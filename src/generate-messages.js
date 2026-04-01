#!/usr/bin/env node
/**
 * 전체 인원 메시지 생성 → MD 파일로 저장
 *
 * 실행: node src/generate-messages.js
 * 결과: output/{날짜}/ 폴더에 멤버별 .md 파일 저장
 */
require('dotenv').config();
process.env.CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

const fs = require('fs');
const path = require('path');
const { fetchInboundKPI, fetchChannelKPI } = require('./s3-fetcher');
const { fetchMembersByRole } = require('./members');
const { buildMessage } = require('./message-builder');

function getToday() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600000);
  return kst.toISOString().slice(0, 10);
}

async function main() {
  const today = getToday();
  const outputDir = path.join(__dirname, '..', 'output', today);
  fs.mkdirSync(outputDir, { recursive: true });

  console.log('📥 데이터 로딩...');
  const [inbound, channel, groups] = await Promise.all([
    fetchInboundKPI(),
    fetchChannelKPI(),
    fetchMembersByRole(),
  ]);
  console.log(`✅ 데이터 로드 완료\n🤖 모델: ${process.env.CLAUDE_MODEL}\n`);

  // 팀별 멤버 + 채널 매핑
  const targets = [
    ...groups.is.map(m => ({ member: m, team: '인바운드', role: 'IS', channel: 'C0AJR810T5H' })),
    ...groups.fs.map(m => ({ member: m, team: '인바운드', role: 'FS', channel: 'C0AJR810T5H' })),
    ...groups.bo.map(m => ({ member: m, team: '인바운드', role: 'BO', channel: 'C0AJR810T5H' })),
    ...groups.ae.map(m => ({ member: m, team: '채널', role: 'AE', channel: 'C0AJXKJHNJW' })),
    ...groups.am.map(m => ({ member: m, team: '채널', role: 'AM', channel: 'C0AJXKJHNJW' })),
    ...groups.tm.map(m => ({ member: m, team: '채널', role: 'TM', channel: 'C0AJXKJHNJW' })),
    ...groups.csbo.map(m => ({ member: m, team: '채널', role: 'CS-BO', channel: 'C0AJXKJHNJW' })),
  ];

  console.log(`📤 생성 대상: ${targets.length}명\n`);

  const manifest = [];
  let success = 0;
  let fail = 0;

  for (const { member, team, role, channel: slackChannel } of targets) {
    process.stdout.write(`  [${team}/${role}] ${member.name}... `);

    try {
      const msg = await buildMessage(member, inbound, channel);
      if (!msg) {
        console.log('⏭️  데이터 없음');
        continue;
      }

      const filename = `${role}_${member.name}.md`;
      const filepath = path.join(outputDir, filename);
      fs.writeFileSync(filepath, msg, 'utf-8');

      manifest.push({
        name: member.name,
        role,
        team,
        slackId: member.slackId,
        channel: slackChannel,
        file: filename,
      });

      console.log(`✅ 저장 (${msg.length}자)`);
      success++;
    } catch (err) {
      console.log(`❌ ${err.message}`);
      fail++;
    }
  }

  // manifest 저장
  const manifestPath = path.join(outputDir, '_manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  console.log(`\n━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📁 저장 위치: ${outputDir}`);
  console.log(`✅ 성공: ${success}건 / ❌ 실패: ${fail}건`);
  console.log(`📋 manifest: ${manifestPath}`);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
