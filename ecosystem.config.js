module.exports = {
  apps: [{
    name: 'sales-kpi-alarm',
    script: 'src/index.js',
    args: '--cron',
    cwd: __dirname,
    env: {
      NODE_ENV: 'production',
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
  }],
};
