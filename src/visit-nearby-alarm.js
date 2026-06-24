#!/usr/bin/env node
/**
 * 방문 전 "주변 매장 컨택" 알람
 *
 * 방문 하루(또는 이틀) 전, 그날 방문 예정인 담당자에게
 * 방문 매장 주변(반경 N km)의 컨택 후보 매장을 슬랙으로 보낸다.
 *
 *   ① 본인이 이미 방문했던 주변 매장   (재방문/리터치 후보)
 *   ② 미방문 + 같은 팀 다른 담당자 매장 (가는 김에 대신 컨택 후보)
 *
 * 데이터: S3 dashboard/visits/tracking.json (build-visit-tracking-dataset.js 생성)
 *
 * 사용법:
 *   node src/visit-nearby-alarm.js                       # 내일(D+1) 방문 예정 전원, 실제 발송
 *   node src/visit-nearby-alarm.js --dry-run             # 발송 안 하고 메시지만 출력
 *   node src/visit-nearby-alarm.js --date=2026-06-24     # 특정 날짜 방문 예정자
 *   node src/visit-nearby-alarm.js --visitor=박대훈       # 특정 담당자만
 *   node src/visit-nearby-alarm.js --radius=3            # 반경(km, 기본 3)
 *   node src/visit-nearby-alarm.js --channel=C07LRMYTSSU # 발송 채널 override
 *   node src/visit-nearby-alarm.js --exclude-cl          # Closed Lost도 제외 (기본은 CW만 제외)
 */
require('dotenv').config();

const { WebClient } = require('@slack/web-api');
const { fetchJSON, getToday } = require('./s3-fetcher');
const { getSalesforceToken, soqlQuery } = require('./salesforce');

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// 발송 채널 — 팀(부서)별 라우팅. 미매핑 부서는 DEFAULT_CHANNEL로.
const DEFAULT_CHANNEL = 'C07LRMYTSSU';
const DEPT_CHANNELS = {
  '아웃바운드세일즈': 'C0BC9DKMFDH',
  '인바운드세일즈': 'C0AJR810T5H',
  // '채널매니지먼트': '',
  // 'SE': '',
};
// --channel= 지정 시 전 부서 강제 단일 채널, 아니면 부서별 라우팅
function channelFor(dept) { return CH_OVERRIDE || DEPT_CHANNELS[dept] || DEFAULT_CHANNEL; }

const SF_BASE = 'https://torder.lightning.force.com/lightning/r/Opportunity';

// ── 인자 파싱 ──────────────────────────────────────────────
function arg(name, def) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
}
const DRY_RUN = process.argv.includes('--dry-run');
const NO_MENTION = process.argv.includes('--no-mention'); // 맨션 끄기
const EXCLUDE_CL = process.argv.includes('--exclude-cl');
const RADIUS = parseFloat(arg('radius', '3'));
const CH_OVERRIDE = arg('channel', ''); // 지정 시 전 부서 단일 채널 강제
const ONLY_VISITOR = arg('visitor', '');
// 제외 부서 (기본: 리텐션). --exclude-dept=리텐션,SE 처럼 콤마로 추가 가능, --exclude-dept= 로 해제
const EXCLUDE_DEPTS = new Set(arg('exclude-dept', '리텐션').split(',').map(s => s.trim()).filter(Boolean));
// 특정 부서만 발송 (콤마 구분). 비면 전체. 예: --only-dept=아웃바운드세일즈
const ONLY_DEPT = new Set(arg('only-dept', '').split(',').map(s => s.trim()).filter(Boolean));
// 매장당 주변 댓글 상한 (섹션별 가까운 N곳). 0 = 무제한
const CAP_PER_STORE = parseInt(arg('cap', '0'), 10);

// 기본 타깃 날짜 = 내일(D+1, KST)
function tomorrow() {
  const t = getToday(); // YYYY-MM-DD (KST)
  const [y, m, d] = t.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + 24 * 3600000);
  return dt.toISOString().slice(0, 10);
}
const TARGET_DATE = arg('date', tomorrow());

