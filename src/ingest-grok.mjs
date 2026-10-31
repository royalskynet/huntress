// 收 Grok 每日掃描結果：grokbots-ops 裡標題 "agentid-grokscan" 的 open issue，內含 ```json {accounts, launches}
// accounts → state/x-extra.json（watch-x 併入輪流池）；launches → queue/x-<id>.json 交 triage（Grok 輸出不可信，照常過 triage＋exec 閘）
// 處理完留言並關 issue。用法：node src/ingest-grok.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const gh = process.env.GH_BIN || 'gh';
const repo = process.env.GROK_REPO || 'royalskynet/grokbots-ops';
const stateDir = process.env.STATE_DIR || 'state';
const queueDir = process.env.QUEUE_DIR || 'queue';
const MAX_NEW_ACC = 5, MAX_EXTRA = 30, MAX_LAUNCH = 30;
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(queueDir, { recursive: true });

const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const extraPath = path.join(stateDir, 'x-extra.json');
const seenPath = path.join(stateDir, 'seen-x.json');
const extra = readJson(extraPath, []);
const seen = new Set(readJson(seenPath, []));

const issues = JSON.parse(execFileSync(gh, ['issue', 'list', '-R', repo, '--state', 'open',
  '--search', 'agentid-grokscan in:title', '--json', 'number,title,body', '--limit', '10'], { encoding: 'utf8' }));

const out = { ok: true, issues: 0, accounts: [], launches: 0, rejected: 0 };
for (const is of issues) {
  if (!/^agentid-grokscan\b/.test(is.title)) continue;
  out.issues++;
  const m = /```json\s*([\s\S]*?)```/.exec(is.body || '');
  let data = null;
  try { data = m && JSON.parse(m[1]); } catch {}
  let note;
  if (!data || typeof data !== 'object') {
    note = 'ingest: 找不到可解析的 ```json 區塊，略過';
    out.rejected++;
  } else {
    let addAcc = 0, addL = 0;
    for (const a of (Array.isArray(data.accounts) ? data.accounts : [])) {
      const h = String(a?.handle ?? a ?? '').replace(/^@/, '');
      if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) { out.rejected++; continue; }
      if (extra.some(e => e.toLowerCase() === h.toLowerCase()) || addAcc >= MAX_NEW_ACC) continue;
      extra.push(h); out.accounts.push(h); addAcc++;
    }
    for (const l of (Array.isArray(data.launches) ? data.launches : []).slice(0, MAX_LAUNCH)) {
      const u = /^https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})$/.exec(String(l?.tweet ?? ''));
      if (!u) { out.rejected++; continue; }
      const [, author, id] = u;
      if (seen.has(id)) continue;
      seen.add(id);
      const text = [l.name, l.contract && `合約 ${l.contract}`, l.chainId && `chainId ${l.chainId}`, l.note]
        .filter(Boolean).map(String).join('\n').slice(0, 1000);
      fs.writeFileSync(path.join(queueDir, `x-${id}.json`), JSON.stringify({
        kind: 'unknown', source: 'x', via: 'grok',
        tweet: { id, text, url: `https://x.com/${author}/status/${id}`, author },
      }, null, 2));
      addL++; out.launches++;
    }
    note = `ingest: 新帳號 ${addAcc}、新盤 ${addL} 進 triage`;
  }
  while (extra.length > MAX_EXTRA) extra.shift();
  fs.writeFileSync(extraPath, JSON.stringify(extra, null, 2));
  fs.writeFileSync(seenPath, JSON.stringify([...seen], null, 2));
  execFileSync(gh, ['issue', 'close', String(is.number), '-R', repo, '-c', note]);
}
console.log(JSON.stringify(out));
