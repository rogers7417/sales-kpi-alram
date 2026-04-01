/**
 * SF User 조회 → 멤버 목록 + 직무 + Slack ID 매핑
 *
 * SF User 필드:
 *   - Id, Name, Department, Team__c (직무), SlackMemberID__c (슬랙ID)
 *
 * Department 기준:
 *   - 인바운드세일즈 → IS / FS / BO (Team__c 기반)
 *   - 채널세일즈, 채널세일즈팀, 채널매니지먼트 → AE / AM / TM / CS-BO (Team__c 기반)
 */
const { getSalesforceToken, soqlQuery } = require('./salesforce');

// 직무(Team__c) → 역할 매핑
const INBOUND_TEAM_MAP = {
  '인사이드세일즈': 'IS',
  '필드세일즈': 'FS',
  '현장영업': 'FS',
  '백오피스': 'BO',
};

const CHANNEL_TEAM_MAP = {
  'AE': 'AE',
  'AM': 'AM',
  'AE/AM': 'AE/AM',
  'TM': 'TM',
  '백오피스': 'CS-BO',
};

/**
 * SF에서 세일즈 전체 User 조회
 * @returns {Promise<Array<{id, name, department, team, role, slackId}>>}
 */
async function fetchMembers() {
  const { accessToken, instanceUrl } = await getSalesforceToken();

  const query = `
    SELECT Id, Name, Department, Team__c, SlackMemberID__c
    FROM User
    WHERE Department IN ('인바운드세일즈','채널세일즈팀','채널세일즈','채널매니지먼트')
      AND IsActive = true
    ORDER BY Department, Team__c, Name
  `.replace(/\s+/g, ' ').trim();

  const result = await soqlQuery(instanceUrl, accessToken, query);

  return result.records.map(u => {
    const dept = u.Department;
    const team = u.Team__c || '';
    let role = null;

    if (dept === '인바운드세일즈') {
      role = INBOUND_TEAM_MAP[team] || null;
    } else {
      role = CHANNEL_TEAM_MAP[team] || null;
    }

    // AE/AM 겸임 처리
    const roles = [];
    if (role === 'AE/AM') {
      roles.push('AE', 'AM');
    } else if (role) {
      roles.push(role);
    }

    return {
      id: u.Id,
      name: u.Name,
      department: dept,
      team,
      role,
      roles,
      slackId: u.SlackMemberID__c || null,
    };
  });
}

/**
 * 역할별 멤버 그룹핑
 * @returns {Promise<{is, fs, bo, ae, am, tm, csbo, all}>}
 */
async function fetchMembersByRole() {
  const members = await fetchMembers();

  const groups = { IS: [], FS: [], BO: [], AE: [], AM: [], TM: [], 'CS-BO': [] };

  members.forEach(m => {
    m.roles.forEach(r => {
      if (groups[r]) groups[r].push(m);
    });
  });

  return {
    is: groups.IS,
    fs: groups.FS,
    bo: groups.BO,
    ae: groups.AE,
    am: groups.AM,
    tm: groups.TM,
    csbo: groups['CS-BO'],
    all: members,
  };
}

/**
 * 이름 → 멤버 정보 lookup 맵 생성
 */
async function fetchMemberMap() {
  const members = await fetchMembers();
  const byName = {};
  const byId = {};

  members.forEach(m => {
    byName[m.name] = m;
    byId[m.id] = m;
  });

  return { byName, byId, members };
}

module.exports = { fetchMembers, fetchMembersByRole, fetchMemberMap };
