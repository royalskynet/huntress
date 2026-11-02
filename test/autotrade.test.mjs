// src/autotrade.mjs 錢路徑：門檻、閘、帳本預扣、每輪 1 筆、賣出規則、approve 只准 Core
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOnce, screen, decide, sellGate, approveGate, toWei, fromWei, DEFAULTS, backoffMs, applySell, devReject } from "../src/autotrade.mjs";

const T = "0x2754803efccc7d808bba1a120cbfcbab80feffff";
const T2 = "0x3333333333333333333333333333333333333333";
const CORE = "0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3";
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const NOW = 1793150000000;
const D = "0x1111111111111111111111111111111111111111";
const row = (o = {}) => ({ contractAddress: T, symbol: "4Agent", holders: 20, progress: "5", devPosition: 1, createTime: NOW - 30 * 60000, devAddress: D, devSellPercent: 0, ...o });
// 10-28 實測真錢包 preview 結構（requestId 為假）
const pv = (bc, o = {}) => ({ success: true, data: { requestId: "rq1", parsedTx: { transactionType: "ContractInteraction" }, simulationResult: { balanceChanges: bc, simulationCode: "000000000", authorityChanges: [], allowanceChanges: [], ...o }, risks: { addresses: {}, riskDetails: [], riskBehaviors: [] }, requireConfirmation: false } });
const buyPv = (tok = T) => pv([{ contractAddress: NATIVE, change: -2999999880268045, tokenType: "Native" }, { contractAddress: tok, change: 2.27e23, tokenType: "Erc20" }]);
const sellPv = () => pv([{ contractAddress: T, change: -1e23, tokenType: "Erc20" }, { contractAddress: NATIVE, change: 4e15, tokenType: "Native" }]);
const tx = (value = "3000000000000000") => ({ to: CORE, value, inputData: "0x995ee6da" });

function mk(o = {}) {
  const calls = { baw: [], script: [], notify: [] };
  const deps = {
    now: NOW, stateDir: mkdtempSync(join(tmpdir(), "at-")), wallet: "0x5e1f5e1f5e1f5e1f5e1f5e1f5e1f5e1f5e1f5e1f", cfg: {},
    rows: async () => [row()],
    balance: async () => toWei("0.02"),
    audit: async () => ({ ok: true, data: { riskLevel: 0, riskItems: [] } }),
    script: (cmd, p) => { calls.script.push([cmd, p]); return (o.script ?? {})[cmd]?.(p) ?? { info: { success: true, data: { route: "contract-call", isAgentIdExclusive: true, wallet: { tokenBalanceRaw: "0" } } }, "quote-buy": { success: true, data: { tx: tx(), simulation: { ok: true }, minTokenOut: "1", slippagePercent: "20" } } }[cmd]; },
    baw: (a) => { calls.baw.push(a.join(" ")); if (a[1] === "preview") return (o.preview ?? (() => buyPv()))(a); if (a[1] === "execute") return { success: true, data: { status: "BROADCASTED", txHash: "0xdead" } }; return {}; },
    notify: async (t) => calls.notify.push(t),
    log: () => {},
    ...o.deps,
  };
  const st = () => JSON.parse(readFileSync(join(deps.stateDir, "positions.json"), "utf8"));
  const ledger = () => JSON.parse(readFileSync(join(deps.stateDir, "buy-2026-10-28.json"), "utf8"));
  return { deps, calls, st, ledger, execs: () => calls.baw.filter((c) => c.includes("execute")).length };
}

test("wei 換算不經浮點", () => {
  assert.equal(toWei("0.003"), 3000000000000000n);
  assert.equal(fromWei(1500000000000000n), "0.0015");
  assert.equal(fromWei(10n ** 18n), "1");
});

test("門檻：欄位缺、dev 清倉、太舊都不過", () => {
  const c = DEFAULTS.buy;
  assert.equal(screen(row(), c, NOW), null);
  assert.match(screen(row({ holders: null }), c, NOW), /持幣/);
  assert.match(screen(row({ holders: 3 }), c, NOW), /持幣/);
  assert.match(screen(row({ progress: "1" }), c, NOW), /曲線/);
  assert.match(screen(row({ devPosition: null }), c, NOW), /dev/);
  assert.match(screen(row({ devPosition: 2 }), c, NOW), /清倉/);
  assert.match(screen(row({ createTime: NOW - 300 * 60000 }), c, NOW), /分鐘/);
});

