# 幣安 Agent 錢包自動打新機器人｜設計 v3（2026-10-29 台北）

## 目標（以 0xHelen／梭哈.AI 為基礎）

1. **0 元 Mint／Agent ID 空投**：全自動。preview 沙箱預演過機械閘才 execute，回報 txHash。
2. **要花錢的 Agent ID 專屬內盤**（Open Four、Flap ID Agent Curve）：autotrade 依寫死規則自動買；其餘候選只做投研簡報推 TG，等使用者回 `/buy <id> <BNB>` 再按鈕確認下單。
3. **賣出與 TG 下單已上線**：持倉自動賣（漲到成本 2 倍賣一半、跌到 0.5 倍全賣、持有滿 24h 全賣）；NFT 白名單買單簿＋遞減底價自動賣；TG `/buy`、`/sell`、`/revoke` 皆為按鈕確認制。

## 和原教學的差別（為什麼改）

| 原教學 | 本設計 | 理由 |
|---|---|---|
| Grok Bot 每 5 分鐘 LLM 掃一輪 | zero-token 腳本輪詢，命中才叫 LLM | Grok Bot 要 SuperGrok／Cursor 付費；每輪燒 token |
| LLM 自己判斷「預演安全就執行」 | **LLM 只提案，機械閘決定** | LLM 可被推文提示注入；閘是寫死的條件 |
| clawby yolo 壓步驟（0xarthur） | 不採用 | 第三方 skill 拿錢包權限、壓掉預覽確認 |

Scott 的實測教訓照收：審計擋不了垃圾幣，真正的過濾是「分類＋上限」；Four.meme 熱盤搶不過科學家，只打冷開盤；Developer Mode 7 天沒外部交易自動關。

## 架構

```
新盤來源（zero-token）
  watch-memerush（meme-rush 內盤）
  watch-x（priority 每輪查＋其餘帳號輪流）
  ingest-grok ← grokscan（Grok 每日掃描 issue；11-24 到期自動跳過）
  prune-extra（Grok 加的帳號 7 天沒出新盤就移出輪流池）
        │
        └→ queue/*.json → triage（bin/triage-llm.sh，opencode 免費模型；只提案）
                              ├ free → exec：preview → gate → execute → ledger → TG
                              └ paid → research 簡報 → TG；queue/paid 等 /buy 按鈕確認
        free mint 成功 → market-detect（找項目自家鏈上買單簿，只通知）→ sell 白名單自動賣

交易與營運
  autotrade（Agent ID 內盤自動買賣；Flap 內盤由 flap.mjs 影子掃描驗證）
  buy（TG /buy 確認買入）
  sell（NFT 白名單＋遞減底價自動賣；TG /sell 確認賣出）
  revoke（賣完撤授權；TG /revoke 按鈕）
  flap-watch（Flap 回溫監看：新畢業、BNB 盤進度達門檻才推）
  allowance-scan（每日授權掃描，未歸零才推 TG）
  blocked-digest（免費 mint 被閘擋下每小時彙整）
  recalc-cap（11-04 一次性重算 dailyMax 報告，推完自卸載）
  bot（TG 指令與按鈕：/status /pause /resume /buy /sell /revoke）
  ask（TG 問答；headless claude 無工具，只讀預先抓好的資料）
```

## 排程

| launchd 任務 | 跑哪支 | 頻率 |
|---|---|---|
| `com.agentid.newlaunch` | `bin/launch.sh`（預設 `run.sh`） | 每 120 秒；RunAtLoad |
| `com.agentid.watchx` | `bin/launch.sh xround.sh` | 每 600 秒 |
| `com.agentid.bot` | `bin/bot.sh` → `bin/launch.sh bin/bot-poll.sh` | KeepAlive 常駐 long-poll |
| `com.agentid.grokscan` | `bin/launch.sh grokscan.sh` | 每日 09:00 |
| `com.agentid.flapwatch` | `bin/launch.sh bin/flap-watch.sh` | 每 1800 秒 |
| `com.agentid.digest` | `bin/launch.sh bin/blocked-digest.sh` | 每 3600 秒 |
| `com.agentid.recalc` | `bin/launch.sh bin/recalc-cap.sh` | 11-04 09:00 一次，推完自卸載 |

