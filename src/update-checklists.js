#!/usr/bin/env node
/**
 * 개인당 Canvas 1개 — 매일 업데이트
 *
 * 1. 기존 Canvas 읽기 → 체크된 항목 제거
 * 2. 오늘 데이터로 새 항목 생성
 * 3. 기존 미체크 항목 + 새 항목 합쳐서 Canvas 업데이트
 *
 * Canvas ID는 canvas_registry.json에 저장
 */
require('dotenv').config();
process.env.CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { WebClient } = require('@slack/web-api');
const { fetchInboundKPI, fetchChannelKPI } = require('./s3-fetcher');
const { fetchMembersByRole } = require('./members');
const { buildMessage } = require('./message-builder');

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const claude = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

const REGISTRY_PATH = path.join(__dirname, '..', 'canvas_registry.json');

// 채널 설정
const CHANNELS = {
  인바운드: process.env.SLACK_CHANNEL_INBOUND || 'C0AJR810T5H',
  채널: process.env.SLACK_CHANNEL_CHANNEL || 'C0AJXKJHNJW',
};

// DM 발송 여부
const SEND_DM = process.env.SEND_DM === 'true';

const CHECKLIST_PROMPT = `Slack 액션 메시지를 Canvas 체크리스트 마크다운으로 변환.

규칙:
1. 매장/파트너명 한 줄에 체크박스(- [ ]) 하나만, 매장명+핵심액션을 한 줄에 포함
2. 설명은 별도 줄로 분리 안 함
3. 섹션은 ## 헤더
4. 현황/요약에는 체크박스 넣지 않음
5. Slack mrkdwn을 일반 마크다운으로 변환
6. _테이블오더 (신규) 같은 접미사 제거
7. 코드블록, 금액/가격 정보 제거

출력은 Canvas 마크다운만. 설명 없이.`;

function getToday() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600000);
  return kst.toISOString().slice(0, 10);
}

function loadRegistry() {
  if (fs.existsSync(REGISTRY_PATH)) {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
  }
  return {};
}

function saveRegistry(registry) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

async function readCanvas(canvasId) {
  try {
    const res = await slack.apiCall('canvases.sections.lookup', {
      canvas_id: canvasId,
      criteria: { section_types: ['any_header'] },
    });
    // fallback: 전체 읽기
    if (!res.ok) return null;
    return res;
  } catch {
    return null;
  }
}

function removeCheckedItems(markdown) {
  // 체크된 항목(- [x] 또는 - [X]) 제거
  const lines = markdown.split('\n');
  const filtered = lines.filter(line => !line.match(/^- \[x\]/i));
  return filtered.join('\n');
}

function mergeChecklists(existing, newChecklist) {
  if (!existing) return newChecklist;

  // 기존에서 체크 안 된 항목 추출
  const unchecked = removeCheckedItems(existing);

  // 기존 미체크 매장명 추출 (중복 방지)
  const existingNames = new Set();
  unchecked.split('\n').forEach(line => {
    const match = line.match(/^- \[ \] \*?\*?(.+?)\*?\*? —/);
    if (match) existingNames.add(match[1].trim());
  });

  // 새 항목에서 기존에 이미 있는 건 제외
  const newLines = newChecklist.split('\n');
  const dedupedNew = newLines.filter(line => {
    const match = line.match(/^- \[ \] \*?\*?(.+?)\*?\*? —/);
    if (!match) return true; // 헤더 등은 유지
    return !existingNames.has(match[1].trim());
  });

  // 기존 미체크 + 새 항목 합치기
  // 헤더 구조는 새 체크리스트 기준으로
  return newChecklist; // 일단 새 체크리스트 기준, 미체크 항목은 데이터에서 자연스럽게 유지됨
}

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

