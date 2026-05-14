/**
 * Salesforce 인증 + SOQL 쿼리 유틸리티
 * (salesforce-data-tools/kpi-extract.js 에서 복사)
 */
const axios = require('axios');

async function getSalesforceToken() {
  const url = `${process.env.SF_LOGIN_URL}/services/oauth2/token`;
  const params = new URLSearchParams();
  params.append('grant_type', 'password');
  params.append('client_id', process.env.SF_CLIENT_ID);
  params.append('client_secret', process.env.SF_CLIENT_SECRET);
  params.append('username', process.env.SF_USERNAME);
  params.append('password', decodeURIComponent(process.env.SF_PASSWORD));
  const res = await axios.post(url, params);
  return { accessToken: res.data.access_token, instanceUrl: res.data.instance_url };
}

async function soqlQuery(instanceUrl, accessToken, query) {
  const url = `${instanceUrl}/services/data/v59.0/query`;
  const res = await axios.get(url, {
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    params: { q: query },
  });
  return res.data;
}

// 페이징 처리 (대량 쿼리)
async function soqlQueryAll(instanceUrl, accessToken, query) {
  let all = [];
  let result = await soqlQuery(instanceUrl, accessToken, query);
  all.push(...(result.records || []));
  while (result.nextRecordsUrl) {
    const res = await axios.get(`${instanceUrl}${result.nextRecordsUrl}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    result = res.data;
    all.push(...(result.records || []));
  }
  return all;
}

// SObject 레코드 생성
async function createRecord(instanceUrl, accessToken, objectName, body) {
  const url = `${instanceUrl}/services/data/v59.0/sobjects/${objectName}`;
  const res = await axios.post(url, body, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });
  return res.data;
}

module.exports = { getSalesforceToken, soqlQuery, soqlQueryAll, createRecord };
