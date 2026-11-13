import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as core from '../semantic-core.mjs';
import * as ivf from '../semantic-ivf.mjs';
const source = (await readFile(new URL('../semantic-worker.js', import.meta.url), 'utf8'))
  .replace(/import[\s\S]*?from ['"][^'"]+['"];\n/g, '')
  .replaceAll('import.meta.url', "'https://extension.test/semantic-worker.js'");
function mockDatabase(documents) {
  const databases = new Map([['manemark-semantic-documents-v2', new Map([['documents', new Map(documents.map(d => [d.id, d]))]])]]);
  return { open(name) {
    const request = {};
    setTimeout(() => {
      const fresh = !databases.has(name);
      if (fresh) databases.set(name, new Map());
      const stores = databases.get(name);
      request.result = {
        createObjectStore(store) { stores.set(store, new Map()); },
        transaction(store) {
          const tx = { objectStore() { return {
            get(key) { return read(() => stores.get(store).get(key)); },
            getAll() { return read(() => [...stores.get(store).values()]); },
            put(value, key) { stores.get(store).set(key ?? value.id, structuredClone(value)); setTimeout(() => tx.oncomplete?.(), 0); },
            delete(key) { stores.get(store).delete(key); setTimeout(() => tx.oncomplete?.(), 0); }
          }; } };
          return tx;
        }
      };
      if (fresh) request.onupgradeneeded?.();
      request.onsuccess?.();
    }, 0);
    return request;
  } };
}
function read(fn) { const r = {}; setTimeout(() => { r.result = structuredClone(fn()); r.onsuccess?.(); }, 0); return r; }
function worker(db, onBuild) {
  const pending = new Map();
  const queryVector = Float32Array.from({ length: 384 }, (_, i) => i === 0 ? 1 : 0);
  const context = vm.createContext({ ...core, ...ivf,
    buildIvf: async entries => { onBuild(); return ivf.buildIvf(entries); },
    configureModelCache: () => {}, getModelAsset: async () => {},
    pipeline: async () => async () => ({ data: queryVector }),
    env: { backends: { onnx: { wasm: {} } } },
    fetch: async () => ({ status: 200, ok: true, headers: { get: () => '2000000' } }),
    indexedDB: db, URL, console, setTimeout, Float32Array, self: {},
    postMessage(message) { if (message.type === 'results' || message.type === 'error') pending.get(message.id)?.(message); }
  });
  vm.runInContext(source, context);
  let sequence = 0;
  return snapshots => new Promise(resolve => {
    const id = ++sequence; pending.set(id, resolve);
    context.self.onmessage({ data: { type: 'search', id, query: 'test', snapshots } });
  });
}
test('worker reuses persisted IVF and excludes deleted or edited snapshots', async () => {
  const snapshots = Array.from({ length: 520 }, (_, i) => ({ id: String(i), title: `Page ${i}`, text: 'Original text' }));
  const documents = snapshots.map((s, i) => ({ id: s.id, fingerprint: core.snapshotFingerprint(s), vectors: [Float32Array.from({ length: 384 }, (_, d) => d === i % 8 ? 1 : 0)] }));
  const db = mockDatabase(documents);
  let builds = 0;
  const search = worker(db, () => builds++);
  const first = await search(snapshots);
  assert.equal(first.type, 'results'); assert.equal(first.mode, 'ivf'); assert.equal(builds, 1);
  await search(snapshots); assert.equal(builds, 1);
  const reopened = worker(db, () => builds++);
  await reopened(snapshots); assert.equal(builds, 1, 'persisted index reused after worker restart');
  const remaining = snapshots.slice(1);
  remaining[0] = { ...remaining[0], text: 'Edited text awaiting re-embedding' };
  const changed = await reopened(remaining);
  assert.equal(builds, 2); assert.equal(changed.pending, 1);
  assert.ok(changed.ranked.every(r => r.id !== '0' && r.id !== '1'));
  const small = await reopened(remaining.slice(0, 10));
  assert.equal(small.mode, 'exact'); assert.equal(small.pending, 1);
});