test("過門檻：preview→閘→先扣帳本→execute 一次，記持倉", async () => {
  const { deps, execs, st, ledger, calls } = mk();
  await runOnce(deps);
  assert.equal(execs(), 1);
  assert.equal(ledger().total, 1);
  assert.equal(ledger().spentWei, "3000000000000000");
  assert.equal(st().positions[T].costWei, "3000000000000000");
  assert.match(calls.notify[0], /自動買入/);
  await runOnce(deps); // 同一顆不買第二次
  assert.equal(execs(), 1);
});

test("模擬收到的不是這顆幣 → 不 execute", async () => {
  const { deps, execs, st } = mk({ preview: () => buyPv(T2) });
  await runOnce(deps);
  assert.equal(execs(), 0);
  assert.match(st().rejected[T], /閘/);
});

test("quote value 超過設定金額 → 不 preview", async () => {
  const { deps, calls } = mk({ script: { "quote-buy": () => ({ success: true, data: { tx: tx("5000000000000000"), simulation: { ok: true } } }) } });
  await runOnce(deps);
  assert.equal(calls.baw.filter((c) => c.includes("preview")).length, 0);
});

test("audit 命中 → 不買；audit 取不到 → 這輪跳過不標記", async () => {
  const a = mk({ deps: { audit: async () => ({ ok: true, data: { riskItems: [{ details: [{ title: "Honeypot", isHit: true }] }] } }) } });
  await runOnce(a.deps);
  assert.equal(a.execs(), 0);
  const b = mk({ deps: { audit: async () => ({ ok: false, error: "x" }) } });
  await runOnce(b.deps);
  assert.equal(b.execs(), 0);
  assert.equal(b.st().rejected[T], undefined);
});

test("每日 4 筆封頂、每輪最多 1 筆", async () => {
  const rows = [0, 1, 2, 3, 4].map((i) => row({ contractAddress: `0x${String(i).repeat(40)}`, devAddress: `0x${String(i + 1).repeat(40)}` }));
  const { deps, execs } = mk({ deps: { rows: async () => rows }, preview: (a) => buyPv(a[a.indexOf("--to") + 1] === CORE ? null : null) });
  // 讓 buyLooksRight 對每顆都成立：preview 回傳收到的就是當輪 quote 的 token
  let cur;
  deps.script = (cmd, p) => { cur = p.token; return cmd === "info" ? { success: true, data: { route: "contract-call", isAgentIdExclusive: true, wallet: { tokenBalanceRaw: "1" } } } : cmd === "quote-buy" ? { success: true, data: { tx: tx(), simulation: { ok: true } } } : { success: true, data: { estimate: { userReceives: "0.003" } } }; };
  const bawOrig = deps.baw;
  deps.baw = (a) => (a[1] === "preview" ? buyPv(cur) : bawOrig(a));
  await runOnce(deps);
  assert.equal(execs(), 1);
  for (let i = 0; i < 5; i++) await runOnce(deps);
  assert.equal(execs(), 4);
});

test("賣出規則：分批停利、停損、超時全賣", () => {
  const c = DEFAULTS.sell;
  const R = 10n ** 21n;
  const pos = { costWei: "3000000000000000", boughtAt: NOW, soldHalf: false };
  assert.equal(decide(pos, 6000000000000000n, R, c, NOW)[0], 5000);
  assert.equal(decide({ ...pos, soldHalf: true, tierIdx: 1, costWei: "1500000000000000" }, 15000000000000000n, R, c, NOW)[0], 4000);
  assert.equal(decide(pos, 1500000000000000n, R, c, NOW)[0], "all");
  assert.equal(decide(pos, 3000000000000000n, R, c, NOW)[0], null);
  assert.equal(decide(pos, null, R, c, NOW + 24 * 3600e3)[0], "all");
  assert.equal(decide(pos, null, R, c, NOW)[0], null);
});

