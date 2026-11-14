// src/signal-shadow.mjs：虛擬帳、去重、白名單、報價與出場算式（假 deps，不 spawn 任何程式）
import { test } from "node:test";
import assert from "node:assert/strict";
import { runOnce, readOnlyBaw, parseTaxInfo, encTaxInfo } from "../src/signal-shadow.mjs";
import { toWei } from "../src/autotrade.mjs";
import { parseRows } from "../bin/shadow-verdict.mjs";

const NOW = 1794662374000;
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const TOK = "0x51005189b0596646f4e8720b9eb2eab1d0ba7777";
const SV = "s1@v1";
const CFG = { version: "v1", strategies: [], perBNB: "0.002", capitalBNB: "0.0419", reserveBNB: "0.003", maxOpen: 3, deadlineH: 72, haircutBps: 300, gasWei: "50000000000000" };
const SELL = { tiers: [{ x: 2, bps: 5000 }], stopLossX: 0.5, maxHoldH: 24, moonMaxHoldH: 168, trailPreBE: 0.4, trailPostBE: 0.6, trailConfirm: 2 };
const QTY = "142687.853855918154307075";
const GAS = 50000000000000n;

const sig = (o = {}) => ({
  signalId: o.signalId ?? 1,
  strategyId: o.strategyId ?? "s1",
  contractAddress: o.token ?? TOK,
  tokenDecimals: o.decimals ?? 18,
  tokenTag: o.tag ?? {},
});

function mk(o = {}) {
  const state = o.state ?? { v: 1, accounts: {} };
  const recs = [];
  const deps = {
    now: o.now ?? NOW,
    cfg: { ...CFG, ...(o.cfg ?? {}) },
    sellCfg: { ...SELL, ...(o.sell ?? {}) },
    baw: (args) => {
      if (args[0] === "signal" && args[1] === "list") return { success: true, data: o.signals ?? [sig()] };
      if (args[0] === "market-order" && args[1] === "quote") {
        if (o.quote) return o.quote({ args, from: args[args.indexOf("--fromToken") + 1], qty: args[args.indexOf("--fromTokenQty") + 1] });
        if (String(args[args.indexOf("--fromToken") + 1]).toLowerCase() === NATIVE) return { success: true, data: { toCoinAmount: QTY } };
        return { success: true, data: { toCoinAmount: "0.0019" } };
      }
      throw new Error(`unexpected ${args.slice(0, 2).join(" ")}`);
    },
    taxOf: o.taxOf ?? (() => ({ buyBps: 300, sellBps: 300 })),
    append: (line) => recs.push(JSON.parse(line)),
    loadState: () => state,
    saveState: () => {},
  };
  return { deps, state, recs };
}

function seeded(o = {}) {
  const entryAt = o.entryAt ?? NOW - 1000;
  const state = {
    v: 1,
    accounts: {
      [SV]: {
        cashWei: String(toWei(CFG.capitalBNB) - toWei(CFG.perBNB)),
        positions: {
          [TOK]: {
            token: TOK, signalId: 99, costWei: toWei(CFG.perBNB).toString(), qty: QTY, decimals: 18,
            entryAt, boughtAt: entryAt, kind: "shadow", peakPx: null, dropHits: 0, tierIdx: 0, soldHalf: false,
            ...(o.pos ?? {}),
          },
        },
      },
    },
  };
  return mk({ state, signals: o.signals ?? [], quote: o.quote, sell: o.sell });
}

test("命中訊號寫 entry，成本與 qty 入帳", async () => {
  const { deps, recs, state } = mk();
  await runOnce(deps);
  assert.equal(recs.length, 1);
  const e = recs[0];
  assert.equal(e.kind, "entry");
  assert.equal(e.strategyVersion, SV);
  assert.equal(e.token, TOK);
  assert.equal(e.costWei, toWei("0.002").toString());
  assert.equal(e.qty, QTY);
  assert.equal(state.accounts[SV].positions[TOK].costWei, "2000000000000000");
});

test("同 token 的第二個訊號寫 dup", async () => {
  const { deps, recs } = mk();
  await runOnce(deps);
  await runOnce(deps);
  const rejects = recs.filter((r) => r.kind === "reject");
  assert.equal(rejects.length, 1);
  assert.equal(rejects[0].reason, "dup");
});

