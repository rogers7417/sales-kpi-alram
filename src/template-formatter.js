/**
 * 템플릿 기반 Canvas 마크다운 포맷터 (Claude API 불필요)
 *
 * extract*Data() 결과를 입력받아 Canvas 체크리스트 마크다운으로 변환.
 * buildMessage()의 Claude 호출을 대체하는 용도.
 */

function fmt(v, unit = '') {
  if (v === null || v === undefined || v === '') return '-';
  return `${v}${unit}`;
}

function line(label, value) {
  return `- ${label}: **${value}**`;
}

function daysBetween(fromDate, todayStr) {
  if (!fromDate) return null;
  const diff = Math.floor((new Date(todayStr) - new Date(fromDate)) / 86400000);
  return isNaN(diff) ? null : diff;
}

// ─────────────────────────────────────────────────────────
// IS — 인사이드세일즈
// ─────────────────────────────────────────────────────────
function formatIS(d) {
  const out = [];
  out.push(`## ${d.name}님 액션 플랜 (${d.date})`);
  out.push('');
  out.push('### 📊 이번달 현황');
  out.push(line('팀 SQL 전환율', fmt(d.team.sqlConversionRate, '%')));
  out.push(line('내 리드', fmt(d.personal.lead, '건')));
  out.push(line('내 MQL → SQL', `${fmt(d.personal.mql)} → ${fmt(d.personal.sql)} (${fmt(d.personal.sqlConversionRate, '%')})`));
  out.push(line('평균 FRT', fmt(d.personal.avgFrt)));
  out.push('');

  if (d.frtPendingCount > 0) {
    out.push(`### 🚨 FRT 20분 초과 계류 (${d.frtPendingCount}건)`);
    out.push('초기 응답 지연된 리드 — 즉시 응답 권장');
    out.push('');
  }

  if (d.retouchLeads.length > 0) {
    out.push(`### 🔁 리터치 대상 (${d.retouchLeads.length}건)`);
    d.retouchLeads.slice(0, 15).forEach(r => {
      const age = daysBetween(r.createdDate, d.date);
      out.push(`- [ ] \`${r.leadName || r.company || '-'}\` ${r.status} · ${age ?? '?'}일 경과`);
    });
    out.push('');
  }

  if (d.absentLeads.length > 0) {
    out.push(`### 📞 부재중 재컨택 (${d.absentLeads.length}건)`);
    d.absentLeads.slice(0, 10).forEach(r => {
      const age = daysBetween(r.createdDate, d.date);
      out.push(`- [ ] \`${r.leadName || r.company || '-'}\` ${age ?? '?'}일 경과`);
    });
    out.push('');
  }

  if (d.noVisitList.length > 0) {
    out.push(`### 🏃 미방문 SQL (${d.noVisitList.length}건)`);
    d.noVisitList.slice(0, 10).forEach(r => {
      out.push(`- [ ] \`${r.oppName || r.accountName || '-'}\` ${r.oppStage || '-'}`);
    });
    out.push('');
  }

  return out.join('\n');
}

// ─────────────────────────────────────────────────────────
// FS — 필드세일즈
// ─────────────────────────────────────────────────────────
function formatFS(d) {
  const out = [];
  out.push(`## ${d.name}님 액션 플랜 (${d.date})`);
  out.push('');
  out.push('### 📊 견적 현황');
  out.push(line('견적 전체', `${d.counts.totalQuote}건`));
  out.push(line('방문 후 과업 없음', `${d.counts.visitedNoTask}건`));
  out.push(line('오버듀 과업', `${d.counts.overdueTask}건`));
  out.push(line('관리 중', `${d.counts.managed}건`));
  out.push('');

  if (d.visitedNoTask.length > 0) {
    out.push(`### 🚨 방문 후 과업 없는 견적 (${d.visitedNoTask.length}건)`);
    out.push('방문 완료됐지만 다음 과업 미설정 — 팔로업 필요');
    d.visitedNoTask.slice(0, 15).forEach(r => {
      out.push(`- [ ] \`${r.accountName || '-'}\` 방문 ${r.daysSinceVisit ?? '?'}일 경과 · ${r.stageName || '-'}`);
    });
    out.push('');
  }

  if (d.overdueTask.length > 0) {
    out.push(`### ⏰ 오버듀 과업 (${d.overdueTask.length}건)`);
    d.overdueTask.slice(0, 15).forEach(r => {
      out.push(`- [ ] \`${r.accountName || '-'}\` 과업 기한 ${r.nextTaskDate}`);
    });
    out.push('');
  }

  if (d.managed.length > 0) {
    out.push(`### 📋 관리 중 (${d.managed.length}건)`);
    d.managed.slice(0, 10).forEach(r => {
      out.push(`- [ ] \`${r.accountName || '-'}\` 설치희망 ${r.installHopeDate || '-'}`);
    });
    out.push('');
  }

  return out.join('\n');
}

