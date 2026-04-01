#!/usr/bin/env node
/**
 * 저장된 MD 파일 → Slack 채널 발송
 *
 * 실행: node src/send-messages.js [날짜]
 * 예시: node src/send-messages.js 2026-03-26
 *       node src/send-messages.js              (오늘 날짜)
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { WebClient } = require('@slack/web-api');

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

function getToday() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600000);
  return kst.toISOString().slice(0, 10);
}

async function main() {
  const date = process.argv[2] || getToday();
  const outputDir = path.join(__dirname, '..', 'output', date);
  const manifestPath = path.join(outputDir, '_manifest.json');

  if (!fs.existsSync(manifestPath)) {
    console.log(`❌ manifest 없음: ${manifestPath}`);
    console.log('   먼저 node src/generate-messages.js 실행하세요.');
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  console.log(`📤 발송 대상: ${manifest.length}건 (${date})\n`);

  let success = 0;
  let fail = 0;

  for (const entry of manifest) {
    const filepath = path.join(outputDir, entry.file);
    if (!fs.existsSync(filepath)) {
      console.log(`  ⏭️  ${entry.name} — 파일 없음`);
      continue;
    }

    const msg = fs.readFileSync(filepath, 'utf-8');
    process.stdout.write(`  [${entry.team}/${entry.role}] ${entry.name} → ${entry.channel}... `);

    try {
      await slack.chat.postMessage({
        channel: entry.channel,
        text: msg,
        unfurl_links: false,
      });
      console.log('✅');
      success++;

      // Rate limit 방지 (2초 대기)
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.log(`❌ ${err.message}`);
      fail++;
    }
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━`);
  console.log(`✅ 발송 완료: ${success}건 / ❌ 실패: ${fail}건`);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
