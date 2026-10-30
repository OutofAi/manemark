// Deterministic local semantic-index helpers, independent of any model runtime.
export const EMBEDDING_DIMENSIONS = 384;
export const INDEX_VERSION = 2;

// MiniLM has a 256 wordpiece-token limit. Short overlapping word chunks leave
// room for subword tokenization and metadata while covering long saved pages.
export function chunkSnapshot(snapshot, maxWords = 140, overlapWords = 28) {
  const title = String(snapshot.title || '').trim().slice(0, 200);
  const text = String(snapshot.text || '').trim();
  const words = text.match(/\S+/gu) || [];
  if (!words.length) return title ? [title] : [];
  const chunks = [];
  const step = maxWords - overlapWords;
  if (step <= 0) throw new Error('Invalid overlap');
  for (let start = 0; start < words.length; start += step) {
    chunks.push((title ? `${title}. ` : '') + words.slice(start, start + maxWords).join(' '));
    if (start + maxWords >= words.length) break;
  }
  return chunks;
}

// Hash used for invalidating indexed documents when imported/re-saved/changed.
// Not for cryptographic purposes.
export function snapshotFingerprint(snapshot) {
  const input = `${INDEX_VERSION}\u0000${snapshot.title || ''}\u0000${snapshot.url || ''}\u0000${snapshot.text || ''}`;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${input.length}:${(hash >>> 0).toString(16)}`;
}

export function cosineNormalized(a, b) {
  if (!a || !b || a.length !== b.length) return -Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

export function rankChunks(queryVector, entries, limit = 15) {
  return entries.map(entry => {
    let score = -Infinity;
    for (const vector of entry.vectors || []) {
      score = Math.max(score, cosineNormalized(queryVector, vector));
    }
    return { id: entry.id, score };
  }).filter(result => Number.isFinite(result.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}


// Compute an incremental refresh plan. Retain unchanged vectors, invalidate
// edited documents, and remove documents absent after delete/clear/import.
export function planIndexChanges(snapshots, indexedDocuments) {
  const wanted = new Map();
  for (const snapshot of snapshots) {
    if (!snapshot || snapshot.id === undefined || snapshot.id === null) continue;
    wanted.set(String(snapshot.id), { snapshot, id: String(snapshot.id), fingerprint: snapshotFingerprint(snapshot) });
  }
  const cached = new Map(indexedDocuments.map(doc => [String(doc.id), doc]));
  const deletes = [];
  for (const [id, entry] of cached) {
    if (!wanted.has(id) || wanted.get(id).fingerprint !== entry.fingerprint) deletes.push(id);
  }
  const missing = [];
  let ready = 0;
  for (const desired of wanted.values()) {
    const doc = cached.get(desired.id);
    if (doc?.fingerprint === desired.fingerprint && Array.isArray(doc.vectors)) ready++;
    else missing.push(desired);
  }
  return { deletes, missing, ready, total: wanted.size };
}
