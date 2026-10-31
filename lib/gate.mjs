// 機械閘：決定一筆 contract-call preview 能不能自動 execute。
// 只放行「0 元、無授權變更、無風險、免 App 確認」的交易；任何缺欄位一律拒絕（fail-closed）。

const ZERO_SIM = "000000000";

const isZero = (v) => {
  if (v === undefined || v === null || v === "") return true; // CLI 預設 value=0
  try { return BigInt(v) === 0n; } catch { return false; }
};

const emptyList = (v) => Array.isArray(v) && v.length === 0;

// preview: `baw contract-call preview --json` 的完整輸出
// call: { to, value }；ctx: { cfg: {dailyMax, perContractDaily, denylist[], gasBudgetWei?, gasReserveWei?}, ledger: {total, byContract{}, gasWei?} }
// opts.maxValueWei：使用者在 TG 按確認的付費單（src/buy.mjs）才給；容許 0 < value ≤ 上限、
// 模擬裡最多一筆資產減少（付出去的 BNB），其餘條件不變。
export function gate(preview, call, ctx, opts = {}) {
  const reasons = [];
  const no = (r) => reasons.push(r);

  const d = preview?.success === true ? preview.data : null;
  if (!d) no("preview 失敗或被攔截");
  if (d && !d.requestId) no("缺 requestId");

  const sim = d?.simulationResult;
  if (d && sim?.simulationCode !== ZERO_SIM) no(`模擬未通過：${sim?.simulationCode ?? "缺欄位"}`);
  if (sim && !emptyList(sim.allowanceChanges)) no("有授權額度變更");
  if (sim && !emptyList(sim.authorityChanges)) no("有權限變更");
  if (sim && !Array.isArray(sim.balanceChanges)) no("缺 balanceChanges");
  const paid = opts.maxValueWei !== undefined;
  // balanceChanges 只容許「收到」（正數）；任何負數＝會扣資產。付費單容許一筆（付出的 BNB）
  const neg = Array.isArray(sim?.balanceChanges)
    ? sim.balanceChanges.filter((c) => !(Number(c?.amount ?? c?.change ?? -1) >= 0)).length : 0;
  if (neg > (paid ? 1 : 0)) no("模擬顯示資產會減少");

  if (paid) {
    let v, max;
    try { v = BigInt(call?.value ?? ""); max = BigInt(opts.maxValueWei); } catch { v = -1n; max = 0n; }
    if (!(v >= 0n && max > 0n && v <= max)) no("value 超過單筆上限或格式錯");
  } else {
    if (!isZero(call?.value)) no("value 不為 0");
    if (d?.parsedTx && Number(d.parsedTx.amount ?? 0) > 0) no("parsedTx 有轉出金額");
  }

  const risks = d?.risks;
  if (d && !risks) no("缺 risks");
  if (risks && !emptyList(risks.riskDetails ?? [])) no("有交易風險項");
  if (risks && Object.values(risks.addresses ?? {}).some((a) => (a?.riskLevel ?? 0) > 0)) no("有風險地址");
  if (d && d.requireConfirmation !== false) no("需 App 確認");

  const to = String(call?.to ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(to)) no("to 地址格式錯");
  const cfg = ctx?.cfg ?? {};
  const ledger = ctx?.ledger ?? {};
  if ((cfg.denylist ?? []).map((a) => a.toLowerCase()).includes(to)) no("合約在 denylist");
  if (!(Number.isInteger(cfg.dailyMax) && Number.isInteger(cfg.perContractDaily))) no("config 缺上限");
  if ((ledger.total ?? 0) >= cfg.dailyMax) no("已達每日自動執行上限");
  if ((ledger.byContract?.[to] ?? 0) >= cfg.perContractDaily) no("此合約今日已達上限");
  // 免費 mint 的真實成本只有 gas：已花（含未對帳的預留）＋這筆預留 ≤ 每日預算。只有 exec.mjs 給這兩欄
  if (cfg.gasBudgetWei !== undefined || cfg.gasReserveWei !== undefined) {
    try {
      if (BigInt(ledger.gasWei ?? "0") + BigInt(cfg.gasReserveWei) > BigInt(cfg.gasBudgetWei)) no("已達每日 gas 預算");
    } catch { no("gas 預算格式錯"); }
  }

  return { ok: reasons.length === 0, reasons, requestId: reasons.length === 0 ? d.requestId : null };
}