// ─────────────────────────────────────────────────────────
// BO — 백오피스
// ─────────────────────────────────────────────────────────
function formatBO(d) {
  const out = [];
  out.push(`## ${d.name}님 액션 플랜 (${d.date})`);
  out.push('');
  out.push('### 📊 이번달 현황');
  out.push(line('CW 전환율', fmt(d.personal.cwRate, '%')));
  out.push(line('이번달 CW/CL', `${fmt(d.personal.thisMonthCW)} / ${fmt(d.personal.thisMonthCL)}`));
  out.push(line('Open 건', `${fmt(d.personal.open)}건`));
  out.push('');

  if (d.urgent.length > 0) {
    out.push(`### 🚨 설치 임박 2주 이내 (${d.urgent.length}건)`);
    d.urgent.forEach(r => {
      const task = r.hasOpenTask ? '과업 있음' : '**과업 없음**';
      out.push(`- [ ] \`${r.accountName || '-'}\` 설치 ${r.installHopeDate || '-'} · ${r.stageName} · ${task}`);
    });
    out.push('');
  }

  if (d.noNextTask.length > 0) {
    out.push(`### ❗ 다음 과업 없는 건 (${d.noNextTask.length}건)`);
    d.noNextTask.forEach(r => {
      out.push(`- [ ] \`${r.accountName || '-'}\` ${r.stageName} · 설치 ${r.installHopeDate || '-'}`);
    });
    out.push('');
  }

  if (d.staleTouched.length > 0) {
    out.push(`### 💤 터치 공백 5일+ (${d.staleTouched.length}건)`);
    d.staleTouched.forEach(r => {
      out.push(`- [ ] \`${r.accountName || '-'}\` 마지막 터치 ${r.daysSinceLastTask}일 전`);
    });
    out.push('');
  }

  if (d.otherStagesSummary.count > 0) {
    out.push(`### 📦 기타 단계 진행 중 (${d.otherStagesSummary.count}건)`);
    Object.entries(d.otherStagesSummary.stages).forEach(([stage, count]) => {
      out.push(`- ${stage}: ${count}건`);
    });
    out.push('');
  }

  return out.join('\n');
}

// ─────────────────────────────────────────────────────────
// TM — 텔레마케팅
// ─────────────────────────────────────────────────────────
function formatTM(d) {
  const out = [];
  out.push(`## ${d.name}님 액션 플랜 (${d.date})`);
  out.push('');
  out.push('### 📊 이번달 현황');
  out.push(line('팀 전환율', fmt(d.team.conversionRate, '%')));
  out.push(line('팀 평균 전환율', fmt(d.team.teamAvgRate, '%')));
  out.push(line('내 MQL/SQL', `${fmt(d.personal.mql)} / ${fmt(d.personal.sql)} (${fmt(d.personal.conversionRate, '%')})`));
  out.push(line('FRT 준수율', fmt(d.frt.complianceRate, '%')));
  out.push('');

  if (d.retouchLeads.length > 0) {
    out.push(`### 🔁 리터치 대상 (${d.retouchLeads.length}건)`);
    d.retouchLeads.slice(0, 15).forEach(l => {
      const age = daysBetween(l.createdDate, d.date);
      out.push(`- [ ] \`${l.company || l.leadName || '-'}\` ${l.status} · ${age ?? '?'}일 경과`);
    });
    out.push('');
  }

  if (d.absentLeads.length > 0) {
    out.push(`### 📞 부재중 재컨택 (${d.absentLeads.length}건)`);
    d.absentLeads.slice(0, 10).forEach(l => {
      const age = daysBetween(l.createdDate, d.date);
      out.push(`- [ ] \`${l.company || l.leadName || '-'}\` ${age ?? '?'}일 경과`);
    });
    out.push('');
  }

  if (d.openSQLList.length > 0) {
    out.push(`### ⏳ 7일+ 체류 Open SQL (${d.counts.openSQLOver7}건)`);
    d.openSQLList.slice(0, 15).forEach(o => {
      out.push(`- [ ] \`${o.accountName || '-'}\` ${o.ageInDays}일 체류 · ${o.stageName || '-'}`);
    });
    out.push('');
  }

  return out.join('\n');
}

