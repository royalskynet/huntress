// 聰明錢監控的純邏輯（無 IO、無簽名）。決策全在這裡，LLM 不參與。
// 資料源：baw leaderboard alpha-radar、meme-rush、query-token-audit（幣安官方技能，釘在 vendor/binance-skills-hub）。

const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));

/** 取出 baw --json 回傳的列陣列；形狀不認得就丟錯（fail loud，不猜）。 */
export function extractRows(resp) {
  if (!resp || resp.success === false) {
    const e = resp?.error;
    throw new Error(`baw error: ${e?.name || "unknown"} ${e?.message || ""}`.trim());
  }
  const d = resp.data;
  if (Array.isArray(d)) return d;
  for (const k of ["list", "records", "rows", "data"]) if (Array.isArray(d?.[k])) return d[k];
  throw new Error("baw response shape not recognised");
}

/**
 * 勝率換算成百分比。實測 baw leaderboard 回 0–1 小數（官方文件寫 0–100 是錯的，2026-11-16 查證）。
 * 出現 >1 的值代表尺度變了：丟錯，不猜（猜錯會讓全部錢包被靜默剔除或誤放行）。
 */
export function winPct(v) {
  const n = num(v);
  if (Number.isNaN(n)) return NaN;
  if (n > 1) throw new Error(`winRate scale changed (got ${v}, expected 0-1 fraction)`);
  return n * 100;
}

/** 合格錢包：勝率（百分比門檻）與已實現損益達標。欄位缺或非數字一律剔除。 */
export function goodWallets(rows, { minWinRate = 55, minPnlUsd = 0 } = {}) {
  return rows.filter((w) => winPct(w.winRate) >= minWinRate && num(w.realizedPnl) > minPnlUsd);
}

/** alpha-radar 列 → Map<CA(小寫), [{address,winRate,profitRate}]>；marchedTokens 是官方拼法。 */
export function groupByToken(wallets) {
  const m = new Map();
  for (const w of wallets) {
    for (const t of w.marchedTokens || []) {
      const ca = String(t.tokenAddress || "").toLowerCase();
      if (!ca) continue;
      if (!m.has(ca)) m.set(ca, []);
      m.get(ca).push({ address: w.address, winRate: winPct(w.winRate), profitRate: num(t.profitRate) });
    }
  }
  return m;
}

/** 池子流動性（USD）；欄位缺一律不過。 */
export function poolGate(tok, { minLiquidityUsd = 5000 } = {}) {
  const liq = num(tok.liquidity);
  if (!(liq >= minLiquidityUsd)) return { pass: false, reason: `liquidity ${tok.liquidity ?? "null"} < ${minLiquidityUsd}` };
  return { pass: true };
}

/**
 * 合約審計閘（fail-closed）。全部成立才過：
 * hasResult && isSupported、riskLevelEnum=LOW、買賣稅都有值且 < maxTaxPct、無 unusualTax 旗標、
 * 且所有 riskItems 的 isHit 皆為 false（官方 isHit=true 即偵測到風險：未放棄權限、貔貅、增發、黑名單等）。
 */
export function auditGate(resp, { maxTaxPct = 5 } = {}) {
  const d = resp?.data;
  if (resp?.code !== "000000" || !d) return { pass: false, reasons: ["no audit data"] };
  if (d.hasResult !== true || d.isSupported !== true) return { pass: false, reasons: ["audit unsupported/no result"] };
  const reasons = [];
  if (d.riskLevelEnum !== "LOW") reasons.push(`riskLevel ${d.riskLevelEnum}/${d.riskLevel}`);
  const x = d.extraInfo || {};
  if (!(num(x.buyTax) < maxTaxPct)) reasons.push(`buyTax ${x.buyTax ?? "null"}`);
  if (!(num(x.sellTax) < maxTaxPct)) reasons.push(`sellTax ${x.sellTax ?? "null"}`);
  if (x.unusualBuyTax || x.unusualSellTax) reasons.push("unusual tax");
  if (x.isFlaggedByVendor || x.isReported) reasons.push("flagged/reported");
  for (const item of d.riskItems || []) {
    for (const det of item.details || []) if (det.isHit === true) reasons.push(`hit: ${det.title}`);
  }
  return reasons.length ? { pass: false, reasons } : { pass: true, reasons: [] };
}

/** 三行簡報：CA／聰明錢買入均價／池子深度。均價官方技能沒有此欄，如實寫「無資料」，不推算。 */
export function formatBrief(tok, wallets) {
  const wr = Math.round(wallets.reduce((s, w) => s + (w.winRate || 0), 0) / wallets.length);
  return [
    `${tok.symbol || "?"} CA ${tok.contractAddress}`,
    `聰明錢 ${wallets.length} 個錢包持有（均勝率 ${wr}%）｜買入均價：無資料（官方技能未提供）｜現價 ${tok.price ?? "?"}`,
    `池子深度 $${Math.round(num(tok.liquidity))}｜進度 ${Math.round(num(tok.progress)) || 0}%｜審計通過（僅初篩）`,
  ].join("\n");
}
