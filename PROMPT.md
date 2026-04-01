# 프롬프트

새 Claude Code 세션에서 아래 내용을 전달하세요:

---

`/Users/torder/workspace/sales-kpi-alarm` 프로젝트를 구축해줘.

CLAUDE.md에 프로젝트 스펙이 정리되어 있어.

핵심 요구사항:
1. salesforce-data-tools의 collectChannelData + calculateStats 모듈을 가져다 써서 데이터 수집
2. 멤버 9명 각각에게 파트별(AM/AE) 개인 Slack DM 발송
3. 하루 2회 (오전 9시, 오후 2시) cron 스케줄
4. 메시지는 "OOO님, 오늘 액션 플랜" 형태로 구체적 액션 포함
5. 먼저 --test 모드로 특정 멤버 1명한테 보내서 확인할 수 있게

멤버 Slack user_id는 slack_search_users로 조회해서 매핑해줘.
.env는 salesforce-data-tools의 것을 심볼릭 링크로 공유하면 돼.
