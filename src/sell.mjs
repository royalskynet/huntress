import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { rpcClient } from "./market-detect.mjs";

export const SELL_DAILY = 3;

function padHex(v) {
  return String(v).replace(/^0x/i, "").padStart(64, "0");
}

export function fillData(bidId, tokenId) {
  return "0x302148df" + padHex(BigInt(bidId).toString(16)) + padHex("40") + padHex("1") + padHex(BigInt(tokenId).toString(16));
}

export function approveData(operator, bool) {
  return "0xa22cb465" + padHex(operator) + padHex(bool ? "1" : "0");
}

export function sellGate(preview, kind) {
  const reasons = [];
  const d = preview?.success === true ? preview.data : null;
  if (!d) reasons.push("preview 失敗");
  if (d && !d.requestId) reasons.push("缺 requestId");
  const sim = d?.simulationResult;
  if (d && sim?.simulationCode !== "000000000") reasons.push("模擬未通過");
  if (sim && !Array.isArray(sim.allowanceChanges)) reasons.push("缺 allowanceChanges");
  if (sim && Array.isArray(sim.allowanceChanges) && sim.allowanceChanges.length !== 0) reasons.push("有授權額度變更");
  if (sim && !Array.isArray(sim.authorityChanges)) reasons.push("缺 authorityChanges");
  if (sim && !Array.isArray(sim.balanceChanges)) reasons.push("缺 balanceChanges");
  const risks = d?.risks;
  if (d && !risks) reasons.push("缺 risks");
  if (risks && !Array.isArray(risks.riskDetails)) reasons.push("缺 riskDetails");
  if (risks && Array.isArray(risks.riskDetails) && risks.riskDetails.length !== 0) reasons.push("有交易風險項");
  if (risks && Object.values(risks.addresses ?? {}).some((a) => (a?.riskLevel ?? 0) > 0)) reasons.push("有風險地址");
  if (d && d.requireConfirmation !== false) reasons.push("需 App 確認");

  if (sim && Array.isArray(sim.balanceChanges)) {
    const neg = sim.balanceChanges.filter((c) => Number(c?.amount ?? c?.change ?? 0) < 0).length;
    const pos = sim.balanceChanges.filter((c) => Number(c?.amount ?? c?.change ?? 0) > 0).length;
    if (kind === "fill") {
      if (!Array.isArray(sim.authorityChanges) || sim.authorityChanges.length !== 0) reasons.push("有權限變更");
      if (neg !== 1) reasons.push("NFT 轉出數量不對");
      if (pos < 1) reasons.push("沒收到錢");
    } else {
      if (neg !== 0) reasons.push("有資產減少");
    }
  }

  const ok = reasons.length === 0;
  return { ok, reasons, requestId: ok ? (d?.requestId ?? null) : null };
}

export async function findBids(rpc, market, { scan, self } = {}) {
  const n = Number.isFinite(scan) ? scan : 200;
  let nextBidId = 0;
  try {
    const raw = await rpc("eth_call", [{ to: market, data: "0xdc269049" }, "latest"]);
    nextBidId = Number(BigInt(raw));
  } catch {
    nextBidId = 0;
  }
  const selfLow = String(self ?? "").toLowerCase();
  const results = [];
  for (let i = 1; i <= n; i++) {
    const id = nextBidId - i;
    if (id <= 0) break;
    const data = "0x454a2ab3" + padHex(id.toString(16));
    let raw = null;
    try { raw = await rpc("eth_call", [{ to: market, data }, "latest"]); } catch { raw = null; }
    if (!raw || typeof raw !== "string") continue;
    const hex = raw.replace(/^0x/i, "").padStart(64 * 6, "0");
    if (hex.length < 64 * 6) continue;
    const words = [];
    for (let w = 0; w < 6; w++) words.push(hex.slice(w * 64, (w + 1) * 64));
    const bidder = "0x" + words[0].slice(-40);
    const kind = parseInt(words[1], 16);
    const priceWei = BigInt("0x" + words[2]).toString();
    const qty = parseInt(words[3], 16);
    const feeBps = parseInt(words[4], 16);
    if (bidder.toLowerCase() === "0x" + "0".repeat(40)) continue;
    if (qty === 0) continue;
    if (selfLow && bidder.toLowerCase() === selfLow) continue;
    results.push({ bidId: id, bidder, kind, priceWei, qty, feeBps });
  }
  results.sort((a, b) => {
    const ba = BigInt(a.priceWei), bb = BigInt(b.priceWei);
    if (bb > ba) return 1;
    if (bb < ba) return -1;
    return 0;
  });
  return results;
}