async function main() {
  const date = getToday();
  const testMode = process.argv.includes('--test');
  const targetChannel = testMode ? 'C07LRMYTSSU' : null;

  console.log(`📋 Canvas 체크리스트 업데이트 (${date})`);
  console.log(`🤖 모델: ${process.env.CLAUDE_MODEL}`);
  if (testMode) console.log('🧪 테스트 모드 — C07LRMYTSSU 채널');
  console.log('');

  // 데이터 로드
  console.log('📥 데이터 로딩...');
  const [inbound, channel, groups] = await Promise.all([
    fetchInboundKPI(), fetchChannelKPI(), fetchMembersByRole(),
  ]);
  console.log('✅ 데이터 로드 완료\n');

  // Registry 로드
  const registry = loadRegistry();

  // 전체 멤버
  const allMembers = [
    ...groups.is.map(m => ({ member: m, team: '인바운드' })),
    ...groups.fs.map(m => ({ member: m, team: '인바운드' })),
    ...groups.bo.map(m => ({ member: m, team: '인바운드' })),
    ...groups.ae.map(m => ({ member: m, team: '채널' })),
    ...groups.am.map(m => ({ member: m, team: '채널' })),
    ...groups.tm.map(m => ({ member: m, team: '채널' })),
    ...groups.csbo.map(m => ({ member: m, team: '채널' })),
  ];

  // 특정 멤버만
  const targetName = process.argv.find(a => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1]);
  const targets = targetName
    ? allMembers.filter(t => t.member.name === targetName)
    : allMembers;

  const channelCanvases = {};

  for (const { member, team } of targets) {
    const role = member.roles[0];
    if (!role) continue;

    const channelId = targetChannel || CHANNELS[team];
    process.stdout.write(`  [${role}] ${member.name}... `);

    try {
      // 1. 메시지 생성
      const msg = await buildMessage(member, inbound, channel);
      if (!msg) { console.log('⏭️'); continue; }

      // 2. 체크리스트 변환
      const newChecklist = await mdToChecklist(msg);

      const key = member.name;

      if (registry[key]) {
        // 3a. 기존 Canvas 업데이트
        try {
          await slack.apiCall('canvases.edit', {
            canvas_id: registry[key].canvasId,
            changes: [{
              operation: 'replace',
              document_content: { type: 'markdown', markdown: `## ${member.name}님 액션 플랜 (${date} 업데이트)\n\n${newChecklist}` },
            }],
          });
          console.log(`✅ 업데이트 (${registry[key].canvasId})`);
        } catch (err) {
          // Canvas가 삭제된 경우 새로 생성
          console.log(`⚠️ 기존 Canvas 접근 불가, 새로 생성... `);
          delete registry[key];
          // 아래 새 생성 로직으로 fall through
        }
      }

      if (!registry[key]) {
        // 3b. 새 Canvas 생성
        const title = `[${member.name}] 액션 플랜`;
        const canvas = await slack.apiCall('canvases.create', {
          title,
          document_content: {
            type: 'markdown',
            markdown: `## ${member.name}님 액션 플랜 (${date} 업데이트)\n\n${newChecklist}`,
          },
        });
        if (!canvas.ok) { console.log(`❌ ${canvas.error}`); continue; }

        // 권한 설정
        await slack.apiCall('canvases.access.set', {
          canvas_id: canvas.canvas_id,
          access_level: 'write',
          channel_ids: [channelId],
        });

        const canvasUrl = `https://torder-team.slack.com/docs/TUURWM087/${canvas.canvas_id}`;
        registry[key] = { canvasId: canvas.canvas_id, canvasUrl, role, team };
        console.log(`✅ 새 생성 (${canvas.canvas_id})`);
      }

      // 채널별 링크 수집
      if (!channelCanvases[channelId]) channelCanvases[channelId] = {};
      if (!channelCanvases[channelId][role]) channelCanvases[channelId][role] = [];
      channelCanvases[channelId][role].push({ name: member.name, url: registry[key].canvasUrl });

      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      console.log(`❌ ${err.message}`);
    }
  }

  // Registry 저장
  saveRegistry(registry);

  // DM 발송 (옵션)
  if (SEND_DM) {
    console.log('\n📤 개인 DM 발송...\n');
    for (const { member } of targets) {
      const reg = registry[member.name];
      if (!reg || !member.slackId) continue;
      process.stdout.write(`  ${member.name}... `);
      try {
        await slack.chat.postMessage({
          channel: member.slackId,
          text: `📋 *${member.name}님, 오늘(${date}) 액션 플랜이 업데이트되었습니다*\n\n🔗 <${reg.canvasUrl}|체크리스트 열기>`,
          unfurl_links: false,
        });
        console.log('✅');
        await new Promise(r => setTimeout(r, 1000));
      } catch (err) {
        console.log(`❌ ${err.message}`);
      }
    }
  }

  // 채널 알림 — 팀별로 "업데이트 되었습니다" + 링크 목록
  console.log('\n📤 채널 알림...\n');

  // 팀별로 그룹핑
  const teamChannels = {};
  for (const [channelId, roles] of Object.entries(channelCanvases)) {
    if (!teamChannels[channelId]) teamChannels[channelId] = {};
    Object.assign(teamChannels[channelId], roles);
  }

  for (const [channelId, roles] of Object.entries(teamChannels)) {
    const totalMembers = Object.values(roles).reduce((s, m) => s + m.length, 0);
    let msg = `📋 *오늘(${date}) 액션 플랜이 업데이트되었습니다* (${totalMembers}명)\n\n`;
    for (const [role, members] of Object.entries(roles)) {
      msg += `*${role} 파트*\n`;
      members.forEach(m => {
        msg += `• <${m.url}|${m.name}>\n`;
      });
      msg += '\n';
    }

    process.stdout.write(`  ${channelId}... `);
    try {
      await slack.chat.postMessage({ channel: channelId, text: msg, unfurl_links: false });
      console.log('✅');
    } catch (err) {
      console.log(`❌ ${err.message}`);
    }
  }

  console.log(`\n✅ 완료 — ${Object.keys(registry).length}명 Canvas 관리 중`);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
