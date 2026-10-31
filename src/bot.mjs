import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

function taipeiDate() {
  const t = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, "0");
  const d = String(t.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function truncate(text) {
  const s = String(text ?? "");
  if (s.length > 4000) return s.slice(0, 4000) + "…";
  return s;
}

function apiBase() {
  return process.env.TG_API || "https://api.telegram.org";
}

function defaultStateDir() {
  return process.env.STATE_DIR || "state";
}

function defaultDeps() {
  const stateDir = defaultStateDir();
  return {
    stateDir,
    send: async (text, keyboard) => {
      const url = `${apiBase()}/bot${process.env.TG_BOT_TOKEN}/sendMessage`;
      const payload = {
        chat_id: process.env.TG_CHAT_ID,
        text: truncate(text),
        disable_web_page_preview: true,
      };
      if (keyboard) payload.reply_markup = keyboard;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (!res.ok || !data || data.ok !== true) {
        const msg = (data && (data.description || data.error)) || res.statusText || "request failed";
        throw new Error(msg);
      }
      return data;
    },
    answerCallback: async (id, text) => {
      const url = `${apiBase()}/bot${process.env.TG_BOT_TOKEN}/answerCallbackQuery`;
      const payload = { callback_query_id: id };
      if (text != null) payload.text = text;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (!res.ok || !data || data.ok !== true) {
        const msg = (data && (data.description || data.error)) || res.statusText || "request failed";
        throw new Error(msg);
      }
      return data;
    },
    runBuy: async (args) => {
      const r = spawnSync("node", ["src/buy.mjs", ...args], { encoding: "utf8" });
      if (r.status !== 0) throw new Error((r.stderr || "").trim() || `buy exited ${r.status}`);
      return JSON.parse(String(r.stdout || "").trim());
    },
    runSell: async (args) => {
      const r = spawnSync("node", ["src/sell.mjs", ...args], { encoding: "utf8" });
      if (r.status !== 0) throw new Error((r.stderr || "").trim() || `sell exited ${r.status}`);
      return JSON.parse(String(r.stdout || "").trim());
    },
    runRevoke: async (args) => {
      const r = spawnSync("node", ["src/revoke.mjs", ...args], { encoding: "utf8" });
      if (r.status !== 0) throw new Error((r.stderr || "").trim() || `revoke exited ${r.status}`);
      return JSON.parse(String(r.stdout || "").trim());
    },
    runAsk: async (q) => {
      const r = spawnSync("node", ["src/ask.mjs", String(q)], { encoding: "utf8" });
      if (r.status !== 0) throw new Error((r.stderr || "").trim() || `ask exited ${r.status}`);
      return String(r.stdout || "").trim();
    },
  };
}

const TG_CHAT_ID = () => process.env.TG_CHAT_ID;

export async function handleUpdate(update, deps = defaultDeps()) {
  const target = TG_CHAT_ID();
  let chatId = null;
  let fromId = null;
  let callback = null;
  let text = null;

  if (update && update.message) {
    chatId = update.message.chat && update.message.chat.id;
    fromId = update.message.from && update.message.from.id;
    text = update.message.text;
  } else if (update && update.callback_query) {
    const cq = update.callback_query;
    chatId = cq.message && cq.message.chat && cq.message.chat.id;
    fromId = cq.from && cq.from.id;
    callback = cq;
  } else {
    return;
  }

  if (String(chatId) !== String(target) || String(fromId) !== String(target)) return;

  if (callback) {
    const id = callback.id;
    const data = callback.data;
    const m = typeof data === "string" ? data.match(/^(b|x|s|y|r):([0-9a-f]{32})$/) : null;
    if (!m) {
      await deps.answerCallback(id);
      return;
    }
    const kind = m[1];
    const nonce = m[2];
    await deps.answerCallback(id);
    if (kind === "r") {
      let res;
      try { res = await deps.runRevoke(["confirm", nonce]); } catch (e) { res = { ok: false, reasons: [e && e.message ? e.message : String(e)] }; }
      const msg = res && res.ok
        ? `✅ 已撤授權 ${res.txHash ?? ""}`.trim()
        : `❌ 撤授權失敗：${res && res.reasons ? res.reasons.join(", ") : "失敗"}`;
      await deps.send(msg);
      return;
    }
    let result;
    if (kind === "b") result = await deps.runBuy(["confirm", nonce]);
    else if (kind === "x") result = await deps.runBuy(["cancel", nonce]);
    else if (kind === "s") result = await deps.runSell(["confirm", nonce]);
    else result = await deps.runSell(["cancel", nonce]);
    let msg;
    if (result && result.ok) {
      if (result.txHash) {
        const revokeText = result.revoked === true ? "已撤授權" : (result.revoked === false ? "⚠️ 授權未撤，請到 App 撤銷" : "");
        msg = `✅ ${result.txHash}${revokeText ? "（" + revokeText + "）" : ""}`;
      } else {
        msg = "✅ 完成";
      }
    } else {
      msg = `❌ ${(result && result.reasons ? result.reasons.join(", ") : "失敗")}`;
      // 賣單失敗也可能留著授權（撤銷也失敗時），要講
      if (result && result.revoked === false) msg += "\n⚠️ 授權未撤，請到 App 撤銷";
    }
    await deps.send(msg);
    return;
  }

  if (typeof text !== "string") return;
  const t = text.trim();

  if (t === "/status") {
    const stateDir = deps.stateDir;
    const paused = existsSync(join(stateDir, "PAUSED"));
    let ledgerTotal = 0;
    try {
      const raw = JSON.parse(readFileSync(join(stateDir, `ledger-${taipeiDate()}.json`), "utf8"));
      if (raw && typeof raw.total !== "undefined") ledgerTotal = raw.total;
    } catch {}
    let buyTotal = 0;
    let spentWei = 0;
    try {
      const raw = JSON.parse(readFileSync(join(stateDir, `buy-${taipeiDate()}.json`), "utf8"));
      if (raw) {
        if (typeof raw.total !== "undefined") buyTotal = raw.total;
        if (typeof raw.spentWei !== "undefined") spentWei = raw.spentWei;
      }
    } catch {}
    const status = paused ? "暫停中" : "運作中";
    await deps.send(`狀態：${status}\nledger total: ${ledgerTotal}\nbuy total: ${buyTotal}\nspentWei: ${spentWei}`);
    return;
  }

  if (t === "/pause") {
    mkdirSync(deps.stateDir, { recursive: true });
    writeFileSync(join(deps.stateDir, "PAUSED"), "");
    return;
  }

  if (t === "/resume") {
    try { unlinkSync(join(deps.stateDir, "PAUSED")); } catch {}
    return;
  }

  // /buy <候選 id> <BNB>：金額由使用者打，LLM 不碰；上限由 buy.mjs 寫死
  const buy = t.match(/^\/buy\s+([0-9]{1,25})\s+([0-9]+(?:\.[0-9]{1,18})?)$/);
  if (buy) {
    const candPath = join(deps.paidDir || process.env.PAID_DIR || "queue/paid", `cand-${buy[1]}.json`);
    if (!existsSync(candPath)) {
      await deps.send(`找不到候選 ${buy[1]}`);
      return;
    }
    await offerCand(deps, candPath, bnbToWei(buy[2]), `確認以 ${buy[2]} BNB mint 候選 ${buy[1]}？`);
    return;
  }

  const sell = t.match(/^\/sell\s+([0-9a-f]{8})$/);
  if (sell) {
    let res;
    try {
      res = await deps.runSell(["prepare", sell[1]]);
    } catch (e) {
      await deps.send(`拒絕：${e && e.message ? e.message : String(e)}`);
      return;
    }
    if (res && res.ok) {
      const priceUsdt = weiToUsdt(res.priceWei);
      const lines = [
        `tokenId: ${res.tokenId}`,
        `bid #${res.bidId}`,
        `出價: ${priceUsdt} USDT`,
        `fee: ${res.feeBps} bps`,
        res.needApprove ? "需先授權" : "已授權",
        "賣完會自動撤授權",
      ];
      const keyboard = {
        inline_keyboard: [[
          { text: "✅ 賣出", callback_data: "s:" + res.nonce },
          { text: "❌ 取消", callback_data: "y:" + res.nonce },
        ]],
      };
      await deps.send(lines.join("\n"), keyboard);
    } else {
      const reasons = res && res.reasons ? res.reasons : ["拒絕"];
      await deps.send(`拒絕：${reasons.join(", ")}`);
    }
    return;
  }

  // /revoke：列出未撤授權，每筆一顆按鈕，按下才撤
  if (t === "/revoke") {
    let res;
    try {
      res = await deps.runRevoke(["prepare"]);
    } catch (e) {
      await deps.send(`拒絕：${e && e.message ? e.message : String(e)}`);
      return;
    }
    const items = res && res.ok && Array.isArray(res.items) ? res.items : [];
    if (!res || !res.ok) {
      await deps.send(`❌ ${res && res.reasons ? res.reasons.join(", ") : "取不到未撤授權"}`);
      return;
    }
    if (items.length === 0) {
      await deps.send("沒有未撤授權");
      return;
    }
    const infinite = 2n ** 255n;
    const lines = [`🔓 有 ${items.length} 筆未撤授權`];
    const keyboard = { inline_keyboard: [] };
    items.forEach((it, i) => {
      let amount;
      if (it.kind === "all") amount = "全部 NFT";
      else {
        let v = 0n;
        try { v = BigInt(it.amount); } catch {}
        amount = v >= infinite ? "無限" : String(it.amount);
      }
      lines.push(`${it.token} → ${it.spender} ${amount}`);
      keyboard.inline_keyboard.push([{ text: `🔓 撤 #${i + 1}`, callback_data: `r:${it.nonce}` }]);
    });
    await deps.send(lines.join("\n"), keyboard);
    return;
  }

  if (t.startsWith("/")) {
    return;
  }

  const reply = await deps.runAsk(t);
  await deps.send(reply);
}

async function poll() {
  const deps = defaultDeps();
  const stateDir = deps.stateDir;
  let offset = 0;
  try {
    offset = Number(readFileSync(join(stateDir, "tg-offset"), "utf8").trim()) || 0;
  } catch {}
  while (true) {
    try {
      const url = `${apiBase()}/bot${process.env.TG_BOT_TOKEN}/getUpdates?timeout=50&offset=${offset}`;
      const res = await fetch(url);
      const data = await res.json();
      const updates = (data && Array.isArray(data.result)) ? data.result : [];
      for (const u of updates) {
        try {
          await handleUpdate(u, deps);
        } catch (e) {
          process.stderr.write((e && e.message ? e.message : String(e)) + "\n");
        }
        offset = u.update_id + 1;
        try {
          mkdirSync(stateDir, { recursive: true });
          writeFileSync(join(stateDir, "tg-offset"), String(offset));
        } catch {}
      }
    } catch (e) {
      process.stderr.write((e && e.message ? e.message : String(e)) + "\n");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

export function weiToUsdt(wei) {
  const b = BigInt(wei ?? "0");
  const whole = b / 10n ** 18n;
  const frac = b % 10n ** 18n;
  let fracStr = frac.toString().padStart(18, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : String(whole);
}

export function bnbToWei(s) {
  const [i, f = ""] = String(s).split(".");
  return (BigInt(i) * 10n ** 18n + BigInt(f.padEnd(18, "0") || "0")).toString();
}

async function offer() {
  await offerCand(defaultDeps(), process.argv[3], process.argv[4], process.argv.slice(5).join(" "));
}

async function offerCand(deps, candPath, valueWei, desc) {
  let res;
  try {
    res = await deps.runBuy(["prepare", candPath, valueWei]);
  } catch (e) {
    await deps.send(`拒絕：${e && e.message ? e.message : String(e)}`);
    return;
  }
  if (res && res.ok) {
    const nonce = res.nonce;
    const keyboard = {
      inline_keyboard: [[
        { text: "✅ 確認", callback_data: "b:" + nonce },
        { text: "❌ 取消", callback_data: "x:" + nonce },
      ]],
    };
    await deps.send(desc || "確認購買", keyboard);
  } else {
    const reasons = res && res.reasons ? res.reasons : ["拒絕"];
    await deps.send(`拒絕：${reasons.join(", ")}`);
  }
}

const isMain =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const cmd = process.argv[2];
  if (cmd === "poll") {
    poll().catch((e) => {
      process.stderr.write((e && e.message ? e.message : String(e)) + "\n");
      process.exit(1);
    });
  } else if (cmd === "offer") {
    offer().then(() => process.exit(0)).catch((e) => {
      process.stderr.write((e && e.message ? e.message : String(e)) + "\n");
      process.exit(1);
    });
  }
}
