import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileP = promisify(execFile);

const STATE_DIR = process.env.STATE_DIR || "state";
const QUEUE_DIR = process.env.QUEUE_DIR || "queue";
const SEEN_FILE = path.join(STATE_DIR, "seen-memerush.json");
const CLI_PATH = new URL(
  "../vendor/skills-hub/skills/binance-web3/meme-rush/scripts/cli.mjs",
  import.meta.url,
).pathname;

const RANKS = [10, 20];

async function ensureDirs() {
  await mkdir(STATE_DIR, { recursive: true });
  await mkdir(QUEUE_DIR, { recursive: true });
}

async function loadSeen() {
  try {
    const raw = await readFile(SEEN_FILE, "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map((x) => String(x).toLowerCase()) : [];
  } catch {
    return [];
  }
}

async function saveSeen(seen) {
  await writeFile(SEEN_FILE, JSON.stringify(seen));
}

async function fetchRank(rankType) {
  const fixture = process.env.MEMERUSH_FIXTURE;
  if (fixture) {
    const raw = await readFile(fixture, "utf8");
    const json = JSON.parse(raw);
    return Array.isArray(json?.data) ? json.data : [];
  }
  const params = JSON.stringify({
    chainId: "56",
    rankType,
    protocol: [2004],
    tokenVersionFilter: { 2004: ["openfour.meme.AgentIdExclusive"] },
    limit: 50,
  });
  const { stdout } = await execFileP("node", [CLI_PATH, "meme-rush", params]);
  const json = JSON.parse(stdout);
  return Array.isArray(json?.data) ? json.data : [];
}

async function main() {
  await ensureDirs();
  const seen = new Set(await loadSeen());
  const seenArr = [...seen];
  const newCandidates = [];
  let totalNew = 0;

  for (const rankType of RANKS) {
    let tokens;
    try {
      tokens = await fetchRank(rankType);
    } catch (err) {
      const msg = (err?.stderr || err?.message || String(err)).trim();
      process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
      process.exit(1);
    }

    for (const token of tokens) {
      const addr = String(token?.contractAddress || "").toLowerCase();
      if (!addr) continue;
      if (seen.has(addr)) continue;
      seen.add(addr);
      seenArr.push(addr);
      totalNew++;
      newCandidates.push(addr);
      const queueFile = path.join(QUEUE_DIR, `memerush-${addr}.json`);
      await writeFile(
        queueFile,
        JSON.stringify({
          kind: "paid",
          source: "memerush",
          rankType,
          token,
        })
      );
    }
  }

  await saveSeen(seenArr);
  process.stdout.write(
    JSON.stringify({ ok: true, new: totalNew, candidates: newCandidates }) + "\n"
  );
}

main().catch((err) => {
  const msg = (err?.stderr || err?.message || String(err)).trim();
  process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
  process.exit(1);
});
