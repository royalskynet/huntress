#!/usr/bin/env bash
# execute 失敗也要記帳：第二輪對同一合約不得再送 execute
set -euo pipefail
cd "$(dirname "$0")/.."
T=$(mktemp -d); export STATE_DIR=$T/s LOG_DIR=$T/l BAW_BIN=$PWD/test/fake-baw.sh FAKE_BAW_LOG=$T/calls CONFIG=$T/c.json FAKE_PREVIEW=test/fixtures/preview-ok.json
printf '%s' '{"dailyMax":5,"perContractDaily":1,"denylist":[]}' > $T/c.json
printf '%s' '{"kind":"free","chainId":"56","targets":[{"to":"0xabababababababababababababababababababab"}]}' > $T/cand.json
FAKE_EXEC_FAIL=1 node src/exec.mjs $T/cand.json >/dev/null
node src/exec.mjs $T/cand.json >/dev/null
n=$(grep -c execute $T/calls)
[ "$n" = "1" ] || { echo "FAIL: execute 送了 $n 次"; exit 1; }
echo ok
