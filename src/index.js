#!/usr/bin/env node
/**
 * Sales KPI Alarm Bot — 메인 파이프라인
 *
 * 실행:
 *   node src/index.js              # 즉시 1회 실행
 *   node src/index.js --cron       # cron 스케줄 모드 (오전 9시, 오후 2시)
 *   node src/index.js --test       # 테스트 채널로 발송
 *   node src/index.js --member=문은기  # 특정 멤버만
 */
require('dotenv').config();

const cron = require('node-cron');
const { fetchInboundKPI, fetchChannelKPI } = require('./s3-fetcher');
const { fetchMembersByRole } = require('./members');
const { buildMessage } = require('./message-builder');
const { run: runAutoTask } = require('./auto-task-quote-retouch');
const { WebClient } = require('@slack/web-api');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const claude = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const SEND_DM = process.env.SEND_DM === 'true';
const REGISTRY_PATH = path.join(__dirname, '..', 'canvas_registry.json');

const CHANNELS = {
  인바운드: process.env.SLACK_CHANNEL_INBOUND || 'C0AJR810T5H',
  채널: process.env.SLACK_CHANNEL_CHANNEL || 'C0AJXKJHNJW',
};

const CHECKLIST_PROMPT = `Slack 액션 메시지를 Canvas 체크리스트 마크다운으로 변환.

### 매우 중요 — 체크박스 형식
- 반드시 정확히 "- [ ] " 형식으로만 시작 (하이픈 + 공백 + [ ] + 공백)
- 절대 ☐, * [ ], • [ ] 같은 다른 형식 쓰지 말 것
- 각 체크박스는 줄 시작이 "- [ ] " 여야 토글 가능
- 체크박스 안에 매장명 + 액션을 한 줄로 모두 작성

### 규칙
1. 매장/파트너명 한 줄에 체크박스 하나만, 매장명+핵심액션을 한 줄에 포함
2. 설명은 별도 줄로 분리 안 함 (체크박스 줄에 모두 포함)
3. 섹션은 ## 헤더로 구분
4. 현황/요약/미션 섹션에는 체크박스 넣지 않음 (일반 텍스트로)
5. 미션 섹션의 프로그래스바(━)와 이모지(🏆 ✨ 💡)는 그대로 유지
6. Slack mrkdwn(*볼드*)을 일반 마크다운(**볼드**)으로 변환
7. _테이블오더 (신규) 같은 접미사 제거
8. 코드블록, 금액/가격 정보 제거

출력은 Canvas 마크다운만. 설명 없이.`;

function getToday() {
  // sv-SE 로케일은 YYYY-MM-DD 형식. timeZone 옵션으로 KST 보장 (서버 TZ 무관)
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
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

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    cronMode: args.includes('--cron'),
    testMode: args.includes('--test'),
    memberName: args.find(a => a.startsWith('--member='))?.split('=')[1] || null,
    roleName: args.find(a => a.startsWith('--role='))?.split('=')[1] || null,
  };
}

/**
 * 메인 파이프라인 실행
 */
