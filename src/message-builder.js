/**
 * 멤버별 KPI 데이터 + 팀 프롬프트 → Claude API → 액션 메시지 생성
 */
const fs = require('fs');
const path = require('path');
const { generateMessage } = require('./claude');

// 프롬프트 캐시
const promptCache = {};

function loadPrompt(role) {
  if (!promptCache[role]) {
    const filePath = path.join(__dirname, 'prompts', `${role}.md`);
    promptCache[role] = fs.readFileSync(filePath, 'utf-8');
  }
  return promptCache[role];
}

function getToday() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600000);
  return kst.toISOString().slice(0, 10);
}

/**
 * IS 멤버 데이터 추출
 */
function extractISData(member, inbound) {
  const is = inbound?.inbound?.insideSales;
  if (!is) return null;

  const ownerData = (is.byOwner || []).find(o => o.name === member.name);
  const taskData = (is.dailyTask?.byOwner || []).find(o => o.name === member.name);
  const frtOver20 = (is.rawData?.frtOver20 || []).filter(r => r.owner === member.name);
  const unconverted = (is.rawData?.unconvertedMQL || []).filter(r => r.owner === member.name);
  const noVisit = (is.rawData?.noVisitSQL || []).filter(r => r.owner === member.name);

  // 리터치 대상: 리터치예정/고민중/장기부재 (종료 제외)
  const retouchLeads = unconverted
    .filter(r => r.status && ['리터치예정', '고민중', '장기부재'].includes(r.status))
    .sort((a, b) => (a.createdDate || '').localeCompare(b.createdDate || ''));

  // 부재중: 별도 그룹
  const absentLeads = unconverted
    .filter(r => r.status === '부재중')
    .sort((a, b) => (a.createdDate || '').localeCompare(b.createdDate || ''));

  // 미방문 SQL: Closed Lost/Closed Won 제외 (액션 불필요)
  const activeNoVisit = noVisit.filter(r =>
    r.oppStage && !r.oppStage.startsWith('Closed')
  );

  // FRT 초과 중 아직 계류 상태인 건 (종료/Qualified 제외)
  const frtPending = frtOver20.filter(r =>
    r.status && !['종료', 'Qualified', 'Unqualified', 'SQL'].includes(r.status)
  );

  return {
    name: member.name,
    date: getToday(),
    team: {
      sqlConversionRate: is.sqlConversionRate,
      visitCount: is.visitCount,
      mql: is.mql,
      sql: is.sql,
    },
    personal: {
      lead: ownerData?.lead,
      mql: ownerData?.mql,
      sql: ownerData?.sql,
      sqlConversionRate: ownerData?.sqlConversionRate,
      avgFrt: ownerData?.avgFrt,
      visitRate: ownerData?.visitRate,
    },
    dailyTask: taskData || {},
    retouchLeads,
    absentLeads,
    noVisitList: activeNoVisit,
    frtPendingCount: frtPending.length,
    counts: {
      retouch: retouchLeads.length,
      absent: absentLeads.length,
      noVisit: activeNoVisit.length,
      closed: unconverted.filter(r => r.status === '종료').length,
    },
  };
}

/**
 * FS 멤버 데이터 추출
 */
function extractFSData(member, inbound) {
  const fs = inbound?.inbound?.fieldSales;
  if (!fs) return null;

  const userData = (fs.cwConversionRate?.byUser || []).find(u => u.name === member.name);
  const todayStr = getToday();

  // Raw Open Opps — 이 FS 담당 건
  const rawOpen = (fs.rawData?.rawOpenOpps || []).filter(r =>
    r.fieldUser === member.name || r.owner === member.name
  );

  // 견적/재견적 단계만 (출고/계약/설치는 BO 영역)
  const quoteOnly = rawOpen.filter(r =>
    r.stageName && (r.stageName.includes('견적') || r.stageName === '재견적')
  );

  // 1순위: 방문 후 과업 없는 견적 건 (방문 경과일 오래된 순)
  const visitedNoTask = quoteOnly
    .filter(r => r.visitCompleteDate && !r.hasOpenTask)
    .sort((a, b) => (b.daysSinceVisit || 0) - (a.daysSinceVisit || 0));

  // 2순위: 오버듀 과업 (기한 지난 열린 과업)
  const overdueTask = quoteOnly
    .filter(r => r.hasOpenTask && r.nextTaskDate && r.nextTaskDate < todayStr)
    .sort((a, b) => (a.nextTaskDate || '').localeCompare(b.nextTaskDate || ''));

  // 과업 있는 건 (터치 유지 중)
  const managed = quoteOnly
    .filter(r => r.hasOpenTask && (!r.nextTaskDate || r.nextTaskDate >= todayStr))
    .sort((a, b) => (a.installHopeDate || '9999').localeCompare(b.installHopeDate || '9999'));

  return {
    name: member.name,
    date: todayStr,
    visitedNoTask,
    overdueTask,
    managed,
    counts: {
      totalQuote: quoteOnly.length,
      visitedNoTask: visitedNoTask.length,
      overdueTask: overdueTask.length,
      managed: managed.length,
    },
  };
}

