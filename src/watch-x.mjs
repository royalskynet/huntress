import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const configPath = process.env.CONFIG || 'config.json';
let config = {};
try {
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
} catch (e) {
  // ignore
}

const queries = config?.x?.queries || [];
// priority（整理新盤的帳號）每輪必查；accounts 每輪輪流查 accountsPerRun 個，降低 X 429
const priority = config?.x?.priority || [];
const stateDirEarly = process.env.STATE_DIR || 'state';
let extraAcc = [];
try { extraAcc = JSON.parse(fs.readFileSync(path.join(stateDirEarly, 'x-extra.json'), 'utf8')); } catch {}
// x-extra.json＝Grok 每日掃描找到的新帳號（src/ingest-grok.mjs 寫入），併入輪流池
const pool = [...new Set([...(config?.x?.accounts || []), ...(Array.isArray(extraAcc) ? extraAcc : [])])];
const twitterBin = process.env.TWITTER_BIN || '/Users/you/.local/bin/twitter';
const stateDir = process.env.STATE_DIR || 'state';
const queueDir = process.env.QUEUE_DIR || 'queue';

fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(queueDir, { recursive: true });

const rotPath = path.join(stateDir, 'x-rot.txt');
const per = Number(config?.x?.accountsPerRun) || pool.length;
let rot = 0;
try { rot = Number(fs.readFileSync(rotPath, 'utf8')) || 0; } catch {}
const picked = pool.length ? Array.from({ length: Math.min(per, pool.length) }, (_, i) => pool[(rot + i) % pool.length]) : [];
fs.writeFileSync(rotPath, String((rot + picked.length) % (pool.length || 1)));
const accounts = [...priority, ...picked];

const seenFilePath = path.join(stateDir, 'seen-x.json');
let seenIds = [];
try {
  if (fs.existsSync(seenFilePath)) {
    const data = JSON.parse(fs.readFileSync(seenFilePath, 'utf8'));
    if (Array.isArray(data)) {
      seenIds = data;
    }
  }
} catch (e) {
  seenIds = [];
}
const seenSet = new Set(seenIds);

const pattern = /free mint|0元|0\s*元|免费铸造|免費鑄造|免费mint|白嫖|proof of agent|agent id/i;

const errors = [];
const allTweets = [];

for (const q of queries) {
  try {
    const cmd = `"${twitterBin}" search ${JSON.stringify(q)} --max 20 --json`;
    const stdout = execSync(cmd, { encoding: 'utf8' });
    const parsed = JSON.parse(stdout.trim());
    const data = Array.isArray(parsed?.data) ? parsed.data : (Array.isArray(parsed) ? parsed : []);
    for (const t of data) {
      if (t && t.id) allTweets.push(t);
    }
  } catch (err) {
    errors.push({ type: 'search', query: q, error: err.message });
  }
}

for (const acc of accounts) {
  try {
    const cmd = `"${twitterBin}" user-posts ${JSON.stringify(acc)} --max 10 --json`;
    const stdout = execSync(cmd, { encoding: 'utf8' });
    const parsed = JSON.parse(stdout.trim());
    const data = Array.isArray(parsed?.data) ? parsed.data : (Array.isArray(parsed) ? parsed : []);
    for (const t of data) {
      if (t && t.id) allTweets.push(t);
    }
  } catch (err) {
    errors.push({ type: 'user-posts', account: acc, error: err.message });
  }
}

const newIds = [];

for (const tweet of allTweets) {
  const id = String(tweet.id);
  if (seenSet.has(id)) continue;

  const text = typeof tweet.text === 'string' ? tweet.text : '';
  if (!pattern.test(text)) continue;

  seenSet.add(id);
  newIds.push(id);

  const authorObj = tweet.author;
  const screenName = (typeof authorObj === 'object' && authorObj !== null)
    ? (authorObj.screenName || authorObj.name || 'unknown')
    : (authorObj || 'unknown');

  const queueObj = {
    kind: "unknown",
    source: "x",
    tweet: {
      id: tweet.id,
      text: tweet.text,
      url: `https://x.com/${screenName}/status/${tweet.id}`,
      author: screenName,
      createdAt: tweet.createdAt
    }
  };

  const queueFilePath = path.join(queueDir, `x-${tweet.id}.json`);
  fs.writeFileSync(queueFilePath, JSON.stringify(queueObj, null, 2), 'utf8');
}

try {
  fs.writeFileSync(seenFilePath, JSON.stringify(Array.from(seenSet), null, 2), 'utf8');
} catch (e) {
  // ignore
}

const output = {
  ok: true,
  new: newIds.length,
  ids: newIds
};
if (errors.length > 0) {
  output.errors = errors;
}
console.log(JSON.stringify(output));
