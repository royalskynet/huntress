import test from "node:test";
import assert from "node:assert/strict";
import { detectMarket, formatHits } from "../src/market-detect.mjs";

// 夾具取自 BSC 實鏈 2026-10-28：Ptah Relic mint tx 0x1329a38d…（PtahGame.market() → PtahMarket）
const GAME = "0xb0d5f3108af164f5f7046f53ab59fd2779812d10";
const RELIC = "0xe8c6b38b5e63377a96b268319b66638f772254bb";
const MARKET = "0xfad7d1300e43a7b8f0b5a2fe5ef9a306f89c6efc";
const TX = "0x1329a38dd79c99c0dadfd35d2f43d117bef3336a2bff53cdb659515b880afc44";
const T0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const word = (a) => "0x" + a.slice(2).padStart(64, "0");

function fakeRpc({ to, logs, status = "0x1", calls = {}, codes = {} }) {
  return async (method, params) => {
    if (method === "eth_getTransactionReceipt") return { to, status, logs };
    if (method === "eth_call") {
      const v = calls[`${params[0].to}:${params[0].data}`];
      if (v === undefined) throw new Error("execution reverted");
      return v;
    }
    if (method === "eth_getCode") return codes[params[0]] ?? "0x";
    throw new Error(method);
  };
}
const ptahLogs = [
  { address: RELIC, topics: [T0, word("0x0"), word("0x5dd0d37d0000000000000000000000007aee30c70"), word("0x1a1")] },
  { address: GAME, topics: ["0xcaaf2c96", "0x1", "0x2"] },
];

test("Ptah 夾具命中 PtahMarket", async () => {
  const rpc = fakeRpc({ to: GAME, logs: ptahLogs, calls: { [`${GAME}:0x80f55605`]: word(MARKET) }, codes: { [MARKET]: "0x6080" } });
  const out = await detectMarket(TX, { rpc, tries: 1 });
  assert.deepEqual(out.hits, [{ contract: GAME, getter: "market()", market: MARKET }]);
  assert.deepEqual(out.nfts, [RELIC]);
  const msg = formatHits(TX, out.hits);
  assert.match(msg, new RegExp(MARKET)); assert.match(msg, /bscscan\.com\/tx\//);
  assert.doesNotMatch(msg, /Ptah|Relic/i); // 不放項目名稱
  assert.ok(!msg.includes("\\n") && msg.split("\n").length >= 4); // 真換行，不是字面 \n
});

test("一般 ERC721（getter 全 revert）不命中", async () => {
  const rpc = fakeRpc({ to: RELIC, logs: ptahLogs.slice(0, 1) });
  assert.deepEqual((await detectMarket(TX, { rpc, tries: 1 })).hits, []);
});

test("零地址、無 code、非地址回傳都不算", async () => {
  const rpc = fakeRpc({
    to: GAME, logs: ptahLogs,
    calls: { [`${GAME}:0x80f55605`]: word("0x0"), [`${GAME}:0xabc8c7af`]: word(MARKET), [`${RELIC}:0xd2f7265a`]: "0x" + "f".repeat(64) },
  });
  assert.deepEqual((await detectMarket(TX, { rpc, tries: 1 })).hits, []);
});

test("tx 失敗、收不到 receipt、壞 hash 都回空", async () => {
  const failed = fakeRpc({ to: GAME, logs: ptahLogs, status: "0x0", calls: { [`${GAME}:0x80f55605`]: word(MARKET) }, codes: { [MARKET]: "0x60" } });
  assert.deepEqual((await detectMarket(TX, { rpc: failed, tries: 1 })).hits, []);
  const none = async () => null;
  assert.equal((await detectMarket(TX, { rpc: none, tries: 2, delayMs: 1 })).error, "no receipt");
  assert.equal((await detectMarket("0x12", { rpc: none })).error, "bad txHash");
});
