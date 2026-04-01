# Sales KPI Alarm Bot

채널세일즈팀 KPI 기반 Slack 개인 알람 봇

## 프로젝트 개요

Salesforce 데이터를 기반으로 채널세일즈팀 멤버 각각에게 하루 2회(오전 9시, 오후 2시) 개인 DM으로 오늘의 액션 플랜을 발송하는 봇.

## 핵심 원칙

- **개인별 1:1 톤**: "OOO님, 오늘 액션 플랜" 형태로 개인화된 메시지
- **현황 나열이 아닌 구체적 액션**: "안착률 36%"가 아니라 "바로체크 미팅 잡기 — 2주째 방치"
- **데이터 기반 근거**: 모든 추천에 숫자(경과일, 건수, 날짜) 포함
- **파트별 메시지 템플릿 분리**: AM/AE/TM 각각 다른 KPI 기준

## 데이터 소스

`salesforce-data-tools` 프로젝트의 모듈을 활용:
- 경로: `/Users/torder/workspace/salesforce-data-tools`
- `channel-sales-report/salesforce.js` → `collectChannelData(targetMonth)`
- `channel-sales-report/stats.js` → `calculateStats(data)`
- `.env` 파일의 Salesforce 인증 정보 공유

## 멤버 구성 (9명)

### Account Owner (AM) — 파트너 관리
- 구준모, 명세준, 문은기, 박해규, 오유정, 이은지, 정용현

### Lead Owner (AE) — 리드 전환
- 송슬기, 정주희

### 겸임 (AM + AE)
- 명세준, 박해규, 오유정, 이은지

## 파트별 KPI 기준 및 메시지 구성

### AM 파트 메시지
1. **이번달 현황**: 리드 일평균, 안착률, 비활성 파트너 수
2. **안착 window 마감 긴급**: MOU 후 3개월 내 리드 0건인 파트너 (마감 임박 순)
3. **미안착 파트너 컨택**: 미팅·Task 0건인 곳 우선
4. **비활성 파트너 리터치**: 90일+ 무리드, 최근 Task 이력 있으면 팔로업 추천
5. **한줄 요약**: 오늘 집중해야 할 핵심 1가지

KPI 목표:
- 리드 확보: 일 5건
- MOU 미팅: 일 2건
- 초기 안착률: 80%
- 활성 파트너 유지: 70개

### AE 파트 메시지
1. **이번달 현황**: 리드 건수, 전환율, 월별 추이
2. **리터치 대상**: 부재중·장기부재·고민중 리드 (오래된 순)
3. **전환율 경고**: 하락 추세 감지 시 알림
4. **한줄 요약**

### TM 파트 메시지 (향후 확장)
- 리터치 대상 파트너 목록
- 통화 이력 기반 재컨택 추천

## Slack 발송

- 봇: `bizopssf` (bot_id: B094ZSYJAMN)
- 토큰: 환경변수 `SLACK_BOT_TOKEN`
- 발송 방식: 각 멤버 user_id로 DM 발송
- 멤버 Slack user_id 매핑 필요 (slack_search_users로 조회)

## 메시지 포맷 (Slack markdown)

```
📋 *{이름}님, 오늘({날짜}) 액션 플랜*

━━━━━━━━━━━━━━━━━━━━

📊 *이번달 현황*
>✅ 리드 일 *6.7건* (목표 5건 초과)
>⚠️ 안착률 *41%* (7/17, 목표 80%)
>🔴 비활성 *47곳* / 전체 85곳

━━━━━━━━━━━━━━━━━━━━

🔥 *1. {우선순위 제목}*
_부가 설명_

• *`업체명`* 핵심 수치 — *액션*

━━━━━━━━━━━━━━━━━━━━

💡 *한줄 요약*
{오늘 집중해야 할 핵심 메시지}
```

- 업체명: *`백틱+볼드`* 로 강조
- 핵심 숫자: *볼드* 처리
- 구분선: ━━━ 사용
- blockquote(>) 로 현황 요약

## 기술 스택

- Node.js
- Slack Web API (axios 또는 @slack/web-api)
- node-cron (스케줄링)
- PM2 (프로세스 관리)

## 프로젝트 구조 (예상)

```
sales-kpi-alarm/
├── CLAUDE.md
├── package.json
├── .env                    # SF 인증 + Slack 토큰 + 멤버 매핑
├── src/
│   ├── index.js            # 메인 (cron 스케줄러)
│   ├── data-collector.js   # SF 데이터 수집 (salesforce-data-tools 연동)
│   ├── message-builder.js  # 파트별 메시지 생성
│   │   ├── am-message.js
│   │   ├── ae-message.js
│   │   └── tm-message.js
│   ├── slack-sender.js     # Slack DM 발송
│   └── members.js          # 멤버 목록 + Slack ID + 역할 매핑
└── ecosystem.config.js     # PM2 설정
```

## 실행

```bash
# 개발/테스트
node src/index.js --test --member=문은기

# 프로덕션 (PM2)
pm2 start ecosystem.config.js
```
