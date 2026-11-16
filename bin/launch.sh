#!/bin/bash
# 載入個人設定後執行指定腳本（預設 bin/smartmoney.sh）。TG_* 不進 repo。
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [ -e "$HOME/.config/agentid-newlaunch/env" ]; then
  set -a
  . "$HOME/.config/agentid-newlaunch/env"
  set +a
fi
: "${TG_BOT_TOKEN:=$(cat "$HOME/.creds/kv/AGENTID_TG_TOKEN.txt" 2>/dev/null)}"
export TG_BOT_TOKEN TG_CHAT_ID
# baw 預設用第一張網卡 MAC 當 session 金鑰；網路瞬斷會讓 session 被清，必須固定
export BINANCE_INSTANCE_ID="${BINANCE_INSTANCE_ID:-agentid-newlaunch}"
export BAW_BIN="$ROOT/node_modules/.bin/baw" PATH="/opt/homebrew/bin:$HOME/.local/bin:/usr/bin:/bin"
cd "$ROOT" || exit 1
exec /bin/bash "${1:-bin/smartmoney.sh}"
