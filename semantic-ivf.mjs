// Local spherical KMeans IVF. Embeddings remain in the existing document store.
import { cosineNormalized, rankChunks } from './semantic-core.mjs';
export const IVF_VERSION = 1;
export const IVF_MIN_CHUNKS = 512;
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
export function indexKey(entries) {
  return JSON.stringify([IVF_VERSION, entries.map(e => [String(e.id), e.fingerprint, e.vectors.length])]);
}
function normalize(vector) {
  const norm = Math.hypot(...vector);
  return norm ? Float32Array.from(vector, x => x / norm) : vector;
}
function nearest(vector, centroids) {
  let best = 0, score = -Infinity;
  centroids.forEach((c, i) => {
    const value = cosineNormalized(vector, c);
    if (value > score) { best = i; score = value; }
  });
  return best;
}
export async function buildIvf(entries, { minChunks = IVF_MIN_CHUNKS, partitions } = {}) {
  const refs = [];
  entries.forEach((entry, document) => entry.vectors.forEach((vector, chunk) => refs.push({ document, chunk, vector })));
  if (refs.length < minChunks || !refs.length) return null;
  const k = Math.min(refs.length, Math.max(1, partitions ?? Math.min(64, Math.max(4, Math.round(Math.sqrt(refs.length / 2))))));
  // Deterministic bounded training sample; assignment still covers every chunk.
  const count = Math.min(2048, refs.length);
  const sample = Array.from({ length: count }, (_, i) => refs[Math.floor(i * refs.length / count)].vector);
  const centroids = [Float32Array.from(sample[0])];
  const distances = new Float64Array(sample.length).fill(Infinity);
  // Farthest-first initialization avoids picking neighbouring chunks as all seeds.
  for (let c = 1; c < k; c++) {
    let farthest = 0;
    sample.forEach((v, i) => {
      distances[i] = Math.min(distances[i], 1 - cosineNormalized(v, centroids[c - 1]));
      if (distances[i] > distances[farthest]) farthest = i;
    });
    centroids.push(Float32Array.from(sample[farthest]));
    if (c % 8 === 0) await pause();
  }
  for (let iteration = 0; iteration < 6; iteration++) {
    const sums = centroids.map(c => new Float32Array(c.length));
    const counts = new Uint32Array(k);
    for (let i = 0; i < sample.length; i++) {
      const v = sample[i], cluster = nearest(v, centroids);
      counts[cluster]++;
      for (let d = 0; d < v.length; d++) sums[cluster][d] += v[d];
      if (i % 128 === 0) await pause();
    }
    for (let c = 0; c < k; c++) if (counts[c]) centroids[c] = normalize(sums[c]);
  }
  const lists = centroids.map(() => []);
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    lists[nearest(ref.vector, centroids)].push(ref.document);
    if (i % 256 === 0) await pause();
  }
  // A partition needs document IDs only: candidate pages get exact best-chunk scores.
  return { centroids, lists: lists.map(list => [...new Set(list)]), totalChunks: refs.length };
}
export function searchIvf(query, entries, index, limit = 15, probes) {
  const totalChunks = entries.reduce((sum, e) => sum + e.vectors.length, 0);
  if (!index) return { ranked: rankChunks(query, entries, limit), mode: 'exact', scannedChunks: totalChunks, totalChunks };
  const nprobe = Math.min(index.centroids.length, Math.max(1, probes ?? Math.ceil(index.centroids.length / 3)));
  const closest = index.centroids.map((c, i) => ({ i, score: cosineNormalized(query, c) }))
    .sort((a, b) => b.score - a.score).slice(0, nprobe);
  const candidates = new Set(closest.flatMap(c => index.lists[c.i]));
  const selected = entries.filter((_, i) => candidates.has(i));
  return { ranked: rankChunks(query, selected, limit), mode: 'ivf', probes: nprobe,
    partitions: index.centroids.length, scannedChunks: selected.reduce((sum, e) => sum + e.vectors.length, 0), totalChunks };
}