export const FILLED_TOPIC = "0x7f748690209a8a1dfeb424cb1f545fd5fadbc24e23e4a158ad56d5999442ec5a";

export async function medianFill(rpc, market, { hours = 24, kind } = {}) {
  try {
    const headHex = await rpc("eth_blockNumber");
    const head = Number(BigInt(headHex));
    const totalBlocks = Math.ceil((Number(hours) * 3600) / 0.45);
    const from = Math.max(0, head - totalBlocks);
    const prices = [];
    const seenSegs = new Set();
    let cur = from;
    while (cur <= head) {
      const to = Math.min(head, cur + 49999);
      const logs = await rpc("eth_getLogs", [{ address: market, fromBlock: "0x" + cur.toString(16), toBlock: "0x" + to.toString(16), topics: [FILLED_TOPIC] }]);
      const arr = Array.isArray(logs) ? logs : [];
      const segKey = JSON.stringify(arr);
      if (!seenSegs.has(segKey)) {
        seenSegs.add(segKey);
        for (const lg of arr) {
          const data = String(lg?.data ?? "");
          const hex = data.replace(/^0x/i, "");
          if (hex.length < 64 * 4) continue;
          const words = [];
          for (let w = 0; w < 4; w++) words.push(hex.slice(w * 64, (w + 1) * 64));
          const k = parseInt(words[0], 16);
          if (k !== Number(kind)) continue;
          prices.push(BigInt("0x" + words[2]));
        }
      }
      cur = to + 1;
    }
    prices.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const n = prices.length;
    const medianWei = n ? prices[n >> 1].toString() : "0";
    return { n, medianWei };
  } catch {
    return { n: 0, medianWei: "0" };
  }
}

