# 付費內盤自動買賣方案｜Four 專區＋Flap Agent Curve（2026-10-28 台北）

級別 L2（錢路徑）。輪子：借鏡 bnbxcs/TMTN（MIT，116★，未審計，只讀 README 不裝）＋官方 `agent-id-exclusive-token-launches.mjs`（只支援 OpenFour）。

## 限額（使用者 10-28 定）

- 單盤買入 0.004 BNB
- 同時持倉最多 4 盤
- 錢包 < 0.005 BNB 不再買（賣、claim 照常）

0.005 BNB 也是免費 mint 的 gas 墊底；最壞同時虧光 4 盤＝0.016 BNB（約 12 美元）。
每日筆數備援 4 筆。程式常數 `PER_TX_MAX_WEI` 0.005 不動；`DAILY_MAX_WEI` 0.015→0.016；`DAILY_COUNT` 3→4。

## 現況（10-28 晚查）

- `src/autotrade.mjs` 10:14 上線，只掃 Four.meme `openfour.meme.AgentIdExclusive`；**0 筆成交、0 行 log**。
- 原因：專區 59 盤有 57 盤 `holders < 15`，被 `screen()` 擋；`screen()` 不寫 log，所以看不出來。
- 現有賣出規則：2 倍賣一半、跌到一半全賣、持有 24h 全賣。內盤賣先 approve（只准這顆幣給 Core）。

## 要改什麼

### A. 篩選看得見（先做，零風險）

- `screen()` 擋下原因每輪彙總一行寫 `run.log`（例：`autobuy screen four 59 盤：持幣<15 ×57、超時 ×1`），進每小時 digest，不即時推 TG。

### B. 持倉上限與停手線

- `config.autotrade.limits = { perBuyBNB: "0.004", maxOpen: 4, minWalletBNB: "0.005" }`。
- 買前三查，任一不過本輪不買：持倉數 < 4；`baw wallet balance` 的 BNB − 0.004 ≥ 0.005；當日帳本 + 0.004 ≤ 0.016。
- 錢包餘額讀不到 → 不買（fail-closed）。

### C. Flap Agent Curve 進場

合約（TMTN README；鏈上已確認有 code，皆為 proxy）：
- Agent Curve Reader `0x18Aa6C93f1887a243fdc348C9A77F5136555174a`
- Portal（買／賣／claim）`0x49387D2E6cbF8FefE856e3FBc3E98a01aC3af062`
- Factory（新盤事件）`0xC55820f24015bE7c4f18949D9e1363A3609B300e`

**第 0 階段（唯讀查證，過了才寫下單碼）**
1. 新盤來源：meme-rush `protocol 2002` 的 `tokenVersion` 6／7 哪個是 Agent Curve（官方文件寫無文件意義）；對不上就改讀 Factory 新市場事件。
2. Portal buy／sell／claim 函式簽章：讀 TMTN `portal.js`，再用 `eth_call` 對一個活盤模擬 buy，確認回傳份額與 2% 上限錯誤碼。
3. 曲線期能不能賣、何時 claim。查不到就寫死「未畢業不賣，畢業後 claim 再賣」。
4. 驗收：`node src/flap.mjs quote '{"market":"<活盤>","budget":"0.004"}'` 回 calldata＋模擬成功，全程 0 筆交易。

**進場條件（冷開，全機械、不給 LLM）**
- 上線 ≤ 60 分鐘；曲線進度 3–40%；持幣 ≥ 5；dev 未清倉。
- Flap 買／賣稅皆 ≤ 5%；稅為 null → 不買。
- 不在 denylist；同一顆幣只買一次。
- 代幣 name／symbol／description 只進 log，不進 LLM、不進 TG HTML（Flap 已出現名稱塞 `<img onerror>` 的假 TMTN）。

### D. 閘：付費模式只放行四種交易

共同條件：preview 成功、`requireConfirmation==false`、無 risks；任何欄位缺漏都拒絕。
- **買**：`to` 只准 Portal 或 OpenFour Core；付出只有 BNB 且 ≤ 0.004；收到只有這顆幣；不准任何授權。
- **claim**：`to` 只准 Portal；不付任何東西；收到只有這顆幣；不准授權。
- **賣前 approve**：`to`＝這顆幣；spender 只准 Portal／Core；額度 ≤ 持倉量，**無限額度必拒**。
- **賣**：`to` 只准 Portal／Core／PancakeSwap Router；付出只有這顆幣；收到只有 BNB。

TMTN 會預先大額授權求快；本方案不抄，要賣那一輪才 approve，下一輪才賣。

### E. 出場（沿用＋Flap 補 claim）

- 沿用：2 倍賣一半、跌到一半全賣、持有 24h 全賣。
- Flap：畢業（phase 變更）後下一輪自動 claim，成功才進賣出判斷。
- 24h 到期但未畢業賣不了：推 TG 一則，繼續持有，每 6h 提醒一次。