/**
 * BO 멤버 데이터 추출
 */
function extractBOData(member, inbound) {
  const bo = inbound?.inbound?.backOffice;
  if (!bo) return null;

  const userData = (bo.cwConversionRate?.byUser || []).find(u => u.name === member.name);
  const backlogUser = (bo.sqlBacklog?.byUser || []).find(u => u.name === member.name);
  const dailyClose = (bo.dailyClose?.byUser || []).find(u => u.name === member.name);
  const contractUser = (bo.contractSummary?.byBO || []).find(u => u.name === member.name);

  // Raw Open Opps — 이 BO 담당 건
  const rawOpen = (bo.rawData?.rawOpenOpps || []).filter(r => r.boUser === member.name);

  const todayStr = getToday();

  // 설치희망일 기준 정렬 함수 (가까운 순, 없으면 맨 뒤)
  const sortByInstallDate = (a, b) => {
    const aDate = a.installHopeDate || '9999-12-31';
    const bDate = b.installHopeDate || '9999-12-31';
    return aDate.localeCompare(bDate);
  };

  // 견적/방문배정 단계 건 — 설치희망일 가까운 순
  const quoteStage = rawOpen
    .filter(r => r.stageName && (r.stageName.includes('견적') || r.stageName === '재견적'))
    .sort(sortByInstallDate);

  const visitStage = rawOpen
    .filter(r => r.stageName && r.stageName.includes('방문'))
    .sort(sortByInstallDate);

  const quoteVisit = [...quoteStage, ...visitStage];

  // 긴급: 설치희망일이 2주 이내인 건
  const twoWeeksLater = new Date(todayStr);
  twoWeeksLater.setDate(twoWeeksLater.getDate() + 14);
  const twoWeeksStr = twoWeeksLater.toISOString().slice(0, 10);

  const urgent = quoteVisit
    .filter(r => r.installHopeDate && r.installHopeDate <= twoWeeksStr)
    .sort(sortByInstallDate);

  // 견적 생성 후 계류 건
  // 조건: 이번달 생성 영업기회 + 견적 단계 + 견적 발송 후 2일+ 경과 + 다음 과업 없음
  const monthStart = todayStr.slice(0, 7) + '-01';
  const twoDaysAgo = new Date(todayStr);
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
  const twoDaysAgoStr = twoDaysAgo.toISOString().slice(0, 10);

  const quoteStalled = quoteStage
    .filter(r =>
      r.createdDate && r.createdDate.slice(0, 10) >= monthStart &&
      r.hasQuote && r.quoteCreatedDate && r.quoteCreatedDate.slice(0, 10) <= twoDaysAgoStr &&
      !r.hasOpenTask
    )
    .sort((a, b) => (a.quoteCreatedDate || '').localeCompare(b.quoteCreatedDate || ''));

  // 다음 과업 없는 건 — 단, "견적 생성 후 계류"에 포함된 건은 제외 (중복 방지)
  const quoteStalledIds = new Set(quoteStalled.map(r => r.oppId));
  const noNextTask = quoteVisit
    .filter(r => !r.hasOpenTask && !quoteStalledIds.has(r.oppId))
    .sort(sortByInstallDate);

  // 기타 단계 (선납금/출고/설치/계약 진행) — 요약만
  const otherStages = rawOpen.filter(r =>
    r.stageName && !r.stageName.includes('견적') && r.stageName !== '재견적' && !r.stageName.includes('방문')
  );

  return {
    name: member.name,
    date: getToday(),
    personal: {
      total: userData?.total,
      cw: userData?.cw,
      cl: userData?.cl,
      open: userData?.open,
      cwRate: userData?.cwRate,
      thisMonthCW: userData?.thisMonthCW,
      thisMonthCL: userData?.thisMonthCL,
      openByAge: userData?.openByAge,
    },
    dailyClose: dailyClose || {},
    contract: contractUser || {},
    urgent: urgent.slice(0, 15),
    noNextTask: noNextTask.slice(0, 10),
    quoteStalled,
    otherStagesSummary: {
      count: otherStages.length,
      stages: otherStages.reduce((acc, r) => {
        acc[r.stageName] = (acc[r.stageName] || 0) + 1;
        return acc;
      }, {}),
    },
    counts: {
      totalOpen: rawOpen.length,
      quote: quoteStage.length,
      visit: visitStage.length,
      urgent: urgent.length,
      noNextTask: noNextTask.length,
      quoteStalled: quoteStalled.length,
    },
  };
}