function weiToUsdt(wei) {
  const b = BigInt(wei ?? "0");
  const whole = b / 10n ** 18n;
  const frac = b % 10n ** 18n;
  let fracStr = frac.toString().padStart(18, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : String(whole);
}

export async function autoSell(id, deps) {
  if (!/^[0-9a-f]{8}$/.test(id)) return { sold: false, reason: "id 格式錯" };
  const stateDir = deps.stateDir;
  const sellAuto = deps.sellAuto || {};
  let marketData;
  try { marketData = JSON.parse(readFileSync(join(stateDir, "markets", `${id}.json`), "utf8")); }
  catch { return { sold: false, reason: "沒有偵測紀錄" }; }
  if (marketData?.sold === true) return { sold: false, reason: "已賣出" };

  const market = String(marketData?.market ?? "").toLowerCase();
  const nft = marketData?.nft;
  const rawTokenIds = Array.isArray(marketData?.tokenIds) ? marketData.tokenIds : [];
  const tokenIds = rawTokenIds.map((t) => (typeof t === "string" ? t : String(t?.tokenId ?? t)));

  const whitelist = sellAuto.markets || {};
  if (!Object.prototype.hasOwnProperty.call(whitelist, market)) {
    return { sold: false, reason: "不在白名單", priceWei: undefined, floorWei: undefined, medianWei: undefined };
  }

  const floorRatio = sellAuto.floorRatio;
  if (typeof floorRatio !== "number" || !Number.isFinite(floorRatio) || floorRatio < 0.5 || floorRatio > 1) {
    return { sold: false, reason: "floorRatio 無效" };
  }
  const windowHours = sellAuto.windowHours ?? 24;
  const minFills = sellAuto.minFills ?? 0;

  let addr;
  try { addr = await walletAddress(deps); }
  catch (e) { return { sold: false, reason: String(e?.message ?? e) }; }

  let tokenId = null;
  for (const tid of tokenIds) {
    const owner = await ownerOf(deps.rpc, nft, tid);
    if (owner && owner.toLowerCase() === addr.toLowerCase()) { tokenId = String(tid); break; }
  }
  if (tokenId === null) return { sold: false, reason: "NFT 不在錢包" };

  let bids;
  try { bids = await findBids(deps.rpc, market, { scan: deps.scan, self: addr }); }
  catch (e) { return { sold: false, reason: String(e?.message ?? e) }; }
  if (!bids || bids.length === 0) return { sold: false, reason: "沒有有效出價" };
  const bid = bids[0];

  const now = deps.now();
  const date = taipeiDate(now);
  const ledger = loadSellLedger(stateDir, date);
  const pendingCount = countPending(stateDir, now);
  if ((ledger.total ?? 0) + pendingCount >= SELL_DAILY) {
    return { sold: false, reason: "已達每日執行上限", priceWei: bid.priceWei };
  }

  // 遞減底價：每滿 24h 底價比例降 0.1；滿 72h 不看底價，接最高出價（免費 mint，有成交就賺）
  // ponytail: 階梯固定 3 段；要改成依成交量趨勢再加
  const ageH = (deps.now() - Number(marketData?.at ?? deps.now())) / 3600e3;
  const stage = Math.min(3, Math.max(0, Math.floor(ageH / 24)));
  let medianWei = "0", floorWei = "0";
  if (stage < 3) {
    const median = await medianFill(deps.logsRpc ?? deps.rpc, market, { hours: windowHours, kind: bid.kind });
    if (median.n < minFills) {
      return { sold: false, reason: "成交筆數不足", priceWei: bid.priceWei, medianWei: median.medianWei };
    }
    medianWei = median.medianWei;
    floorWei = (BigInt(medianWei) * BigInt(Math.round((floorRatio - stage * 0.1) * 1000)) / 1000n).toString();
    if (BigInt(bid.priceWei) < BigInt(floorWei)) {
      return { sold: false, reason: "出價低於底價", priceWei: bid.priceWei, floorWei, medianWei };
    }
  } else if (BigInt(bid.priceWei) <= 0n) {
    return { sold: false, reason: "出價為 0", priceWei: bid.priceWei };
  }

  const approved = await isApprovedForAll(deps.rpc, nft, addr, market);
  const needApprove = !approved;
  const data = { id, market, nft, tokenId, bidId: bid.bidId, priceWei: bid.priceWei, feeBps: bid.feeBps, needApprove };
  const res = await executeSell(data, deps);
  if (res.ok) {
    try {
      writeFileSync(join(stateDir, "markets", `${id}.json`), JSON.stringify({ ...marketData, sold: true, soldTx: res.txHash }));
    } catch {}
    const revokeText = res.revoked === true ? "已撤授權" : "⚠️ 授權未撤，請到 App 撤銷";
    const text = `🟢 NFT 自動賣出
tokenId: ${tokenId}
出價: ${weiToUsdt(bid.priceWei)} USDT
${stage < 3 ? `24h 中位數: ${weiToUsdt(medianWei)} USDT\n底價: ${weiToUsdt(floorWei)} USDT（第 ${stage + 1} 段，×${(floorRatio - stage * 0.1).toFixed(1)}）` : "已滿 72h，接最高出價"}
https://bscscan.com/tx/${res.txHash}
${revokeText}`;
    return { sold: true, txHash: res.txHash, revoked: res.revoked, priceWei: bid.priceWei, floorWei, medianWei, text };
  }
  return { sold: false, reason: (res.reasons && res.reasons.length ? res.reasons.join(", ") : "失敗"), txHash: res.txHash, revoked: res.revoked, priceWei: bid.priceWei, floorWei, medianWei };
}

function taipeiDate(ts) {
  const t = new Date((ts ?? Date.now()) + 8 * 60 * 60 * 1000);
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, "0");
  const d = String(t.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function loadSellLedger(stateDir, date) {
  try {
    const l = JSON.parse(readFileSync(join(stateDir, `sell-${date}.json`), "utf8"));
    if (!l || typeof l !== "object") return { total: 0 };
    if (l.total === undefined) l.total = 0;
    return l;
  } catch {
    return { total: 0 };
  }
}

function saveSellLedger(stateDir, date, ledger) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, `sell-${date}.json`), JSON.stringify(ledger));
}

