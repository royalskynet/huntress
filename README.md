# Huntress

> **Status: v4 rewrite, read-only.** Huntress is now a daily smart-money screener built on three official skills from
> [binance/binance-skills-hub](https://github.com/binance/binance-skills-hub) (pinned commit in `vendor/`).
> It never signs a transaction. The previous trading bot (v3) is kept at git tag `legacy-v3-2026-11-16`.

Once a day it:

1. pulls early BNB Chain launches with `meme-rush` (new + finalizing bonding curves);
2. drops pools under the liquidity floor;
3. asks `baw leaderboard alpha-radar` which high win-rate wallets hold each candidate (`binance-leaderboard`);
4. runs `query-token-audit` and rejects anything with an unrenounced owner, tax ≥ 5 %, a honeypot hit, an unknown tax, or any other `isHit`;
5. pushes at most five 3-line briefs (CA / smart-money entry price / pool depth) to Telegram for you to confirm.

The decision is hard-coded in `lib/smartmoney.mjs` and fails closed. No LLM is involved.

**Known gaps (stated, not hidden):** the official skills expose realized PnL and win rate, not wallet entry prices, so the
brief prints "無資料" for the entry price. `baw leaderboard` needs a logged-in `baw` session (`baw auth signin`); when
logged out the job sends one alert per day and sends no brief.

```
src/smartmoney.mjs   orchestrator (read-only; baw subcommand: leaderboard only)
lib/smartmoney.mjs   pure gates + brief formatter
bin/vendor.sh         fetch the pinned official skill repo into vendor/ (run once)
bin/smartmoney.sh    launchd entry (launchd/com.agentid.smartmoney.plist, daily 09:15)
test/smartmoney.test.mjs   gate tests + a structural check that no signing module is imported
```

Setup: `npm install && bin/vendor.sh && cp config.example.json config.json`, put `TG_BOT_TOKEN`/`TG_CHAT_ID` in `~/.config/agentid-newlaunch/env`, run `node_modules/.bin/baw auth signin`.

Config (`config.json` → `smartMoney`, all optional): `minWinRate` 55, `minWallets` 2, `minLiquidityUsd` 5000,
`maxTaxPct` 5, `maxBriefs` 5. Run tests: `node --test test/smartmoney.test.mjs`. `TG_DRY=1` prints instead of sending.

Not financial advice. Passing the audit screen is a point-in-time snapshot, not a safety guarantee.

---

# Huntress（中文）

v4 改寫為**唯讀**的每日聰明錢初篩，建在幣安官方技能庫 `binance-skills-hub` 的三個技能上（`binance-leaderboard`、`meme-rush`、`query-token-audit`，版本釘在 `vendor/`）。**不簽任何交易。** 舊版交易機器人（v3）在 git tag `legacy-v3-2026-11-16`。

流程：meme-rush 抓早期標的 → 池子流動性閘 → alpha-radar 找持有的高勝率錢包 → 合約審計閘（未放棄權限、稅 ≥ 5%、貔貅、稅率未知、任何 `isHit` 都剔除）→ 最多五則三行簡報（CA／聰明錢買入均價／池子深度）推 Telegram 等你確認。決策是寫死的機械閘，fail-closed，不經 LLM。

已知缺口：官方技能不提供錢包買入均價，簡報該欄寫「無資料」；`baw leaderboard` 需要已登入的 `baw`（`baw auth signin`），登出時每天只告警一次、不推簡報。