// ─────────────────────────────────────────────────────────
// AM — 어카운트매니저
// ─────────────────────────────────────────────────────────
function formatAM(d) {
  const out = [];
  out.push(`## ${d.name}님 액션 플랜 (${d.date})`);
  out.push('');
  out.push('### 📊 이번달 현황');
  out.push(line('팀 리드 일평균', fmt(d.team.leadsDailyAvg, '건')));
  out.push(line('팀 안착률', fmt(d.team.onboardingRate, '%')));
  out.push(line('팀 활성 파트너(90일)', fmt(d.team.activeChannels90d, '곳')));
  out.push(line('내 리드', `${fmt(d.personal.totalLeads)}건 (무리드일 ${d.personal.zeroDays}일)`));
  out.push('');

  out.push(`### 🧾 내 파트너 요약`);
  out.push(`- 전체 ${d.partnerSummary.total}곳 · 활성 ${d.partnerSummary.active} · 감소 ${d.partnerSummary.declining} · 비활성 ${d.partnerSummary.inactive}`);
  out.push('');

  if (d.unsettledPartners.length > 0) {
    out.push(`### 🚨 미안착 파트너 (${d.unsettledCount}곳)`);
    out.push('MOU 후 3개월 내 리드 0건 — 안착 window 마감 임박');
    d.unsettledPartners.slice(0, 15).forEach(p => {
      const days = daysBetween(p.mouStart, d.date);
      out.push(`- [ ] \`${p.accountName || p.name || '-'}\` MOU ${days ?? '?'}일 경과`);
    });
    out.push('');
  }

  if (d.decliningPartners.length > 0) {
    out.push(`### 📉 리드 감소 파트너 (${d.decliningPartners.length}곳)`);
    d.decliningPartners.forEach(p => {
      out.push(`- [ ] \`${p.accountName || '-'}\` 최근 3개월 ${p.last3MonthLeadCount}건 → 이번달 0건`);
    });
    out.push('');
  }

  if (d.inactivePartners.length > 0) {
    out.push(`### ⏸ 비활성 파트너 (${d.inactivePartners.length}곳)`);
    d.inactivePartners.forEach(p => {
      const days = daysBetween(p.lastLeadDate, d.date);
      out.push(`- [ ] \`${p.accountName || '-'}\` 마지막 리드 ${p.lastLeadDate || '-'} (${days ?? '?'}일 전)`);
    });
    out.push('');
  }

  if (d.todayMeetings.length > 0) {
    out.push(`### 📅 오늘 미팅 (${d.todayMeetings.length}건)`);
    d.todayMeetings.forEach(m => {
      out.push(`- \`${m.accountName || '-'}\` ${m.isMouComplete ? 'MOU 완료' : 'MOU 미완료'}`);
    });
    out.push('');
  }

  if (d.upcomingMeetings.length > 0) {
    out.push(`### 🗓 예정 미팅`);
    d.upcomingMeetings.forEach(m => {
      out.push(`- ${m.date} \`${m.accountName || '-'}\``);
    });
    out.push('');
  }

  return out.join('\n');
}

