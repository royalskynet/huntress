import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as f from "../src/flap.mjs";

const F = (n) => readFileSync(join(process.cwd(), "test/fixtures/flap", n), "utf8").trim();
const MK = "0xfd0d9e4ad5c9ddc07f68d7adf1ab9b0b20e798c4";
const GR = "0xaacb16af918a1d63b666109eb6b89090412f4968";
const UQ = "0x936fc3208a5007a1fa31eaa1098ea9171869d124";
const fx = (k, m) => F(`${k}-${m === MK ? "0xfd0d9e4AD5c9ddC07f68d7adF1aB9b0B20E798c4" : m === GR ? "0xAACB16aF918a1D63B666109Eb6b89090412F4968" : "0x936fc3208A5007A1fa31EAa1098ea9171869D124"}.hex`);

test("words throws on bad length", () => {
  assert.throws(() => f.words("0x1234"));
});

test("parseDetail decodes MK fixture", () => {
  const d = f.parseDetail(fx("detail", MK));
  assert.equal(d.quoteToken, "0x0000000000000000000000000000000000000000");
  assert.equal(d.progressBps, 826);
  assert.equal(d.phase, 1);
  assert.equal(d.holders, 13);
  assert.equal(d.startBlock, 129338926);
});

test("parseDetail throws short", () => {
  assert.throws(() => f.parseDetail("0x1234"));
});

test("parseSettings decodes MK", () => {
  const s = f.parseSettings(fx("settings", MK));
  assert.deepEqual([s.buyTaxBps, s.sellTaxBps, s.maxWalletBps], [100, 100, 200]);
});

test("parseSettings UQ quoteToken", () => {
  assert.equal(f.parseSettings(fx("settings", UQ)).quoteToken, "0x4902c5ebc598265ed2212b559b042de8a5eeec3f"); // gitleaks:allow 公開代幣合約地址
});

test("parseQuote decodes", () => {
  const q = f.parseQuote(F("quotebuy-0xfd0d9e4AD5c9ddC07f68d7adF1aB9b0B20E798c4.hex"));
  assert.equal(q.shares, 609958818393555985940059n);
  assert.equal(q.fee, 40000000000000n);
});

test("parsePage decodes", () => {
  const pg = f.parsePage(F("page.hex"));
  assert.equal(pg.total, 97);
  assert.equal(pg.markets.length, 3);
});

test("encBuy matches expected", () => {
  assert.equal(f.encBuy(MK, 0x6754bf3e16e454aefeafn), "0xcce7ec13000000000000000000000000fd0d9e4ad5c9ddc07f68d7adf1ab9b0b20e798c4000000000000000000000000000000000000000000006754bf3e16e454aefeaf");
});

test("screenFlap passes MK", () => {
  const d = f.parseDetail(fx("detail", MK));
  const s = f.parseSettings(fx("settings", MK));
  assert.equal(f.screenFlap(d, s, 30, f.DEFAULTS), null);
});

test("screenFlap non-BNB", () => {
  assert.match(f.screenFlap(f.parseDetail(fx("detail", UQ)), f.parseSettings(fx("settings", UQ)), 30, f.DEFAULTS), /非 BNB/);
});

test("screenFlap graduated", () => {
  assert.match(f.screenFlap(f.parseDetail(fx("detail", GR)), f.parseSettings(fx("settings", GR)), 30, f.DEFAULTS), /畢業/);
});

test("screenFlap age", () => {
  const d = f.parseDetail(fx("detail", MK));
  const s = f.parseSettings(fx("settings", MK));
  assert.match(f.screenFlap(d, s, 61, f.DEFAULTS), /上線/);
});

test("screenFlap holders", () => {
  const d = f.parseDetail(fx("detail", MK));
  const s = f.parseSettings(fx("settings", MK));
  assert.match(f.screenFlap({ ...d, holders: 4 }, s, 30, f.DEFAULTS), /持幣/);
});

test("screenFlap progress", () => {
  const d = f.parseDetail(fx("detail", MK));
  const s = f.parseSettings(fx("settings", MK));
  assert.match(f.screenFlap({ ...d, progressBps: 299 }, s, 30, f.DEFAULTS), /曲線/);
  assert.match(f.screenFlap({ ...d, progressBps: 4001 }, s, 30, f.DEFAULTS), /曲線/);
});

test("screenFlap tax", () => {
  const d = f.parseDetail(fx("detail", MK));
  const s = f.parseSettings(fx("settings", MK));
  assert.match(f.screenFlap(d, { ...s, sellTaxBps: 501 }, 30, f.DEFAULTS), /稅/);
  assert.match(f.screenFlap(d, { ...s, buyTaxBps: null }, 30, f.DEFAULTS), /稅/);
});

