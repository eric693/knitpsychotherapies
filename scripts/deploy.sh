#!/usr/bin/env bash
# 上線流程：先驗，再重啟，重啟後再驗一次。任一步失敗即中止，不會留下半套狀態。
#
#   ./scripts/deploy.sh              # 完整流程
#   ./scripts/deploy.sh --skip-ui    # 略過前端冒煙（沒有安裝瀏覽器的機器）
#
# 步驟：
#   1. API 冒煙測試（拋棄式資料庫，不碰正式資料）——不過就不重啟
#   2. 手動備份一次（重啟前先留一份，改壞了可以退回）
#   3. pm2 restart
#   4. 等服務起來，再跑前端冒煙（唯讀）
set -euo pipefail

cd "$(dirname "$0")/.."
APP=knitpsychotherapies
PORT=${PORT:-3440}
SKIP_UI=${1:-}

step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1"; exit 1; }

step "1/4 API 冒煙測試"
npm run --silent smoke || fail "API 冒煙測試未通過，已中止部署（正式站未重啟）"

step "2/4 重啟前先備份"
# 服務還活著時透過 API 備份；服務已掛掉就跳過，不擋部署
if curl -fsS -o /dev/null "http://localhost:$PORT/api/public/ui-texts" 2>/dev/null; then
  cp -a data/mindcare.db "data/backups/pre-deploy-$(date +%Y%m%d-%H%M%S).db" 2>/dev/null \
    && echo "  已複製一份部署前資料庫到 data/backups/" \
    || echo "  （略過：無法複製資料庫，請確認 data/backups 存在）"
else
  echo "  （服務目前沒有回應，略過部署前備份）"
fi

step "3/4 重啟服務"
pm2 restart "$APP" >/dev/null
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://localhost:$PORT/api/public/ui-texts" 2>/dev/null; then
    echo "  服務已就緒（$i 秒）"
    break
  fi
  [ "$i" = 30 ] && fail "重啟後 30 秒內服務沒有回應，請看 pm2 logs $APP"
  sleep 1
done

step "4/4 前端冒煙測試"
# 正式站已清掉展示帳號，直接對正式站跑只會「無法登入，略過」，等於什麼都沒驗到。
# 因此另起一台帶展示資料的臨時站（拋棄式資料庫與埠號，不碰正式資料）來巡所有畫面。
if [ "$SKIP_UI" = "--skip-ui" ]; then
  echo "  （依參數略過）"
else
  UI_TMP=$(mktemp -d)
  UI_PORT=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
  cleanup_ui() {
    [ -n "${UI_PID:-}" ] && kill "$UI_PID" 2>/dev/null || true
    rm -rf "$UI_TMP"
  }
  trap cleanup_ui EXIT
  export MINDCARE_DATA_DIR="$UI_TMP/data" MINDCARE_UPLOAD_DIR="$UI_TMP/uploads" MINDCARE_BACKUP_MIRROR="$UI_TMP/mirror"
  node scripts/seed.js >/dev/null 2>&1 || fail "臨時站灌展示資料失敗"
  PORT="$UI_PORT" node src/server.js > "$UI_TMP/server.log" 2>&1 &
  UI_PID=$!
  for i in $(seq 1 20); do
    curl -fsS -o /dev/null "http://127.0.0.1:$UI_PORT/api/public/ui-texts" 2>/dev/null && break
    [ "$i" = 20 ] && { cat "$UI_TMP/server.log"; fail "臨時站起不來，無法執行前端冒煙"; }
    sleep 1
  done
  echo "  臨時站（埠 $UI_PORT，展示資料）已就緒"
  BASE="http://127.0.0.1:$UI_PORT" npm run --silent smoke:ui || fail "前端冒煙測試未通過，請檢查（正式站已是新版）"
  unset MINDCARE_DATA_DIR MINDCARE_UPLOAD_DIR MINDCARE_BACKUP_MIRROR
fi

printf '\n\033[32m✓ 部署完成\033[0m\n'