test("第 4 筆同時持倉寫 full", async () => {
  const tokens = [TOK, "0x2222222222222222222222222222222222222222", "0x3333333333333333333333333333333333333333", "0x4444444444444444444444444444444444444444"];
  const { deps, recs } = mk({ signals: tokens.map((token, i) => sig({ token, signalId: i + 1 })) });
  await runOnce(deps);
  assert.equal(recs.filter((r) => r.kind === "entry").length, 3);
  const full = recs.filter((r) => r.kind === "reject" && r.reason === "full");
  assert.equal(full.length, 1);
  assert.equal(full[0].token, tokens[3]);
});

const TAXTAG = { "Token Fee": [{ tagName: "High Tax Token" }] };

test("taxVersion 關閉時 Token Fee 標籤寫 tax，不報價", async () => {
  const { deps, recs } = mk({ cfg: { taxVersion: null }, signals: [sig({ tag: TAXTAG })] });
  await runOnce(deps);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].kind, "reject");
  assert.equal(recs[0].reason, "tax");
  assert.equal(recs[0].strategyVersion, SV);
});

test("預設 Token Fee 訊號記到 @v1-tax 帳，主帳不受影響", async () => {
  const other = "0x2222222222222222222222222222222222222222";
  const { deps, recs, state } = mk({ signals: [sig({ tag: TAXTAG }), sig({ token: other, signalId: 2 })] });
  await runOnce(deps);
  const entries = recs.filter((r) => r.kind === "entry");
  assert.deepEqual(entries.map((r) => r.strategyVersion), ["s1@v1-tax", SV]);
  assert.ok(state.accounts["s1@v1-tax"].positions[TOK]);
  assert.equal(state.accounts[SV].positions[TOK], undefined);
  assert.equal(state.accounts["s1@v1-tax"].cashWei, String(toWei("0.0419") - toWei("0.002")));
});

test("tax 帳仍過往返報價守門：賣回不到一半寫 roundtrip", async () => {
  const quote = ({ from }) => (from.toLowerCase() === NATIVE ? { success: true, data: { toCoinAmount: QTY } } : { success: true, data: { toCoinAmount: "0.0009" } });
  const { deps, recs } = mk({ signals: [sig({ tag: TAXTAG })], quote });
  await runOnce(deps);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].reason, "roundtrip");
  assert.equal(recs[0].strategyVersion, "s1@v1-tax");
});

test("tax 進場把鏈上買／賣稅率存進持倉；非 tax 進場不讀稅率", async () => {
  const other = "0x2222222222222222222222222222222222222222";
  const asked = [];
  const taxOf = (t) => { asked.push(t); return { buyBps: 100, sellBps: 300 }; };
  const { deps, state } = mk({ signals: [sig({ tag: TAXTAG }), sig({ token: other, signalId: 2 })], taxOf });
  await runOnce(deps);
  const pos = state.accounts["s1@v1-tax"].positions[TOK];
  assert.equal(pos.buyTaxBps, 100);
  assert.equal(pos.sellTaxBps, 300);
  assert.deepEqual(asked, [TOK]);
  assert.equal(state.accounts[SV].positions[other].buyTaxBps, undefined);
});

test("讀不到稅率（丟錯或不合法）→ 寫 taxread，不扣現金", async () => {
  for (const taxOf of [() => { throw new Error("rpc down"); }, () => null, () => ({ buyBps: 10000, sellBps: 0 })]) {
    const { deps, recs, state } = mk({ signals: [sig({ tag: TAXTAG })], taxOf });
    await runOnce(deps);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].reason, "taxread");
    assert.equal(state.accounts["s1@v1-tax"].cashWei, String(toWei("0.0419")));
  }
});

test("出場估值扣買稅與賣稅：0.0019 × 0.97(買稅) × 0.97(haircut) × 0.97(賣稅)", async () => {
  const { deps, recs } = seeded({ entryAt: NOW - 25 * 3600 * 1000, pos: { buyTaxBps: 300, sellTaxBps: 300 } });
  await runOnce(deps);
  const ex = recs.find((r) => r.kind === "exit");
  assert.ok(ex, "要出場");
  assert.equal(ex.estProceedsWei, "1734078700000000");
});

