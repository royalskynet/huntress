#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

QUEUE_DIR="$T/queue"
STATE_DIR="$T/state"
LOG_DIR="$T/logs"
mkdir -p "$QUEUE_DIR" "$STATE_DIR" "$LOG_DIR"

CONFIG="$T/config.json"
cat > "$CONFIG" <<'JSON'
{"dailyMax":3,"perContractDaily":1,"denylist":[],"x":{"queries":["Agent ID free mint"],"accounts":[]}}
JSON

export QUEUE_DIR STATE_DIR LOG_DIR CONFIG
export MEMERUSH_FIXTURE=test/fixtures/memerush.json
export TWITTER_BIN=test/fake-twitter.sh
export TRIAGE_CMD=test/fake-llm-ok.sh
export BAW_BIN=test/fake-baw.sh
export FAKE_BAW_LOG="$T/baw.log"
export FAKE_PREVIEW=test/fixtures/preview-ok.json
export AUDIT_FIXTURE=test/fixtures/audit-honeypot.json
export INFO_FIXTURE=test/fixtures/info-sample.json
export AUTOTRADE_ROWS=test/fixtures/autotrade-rows-empty.json
export X_EVERY_RUN=1 TG_DRY=1 TG_BOT_TOKEN=x TG_CHAT_ID=1

bash run.sh

if [ ! -f "$FAKE_BAW_LOG" ]; then
  echo "missing baw log" >&2
  exit 1
fi
exec_count=$(grep -c 'execute' "$FAKE_BAW_LOG" || true)
if [ "$exec_count" -ne 1 ]; then
  echo "expected 1 execute, got $exec_count" >&2
  exit 1
fi

ls "$QUEUE_DIR/done"/memerush-* >/dev/null 2>&1 || { echo "no memerush done" >&2; exit 1; }
ls "$QUEUE_DIR/done"/x-* >/dev/null 2>&1 || { echo "no x done" >&2; exit 1; }

if ls "$QUEUE_DIR" | grep -Eq '^(x-|memerush-|cand-)'; then
  echo "leftover queue files" >&2
  exit 1
fi

exit 0
