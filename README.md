# Huntress

A Telegram-driven bot for the **Binance Agentic Wallet** (`baw` CLI) that hunts new launches on BNB Chain:
free (0 BNB) Agent ID mints run fully automatically, Agent ID bonding-curve tokens are bought and sold by fixed rules,
and anything else that costs money is sent to Telegram as a research brief that you confirm with a button.

The core rule: **the LLM only proposes; a hard-coded gate decides.** The gate (`lib/gate.mjs`) reads only the
structured fields of baw's on-chain `preview` simulation and rejects anything it does not recognise (fail-closed).
Token names, descriptions and tweets never reach the decision.

```
sources (zero-token)        meme-rush poller · X account rotation · optional Grok sweep
        │
        └→ queue → triage (free LLM, proposes free / paid / skip)
                     ├ free → preview → gate → execute → ledger → Telegram
                     └ paid → research brief → Telegram → /buy <id> <BNB> → button confirm
trading               autotrade (rules) · sell (NFT order books, decaying floor) · revoke (every approve gets undone)
ops                   balance gate · gas budget · allowance scan · hourly digest · Telegram bot (/status /pause /buy /sell /revoke)
Q&A                   headless `claude -p --tools ""` — zero tools, fed pre-fetched read-only data
```

- Design: [`DESIGN.md`](DESIGN.md) (Chinese)
- Dev log and lessons: [`DEVLOG.md`](DEVLOG.md) (Chinese) — 80 commits in four days, ten takeaways at the end
- Most modules were written by cheap LLM executors from work orders and accepted by external scripts' exit codes (the work orders are not published)

## Requirements

- macOS (scheduling uses launchd; the scripts themselves are plain bash + Node)
- Node 22+, `npm install` (pulls `@binance/agentic-wallet`, which provides `baw`)
- A Binance Agentic Wallet with an Agent ID, Developer Mode on, daily limits set to the minimum, and only gas money inside
- A Telegram bot token and your chat id
- Optional: an X CLI for account polling (`TWITTER_BIN`), `opencode` for free-model triage (`bin/triage-llm.sh`), `claude` for Q&A

## Setup

```bash
git clone https://github.com/royalskynet/huntress && cd huntress
npm install
cp config.example.json config.json            # limits, X queries/accounts, autotrade, sellAuto
mkdir -p ~/.config/agentid-newlaunch
printf 'TG_CHAT_ID=<your chat id>\nTG_BOT_TOKEN=<your bot token>\n' > ~/.config/agentid-newlaunch/env
chmod 600 ~/.config/agentid-newlaunch/env
node_modules/.bin/baw auth signin              # scan the QR in the Binance app
```

Run the tests (they use `test/fake-baw.sh` and never touch a real wallet):

```bash
node --test test/*.test.mjs
bash test/e2e.sh
```

Then edit the paths in `launchd/*.plist` and `launchctl bootstrap gui/$(id -u) launchd/com.agentid.newlaunch.plist`
(plus `bot`, `watchx`, `digest` as needed). `TG_DRY=1` prints notifications instead of sending them.

## Risk

This bot signs real transactions. Free mints still cost gas and can be phishing contracts; the gate blocks what the
simulation can see, not logic that triggers later. Keep only gas money in the wallet and set the wallet-side limits.
Not financial advice.

---

# Huntress（中文）

幣安 Agentic Wallet（`baw` CLI）的 Telegram 打新機器人：0 元 Agent ID mint 全自動；Agent ID 專屬內盤依寫死規則自動買賣；其他要花錢的單推投研簡報到 TG，按鈕確認才下單。

核心規則：**LLM 只提案，寫死的機械閘決定。** 閘只讀 baw `preview` 鏈上預演的結構化欄位，不認得就拒絕；代幣名稱、描述、推文都進不了決策。

- 設計：[`DESIGN.md`](DESIGN.md)
- 開發日誌與教學重點：[`DEVLOG.md`](DEVLOG.md)

安裝與測試見上方英文段。這個 bot 會簽真實交易：錢包只放 gas 錢，App 端額度調到最低。不構成投資建議。

MIT License
