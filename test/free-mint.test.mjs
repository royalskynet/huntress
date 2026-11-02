import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestFreeMints, decide, DEFAULTS } from "../src/autotrade.mjs";

const W = "0x5e1f5e1f5e1f5e1f5e1f5e1f5e1f5e1f5e1f5e1f";
const T = "0x2754803efccc7d808bba1a120cbfcbab80feffff";
const NFT = "0x4444444444444444444444444444444444444444";
const OTHER = "0x9999999999999999999999999999999999999999";
const TR = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (a) => "0x" + a.slice(2).padStart(64, "0");
const N = 1793150000000;

test("ingest 收 ERC20、不收 NFT（4 topics）、不收轉給別人", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fm-"));
  writeFileSync(join(dir, "free-mints.jsonl"), JSON.stringify({ txHash: "0x" + "a".repeat(64), at: N - 60000 }) + "\n");
  const st = { positions: {}, rejected: {}, closed: [] };
  await ingestFreeMints({ now: N, stateDir: dir, wallet: W, receipt: async () => ({ status: "0x1", logs: [
    { address: T, topics: [TR, pad("0x" + "0".repeat(40)), pad(W)] },
    { address: NFT, topics: [TR, pad("0x" + "0".repeat(40)), pad(W), pad("0x01")] },
    { address: OTHER, topics: [TR, pad("0x" + "0".repeat(40)), pad("0x" + "1".repeat(40))] },
  ] }) }, st);
  assert.equal(st.positions[T].kind, "free");
  assert.equal(st.positions[NFT], undefined);
  assert.equal(st.positions[OTHER], undefined);
  assert.equal(readFileSync(join(dir, "free-mints.jsonl"), "utf8").trim(), "");
});

test("ingest 未滿 30 分無 receipt 留著", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fm-"));
  const rec = { txHash: "0x" + "b".repeat(64), at: N - 60000 };
  writeFileSync(join(dir, "free-mints.jsonl"), JSON.stringify(rec) + "\n");
  const st = { positions: {}, rejected: {}, closed: [] };
  await ingestFreeMints({ now: N, stateDir: dir, wallet: W, receipt: async () => null }, st);
  assert.equal(readFileSync(join(dir, "free-mints.jsonl"), "utf8").trim(), JSON.stringify(rec));
  assert.equal(Object.keys(st.positions).length, 0);
});

test("ingest 滿 30 分無 receipt 丟掉", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fm-"));
  const rec = { txHash: "0x" + "c".repeat(64), at: N - 31 * 60 * 1000 };
  writeFileSync(join(dir, "free-mints.jsonl"), JSON.stringify(rec) + "\n");
  const st = { positions: {}, rejected: {}, closed: [] };
  await ingestFreeMints({ now: N, stateDir: dir, wallet: W, receipt: async () => null }, st);
  assert.equal(readFileSync(join(dir, "free-mints.jsonl"), "utf8").trim(), "");
});

test("free 持倉暖機期不賣、之後高點回落連 2 次全賣", () => {
  const c = DEFAULTS.sell;
  const R = 10n ** 21n;
  const p = { kind: "free", costWei: "0", boughtAt: N, soldHalf: false };
  assert.equal(decide(p, 1000000000000000n, R, c, N)[0], null);
  assert.equal(decide(p, 1000000000000000n, R, c, N + 60000)[0], null);
  assert.equal(decide(p, 2000000000000000n, R, c, N + 240000)[0], null);
  assert.equal(decide(p, 900000000000000n, R, c, N + 300000)[0], null);
  assert.equal(decide(p, 900000000000000n, R, c, N + 360000)[0], "all");
});
