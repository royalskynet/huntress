import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const QUEUE_DIR = process.env.QUEUE_DIR || "queue";

function readJsonFile(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

export async function fetchAudit(chainId, contract) {
  if (process.env.AUDIT_FIXTURE) {
    try {
      const raw = readJsonFile(process.env.AUDIT_FIXTURE);
      if (raw?.code && raw.code !== "000000") {
        return { ok: false, error: `code ${raw.code}` };
      }
      if (!raw?.data) return { ok: false, error: "no data" };
      return { ok: true, data: raw.data };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }
  try {
    const res = await fetch("https://web3.binance.com/bapi/defi/v1/public/wallet-direct/security/token/audit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept-Encoding": "identity",
        "User-Agent": "binance-web3/1.4 (Skill)",
        "source": "agent",
      },
      body: JSON.stringify({
        binanceChainId: String(chainId),
        contractAddress: contract,
        requestId: crypto.randomUUID(),
      }),
    });
    const raw = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    if (!raw || raw.code !== "000000" || !raw.data) {
      return { ok: false, error: (raw && (raw.message || raw.code)) || "request failed" };
    }
    if (raw.data.hasResult === false || raw.data.isSupported === false) {
      return { ok: false, error: "audit data unavailable" };
    }
    return { ok: true, data: raw.data };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function fetchInfo(chainId, contract) {
  if (process.env.INFO_FIXTURE) {
    try {
      const raw = readJsonFile(process.env.INFO_FIXTURE);
      if (raw?.code && raw.code !== "000000") {
        return { ok: false, error: `code ${raw.code}` };
      }
      if (!raw?.data) return { ok: false, error: "no data" };
      return { ok: true, data: raw.data };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }
  try {
    const url = `https://web3.binance.com/bapi/defi/v4/public/wallet-direct/buw/wallet/market/token/dynamic/info/ai?chainId=${encodeURIComponent(chainId)}&contractAddress=${encodeURIComponent(contract)}`;
    const res = await fetch(url, {
      headers: {
        "Accept-Encoding": "identity",
        "User-Agent": "binance-web3/2.0 (Skill)",
      },
    });
    const raw = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    if (!raw || raw.code !== "000000" || !raw.data) {
      return { ok: false, error: (raw && (raw.message || raw.code)) || "request failed" };
    }
    return { ok: true, data: raw.data };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export function findDetail(data, pattern) {
  const items = Array.isArray(data?.riskItems) ? data.riskItems : [];
  for (const cat of items) {
    const details = Array.isArray(cat?.details) ? cat.details : [];
    for (const d of details) {
      if (pattern.test(String(d?.title || ""))) return d;
    }
  }
  return null;
}

function str(v) {
  if (v === null || v === undefined || v === "") return "未知";
  return String(v);
}

function pct(v) {
  if (v === null || v === undefined || v === "") return "未知";
  return `${v}%`;
}

// 實回是小數（0.02＝2%）；舊 fixture 是百分比（5＝5%）
function taxRate(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const p = n <= 1 ? n * 100 : n;
  return Number(p.toFixed(2));
}

function taxText(v) {
  const n = taxRate(v);
  return n === null ? "未知" : `${n}%`;
}

function roundTrip(buy, sell) {
  const b = taxRate(buy);
  const s = taxRate(sell);
  if (b === null || s === null) return "未知";
  return `${Number(((1 - (1 - b / 100) * (1 - s / 100)) * 100).toFixed(2))}%`;
}

const PERMISSIONS = [
  ["可改稅", /modifiable tax/i],
  ["黑名單", /blacklist/i],
  ["可暫停交易", /trading suspension/i],
  ["可凍結帳戶", /freez/i],
  ["可改餘額", /balance manipulation/i],
  ["自毀", /self-destruct/i],
  ["賣出限制", /sale restriction/i],
  ["可升級", /upgrade/i],
  ["白名單", /whitelist/i],
  ["冷卻限制", /cooling-off/i],
];

const PERM_AVOID = ["可改稅", "黑名單", "可暫停交易", "可凍結帳戶", "可改餘額", "自毀", "賣出限制"];
const PERM_WATCH = ["可升級", "白名單", "冷卻限制"];

function permissionState(data, pattern) {
  const d = findDetail(data, pattern);
  if (!d) return "未知";
  return d.isHit ? "有" : "無";
}

function permissionStates(data) {
  const out = {};
  for (const [name, pattern] of PERMISSIONS) out[name] = permissionState(data, pattern);
  return out;
}

function verifyState(v) {
  if (v === true) return "是";
  if (v === false) return "否";
  return "未知";
}

function top10Value(info) {
  const v = info?.top10HoldersPercentage ?? info?.holdersTop10Percent;
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const queueFile = process.argv[2];
  if (!queueFile) {
    process.stderr.write("missing queue file\n");
    process.exit(1);
  }
  const q = readJsonFile(queueFile);
  const token = q?.token || {};
  const contract = String(token.contractAddress || "");
  const symbol = String(token.symbol || "");
  const chainId = token.chainId || "56";

  const lower = contract.toLowerCase();
  const auditRes = await fetchAudit(chainId, contract);
  const infoRes = await fetchInfo(chainId, contract);

  const lines = [];
  lines.push(`## ${symbol} ${contract}`);
  lines.push("");

  // 安全
  lines.push("### 安全");
  if (!auditRes.ok) {
    lines.push(`取得失敗：${auditRes.error}`);
  } else {
    const d = auditRes.data;
    const hp = findDetail(d, /honeypot/i);
    const honeypot = hp ? (hp.isHit ? "是" : "否") : "未知";
    const mt = findDetail(d, /mint(?:able|ing)/i);
    const mintable = mt ? (mt.isHit ? "是" : "否") : "未知";
    const riskLevel = d?.riskLevelEnum ?? d?.riskLevel;
    lines.push(`- 蜜罐：${honeypot}`);
    lines.push(`- 可增發：${mintable}`);
    lines.push(`- 風險等級：${riskLevel === null || riskLevel === undefined || riskLevel === "" ? "未知" : riskLevel}`);
  }
  lines.push("");

  // 費用
  lines.push("### 費用");
  if (!auditRes.ok) {
    lines.push(`取得失敗：${auditRes.error}`);
  } else {
    const d = auditRes.data;
    const buyTax = d?.extraInfo?.buyTax;
    const sellTax = d?.extraInfo?.sellTax;
    lines.push(`- 買稅：${taxText(buyTax)}`);
    lines.push(`- 賣稅：${taxText(sellTax)}`);
    lines.push(`- 來回稅損：約 ${roundTrip(buyTax, sellTax)}`);
    lines.push("- 本金由 /buy 時自訂，內盤買賣各一筆 gas 另計");
  }
  lines.push("");

  // 合約權限
  lines.push("### 合約權限");
  if (!auditRes.ok) {
    lines.push(`取得失敗：${auditRes.error}`);
  } else {
    const d = auditRes.data;
    const states = permissionStates(d);
    for (const [name] of PERMISSIONS) lines.push(`- ${name}：${states[name]}`);
    lines.push(`- 原始碼已驗證：${verifyState(d?.extraInfo?.isVerified)}`);
  }
  lines.push("");

  // 鏈上
  lines.push("### 鏈上");
  if (!infoRes.ok) {
    lines.push(`取得失敗：${infoRes.error}`);
  } else {
    const d = infoRes.data;
    lines.push(`- 流動性：${str(d?.liquidity)}`);
    lines.push(`- 市值：${str(d?.marketCap)}`);
    lines.push(`- 持幣人數：${str(d?.holders)}`);
    lines.push(`- 前十大占比：${d?.top10HoldersPercentage === null || d?.top10HoldersPercentage === undefined || d?.top10HoldersPercentage === "" ? "未知" : `${d.top10HoldersPercentage}%`}`);
    lines.push(`- 曲線進度：${str(d?.progress)}`);
  }
  lines.push("");

  // 判定
  lines.push("### 判定");
  let verdict = "觀望";
  let reason = "資料不足，建議觀望";
  if (!auditRes.ok || !infoRes.ok) {
    verdict = "觀望";
    reason = "資料取得失敗";
  } else {
    const a = auditRes.data;
    const i = infoRes.data;
    const hp = findDetail(a, /honeypot/i);
    const isHoneypot = !!(hp && hp.isHit);
    const mt = findDetail(a, /mint(?:able|ing)/i);
    const isMintable = !!(mt && mt.isHit);
    const t10 = top10Value(i);
    const top10Over = t10 !== null && t10 > 50;
    const states = permissionStates(a);
    const allPerms = PERMISSIONS.map(([n]) => n);
    const avoidPerms = PERM_AVOID.filter((n) => states[n] === "有");
    const watchPerms = PERM_WATCH.filter((n) => states[n] === "有");
    const unknownPerms = allPerms.filter((n) => states[n] === "未知");
    const verified = verifyState(a?.extraInfo?.isVerified);
    if (isHoneypot) {
      verdict = "避開";
      reason = "偵測到蜜罐";
    } else if (isMintable) {
      verdict = "避開";
      reason = "代幣可增發";
    } else if (top10Over) {
      verdict = "避開";
      reason = "前十大持幣占比超過 50%";
    } else if (avoidPerms.length) {
      verdict = "避開";
      reason = `合約權限：${avoidPerms.join("、")}`;
    } else if (unknownPerms.length) {
      verdict = "觀望";
      reason = "合約權限資料不全";
    } else if (watchPerms.length) {
      verdict = "觀望";
      reason = `合約權限：${watchPerms.join("、")}`;
    } else if (verified === "否") {
      verdict = "觀望";
      reason = "原始碼未驗證";
    } else {
      const rl = a?.riskLevelEnum ?? a?.riskLevel;
      const high = (typeof rl === "string" && /high/i.test(rl)) || (typeof rl === "number" && rl >= 4);
      if (high) {
        verdict = "觀望";
        reason = "風險等級偏高";
      } else if (t10 === null || i?.holders == null || i?.liquidity == null) {
        // 資料不全就不算可考慮（10-28 兩份可考慮都是欄位未知漏過來的）
        verdict = "觀望";
        reason = "鏈上資料不全";
      } else {
        verdict = "可考慮";
        reason = "未偵測到重大風險";
      }
    }
  }
  lines.push(`${verdict}：${reason}`);

  const md = lines.join("\n") + "\n";

  const dir = QUEUE_DIR;
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, `brief-${lower}.md`);
  writeFileSync(outPath, md);
  process.stdout.write(md);
}

// autotrade.mjs 會 import fetchAudit；只有直接執行才跑 main
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write((e?.message || String(e)) + "\n");
    process.exit(1);
  });
}
