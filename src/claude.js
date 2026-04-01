/**
 * Claude API 호출 모듈
 */
const Anthropic = require('@anthropic-ai/sdk');

let _client = null;

function getClient() {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
  }
  return _client;
}

/**
 * 프롬프트 + 데이터 → 메시지 생성
 * @param {string} systemPrompt — 팀별 시스템 프롬프트
 * @param {string} userMessage — 멤버 데이터 (JSON 등)
 * @param {string} model — 모델 (기본: haiku)
 * @returns {Promise<string>} 생성된 메시지 텍스트
 */
// 테스트: haiku, 운영: sonnet
const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const PROD_MODEL = 'claude-sonnet-4-6';

async function generateMessage(systemPrompt, userMessage, model = DEFAULT_MODEL) {
  const client = getClient();

  const res = await client.messages.create({
    model,
    max_tokens: 8000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  return res.content[0].text;
}

module.exports = { generateMessage };
