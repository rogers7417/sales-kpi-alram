# Sales KPI Alarm Bot

채널세일즈/인바운드팀 멤버에게 매일 평일 오전 10시(KST) KPI 기반 **개인 액션 플랜을 Slack Canvas로 자동 업데이트**하는 봇.

---

## 🎯 무엇을 하나?

1. AWS S3 대시보드 스냅샷 + Salesforce User 데이터를 수집
2. 역할별(IS/FS/BO/TM/AM/AE/CS-BO) KPI 이탈·위험 지표를 추출
3. Claude로 "오늘 해야 할 일"을 구체적 액션 문장으로 생성
4. 멤버별 **Slack Canvas 체크리스트**를 생성/갱신
5. 채널에 링크 알림, (옵션) 개인 DM 발송

> 핵심 원칙: "안착률 36%" 같은 현황 나열이 아니라, "바로체크 미팅 잡기 — 2주째 방치" 같은 **구체적 액션** 제시.

---

## 🏗️ 아키텍처

```
                ┌──────────────────┐
                │   node-cron      │  0 10 * * 1-5 (Asia/Seoul)
                └────────┬─────────┘
                         ▼
┌────────────────────────────────────────────────┐
│               src/index.js  run()              │
└─┬──────────────┬───────────────┬───────────────┘
  │              │               │
  ▼              ▼               ▼
┌──────────┐ ┌───────────┐ ┌────────────┐
│ S3 KPI   │ │ SF Users  │ │ Prompts    │
│ s3-      │ │ members.js│ │ prompts/*  │
│ fetcher  │ │           │ │            │
└────┬─────┘ └─────┬─────┘ └─────┬──────┘
     └─────┬───────┴─────────────┘
           ▼
  ┌──────────────────┐
  │ message-builder  │  역할별 extract*Data() → 액션 추출
  └────────┬─────────┘
           ▼
  ┌──────────────────┐
  │ claude.js        │  Claude Haiku 4.5 로 액션 문장 생성
  └────────┬─────────┘
           ▼
  ┌──────────────────┐
  │ Checklist 변환   │  마크다운 → Canvas 체크박스
  └────────┬─────────┘
           ▼
  ┌──────────────────┐
  │ Slack Canvas API │  canvases.create / edit / access.set
  └────────┬─────────┘
           ▼
   canvas_registry.json  (멤버 ↔ canvasId 매핑)
           │
           ▼
   ┌──────────────┐
   │ 채널 알림     │  chat.postMessage (링크 목록)
   │ + 개인 DM    │  (SEND_DM=true 일 때)
   └──────────────┘
```

---

## 📂 프로젝트 구조

```
sales-kpi-alram/
├── src/
│   ├── index.js              # 메인 파이프라인 + cron 스케줄러
│   ├── s3-fetcher.js         # S3에서 일/월 KPI 스냅샷 로드
│   ├── salesforce.js         # SF OAuth + SOQL 헬퍼
│   ├── members.js            # SF User → 역할별 멤버 목록
│   ├── message-builder.js    # 역할별 데이터 추출 + 프롬프트 조립
│   ├── claude.js             # Anthropic SDK 래퍼
│   ├── create-checklists.js  # Canvas 초기 생성
│   ├── update-checklists.js  # Canvas 갱신
│   ├── generate-messages.js  # MD 파일로 메시지 덤프 (디버깅용)
│   ├── generate-summary.js   # 팀 전체 요약 생성
│   ├── send-messages.js      # 개인 DM 발송
│   ├── send-to-channel.js    # 채널 메시지 발송
│   └── prompts/
│       ├── is.md  fs.md  bo.md  tm.md
│       ├── am.md  ae.md  csbo.md
│       └── summary.md
├── docs/
│   └── server-setup.md       # 서버 셋업 가이드
├── canvas_registry.json      # 멤버 → Canvas ID 매핑 (런타임 생성)
├── ecosystem.config.js       # PM2 설정
├── package.json
├── CLAUDE.md                 # 프로젝트 배경/원칙
└── README.md
```

---

## 🧩 역할별 KPI 감지 로직

`src/message-builder.js`의 `extract*Data()` 함수들이 각 역할의 이탈 지표를 추출합니다.

| 역할 | 감지 항목 | 임계치 |
|-----|----------|-------|
| **IS** 인사이드세일즈 | FRT 초과 리드, 미전환 MQL, 미방문 SQL | FRT 20분, SQL 전환율 90% |
| **FS** 필드세일즈 | 방문 후 과업 없는 견적, 오버듀 과업 | 7일 내 임박 |
| **BO** 백오피스 | 설치 임박, 터치 공백, 다음 과업 없음 | 2주 내 긴급, 5일+ 공백 |
| **TM** 텔레마케팅 | FRT 초과, 7일+ 체류 Open SQL, 상태별 미전환 | FRT 준수율 80% |
| **AM** 어카운트매니저 | 미안착 파트너, 비활성 파트너, 리드 감소 | 안착률 80%, 70개 유지 |
| **AE** 어카운트이그제큐티브 | MOU 미완료 미팅, 미안착 | - |
| **CS-BO** | 계약 없는 건, 터치 공백 | - |