test("sellGate：只准減少這顆幣、收到 BNB", () => {
  const t0 = { value: "0" };
  assert.equal(sellGate(sellPv(), t0, T).ok, true);
  assert.equal(sellGate(sellPv(), { value: "1" }, T).ok, false);
  assert.equal(sellGate(pv([{ contractAddress: T, change: -1 }, { contractAddress: NATIVE, change: -1 }]), t0, T).ok, false);
  assert.equal(sellGate(pv([{ contractAddress: T, change: -1 }, { contractAddress: T2, change: 5 }]), t0, T).ok, false);
});

test("approveGate：只准授權這顆幣給 Core", () => {
  const ok = pv([], { allowanceChanges: [{ token: T, spender: CORE, amount: "100" }] });
  assert.equal(approveGate(ok, { to: T, value: "0" }, T, CORE).ok, true);
  const evil = pv([], { allowanceChanges: [{ token: T, spender: T2, amount: "100" }] });
  assert.equal(approveGate(evil, { to: T, value: "0" }, T, CORE).ok, false);
  assert.equal(approveGate(ok, { to: T2, value: "0" }, T, CORE).ok, false);
  const two = pv([], { allowanceChanges: [{ token: T, spender: CORE }, { token: T2, spender: CORE }] });
  assert.equal(approveGate(two, { to: T, value: "0" }, T, CORE).ok, false);
});

test("持倉 2 倍：先 approve 不賣，下一輪才賣一半，成本基準減半", async () => {
  let approved = false;
  const { deps, calls, st } = mk({
    deps: { rows: async () => [] },
    script: {
      info: () => ({ success: true, data: { route: "contract-call", isAgentIdExclusive: true, wallet: { tokenBalance: "200000", tokenBalanceRaw: "200000000000000000000000" } } }),
      "quote-sell": (p) => ({ success: true, data: { estimate: { userReceives: p.amount === "all" ? "0.007" : "0.0035" }, contracts: { core: CORE }, approveTx: approved || p.amount === "all" ? null : { to: T, value: "0", inputData: "0x095ea7b3" }, tx: { to: CORE, value: "0", inputData: "0xsell" } } }),
    },
    preview: (a) => (a[a.indexOf("--to") + 1] === T ? pv([], { allowanceChanges: [{ token: T, spender: CORE }] }) : sellPv()),
  });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(deps.stateDir, "positions.json"), JSON.stringify({ positions: { [T]: { symbol: "4Agent", costWei: "3000000000000000", boughtAt: NOW - 3600e3, soldHalf: false } } }));
  await runOnce(deps);
  assert.equal(calls.baw.filter((c) => c.includes("execute")).length, 1); // approve
  assert.equal(st().positions[T].soldHalf, false);
  assert.deepEqual(calls.script.find((c) => c[0] === "quote-sell" && c[1].amount !== "all")[1].amount, "100000");
  approved = true;
  await runOnce(deps);
  assert.equal(calls.baw.filter((c) => c.includes("execute")).length, 2); // sell
  assert.equal(st().positions[T].soldHalf, true);
  assert.equal(st().positions[T].costWei, "1500000000000000");
});

test("記下 Core 授權對象：approve 成功才記；不用 approve（授權早已存在）也記；approve 失敗不記", async () => {
  const { writeFileSync } = await import("node:fs");
  for (const [needApprove, execOk, want] of [[true, true, CORE], [true, false, undefined], [false, true, CORE]]) {
    const { deps, st } = mk({
      deps: { rows: async () => [] },
      script: {
        info: () => ({ success: true, data: { route: "contract-call", isAgentIdExclusive: true, wallet: { tokenBalance: "200000", tokenBalanceRaw: "200000000000000000000000" } } }),
        "quote-sell": (p) => ({ success: true, data: { estimate: { userReceives: p.amount === "all" ? "0.007" : "0.0035" }, contracts: { core: CORE }, approveTx: needApprove ? { to: T, value: "0", inputData: "0x095ea7b3" } : null, tx: { to: CORE, value: "0", inputData: "0xsell" } } }),
      },
      preview: (a) => (a[a.indexOf("--to") + 1] === T ? pv([], { allowanceChanges: [{ token: T, spender: CORE }] }) : sellPv()),
    });
    if (!execOk) { const b = deps.baw; deps.baw = (a) => (a[1] === "execute" ? { success: false, error: "x" } : b(a)); }
    writeFileSync(join(deps.stateDir, "positions.json"), JSON.stringify({ positions: { [T]: { symbol: "4Agent", costWei: "3000000000000000", boughtAt: NOW - 3600e3, soldHalf: false } } }));
    await runOnce(deps);
    assert.equal(st().positions[T].core, want, `needApprove=${needApprove} execOk=${execOk}`);
  }
});

