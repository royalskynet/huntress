#!/usr/bin/env bash
# gas 預算：送出前預留、receipt 對帳換成實際、超過預算擋下；擋下原因以模擬有過的那組為準
set -euo pipefail
cd "$(dirname "$0")/.."
T=$(mktemp -d); SRV=; trap '[ -n "$SRV" ] && kill $SRV 2>/dev/null; rm -rf $T' EXIT
export STATE_DIR=$T/s LOG_DIR=$T/l BAW_BIN=$PWD/test/fake-baw.sh FAKE_BAW_LOG=$T/calls CONFIG=$T/cfg.json FAKE_PREVIEW=test/fixtures/preview-ok.json
L=$T/s/ledger-$(TZ=Asia/Taipei date +%F).json
cand() { printf '{"kind":"free","targets":[{"to":"0x%s"}]}' "$(printf "$1%.0s" {1..40})" > $T/cand-$1.json; }
for x in a b c d; do cand $x; done
# 預算 0.0001、每筆預留 0.00005 → 只容兩筆
printf '%s' '{"dailyMax":100,"perContractDaily":1,"denylist":[],"gasBudgetBNB":"0.0001","gasReserveBNB":"0.00005"}' > $T/cfg.json
# 1) 兩筆過、第三筆擋 gas 預算（fake txHash 0xdead 不對帳，預留不退）
node src/exec.mjs $T/cand-a.json >/dev/null; node src/exec.mjs $T/cand-b.json >/dev/null
r=$(node src/exec.mjs $T/cand-c.json)
[ "$(jq -r '.reasons|join(",")' <<<"$r")" = "已達每日 gas 預算" ] || { echo "FAIL1: $r"; exit 1; }
[ "$(jq -r .gasWei $L)" = "100000000000000" ] || { echo "FAIL1b: $(cat $L)"; exit 1; }
# 2) receipt 對帳：假 RPC 回 gasUsed 0x2710 × price 0x3b9aca00 = 1e13 wei，兩筆共 2e13
H=0x$(printf 'e%.0s' {1..64})
jq --arg h $H '.pending |= map(.txHash=$h)' $L > $T/x && mv $T/x $L
node -e 'require("http").createServer((q,s)=>{s.end(JSON.stringify({result:{gasUsed:"0x2710",effectiveGasPrice:"0x3b9aca00"}}))}).listen(0,function(){require("fs").writeFileSync(process.argv[1],String(this.address().port))})' $T/port & SRV=$!
for _ in $(seq 50); do [ -s $T/port ] && break; sleep 0.1; done
r=$(BSC_RPC=http://127.0.0.1:$(cat $T/port) node src/exec.mjs $T/cand-c.json)
[ "$(jq -r .ok <<<"$r")" = true ] || { echo "FAIL2: 對帳後應放行 $r"; exit 1; }
# 2e13 實際 + 5e13 新預留
[ "$(jq -r .gasWei $L)" = "70000000000000" ] || { echo "FAIL2b: $(cat $L)"; exit 1; }
# 3) 模擬有過但被上限擋：回報上限原因，不是「preview 失敗」
printf '%s' '{"dailyMax":3,"perContractDaily":1,"denylist":[]}' > $T/cfg.json
r=$(FAKE_PREVIEW_MATCH=0xa0712d68 node src/exec.mjs $T/cand-d.json)
[ "$(jq -r '.reasons|join(",")' <<<"$r")" = "已達每日自動執行上限" ] || { echo "FAIL3: $r"; exit 1; }
# 4) 全部模擬失敗：報失敗訊息、不混上限
r=$(FAKE_PREVIEW_MATCH=nomatch node src/exec.mjs $T/cand-d.json)
[ "$(jq -r '.reasons|join(",")' <<<"$r")" = "preview 失敗或被攔截：sim fail" ] || { echo "FAIL4: $r"; exit 1; }
echo ok