function countPending(stateDir, now) {
  const dir = join(stateDir, "sell-pending");
  let n = 0;
  try {
    for (const f of readdirSync(dir)) {
      if (!/^[0-9a-f]{32}\.json$/.test(f)) continue;
      try {
        const created = JSON.parse(readFileSync(join(dir, f), "utf8")).createdAt ?? 0;
        if ((now ?? Date.now()) - created <= 10 * 60 * 1000) n++;
      } catch {
        n++;
      }
    }
  } catch {}
  return n;
}

async function walletAddress(deps) {
  const j = await deps.baw(["wallet", "address", "--json"]);
  const addr = (j?.data?.addresses ?? []).find((a) => a.binanceChainId === "56" || a.chainName === "BSC");
  if (!addr) throw new Error("no bsc wallet");
  return addr.address;
}

async function ownerOf(rpc, nft, tokenId) {
  const data = "0x6352211e" + padHex(BigInt(tokenId).toString(16));
  let raw = null;
  try { raw = await rpc("eth_call", [{ to: nft, data }, "latest"]); } catch { raw = null; }
  if (!raw || typeof raw !== "string") return null;
  return "0x" + raw.replace(/^0x/i, "").padStart(64, "0").slice(-40);
}

async function isApprovedForAll(rpc, nft, owner, operator) {
  const data = "0xe985e9c5" + padHex(owner) + padHex(operator);
  let raw = null;
  try { raw = await rpc("eth_call", [{ to: nft, data }, "latest"]); } catch { raw = null; }
  if (!raw) return false;
  try { return BigInt(raw) !== 0n; } catch { return false; }
}

async function waitReceipt(rpc, txHash, deps) {
  for (let i = 0; i < 10; i++) {
    const r = await rpc("eth_getTransactionReceipt", [txHash]).catch(() => null);
    if (r && r.status) return r;
    if (i < 9) await deps.sleep(3000);
  }
  return null;
}

export async function prepare(id, deps) {
  if (!/^[0-9a-f]{8}$/.test(id)) return { ok: false, reasons: ["id 格式錯"] };
  const stateDir = deps.stateDir;
  let marketData;
  try {
    marketData = JSON.parse(readFileSync(join(stateDir, "markets", `${id}.json`), "utf8"));
  } catch {
    return { ok: false, reasons: ["沒有偵測紀錄"] };
  }
  const market = marketData.market;
  const nft = marketData.nft;
  const rawTokenIds = Array.isArray(marketData.tokenIds) ? marketData.tokenIds : [];
  const tokenIds = rawTokenIds.map((t) => (typeof t === "string" ? t : String(t?.tokenId ?? t)));
  let addr;
  try { addr = await walletAddress(deps); }
  catch (e) { return { ok: false, reasons: [String(e?.message ?? e)] }; }

  let tokenId = null;
  for (const tid of tokenIds) {
    const owner = await ownerOf(deps.rpc, nft, tid);
    if (owner && owner.toLowerCase() === addr.toLowerCase()) { tokenId = String(tid); break; }
  }
  if (tokenId === null) return { ok: false, reasons: ["NFT 不在錢包"] };

  let bids;
  try { bids = await findBids(deps.rpc, market, { scan: deps.scan, self: addr }); }
  catch (e) { return { ok: false, reasons: [String(e?.message ?? e)] }; }
  if (!bids || bids.length === 0) return { ok: false, reasons: ["沒有有效出價"] };
  const bid = bids[0];

  const now = deps.now();
  const date = taipeiDate(now);
  const ledger = loadSellLedger(stateDir, date);
  const pendingCount = countPending(stateDir, now);
  if ((ledger.total ?? 0) + pendingCount >= SELL_DAILY) {
    return { ok: false, reasons: ["已達每日執行上限"] };
  }

  const approved = await isApprovedForAll(deps.rpc, nft, addr, market);
  const needApprove = !approved;
  if (needApprove) {
    let preview;
    try {
      preview = await deps.baw([
        "contract-call", "preview",
        "--binanceChainId", "56",
        "--from", addr,
        "--to", nft,
        "--value", "0",
        "--inputData", approveData(market, true),
        "--json",
      ]);
    } catch (e) {
      return { ok: false, reasons: [String(e?.message ?? e)] };
    }
    const g = sellGate(preview, "approve");
    if (!g.ok) return { ok: false, reasons: g.reasons?.length ? g.reasons : ["preview 未通過"] };
  }

  const nonce = randomBytes(16).toString("hex");
  mkdirSync(join(stateDir, "sell-pending"), { recursive: true });
  writeFileSync(
    join(stateDir, "sell-pending", `${nonce}.json`),
    JSON.stringify({ id, market, nft, tokenId, bidId: bid.bidId, priceWei: bid.priceWei, feeBps: bid.feeBps, needApprove, createdAt: now })
  );
  return { ok: true, nonce, tokenId, bidId: bid.bidId, priceWei: bid.priceWei, feeBps: bid.feeBps, market, nft, needApprove };
}

