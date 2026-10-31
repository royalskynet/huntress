#!/bin/bash
# buy.mjs 錢路徑：超額拒、nonce 一次性、過期拒、execute 失敗仍預扣、每日 3 筆封頂
set -e
cd "$(dirname "$0")/.."
T=$(mktemp -d); export STATE_DIR=$T/s LOG_DIR=$T/l FAKE_BAW_LOG=$T/baw.log BAW_BIN=$PWD/test/fake-baw.sh FAKE_PREVIEW=$PWD/test/fixtures/preview-paid.json CONFIG=$PWD/config.example.json
printf '%s' '{"kind":"paid","targets":[{"to":"0xabababababababababababababababababababab","inputData":"0x1249c58b"}]}' > $T/c.json
ok() { jq -r .ok; }
[ "$(node src/buy.mjs prepare $T/c.json 5000000000000001 | ok)" = false ]
N=$(node src/buy.mjs prepare $T/c.json 5000000000000000 | jq -r .nonce); [[ "$N" =~ ^[0-9a-f]{32}$ ]]
if grep -q 'contract-call execute' $T/baw.log; then exit 1; fi
[ "$(node src/buy.mjs confirm $N | jq -r .txHash)" = "0xdead" ]          # 第 1 筆
[ "$(node src/buy.mjs confirm $N | ok)" = false ]                        # nonce 重用
[ "$(node src/buy.mjs confirm ../../x | ok)" = false ]
N2=$(node src/buy.mjs prepare $T/c.json 5000000000000000 | jq -r .nonce)
jq '.createdAt=0' $T/s/pending/$N2.json > $T/p && mv $T/p $T/s/pending/$N2.json
[ "$(node src/buy.mjs confirm $N2 | ok)" = false ]                       # 過期，不扣
N3=$(node src/buy.mjs prepare $T/c.json 5000000000000000 | jq -r .nonce)
[ "$(FAKE_EXEC_FAIL=1 node src/buy.mjs confirm $N3 | ok)" = false ]     # 第 2 筆：失敗仍預扣
N4=$(node src/buy.mjs prepare $T/c.json 5000000000000000 | jq -r .nonce); [[ "$N4" =~ ^[0-9a-f]{32}$ ]]  # 已用/過期單不佔額
[ "$(node src/buy.mjs prepare $T/c.json 5000000000000000 | ok)" = false ]  # 帳本 2＋待確認 1＝3
[ "$(node src/buy.mjs confirm $N4 | jq -r .txHash)" = "0xdead" ]         # 第 3 筆
[ "$(node src/buy.mjs prepare $T/c.json 5000000000000000 | ok)" = false ]  # 當日封頂
[ "$(grep -c 'contract-call execute' $T/baw.log)" = 3 ]
echo "buy ok"
