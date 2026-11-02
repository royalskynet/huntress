#!/bin/bash
# nag 回歸：持續提醒 + brief 寫入
set -e
cd "$(dirname "$0")/.."
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export QUEUE_DIR=$T/q STATE_DIR=$T/s LOG_DIR=$T/l CONFIG=$PWD/config.example.json FAKE_BAW_LOG=$T/baw.log BAW_BIN=$PWD/test/fake-baw.sh
export MEMERUSH_FIXTURE=test/fixtures/memerush.json TWITTER_BIN=test/fake-twitter.sh TRIAGE_CMD=test/fake-llm-ok.sh
export FAKE_PREVIEW=test/fixtures/preview-ok.json AUDIT_FIXTURE=test/fixtures/audit-honeypot.json INFO_FIXTURE=test/fixtures/info-sample.json
export AUTOTRADE_ROWS=test/fixtures/autotrade-rows-empty.json
export X_EVERY_RUN=1 TG_DRY=1 TG_BOT_TOKEN=x TG_CHAT_ID=1
export BRIEF_DIR=$T/brief
mkdir -p $T/q $T/s $T/l $T/brief

FAKE_BAL_FAIL=1 bash run.sh
FAKE_BAL_FAIL=1 bash run.sh
[ -e $T/s/BAL_UNKNOWN ]
[ -f $T/brief/agentid.tsv ]
grep -q '⚠' $T/brief/agentid.tsv
[ "$(grep -c 'nag BAL_UNKNOWN' "$T/l/run.log")" = 1 ]

touch -t "$(date -v-7H +%Y%m%d%H%M.%S)" $T/s/BAL_UNKNOWN.nag $T/s/BAL_UNKNOWN
FAKE_BAL_FAIL=1 bash run.sh
[ "$(grep -c 'nag BAL_UNKNOWN' "$T/l/run.log")" = 2 ]

FAKE_BAL=0.02 bash run.sh
[ ! -e $T/s/BAL_UNKNOWN ] && [ ! -e $T/s/BAL_UNKNOWN.nag ] && [ ! -e $T/brief/agentid.tsv ]

: > "$T/baw.log"
touch $T/s/PAUSED
bash run.sh
[ "$(grep -c 'nag PAUSED' "$T/l/run.log")" = 1 ]
touch -t "$(date -v-25H +%Y%m%d%H%M.%S)" $T/s/PAUSED $T/s/PAUSED.nag
bash run.sh
[ "$(grep -c 'nag PAUSED' "$T/l/run.log")" = 2 ]
if grep -q 'contract-call' $T/baw.log 2>/dev/null; then exit 1; fi

# NOT_LOGGED_IN 原始輸出進 log
cat > $T/fake-baw2.sh <<'SH'
#!/usr/bin/env bash
if [[ "$1" == "wallet" && "${2:-}" == "balance" ]]; then
  printf '%s\n' '{"success":false,"error":{"code":10003000,"name":"NOT_LOGGED_IN"}}'
  exit 0
fi
printf '%s\n' '{}'
SH
chmod +x $T/fake-baw2.sh
rm -f $T/s/BAL_UNKNOWN $T/s/BAL_UNKNOWN.nag $T/s/PAUSED $T/s/PAUSED.nag
BAW_BIN=$T/fake-baw2.sh bash run.sh
if ! grep 'balance unknown' "$T/l/run.log" | grep -q 'NOT_LOGGED_IN'; then exit 1; fi

echo "nag ok"