## 授權生命週期

- **誰會 approve**：`autotrade` 賣內盤持倉前，只准授權「這一顆代幣」給 Core（`approveGate` 過閘才送）；`sell` 賣 NFT 前對白名單買單簿做 `setApprovalForAll`（`run.sh` 每輪 `sell.mjs auto-all` 自動賣；TG `/sell` 是手動入口）。
- **何時自動撤**：`autotrade` 持倉賣完、代幣餘額為 0 且距買入超過 10 分鐘而結案時撤 ERC20 授權；`sell` 的 fill 成交後一定接一筆撤銷，並在 TG 回報「已撤授權／授權未撤」。
- **撤前預演條件**：`revokeGate` 要求 preview `success:true`、有 `requestId`、`simulationCode` 為成功碼、`authorityChanges` 空、`balanceChanges` 沒有負值；任一不符就不 execute。
- **撤失敗怎麼辦**：不重送，推 TG 說明原因並提示回 `/revoke` 或到 App 手動撤。`/revoke` 會列出目前未撤授權，每筆一顆按鈕；nonce 單次使用、10 分鐘過期。
- **每日掃描範圍**：`allowance-scan` 每 20 小時最多一輪，只掃「本 bot 碰過的合約」（買入帳本、持倉、已結案代幣、偵測到的 NFT 合約）的 `Approval`／`ApprovalForAll` 事件，再以 `allowance`／`isApprovedForAll` 查現值；未歸零才推 TG。App 內手動授權、或不在這份清單的合約掃不到。

## 機械閘 lib/gate.mjs（全部成立才 execute，主 session 自寫＋測試）

- preview `success:true`、有 `requestId`、`simulationResult.simulationCode=="000000000"`
- 免費 mint：`value==0`，且 `parsedTx` 無轉出金額（native 與 token 都不能少）；付費單（TG 按鈕確認）容許 `0 < value ≤` 單筆上限，模擬最多一筆資產減少
- `allowanceChanges`、`authorityChanges` 皆空；`risks.riskDetails` 空；`risks.addresses` 無 riskLevel>0
- `requireConfirmation==false`（true 就改推 TG 讓使用者去 App 按）
- `to` 不在 denylist；同一 `to` 當日已 mint 數 < `perContractDaily`；當日已花 gas（receipt 對帳，未上鏈的以 `gasReserveBNB` 預留計）＋本筆預留 ≤ `gasBudgetBNB`；`dailyMax` 只當備援上限
- 任何欄位缺漏或格式不符 → 拒絕（fail-closed）

## 錢包端護欄（使用者在幣安 App 設，AI 改不了）

- Agentic Wallet 每日額度：預設 200k 美元，**調到 50 U**
- Developer Mode 每日額度：**20 U**；錢包只放 gas 用 BNB（≈0.02 BNB）
- 地址簿不加任何外部地址（轉帳一律被擋）

## 檔案

```
run.sh                主輪：餘額閘、autotrade、自動賣、授權掃描、掃新盤、triage、執行
xround.sh             X 輪次：watch-x＋ingest-grok＋prune-extra
grokscan.sh           每日送 Grok 掃描任務（11-24 到期後跳過）
config.json           設定（鍵名見下）
lib/gate.mjs          機械閘
bin/blocked-digest.sh 免費 mint 被擋下的每小時彙整
bin/bot-poll.sh       TG long-poll 入口
bin/bot.sh            launchd 常駐 bot 的啟動殼
bin/flap-shadow-run.sh Flap 影子跑（只 preview）並推彙總
bin/flap-watch.sh     Flap 回溫監看的啟動殼
bin/launch.sh         帶入環境變數與憑證後執行指定腳本
bin/recalc-cap.py     dailyMax 重算報告內容
bin/recalc-cap.sh     dailyMax 重算報告推播＋自卸載
bin/triage-llm.sh     triage 用的免費模型指令
bin/window-report.sh  區間 log 統計（零 token）
src/allowance-scan.mjs 每日授權掃描與未撤清單
src/ask.mjs           TG 問答（headless claude、零工具）
src/autotrade.mjs     內盤自動買賣與持倉結案撤授權
src/bot.mjs           TG 指令、按鈕與 long-poll
src/buy.mjs           /buy 確認買入的預演、帳本與執行
src/exec.mjs          免費 mint 預演、過閘、執行與 gas 對帳
src/flap-watch.mjs    Flap 新畢業／進度門檻監看
src/flap.mjs          Flap 讀鏈、影子掃描與買入閘
src/ingest-grok.mjs   收 Grok issue：帳號進輪流池、新盤進 triage
src/market-detect.mjs mint 後偵測項目自家買單簿並存檔
src/notify.mjs        TG 推播
src/prune-extra.mjs   輪流池 7 天沒出新盤淘汰
src/research.mjs      付費盤投研簡報
src/revoke.mjs        撤授權 prepare／confirm
src/sell.mjs          NFT 賣單簿、白名單遞減底價自動賣
src/triage.mjs        推文分類成 free／paid／skip（只提案）
src/watch-memerush.mjs meme-rush 新盤輪詢
src/watch-x.mjs       X 帳號輪流掃描
vendor/               binance-skills-hub sparse clone＋node_modules/@binance/agentic-wallet
```

