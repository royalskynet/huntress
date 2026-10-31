// 輪流池自動淘汰：state/x-extra.json（Grok 找到的帳號）7 天沒出新盤就移除。config.x.accounts 手動清單不動。
// 「出新盤」＝該帳號推文被 triage 判成 free／paid（queue/**/cand-*.json）；時間取推文 id（snowflake）
// 加入時間記在 state/x-extra-meta.json；被移除後 Grok 又找回來＝重新加入，重新起算 7 天
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const TTL_MS = 7 * 24 * 3600e3;
const snowflakeMs = (id) => { try { return Number((BigInt(id) >> 22n) + 1288834974657n); } catch { return 0; } };

export function lastHits(queueDir) {
  const hits = {};
  for (const dir of [queueDir, path.join(queueDir, 'done'), path.join(queueDir, 'paid')]) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /^cand-.*\.json$/.test(f)); } catch {}
    for (const f of files) {
      let c;
      try { c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      if (c?.kind !== 'free' && c?.kind !== 'paid') continue;
      const m = /^https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/.exec(String(c?.tweet?.url ?? ''));
      if (!m) continue;
      const h = m[1].toLowerCase();
      hits[h] = Math.max(hits[h] ?? 0, snowflakeMs(m[2]));
    }
  }
  return hits;
}

export function prune(extra, meta, hits, now) {
  const keep = [], removed = [];
  const next = { ...meta };
  for (const h of extra) {
    const k = h.toLowerCase();
    let m = next[k];
    if (!m || m.removedAt) m = next[k] = { addedAt: now };
    if (now - Math.max(m.addedAt, hits[k] ?? 0) > TTL_MS) { removed.push(h); next[k] = { ...m, removedAt: now }; }
    else keep.push(h);
  }
  return { keep, removed, meta: next };
}

const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const stateDir = process.env.STATE_DIR || 'state';
  const queueDir = process.env.QUEUE_DIR || 'queue';
  const extraPath = path.join(stateDir, 'x-extra.json');
  const metaPath = path.join(stateDir, 'x-extra-meta.json');
  const read = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
  const extra = read(extraPath, []);
  const r = prune(Array.isArray(extra) ? extra : [], read(metaPath, {}), lastHits(queueDir), Date.now());
  fs.writeFileSync(metaPath, JSON.stringify(r.meta, null, 2));
  if (r.removed.length) fs.writeFileSync(extraPath, JSON.stringify(r.keep, null, 2));
  console.log(JSON.stringify({ ok: true, kept: r.keep.length, removed: r.removed }));
}
