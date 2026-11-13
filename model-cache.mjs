// Only fixed model-data files may be downloaded. JS, WASM and runtime modules
// remain in vendor/ and are never fetched through this loader.
const MINI = 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/751bff37182d3f1213fa05d7196b954e230abad9/';
const SIFT = 'https://huggingface.co/koivualeksi/htmlsift-release/resolve/73ac2b978aef356e9e5772640a0c9444f2b67705/mini/';
export const MODEL_ASSETS = Object.freeze({
  'Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx': MINI + 'onnx/model_quantized.onnx',
  'htmlsift-mini/tokenizer.json': SIFT + 'tokenizer.json',
  'htmlsift-mini/manifest.json': SIFT + 'manifest.json',
  'htmlsift-mini/mini-table-int8.onnx': SIFT + 'mini-table-int8.onnx',
  'htmlsift-mini/mini-head-fABC.onnx': SIFT + 'mini-head-fABC.onnx'
});
const CACHE = 'manemark-model-data-v1';
const inFlight = new Map();

let progressListener = () => {};
export function onModelDownloadProgress(listener) { progressListener = listener; }
function report(path, phase, loaded = 0, total = 0, message = '') {
  progressListener({ path, phase, loaded, total, message, updatedAt: Date.now() });
}
let requestSequence = 0;
const requests = new Map();
const inWorker = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
if (inWorker) self.addEventListener('message', ({ data }) => {
  if (data?.type !== 'model-download-response') return;
  const request = requests.get(data.requestId);
  if (!request) return;
  requests.delete(data.requestId);
  data.success ? request.resolve() : request.reject(new Error(data.message));
});

export async function getModelAsset(path) {
  const url = MODEL_ASSETS[path];
  if (!url) throw new Error('Model asset is not allowlisted: ' + path);
  const cache = await caches.open(CACHE);
  const cached = await cache.match(url);
  if (cached) return cached;
  // The offscreen document owns downloads, even for popup-owned query workers.
  // Closing a popup or terminating an inference worker cannot cancel a download.
  if (inWorker) {
    await new Promise((resolve, reject) => {
      const requestId = ++requestSequence;
      requests.set(requestId, { resolve, reject });
      postMessage({ type: 'model-download-request', requestId, path });
    });
    const result = await cache.match(url);
    if (!result) throw new Error('Downloaded model is missing from the cache. Please retry.');
    return result;
  }
  if (!inFlight.has(url)) {
    const download = async () => {
      // A popup search and background indexing can request the same model.
      if (await cache.match(url)) return;
      report(path, 'downloading');
      let response;
      try {
        response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(15 * 60 * 1000) });
      } catch (error) {
        throw new Error('Could not download ' + path + '. Connect to the internet and try again. ' + error.message);
      }
      if (!response.ok) throw new Error('Model download failed (' + response.status + '): ' + path);
      // Consume completely before committing, so interrupted downloads are not cached.
      const total = Number(response.headers.get('content-length')) || 0;
      let loaded = 0;
      let lastReport = 0;
      const reader = response.body.getReader();
      const parts = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        loaded += value.byteLength;
        if (Date.now() - lastReport >= 200) {
          report(path, 'downloading', loaded, total);
          lastReport = Date.now();
        }
      }
      const blob = new Blob(parts);
      report(path, 'saving', loaded, total);

      if (path.endsWith('.onnx')) {
        const prefix = await blob.slice(0, 100).text();
        if (blob.size < 1024 || /^\s*(<|version https:)/.test(prefix)) {
          throw new Error('Invalid or incomplete ONNX model: ' + path);
        }
      } else {
        JSON.parse(await blob.text());
      }
      await cache.put(url, new Response(blob, { headers: { 'Content-Type': path.endsWith('.json') ? 'application/json' : 'application/octet-stream' } }));
      report(path, 'complete', loaded, loaded);
    };
    const job = globalThis.navigator?.locks
      ? navigator.locks.request('manemark-model:' + url, download)
      : download();
    inFlight.set(url, job.catch(error => {
      report(path, 'error', 0, 0, error.message);
      throw error;
    }).finally(() => inFlight.delete(url)));
  }
  await inFlight.get(url);
  const result = await cache.match(url);
  if (!result) throw new Error('Model cache unavailable. Check available disk space and retry.');
  return result;
}

export function configureModelCache(env) {
  const localRoot = new URL('./models/', import.meta.url).href;
  env.allowLocalModels = true;
  env.allowRemoteModels = false; // No generic remote loading or remote runtime fallback.
  env.useBrowserCache = false;
  env.useCustomCache = true;
  env.localModelPath = localRoot;
  env.customCache = {
    async match(key) {
      const value = typeof key === 'string' ? key : key.url;
      if (!value?.startsWith(localRoot)) return undefined;
      const path = value.slice(localRoot.length);
      return Object.hasOwn(MODEL_ASSETS, path) ? getModelAsset(path) : undefined;
    },
    async put() { /* Bundled small config/tokenizer files need no duplicate cache. */ }
  };
}