export async function executeSell(data, deps) {
  const stateDir = deps.stateDir;
  const rpc = deps.rpc;
  const market = data.market;
  const nft = data.nft;
  const tokenId = data.tokenId;
  const bidId = data.bidId;
  const pendingPrice = data.priceWei;

  let onChainValid = false;
  let onChainPrice = null;
  try {
    const raw = await rpc("eth_call", [{ to: market, data: "0x454a2ab3" + padHex(Number(bidId).toString(16)) }, "latest"]);
    if (raw && typeof raw === "string") {
      const hex = raw.replace(/^0x/i, "").padStart(64 * 6, "0");
      if (hex.length >= 64 * 6) {
        const words = [];
        for (let w = 0; w < 6; w++) words.push(hex.slice(w * 64, (w + 1) * 64));
        const bidder = "0x" + words[0].slice(-40);
        const qty = parseInt(words[3], 16);
        onChainPrice = BigInt("0x" + words[2]).toString();
        onChainValid = bidder.toLowerCase() !== "0x" + "0".repeat(40) && qty !== 0;
      }
    }
  } catch {
    onChainValid = false;
  }
  if (!onChainValid) return { ok: false, reasons: ["出價已失效"] };
  if (BigInt(onChainPrice) < BigInt(pendingPrice)) return { ok: false, reasons: ["出價已降低"] };

  let addr;
  try { addr = await walletAddress(deps); }
  catch (e) { return { ok: false, reasons: [String(e?.message ?? e)] }; }
  const owner = await ownerOf(rpc, nft, tokenId);
  if (!owner || owner.toLowerCase() !== addr.toLowerCase()) {
    return { ok: false, reasons: ["NFT 不在錢包"] };
  }

  const now = deps.now();
  const date = taipeiDate(now);
  const ledger = loadSellLedger(stateDir, date);
  const pendingCount = countPending(stateDir, now);
  if ((ledger.total ?? 0) + pendingCount >= SELL_DAILY) {
    return { ok: false, reasons: ["已達每日執行上限"] };
  }
  ledger.total = (ledger.total ?? 0) + 1;
  saveSellLedger(stateDir, date, ledger);

  const originallyApproved = await isApprovedForAll(rpc, nft, addr, market);
  const needApprove = data.needApprove === true;

  let approvalGrantedByUs = false;
  let approveFail = null;
  let txHash = null;
  let revoked = false;

  if (needApprove) {
    let preview;
    try {
      preview = await deps.baw([
        "contract-call", "preview",
        "--binanceChainId", "56",
        "--from", addr,
        "--to", nft,
        "--value", "0",
        "--inputData", approveData(market, true),
        "--json",
      ]);
    } catch (e) {
      return { ok: false, txHash: null, revoked: false, reasons: [String(e?.message ?? e)] };
    }
    const g = sellGate(preview, "approve");
    if (!g.ok) return { ok: false, txHash: null, revoked: false, reasons: g.reasons?.length ? g.reasons : ["preview 未通過"] };
    let execJson;
    try {
      execJson = await deps.baw([
        "contract-call", "execute",
        "--requestId", g.requestId,
        "--json",
      ]);
    } catch (e) {
      execJson = null;
      approveFail = [`授權 execute 拋錯：${String(e?.message ?? e)}`];
    }
    approvalGrantedByUs = true;
    if (execJson) {
      const d = execJson?.data ?? execJson;
      const th = d?.txHash;
      if (execJson?.success === false) approveFail = ["授權 execute 失敗"];
      else if (th) {
        const receipt = await waitReceipt(rpc, th, deps);
        if (!receipt || receipt.status !== "0x1") approveFail = ["授權 receipt 失敗或逾時"];
      }
    }
  }

  let fillOk = false;
  let fillReasons = approveFail ?? [];
  let fillTx = null;
  if (!approveFail) try {
    const preview = await deps.baw([
      "contract-call", "preview",
      "--binanceChainId", "56",
      "--from", addr,
      "--to", market,
      "--value", "0",
      "--inputData", fillData(bidId, tokenId),
      "--json",
    ]);
    const g = sellGate(preview, "fill");
    if (!g.ok) {
      fillReasons = g.reasons?.length ? g.reasons : ["preview 未通過"];
    } else {
      let execJson;
      try {
        execJson = await deps.baw([
          "contract-call", "execute",
          "--requestId", g.requestId,
          "--json",
        ]);
      } catch (e) {
        fillReasons = [String(e?.message ?? e)];
        throw e;
      }
      const d = execJson?.data ?? execJson;
      const th = d?.txHash;
      const execOk = execJson?.success !== false;
      if (!execOk) {
        fillReasons = ["execute 失敗"];
        fillTx = th ?? null;
      } else {
        if (th) {
          const receipt = await waitReceipt(rpc, th, deps);
          if (!receipt || receipt.status !== "0x1") {
            fillReasons = ["receipt 失敗"];
            fillTx = th;
          } else {
            fillOk = true;
            fillTx = th;
          }
        } else {
          fillOk = true;
        }
      }
    }
  } catch (e) {
    if (!fillReasons.length) fillReasons = [String(e?.message ?? e)];
  }
  txHash = fillTx;

  const approvalOpen = originallyApproved || approvalGrantedByUs;
  if (approvalOpen) {
    try {
      const preview = await deps.baw([
        "contract-call", "preview",
        "--binanceChainId", "56",
        "--from", addr,
        "--to", nft,
        "--value", "0",
        "--inputData", approveData(market, false),
        "--json",
      ]);
      const g = sellGate(preview, "revoke");
      if (g.ok) {
        const execJson = await deps.baw([
          "contract-call", "execute",
          "--requestId", g.requestId,
          "--json",
        ]);
        const d = execJson?.data ?? execJson;
        const th = d?.txHash;
        const execOk = execJson?.success !== false;
        if (execOk) {
          if (th) {
            const receipt = await waitReceipt(rpc, th, deps);
            if (receipt && receipt.status === "0x1") revoked = true;
          } else {
            revoked = true;
          }
        }
      }
    } catch {
      // revoke failed
    }
  }

  if (fillOk) {
    if (approvalOpen && !revoked) {
      return { ok: true, txHash, revoked: false, reasons: ["授權未撤，請到 App 撤銷"] };
    }
    return { ok: true, txHash, revoked, reasons: [] };
  }
  return { ok: false, txHash, revoked, reasons: fillReasons.length ? fillReasons : ["失敗"] };
}

