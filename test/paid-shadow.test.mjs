// 付費 mint 影子單：命中只寫 shadow.jsonl，全程不得下單（execute/swap 呼叫數必為 0）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import * as f from "../src/flap.mjs";

const F = (n) => readFileSync(join(process.cwd(), "test/fixtures/flap", n), "utf8").trim();
const MK = "0xfd0d9e4ad5c9ddc07f68d7adf1ab9b0b20e798c4";
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const NOW = 1793180000000;
const pad = (x) => BigInt(x).toString(16).padStart(64, "0");
const page = "0x" + [pad(96), pad(0), pad(1), pad(1), pad(MK)].join("");

function makeDeps(extra = {}) {
  const L = mkdtempSync(join(tmpdir(), "ps-l-")), S = mkdtempSync(join(tmpdir(), "ps-s-"));
  const calls = [];
  const deps = {
    now: NOW, wallet: "0x5e1f5e1f5e1f5e1f5e1f5e1f5e1f5e1f5e1f5e1f", logDir: L, stateDir: S, cfg: {},
    call: (to, data) => {
      calls.push(data.slice(0, 10));
      if (data.startsWith(f.SEL.marketPage)) return page;
      if (data.startsWith(f.SEL.marketDetail)) return F("detail-0xfd0d9e4AD5c9ddC07f68d7adF1aB9b0B20E798c4.hex");
      if (data.startsWith(f.SEL.marketSettings)) return F("settings-0xfd0d9e4AD5c9ddC07f68d7adF1aB9b0B20E798c4.hex");
      if (data.startsWith(f.SEL.quoteBuy)) return F("quotebuy-0xfd0d9e4AD5c9ddC07f68d7adF1aB9b0B20E798c4.hex");
      throw new Error("unexpected call " + data.slice(0, 10));
    },
    blockTs: () => Math.floor(NOW / 1000) - 30 * 60,
    preview: () => { calls.push("preview"); return { success: true, data: { requestId: "rq", simulationResult: { simulationCode: "000000000", balanceChanges: [{ contractAddress: NATIVE, change: -4e15 }], authorityChanges: [], allowanceChanges: [] }, risks: { riskDetails: [] }, requireConfirmation: false } }; },
    logs: null,
    ...extra,
  };
  deps.logs = [];
  deps.log = (m) => deps.logs.push(m);
  // 影子模組若哪天被改成會下單，一定得經過這些入口；任何一個被呼叫就算違規。
  for (const k of ["execute", "send", "swap", "sign", "broadcast"]) {
    deps[k] = (...a) => { calls.push(`${k}!`); throw new Error(`影子單不得呼叫 ${k}`); };
  }
  return { deps, calls, L };
}

test("影子命中：寫一筆 row，且全程只有 preview、零下單呼叫", async () => {
  const { deps, calls, L } = makeDeps();
  await f.runShadow(deps);
  const rows = readFileSync(join(L, "shadow.jsonl"), "utf8").trim().split("\n").map((x) => JSON.parse(x));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].market, MK);
  assert.equal(calls.filter((c) => c === "preview").length, 1);
  assert.deepEqual(calls.filter((c) => /!$/.test(c)), []);
});

test("閘擋下：不寫 shadow.jsonl，也不下單", async () => {
  const { deps, calls, L } = makeDeps({ preview: () => { calls.push("preview"); return { success: true, data: { requestId: "rq", simulationResult: { simulationCode: "000000000", balanceChanges: [{ contractAddress: NATIVE, change: -4e15 }], authorityChanges: [], allowanceChanges: [{ a: 1 }] }, risks: { riskDetails: [] }, requireConfirmation: false } }; } });
  await f.runShadow(deps);
  assert.equal(existsSync(join(L, "shadow.jsonl")), false);
  assert.deepEqual(calls.filter((c) => /!$/.test(c)), []);
});

test("上線門檻：命中筆數 < minHits 印未達，≥ minHits 印達標", async () => {
  const { deps } = makeDeps();
  await f.runShadow(deps);
  assert.ok(deps.logs.some((m) => m.includes("命中累計 1/5")), deps.logs.join(" | "));
  const { deps: d5 } = makeDeps({ cfg: { minHits: 1 } });
  await f.runShadow(d5);
  assert.ok(d5.logs.some((m) => m.includes("命中累計 1/1（達上線門檻）")), d5.logs.join(" | "));
});
