/**
 * S3 데이터 fetcher
 *
 * salesforce-data-tools가 S3에 올려둔 KPI JSON을 가져옴.
 *
 * S3 경로:
 *   dashboard/kpi/monthly/{YYYY-MM}.json      — IS/FS/BO (인바운드)
 *   dashboard/kpi/daily/{YYYY-MM-DD}.json      — 일별 인바운드
 *   dashboard/channel/kpi-v2/{YYYY-MM}.json    — CS (채널세일즈)
 *   dashboard/channel/{YYYY-MM}.json           — CS full (폴백)
 */
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

let _client = null;

function getClient() {
  if (!_client) {
    _client = new S3Client({
      region: process.env.AWS_REGION || 'ap-northeast-2',
      credentials: {
        accessKeyId: process.env.AWS_S3_ACCESS_KEY,
        secretAccessKey: process.env.AWS_S3_SECRET_KEY,
      },
    });
  }
  return _client;
}

function getBucket() {
  return process.env.S3_BUCKET_NAME || 'torder-salesforce-dashboard';
}

function getPrefix() {
  return process.env.S3_PREFIX || 'dashboard/';
}

async function fetchJSON(key) {
  const client = getClient();
  const fullKey = `${getPrefix()}${key}`;

  try {
    const res = await client.send(new GetObjectCommand({
      Bucket: getBucket(),
      Key: fullKey,
    }));
    const body = await res.Body.transformToString();
    return JSON.parse(body);
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}

function getCurrentMonth() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600000);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}`;
}

function getToday() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600000);
  return kst.toISOString().slice(0, 10);
}

/**
 * 인바운드 KPI 데이터 (IS/FS/BO)
 * - monthly: 월간 누적
 * - daily: 오늘 기준 스냅샷 (없으면 monthly 폴백)
 */
async function fetchInboundKPI(month) {
  const m = month || getCurrentMonth();

  // 일별 데이터 우선 시도
  const today = getToday();
  const daily = await fetchJSON(`kpi/daily/${today}.json`);
  if (daily) return daily;

  // 월간 폴백
  return fetchJSON(`kpi/monthly/${m}.json`);
}

/**
 * 채널세일즈 KPI 데이터 (AM/AE/TM)
 * - kpi-v2 slim 우선 → full 폴백
 */
async function fetchChannelKPI(month) {
  const m = month || getCurrentMonth();

  const slim = await fetchJSON(`channel/kpi-v2/${m}.json`);
  if (slim) return slim;

  return fetchJSON(`channel/${m}.json`);
}

module.exports = {
  fetchJSON,
  fetchInboundKPI,
  fetchChannelKPI,
  getCurrentMonth,
  getToday,
};
