// MiniLM inference runs in a dedicated Web Worker, not in the popup or MV3
// service worker. The offscreen document uses this for incremental indexing;
// the popup uses a separate instance for query-only embedding and ranking.
import { pipeline, env } from './vendor/transformers.min.js';
import {
  EMBEDDING_DIMENSIONS, chunkSnapshot, snapshotFingerprint, rankChunks,
  planIndexChanges
} from './semantic-core.mjs';

const DATABASE = 'manemark-semantic-documents-v2';
const STORE = 'documents';
const MODEL = 'Xenova/all-MiniLM-L6-v2';

// All model/runtime assets must be part of the installed extension. There are
// no hosted models, CDN scripts, or online embedding requests.
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.useBrowserCache = false; // Prevent unsupported cache writes
env.localModelPath = new URL('./models/', import.meta.url).href;
env.backends.onnx.wasm.wasmPaths = new URL('./vendor/', import.meta.url).href;
env.backends.onnx.wasm.numThreads = 1;

let modelPromise;
let databasePromise;
let nextIndex = null;
let indexing = false;

function loadModel() {
  if (!modelPromise) {
    modelPromise = pipeline('feature-extraction', MODEL, {
      dtype: 'q8', device: 'wasm', local_files_only: true
    }).catch(error => {
      modelPromise = null; // A later retry can work after a repaired install.
      throw error;
    });
  }
  return modelPromise;
}

async function embed(text) {
  const model = await loadModel();
  const output = await model(text, { pooling: 'mean', normalize: true });
  const vector = Float32Array.from(output.data);
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Unexpected embedding size: ${vector.length}`);
  }
  return vector;
}

function openDatabase() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch(error => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

async function listDocuments() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function updateDocuments({ deletes = [], put = null }) {
  if (!deletes.length && !put) return;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    for (const id of deletes) store.delete(id);
    if (put) store.put(put);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

// Offscreen messages can arrive while a slow inference operation is underway.
// Only the newest requested snapshot set is authoritative. Each new batch is
// reconciled with IndexedDB, with stale vectors deleted before re-embedding.
async function runIndexQueue() {
  if (indexing) return;
  indexing = true;
  try {
    while (nextIndex !== null) {
      const { snapshots, generation } = nextIndex;
      nextIndex = null;
      try {
        const current = await listDocuments();
        const { deletes, missing, ready, total } = planIndexChanges(snapshots, current);
        await updateDocuments({ deletes });
        if (nextIndex !== null) continue;

        let indexed = ready;
        postMessage({ type: 'index-progress', indexed, total, generation });
        for (const { snapshot, id, fingerprint } of missing) {
          if (nextIndex !== null) break;
          const chunks = chunkSnapshot(snapshot);
          if (!chunks.length) {
            await updateDocuments({ put: { id, fingerprint, vectors: [] } });
            indexed++;
            postMessage({ type: 'index-progress', indexed, total, generation });
            continue;
          }
          const vectors = [];
          for (let chunkNumber = 0; chunkNumber < chunks.length; chunkNumber++) {
            if (nextIndex !== null) break;
            if (!modelPromise) {
              postMessage({
                type: 'index-progress', indexed, total, generation,
                chunksDone: chunkNumber, chunksTotal: chunks.length, stage: 'loading-model'
              });
            }
            vectors.push(await embed(chunks[chunkNumber]));
            if (nextIndex !== null) break;
            postMessage({
              type: 'index-progress', indexed, total, generation,
              chunksDone: chunkNumber + 1, chunksTotal: chunks.length
            });
          }
          // A save/delete/import that arrived during inference supersedes this
          // computation. Never write an out-of-date version to the index.
          if (nextIndex !== null) break;
          await updateDocuments({ put: { id, fingerprint, vectors } });
          indexed++;
          postMessage({ type: 'index-progress', indexed, total, generation });
        }
        if (nextIndex === null) {
          postMessage({ type: 'index-complete', indexed, total, generation });
        }
      } catch (error) {
        // If a newer batch arrived, its result supersedes this old failure.
        if (nextIndex === null) {
          postMessage({ type: 'index-error', generation, message: error.message || String(error) });
        }
      }
    }
  } finally {
    indexing = false;
    // A new message may have arrived after the last loop condition.
    if (nextIndex !== null) void runIndexQueue();
  }
}

async function search({ id, query, snapshots = [] }) {
  try {
    const current = await listDocuments();
    const { readyEntries, pending } = collectSearchEntries(snapshots, current);
    postMessage({ type: 'progress', id, message: 'Embedding search query locally…' });
    const vector = await embed(query);
    postMessage({
      type: 'results', id,
      ranked: rankChunks(vector, readyEntries, snapshots.length),
      pending, total: snapshots.length
    });
  } catch (error) {
    postMessage({ type: 'error', id, message: error.message || String(error) });
  }
}

function collectSearchEntries(snapshots, current) {
  const cached = new Map(current.map(entry => [String(entry.id), entry]));
  const readyEntries = [];
  let pending = 0;
  for (const snapshot of snapshots) {
    const id = String(snapshot.id);
    const entry = cached.get(id);
    if (entry && entry.fingerprint === snapshotFingerprint(snapshot) && Array.isArray(entry.vectors)) {
      readyEntries.push(entry);
    } else {
      pending++;
    }
  }
  return { readyEntries, pending };
}

self.onmessage = ({ data }) => {
  if (data?.type === 'index') {
    nextIndex = {
      snapshots: Array.isArray(data.snapshots) ? data.snapshots : [],
      generation: data.generation
    };
    void runIndexQueue();
  } else if (data?.type === 'search' && typeof data.query === 'string') {
    void search(data);
  }
};
