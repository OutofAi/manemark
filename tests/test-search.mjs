import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { chunkSnapshot, rankChunks, snapshotFingerprint, planIndexChanges } from '../semantic-core.mjs';

// The current index ranks Manemarks by their best chunk similarity, without
// exposing the chunk metadata (which was removed before v1.2.6).
const q = Float32Array.from([1, 0]);
const entries = [
  { id: 10, vectors: [[0.2, 0.8], [0.9, 0.1], [0.6, 0.4], [0.7, 0.3]] },
  { id: 11, vectors: [[0.5, 0.5]] },
  { id: 12, vectors: [] }
];
const ranked = rankChunks(q, entries, 10);
assert.deepEqual(ranked, [{id:10,score:0.9}, {id:11,score:0.5}]);
assert.deepEqual(rankChunks(q, entries, 1).map(r => r.id), [10]);
assert.deepEqual(rankChunks(q, [{ id: 100, vectors: [[], null] }]), []);

// Chunk indexing remains 140 words with 28-word overlap (112-word stride).
const text = Array.from({length: 280}, (_, i) => `word${i + 1}`).join(' ');
const snapshot = {id: 10, title: 'Demo title', url:'https://example.com', text};
const chunks = chunkSnapshot(snapshot);
assert.equal(chunks.length, 3);
assert.ok(chunks[0].startsWith('Demo title. word1 word2'));
assert.ok(chunks[1].startsWith('Demo title. word113 word114'));
assert.ok(chunks[2].startsWith('Demo title. word225 word226'));
assert.equal(planIndexChanges([snapshot], [{id:'10', fingerprint:snapshotFingerprint(snapshot), vectors:[1]}]).ready, 1);

// Check the actual popup escaping helper, which protects rendered Manemark
// titles, URLs and preview text against saved HTML injection.
const popup = fs.readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
const escapeImpl = popup.match(/^function escapeHtml\(text\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(escapeImpl);
const escapeHtml = vm.runInNewContext(`(${escapeImpl})`);
assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
assert.equal(escapeHtml('& "quoted"'), '&amp; &quot;quoted&quot;');

console.log('PASS: current semantic ranking, chunk alignment, index reuse and HTML escaping');