// ── 지리 계산 ──────────────────────────────────────────────
const R = 6371, toRad = x => x * Math.PI / 180;
function haversine(a, b, c, e) {
  const p = toRad(c - a), q = toRad(e - b);
  const s = Math.sin(p / 2) ** 2 + Math.cos(toRad(a)) * Math.cos(toRad(c)) * Math.sin(q / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// ── 헬퍼 ──────────────────────────────────────────────────
const CANCELLED = /취소/;
function visitedBy(r, name) {
  return (r.visits || []).some(v => v.visitor === name) || (r.visitors || []).includes(name);
}
function phoneOf(r) {
  const c = r.contact || {};
  let p = c.communicationPhone || c.presidentPhone || c.mainContactPhone;
  if (p) return p;
  for (const v of (r.visits || [])) {
    p = v.communicationPhone || v.presidentPhone || v.mainContactPhone;
    if (p) return p;
  }
  return '';
}
function shortDate(d) { return d ? d.slice(2).replace(/-/g, '/') : '-'; } // 2026-06-18 → 26/06/18
function taskBrief(r) {
  const t = r.lastTask;
  if (!t) return '';
  const desc = (t.description || '').replace(/[\r\n]+/g, ' ').trim();
  return `${t.subject || ''}${t.date ? `(${shortDate(t.date)})` : ''}${desc ? ` ${desc.slice(0, 22)}` : ''}`.trim();
}
function addrOf(r) { return r.roadAddress || r.rawAddress || ''; }
// 지점명 포함 매장명 — Opp명의 "_" 앞부분(예: 소막집(해운대장산본점)) 우선, 없으면 account
function storeLabel(r) {
  const nm = (r.name || '').split('_')[0].trim();
  return nm || r.account || '-';
}

// 이름 → 부서 매핑 (lastVisitor / oppOwner 기준 최빈 부서)
function buildDeptMap(records) {
  const tally = {};
  const bump = (name, dept) => {
    if (!name || !dept) return;
    (tally[name] = tally[name] || {})[dept] = (tally[name][dept] || 0) + 1;
  };
  for (const r of records) {
    bump(r.lastVisitor, r.lastVisitorDept);
    bump(r.oppOwner, r.oppOwnerDept);
  }
  const map = {};
  for (const [name, depts] of Object.entries(tally)) {
    map[name] = Object.entries(depts).sort((a, b) => b[1] - a[1])[0][0];
  }
  return map;
}

// SF User 이름→슬랙ID 맵 (맨션용). 동명이인은 Name|Department 로 구분.
async function fetchSlackMap() {
  const { accessToken, instanceUrl } = await getSalesforceToken();
  const q = 'SELECT Name, Department, SlackMemberID__c FROM User WHERE IsActive = true AND SlackMemberID__c != null';
  const r = await soqlQuery(instanceUrl, accessToken, q);
  const byKey = {}, byName = {}, dup = new Set();
  for (const u of r.records) {
    const id = u.SlackMemberID__c;
    byKey[`${u.Name}|${u.Department}`] = id;
    if (byName[u.Name] && byName[u.Name] !== id) dup.add(u.Name); // 동명이인
    byName[u.Name] = id;
  }
  return { byKey, byName, dup };
}
function mentionOf(map, name, dept) {
  if (!map) return '';
  const id = map.byKey[`${name}|${dept}`] || (!map.dup.has(name) ? map.byName[name] : '');
  return id ? `<@${id}>` : '';
}

// ── 메시지 빌드 ────────────────────────────────────────────
function buildNearbySections(target, allRecords, visitorName, visitorDept) {
  const near = [];
  for (const r of allRecords) {
    if (!r.lat || !r.lng || r.oppId === target.oppId) continue;
    if (r.stage === 'Closed Won') continue;
    if (EXCLUDE_CL && r.stage === 'Closed Lost') continue;
    const km = haversine(target.lat, target.lng, r.lat, r.lng);
    if (km > RADIUS) continue;
    near.push({
      r, km: Math.round(km * 10) / 10,
      owner: r.oppOwner || '-',
      visitor: r.lastVisitor || r.owner || '-',
      visitorDept: r.lastVisitorDept || r.dept || '-',
      visitDate: r.lastVisitDate || '-',
      visited: visitedBy(r, visitorName),
    });
  }
  const sec1 = near.filter(x => x.visited).sort((a, b) => a.km - b.km);
  const sec2 = near.filter(x => !x.visited && x.visitorDept === visitorDept && x.visitor !== visitorName)
    .sort((a, b) => a.km - b.km);
  return { sec1, sec2, total: near.length };
}

// 단계 영문 → 한글
const STAGE_KO = { 'Closed Won': '계약완료', 'Closed Lost': '실패' };
const stageKo = s => STAGE_KO[s] || s || '-';

const oppLink = r => `<${SF_BASE}/${r.oppId}/view|열기>`;

// ① 본인 방문이력 — 매장(depth1) + 필드(depth2 들여쓰기)
function line1(x, tag) {
  const r = x.r, ph = phoneOf(r), tb = taskBrief(r);
  const lines = [
    `*${storeLabel(r)}*  ${stageKo(r.stage)} · ${x.km}km${tag ? ` · ${tag}` : ''}`,
    `   - 전화: ${ph || '-'}`,
    `   - 주소: ${addrOf(r) || '-'}`,
    `   - 방문일: ${shortDate(x.visitDate)}`,
  ];
  if (tb) lines.push(`   - 최근활동: ${tb}`);
  lines.push(`   - 영업기회: ${oppLink(r)}`);
  return lines.join('\n');
}
// ② 같은팀 다른담당 — 매장(depth1) + 필드(depth2 들여쓰기)
function line2(x, tag) {
  const r = x.r, ph = phoneOf(r), tb = taskBrief(r);
  const lines = [
    `*${storeLabel(r)}*  ${stageKo(r.stage)} · ${x.km}km${tag ? ` · ${tag}` : ''}`,
    `   - 담당자: ${x.owner}`,
    `   - 방문담당자: ${x.visitor}`,
    `   - 전화: ${ph || '-'}`,
    `   - 주소: ${addrOf(r) || '-'}`,
    `   - 방문일: ${shortDate(x.visitDate)}`,
  ];
  if (tb) lines.push(`   - 최근활동: ${tb}`);
  lines.push(`   - 영업기회: ${oppLink(r)}`);
  return lines.join('\n');
}

// 부모(스레드 시작) 메시지 — 매장 1곳의 방문 정보
function buildStoreParent(visitorName, dateLabel, store, mention) {
  const loc = [store.sido, store.sigugun].filter(Boolean).join(' ');
  const time = (store.time && store.time !== '00:00') ? ` ${store.time}` : '';
  let msg = `*[방문 전 주변매장 컨택]*${mention ? ' ' + mention : ''}\n`;
  msg += `   - 방문자: ${visitorName}\n`;
  msg += `   - 일시: ${dateLabel}${time}\n`;
  msg += `   - 매장: ${store.account} (${stageKo(store.stage)})\n`;
  msg += `   - 주소: ${store.addr || loc}\n`;
  msg += `   - 영업기회: <${SF_BASE}/${store.oppId}/view|열기>\n`;
  msg += `이 매장 주변 컨택 후보는 아래 스레드 참고 (반경 ${RADIUS}km, CW${EXCLUDE_CL ? '·CL' : ''} 제외)`;
  return msg;
}

// 매장 1곳 → 주변 후보 "매장별" 댓글 배열 (1매장 = 1댓글, --cap 으로 섹션별 상한)
function buildStoreThreadComments(store, allRecords, visitorName, visitorDept) {
  const { sec1, sec2 } = buildNearbySections(store, allRecords, visitorName, visitorDept);
  const comments = [];
  const take = (arr, fmt, tag) => {
    const list = CAP_PER_STORE ? arr.slice(0, CAP_PER_STORE) : arr;
    list.forEach(x => comments.push(fmt(x, tag)));
    if (CAP_PER_STORE && arr.length > CAP_PER_STORE)
      comments.push(`${tag} — 가까운 ${CAP_PER_STORE}곳만 표시 (총 ${arr.length}곳 중 ${arr.length - CAP_PER_STORE}곳 생략)`);
  };
  take(sec1, line1, '① 내 방문이력');
  take(sec2, line2, '② 같은팀 타담당');
  return comments;
}

// ── 메인 ──────────────────────────────────────────────────
async function main() {
  console.log(`📥 visits/tracking.json 로딩... (대상일 ${TARGET_DATE})`);
  const data = await fetchJSON('visits/tracking.json');
  if (!data || !data.records) { console.error('❌ visit-tracking 데이터 없음'); process.exit(1); }
  const records = data.records;
  console.log(`✅ ${records.length}건 로드 (generatedAt ${data.generatedAt})`);

  const deptMap = buildDeptMap(records);

  // 맨션용 슬랙ID 맵 (실패해도 맨션만 빠지고 진행)
  let slackMap = null;
  if (!NO_MENTION) {
    try {
      slackMap = await fetchSlackMap();
      console.log(`✅ 슬랙ID 맵 로드 (${Object.keys(slackMap.byName).length}명${slackMap.dup.size ? `, 동명이인 ${slackMap.dup.size}` : ''})`);
    } catch (e) {
      console.warn(`⚠️  슬랙ID 맵 로드 실패 — 맨션 없이 진행: ${e.message}`);
    }
  }

  // 대상일에 방문 예정(미완료·미취소)인 visit 수집 → 방문담당자별 그룹
  const byVisitor = {};
  for (const r of records) {
    if (!r.lat || !r.lng) continue;
    for (const v of (r.visits || [])) {
      if (v.visitDate !== TARGET_DATE) continue;
      if (v.isComplete) continue;
      if (CANCELLED.test(v.status || '')) continue;
      const who = v.visitor;
      if (!who) continue;
      if (ONLY_VISITOR && who !== ONLY_VISITOR) continue;
      if (EXCLUDE_DEPTS.has(deptMap[who])) continue; // 제외 부서(기본 리텐션) 스킵
      if (ONLY_DEPT.size && !ONLY_DEPT.has(deptMap[who])) continue; // 특정 부서만
      (byVisitor[who] = byVisitor[who] || []).push({
        oppId: r.oppId, account: storeLabel(r), stage: r.stage,
        lat: r.lat, lng: r.lng, sido: r.sido, sigugun: r.sigugun,
        addr: r.roadAddress || r.rawAddress || '',
        time: (v.visitDateTime || '').slice(11),
      });
    }
  }

  const visitors = Object.keys(byVisitor);
  if (!visitors.length) {
    console.log(`ℹ️  ${TARGET_DATE} 방문 예정(좌표 보유) 건 없음${ONLY_VISITOR ? ` (visitor=${ONLY_VISITOR})` : ''}`);
    return;
  }

  // 날짜 라벨 (6/24(화))
  const [yy, mm, dd] = TARGET_DATE.split('-').map(Number);
  const dow = ['일', '월', '화', '수', '목', '금', '토'][new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay()];
  const dateLabel = `${mm}/${dd}(${dow})`;

  const routeNote = CH_OVERRIDE ? `단일채널 ${CH_OVERRIDE}` : '부서별 채널 라우팅';
  console.log(`📤 방문담당자 ${visitors.length}명 · ${routeNote}${DRY_RUN ? ' (DRY RUN)' : ''}\n`);

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // rate limit 재시도 포함 발송
  const postMsg = async (payload, tries = 4) => {
    for (let i = 0; i < tries; i++) {
      try { return await slack.chat.postMessage(payload); }
      catch (err) {
        const ra = err && err.data && err.data.retry_after;
        if (err && err.data && err.data.error === 'ratelimited' && i < tries - 1) {
          await sleep(((ra || 2) + 1) * 1000); continue;
        }
        throw err;
      }
    }
  };

  let okMsgs = 0, fail = 0, storeCnt = 0;
  for (const name of visitors) {
    const dept = deptMap[name] || '-';
    const ch = channelFor(dept); // 부서별 채널 라우팅
    const mention = mentionOf(slackMap, name, dept); // 맨션
    const stores = byVisitor[name].sort((a, b) => (a.time || '').localeCompare(b.time || ''));

    // 방문 매장 1곳 = 독립 부모 메시지 + 주변 매장 1곳당 댓글 1개
    for (const store of stores) {
      const parent = buildStoreParent(name, dateLabel, store, mention);
      const comments = buildStoreThreadComments(store, records, name, dept);
      storeCnt++;

      if (DRY_RUN) {
        console.log('═'.repeat(64));
        console.log(`[부모] ${name}/${dept} → ${ch} — ${store.account} (주변 댓글 ${comments.length}개)`);
        console.log('═'.repeat(64));
        console.log(parent);
        comments.forEach((m, i) => {
          console.log(`\n  ┌─ 🧵 댓글 [${i + 1}/${comments.length}]`);
          console.log(m.split('\n').map(l => '  │ ' + l).join('\n'));
        });
        console.log('');
        okMsgs += 1 + comments.length;
        continue;
      }
      try {
        const res = await postMsg({ channel: ch, text: parent, unfurl_links: false, unfurl_media: false });
        const thread_ts = res.ts;
        okMsgs++;
        for (const m of comments) {
          await sleep(1000); // rate limit
          await postMsg({ channel: ch, thread_ts, text: m, unfurl_links: false, unfurl_media: false });
          okMsgs++;
        }
        console.log(`  ✅ ${name} · ${store.account} → ${ch}: 부모1 + 댓글${comments.length}`);
        await sleep(1200);
      } catch (err) {
        console.error(`  ❌ ${name} · ${store.account} 발송 실패: ${err.message}`);
        fail++;
      }
    }
  }
  console.log(`\n━━━━━━━━━━\n방문매장 ${storeCnt}곳 · ${DRY_RUN ? '생성' : '발송'} 메시지 ${okMsgs}건 / 실패 ${fail}건`);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
