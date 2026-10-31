// src/autotrade.mjs 錢路徑：門檻、閘、帳本預扣、每輪 1 筆、賣出規則、approve 只准 Core
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOnce, screen, decide, sellGate, approveGate, toWei, fromWei, DEFAULTS } from "../src/autotrade.mjs";

const T = "0x2754803efccc7d808bba1a120cbfcbab80feffff";
const T2 = "0x3333333333333333333333333333333333333333";
const CORE = "0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3";
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const NOW = 1793150000000;
const row = (o = {}) => ({ contractAddress: T, symbol: "4Agent", holders: 20, progress: "5", devPosition: 1, createTime: NOW - 30 * 60000, ...o });
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
  const rows = [0, 1, 2, 3, 4].map((i) => row({ contractAddress: `0x${String(i).repeat(40)}` }));
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

test("賣出規則：2 倍賣一半、跌半全賣、超時全賣", () => {
  const c = DEFAULTS.sell;
  const pos = { costWei: "3000000000000000", boughtAt: NOW, soldHalf: false };
  assert.deepEqual(decide(pos, 6000000000000000n, c, NOW)[0], "half");
  assert.deepEqual(decide({ ...pos, soldHalf: true }, 6000000000000000n, c, NOW)[0], null);
  assert.deepEqual(decide(pos, 1500000000000000n, c, NOW)[0], "all");
  assert.deepEqual(decide(pos, 3000000000000000n, c, NOW)[0], null);
  assert.deepEqual(decide(pos, null, c, NOW + 24 * 3600e3)[0], "all");
  assert.deepEqual(decide(pos, null, c, NOW)[0], null);
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
