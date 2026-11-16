import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { winPct, extractRows, goodWallets, groupByToken, poolGate, auditGate, formatBrief } from "../lib/smartmoney.mjs";

const audit = (over = {}, hit = null) => ({
  code: "000000",
  data: {
    hasResult: true, isSupported: true, riskLevelEnum: "LOW", riskLevel: 1,
    extraInfo: { buyTax: "0", sellTax: "0", unusualBuyTax: false, unusualSellTax: false, isFlaggedByVendor: false, isReported: false },
    riskItems: [{ details: [{ title: "Honeypot Risk Not Found", isHit: false }, ...(hit ? [{ title: hit, isHit: true }] : [])] }],
    ...over,
  },
});

test("auditGate: 乾淨合約通過", () => assert.equal(auditGate(audit()).pass, true));
test("auditGate: 高買稅剔除", () => assert.equal(auditGate(audit({ extraInfo: { buyTax: "12", sellTax: "0" } })).pass, false));
test("auditGate: 賣稅 null（未知）剔除", () => assert.equal(auditGate(audit({ extraInfo: { buyTax: "0", sellTax: null } })).pass, false));
test("auditGate: 未放棄權限（isHit）剔除", () => assert.equal(auditGate(audit({}, "Contract Renounced")).pass, false));
test("auditGate: 貔貅剔除", () => assert.equal(auditGate(audit({}, "Honeypot Risk")).pass, false));
test("auditGate: hasResult=false 剔除", () => assert.equal(auditGate(audit({ hasResult: false })).pass, false));
test("auditGate: isSupported=false 剔除", () => assert.equal(auditGate(audit({ isSupported: false })).pass, false));
test("auditGate: MEDIUM 剔除", () => assert.equal(auditGate(audit({ riskLevelEnum: "MEDIUM", riskLevel: 3 })).pass, false));
test("auditGate: API 錯誤碼剔除", () => assert.equal(auditGate({ code: "500", data: null }).pass, false));
test("auditGate: 空輸入剔除", () => assert.equal(auditGate(undefined).pass, false));

test("poolGate: 流動性不足與缺值剔除", () => {
  assert.equal(poolGate({ liquidity: "13170.03" }).pass, true);
  assert.equal(poolGate({ liquidity: "100" }).pass, false);
  assert.equal(poolGate({ liquidity: null }).pass, false);
});

test("extractRows: 未登入丟錯、形狀不明丟錯", () => {
  assert.throws(() => extractRows({ success: false, error: { name: "NOT_LOGGED_IN", message: "Not logged in" } }), /NOT_LOGGED_IN/);
  assert.throws(() => extractRows({ success: true, data: { x: 1 } }), /shape/);
  assert.deepEqual(extractRows({ success: true, data: { list: [1] } }), [1]);
});

test("goodWallets + groupByToken: 低勝率剔除，CA 大小寫合併", () => {
  const rows = [
    { address: "0xa", winRate: 0.7, realizedPnl: "500", marchedTokens: [{ tokenAddress: "0xABC", profitRate: "1.5" }] },
    { address: "0xb", winRate: 0.6, realizedPnl: "10", marchedTokens: [{ tokenAddress: "0xabc", profitRate: "0.2" }] },
    { address: "0xc", winRate: 0.3, realizedPnl: "900", marchedTokens: [{ tokenAddress: "0xabc", profitRate: "9" }] },
    { address: "0xd", winRate: "x", realizedPnl: "900", marchedTokens: [{ tokenAddress: "0xabc" }] },
  ];
  const g = groupByToken(goodWallets(rows));
  assert.equal(g.get("0xabc").length, 2);
});

test("formatBrief: 三行，且均價誠實標無資料", () => {
  const out = formatBrief({ symbol: "T", contractAddress: "0xabc", liquidity: "13170.9", price: "0.1", progress: "88.3" }, [{ winRate: 70 }, { winRate: 60 }]);
  assert.equal(out.split("\n").length, 3);
  assert.match(out, /無資料/);
});

test("結構斷言：新管線不得 import 簽名／交易模組，baw 只准唯讀子指令", () => {
  for (const f of ["../lib/smartmoney.mjs", "../src/smartmoney.mjs"]) {
    const s = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.doesNotMatch(s, /from\s+["'][^"']*(exec|buy|sell|revoke|autotrade)\.mjs["']/);
    assert.doesNotMatch(s, /market-order|limit-order|wallet\s+send|x402|["']swap["']/);
  }
});

test("winPct: 0–1 小數換算百分比；>1 代表尺度變了，丟錯而非猜", () => {
  assert.equal(winPct(0.625), 62.5);
  assert.equal(winPct("1"), 100);
  assert.ok(Number.isNaN(winPct(null)));
  assert.throws(() => winPct(70), /scale changed/);
});

test("真實形狀：alpha-radar 的 data 是 {data:[],current,size,pages}", () => {
  assert.deepEqual(extractRows({ success: true, data: { data: [1, 2], current: 1, size: 20, pages: 1 } }), [1, 2]);
});

test("實測值：勝率 0.2889（28.9%）被 55% 門檻剔除，0.625 通過", () => {
  const rows = [{ address: "0xa", winRate: 0.2889, realizedPnl: "94643" }, { address: "0xb", winRate: 0.625, realizedPnl: "34501" }];
  assert.deepEqual(goodWallets(rows).map((w) => w.address), ["0xb"]);
});