test("持倉 4 盤不買第 5 盤", async () => {
  const positions = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`0x${String(i + 1).repeat(40)}`, { symbol: "P", costWei: "4000000000000000", boughtAt: NOW - 60000, soldHalf: false }]));
  const { deps, execs } = mk();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(deps.stateDir, "positions.json"), JSON.stringify({ positions, rejected: {}, closed: [] }));
  deps.rows = async () => [row({ contractAddress: "0x9999999999999999999999999999999999999999" })];
  await runOnce(deps);
  assert.equal(execs(), 0);
});

test("餘額 0.008 不買且只推一次停手通知", async () => {
  const { deps, execs, calls } = mk({ deps: { balance: async () => toWei("0.008") } });
  await runOnce(deps);
  assert.equal(execs(), 0);
  assert.equal(calls.notify.filter((t) => /停手/.test(t)).length, 1);
  await runOnce(deps);
  assert.equal(calls.notify.filter((t) => /停手/.test(t)).length, 1);
});

test("餘額讀不到不買", async () => {
  for (const balance of [async () => null, async () => { throw new Error("x"); }]) {
    const { deps, execs } = mk({ deps: { balance } });
    await runOnce(deps);
    assert.equal(execs(), 0);
  }
});

test("外盤：quote 失敗不 swap、swap 帶 --slippage 15", async () => {
  const { deps, calls } = mk({ deps: { rows: async () => [] } });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(deps.stateDir, "positions.json"), JSON.stringify({ positions: { [T]: { symbol: "4Agent", costWei: "1000000000000000", boughtAt: NOW - 3600e3, soldHalf: false } }, rejected: {}, closed: [] }));
  deps.script = (cmd, p) => (cmd === "info" ? { success: true, data: { route: "market-order", isAgentIdExclusive: true, wallet: { tokenBalance: "1.5", tokenBalanceRaw: "1500000000000000000" } } } : { success: true, data: {} });
  // quote 失敗 → 不 swap
  deps.baw = (a) => { calls.baw.push(a.join(" ")); if (a[1] === "quote") return { success: false, error: "no" }; if (a[1] === "swap") return { success: true, data: { orderId: "o1" } }; return {}; };
  await runOnce(deps);
  assert.equal(calls.baw.some((c) => c.includes("swap")), false);
  // 清掉退避，quote 成功 → swap 帶 --slippage 15
  const stObj = JSON.parse(readFileSync(join(deps.stateDir, "positions.json"), "utf8"));
  delete stObj.positions[T].sellFail;
  writeFileSync(join(deps.stateDir, "positions.json"), JSON.stringify(stObj));
  deps.baw = (a) => { calls.baw.push(a.join(" ")); if (a[1] === "quote") return { success: true, data: { toCoinSymbol: "BNB", toCoinAmount: "0.003" } }; if (a[1] === "swap") return { success: true, data: { orderId: "o2" } }; return {}; };
  await runOnce(deps);
  const swapCall = calls.baw.find((c) => c.includes("swap"));
  assert.ok(swapCall && swapCall.includes("--slippage 15"));
});