`config.json` 只列鍵名：`dailyMax`、`perContractDaily`、`denylist`、`x`、`autotrade`、`gasBudgetBNB`、`gasReserveBNB`、`sellAuto`。

所有呼叫 baw 的模組讀 `BAW_BIN` 環境變數，測試用 `test/fake-baw.sh` 回固定 JSON，不碰真錢包。

## 上線前要使用者在 App 做（一次性）

1. 錢包 → 更多 → Agentic Wallet → 領 .ai Agent ID
2. 安全設定：調低兩個額度（數字見上）、開 Developer Mode
3. 轉 0.02 BNB 進 Agentic Wallet
4. 掃 `baw auth signin` 給的 QR，核對配對碼

## X 調研修正（2026-10-28，報告 royalskynet/grokbots-ops `reports/2026-10-28-x-research-agentid.md`）

架構不變。逐條對照：
- **唯讀問答不給任何工具**：`--allowedTools` 擋 Edit/Write 擋不住 Bash（@MervinPraison 8/8 用 python3 改檔）。改成 bot.mjs 先跑唯讀 baw（wallet balance／address、query-*），把輸出當文字餵 `claude -p --tools "" --strict-mcp-config`；模型手上零工具。
- **metadata 是注入面**：token name／symbol／description 進 triage 只影響「提案」；gate 只看 preview 的模擬欄位，不讀任何文字欄位。已符合，不改。
- **假免費**：文案寫 0、模擬報付款不足（Dobly）。exec 一律用 value 0 預演，模擬失敗即拒。已符合。
- **execute 只吃 preview 的 requestId**：exec 已照此流程。預演失敗＝放棄該盤，不重試（重送冪等性 X 上查無；帳本送出前預扣已防重送）。
- **EIP-712 `sign-message` 不支援（baw 1.12.0，錯誤 953004）**：要先簽名／解題登入的盤一律跳過，只做純 contract-call。
- **Dev Mode 額度也卡買賣**：自動買入、NFT 自動賣出與授權撤銷都算交易，20U 會一併受限；撞到就先停手，等使用者去 App 臨時調高。
- **Dev Mode 連續 7 天無外部交易自動關**（單一來源）：preview 連續失敗時推 TG 提醒去 App 重開。
- **免費 mint 多數靈魂綁定／無市場**：報酬期望低，dailyMax 維持小值，gas 是主要成本。
- 仍查無：`balanceChanges` 實際欄位名（gate 未知格式一律拒，等第一筆真 preview 核對）。

## 風險明說

- 免費 mint 也有成本：gas＋被釣魚合約騙簽。閘擋得住「預演看得到的」扣款與授權，擋不住預演之後才觸發的惡意邏輯；所以錢包只放 gas 錢。
- 官方 skill 文件要求每筆 execute 前使用者確認。本設計對「0 元＋過閘」的類別事先一次授權，這是使用者的決定，不是官方建議。
- 第二意見（Jev）：同意 0.55、風險 3.3/5，信心低。
