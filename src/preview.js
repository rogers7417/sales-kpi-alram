#!/usr/bin/env node
/**
 * 프리뷰 모드 — Claude/Slack 호출 없이 템플릿으로만 메시지 생성
 *
 * 실행:
 *   node src/preview.js                    # 전체 멤버
 *   node src/preview.js --member=문은기    # 특정 멤버
 *   node src/preview.js --stdout           # 파일 대신 표준출력
 *
 * 출력: preview/{role}_{name}.md
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { fetchInboundKPI, fetchChannelKPI } = require('./s3-fetcher');
const { fetchMembersByRole } = require('./members');
const { extractors, dataSources } = require('./message-builder');
const { formatMessage } = require('./template-formatter');

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    memberName: args.find(a => a.startsWith('--member='))?.split('=')[1] || null,
    stdout: args.includes('--stdout'),
  };
}

function getToday() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

async function main() {
  const args = parseArgs();
  const date = getToday();

  console.log(`\n${'━'.repeat(50)}`);
  console.log(`📋 Preview Mode — ${date}`);
  console.log(`🧪 Claude/Slack 호출 없음. 템플릿만 사용.`);
  if (args.memberName) console.log(`👤 대상: ${args.memberName}`);
  console.log(`${'━'.repeat(50)}\n`);

  console.log('📥 데이터 수집...');
  const [inbound, channel, groups] = await Promise.all([
    fetchInboundKPI(),
    fetchChannelKPI(),
    fetchMembersByRole(),
  ]);
  console.log('  ✅ 완료\n');

  const allMembers = [
    ...groups.is.map(m => ({ member: m, role: 'IS' })),
    ...groups.fs.map(m => ({ member: m, role: 'FS' })),
    ...groups.bo.map(m => ({ member: m, role: 'BO' })),
    ...groups.tm.map(m => ({ member: m, role: 'TM' })),
    ...groups.am.map(m => ({ member: m, role: 'AM' })),
    ...groups.ae.map(m => ({ member: m, role: 'AE' })),
    ...groups.csbo.map(m => ({ member: m, role: 'CS-BO' })),
  ];

  const targets = args.memberName
    ? allMembers.filter(t => t.member.name === args.memberName)
    : allMembers;

  if (targets.length === 0) {
    console.log(`❌ 대상 없음${args.memberName ? ` (${args.memberName})` : ''}`);
    return;
  }

  const outDir = path.join(__dirname, '..', 'preview');
  if (!args.stdout && !fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  console.log(`📝 프리뷰 생성 (${targets.length}명)...\n`);

  let ok = 0, skip = 0, fail = 0;

  for (const { member, role } of targets) {
    const primaryRole = member.roles[0];
    if (!primaryRole) { skip++; continue; }

    try {
      const extractor = extractors[primaryRole];
      if (!extractor) { skip++; continue; }

      const dataSource = dataSources[primaryRole] === 'inbound' ? inbound : channel;
      const data = extractor(member, dataSource);

      if (!data) {
        console.log(`  [${primaryRole}] ${member.name}... ⏭️ 데이터 없음`);
        skip++;
        continue;
      }

      const md = formatMessage(primaryRole, data);

      if (args.stdout) {
        console.log(`\n${'═'.repeat(60)}`);
        console.log(`[${primaryRole}] ${member.name}`);
        console.log('═'.repeat(60));
        console.log(md);
      } else {
        const safeName = member.name.replace(/[\/\\:*?"<>|]/g, '_');
        const filePath = path.join(outDir, `${primaryRole}_${safeName}.md`);
        fs.writeFileSync(filePath, md);
        console.log(`  [${primaryRole}] ${member.name} → preview/${path.basename(filePath)}`);
      }
      ok++;
    } catch (err) {
      console.log(`  [${primaryRole}] ${member.name}... ❌ ${err.message}`);
      fail++;
    }
  }

  console.log(`\n${'━'.repeat(50)}`);
  console.log(`✅ 완료 — 성공 ${ok} / 스킵 ${skip} / 실패 ${fail}`);
  if (!args.stdout) console.log(`📁 출력: ${outDir}`);
  console.log(`${'━'.repeat(50)}\n`);
}

main().catch(err => {
  console.error('❌', err);
  process.exit(1);
});