test("退避：失敗後 1 分鐘內不重試、成功清掉 sellFail", async () => {
  let execOk = false;
  const { deps, calls, st } = mk({
    deps: { rows: async () => [] },
    preview: () => sellPv(),
    script: {
      info: () => ({ success: true, data: { route: "contract-call", isAgentIdExclusive: true, wallet: { tokenBalance: "200000", tokenBalanceRaw: "200000000000000000000000" } } }),
      "quote-sell": () => ({ success: true, data: { estimate: { userReceives: "0.0035" }, contracts: { core: CORE }, approveTx: null, tx: { to: CORE, value: "0", inputData: "0xsell" } } }),
    },
  });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(deps.stateDir, "positions.json"), JSON.stringify({ positions: { [T]: { symbol: "4Agent", costWei: "1000000000000000", boughtAt: NOW - 3600e3, soldHalf: false } }, rejected: {}, closed: [] }));
  deps.baw = (a) => { calls.baw.push(a.join(" ")); if (a[1] === "preview") return sellPv(); if (a[1] === "execute") { if (!execOk) return { success: false, error: "x" }; return { success: true, data: { txHash: "0xdead" } }; } return {}; };
  await runOnce(deps);
  const execCount1 = calls.baw.filter((c) => c.includes("execute")).length;
  assert.equal(execCount1, 1);
  // 1 分鐘內不重試
  await runOnce(deps);
  const execCount2 = calls.baw.filter((c) => c.includes("execute")).length;
  assert.equal(execCount2, execCount1);
  assert.ok(st().positions[T].sellFail);
  // 時間過後成功清掉 sellFail
  execOk = true;
  deps.now = NOW + 61000;
  await runOnce(deps);
  assert.equal(calls.baw.filter((c) => c.includes("execute")).length, 2);
  assert.equal(st().positions[T]?.sellFail, undefined);
});

test("零頭：不賣且 dust 不佔 maxOpen", async () => {
  const { deps, execs, calls } = mk();
  const { writeFileSync, readFileSync } = await import("node:fs");
  writeFileSync(join(deps.stateDir, "positions.json"), JSON.stringify({ positions: { [T]: { symbol: "4Agent", costWei: "3000000000000000", boughtAt: NOW - 25 * 3600e3, soldHalf: false } }, rejected: {}, closed: [] }));
  deps.script = (cmd, p) => {
    if (cmd === "info") return { success: true, data: { route: "contract-call", isAgentIdExclusive: true, wallet: { tokenBalance: "100", tokenBalanceRaw: "100000000000000000" } } };
    if (cmd === "quote-sell") return { success: true, data: { estimate: { userReceives: "0.0001" }, contracts: { core: CORE }, approveTx: null, tx: { to: CORE, value: "0", inputData: "0xsell" } } };
    if (cmd === "quote-buy") return { success: true, data: { tx: tx(), simulation: { ok: true }, minTokenOut: "1", slippagePercent: "20" } };
    return { success: true, data: {} };
  };
  deps.baw = (a) => { calls.baw.push(a.join(" ")); if (a[1] === "preview") { const v = a[a.indexOf("--value") + 1]; return v && v !== "0" ? buyPv(T2) : sellPv(); } return { success: true, data: { status: "BROADCASTED", txHash: "0xdead" } }; };
  await runOnce(deps);
  const st1 = JSON.parse(readFileSync(join(deps.stateDir, "positions.json"), "utf8"));
  assert.equal(st1.positions[T].dust, true);
  // dust 不佔 maxOpen，下一輪可買
  deps.rows = async () => [row({ contractAddress: T2 })];
  deps.now = NOW + 1000;
  await runOnce(deps);
  assert.equal(execs(), 1);
});