test("parseTaxInfo 取第 5、6 個 word；長度不足或非 hex 回 null", () => {
  const w = (n) => BigInt(n).toString(16).padStart(64, "0");
  const hex = `0x${[1, 2, 3, 4, 250, 450].map(w).join("")}${w(0).repeat(14)}`;
  assert.deepEqual(parseTaxInfo(hex), { buyBps: 250, sellBps: 450 });
  assert.equal(parseTaxInfo(`0x${w(0).repeat(5)}`), null);
  assert.equal(parseTaxInfo("0xzz"), null);
  assert.equal(encTaxInfo("0xABC"), `0x6c06b371${"abc".padStart(64, "0")}`);
});

test("taxVersion 等於 version → runOnce 丟錯", async () => {
  const { deps } = mk({ cfg: { taxVersion: "v1" } });
  await assert.rejects(runOnce(deps), /taxVersion/);
});

test("現金不足寫 cash", async () => {
  const { deps, recs } = mk({ cfg: { capitalBNB: "0.004" } });
  await runOnce(deps);
  assert.equal(recs[0].kind, "reject");
  assert.equal(recs[0].reason, "cash");
});

test("賣回報價低於成本一半寫 roundtrip", async () => {
  const { deps, recs } = mk({
    quote: ({ from }) => (String(from).toLowerCase() === NATIVE
      ? { success: true, data: { toCoinAmount: QTY } }
      : { success: true, data: { toCoinAmount: "0.0005" } }),
  });
  await runOnce(deps);
  assert.equal(recs[0].kind, "reject");
  assert.equal(recs[0].reason, "roundtrip");
});

test("72 小時拿不到報價寫 noquote，netWei 為負", async () => {
  const { deps, recs } = seeded({ entryAt: NOW - 73 * 3600 * 1000, quote: () => ({ success: false }) });
  await runOnce(deps);
  assert.equal(recs.length, 1);
  const x = recs[0];
  assert.equal(x.kind, "exit");
  assert.equal(x.exitReason, "noquote");
  assert.equal(x.estProceedsWei, "0");
  assert.equal(x.gasWei, String(GAS));
  assert.equal(x.netWei, String(-(toWei("0.002") + GAS)));
  assert.ok(BigInt(x.netWei) < 0n);
});

test("漲到成本出場 tp，netWei 扣折減與 gas", async () => {
  const { deps, recs } = seeded({
    quote: ({ from }) => (String(from).toLowerCase() === NATIVE
      ? { success: true, data: { toCoinAmount: QTY } }
      : { success: true, data: { toCoinAmount: "0.004" } }),
  });
  await runOnce(deps);
  assert.equal(recs.length, 1);
  const x = recs[0];
  assert.equal(x.kind, "exit");
  assert.equal(x.exitReason, "tp");
  assert.equal(x.estProceedsWei, "3880000000000000");
  assert.equal(x.netWei, "1830000000000000");
  assert.equal(BigInt(x.netWei), BigInt(x.estProceedsWei) - BigInt(x.costWei) - BigInt(x.gasWei));
});

test("signalId 寫成字串（entry 與 reject）", async () => {
  const { deps, recs } = mk({ signals: [sig({ signalId: 7 })] });
  await runOnce(deps);
  await runOnce(deps);
  const entry = recs.find((r) => r.kind === "entry");
  const reject = recs.find((r) => r.kind === "reject");
  assert.equal(typeof entry.signalId, "string");
  assert.equal(entry.signalId, "7");
  assert.equal(typeof reject.signalId, "string");
  assert.equal(reject.signalId, "7");
});

test("每個事件 append 後立刻 saveState", async () => {
  const tokens = [TOK, "0x2222222222222222222222222222222222222222", "0x3333333333333333333333333333333333333333", "0x4444444444444444444444444444444444444444"];
  const { deps, recs } = mk({ signals: tokens.map((token, i) => sig({ token, signalId: i + 1 })) });
  let saves = 0;
  deps.saveState = () => { saves += 1; };
  await runOnce(deps);
  assert.ok(recs.length >= 4);
  assert.ok(saves >= recs.length, `saveState ${saves} < events ${recs.length}`);
});

