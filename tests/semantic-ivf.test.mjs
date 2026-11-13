import test from 'node:test';
import assert from 'node:assert/strict';
import { rankChunks } from '../semantic-core.mjs';
import { buildIvf, searchIvf, indexKey } from '../semantic-ivf.mjs';
const unit = v => { const n = Math.hypot(...v); return Float32Array.from(v, x => x / n); };
function fixture(n = 600) {
  return Array.from({ length: n }, (_, i) => ({ id: String(i), fingerprint: `v1-${i}`, vectors: [unit(Array.from({ length: 16 }, (_, d) => d === i % 8 ? 1 : 0.015 * Math.sin(i * 17 + d)))] }));
}
test('small and empty collections retain exact ranking', async () => {
  const entries = fixture(20), q = entries[5].vectors[0];
  assert.equal(await buildIvf(entries), null);
  assert.deepEqual(searchIvf(q, entries, null).ranked, rankChunks(q, entries));
  assert.deepEqual(searchIvf(q, [], null).ranked, []);
});
test('probing every cluster equals exhaustive ranking, including best-chunk page scoring', async () => {
  const entries = fixture();
  entries[0].vectors.push(entries[11].vectors[0]);
  const index = await buildIvf(entries, { partitions: 8 });
  // Structured clone represents an IndexedDB cache round trip.
  const stored = structuredClone(index);
  for (let i = 0; i < 16; i++) {
    const q = entries[i].vectors[0];
    assert.deepEqual(searchIvf(q, entries, stored, entries.length, 8).ranked, rankChunks(q, entries, entries.length));
  }
});
test('partial probing retrieves nearest matches while reducing comparisons on separated clusters', async () => {
  const entries = fixture(), index = await buildIvf(entries, { partitions: 8 });
  let hits = 0, scanned = 0;
  for (let i = 0; i < 24; i++) {
    const q = entries[i * 7].vectors[0];
    const result = searchIvf(q, entries, index, 10, 2);
    const expected = new Set(rankChunks(q, entries, 10).map(r => r.id));
    hits += result.ranked.filter(r => expected.has(r.id)).length;
    scanned += result.scannedChunks;
  }
  assert.ok(hits / 240 >= 0.95);
  assert.ok(scanned / (24 * entries.length) < 0.5);
  console.log(`Synthetic Recall@10: ${(hits / 240 * 100).toFixed(1)}%; chunks scored: ${(scanned / (24 * entries.length) * 100).toFixed(1)}%`);
});
test('candidate pages use their strongest chunk even in another partition', async () => {
  const entries = [{ id: 'a', vectors: [unit([1, 0]), unit([0, 1])] }, { id: 'b', vectors: [unit([0.8, 0.2])] }];
  const index = { centroids: [unit([1, 0]), unit([0, 1])], lists: [[0, 1], [0]] };
  assert.deepEqual(searchIvf(unit([1, 0.9]), entries, index, 10, 1).ranked, rankChunks(unit([1, 0.9]), entries, 10));
});
test('cache identity changes for edits, deletion, import and membership ordering', () => {
  const entries = fixture(3), key = indexKey(entries);
  assert.equal(indexKey(structuredClone(entries)), key);
  assert.notEqual(indexKey(entries.slice(1)), key);
  assert.notEqual(indexKey([...entries].reverse()), key);
  entries[0].fingerprint = 'edited';
  assert.notEqual(indexKey(entries), key);
});
test('identical vectors and empty documents remain searchable', async () => {
  const entries = [{ id: 'empty', vectors: [] }, ...Array.from({ length: 20 }, (_, i) => ({ id: String(i), vectors: [unit([1, 1])] }))];
  const index = await buildIvf(entries, { minChunks: 0, partitions: 4 });
  assert.deepEqual(searchIvf(unit([1, 1]), entries, index, 20, 4).ranked, rankChunks(unit([1, 1]), entries, 20));
});