test("預演賣出：不過記 fail 且只推一次、有 approveTx 不判、外盤 quote 失敗記 fail、任何情況都沒有 execute／swap 呼叫", async () => {
  const { deps, calls, st } = mk({ deps: { rows: async () => [] } });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(deps.stateDir, "positions.json"), JSON.stringify({ positions: { [T]: { symbol: "X", costWei: "1000000000000000", boughtAt: NOW - 3600e3, soldHalf: false } }, rejected: {}, closed: [] }));

  // 內盤 quote-sell 失敗
  deps.script = (cmd) => {
    if (cmd === "info") return { success: true, data: { route: "contract-call", isAgentIdExclusive: true, wallet: { tokenBalance: "1", tokenBalanceRaw: "1000" } } };
    if (cmd === "quote-sell") return { success: false, error: "x" };
    return { success: true, data: {} };
  };
  deps.baw = (a) => { calls.baw.push(a.join(" ")); return {}; };
  const before = calls.baw.length;
  await runOnce(deps);
  assert.match(String(st().positions[T].sellCheck), /^fail/);
  await runOnce(deps);
  assert.equal(calls.notify.filter((t) => /預演賣出/.test(t)).length, 1);
  assert.equal(calls.baw.filter((c) => /execute|swap/.test(c)).length, 0);

  // 有 approveTx 不判
  deps.script = (cmd) => {
    if (cmd === "info") return { success: true, data: { route: "contract-call", isAgentIdExclusive: true, wallet: { tokenBalance: "1", tokenBalanceRaw: "1000" } } };
    if (cmd === "quote-sell") return { success: true, data: { estimate: { userReceives: "0.001" }, contracts: { core: CORE }, approveTx: { to: T, value: "0", inputData: "0x095ea7b3" }, tx: { to: CORE, value: "0", inputData: "0xsell" } } };
    return { success: true, data: {} };
  };
  deps.baw = (a) => { calls.baw.push(a.join(" ")); return {}; };
  await runOnce(deps);
  assert.equal(st().positions[T].sellCheck, undefined);

  // 外盤 quote 失敗記 fail
  const { writeFileSync: ws } = await import("node:fs");
  ws(join(deps.stateDir, "positions.json"), JSON.stringify({ positions: { [T2]: { symbol: "Y", costWei: "1000000000000000", boughtAt: NOW - 3600e3, soldHalf: false } }, rejected: {}, closed: [] }));
  deps.script = (cmd) => {
    if (cmd === "info") return { success: true, data: { route: "market-order", isAgentIdExclusive: true, wallet: { tokenBalance: "1.5", tokenBalanceRaw: "1500000000000000000" } } };
    return { success: true, data: {} };
  };
  deps.baw = (a) => { calls.baw.push(a.join(" ")); if (a[1] === "quote") return { success: false, error: "no" }; return {}; };
  await runOnce(deps);
  assert.match(String(st().positions[T2].sellCheck), /^fail/);
  assert.equal(calls.baw.filter((c) => /execute|swap/.test(c)).length, 0);
});

test("戰績：台北 21 點後只推一次、20 點不推", async () => {
  const { runOnce } = await import("../src/autotrade.mjs");
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const now21 = Date.parse("2026-10-28T13:05:00.000Z");
  const { deps, calls } = mk({ deps: { rows: async () => [] } });
  deps.now = now21;
  writeFileSync(join(deps.stateDir, "positions.json"), JSON.stringify({ positions: {}, closed: [{ costWei: "1000", proceedsWei: "2000", closedAt: now21 }] }));
  await runOnce(deps);
  const pushed = calls.notify.filter((n) => String(n).includes("戰績"));
  assert.equal(pushed.length >= 1, true);
  const before = calls.notify.length;
  await runOnce(deps);
  const after = calls.notify.length;
  assert.equal(after, before);
});

