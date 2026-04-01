#!/usr/bin/env node
/**
 * 파트별 요약 메시지 생성
 * 개인별 MD 파일을 읽어서 → Sonnet으로 파트 요약 생성
 */
require('dotenv').config();
process.env.CLAUDE_MODEL = 'claude-sonnet-4-6';

const fs = require('fs');
const path = require('path');
const { generateMessage } = require('./claude');

function getToday() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600000);
  return kst.toISOString().slice(0, 10);
}

const PARTS = [
  { key: 'IS', name: 'IS (인사이드세일즈)', prefix: 'IS_', channel: 'C0AJR810T5H' },
  { key: 'FS', name: 'FS (필드세일즈)', prefix: 'FS_', channel: 'C0AJR810T5H' },
  { key: 'BO', name: 'BO (백오피스)', prefix: 'BO_', channel: 'C0AJR810T5H' },
  { key: 'AE', name: 'AE (어카운트이그제큐티브)', prefix: 'AE_', channel: 'C0AJXKJHNJW' },
  { key: 'AM', name: 'AM (어카운트매니저)', prefix: 'AM_', channel: 'C0AJXKJHNJW' },
  { key: 'TM', name: 'TM (텔레마케팅)', prefix: 'TM_', channel: 'C0AJXKJHNJW' },
  { key: 'CS-BO', name: 'CS-BO (채널 백오피스)', prefix: 'CS-BO_', channel: 'C0AJXKJHNJW' },
];

async function main() {
  const date = process.argv[2] || getToday();
  const outputDir = path.join(__dirname, '..', 'output', date);

  if (!fs.existsSync(outputDir)) {
    console.log(`❌ 출력 폴더 없음: ${outputDir}`);
    console.log('   먼저 node src/generate-messages.js 실행하세요.');
    return;
  }

  const summaryPrompt = fs.readFileSync(path.join(__dirname, 'prompts', 'summary.md'), 'utf-8');

  console.log(`📊 파트별 요약 생성 (${date})\n🤖 모델: ${process.env.CLAUDE_MODEL}\n`);

  const allFiles = fs.readdirSync(outputDir);

  for (const part of PARTS) {
    const partFiles = allFiles.filter(f => f.startsWith(part.prefix) && f.endsWith('.md'));

    if (partFiles.length === 0) {
      console.log(`  [${part.key}] ⏭️  파일 없음`);
      continue;
    }

    process.stdout.write(`  [${part.key}] ${partFiles.length}명 요약 중... `);

    // 개인별 메시지 합치기
    let combined = `파트: ${part.name}\n날짜: ${date}\n멤버 ${partFiles.length}명\n\n`;
    for (const file of partFiles) {
      const name = file.replace(part.prefix, '').replace('.md', '');
      const content = fs.readFileSync(path.join(outputDir, file), 'utf-8');
      combined += `=== ${name} ===\n${content}\n\n`;
    }

    try {
      const summary = await generateMessage(summaryPrompt, combined);
      const summaryFile = path.join(outputDir, `_summary_${part.key}.md`);
      fs.writeFileSync(summaryFile, summary, 'utf-8');
      console.log(`✅ 저장 (${summary.length}자)`);
    } catch (err) {
      console.log(`❌ ${err.message}`);
    }
  }

  console.log(`\n✅ 완료 — ${outputDir}/_summary_*.md`);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
