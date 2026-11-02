import { test } from "node:test";
import assert from "node:assert/strict";
import * as f from "../src/flap.mjs";

const PORTAL = f.PORTAL;
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const MK = "0xfd0d9e4ad5c9ddc07f68d7adf1ab9b0b20e798c4";
const TOK = "0x1111111111111111111111111111111111111111";

function makePvOk(simExtra = {}, pvExtra = {}) {
  const sim = {
    simulationCode: "000000000",
    balanceChanges: [],
    authorityChanges: [],
    allowanceChanges: [],
    ...simExtra,
  };
  const d = {
    requestId: "rq",
    simulationResult: sim,
    risks: { riskDetails: [] },
    requireConfirmation: false,
    ...pvExtra,
  };
  return { success: true, data: d };
}

// sellGate tests
test("sellGate 正例", () => {
  const minNetOut = 12345n;
  const tx = { to: PORTAL, value: "0", inputData: f.encSellAll(MK, minNetOut) };
  const pv = makePvOk({ balanceChanges: [{ contractAddress: NATIVE, change: 100n }] });
  const g = f.sellGate(pv, tx, { market: MK, minNetOut });
  assert.equal(g.ok, true);
});

test("sellGate 反例 allowanceChanges 非空", () => {
  const minNetOut = 12345n;
  const tx = { to: PORTAL, value: "0", inputData: f.encSellAll(MK, minNetOut) };
  const pv = makePvOk({ balanceChanges: [{ contractAddress: NATIVE, change: 100n }], allowanceChanges: [{ a: 1 }] });
  const g = f.sellGate(pv, tx, { market: MK, minNetOut });
  assert.equal(g.ok, false);
});

test("sellGate 反例 to 錯", () => {
  const minNetOut = 12345n;
  const tx = { to: "0x0000000000000000000000000000000000000001", value: "0", inputData: f.encSellAll(MK, minNetOut) };
  const pv = makePvOk({ balanceChanges: [{ contractAddress: NATIVE, change: 100n }] });
  const g = f.sellGate(pv, tx, { market: MK, minNetOut });
  assert.equal(g.ok, false);
});

test("sellGate 反例 value≠0", () => {
  const minNetOut = 12345n;
  const tx = { to: PORTAL, value: "1", inputData: f.encSellAll(MK, minNetOut) };
  const pv = makePvOk({ balanceChanges: [{ contractAddress: NATIVE, change: 100n }] });
  const g = f.sellGate(pv, tx, { market: MK, minNetOut });
  assert.equal(g.ok, false);
});

test("sellGate 反例 selector 錯", () => {
  const minNetOut = 12345n;
  const tx = { to: PORTAL, value: "0", inputData: f.encBuy ? f.encBuy(MK, 1n) : f.encSellAll(MK, minNetOut).replace("d69f8e66", "cce7ec13") };
  const pv = makePvOk({ balanceChanges: [{ contractAddress: NATIVE, change: 100n }] });
  const g = f.sellGate(pv, tx, { market: MK, minNetOut });
  assert.equal(g.ok, false);
});

test("sellGate 反例 market 錯", () => {
  const minNetOut = 12345n;
  const tx = { to: PORTAL, value: "0", inputData: f.encSellAll("0x0000000000000000000000000000000000000002", minNetOut) };
  const pv = makePvOk({ balanceChanges: [{ contractAddress: NATIVE, change: 100n }] });
  const g = f.sellGate(pv, tx, { market: MK, minNetOut });
  assert.equal(g.ok, false);
});

test("sellGate 反例 balanceChanges 非一筆必拒", () => {
  const minNetOut = 12345n;
  const tx = { to: PORTAL, value: "0", inputData: f.encSellAll(MK, minNetOut) };
  const pv = makePvOk({ balanceChanges: [] });
  const g = f.sellGate(pv, tx, { market: MK, minNetOut });
  assert.equal(g.ok, false);

  const pv2 = makePvOk({ balanceChanges: [{ contractAddress: NATIVE, change: 100n }, { contractAddress: NATIVE, change: 1n }] });
  const g2 = f.sellGate(pv2, tx, { market: MK, minNetOut });
  assert.equal(g2.ok, false);
});

// claimGate tests
test("claimGate 正例", () => {
  const tx = { to: PORTAL, value: "0", inputData: f.encClaim(MK) };
  const pv = makePvOk({ balanceChanges: [{ contractAddress: TOK, change: 100n }] });
  const g = f.claimGate(pv, tx, { market: MK, token: TOK });
  assert.equal(g.ok, true);
});

