#!/bin/bash
# 跑一輪：掃新盤與推文 → 付費盤推簡報、推文交 triage → 0 元候選過閘執行 → TG 回報。
# launchd 每 120s 叫一次；處理過的 queue 檔移到 queue/done/。
set -u
cd "$(dirname "$0")"
Q=${QUEUE_DIR:-queue}; L=${LOG_DIR:-logs}; mkdir -p "$Q/done" "$L"
log() { printf '%s %s\n' "$(TZ=Asia/Taipei date '+%F %T')" "$*" >> "$L/run.log"; }
# TG /pause 建的旗標；暫停時整輪不跑
[ -e "${STATE_DIR:-state}/PAUSED" ] && { log "paused"; exit 0; }
# 推播走 @your_bot（TG_BOT_TOKEN／TG_CHAT_ID 由 bin/launch.sh 帶入；TG_DRY=1 只印不送）
tg() { node src/notify.mjs "$1" >/dev/null 2>>"$L/run.log" || log "notify fail"; }

# App 日限額最低 1000U 降不下來，改用錢包餘額當風險上限：超過 BAL_MAX_BNB 就暫停（/resume 解除）
# 查不到餘額（登出、API 掛）整輪不跑，只推一次免洗版
S=${STATE_DIR:-state}; mkdir -p "$S"
bal=$("${BAW_BIN:-node_modules/.bin/baw}" wallet balance --json 2>>"$L/run.log" |
  jq -r '[.data[]? | select(.binanceChainId=="56" and .symbol=="BNB") | .balance][0] // empty' 2>/dev/null)
if ! [[ "$bal" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
  log "balance unknown"
  [ -e "$S/BAL_UNKNOWN" ] || { touch "$S/BAL_UNKNOWN"; tg "⚠️ 查不到 Agent 錢包 BNB 餘額，暫停打新（可能登出，要重掃 QR）"; }
  exit 0
fi
rm -f "$S/BAL_UNKNOWN"
if awk -v b="$bal" -v m="${BAL_MAX_BNB:-0.05}" 'BEGIN{exit !(b>m)}'; then
  touch "$S/PAUSED"; log "balance $bal > ${BAL_MAX_BNB:-0.05}, paused"
  tg "⛔ Agent 錢包 BNB 餘額 $bal 超過上限 ${BAL_MAX_BNB:-0.05}，已暫停。轉出多餘的再回 /resume"
  exit 0
fi

# 內盤自動買賣（規則寫死不經 LLM）；先跑，時間差就是錢
node src/autotrade.mjs >> "$L/run.log" 2>&1 || log "autotrade fail"
node src/sell.mjs auto-all 2>>"$L/run.log" | while IFS= read -r line; do printf '%s\n' "$line" >> "$L/run.log"; t=$(printf '%s' "$line" | jq -r '.text // empty' 2>/dev/null); [ -n "$t" ] && tg "$t"; done
node src/allowance-scan.mjs daily 2>>"$L/run.log" | while IFS= read -r line; do printf '%s\n' "$line" >> "$L/run.log"; t=$(printf '%s' "$line" | jq -r '.text // empty' 2>/dev/null); [ -n "$t" ] && tg "$t"; done

node src/watch-memerush.mjs --once >> "$L/run.log" 2>&1 || log "watch-memerush fail"
# X 用登入中的帳號抓，每 10 分鐘一次免被限流
# X 推文由獨立 job com.agentid.watchx 每 600s 掃（xround.sh），429 退避不擋這裡；X_EVERY_RUN=1 只給測試同輪跑
[ "${X_EVERY_RUN:-0}" = 1 ] && { node src/watch-x.mjs --once >> "$L/run.log" 2>&1 || log "watch-x fail"; }

for f in "$Q"/memerush-*.json; do
  [ -e "$f" ] || continue
  # 只推判定「可考慮」的，觀望／避開只記 log，免得 TG 洗版
  brief=$(node src/research.mjs "$f" 2>>"$L/run.log") &&
    if grep -A2 '### 判定' <<<"$brief" | grep -q '可考慮'; then tg "$brief"; else log "skip brief $(basename "$f")"; fi
  mv "$f" "$Q/done/"
done

for f in "$Q"/x-*.json; do
  [ -e "$f" ] || continue
  cand=$(node src/triage.mjs "$f" 2>>"$L/run.log") || { log "triage fail $f"; mv "$f" "$Q/done/"; continue; }
  mv "$f" "$Q/done/"
  id=$(jq -r '.tweet.id // empty' "$Q/done/$(basename "$f")")
  c="$Q/cand-$id.json"
  case $(jq -r .kind <<<"$cand") in
    free)
      r=$(node src/exec.mjs "$c" 2>>"$L/run.log")
      log "exec $c $r"
      if [ "$(jq -r .ok <<<"$r")" = true ]; then
        tg "✅ 免費 mint 已送出 $(jq -r .txHash <<<"$r")  來源 $(jq -r '.tweet.url // .source' "$c")"
        # 背景等 receipt 找項目自家買單簿，有才推（只通知不賣）；失敗只記 log、不擋 mint
        tx=$(jq -r '.txHash // empty' <<<"$r")
        [ -n "$tx" ] && ( m=$(node src/market-detect.mjs "$tx" 2>>"$L/run.log"); log "market $tx $m"
          t=$(jq -r '.text // empty' <<<"$m" 2>/dev/null); [ -n "$t" ] && tg "$t" ) &
      fi ;; # 擋下的只記 log，bin/blocked-digest.sh 每小時彙整推一次
    # 付費盤留檔等使用者在 TG 打 /buy <id> <BNB>；金額不交給 LLM
    paid) mkdir -p "$Q/paid"; cp "$c" "$Q/paid/"
      tg "💰 付費項目（未下單）：$(jq -r '.why' <<<"$cand")  $(jq -r '.tweet.url // empty' "$c")
要買就回 /buy $id <BNB 金額>（每筆上限 0.005）" ;;
  esac
  [ -e "$c" ] && mv "$c" "$Q/done/"
done