/**
 * TM 멤버 데이터 추출
 */
function extractTMData(member, csData) {
  const leadsByOwner = csData?.summary?.channelLeadsByOwner;
  if (!leadsByOwner) return null;

  const ownerData = (leadsByOwner.data || []).find(o => o.owner === member.name);
  const frtData = (leadsByOwner.frt?.byOwner || []).find(o => o.name === member.name);
  const notConverted = (leadsByOwner.notConverted?.byOwner || []).find(o => o.owner === member.name);

  // 미전환 리드 상태별 분류 (name이 null/없음인 건 "이름미확인"으로 표시)
  const cleanName = (l) => ({
    ...l,
    name: (l.name && l.name !== 'null' && l.name !== '-') ? l.name : '이름미확인',
  });
  const allNotConverted = (notConverted?.leads || []).map(cleanName);
  const retouchLeads = allNotConverted.filter(l => l.status === '리터치예정' || l.status === '고민중' || l.status === '장기부재');
  const absentLeads = allNotConverted.filter(l => l.status === '부재중');
  const closedLeads = allNotConverted.filter(l => l.status === '종료');

  // SQL Pipeline — 이 사람의 Open 건 중 7일+ 경과 (시급한 순)
  const allOpenSQL = (leadsByOwner.sqlPipeline?.openList || []).filter(o => o.owner === member.name);
  const openList = allOpenSQL
    .filter(o => (o.ageInDays || 0) >= 7)
    .sort((a, b) => (b.ageInDays || 0) - (a.ageInDays || 0));

  // 팀 평균 전환율
  const allRates = (leadsByOwner.data || []).map(o => parseFloat(o.conversionRate)).filter(v => !isNaN(v));
  const teamAvgRate = allRates.length > 0 ? (allRates.reduce((a, b) => a + b, 0) / allRates.length).toFixed(1) : '-';

  // 시간대별 전환
  const timeSlot = (leadsByOwner.timeSlotByOwner || []).find(o => o.name === member.name);

  return {
    name: member.name,
    date: getToday(),
    team: {
      totalMQL: leadsByOwner.totalMQL,
      totalSQL: leadsByOwner.totalSQL,
      conversionRate: leadsByOwner.conversionRate,
      teamAvgRate,
    },
    personal: ownerData || {},
    frt: frtData || {},
    retouchLeads,
    absentLeads,
    openSQLList: openList.map(({ amount, ...rest }) => rest),
    timeSlot: timeSlot || {},
    counts: {
      retouch: retouchLeads.length,
      absent: absentLeads.length,
      closed: closedLeads.length,
      totalNotConverted: allNotConverted.length,
      openSQLOver7: openList.length,
      openSQLTotal: allOpenSQL.length,
    },
  };
}

/**
 * AM 멤버 데이터 추출
 */
/**
 * 스코어에서 "만점에 가장 가까운 항목" 찾기
 * — 단기 목표가 인간에게 더 효과적 (Miller's law)
 */
function findClosestToMax(score) {
  if (!score?.breakdown) return null;
  const items = Object.entries(score.breakdown)
    .map(([key, item]) => ({
      key,
      label: item.label,
      pts: item.pts,
      max: item.max,
      actual: item.actual,
      target: item.target,
      gap: item.max - item.pts, // 만점까지 남은 점수
      ratio: item.pts / item.max,
    }))
    .filter(i => i.gap > 0); // 이미 만점인 건 제외

  if (items.length === 0) return null;

  // 만점까지 가장 가까운 (gap이 작은) 항목, 단 0점은 후순위
  items.sort((a, b) => {
    if (a.pts === 0 && b.pts > 0) return 1;
    if (b.pts === 0 && a.pts > 0) return -1;
    return a.gap - b.gap;
  });

  return items[0];
}