export async function confirm(nonce, deps) {
  if (!/^[0-9a-f]{32}$/.test(nonce)) return { ok: false, reasons: ["nonce 格式錯"] };
  const stateDir = deps.stateDir;
  const pendingDir = join(stateDir, "sell-pending");
  const pendingPath = join(pendingDir, `${nonce}.json`);
  const usedPath = join(pendingDir, `used-${nonce}.json`);
  try { renameSync(pendingPath, usedPath); }
  catch { return { ok: false, reasons: ["invalid or used"] }; }
  let data;
  try { data = JSON.parse(readFileSync(usedPath, "utf8")); }
  catch { return { ok: false, reasons: ["invalid pending"] }; }

  const now = deps.now();
  if (now - (data.createdAt ?? 0) > 10 * 60 * 1000) {
    return { ok: false, reasons: ["expired"] };
  }

  const date = taipeiDate(now);
  const ledger = loadSellLedger(stateDir, date);
  const pendingCount = countPending(stateDir, now);
  if ((ledger.total ?? 0) + pendingCount >= SELL_DAILY) {
    return { ok: false, reasons: ["已達每日執行上限"] };
  }

  return executeSell(data, deps);
}

export async function cancel(nonce, deps) {
  if (!/^[0-9a-f]{32}$/.test(nonce)) return { ok: false, reasons: ["nonce 格式錯"] };
  const stateDir = deps.stateDir;
  const pendingPath = join(stateDir, "sell-pending", `${nonce}.json`);
  const usedPath = join(stateDir, "sell-pending", `used-${nonce}.json`);
  try { renameSync(pendingPath, usedPath); }
  catch { return { ok: false, reasons: ["invalid or used"] }; }
  return { ok: true };
}