test("claimGate 反例 allowanceChanges 非空", () => {
  const tx = { to: PORTAL, value: "0", inputData: f.encClaim(MK) };
  const pv = makePvOk({ balanceChanges: [{ contractAddress: TOK, change: 100n }], allowanceChanges: [{ a: 1 }] });
  const g = f.claimGate(pv, tx, { market: MK, token: TOK });
  assert.equal(g.ok, false);
});

test("claimGate 反例 to 錯", () => {
  const tx = { to: "0x0000000000000000000000000000000000000003", value: "0", inputData: f.encClaim(MK) };
  const pv = makePvOk({ balanceChanges: [{ contractAddress: TOK, change: 100n }] });
  const g = f.claimGate(pv, tx, { market: MK, token: TOK });
  assert.equal(g.ok, false);
});

test("claimGate 反例 value≠0", () => {
  const tx = { to: PORTAL, value: "5", inputData: f.encClaim(MK) };
  const pv = makePvOk({ balanceChanges: [{ contractAddress: TOK, change: 100n }] });
  const g = f.claimGate(pv, tx, { market: MK, token: TOK });
  assert.equal(g.ok, false);
});

test("claimGate 反例 selector 錯", () => {
  const tx = { to: PORTAL, value: "0", inputData: f.encSellAll(MK, 1n) };
  const pv = makePvOk({ balanceChanges: [{ contractAddress: TOK, change: 100n }] });
  const g = f.claimGate(pv, tx, { market: MK, token: TOK });
  assert.equal(g.ok, false);
});

test("claimGate 反例 market 錯", () => {
  const tx = { to: PORTAL, value: "0", inputData: f.encClaim("0x0000000000000000000000000000000000000004") };
  const pv = makePvOk({ balanceChanges: [{ contractAddress: TOK, change: 100n }] });
  const g = f.claimGate(pv, tx, { market: MK, token: TOK });
  assert.equal(g.ok, false);
});

test("claimGate 反例 balanceChanges 非一筆必拒", () => {
  const tx = { to: PORTAL, value: "0", inputData: f.encClaim(MK) };
  const pv = makePvOk({ balanceChanges: [] });
  const g = f.claimGate(pv, tx, { market: MK, token: TOK });
  assert.equal(g.ok, false);

  const pv2 = makePvOk({ balanceChanges: [{ contractAddress: TOK, change: 100n }, { contractAddress: TOK, change: 2n }] });
  const g2 = f.claimGate(pv2, tx, { market: MK, token: TOK });
  assert.equal(g2.ok, false);
});


// LIVE flow tests
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

const F = (n) => readFileSync(join(process.cwd(), "test/fixtures/flap", n), "utf8").trim();
const NOW = 1793180000000;
const pad2 = (x) => BigInt(x).toString(16).padStart(64, "0");
const page2 = "0x" + [pad2(96), pad2(0), pad2(1), pad2(1), pad2(MK)].join("");

function makeLiveDeps(extra = {}) {
  const L = mkdtempSync(join(tmpdir(), "fl-")), S = mkdtempSync(join(tmpdir(), "fs-"));
  const calls = [];
  const deps = {
    now: NOW,
    wallet: "0x5e1f5e1f5e1f5e1f5e1f5e1f5e1f5e1f5e1f5e1f",
    logDir: L,
    stateDir: S,
    cfg: { valueBNB: "0.004", minProgressBps: 300, maxProgressBps: 4000, minHolders: 5, maxAgeMin: 60, maxTaxBps: 500, slippageBps: 2000, scanLast: 32, checkAfterMin: 30, minHits: 5 },
    cfgAll: { paidShadow: { enabled: true, live: true } },
    call: (to, data) => {
      calls.push(data.slice(0, 10));
      if (data.startsWith(f.SEL.marketPage)) return page2;
      if (data.startsWith(f.SEL.marketDetail)) return F("detail-0xfd0d9e4AD5c9ddC07f68d7adF1aB9b0B20E798c4.hex");
      if (data.startsWith(f.SEL.marketSettings)) return F("settings-0xfd0d9e4AD5c9ddC07f68d7adF1aB9b0B20E798c4.hex");
      if (data.startsWith(f.SEL.quoteBuy)) return F("quotebuy-0xfd0d9e4AD5c9ddC07f68d7adF1aB9b0B20E798c4.hex");
      throw new Error("unexpected call " + data.slice(0, 10));
    },
    blockTs: () => Math.floor(NOW / 1000) - 30 * 60,
    preview: () => {
      calls.push("preview");
      return { success: true, data: { requestId: "rq", simulationResult: { simulationCode: "000000000", balanceChanges: [{ contractAddress: NATIVE, change: -4e15 }], authorityChanges: [], allowanceChanges: [] }, risks: { riskDetails: [] }, requireConfirmation: false } };
    },
    balance: () => ({ success: true, data: [{ binanceChainId: "56", symbol: "BNB", balance: "0.01" }] }),
    execute: () => { calls.push("execute"); return { success: true, data: { txHash: "0xabc123" } }; },
    notify: () => { calls.push("notify"); return { ok: true }; },
    ...extra,
  };
  deps.logs = [];
  deps.log = (m) => deps.logs.push(m);
  return { deps, calls, L, S };
}