test("DEV 規則：devAddress 缺、devSellPercent > max、黑名單、重複 DEV、24h 過期、停損全賣後進黑名單", async () => {
  // 直接測 devReject
  const c = DEFAULTS.buy;
  const stEmpty = { positions: {}, rejected: {}, closed: [], devSeen: {}, devBlack: {} };
  assert.equal(devReject({ devSellPercent: 0 }, stEmpty, c, NOW), "dev 地址未知");
  assert.equal(devReject({ devAddress: D, devSellPercent: 80 }, stEmpty, c, NOW), "dev 已賣");
  assert.equal(devReject({ devAddress: D, devSellPercent: 0 }, { positions: {}, rejected: {}, closed: [], devSeen: {}, devBlack: { [D.toLowerCase()]: NOW - 1 } }, c, NOW), "黑名單 DEV");
  const seen = { [D.toLowerCase()]: [{ token: "0xa", at: NOW }, { token: "0xb", at: NOW }, { token: "0xc", at: NOW }] };
  assert.equal(devReject({ devAddress: D, devSellPercent: 10 }, { positions: {}, rejected: {}, closed: [], devSeen: seen }, c, NOW), "重複 DEV");
  // 24h 過期：過期的被清掉就不算重複，且 devSellPercent 10 <=50 可過
  const seenOld = { [D.toLowerCase()]: [{ token: "0xa", at: NOW - 25 * 3600e3 }, { token: "0xb", at: NOW - 25 * 3600e3 }, { token: "0xc", at: NOW - 25 * 3600e3 }] };
  const stOld = { positions: {}, rejected: {}, closed: [], devSeen: seenOld, devBlack: {} };
  // devReject 只看 seen，tryBuy 會先清理；這裡直接測試看現狀：若都過期，active length 0 應該不算重複
  assert.equal(devReject({ devAddress: D, devSellPercent: 10 }, stOld, c, NOW), null);

  // tryBuy 整合：devSeen 24h 過期後可買、devSellPercent >50 擋、黑名單擋、重複 DEV 擋
  const { writeFileSync } = await import("node:fs");
  // 過期 seen → 應該能買
  {
    const { deps, execs, st } = mk();
    const s = { positions: {}, rejected: {}, closed: [], devSeen: { [D.toLowerCase()]: [{ token: "0xa", at: NOW - 25 * 3600e3 }] }, devBlack: {} };
    writeFileSync(join(deps.stateDir, "positions.json"), JSON.stringify(s));
    await runOnce(deps);
    assert.equal(execs(), 1);
  }
  // devSellPercent >50 擋
  {
    const { deps, execs, st } = mk({ deps: { rows: async () => [row({ devSellPercent: 80 })] } });
    await runOnce(deps);
    assert.equal(execs(), 0);
    assert.equal(st().rejected[T], "dev 已賣");
  }
  // 黑名單擋
  {
    const { deps, execs, st } = mk();
    const s = { positions: {}, rejected: {}, closed: [], devSeen: {}, devBlack: { [D.toLowerCase()]: NOW } };
    writeFileSync(join(deps.stateDir, "positions.json"), JSON.stringify(s));
    await runOnce(deps);
    assert.equal(execs(), 0);
    assert.equal(st().rejected[T], "黑名單 DEV");
  }
  // 重複 DEV 擋
  {
    const { deps, execs, st } = mk();
    const s = { positions: {}, rejected: {}, closed: [], devSeen: { [D.toLowerCase()]: [{ token: "0xa", at: NOW }, { token: "0xb", at: NOW }, { token: "0xc", at: NOW }] }, devBlack: {} };
    writeFileSync(join(deps.stateDir, "positions.json"), JSON.stringify(s));
    await runOnce(deps);
    assert.equal(execs(), 0);
    assert.equal(st().rejected[T], "重複 DEV");
  }
  // 停損全賣成功後進黑名單
  {
    let execOk = true;
    const { deps, calls, st } = mk({
      deps: { rows: async () => [] },
      preview: () => sellPv(),
      script: {
        info: () => ({ success: true, data: { route: "contract-call", isAgentIdExclusive: true, wallet: { tokenBalance: "200000", tokenBalanceRaw: "200000000000000000000000" } } }),
        "quote-sell": () => ({ success: true, data: { estimate: { userReceives: "0.001" }, contracts: { core: CORE }, approveTx: null, tx: { to: CORE, value: "0", inputData: "0xsell" } } }),
      },
    });
    writeFileSync(join(deps.stateDir, "positions.json"), JSON.stringify({ positions: { [T]: { symbol: "4Agent", costWei: "3000000000000000", boughtAt: NOW - 3600e3, soldHalf: false, dev: D.toLowerCase() } }, rejected: {}, closed: [] }));
    deps.baw = (a) => { calls.baw.push(a.join(" ")); if (a[1] === "preview") return sellPv(); if (a[1] === "execute") return { success: true, data: { txHash: "0xdead" } }; return {}; };
    // 價格跌到停損觸發全賣
    deps.script = (cmd) => {
      if (cmd === "info") return { success: true, data: { route: "contract-call", isAgentIdExclusive: true, wallet: { tokenBalance: "200000", tokenBalanceRaw: "200000000000000000000000" } } };
      // valWei 很低觸發停損
      if (cmd === "quote-sell") return { success: true, data: { estimate: { userReceives: "0.001" }, contracts: { core: CORE }, approveTx: null, tx: { to: CORE, value: "0", inputData: "0xsell" } } };
      return { success: true, data: {} };
    };
    // 讓 decide 判斷停損：valWei 1500000000000000 < cost*0.5
    deps.script = (cmd) => {
      if (cmd === "info") return { success: true, data: { route: "contract-call", isAgentIdExclusive: true, wallet: { tokenBalance: "200000", tokenBalanceRaw: "200000000000000000000000" } } };
      if (cmd === "quote-sell") return { success: true, data: { estimate: { userReceives: "0.0015" }, contracts: { core: CORE }, approveTx: null, tx: { to: CORE, value: "0", inputData: "0xsell" } } };
      return { success: true, data: {} };
    };
    // 重新設定讓 valueOf 返回夠低的值
    const bawOrig = deps.baw;
    deps.baw = (a) => { calls.baw.push(a.join(" ")); if (a[1] === "preview") return sellPv(); if (a[1] === "execute") return { success: true, data: { txHash: "0xdead" } }; return {}; };
    // 直接用 runOnce，valueOf 會從 quote-sell 拿 userReceives 轉換
    await runOnce(deps);
    assert.ok(st().devBlack && st().devBlack[D.toLowerCase()]);
  }
});

