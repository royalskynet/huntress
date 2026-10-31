import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prune, lastHits, TTL_MS } from '../src/prune-extra.mjs';

const NOW = 1793250000000;
const DAY = 24 * 3600e3;
// 推文 id 由時間反推（snowflake）
const idAt = (ms) => ((BigInt(ms) - 1288834974657n) << 22n).toString();

test('lastHits 只算 free／paid，取最新推文時間、帳號不分大小寫', () => {
  const q = mkdtempSync(join(tmpdir(), 'pq-'));
  mkdirSync(join(q, 'done'));
  const w = (f, kind, h, ms) => writeFileSync(join(q, 'done', f), JSON.stringify({ kind, tweet: { url: `https://x.com/${h}/status/${idAt(ms)}` } }));
  w('cand-1.json', 'free', 'Kobe', NOW - 3 * DAY);
  w('cand-2.json', 'paid', 'kobe', NOW - 1 * DAY);
  w('cand-3.json', 'skip', 'Skipper', NOW);
  const h = lastHits(q);
  assert.ok(Math.abs(h.kobe - (NOW - DAY)) < 1000);
  assert.equal(h.skipper, undefined);
});

test('新帳號有 7 天寬限；超過 7 天沒出盤才移除；出過盤從那時起算', () => {
  const extra = ['New', 'Old', 'Hit', 'Stale'];
  const meta = { old: { addedAt: NOW - 8 * DAY }, hit: { addedAt: NOW - 30 * DAY }, stale: { addedAt: NOW - 30 * DAY } };
  const hits = { hit: NOW - 2 * DAY, stale: NOW - 8 * DAY };
  const r = prune(extra, meta, hits, NOW);
  assert.deepEqual(r.keep, ['New', 'Hit']);
  assert.deepEqual(r.removed, ['Old', 'Stale']);
  assert.equal(r.meta.new.addedAt, NOW);
  assert.equal(r.meta.old.removedAt, NOW);
});

test('移除後被 Grok 加回來：重新起算，不會立刻再刪', () => {
  const meta = { old: { addedAt: NOW - 30 * DAY, removedAt: NOW - DAY } };
  const r = prune(['Old'], meta, {}, NOW);
  assert.deepEqual(r.keep, ['Old']);
  assert.equal(r.meta.old.addedAt, NOW);
  assert.equal(r.meta.old.removedAt, undefined);
  assert.ok(TTL_MS === 7 * DAY);
});
