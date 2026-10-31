#!/bin/bash
# 每小時彙整一次「免費 mint 被閘擋下」推 TG，取代 run.sh 每筆都推（洗版）。零 token。
# 從上次讀到的 run.log 行號往後數；沒有新的擋下就不推。launchd com.agentid.digest 每 3600s 叫一次。
set -u
cd "$(dirname "$0")/.."
L=${LOG_DIR:-logs}; S=${STATE_DIR:-state}; mkdir -p "$S"
off="$S/digest-line"
n=$(wc -l < "$L/run.log" | tr -d ' ')
from=$(cat "$off" 2>/dev/null || echo 0)
# run.log 被輪替變短就從頭數
[[ "$from" =~ ^[0-9]+$ ]] && [ "$from" -le "$n" ] || from=0
# 只算整筆 .ok=false；部分 target 成功的那筆不算擋下
blocked=$(sed -n "$((from + 1)),${n}p" "$L/run.log" | grep -E '^[0-9-]+ [0-9:]+ exec ' |
  while IFS= read -r line; do [ "$(sed -E 's/^[^{]*//' <<<"$line" | jq -r .ok 2>/dev/null)" = false ] && printf '%s\n' "$line"; done)
echo "$n" > "$off"
[ -n "$blocked" ] || exit 0
# 例行擋下不推：同合約重複（perContractDaily）、preview revert（要簽名或特殊參數，修不了）
# 只剩例行的就不推；有額度、gas、風險這類要人看的才推
act=$(sed -E 's/^[^{]*//' <<<"$blocked" | jq -r '(.reasons // [.error // "未知"]) | map(tostring) | .[]' 2>/dev/null |
  grep -vE '^(此合約今日已達上限|preview 失敗或被攔截.*)$' || true)
[ -n "$act" ] || exit 0

cnt=$(wc -l <<<"$blocked" | tr -d ' ')
# 只列要人看的原因；例行的併成一行
byreason=$(sort <<<"$act" | uniq -c | sort -rn | awk '{c=$1; $1=""; printf "・%s 筆：%s\n", c, substr($0,2)}')
routine=$(sed -E 's/^[^{]*//' <<<"$blocked" | jq -r '(.reasons // [.error // "未知"]) | map(tostring) | all(test("^(此合約今日已達上限|preview 失敗或被攔截.*)$"))' 2>/dev/null | grep -c true || true)
[ "$routine" -gt 0 ] && byreason="${byreason}
・例行 ${routine} 筆（同合約重複、預演 revert）"
first=$(head -1 <<<"$blocked" | cut -c12-16); last=$(tail -1 <<<"$blocked" | cut -c12-16)
used=$(jq -r '.total // 0' "$S/ledger-$(TZ=Asia/Taipei date +%F).json" 2>/dev/null || echo 0)
max=$(jq -r '.dailyMax // "?"' "${CONFIG:-config.json}" 2>/dev/null)
gas=$(jq -r '((.gasWei // "0") | tonumber) / 1e18 | . * 100000 | round / 100000' "$S/ledger-$(TZ=Asia/Taipei date +%F).json" 2>/dev/null || echo 0)
budget=$(jq -r '.gasBudgetBNB // "?"' "${CONFIG:-config.json}" 2>/dev/null)
msg="⛔ 免費 mint 擋下 ${cnt} 筆（${first}–${last}）
${byreason}
今日 ${used}/${max} 筆，gas ${gas}/${budget} BNB"
if [ "${TG_DRY:-0}" = 1 ]; then printf '%s\n' "$msg"; else node src/notify.mjs "$msg" >/dev/null 2>>"$L/run.log" || echo "digest notify fail" >> "$L/run.log"; fi