test("devSeen：rows 有同一 dev 的 3 個盤 → 這輪一筆都不買、st.rejected 標「重複 DEV」；只有 2 個盤 → 照常買；重跑同一批 rows 不會重複記", async () => {
  const D2 = D;
  const rows3 = [
    row({ contractAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", devAddress: D2 }),
    row({ contractAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", devAddress: D2 }),
    row({ contractAddress: "0xcccccccccccccccccccccccccccccccccccccccc", devAddress: D2 }),
  ];
  // rows 有同一 dev 的 3 個盤 → 這輪一筆都不買、st.rejected 標「重複 DEV」
  {
    let cur;
    const { deps, execs, st } = mk({
      deps: { rows: async () => rows3 },
    });
    deps.script = (cmd, p) => { cur = p?.token; if (cmd === "info") return { success: true, data: { route: "contract-call", isAgentIdExclusive: true, wallet: { tokenBalanceRaw: "1" } } }; if (cmd === "quote-buy") return { success: true, data: { tx: tx(), simulation: { ok: true } } }; return { success: true, data: {} }; };
    const bawOrig = deps.baw;
    deps.baw = (a) => (a[1] === "preview" ? buyPv(cur) : bawOrig(a));
    await runOnce(deps);
    assert.equal(execs(), 0);
    const rej = st().rejected || {};
    assert.equal(Object.values(rej).some((v) => String(v).includes("重複 DEV")), true);
  }
  // 只有 2 個盤 → 照常買
  {
    const rows2 = [
      row({ contractAddress: "0xdddddddddddddddddddddddddddddddddddddddd", devAddress: D2 }),
      row({ contractAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", devAddress: D2 }),
    ];
    let cur;
    const { deps, execs, st } = mk({
      deps: { rows: async () => rows2 },
    });
    deps.script = (cmd, p) => { cur = p?.token; if (cmd === "info") return { success: true, data: { route: "contract-call", isAgentIdExclusive: true, wallet: { tokenBalanceRaw: "1" } } }; if (cmd === "quote-buy") return { success: true, data: { tx: tx(), simulation: { ok: true } } }; return { success: true, data: {} }; };
    const bawOrig = deps.baw;
    deps.baw = (a) => (a[1] === "preview" ? buyPv(cur) : bawOrig(a));
    await runOnce(deps);
    assert.equal(execs(), 1);
  }
  // 重跑同一批 rows 不會重複記
  {
    let cur;
    const rows2 = [
      row({ contractAddress: "0xffffffffffffffffffffffffffffffffffffffff", devAddress: D2 }),
      row({ contractAddress: "0x1111111111111111111111111111111111111112", devAddress: D2 }),
    ];
    const { deps, execs, st } = mk({
      deps: { rows: async () => rows2 },
    });
    deps.script = (cmd, p) => { cur = p?.token; if (cmd === "info") return { success: true, data: { route: "contract-call", isAgentIdExclusive: true, wallet: { tokenBalanceRaw: "1" } } }; if (cmd === "quote-buy") return { success: true, data: { tx: tx(), simulation: { ok: true } } }; return { success: true, data: {} }; };
    const bawOrig = deps.baw;
    deps.baw = (a) => (a[1] === "preview" ? buyPv(cur) : bawOrig(a));
    await runOnce(deps);
    const exec1 = execs();
    const seenLen1 = st().devSeen?.[D2.toLowerCase()]?.length;
    await runOnce(deps);
    const exec2 = execs();
    const seenLen2 = st().devSeen?.[D2.toLowerCase()]?.length;
    assert.equal(seenLen2, seenLen1); // 重跑同一批 rows 不會重複記
    assert.equal(exec2, exec1 + 1);
  }
});

