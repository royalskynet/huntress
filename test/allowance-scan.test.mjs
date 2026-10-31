import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan, candidates } from "../src/allowance-scan.mjs";

const addr = (i) => "0x" + i.toString(16).padStart(40, "0");

test("getLogs 每次最多帶 10 個 address", async () => {
  const sent = [];
  const rpc = async (m, p) => {
    if (m === "eth_blockNumber") return "0x10";
    if (m === "eth_getLogs") { sent.push(p[0].address); return []; }
    return "0x0";
  };
  await scan(rpc, addr(1), { fromBlock: 0, pairs: [], addresses: Array.from({ length: 12 }, (_, i) => addr(i + 2)) });
  assert.equal(sent.length, 4); // 2 組 × (Approval＋ApprovalForAll)
  assert.ok(sent.every((a) => Array.isArray(a) && a.length <= 10));
});

test("candidates 收 buy／positions／closed／markets.nfts", () => {
  const d = mkdtempSync(join(tmpdir(), "cand-"));
  writeFileSync(join(d, "buy-2026-10-28.json"), JSON.stringify({ byContract: { [addr(2)]: 1 } }));
  writeFileSync(join(d, "ledger-2026-10-28.json"), JSON.stringify({ byContract: { [addr(9)]: 1 } }));
  writeFileSync(join(d, "positions.json"), JSON.stringify({ positions: { [addr(3)]: {} }, closed: [{ token: addr(4) }] }));
  mkdirSync(join(d, "markets"));
  writeFileSync(join(d, "markets", "abcd1234.json"), JSON.stringify({ nfts: [addr(5)] }));
  assert.deepEqual(candidates(d), [addr(2), addr(3), addr(4), addr(5)]);
});
