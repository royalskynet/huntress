#!/bin/bash
# lane 連續失敗告警測試：載入真正的 bin/lane.sh，用假 tg 計數。
set -u
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
tg() { echo "TG $*"; return "${TGRC:-0}"; }
. "$(dirname "$0")/../bin/lane.sh"

fail=0
check() {
  if [ "$2" = "$3" ]; then return 0; fi
  echo "FAIL: $1 (want $2 got $3)" >&2
  fail=1
}

# 1) 連敗 6 輪 → 1 則
LANE_STATE="$T/c1.json"
(
  base=1700000000
  i=1
  while [ "$i" -le 6 ]; do
    LANE_NOW=$((base + i * 60))
    lane x false
    i=$((i + 1))
  done
) > "$T/o1" 2>&1
check "6 連敗" 1 "$(grep -c '^TG ' "$T/o1")"

# 2) 連敗 5 輪 → 0 則
LANE_STATE="$T/c2.json"
(
  base=1700000000
  i=1
  while [ "$i" -le 5 ]; do
    LANE_NOW=$((base + i * 60))
    lane x false
    i=$((i + 1))
  done
) > "$T/o2" 2>&1
check "5 連敗" 0 "$(grep -c '^TG ' "$T/o2")"

# 3) 5 敗 + 1 成 + 5 敗 → 0 則
LANE_STATE="$T/c3.json"
(
  base=1700000000
  i=1
  while [ "$i" -le 5 ]; do
    LANE_NOW=$((base + i * 60))
    lane x false
    i=$((i + 1))
  done
  LANE_NOW=$((base + 360))
  lane x true
  i=1
  while [ "$i" -le 5 ]; do
    LANE_NOW=$((base + 360 + i * 60))
    lane x false
    i=$((i + 1))
  done
) > "$T/o3" 2>&1
check "5敗1成5敗" 0 "$(grep -c '^TG ' "$T/o3")"

# 4) 同一天連敗 12 輪 → 1 則
LANE_STATE="$T/c4.json"
(
  base=1700000000
  i=1
  while [ "$i" -le 12 ]; do
    LANE_NOW=$((base + i * 60))
    lane x false
    i=$((i + 1))
  done
) > "$T/o4" 2>&1
check "同日 12 連敗" 1 "$(grep -c '^TG ' "$T/o4")"

# 5) 每輪間隔 25h、連敗 12 輪 → 只在第 6、12 輪告警（共 2 則）
LANE_STATE="$T/c5.json"
(
  base=1700000000
  i=1
  while [ "$i" -le 12 ]; do
    LANE_NOW=$((base + i * 90000))
    lane x false
    i=$((i + 1))
  done
) > "$T/o5" 2>&1
check "跨24h 12連敗" 2 "$(grep -c '^TG ' "$T/o5")"

# 6) lane 回傳原指令 rc
LANE_STATE="$T/c6.json"
lane x true >/dev/null 2>&1
check "true rc" 0 $?
lane x false >/dev/null 2>&1
check "false rc" 1 $?
lane x sh -c 'exit 7' >/dev/null 2>&1
check "exit7 rc" 7 $?

# 7) tg 送達失敗不進 24h 冷卻：第 6 輪失敗、第 12 輪仍告警（共 2 則）
LANE_STATE="$T/c7.json"
(
  base=1700000000
  i=1
  while [ "$i" -le 6 ]; do
    TGRC=1 LANE_NOW=$((base + i)) lane z false
    i=$((i + 1))
  done
  unset TGRC
  i=7
  while [ "$i" -le 12 ]; do
    LANE_NOW=$((base + i)) lane z false
    i=$((i + 1))
  done
) > "$T/o7" 2>&1
check "tg失敗後仍告警" 2 "$(grep -c '^TG ' "$T/o7")"

# 8) 壞 JSON state 檔：不覆寫、仍回原 rc
printf '{bad' > "$T/c8.json"
LANE_STATE="$T/c8.json"
lane x false >/dev/null 2>&1
check "壞JSON rc" 1 $?
check "壞JSON 保留原檔" "{bad" "$(cat "$T/c8.json")"

# 遺留鎖（程序中途被殺）超過 10 分鐘要回收，不能永久停掉計數
LANE_STATE="$T/c9.json"
mkdir "$T/c9.json.lock" && touch -t 202001010000 "$T/c9.json.lock"
lane x false >/dev/null 2>&1
check "遺留鎖回收後記帳" 1 "$(jq -r '.x.n' "$T/c9.json" 2>/dev/null)"

# 遺留鎖刪不掉（非空目錄）不得無限迴圈：照常重試上限後放棄、回傳原 rc
LANE_STATE="$T/c10.json"
mkdir -p "$T/c10.json.lock/x" && touch -t 202001010000 "$T/c10.json.lock"
( sleep 15; kill -9 $$ 2>/dev/null ) & wd=$!
lane x false >/dev/null 2>&1
check "刪不掉的遺留鎖 rc" 1 $?
kill $wd 2>/dev/null

if [ "$fail" -ne 0 ]; then exit 1; fi
echo "LANE ALERT TEST PASS"