---

## 🚀 실행

### 개발/테스트

```bash
# 의존성 설치
npm install

# 특정 멤버 1명 테스트 (테스트 채널로)
node src/index.js --test --member=문은기

# 테스트 모드 전체
node src/index.js --test

# 즉시 1회 실행 (프로덕션 채널)
node src/index.js
```

### 프로덕션 (PM2)

```bash
pm2 start ecosystem.config.js
pm2 logs sales-kpi-alarm
pm2 restart sales-kpi-alarm
```

- `ecosystem.config.js`: `node src/index.js --cron` 상시 구동
- 스케줄: 매주 월~금 10:00 KST
- `TZ=Asia/Seoul`, 자동 재시작, 에러/출력 로그 분리

### 배포 업데이트

```bash
cd ~/workspace/sales-kpi-alarm
git pull origin main
pm2 restart sales-kpi-alarm
pm2 logs sales-kpi-alarm --lines 50
```

---

## ⚙️ 환경변수 (`.env`)

```bash
# Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_CHANNEL_INBOUND=C0AJR810T5H
SLACK_CHANNEL_CHANNEL=C0AJXKJHNJW
SEND_DM=true

# Claude
CLAUDE_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-haiku-4-5-20251001

# Salesforce
SF_LOGIN_URL=https://login.salesforce.com
SF_CLIENT_ID=...
SF_CLIENT_SECRET=...
SF_USERNAME=...
SF_PASSWORD=...  # URL 인코딩

# AWS S3
AWS_REGION=ap-northeast-2
AWS_S3_ACCESS_KEY=...
AWS_S3_SECRET_KEY=...
S3_BUCKET_NAME=torder-salesforce-dashboard
S3_PREFIX=dashboard/
```

---

## 🔑 Slack Canvas 권한

멤버가 DM 링크로 Canvas를 열어 **체크박스를 토글**하려면 write 권한이 필요합니다. `src/index.js`는 Canvas 생성/업데이트 시 다음을 호출:

1. `canvases.access.set({ channel_ids, access_level: 'write' })` — 채널 전체 쓰기
2. `canvases.access.set({ user_ids: [slackId], access_level: 'write' })` — 본인 쓰기 보장

**본인만 접근 가능한 비공개 Canvas**로 만들고 싶다면 1번을 제거하세요.

---

## 📊 데이터 소스

| 데이터 | 위치 | 사용처 |
|-------|-----|--------|
| 일별 인바운드 KPI | `s3://.../dashboard/kpi/daily/{YYYY-MM-DD}.json` | IS/FS/BO |
| 월간 인바운드 KPI | `s3://.../dashboard/kpi/monthly/{YYYY-MM}.json` | 폴백 |
| 채널세일즈 KPI | `s3://.../dashboard/channel/kpi-v2/{YYYY-MM}.json` | AM/AE/TM/CS-BO |
| 멤버 정보 | Salesforce `User` 객체 (SOQL) | 전체 |

---

## 🧪 Canvas 레지스트리

`canvas_registry.json`은 멤버별 Canvas ID를 저장해 **매일 같은 Canvas를 갱신**합니다 (체크 상태 유지).

```json
{
  "문은기": {
    "canvasId": "F0XXXXXXXXX",
    "canvasUrl": "https://...slack.com/docs/...",
    "role": "AM",
    "team": "채널"
  }
}
```

- Canvas가 정말 삭제된 경우(`canvas_not_found`)에만 재생성
- rate limit·네트워크 등 일시 오류는 registry 보존 → 체크 상태 손실 방지

---

## 🛠️ 기술 스택

- **Node.js** (CommonJS)
- **`@slack/web-api`** — Canvas/메시지 API
- **`@anthropic-ai/sdk`** — Claude Haiku 4.5
- **`@aws-sdk/client-s3`** — KPI 스냅샷 로드
- **`node-cron`** — 스케줄링
- **PM2** — 프로세스 관리

---

## 📝 관련 문서

- `CLAUDE.md` — 프로젝트 배경, 원칙, 메시지 톤 가이드
- `PROMPT.md` — 프롬프트 작성 가이드
- `docs/server-setup.md` — 서버 셋업
- `src/prompts/*.md` — 역할별 Claude 시스템 프롬프트