### F. 通知

- 買進、claim、賣出成交：即時推 TG（BNB 數＋tx 連結）。
- 篩選擋下、閘擋下：只進每小時 digest。
- 停手線觸發推一次，回到線上再推一次。

## 第 0 階段查證結果（10-28 晚，全唯讀，錢包 nonce 前後皆 26）

- **新盤來源**：直接讀 Reader `marketPage`／`marketCards`，不必猜 meme-rush tokenVersion。累計 97 盤：85 盤曲線中、12 盤畢業（12%）；進度 <1% 有 60 盤，落在 3–40% 只 6 盤。新盤買賣筆數幾乎相等，像機器人刷量。
- **計價幣**：97 盤只有 43 盤用 BNB 計價，其餘是 USDT 等。**只做 `quoteToken == 0x0` 的 BNB 盤**，非 BNB 盤要多換一次幣，不做。
- **Portal 函式**（TMTN `engine/live/portal.js`）：`buy(address market,uint256 minShares) payable`（selector `0xcce7ec13`）、`quoteBuy(market,wallet,grossWei) view → (gross,fee,extra,shares)`、`sell(market,grossQuoteOut,maxShares,minNetOut)`、`sellAll(market,minNetOut)`、`claim(market)`；份額查 `market.sharesOf(wallet)`。
- **實測 `0xfd0d9e4A…`（BNB 盤，進度 8.26%）**：`quoteBuy` 0.004 BNB → 手續費 0.00004（1%）、約 6.1e23 份；`eth_call buy` 成功；`marketSettings` 買賣稅各 100 bps、maxWalletBps 200、cap 5 BNB。
- **baw preview 看不到份額**：Portal.buy 的 balanceChanges 只有「BNB −0.004」，simulationCode 000000000、無風險、免確認。所以「收到的就是這顆幣」這條檢查對 Flap 不適用，**改成 `quoteBuy` 份額 > 0，且 minShares ≥ 份額 × (1 − 滑點)**。
- **曲線期可以賣**：買到的是曲線份額（不是 ERC20），TMTN 在曲線期直接 `Portal.sellAll`／`sell` 賣回 BNB，**不需要 approve**。畢業後才 `claim` 成代幣，再走 PancakeSwap 賣。曲線期賣出尚未鏈上實測（手上沒份額），留到影子跑後第一筆真單驗。
- **2% 上限錯誤碼**：未測。0.004 BNB 遠低於 2%（cap 5 BNB 的 2%＝0.1 BNB），不影響。

### 因此改 C／D／E

- C 進場：多一條「BNB 計價」；上線時間用 `marketDetail.launchedAt`、持幣用 `holderCount`、稅用 `marketSettings.launch.buyTaxRate/sellTaxRate`。
- D 閘：Flap 買只准 `to == Portal`、selector `0xcce7ec13`、calldata 內 market 等於這盤、付出只有 BNB ≤ 0.004、無授權。Flap 曲線期賣只准 `to == Portal`、selector 為 sell／sellAll、calldata market 等於持倉盤、preview 收到只有 BNB、無授權。曲線期不走 approve。
- E 出場：曲線期估值用 `eth_call sellAll(market,0)` 的回傳值；畢業後 `claim` 再照 Four 外盤流程賣。

## 執行順序與驗收（exit code 判定）

1. **A＋B**：`node --test test/autotrade.test.mjs` 新增第 5 盤被拒、餘額 0.008 被拒、餘額讀不到被拒；邏輯改錯要 fail。上線後 Four 專區就照新限額跑（門檻不變）。
2. **第 0 階段**：上面的唯讀 quote 指令 rc=0，且錢包 nonce 前後不變。
3. **C＋D＋E**：fake-baw 測試，買／claim／approve／賣各一正一反例；無限 approve 必拒。
4. **影子跑 24h**：`AUTOTRADE_DRY=1` 照常篩選、preview，不 execute；「本來會買」記 `logs/shadow.jsonl`，24h 後對照價格算假想損益推 TG。
5. **上線**：第 4 步至少 1 筆「本來會買」且無閘誤放，才關 DRY 開始花錢。

## 已知風險（照收）

- 獲利個案都是自述，無交易哈希；冷開勝率查無統計，第 4 步影子跑是唯一勝率依據。
- Flap 合約皆 proxy，可被升級；介面變了 → preview 失敗 → 不買（fail-closed）。
- Dev Mode 7 天無外部交易自動關；Dev Mode 日額 20U 夠用（4 盤約 12 美元）。

## 不做

- 不裝 TMTN、不抄它的預授權、不碰 gang.fun。
- 不放寬 Four 專區 `minHolders 15`，等影子資料再議。
