#!/bin/bash
# 每日一次把「找新帳號＋補漏」丟給雲端 Grok Bot（launchd com.agentid.grokscan）；結果由 xround.sh 的 ingest-grok 收
# Grok 11-24 到期（已退訂），之後自動停
set -u
cd "$(dirname "$0")"
L=${LOG_DIR:-logs}; mkdir -p "$L"
log() { printf '%s %s\n' "$(TZ=Asia/Taipei date '+%F %T')" "$*" >> "$L/run.log"; }
[ "$(TZ=Asia/Taipei date +%Y%m%d)" -gt 20261124 ] && { log "grokscan: Grok 已到期，跳過"; exit 0; }
d=$(TZ=Asia/Taipei date +%F)
known=$(jq -r '[.x.priority[]?, .x.accounts[]?] | join(", ")' config.json)
extra=$(jq -r 'join(", ")' state/x-extra.json 2>/dev/null)
task=$(cat <<T
任務：BNB Chain「幣安 Agent ID／Agentic Wallet」打新情報每日掃描（${d}）。
1. 用 X 搜尋過去 24 小時的推文，關鍵字包括：Agent ID free mint、Agent ID 免费铸造、Proof of Agent、Agentic Wallet 内盘、four.meme Agent ID、flap Agent ID。
2. 找出「固定在整理或首發 Agent ID 新盤」、而且不在這份清單裡的 X 帳號，最多 5 個：${known}${extra:+, $extra}
3. 列出過去 24 小時內的 Agent ID 0 元 mint 或內盤新盤，最多 30 個。每個都要附原推文網址（x.com/<帳號>/status/<數字>）。合約地址查得到才填，查不到就省略，不要猜。
4. 完成後在雲端電腦執行 gh，開 issue 回報：
   gh issue create -R royalskynet/grokbots-ops --title "agentid-grokscan ${d}" --body-file <檔>
   內文只放一個 json code block，格式如下：
   {"accounts":[{"handle":"帳號不含@","why":"一句理由"}],"launches":[{"tweet":"https://x.com/帳號/status/數字","name":"專案名","contract":"0x...","chainId":"56","note":"一句"}]}
不要買、不要 mint、不要發文，也不要開別的 issue。gh 失敗就把同一段 json 回在這個對話裡。
T
)
code=$(GROKBOT_REPLY=none bash "$HOME/.claude/skills/send-to-grok-bot/send.sh" "$task" 2>>"$L/run.log")
log "grokscan sent http=$code"
