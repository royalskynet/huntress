// Flap 回溫監看（零 token，launchd 每 30 分鐘）：讀全部盤，出現「新畢業」或「BNB 曲線盤進度首次 ≥ 門檻」才推 TG。
// 第一輪只建基準不推（fix 11526：既有狀態不算新事件）。只寫地址，不寫代幣名。
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { READER, parsePage, parseDetail, encPage, encDetail } from "./flap.mjs";

const ZERO = "0x0000000000000000000000000000000000000000";
const PAGE = 16; // Reader 上限，超過 revert「page limit」

// 純函式：比對上一輪基準，回傳新事件與新基準
export function diffWatch(prev, rows, minBps = 300) {
  const grad = rows.filter((r) => r.phase === 3).map((r) => r.m);
  const hot = rows.filter((r) => r.phase === 1 && r.quoteToken === ZERO && r.progressBps >= minBps).map((r) => r.m);
  const next = { grad: [...new Set([...(prev?.grad ?? []), ...grad])], hot: [...new Set([...(prev?.hot ?? []), ...hot])], total: rows.length };
  if (!prev) return { events: [], next };
  const g = new Set(prev.grad), h = new Set(prev.hot);
  const events = [
    ...grad.filter((m) => !g.has(m)).map((m) => `🎓 新畢業 ${m}`),
    ...hot.filter((m) => !h.has(m)).map((m) => `🔥 BNB 盤進度 ≥${minBps / 100}%：${m}（${(rows.find((r) => r.m === m).progressBps / 100).toFixed(2)}%）`),
  ];
  return { events, next };
}

export function scan(call) {
  const ms = [];
  for (let cur = 0; ; cur += PAGE) {
    const p = parsePage(call(READER, encPage(cur, PAGE)));
    ms.push(...p.markets);
    if (!p.markets.length || ms.length >= p.total) break;
  }
  return ms.map((m) => ({ m, ...parseDetail(call(READER, encDetail(m))) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { spawnSync } = await import("node:child_process");
  const { notify } = await import("./notify.mjs");
  const rpc = process.env.FLAP_RPC || "https://bsc-rpc.publicnode.com";
  const stateDir = process.env.STATE_DIR || "state", logDir = process.env.LOG_DIR || "logs";
  mkdirSync(stateDir, { recursive: true });
  const sp = join(stateDir, "flap-watch.json");
  const log = (m) => appendFileSync(join(logDir, "run.log"), `${new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace("T", " ")} ${m}\n`);
  const call = (to, data) => {
    const r = spawnSync("cast", ["call", "--rpc-url", rpc, to, data], { encoding: "utf8" });
    if (r.status !== 0) throw new Error((r.stderr || "").trim() || `exit ${r.status}`);
    return r.stdout.trim();
  };
  let prev = null;
  try { prev = JSON.parse(readFileSync(sp, "utf8")); } catch {}
  let rows;
  try { rows = scan(call); } catch (e) { log(`flap watch 讀鏈失敗：${e.message.slice(0, 120)}`); process.exit(1); }
  const { events, next } = diffWatch(prev, rows, Number(process.env.FLAP_WATCH_BPS || 300));
  writeFileSync(sp, JSON.stringify(next));
  log(`flap watch ${rows.length} 盤：畢業 ${next.grad.length}、熱盤 ${next.hot.length}、新事件 ${events.length}${prev ? "" : "（首輪建基準）"}`);
  if (events.length) await notify(`📈 Flap 回溫訊號（共 ${rows.length} 盤）\n${events.join("\n")}\n要重開影子跑再說一聲`);
}
