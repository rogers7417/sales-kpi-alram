#!/usr/bin/env node
/**
 * 전체 인원 메시지 생성 → Slack 채널 발송
 *
 * 인바운드세일즈 (IS/FS/BO) → C0AJR810T5H
 * 채널세일즈 (AE/AM/TM/CS-BO) → C0AJXKJHNJW
 */
require('dotenv').config();

// Sonnet 모델 강제 사용
process.env.CLAUDE_MODEL = 'claude-sonnet-4-6';

const { WebClient } = require('@slack/web-api');
const { fetchInboundKPI, fetchChannelKPI } = require('./s3-fetcher');
const { fetchMembersByRole } = require('./members');
const { buildMessage } = require('./message-builder');

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

const CHANNELS = {
  inbound: 'C0AJR810T5H',
  channel: 'C0AJXKJHNJW',
};

async function sendSlack(channel, text) {
  try {
    await slack.chat.postMessage({ channel, text, unfurl_links: false });
    return true;
  } catch (err) {
    console.error(`  ❌ Slack 발송 실패: ${err.message}`);
    return false;
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const onlyName = process.argv.find(a => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1]);

  console.log('📥 데이터 로딩...');
  const [inbound, channel, groups] = await Promise.all([
    fetchInboundKPI(),
    fetchChannelKPI(),
    fetchMembersByRole(),
  ]);

  console.log(`✅ 데이터 로드 완료\n`);
  console.log(`🤖 모델: ${process.env.CLAUDE_MODEL}`);
  if (dryRun) console.log('⚠️  DRY RUN — Slack 발송 안 함\n');

  // 인바운드 팀 (IS/FS/BO)
  const inboundMembers = [...groups.is, ...groups.fs, ...groups.bo];
  // 채널 팀 (AE/AM/TM/CS-BO)
  const channelMembers = [...groups.ae, ...groups.am, ...groups.tm, ...groups.csbo];

  const allTargets = [
    ...inboundMembers.map(m => ({ member: m, channel: CHANNELS.inbound, team: '인바운드' })),
    ...channelMembers.map(m => ({ member: m, channel: CHANNELS.channel, team: '채널' })),
  ];

  // 특정 멤버만
  const targets = onlyName
    ? allTargets.filter(t => t.member.name === onlyName)
    : allTargets;

  if (targets.length === 0) {
    console.log(`❌ 대상 없음${onlyName ? ` (${onlyName})` : ''}`);
    return;
  }

  console.log(`📤 발송 대상: ${targets.length}명\n`);

  let success = 0;
  let fail = 0;

  for (const { member, channel: ch, team } of targets) {
    const role = member.roles[0] || '-';
    process.stdout.write(`  [${team}/${role}] ${member.name}... `);

    try {
      const msg = await buildMessage(member, inbound, channel);
      if (!msg) {
        console.log('⏭️  데이터 없음');
        continue;
      }

      if (dryRun) {
        console.log('✅ 생성 완료 (dry-run)');
        console.log('─'.repeat(40));
        console.log(msg.slice(0, 200) + '...');
        console.log('─'.repeat(40));
      } else {
        const sent = await sendSlack(ch, msg);
        if (sent) {
          console.log('✅ 발송 완료');
          success++;
        } else {
          fail++;
        }
        // Rate limit 방지
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (err) {
      console.log(`❌ ${err.message}`);
      fail++;
    }
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━`);
  console.log(`✅ 완료: ${success}건 / ❌ 실패: ${fail}건`);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
