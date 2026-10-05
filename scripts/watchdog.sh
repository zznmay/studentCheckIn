#!/bin/bash
# 学生考勤平台 —— 进程保活守护
# 当 Node 服务进程不存在时自动拉起（可配合 crontab 每分钟执行一条：
#   * * * * * bash /path/to/学生考勤平台/scripts/watchdog.sh
# 注意：公网访问请使用你自己的隧道 / 反向代理；本脚本仅负责本地 Node 进程保活。
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! pgrep -x node > /dev/null; then
  cd "$ROOT" || exit 1
  setsid nohup node server/index.js > /tmp/attend.log 2>&1 < /dev/null &
  disown
  echo "$(date -Is) node restarted" >> /tmp/watchdog.log
fi