test("LIVE 未達門檻 execute=0", async () => {
  const { deps, calls } = makeLiveDeps({ cfg: { valueBNB: "0.004", minProgressBps: 300, maxProgressBps: 4000, minHolders: 5, maxAgeMin: 60, maxTaxBps: 500, slippageBps: 2000, scanLast: 32, checkAfterMin: 30, minHits: 100 }, cfgAll: { paidShadow: { enabled: true, live: true } } });
  await f.runShadow(deps);
  assert.equal(calls.filter((c) => c === "execute").length, 0);
});

test("LIVE 達門檻餘額不足 execute=0", async () => {
  const { deps, calls } = makeLiveDeps({ cfg: { valueBNB: "0.004", minProgressBps: 300, maxProgressBps: 4000, minHolders: 5, maxAgeMin: 60, maxTaxBps: 500, slippageBps: 2000, scanLast: 32, checkAfterMin: 30, minHits: 0 }, cfgAll: { paidShadow: { enabled: true, live: true } }, balance: () => ({ success: true, data: [{ binanceChainId: "56", symbol: "BNB", balance: "0.001" }] }) });
  await f.runShadow(deps);
  assert.equal(calls.filter((c) => c === "execute").length, 0);
});

test("LIVE 餘額回非陣列（舊 data.balances 形狀）execute=0", async () => {
  const { deps, calls } = makeLiveDeps({ cfg: { valueBNB: "0.004", minProgressBps: 300, maxProgressBps: 4000, minHolders: 5, maxAgeMin: 60, maxTaxBps: 500, slippageBps: 2000, scanLast: 32, checkAfterMin: 30, minHits: 0 }, cfgAll: { paidShadow: { enabled: true, live: true } }, balance: () => ({ success: true, data: { balances: [{ binanceChainId: "56", symbol: "BNB", balance: "9" }] } }) });
  await f.runShadow(deps);
  assert.equal(calls.filter((c) => c === "execute").length, 0);
});

test("LIVE 達門檻餘額足 gate 過 execute 恰 1 次、state/flap-live.json 有該 market、notify 恰 1 次", async () => {
  const { deps, calls, S } = makeLiveDeps({ cfg: { valueBNB: "0.004", minProgressBps: 300, maxProgressBps: 4000, minHolders: 5, maxAgeMin: 60, maxTaxBps: 500, slippageBps: 2000, scanLast: 32, checkAfterMin: 30, minHits: 0 }, cfgAll: { paidShadow: { enabled: true, live: true } }, balance: () => ({ success: true, data: [{ binanceChainId: "56", symbol: "BNB", balance: "0.01" }] }) });
  await f.runShadow(deps);
  assert.equal(calls.filter((c) => c === "execute").length, 1);
  const livePath = join(S, "flap-live.json");
  assert.equal(existsSync(livePath), true);
  const live = JSON.parse(readFileSync(livePath, "utf8"));
  assert.ok(Object.keys(live.positions || {}).some((k) => k.toLowerCase() === MK.toLowerCase()));
  assert.equal(calls.filter((c) => c === "notify").length, 1);
});

