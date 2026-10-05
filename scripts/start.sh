#!/bin/bash
# 学生考勤平台 —— 本地启动脚本（零依赖，需 Node.js ≥ 16）
# 用法：bash scripts/start.sh   或   PORT=8080 bash scripts/start.sh
set -e

# 切到仓库根目录（本脚本位于 scripts/ 下）
cd "$(dirname "$0")/.." || exit 1

PORT="${PORT:-3000}"
echo "学生考勤平台 启动中，监听端口 $PORT ..."
exec node server/index.js
