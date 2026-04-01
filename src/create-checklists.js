#!/usr/bin/env node
/**
 * 개인별 MD 파일 → Canvas 체크리스트 생성 + 권한 설정 + 채널 발송
 *
 * 실행: node src/create-checklists.js [날짜]
 * 예시: node src/create-checklists.js 2026-03-30
 */
require('dotenv').config();
process.env.CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { WebClient } = require('@slack/web-api');

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const claude = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

function getToday() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600000);
  return kst.toISOString().slice(0, 10);
}

const CHECKLIST_PROMPT = `Slack 액션 메시지를 Canvas 체크리스트 마크다운으로 변환하세요.

규칙:
1. 매장/파트너명 한 줄에 체크박스(- [ ]) 하나만. 매장명 + 핵심 액션을 한 줄에 모두 포함.
2. 설명이나 부연은 체크박스 안에 포함하거나 생략. 별도 줄로 분리하지 않음.
3. 섹션별로 ## 헤더로 구분
4. 현황 수치는 첫 섹션에 체크박스 없이 일반 텍스트로.
5. Slack mrkdwn(*볼드*)을 일반 마크다운(**볼드**)으로 변환
6. _테이블오더 (신규) 같은 접미사 제거
7. 코드블록 제거

중요: 체크박스는 매장/파트너 단위로만 생성. 설명, 현황, 요약에는 체크박스 넣지 않음.

출력은 Canvas 마크다운만 반환. 설명 없이.`;

const CHANNELS = {
  인바운드: 'C0AJR810T5H',
  채널: 'C0AJXKJHNJW',
};

async function mdToChecklist(content) {
  const cleaned = content.replace(/^```\n?/, '').replace(/\n?```$/, '');
  const res = await claude.messages.create({
    model: process.env.CLAUDE_MODEL,
    max_tokens: 4000,
    system: CHECKLIST_PROMPT,
    messages: [{ role: 'user', content: cleaned }],
  });
  return res.content[0].text;
}

async function createCanvas(title, markdown, channelId) {
  // Canvas 생성
  const res = await slack.apiCall('canvases.create', {
    title,
    document_content: { type: 'markdown', markdown },
  });
  if (!res.ok) throw new Error(`Canvas 생성 실패: ${res.error}`);

  // 채널 멤버에게 write 권한 부여
  await slack.apiCall('canvases.access.set', {
    canvas_id: res.canvas_id,
    access_level: 'write',
    channel_ids: [channelId],
  });

  return res.canvas_id;
}

async function main() {
  const date = process.argv[2] || getToday();
  const outputDir = path.join(__dirname, '..', 'output', date);
  const manifestPath = path.join(outputDir, '_manifest.json');

  if (!fs.existsSync(manifestPath)) {
    console.log('❌ manifest 없음. 먼저 generate-messages.js 실행하세요.');
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  console.log(`📋 체크리스트 Canvas 생성 (${date})`);
  console.log(`🤖 모델: ${process.env.CLAUDE_MODEL}\n`);

  // 채널별 Canvas 링크 수집
  const channelCanvases = {};
  const results = [];

  for (const entry of manifest) {
    const filepath = path.join(outputDir, entry.file);
    if (!fs.existsSync(filepath)) continue;

    const channelId = CHANNELS[entry.team];
    if (!channelId) continue;

    process.stdout.write(`  [${entry.role}] ${entry.name}... `);

    try {
      // MD → 체크리스트 변환
      const mdContent = fs.readFileSync(filepath, 'utf-8');
      const checklist = await mdToChecklist(mdContent);

      // Canvas 생성 + 권한 설정
      const title = `[${entry.name}] ${date} 액션 플랜`;
      const canvasId = await createCanvas(title, checklist, channelId);

      const canvasUrl = `https://torder-team.slack.com/docs/TUURWM087/${canvasId}`;

      // 채널별로 링크 수집
      if (!channelCanvases[channelId]) channelCanvases[channelId] = {};
      if (!channelCanvases[channelId][entry.role]) channelCanvases[channelId][entry.role] = [];
      channelCanvases[channelId][entry.role].push({ name: entry.name, canvasUrl });

      results.push({ ...entry, canvasId, canvasUrl });
      console.log(`✅ ${canvasId}`);

      // Rate limit 방지
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      console.log(`❌ ${err.message}`);
    }
  }

  // 채널별로 링크 모아서 발송
  console.log('\n📤 채널 발송...\n');

  for (const [channelId, roles] of Object.entries(channelCanvases)) {
    let msg = `📋 *오늘(${date}) 액션 플랜 체크리스트*\n\n`;

    for (const [role, members] of Object.entries(roles)) {
      msg += `*${role} 파트*\n`;
      members.forEach(m => {
        msg += `• <${m.canvasUrl}|${m.name}님 체크리스트>\n`;
      });
      msg += '\n';
    }
    msg += '완료한 항목은 체크해주세요! ✅';

    process.stdout.write(`  ${channelId}... `);
    try {
      await slack.chat.postMessage({ channel: channelId, text: msg, unfurl_links: false });
      console.log('✅');
    } catch (err) {
      console.log(`❌ ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  // 결과 저장
  const resultPath = path.join(outputDir, '_canvas_manifest.json');
  fs.writeFileSync(resultPath, JSON.stringify(results, null, 2));
  console.log(`\n✅ 완료 — ${results.length}건 Canvas 생성`);
  console.log(`📋 ${resultPath}`);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
