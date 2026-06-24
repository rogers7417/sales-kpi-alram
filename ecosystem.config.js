module.exports = {
  apps: [{
    name: 'sales-kpi-alarm',
    script: 'src/index.js',
    args: '--cron',
    cwd: __dirname,
    env: {
      NODE_ENV: 'production',
      TZ: 'Asia/Seoul',
    },
    // 로그
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: 'logs/error.log',
    out_file: 'logs/out.log',
    merge_logs: true,
    // 재시작
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
  }, {
    // 방문 전 주변매장 컨택 알람 (들렀다 가기 축소판)
    // 매일 12:00 KST 실행 → 내일(D+1) 방문 예정자에게 팀별 채널 + 맨션 발송
    name: 'visit-nearby-alarm',
    script: 'src/visit-nearby-alarm.js',
    cwd: __dirname,
    cron_restart: '0 12 * * *',   // 매일 정오(KST)
    autorestart: false,            // 완료 후 종료 (run-and-exit)
    watch: false,
    env: {
      NODE_ENV: 'production',
      TZ: 'Asia/Seoul',
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: 'logs/visit-nearby-error.log',
    out_file: 'logs/visit-nearby-out.log',
    merge_logs: true,
  }],
};
