#!/bin/bash
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# 個人設定（TG_CHAT_ID 等）放這裡，不進 repo
if [ -e "$HOME/.config/agentid-newlaunch/env" ]; then
  set -a
  . "$HOME/.config/agentid-newlaunch/env"
  set +a
fi
: "${TG_BOT_TOKEN:=$(cat "$HOME/.creds/kv/AGENTID_TG_TOKEN.txt" 2>/dev/null)}"
export TG_BOT_TOKEN TG_CHAT_ID
export TRIAGE_CMD="$ROOT/bin/triage-llm.sh" BAW_BIN="$ROOT/node_modules/.bin/baw" PATH="/opt/homebrew/bin:$HOME/.local/bin:/usr/bin:/bin"
cd "$ROOT"
exec /bin/bash "${1:-run.sh}"
