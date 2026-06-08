#!/usr/bin/env node
/**
 * 인바운드 견적 단계 해피콜 Task 자동 생성기
 *
 * 트리거 조건:
 *   - Opportunity.StageName = '견적' AND IsClosed = false
 *   - Owner.Department = '인바운드세일즈'
 *   - 영업기회 하위 Visit__c 중 IsVisitComplete__c = true 인 최신 방문완료일(ConselEnd__c)이
 *     현재월에 속하고 + 2일 경과 (≤ today - 2일)
 *   - 같은 Opp에 Subject='해피콜 진행' Task가 한 번도 없음 (완료/미완료 무관)
 *
 * 생성 Task:
 *   Subject       = "해피콜 진행"
 *   ActivityDate  = 방문완료일 + 2일 (예: 5/1 방문완료 → 5/3 due)
 *   OwnerId       = Opp.OwnerId
 *   Status        = 'Open' (SF Task 표준 picklist; default)
 *   Priority      = 'High'
 *
 * 사용법:
 *   node src/auto-task-quote-retouch.js --dry-run     # 후보 목록만, SF 생성 X
 *   node src/auto-task-quote-retouch.js --sample 3    # 실제 3건만 생성 (검증)
 *   node src/auto-task-quote-retouch.js               # 본격 실행
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const sf = require('./salesforce');

const SUBJECT = '해피콜 진행';
const LOG_DIR = path.join(__dirname, '..', 'logs', 'auto-task');

function kstNow() {
  return new Date(Date.now() + 9 * 3600000);
}
function fmt(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function todayKST() {
  return fmt(kstNow());
}
function currentMonthStartISO() {
  const n = kstNow();
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, '0')}-01T00:00:00+09:00`;
}
function addDaysISODate(iso, days) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return fmt(d);
}

async function fetchCandidates(instanceUrl, accessToken) {
  const users = await sf.soqlQueryAll(instanceUrl, accessToken,
    `SELECT Id, Name FROM User WHERE Department='인바운드세일즈'`);
  const userMap = Object.fromEntries(users.map(u => [u.Id, u.Name]));
  const ibUserIds = users.map(u => `'${u.Id}'`).join(',');
  console.log(`  인바운드세일즈 User: ${users.length}명`);

  const opps = await sf.soqlQueryAll(instanceUrl, accessToken, `
    SELECT Id, Name, OwnerId, StageName, Account.Name
    FROM Opportunity
    WHERE StageName='견적' AND IsClosed=false AND OwnerId IN (${ibUserIds})
  `);
  console.log(`  견적 단계 Opp: ${opps.length}건`);
  if (!opps.length) return [];
  const oppIds = opps.map(o => `'${o.Id}'`).join(',');

  const visits = await sf.soqlQueryAll(instanceUrl, accessToken, `
    SELECT Id, Opportunity__c, ConselEnd__c
    FROM Visit__c
    WHERE Opportunity__c IN (${oppIds})
      AND IsVisitComplete__c=true
      AND ConselEnd__c >= ${currentMonthStartISO()}
    ORDER BY Opportunity__c, ConselEnd__c DESC
  `);
  const latestVisit = {};
  visits.forEach(v => { if (!latestVisit[v.Opportunity__c]) latestVisit[v.Opportunity__c] = v.ConselEnd__c; });
  console.log(`  현재월 방문완료 보유 Opp: ${Object.keys(latestVisit).length}건`);

  const TODAY = kstNow();
  const cutoff = new Date(TODAY.getTime() - 2 * 86400000);
  let pool = opps.filter(o => {
    const v = latestVisit[o.Id];
    return v && new Date(v) <= cutoff;
  });
  console.log(`  방문완료 +2일 경과: ${pool.length}건`);
  if (!pool.length) return [];

  const poolIds = pool.map(o => `'${o.Id}'`).join(',');
  const happyCallTasks = await sf.soqlQueryAll(instanceUrl, accessToken, `
    SELECT Id, WhatId FROM Task WHERE WhatId IN (${poolIds}) AND Subject='${SUBJECT}'
  `);
  const hasHappyCall = new Set(happyCallTasks.map(t => t.WhatId));
  pool = pool.filter(o => !hasHappyCall.has(o.Id));
  console.log(`  '${SUBJECT}' 이력 없음: ${pool.length}건`);

  return pool.map(o => ({
    oppId: o.Id,
    oppName: o.Name,
    accountName: o.Account?.Name || '',
    ownerId: o.OwnerId,
    ownerName: userMap[o.OwnerId] || o.OwnerId,
    visitEndDate: latestVisit[o.Id],
    activityDate: addDaysISODate(latestVisit[o.Id], 2),
    daysSinceVisit: Math.floor((TODAY - new Date(latestVisit[o.Id])) / 86400000),
  }));
}

function writeLog(payload) {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  const file = path.join(LOG_DIR, `${todayKST()}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  console.log(`  log: ${file}`);
}

async function run({ dryRun = false, sample = null } = {}) {
  const DRY_RUN = dryRun;
  const SAMPLE = sample;
  const startedAt = new Date().toISOString();
  console.log('============================================');
  console.log('🤖 견적단계 해피콜 Task 자동 생성기');
  console.log(`📅 ${todayKST()} | mode: ${DRY_RUN ? 'dry-run' : SAMPLE ? `sample(${SAMPLE})` : 'live'}`);
  console.log('============================================\n');

  const { accessToken, instanceUrl } = await sf.getSalesforceToken();

  console.log('[1/2] 후보 조회');
  let candidates = await fetchCandidates(instanceUrl, accessToken);
  console.log(`\n>>> 후보 ${candidates.length}건 <<<\n`);

  if (SAMPLE) candidates = candidates.slice(0, SAMPLE);

  candidates.forEach((c, i) => {
    console.log(`  ${i + 1}. [${c.daysSinceVisit}일] ${c.accountName || c.oppName} (${c.ownerName}) — due ${c.activityDate}`);
  });
  console.log('');

  if (DRY_RUN || !candidates.length) {
    writeLog({ startedAt, mode: DRY_RUN ? 'dry-run' : 'live', candidates: candidates.length, samples: candidates });
    return;
  }

  console.log(`[2/2] Salesforce Task 생성 (${candidates.length}건)`);
  let created = 0, failed = 0;
  const results = [];
  for (const c of candidates) {
    try {
      const sfRes = await sf.createRecord(instanceUrl, accessToken, 'Task', {
        OwnerId: c.ownerId,
        WhatId: c.oppId,
        Subject: SUBJECT,
        ActivityDate: c.activityDate,
        Status: 'Open',
        Priority: 'High',
      });
      results.push({ ...c, taskId: sfRes.id, status: 'created' });
      created++;
      console.log(`  ✓ Task ${sfRes.id} — ${c.accountName || c.oppName}`);
    } catch (err) {
      const errMsg = err.response?.data || err.message;
      results.push({ ...c, status: 'sf-failed', error: errMsg });
      failed++;
      console.error(`  ✗ ${c.oppId}: ${JSON.stringify(errMsg).slice(0, 200)}`);
    }
  }

  console.log(`\n결과: 생성 ${created}건 / 실패 ${failed}건`);
  writeLog({
    startedAt, mode: SAMPLE ? `sample(${SAMPLE})` : 'live',
    candidates: candidates.length, created, failed, results,
  });
}

module.exports = { run };

// 직접 실행 시에만 CLI 인자 파싱 후 1회 실행
if (require.main === module) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const sampleIdx = argv.indexOf('--sample');
  const sample = sampleIdx >= 0 ? parseInt(argv[sampleIdx + 1], 10) : null;
  run({ dryRun, sample }).catch(e => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
}
