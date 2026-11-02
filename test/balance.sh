#!/bin/bash
# run.sh 餘額閘：超上限建 PAUSED 且不 execute；查不到餘額整輪不跑、只推一次
set -e
cd "$(dirname "$0")/.."
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export QUEUE_DIR=$T/q STATE_DIR=$T/s LOG_DIR=$T/l CONFIG=$PWD/config.example.json FAKE_BAW_LOG=$T/baw.log BAW_BIN=$PWD/test/fake-baw.sh
export MEMERUSH_FIXTURE=test/fixtures/memerush.json TWITTER_BIN=test/fake-twitter.sh TRIAGE_CMD=test/fake-llm-ok.sh
export FAKE_PREVIEW=test/fixtures/preview-ok.json AUDIT_FIXTURE=test/fixtures/audit-honeypot.json INFO_FIXTURE=test/fixtures/info-sample.json
export AUTOTRADE_ROWS=test/fixtures/autotrade-rows-empty.json
export BRIEF_DIR=$T/brief
export X_EVERY_RUN=1 TG_DRY=1 TG_BOT_TOKEN=x TG_CHAT_ID=1
FAKE_BAL=0.06 bash run.sh
[ -e $T/s/PAUSED ]
if grep -q 'contract-call' $T/baw.log; then exit 1; fi
rm $T/s/PAUSED
FAKE_BAL_FAIL=1 bash run.sh; FAKE_BAL_FAIL=1 bash run.sh
[ -e $T/s/BAL_UNKNOWN ]
if grep -q 'contract-call' $T/baw.log; then exit 1; fi
[ "$(grep -c "balance unknown" "$T/l/run.log")" -ge 2 ]
FAKE_BAL=0.02 bash run.sh
[ ! -e $T/s/BAL_UNKNOWN ] && [ ! -e $T/s/PAUSED ]
[ "$(grep -c 'contract-call execute' $T/baw.log)" = 1 ]
echo "balance ok"
