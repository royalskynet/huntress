// 每日一輪：meme-rush 找早期標的 → baw leaderboard alpha-radar 找持有的高勝率錢包 → 池子閘 → query-token-audit 閘 → 三行簡報推 TG。
// 只讀、不簽名、無 LLM。baw 子指令白名單：leaderboard。環境變數見 bin/launch.sh（BAW_BIN、TG_*）。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { notify } from "./notify.mjs";
import { extractRows, goodWallets, groupByToken, poolGate, auditGate, formatBrief } from "../lib/smartmoney.mjs";

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = join(ROOT, "vendor/binance-skills-hub/skills/binance-web3");
const STATE = process.env.STATE_DIR || join(ROOT, "state");
const CHAIN = "56";
const MAX_PAGES = 5;
const cfg = { minWinRate: 55, minWallets: 2, minLiquidityUsd: 5000, maxTaxPct: 5, maxBriefs: 5, ...JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8")).smartMoney };

async function memeRush(rankType) {
  const body = JSON.stringify({ chainId: CHAIN, rankType, limit: 50 });
  const { stdout } = await run("node", [join(SKILLS, "meme-rush/scripts/cli.mjs"), "meme-rush", body], { maxBuffer: 20e6, timeout: 60000 });
  const r = JSON.parse(stdout);
  if (r.code !== "000000" || !Array.isArray(r.data)) throw new Error(`meme-rush ${rankType}: ${r.code} ${r.message}`);
  return r.data;
}

async function alphaRadar(cas) {
  const bin = process.env.BAW_BIN || "node_modules/.bin/baw";
  const rows = [];
  for (let i = 0; i < cas.length; i += 20) {
    // 回應帶 pages（--page 從 0 起算）；最多讀 MAX_PAGES 頁，避免低估持有錢包數
    for (let page = 0, pages = 1; page < Math.min(pages, MAX_PAGES); page++) {
      const { stdout } = await run(bin, ["leaderboard", "alpha-radar", "-c", CHAIN, "-t", cas.slice(i, i + 20).join(","), "-m", "1", "-p", "7d", "--page", String(page), "--size", "20", "--json"], { cwd: ROOT, maxBuffer: 20e6, timeout: 60000 }).catch((e) => ({ stdout: e.stdout || "" }));
      const j = JSON.parse(stdout);
      rows.push(...extractRows(j));
      pages = Number(j.data?.pages) || 1;
    }
  }
  return rows;
}

async function audit(ca) {
  const res = await fetch("https://web3.binance.com/bapi/defi/v1/public/wallet-direct/security/token/audit", {
    method: "POST",
    headers: { "Content-Type": "application/json", source: "agent", "Accept-Encoding": "identity", "User-Agent": "binance-web3/1.4 (Skill)" },
    body: JSON.stringify({ binanceChainId: CHAIN, contractAddress: ca, requestId: randomUUID() }),
    signal: AbortSignal.timeout(20000),
  });
  return res.json();
}

export async function main() {
  mkdirSync(STATE, { recursive: true });
  const seenFile = join(STATE, "smartmoney-seen.json");
  let seen = {};
  try { seen = JSON.parse(readFileSync(seenFile, "utf8")); } catch {}
  const now = Date.now();
  for (const k of Object.keys(seen)) if (now - seen[k] > 7 * 864e5) delete seen[k];

  // 早期標的：10=剛發射、20=綁定曲線將滿（meme-rush rankType）
  const tokens = new Map();
  for (const rt of [10, 20]) for (const t of await memeRush(rt)) tokens.set(String(t.contractAddress).toLowerCase(), t);
  const pool = [...tokens.values()].filter((t) => poolGate(t, cfg).pass);

  // 未登入會在這裡丟 NOT_LOGGED_IN，不降級成「沒聰明錢也推」。
  const rows = pool.length ? await alphaRadar(pool.map((t) => t.contractAddress)) : [];
  const byToken = groupByToken(goodWallets(rows, cfg));

  const briefs = [];
  const stats = { memeRush: tokens.size, pool: pool.length, smart: 0, audited: 0, passed: 0 };
  for (const t of pool) {
    const ca = String(t.contractAddress).toLowerCase();
    const w = byToken.get(ca) || [];
    if (w.length < cfg.minWallets || seen[ca]) continue;
    stats.smart++;
    stats.audited++;
    let g;
    try { g = auditGate(await audit(t.contractAddress), cfg); } catch (e) { g = { pass: false, reasons: [`audit error ${e.message}`] }; }
    if (!g.pass) { console.log(`reject ${ca}: ${g.reasons.join("; ")}`); continue; }
    stats.passed++;
    briefs.push(formatBrief(t, w));
    seen[ca] = now;
    if (briefs.length >= cfg.maxBriefs) break;
  }
  console.log(JSON.stringify(stats));
  const text = briefs.length ? `聰明錢初篩（未簽任何交易，請自行確認）\n\n${briefs.join("\n\n")}` : "";
  if (text) { if (process.env.TG_DRY === "1") console.log(text); else await notify(text); }
  writeFileSync(seenFile, JSON.stringify(seen));
  return stats;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (e) => {
    console.error(`smartmoney fail: ${e.message}`);
    // 同一錯誤每天只告警一次，避免洗版
    const f = join(STATE, "smartmoney-alert.json");
    let last = {}; try { last = JSON.parse(readFileSync(f, "utf8")); } catch {}
    const key = e.message.slice(0, 80);
    if (last.key !== key || Date.now() - last.t > 864e5) {
      try { if (process.env.TG_DRY !== "1") await notify(`聰明錢監控失敗：${e.message}${/NOT_LOGGED_IN/.test(e.message) ? "\nbaw 需重新掃 QR 登入（baw auth signin）" : ""}`); } catch {}
      writeFileSync(f, JSON.stringify({ key, t: Date.now() }));
    }
    process.exit(3);
  });
}