test("append 後第二次 saveState 失敗：下一輪只補寫同一事件一次，兩輪日誌可解析", async () => {
  const lines = [];
  let saved = JSON.stringify({ v: 1, accounts: {} });
  let saves = 0;
  const deps = {
    now: NOW,
    cfg: { ...CFG },
    sellCfg: { ...SELL },
    signals: [sig()],
    baw: (args) => {
      if (args[0] === "signal" && args[1] === "list") return { success: true, data: deps.signals };
      if (args[0] === "market-order" && args[1] === "quote") {
        if (String(args[args.indexOf("--fromToken") + 1]).toLowerCase() === NATIVE) {
          return { success: true, data: { toCoinAmount: QTY } };
        }
        return { success: true, data: { toCoinAmount: "0.0019" } };
      }
      throw new Error(`unexpected ${args.slice(0, 2).join(" ")}`);
    },
    append: (line) => lines.push(line),
    loadState: () => JSON.parse(saved),
    saveState: (st) => {
      saves += 1;
      if (saves === 2) throw new Error("saveState boom");
      saved = JSON.stringify(st);
    },
  };

  await assert.rejects(() => runOnce(deps), /saveState boom/);
  assert.equal(lines.length, 1);
  assert.ok(JSON.parse(saved).pending, "saveState 失敗後磁碟應保留 pending");

  deps.signals = [];
  await runOnce(deps);
  assert.equal(lines.length, 2, "恢復輪只補寫一次");
  assert.equal(lines[0], lines[1], "補寫內容與原事件相同");

  const rows = parseRows(lines.join("\n"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "entry");
});

test("改 cfg.gasWei 後舊帳戶出場仍用舊 gasWei", async () => {
  const m = mk({ signals: [sig()] });
  await runOnce(m.deps);
  const acct = m.state.accounts[SV];
  assert.equal(acct.params.gasWei, CFG.gasWei);
  acct.positions[TOK].entryAt = NOW - 73 * 3600 * 1000;
  const recs2 = [];
  const deps2 = {
    ...m.deps,
    cfg: { ...CFG, gasWei: "123456789" },
    now: NOW,
    baw: (args) => {
      if (args[0] === "signal" && args[1] === "list") return { success: true, data: [] };
      if (args[0] === "market-order" && args[1] === "quote") return { success: false };
      throw new Error(`unexpected ${args.slice(0, 2).join(" ")}`);
    },
    append: (line) => recs2.push(JSON.parse(line)),
    saveState: () => {},
  };
  await runOnce(deps2);
  const exit = recs2.find((r) => r.kind === "exit");
  assert.equal(exit.gasWei, String(GAS));
  assert.notEqual(exit.gasWei, "123456789");
});

test("signal list success:false 讓 runOnce 丟錯", async () => {
  const { deps } = mk();
  deps.baw = () => ({ success: false });
  await assert.rejects(() => runOnce(deps), /signal list/);
  const { deps: d2 } = mk();
  d2.baw = () => ({ success: true, data: {} });
  await assert.rejects(() => runOnce(d2), /signal list/);
});

test("進場後現金減 perBNB", async () => {
  const { deps, state } = mk();
  await runOnce(deps);
  const expected = toWei(CFG.capitalBNB) - toWei(CFG.perBNB);
  assert.equal(state.accounts[SV].cashWei, String(expected));
});

test("出場後現金加回 estProceeds−gas", async () => {
  const { deps, state } = seeded({
    quote: ({ from }) => (String(from).toLowerCase() === NATIVE
      ? { success: true, data: { toCoinAmount: QTY } }
      : { success: true, data: { toCoinAmount: "0.004" } }),
  });
  const before = BigInt(state.accounts[SV].cashWei);
  await runOnce(deps);
  const expected = before + 3880000000000000n - GAS;
  assert.equal(state.accounts[SV].cashWei, String(expected));
  assert.deepEqual(state.accounts[SV].positions, {});
});

test("白名單外呼叫丟 not allowed", () => {
  const baw = readOnlyBaw(() => ({ success: true }));
  assert.deepEqual(baw(["signal", "list", "--json"]), { success: true });
  assert.deepEqual(baw(["market-order", "quote", "--json"]), { success: true });
  assert.throws(() => baw(["market-order", "swap"]), /not allowed/);
  assert.throws(() => baw(["contract-call", "preview"]), /not allowed/);
});
