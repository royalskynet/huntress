// sell.mjs 錢路徑補充（wo15 驗收以外）：授權送出後結果不明，必須不賣、但照樣撤授權
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepare, confirm } from "../src/sell.mjs";

const W = "0x1111111111111111111111111111111111111111";
const M = "0xfad7d1300e43a7b8f0b5a2fe5ef9a306f89c6efc";
const NFT = "0xe8c6b38b5e63377a96b268319b66638f772254bb";
const pad = (h) => String(h).replace(/^0x/, "").padStart(64, "0");
const BID = "0x" + ["08b117f5bb0156b84703d8590f581a682a322224", "1", "7ce66c50e28400000", "a", "64", "6ae1defa"].map(pad).join("");
const pv = (id, bal) => ({ success: true, data: { requestId: id, simulationResult: { simulationCode: "000000000", balanceChanges: bal, allowanceChanges: [], authorityChanges: [] }, risks: { riskDetails: [], addresses: {} }, requireConfirmation: false } });

function env(approveExec) {
  const stateDir = mkdtempSync(join(tmpdir(), "sell-"));
  mkdirSync(join(stateDir, "markets"));
  writeFileSync(join(stateDir, "markets", "1329a38d.json"), JSON.stringify({ tx: "0x1329a38d", market: M, nft: NFT, tokenIds: ["417"] }));
  const execs = [];
  const rpc = async (m, p) => {
    if (m === "eth_getTransactionReceipt") return { status: p[0].startsWith("0xaa") ? "0x0" : "0x1" };
    const d = p[0].data;
    if (d === "0xdc269049") return "0x" + pad((13036).toString(16));
    if (d.startsWith("0x454a2ab3")) return parseInt(d.slice(10), 16) === 13035 ? BID : "0x" + "0".repeat(384);
    if (d.startsWith("0x6352211e")) return "0x" + pad(W);
    if (d.startsWith("0xe985e9c5")) return "0x" + pad("0");
    throw new Error("execution reverted");
  };
  const baw = async (a) => {
    if (a[0] === "wallet") return { data: { addresses: [{ binanceChainId: "56", address: W }] } };
    if (a[1] === "preview") {
      const cd = a[a.indexOf("--inputData") + 1];
      if (cd.startsWith("0x302148df")) return pv("rF", [{ amount: -1 }, { amount: 142 }]);
      return pv(cd.endsWith(pad("1")) ? "rA" : "rR", []);
    }
    const id = a[a.indexOf("--requestId") + 1];
    execs.push(id);
    if (id === "rA") return approveExec();
    return { success: true, data: { txHash: "0xbb" + id } };
  };
  return { deps: { rpc, baw, stateDir, now: () => Date.now(), sleep: async () => {}, scan: 5 }, execs };
}

for (const [name, fn] of [
  ["授權 receipt 失敗", () => ({ success: true, data: { txHash: "0xaa01" } })],
  ["授權 execute 拋錯（可能已送出）", () => { throw new Error("timeout"); }],
  ["授權 execute 回失敗", () => ({ success: false })],
]) {
  test(`${name}：不賣、照樣撤授權`, async () => {
    const e = env(fn);
    const p = await prepare("1329a38d", e.deps);
    assert.equal(p.ok, true);
    const c = await confirm(p.nonce, e.deps);
    assert.equal(c.ok, false);
    assert.deepEqual(e.execs, ["rA", "rR"]);
    assert.equal(c.revoked, true);
  });
}