const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const cmd = process.argv[2];
  const bawBin = process.env.BAW_BIN || "node_modules/.bin/baw";
  const rpcUrl = process.env.BSC_RPC || "https://bsc-dataseed.bnbchain.org";
  const rpc = rpcClient(rpcUrl);
  const baw = async (args) => {
    const r = spawnSync(bawBin, args, { encoding: "utf8" });
    if (r.status !== 0) throw new Error((r.stderr || "").trim() || `baw exited ${r.status}`);
    return JSON.parse(String(r.stdout || "").trim());
  };
  const stateDir = process.env.STATE_DIR || "state";
  const scan = Number(process.env.SELL_SCAN || 200);
  if (cmd === "auto-all") {
    let cfg = {};
    try { cfg = JSON.parse(readFileSync("config.json", "utf8")); } catch { cfg = {}; }
    const sellAuto = cfg?.sellAuto;
    if (!sellAuto) {
      console.log(JSON.stringify({ ok: true, skipped: "no sellAuto" }));
      process.exit(0);
    }
    // dataseed／defibit 的 eth_getLogs 一律 limit exceeded、1rpc 限 50 區塊；publicnode 實測 5 萬區塊可查（2026-10-29）
    const logsRpc = rpcClient(process.env.BSC_LOGS_RPC || "https://bsc-rpc.publicnode.com");
    const deps = { rpc, logsRpc, baw, stateDir, now: () => Date.now(), sleep: (ms) => new Promise((res) => setTimeout(res, ms)), scan, sellAuto };
    const dir = join(stateDir, "markets");
    let files = [];
    try { files = readdirSync(dir).filter((f) => /^[0-9a-f]{8}\.json$/.test(f)); } catch {}
    files.sort();
    (async () => {
      for (const f of files) {
        const id = f.replace(/\.json$/, "");
        const filePath = join(dir, f);
        let marketData;
        try { marketData = JSON.parse(readFileSync(filePath, "utf8")); } catch { continue; }
        if (marketData?.sold === true) continue;
        const now = Date.now();
        const lastTry = Number(marketData?.lastTry ?? 0);
        if (lastTry && now - lastTry < 30 * 60 * 1000) continue;
        // 舊檔沒有 at：用檔案建立時間補（mtime 會被 lastTry 改寫，不能用）
        if (!marketData.at) { try { marketData.at = statSync(filePath).birthtimeMs; } catch { marketData.at = now; } }
        marketData.lastTry = now;
        try { writeFileSync(filePath, JSON.stringify(marketData)); } catch {}
        try {
          const res = await autoSell(id, deps);
          const out = { ...res, id };
          console.log(JSON.stringify(out));
        } catch (e) {
          console.log(JSON.stringify({ ok: false, id, reasons: [String(e?.message ?? e)] }));
        }
      }
    })().catch((e) => {
      console.log(JSON.stringify({ ok: false, reasons: [String(e?.message ?? e)] }));
    });
  } else {
  const deps = { rpc, baw, stateDir, now: () => Date.now(), sleep: (ms) => new Promise((res) => setTimeout(res, ms)), scan };
  (async () => {
    let out;
    if (cmd === "prepare") out = await prepare(process.argv[3], deps);
    else if (cmd === "confirm") out = await confirm(process.argv[3], deps);
    else if (cmd === "cancel") out = await cancel(process.argv[3], deps);
    else out = { ok: false, reasons: ["unknown command"] };
    console.log(JSON.stringify(out));
  })().catch((e) => {
    console.log(JSON.stringify({ ok: false, reasons: [String(e?.message ?? e)] }));
  });
  }
}