test("出場 phase=1 且倍數 2x → execute 恰 1 次", async () => {
  const { deps, calls, S } = makeLiveDeps({ cfg: { valueBNB: "0.004", minProgressBps: 300, maxProgressBps: 4000, minHolders: 5, maxAgeMin: 60, maxTaxBps: 500, slippageBps: 2000, scanLast: 32, checkAfterMin: 30, minHits: 0 }, cfgAll: { paidShadow: { enabled: true, live: true } }, balance: () => ({ success: true, data: [{ binanceChainId: "56", symbol: "BNB", balance: "0.01" }] }) });
  // 先買進，建立持倉
  await f.runShadow(deps);
  const before = calls.filter((c) => c === "execute").length;
  // 設置 quoteSell 回傳倍數 2x
  deps.quoteSell = () => ({ multiple: 2.0 });
  // 需要重新讀取 detail？出場時會讀 detail，phase 仍為 1
  deps.call = (to, data) => {
    calls.push(data.slice(0, 10));
    if (data.startsWith(f.SEL.marketPage)) return page2;
    if (data.startsWith(f.SEL.marketDetail)) return F("detail-0xfd0d9e4AD5c9ddC07f68d7adF1aB9b0B20E798c4.hex");
    if (data.startsWith(f.SEL.marketSettings)) return F("settings-0xfd0d9e4AD5c9ddC07f68d7adF1aB9b0B20E798c4.hex");
    if (data.startsWith(f.SEL.quoteBuy)) return F("quotebuy-0xfd0d9e4AD5c9ddC07f68d7adF1aB9b0B20E798c4.hex");
    throw new Error("unexpected call " + data.slice(0, 10));
  };
  deps.preview = () => {
    calls.push("preview");
    return { success: true, data: { requestId: "rq2", simulationResult: { simulationCode: "000000000", balanceChanges: [{ contractAddress: NATIVE, change: 1e15 }], authorityChanges: [], allowanceChanges: [] }, risks: { riskDetails: [] }, requireConfirmation: false } };
  };
  deps.execute = () => { calls.push("execute"); return { success: true, data: { txHash: "0xdef456" } }; };
  await f.runShadow(deps);
  assert.equal(calls.filter((c) => c === "execute").length, before + 1);
});

test("出場 phase≠1 → claim execute 恰 1 次", async () => {
  const { deps, calls, S } = makeLiveDeps({ cfg: { valueBNB: "0.004", minProgressBps: 300, maxProgressBps: 4000, minHolders: 5, maxAgeMin: 60, maxTaxBps: 500, slippageBps: 2000, scanLast: 32, checkAfterMin: 30, minHits: 0 }, cfgAll: { paidShadow: { enabled: true, live: true } }, balance: () => ({ success: true, data: [{ binanceChainId: "56", symbol: "BNB", balance: "0.01" }] }) });
  await f.runShadow(deps);
  const before = calls.filter((c) => c === "execute").length;
  // phase 改成非1的 detail
  const detailPhase2 = F("detail-0xfd0d9e4AD5c9ddC07f68d7adF1aB9b0B20E798c4.hex");
  // phase 在 w[8]，簡單替換 - 但 fixture 格式固定，直接改 hex 比較麻煩；改 call 返回
  deps.call = (to, data) => {
    calls.push(data.slice(0, 10));
    if (data.startsWith(f.SEL.marketPage)) return page2;
    if (data.startsWith(f.SEL.marketDetail)) {
      // 將 phase 設為 2
      const d = detailPhase2;
      // phase 是第 9 個 word? w[8] 是 phase，index 8 * 64
      const w = f.words(d);
      // 重建
      const wordsArr = [...w];
      wordsArr[8] = 2n;
      // 簡單重組（不完全精確但 parseDetail 只讀特定位置，足夠）
      let out = "0x";
      // 需要保留原格式結構，直接構造
      // 但快速做法：用原始 hex 替換對應位置
      const hexStr = d.startsWith("0x") ? d.slice(2) : d;
      const before = hexStr.slice(0, 8 * 64);
      const after = hexStr.slice(9 * 64);
      const replaced = before + "0000000000000000000000000000000000000000000000000000000000000002" + after;
      return "0x" + replaced;
    }
    if (data.startsWith(f.SEL.marketSettings)) return F("settings-0xfd0d9e4AD5c9ddC07f68d7adF1aB9b0B20E798c4.hex");
    if (data.startsWith(f.SEL.quoteBuy)) return F("quotebuy-0xfd0d9e4AD5c9ddC07f68d7adF1aB9b0B20E798c4.hex");
    throw new Error("unexpected call " + data.slice(0, 10));
  };
  deps.preview = () => {
    calls.push("preview");
    return { success: true, data: { requestId: "rq3", simulationResult: { simulationCode: "000000000", balanceChanges: [{ contractAddress: "0x0000000000000000000000000000000000000000", change: 100n }], authorityChanges: [], allowanceChanges: [] }, risks: { riskDetails: [] }, requireConfirmation: false } };
  };
  deps.execute = () => { calls.push("execute"); return { success: true, data: { txHash: "0xghi789" } }; };
  await f.runShadow(deps);
  assert.equal(calls.filter((c) => c === "execute").length, before + 1);
});