const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const V = 4000000000000000n;
test("buyGate positive", () => {
  const q = f.parseQuote(F("quotebuy-0xfd0d9e4AD5c9ddC07f68d7adF1aB9b0B20E798c4.hex"));
  const minOk = (q.shares * 8000n) / 10000n;
  const tx = { to: f.PORTAL, value: String(V), inputData: f.encBuy(MK, minOk) };
  const pv = { success: true, data: { requestId: "rq", simulationResult: { simulationCode: "000000000", balanceChanges: [{ contractAddress: NATIVE, change: -4e15 }], authorityChanges: [], allowanceChanges: [] }, risks: { riskDetails: [] }, requireConfirmation: false } };
  const ctx = { market: MK, shares: q.shares, valueWei: V, slippageBps: 2000 };
  assert.equal(f.buyGate(pv, tx, ctx).ok, true);
  assert.equal(f.buyGate(pv, tx, ctx).requestId, "rq");
});

test("buyGate negatives", () => {
  const q = f.parseQuote(F("quotebuy-0xfd0d9e4AD5c9ddC07f68d7adF1aB9b0B20E798c4.hex"));
  const minOk = (q.shares * 8000n) / 10000n;
  const NATIVE2 = NATIVE;
  const pv = (o = {}, sim = {}) => ({ success: true, data: { requestId: "rq", simulationResult: { simulationCode: "000000000", balanceChanges: [{ contractAddress: NATIVE2, change: -4e15 }], authorityChanges: [], allowanceChanges: [], ...sim }, risks: { riskDetails: [] }, requireConfirmation: false, ...o } });
  const tx = (o = {}) => ({ to: f.PORTAL, value: String(V), inputData: f.encBuy(MK, minOk), ...o });
  const ctx = { market: MK, shares: q.shares, valueWei: V, slippageBps: 2000 };
  assert.equal(f.buyGate(pv({ success: false }), tx(), ctx).ok, false);
  assert.equal(f.buyGate(pv({}, { simulationCode: "1" }), tx(), ctx).ok, false);
  assert.equal(f.buyGate(pv({ requireConfirmation: true }), tx(), ctx).ok, false);
  assert.equal(f.buyGate(pv({ risks: { riskDetails: [{ a: 1 }] } }), tx(), ctx).ok, false);
  assert.equal(f.buyGate(pv({}, { allowanceChanges: [{ a: 1 }] }), tx(), ctx).ok, false);
});

test("runShadow integration", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const L = mkdtempSync(tmpdir() + "/t-");
  const S = mkdtempSync(tmpdir() + "/t-");
  const logs = [];
  const pad = (x) => BigInt(x).toString(16).padStart(64, "0");
  const page = "0x" + [pad(96), pad(0), pad(3), pad(3), pad(MK), pad(GR), pad(UQ)].join("");
  const NOW = 1793180000000;
  const calls = [];
  function deps(extra = {}) {
    return {
      now: NOW, wallet: "0x5e1f5e1f5e1f5e1f5e1f5e1f5e1f5e1f5e1f5e1f", logDir: L, stateDir: S, cfg: {},
      call: (to, data) => {
        calls.push(data.slice(0, 10));
        const m = "0x" + data.slice(34, 74);
        if (data.startsWith(f.SEL.marketPage)) return page;
        if (data.startsWith(f.SEL.marketDetail)) return fx("detail", m);
        if (data.startsWith(f.SEL.marketSettings)) return fx("settings", m);
        if (data.startsWith(f.SEL.quoteBuy)) return extra.quote ?? F("quotebuy-0xfd0d9e4AD5c9ddC07f68d7adF1aB9b0B20E798c4.hex");
        throw new Error("unexpected call " + data.slice(0, 10));
      },
      blockTs: (n) => Math.floor(NOW / 1000) - 30 * 60,
      preview: () => { calls.push("preview"); return { success: true, data: { requestId: "rq", simulationResult: { simulationCode: "000000000", balanceChanges: [{ contractAddress: NATIVE, change: -4e15 }], authorityChanges: [], allowanceChanges: [] }, risks: { riskDetails: [] }, requireConfirmation: false } }; },
      log: (m) => logs.push(m),
      ...extra,
    };
  }
  await f.runShadow(deps());
  const { readFileSync, existsSync } = await import("node:fs");
  const sh = join(L, "shadow.jsonl");
  assert.ok(existsSync(sh));
  const rows = readFileSync(sh, "utf8").trim().split("\n").map((x) => JSON.parse(x));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].market, MK);
});
