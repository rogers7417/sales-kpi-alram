# Sales KPI Alarm Bot — 서버 구성

## 1. 서비스 개요

Salesforce KPI 데이터를 기반으로 세일즈팀 멤버별 오늘의 액션 플랜을 자동 생성하여 Slack으로 발송하는 봇.

- 대상: 인바운드세일즈(IS/FS/BO 17명) + 채널세일즈(AE/AM/TM/CS-BO 11명) = 28명
- 발송 주기: 하루 2회 (오전 9시, 오후 2시)
- 발송 방식: 멤버별 Slack Canvas 체크리스트 + 팀 채널 알림

## 2. 아키텍처

데이터 흐름:

1. S3에서 KPI 데이터 fetch (salesforce-data-tools가 30분마다 업로드)
2. Salesforce에서 User 정보 조회 (이름, 직무, SlackId)
3. Claude API(Haiku)로 멤버별 액션 메시지 생성
4. Slack Bot으로 Canvas 체크리스트 생성/업데이트
5. 팀 채널에 업데이트 알림 발송

## 3. 서버 구성

| 항목 | 내용 |
|------|------|
| 서버 | AWS EC2 (t3.micro 충분) |
| OS | Amazon Linux 2 / Ubuntu |
| 런타임 | Node.js 18+ |
| 프로세스 관리 | PM2 |
| 스케줄링 | node-cron (PM2 내장 cron) |

## 4. 환경변수

| 변수 | 용도 | 비고 |
|------|------|------|
| SF_CLIENT_ID | Salesforce OAuth | salesforce-data-tools와 공유 |
| SF_CLIENT_SECRET | Salesforce OAuth | |
| SF_USERNAME | Salesforce 계정 | |
| SF_PASSWORD | Salesforce 비밀번호 | |
| SF_LOGIN_URL | SF 로그인 URL | |
| AWS_S3_ACCESS_KEY | S3 접근 | |
| AWS_S3_SECRET_KEY | S3 접근 | |
| S3_BUCKET_NAME | S3 버킷 | torder-salesforce-dashboard |
| SLACK_BOT_TOKEN | Slack Bot | Sales KPI Bot 앱 토큰 |
| CLAUDE_API_KEY | Claude API | Anthropic 콘솔에서 발급 |
| CLAUDE_MODEL | 메시지 생성 모델 | 기본: claude-haiku-4-5-20251001 |
| SEND_DM | 개인 DM 발송 여부 | true/false (기본 false) |
| SLACK_CHANNEL_INBOUND | 인바운드 채널 ID | C0AJR810T5H |
| SLACK_CHANNEL_CHANNEL | 채널세일즈 채널 ID | C0AJXKJHNJW |

## 5. 실행 스케줄

| 시간 | 동작 |
|------|------|
| 오전 9:00 | 전체 파이프라인 실행 (데이터 수집 → 메시지 생성 → Canvas 업데이트 → 채널 알림) |
| 오후 2:00 | 동일 (최신 데이터로 Canvas 업데이트) |

## 6. 비용 (월 예상)

| 항목 | 비용 |
|------|------|
| Claude API (Haiku) — 메시지 생성 28명 x 2회 x 30일 | ~$13 |
| Claude API (Haiku) — Canvas 변환 28명 x 2회 x 30일 | ~$13 |
| EC2 (t3.micro) | ~$8 |
| 합계 | ~$34/월 |

파트별 요약을 Sonnet으로 추가 시 +$30/월

## 7. 프로젝트 구조

```
sales-kpi-alarm/
├── .env
├── canvas_registry.json      ← 멤버별 Canvas ID 저장
├── ecosystem.config.js       ← PM2 설정
├── src/
│   ├── index.js              ← 메인 (cron 스케줄러)
│   ├── s3-fetcher.js         ← S3 데이터 fetch
│   ├── salesforce.js         ← SF 인증 + SOQL
│   ├── members.js            ← SF User 조회
│   ├── message-builder.js    ← 파트별 데이터 추출
│   ├── claude.js             ← Claude API 호출
│   ├── update-checklists.js  ← Canvas 생성/업데이트 + 발송
│   └── prompts/
│       ├── is.md / fs.md / bo.md
│       ├── ae.md / am.md / tm.md / csbo.md
│       └── summary.md
```

## 8. Slack Bot 권한 (OAuth Scopes)

- chat:write — 메시지 발송
- canvases:write — Canvas 생성/수정/삭제
- im:write — DM 발송
- users:read — 멤버 조회