// ─────────────────────────────────────────────────────────
// AE — 어카운트이그제큐티브
// ─────────────────────────────────────────────────────────
function formatAE(d) {
  const out = [];
  out.push(`## ${d.name}님 액션 플랜 (${d.date})`);
  out.push('');
  out.push('### 📊 이번달 현황');
  out.push(line('팀 신규 MOU', fmt(d.team.mouNewThisMonth, '건')));
  out.push(line('팀 Nego 진입', fmt(d.team.negoEntryThisMonth, '건')));
  out.push(line('오늘 미팅(미완료)', fmt(d.team.meetingsIncompleteToday)));
  out.push('');

  if (d.todayMeetings.length > 0) {
    out.push(`### 📅 오늘 미팅 (${d.todayMeetings.length}건)`);
    d.todayMeetings.forEach(m => {
      out.push(`- [ ] \`${m.accountName || '-'}\` ${m.isMouComplete ? 'MOU 완료' : '**MOU 미완료**'}`);
    });
    out.push('');
  }

  if (d.mouIncompletePartners.length > 0) {
    out.push(`### 🚨 MOU 미완료 미팅 파트너 (${d.mouIncompletePartners.length}곳)`);
    out.push('미팅했지만 MOU 미체결 — 후속 액션 필요');
    d.mouIncompletePartners.slice(0, 15).forEach(name => {
      out.push(`- [ ] \`${name}\``);
    });
    out.push('');
  }

  if (d.isAMConcurrent && d.unsettledPartners.length > 0) {
    out.push(`### ⚠️ 미안착 파트너 (AM 겸임, ${d.unsettledCount}곳)`);
    d.unsettledPartners.slice(0, 10).forEach(p => {
      const days = daysBetween(p.mouStart, d.date);
      out.push(`- [ ] \`${p.accountName || '-'}\` MOU ${days ?? '?'}일 경과`);
    });
    out.push('');
  }

  if (d.upcomingMeetings.length > 0) {
    out.push(`### 🗓 예정 미팅`);
    d.upcomingMeetings.slice(0, 10).forEach(m => {
      out.push(`- ${m.date} \`${m.accountName || '-'}\``);
    });
    out.push('');
  }

  return out.join('\n');
}

// ─────────────────────────────────────────────────────────
// CS-BO
// ─────────────────────────────────────────────────────────
function formatCSBO(d) {
  const out = [];
  out.push(`## ${d.name}님 액션 플랜 (${d.date})`);
  out.push('');
  out.push('### 📊 이번달 현황');
  out.push(line('CW 전환율', fmt(d.personal.cwRate, '%')));
  out.push(line('이번달 CW/CL', `${fmt(d.personal.thisMonthCW)} / ${fmt(d.personal.thisMonthCL)}`));
  out.push(line('Open 건', `${fmt(d.personal.open)}건`));
  out.push('');

  if (d.noContract.length > 0) {
    out.push(`### 🚨 계약서 없는 건 (${d.counts.noContract}건)`);
    d.noContract.slice(0, 15).forEach(r => {
      out.push(`- [ ] \`${r.accountName || '-'}\` ${r.stageName || '-'} · 설치 ${r.installHopeDate || '-'}`);
    });
    out.push('');
  }

  if (d.urgent.length > 0) {
    out.push(`### ⏰ 설치 임박 2주 이내 (${d.counts.urgent}건)`);
    d.urgent.forEach(r => {
      out.push(`- [ ] \`${r.accountName || '-'}\` 설치 ${r.installHopeDate || '-'}`);
    });
    out.push('');
  }

  if (d.openTaskItems.length > 0) {
    out.push(`### 📋 과업 열린 건 (${d.counts.openTask}건)`);
    d.openTaskItems.slice(0, 10).forEach(r => {
      out.push(`- [ ] \`${r.accountName || '-'}\` 과업 ${r.nextTaskDate || '-'}`);
    });
    out.push('');
  }

  if (d.staleTouched.length > 0) {
    out.push(`### 💤 터치 공백 5일+ (${d.counts.staleTouched}건)`);
    d.staleTouched.forEach(r => {
      const days = daysBetween(r.lastTaskDate, d.date);
      out.push(`- [ ] \`${r.accountName || '-'}\` 마지막 터치 ${days ?? '?'}일 전`);
    });
    out.push('');
  }

  return out.join('\n');
}

const formatters = {
  IS: formatIS,
  FS: formatFS,
  BO: formatBO,
  TM: formatTM,
  AM: formatAM,
  AE: formatAE,
  'CS-BO': formatCSBO,
};

function formatMessage(role, data) {
  const fn = formatters[role];
  if (!fn) throw new Error(`Unknown role: ${role}`);
  return fn(data);
}

module.exports = { formatMessage, formatters };