/**
 * 점수 객체를 표준 형식으로 변환
 */
function normalizeScore(rawScore) {
  if (!rawScore) return null;
  return {
    total: rawScore.total,
    grade: rawScore.grade,
    breakdown: rawScore.breakdown,
    closestToMax: findClosestToMax(rawScore),
  };
}

/**
 * 멤버별 점수 가져오기
 */
function getMemberScore(inboundData, role, memberName) {
  const scores = inboundData?.scores;
  if (!scores) return null;

  // 배열 형식 (IS/FS/BO/CS-BO)
  if (role === 'IS') return normalizeScore((scores.is || []).find(s => s.name === memberName));
  if (role === 'FS') return normalizeScore((scores.fs || []).find(s => s.name === memberName));
  if (role === 'BO') return normalizeScore((scores.bo || []).find(s => s.name === memberName));
  if (role === 'CS-BO') return normalizeScore((scores.csbo || []).find(s => s.name === memberName));

  // perMember 형식 (AM/AE)
  if (role === 'AM') return normalizeScore((scores.am?.perMember || []).find(s => s.name === memberName));
  if (role === 'AE') return normalizeScore((scores.ae?.perMember || []).find(s => s.name === memberName));

  // 팀 단위 (TM은 팀 점수만)
  if (role === 'TM') return normalizeScore(scores.tm);

  return null;
}

function extractAMData(member, csData, inboundData) {
  const leadsByOwner = csData?.summary?.channelLeadsByOwner;
  const amHeatmap = leadsByOwner?.amHeatmap;
  const kpi = csData?.kpi;
  const onboarding = csData?.mouStats?.onboarding;

  const heatmapData = (amHeatmap?.data || []).find(o => o.owner === member.name);
  const meetingData = (kpi?.meetingsByOwner || []).find(o => o.name === member.name);

  // 미안착 파트너 (이 AM 담당) — MOU 오래된 순
  const unsettled = (onboarding?.partner?.list || [])
    .filter(p => p.owner === member.name && !p.settled)
    .sort((a, b) => (a.mouStart || '').localeCompare(b.mouStart || ''));

  // 오늘~이번주 미팅 캘린더
  const todayStr = getToday();
  const calendar = kpi?.meetingCalendar || {};
  const allMeetings = [];
  for (const [date, meetings] of Object.entries(calendar)) {
    meetings
      .filter(m => m.owner === member.name)
      .forEach(m => allMeetings.push({ ...m, date }));
  }
  allMeetings.sort((a, b) => a.date.localeCompare(b.date));

  const pastMeetings = allMeetings.filter(m => m.date < todayStr);
  const todayMeetings = allMeetings.filter(m => m.date === todayStr);
  const upcomingMeetings = allMeetings.filter(m => m.date > todayStr);

  const partnerStats = csData?.partnerStats || [];
  const myPartners = partnerStats.filter(p => p.owner === member.name);

  // 활성 파트너 — 이번달 리드 있음 (리드 많은 순)
  const activePartners = myPartners
    .filter(p => p.thisMonthLeadCount > 0)
    .sort((a, b) => b.thisMonthLeadCount - a.thisMonthLeadCount);

  // 리드 감소 — 이번달 0건이지만 최근 3개월 리드 있었음 (3개월 리드 많은 순)
  const decliningPartners = myPartners
    .filter(p => p.thisMonthLeadCount === 0 && p.last3MonthLeadCount > 0)
    .sort((a, b) => b.last3MonthLeadCount - a.last3MonthLeadCount);

  // 비활성 — 3개월+ 무리드 (과거 리드 있었음)
  const inactivePartners = myPartners
    .filter(p => p.thisMonthLeadCount === 0 && p.last3MonthLeadCount === 0 && p.leadCount > 0)
    .sort((a, b) => (a.lastLeadDate || '').localeCompare(b.lastLeadDate || ''));

  // 스코어 (inbound 데이터에 있음)
  const myScore = (inboundData?.scores?.am?.perMember || []).find(s => s.name === member.name);
  const closestToMax = findClosestToMax(myScore);

  return {
    name: member.name,
    date: todayStr,
    score: myScore ? {
      total: myScore.total,
      grade: myScore.grade,
      breakdown: myScore.breakdown,
      closestToMax,
    } : null,
    team: {
      leadsDailyAvg: kpi?.am?.leadsDailyAvg,
      leadsThisMonth: kpi?.am?.leadsThisMonth,
      onboardingRate: kpi?.am?.onboardingRate,
      activeChannels90d: kpi?.am?.activeChannels90d,
    },
    personal: {
      totalLeads: heatmapData?.total || 0,
      zeroDays: heatmapData?.zeroDays || 0,
    },
    meetings: meetingData || {},
    todayMeetings,
    upcomingMeetings: upcomingMeetings.slice(0, 5),
    recentMeetings: pastMeetings.slice(-5),
    unsettledPartners: unsettled,
    unsettledCount: unsettled.length,
    activePartners: activePartners.slice(0, 5),
    decliningPartners: decliningPartners.slice(0, 10),
    inactivePartners: inactivePartners.slice(0, 5),
    partnerSummary: {
      total: myPartners.length,
      active: activePartners.length,
      declining: decliningPartners.length,
      inactive: inactivePartners.length,
    },
  };
}