async function run(options = {}) {
  const { testMode = false, memberName = null, roleName = null } = options;
  const date = getToday();
  const startTime = Date.now();

  console.log(`\n${'━'.repeat(50)}`);
  console.log(`📋 Sales KPI Alarm Bot — ${date}`);
  console.log(`🤖 모델: ${MODEL}`);
  if (testMode) console.log('🧪 테스트 모드');
  if (memberName) console.log(`👤 대상: ${memberName}`);
  if (roleName) console.log(`🏷️  역할 필터: ${roleName}`);
  console.log(`${'━'.repeat(50)}\n`);

  // ── 1. 데이터 수집 ──
  console.log('📥 [1/4] 데이터 수집...');
  const [inbound, channel, groups] = await Promise.all([
    fetchInboundKPI(),
    fetchChannelKPI(),
    fetchMembersByRole(),
  ]);
  console.log('  ✅ S3 + SF User 로드 완료\n');

  // ── 2. 대상 멤버 구성 ──
  const allMembers = [
    ...groups.is.map(m => ({ member: m, team: '인바운드' })),
    ...groups.fs.map(m => ({ member: m, team: '인바운드' })),
    ...groups.bo.map(m => ({ member: m, team: '인바운드' })),
    ...groups.ae.map(m => ({ member: m, team: '채널' })),
    ...groups.am.map(m => ({ member: m, team: '채널' })),
    ...groups.tm.map(m => ({ member: m, team: '채널' })),
    ...groups.csbo.map(m => ({ member: m, team: '채널' })),
  ];

  let targets = allMembers;
  if (memberName) targets = targets.filter(t => t.member.name === memberName);
  if (roleName) targets = targets.filter(t => t.member.roles.includes(roleName));

  if (targets.length === 0) {
    console.log(`❌ 대상 없음${memberName ? ` (${memberName})` : ''}`);
    return;
  }

  // ── 3. 메시지 생성 + Canvas 업데이트 ──
  console.log(`📝 [2/4] 메시지 생성 + Canvas 업데이트 (${targets.length}명)...\n`);

  const registry = loadRegistry();
  const channelCanvases = {};
  let success = 0;
  let fail = 0;

  for (const { member, team } of targets) {
    const role = member.roles[0];
    if (!role) continue;

    const channelId = testMode ? 'C07LRMYTSSU' : CHANNELS[team];
    process.stdout.write(`  [${role}] ${member.name}... `);

    try {
      // 메시지 생성
      const msg = await buildMessage(member, inbound, channel);
      if (!msg) { console.log('⏭️ 데이터 없음'); continue; }

      // 체크리스트 변환
      const cleaned = msg.replace(/^```\n?/, '').replace(/\n?```$/, '');
      const res = await claude.messages.create({
        model: MODEL,
        max_tokens: 4000,
        system: CHECKLIST_PROMPT,
        messages: [{ role: 'user', content: cleaned }],
      });
      const checklist = res.content[0].text;
      const content = `## ${member.name}님 액션 플랜 (${date} 업데이트)\n\n${checklist}`;

      // Canvas 업데이트 or 생성
      const key = member.name;

      if (registry[key]) {
        try {
          const editRes = await slack.apiCall('canvases.edit', {
            canvas_id: registry[key].canvasId,
            changes: [{ operation: 'replace', document_content: { type: 'markdown', markdown: content } }],
          });
          if (!editRes.ok) throw new Error(editRes.error);

          // 본인 편집권한 재보장 (DM 링크로 열어도 체크박스 토글 가능하도록)
          if (member.slackId) {
            await slack.apiCall('canvases.access.set', {
              canvas_id: registry[key].canvasId,
              access_level: 'write',
              user_ids: [member.slackId],
            }).catch(e => console.log(`  ⚠️ user access.set 실패: ${e.message}`));
          }
          console.log('✅ 업데이트');
        } catch (err) {
          const code = err?.data?.error || err?.message || '';
          if (code === 'canvas_not_found' || code === 'channel_not_found' || code === 'not_found') {
            console.log(`⚠️ Canvas 없음 (${code}) → 재생성`);
            delete registry[key];
          } else {
            throw err; // 일시 오류는 fail 카운트로 처리, registry 보존
          }
        }
      }

      if (!registry[key]) {
        const title = `[${member.name}] 액션 플랜`;
        const canvas = await slack.apiCall('canvases.create', {
          title,
          document_content: { type: 'markdown', markdown: content },
        });
        if (!canvas.ok) throw new Error(canvas.error);

        // 채널 권한
        await slack.apiCall('canvases.access.set', {
          canvas_id: canvas.canvas_id,
          access_level: 'write',
          channel_ids: [channelId],
        });

        // 본인 권한 (DM 링크로 열어도 편집 가능하도록)
        if (member.slackId) {
          await slack.apiCall('canvases.access.set', {
            canvas_id: canvas.canvas_id,
            access_level: 'write',
            user_ids: [member.slackId],
          }).catch(e => console.log(`  ⚠️ user access.set 실패: ${e.message}`));
        }

        registry[key] = {
          canvasId: canvas.canvas_id,
          canvasUrl: `https://torder-team.slack.com/docs/TUURWM087/${canvas.canvas_id}`,
          role,
          team,
        };
        console.log('✅ 새 생성');
      }

      // 채널별 링크 수집
      if (!channelCanvases[channelId]) channelCanvases[channelId] = {};
      if (!channelCanvases[channelId][role]) channelCanvases[channelId][role] = [];
      channelCanvases[channelId][role].push({
        name: member.name,
        url: registry[key].canvasUrl,
        slackId: member.slackId,
      });

      success++;
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      console.log(`❌ ${err.message}`);
      fail++;
    }
  }

  saveRegistry(registry);

  // ── 4. DM 발송 (옵션) ──
  if (SEND_DM) {
    console.log('\n📤 [3/4] 개인 DM 발송...\n');
    for (const roles of Object.values(channelCanvases)) {
      for (const members of Object.values(roles)) {
        for (const m of members) {
          if (!m.slackId) continue;
          try {
            await slack.chat.postMessage({
              channel: m.slackId,
              text: `📋 *${m.name}님, 오늘(${date}) 액션 플랜이 업데이트되었습니다*\n\n🔗 <${registry[m.name]?.canvasUrl}|체크리스트 열기>`,
              unfurl_links: false,
            });
            await new Promise(r => setTimeout(r, 1000));
          } catch {}
        }
      }
    }
  } else {
    console.log('\n📤 [3/4] DM 발송 스킵 (SEND_DM=false)\n');
  }

  // ── 5. 채널 알림 ──
  console.log('📤 [4/4] 채널 알림...\n');

  for (const [channelId, roles] of Object.entries(channelCanvases)) {
    const totalMembers = Object.values(roles).reduce((s, m) => s + m.length, 0);
    let msg = `📋 *오늘(${date}) 액션 플랜이 업데이트되었습니다* (${totalMembers}명)\n\n`;
    for (const [role, members] of Object.entries(roles)) {
      msg += `*${role} 파트*\n`;
      members.forEach(m => {
        msg += `• <${registry[m.name]?.canvasUrl}|${m.name}>\n`;
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

  // ── 완료 ──
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${'━'.repeat(50)}`);
  console.log(`✅ 완료 — ${success}건 성공 / ${fail}건 실패 (${elapsed}초)`);
  console.log(`📁 Registry: ${Object.keys(registry).length}명 Canvas 관리 중`);
  console.log(`${'━'.repeat(50)}\n`);
}

// ── 실행 ──
const args = parseArgs();

if (args.cronMode) {
  console.log('⏰ Cron 모드 시작 — 오전 10시 실행 (월~금)');
  console.log(`   채널: 인바운드 ${CHANNELS.인바운드} / 채널세일즈 ${CHANNELS.채널}`);
  console.log(`   DM: ${SEND_DM ? 'ON' : 'OFF'}\n`);

  // 오전 9시 50분 KST (월~금) — 견적단계 해피콜 Task 자동 생성 (알람 발송 전)
  cron.schedule('50 9 * * 1-5', () => {
    console.log(`\n🤖 [${new Date().toISOString()}] 해피콜 Task 자동 생성`);
    runAutoTask({ dryRun: args.testMode }).catch(console.error);
  }, { timezone: 'Asia/Seoul' });

  // 오전 10시 KST (월~금) — 개인 알람 발송
  cron.schedule('0 10 * * 1-5', () => {
    console.log(`\n⏰ [${new Date().toISOString()}] 오전 10시 실행`);
    run({ testMode: args.testMode }).catch(console.error);
  }, { timezone: 'Asia/Seoul' });

} else {
  // 즉시 실행
  run({
    testMode: args.testMode,
    memberName: args.memberName,
    roleName: args.roleName,
  }).catch(err => {
    console.error('❌', err.message);
    process.exit(1);
  });
}
