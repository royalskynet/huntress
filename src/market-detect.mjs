// mint 成功後找項目自家鏈上買單簿（只通知不賣）：
// receipt 的 ERC721 Transfer 取 NFT 合約 → 對 mint 目標與 NFT 合約 eth_call 常見 getter →
// 回非零且有 code 的地址＝候選。任何失敗都回空，不擋 mint。
import { pathToFileURL } from "node:url";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const GETTERS = { "market()": "0x80f55605", "marketplace()": "0xabc8c7af", "exchange()": "0xd2f7265a" };

export function rpcClient(url = process.env.BSC_RPC || "https://bsc-dataseed.bnbchain.org") {
  return async (method, params) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(8000),
    });
    const j = await res.json();
    if (j.error) throw new Error(j.error.message ?? "rpc error");
    return j.result;
  };
}

// receipt 還沒出塊就等；BSC 出塊約 0.75–3 秒
async function waitReceipt(rpc, txHash, tries, delayMs) {
  for (let i = 0; i < tries; i++) {
    const r = await rpc("eth_getTransactionReceipt", [txHash]).catch(() => null);
    if (r) return r;
    if (i < tries - 1) await new Promise((ok) => setTimeout(ok, delayMs));
  }
  return null;
}

export async function detectMarket(txHash, { rpc = rpcClient(), tries = 10, delayMs = 3000 } = {}) {
  if (!/^0x[0-9a-f]{64}$/i.test(txHash ?? "")) return { hits: [], error: "bad txHash" };
  const r = await waitReceipt(rpc, txHash, tries, delayMs);
  if (!r || r.status !== "0x1") return { hits: [], error: r ? "tx failed" : "no receipt" };
  const transferLogs = (r.logs ?? []).filter((l) => l.topics?.length === 4 && l.topics[0]?.toLowerCase() === TRANSFER);
  const nfts = [...new Set(transferLogs.map((l) => l.address.toLowerCase()))];
  const tokenIds = transferLogs
    .filter((l) => /^0x0{64}$/i.test(l.topics[1] ?? ""))
    .map((l) => ({ nft: l.address.toLowerCase(), tokenId: BigInt(l.topics[3]).toString() }));
  const contracts = [...new Set([String(r.to ?? "").toLowerCase(), ...nfts])].filter((a) => /^0x[0-9a-f]{40}$/.test(a));
  const hits = [];
  const seen = new Set();
  for (const c of contracts) {
    for (const [getter, data] of Object.entries(GETTERS)) {
      const out = await rpc("eth_call", [{ to: c, data }, "latest"]).catch(() => null);
      // 剛好 32 bytes、高 12 bytes 為 0 才當地址，避免把其他回傳型別誤判
      if (!/^0x0{24}[0-9a-f]{40}$/i.test(out ?? "")) continue;
      const market = "0x" + out.slice(-40).toLowerCase();
      if (/^0x0{40}$/.test(market) || seen.has(market)) continue;
      const code = await rpc("eth_getCode", [market, "latest"]).catch(() => "0x");
      if (!code || code === "0x") continue;
      seen.add(market);
      hits.push({ contract: c, getter, market });
    }
  }
  return { hits, nfts, tokenIds };
}

export function formatHits(txHash, hits, opts = {}) {
  const auto = opts?.auto === true;
  const lines = hits.map((h) => `合約 ${h.contract}\n${h.getter} → ${h.market}`);
  const id = String(txHash ?? "").slice(2, 10);
  const lastLine = auto ? "白名單買單簿，會自動賣：底價＝24h 成交中位數×0.9，每 24h 降 0.1，滿 72h 接最高出價" : `要賣回 /sell ${id}`;
  return `🧾 偵測到鏈上買單簿（只通知，未賣）\n${lines.join("\n")}\ntx https://bscscan.com/tx/${txHash}\n${lastLine}`;
}

export function saveMarket(stateDir, txHash, out) {
  const id = String(txHash ?? "").slice(2, 10);
  const dir = join(stateDir, "markets");
  mkdirSync(dir, { recursive: true });
  const hits = Array.isArray(out?.hits) ? out.hits : [];
  const market = hits.length ? hits[0].market : (out?.market ?? null);
  const rawTokenIds = Array.isArray(out?.tokenIds) ? out.tokenIds : [];
  const tokenIds = rawTokenIds.map((t) => (typeof t === "string" ? t : String(t?.tokenId ?? t)));
  let nft = null;
  if (rawTokenIds.length && typeof rawTokenIds[0] === "object" && rawTokenIds[0] !== null) {
    nft = rawTokenIds[0].nft ?? null;
  }
  if (!nft && Array.isArray(out?.nfts) && out.nfts.length) nft = out.nfts[0];
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ tx: txHash, market, nft, tokenIds, at: Date.now() }));
  return;
}

const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const txHash = process.argv[2];
  let out;
  try {
    out = await detectMarket(txHash);
  } catch (e) {
    out = { hits: [], error: String(e?.message ?? e) };
  }
  if (out.hits.length) {
    let auto = false;
    try {
      const cfg = JSON.parse(readFileSync("config.json", "utf8"));
      const wl = cfg?.sellAuto?.markets ?? {};
      const m = String(out.hits[0]?.market ?? "").toLowerCase();
      auto = Object.prototype.hasOwnProperty.call(wl, m);
    } catch {}
    out.text = formatHits(txHash, out.hits, { auto });
    const stateDir = process.env.STATE_DIR || "state";
    saveMarket(stateDir, txHash, out);
  }
  console.log(JSON.stringify(out));
}