/**
 * AE 멤버 데이터 추출
 */
function extractAEData(member, csData, inboundData) {
  const kpi = csData?.kpi;
  const meetingData = (kpi?.meetingsByOwner || []).find(o => o.name === member.name);

  const todayStr = getToday();
  const calendar = kpi?.meetingCalendar || {};

  // 이번달 전체 미팅 (이 사람꺼)
  const allMeetings = [];
  for (const [date, meetings] of Object.entries(calendar)) {
    meetings
      .filter(m => m.owner === member.name)
      .forEach(m => allMeetings.push({ ...m, date }));
  }
  allMeetings.sort((a, b) => a.date.localeCompare(b.date));

  const pastMeetings = allMeetings.filter(m => m.date < todayStr);
  const todayMeetings = allMeetings.filter(m => m.date === todayStr);
  const upcomingMeetings = allMeetings.filter(m => m.date > todayStr);

  // MOU 미완료 파트너 중 미팅한 곳 (후속 액션 필요)
  const mouIncompletePartners = [...new Set(
    allMeetings.filter(m => !m.isMouComplete).map(m => m.accountName)
  )];

  // 미안착 파트너 (AM 겸임 시)
  const onboarding = csData?.mouStats?.onboarding;
  const unsettled = (onboarding?.partner?.list || [])
    .filter(p => p.owner === member.name && !p.settled);

  // 스코어 (inbound 데이터에 있음)
  const myScore = (inboundData?.scores?.ae?.perMember || []).find(s => s.name === member.name);
  const closestToMax = findClosestToMax(myScore);

  return {
    name: member.name,
    date: todayStr,
    score: myScore ? {
      total: myScore.total,
      grade: myScore.grade,
      breakdown: myScore.breakdown,
      closestToMax,
    } : null,
    team: {
      mouNewThisMonth: kpi?.bd?.mouNewThisMonth,
      negoEntryThisMonth: kpi?.bd?.negoEntryThisMonth,
      meetingsIncompleteToday: kpi?.bd?.meetingsIncompleteToday,
      meetingsIncompleteAvg: kpi?.bd?.meetingsIncompleteAvg,
    },
    meetings: meetingData || {},
    pastMeetings: pastMeetings.slice(-10),
    todayMeetings,
    upcomingMeetings,
    mouIncompletePartners,
    unsettledPartners: unsettled.slice(0, 10),
    unsettledCount: unsettled.length,
    isAMConcurrent: member.roles.includes('AM'),
  };
}

/**
 * CS-BO 멤버 데이터 추출
 * 데이터 위치: inbound.channel.backOffice
 */
function extractCSBOData(member, inboundData) {
  const csbo = inboundData?.channel?.backOffice;
  if (!csbo) return null;

  const userData = (csbo.cwConversionRate?.byUser || []).find(u => u.name === member.name);
  const dailyClose = (csbo.dailyClose?.byUser || []).find(u => u.name === member.name);
  const contractUser = (csbo.contractSummary?.byBO || []).find(u => u.name === member.name);

  const rawOpen = (csbo.rawData?.rawOpenOpps || []).filter(r => r.boUser === member.name);
  const todayStr = getToday();

  const sortByInstallDate = (a, b) => {
    const aDate = a.installHopeDate || '9999-12-31';
    const bDate = b.installHopeDate || '9999-12-31';
    return aDate.localeCompare(bDate);
  };

  // 1순위: 계약서 없는 건
  const noContract = rawOpen
    .filter(r => !r.hasContract)
    .sort(sortByInstallDate);

  // 2순위: 과업 열린 건 (계약서 있는 건 중)
  const openTaskItems = rawOpen
    .filter(r => r.hasContract && r.hasOpenTask)
    .sort((a, b) => (a.nextTaskDate || '9999').localeCompare(b.nextTaskDate || '9999'));

  // 3순위: 설치 임박 2주 이내 (위에 해당 안 하는 건)
  const twoWeeksLater = new Date(todayStr);
  twoWeeksLater.setDate(twoWeeksLater.getDate() + 14);
  const twoWeeksStr = twoWeeksLater.toISOString().slice(0, 10);

  const urgent = rawOpen
    .filter(r => r.hasContract && !r.hasOpenTask && r.installHopeDate && r.installHopeDate <= twoWeeksStr)
    .sort(sortByInstallDate);

  // 터치 공백 5일+
  const staleTouched = rawOpen
    .filter(r => {
      if (!r.lastTaskDate) return true;
      const diff = Math.floor((new Date(todayStr) - new Date(r.lastTaskDate)) / 86400000);
      return diff >= 5;
    })
    .sort((a, b) => (a.lastTaskDate || '').localeCompare(b.lastTaskDate || ''));

  // 나머지 건 (위에 해당 안 하는 건)
  const coveredIds = new Set([
    ...noContract.map(r => r.oppId),
    ...openTaskItems.map(r => r.oppId),
    ...urgent.map(r => r.oppId),
  ]);
  const remaining = rawOpen
    .filter(r => !coveredIds.has(r.oppId))
    .sort(sortByInstallDate);

  return {
    name: member.name,
    date: todayStr,
    personal: {
      total: userData?.total,
      cw: userData?.cw,
      cl: userData?.cl,
      open: userData?.open,
      cwRate: userData?.cwRate,
      thisMonthCW: userData?.thisMonthCW,
      thisMonthCL: userData?.thisMonthCL,
    },
    dailyClose: dailyClose || {},
    contract: contractUser || {},
    noContract,
    openTaskItems,
    urgent: urgent.slice(0, 15),
    staleTouched: staleTouched.slice(0, 10),
    remaining: remaining.slice(0, 10),
    stageDistribution: rawOpen.reduce((acc, r) => {
      acc[r.stageName || '-'] = (acc[r.stageName || '-'] || 0) + 1;
      return acc;
    }, {}),
    counts: {
      totalOpen: rawOpen.length,
      noContract: noContract.length,
      openTask: openTaskItems.length,
      urgent: urgent.length,
      staleTouched: staleTouched.length,
      remaining: remaining.length,
    },
  };
}

// 역할별 추출 함수 매핑
const extractors = {
  IS: extractISData,
  FS: extractFSData,
  BO: extractBOData,
  TM: extractTMData,
  AM: extractAMData,
  AE: extractAEData,
  'CS-BO': extractCSBOData,
};

// 역할별 데이터 소스
const dataSources = {
  IS: 'inbound',
  FS: 'inbound',
  BO: 'inbound',
  TM: 'channel',
  AM: 'channel',
  AE: 'channel',
  'CS-BO': 'inbound',
};

/**
 * 멤버 1명의 메시지 생성
 * @param {object} member — members.js에서 온 멤버 객체
 * @param {object} inboundData — S3 인바운드 KPI 데이터
 * @param {object} channelData — S3 채널세일즈 KPI 데이터
 * @returns {Promise<string>} Slack 메시지 텍스트
 */
async function buildMessage(member, inboundData, channelData) {
  const role = member.roles[0]; // 주 역할
  if (!role) return null;

  const promptKey = role === 'CS-BO' ? 'csbo' : role.toLowerCase();
  const systemPrompt = loadPrompt(promptKey);

  const extractor = extractors[role];
  if (!extractor) return null;

  const dataSource = dataSources[role] === 'inbound' ? inboundData : channelData;
  // AM/AE는 score를 위해 inboundData도 함께 전달
  const memberData = ['AM', 'AE'].includes(role)
    ? extractor(member, dataSource, inboundData)
    : extractor(member, dataSource);
  if (!memberData) return null;

  // 모든 파트에 score 주입 (AM/AE는 이미 extractor에서 처리)
  if (!memberData.score) {
    memberData.score = getMemberScore(inboundData, role, member.name);
  }

  const userMessage = JSON.stringify(memberData, null, 2);
  return generateMessage(systemPrompt, userMessage);
}

module.exports = { buildMessage, extractors, dataSources };
