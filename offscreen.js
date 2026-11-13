import { getModelAsset, onModelDownloadProgress } from './model-cache.mjs';
onModelDownloadProgress(status => {
  chrome.runtime.sendMessage({ action: 'modelDownloadProgress', status }).catch(() => {});
});
function handleModelRequest(running, data) {
  if (data?.type !== 'model-download-request') return false;
  getModelAsset(data.path).then(() => {
    running.postMessage({ type: 'model-download-response', requestId: data.requestId, success: true });
  }).catch(error => {
    running.postMessage({ type: 'model-download-response', requestId: data.requestId, success: false, message: error.message });
  });
  return true;
}

// A hidden extension page can own a long-running Web Worker even after the
// popup closes and the Manifest V3 service worker goes idle.
import { snapshotFingerprint } from './semantic-core.mjs';

// The semantic index does not need MiniLM resident once embeddings have been
// written to IndexedDB. Reuse the worker briefly for nearby saves, then unload.
let worker = null;
let semanticIdleTimer = null;
const SEMANTIC_IDLE_MS = 15000;

function releaseSemanticWorker() {
  clearTimeout(semanticIdleTimer);
  semanticIdleTimer = null;
  const running = worker;
  worker = null;
  if (running) {
    running.onmessage = null;
    running.onerror = null;
    running.terminate();
  }
}

function scheduleSemanticRelease() {
  clearTimeout(semanticIdleTimer);
  semanticIdleTimer = setTimeout(() => {
    semanticIdleTimer = null;
    releaseSemanticWorker();
  }, SEMANTIC_IDLE_MS);
}
// htmlsift's ONNX sessions can use a LOT of WASM memory. Do not construct its
// worker on page startup, and never retain it after the last extraction ends.
// The separate semantic index worker must stay alive to finish background jobs.
let extractionWorker = null;
let extractionId = 0;
const extractionJobs = new Map();
const JOB_TIMEOUT_MS = 20 * 60 * 1000; // Allow the first model download on slow connections.

function releaseExtractionWorker() {
  const running = extractionWorker;
  extractionWorker = null;
  if (running) {
    running.onmessage = null;
    running.onerror = null;
    running.onmessageerror = null;
    running.terminate(); // Frees htmlsift's ONNX sessions and WASM heap.
  }
}

function finishWorkerJob(id, response) {
  const job = extractionJobs.get(id);
  if (!job) return;
  extractionJobs.delete(id);
  clearTimeout(job.timeout);
  job.resolve(response);
  // Keep one model for overlapping jobs, but release it immediately after the
  // final response (success OR error), even while a save is being committed.
  if (extractionJobs.size === 0) releaseExtractionWorker();
}

function failExtractionWorker(message) {
  // A crashed/hung worker cannot process any queued jobs. Fail them all and
  // terminate it, rather than leaving a 1 GB heap and pending saves behind.
  for (const [id] of extractionJobs) {
    finishWorkerJob(id, { success: false, message });
  }
  releaseExtractionWorker();
}

function getExtractionWorker() {
  if (extractionWorker) return extractionWorker;
  const running = new Worker(chrome.runtime.getURL('htmlsift-worker.js'), { type: 'module' });
  extractionWorker = running;
  running.onmessage = ({ data }) => {
    if (handleModelRequest(running, data)) return;
    if (running !== extractionWorker || !data || typeof data.id !== 'number') return;
    if (data.type === 'extract-result') {
      finishWorkerJob(data.id, { success: true, text: data.text, blocks: data.blocks });
    } else if (data.type === 'extract-error') {
      finishWorkerJob(data.id, { success: false, message: data.message || 'AI inference failed.' });
    }
  };
  running.onerror = event => {
    if (running !== extractionWorker) return;
    const message = event.message || 'The htmlsift model worker failed to start.';
    console.error('Manemark htmlsift worker:', message);
    failExtractionWorker(message);
  };
  running.onmessageerror = () => {
    if (running !== extractionWorker) return;
    failExtractionWorker('The htmlsift worker could not read a message.');
  };
  return running;
}

async function extractWithHtmlsift(html) {
  // DOMParser exists in an offscreen document, not in a Web Worker.
  const { renderBlocks } = await import('./htmlsift/render.mjs');
  const { blocks, features } = renderBlocks(html);
  if (!blocks.length) return { success: false, message: 'No readable HTML lines.' };
  const id = ++extractionId;
  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      failExtractionWorker('Model setup or extraction timed out. Check your connection and available storage, then retry.');
    }, JOB_TIMEOUT_MS);
    extractionJobs.set(id, { resolve, timeout });
    try {
      getExtractionWorker().postMessage({ type: 'extract', id, blocks, features }, [features.buffer]);
    } catch (error) {
      // Worker construction and postMessage can fail synchronously.
      failExtractionWorker(error?.message || String(error));
    }
  });
}

const activeHtmlsiftJobs = new Set();
async function runHtmlsiftJob(request) {
  const { jobId, mode, html, url, title } = request;
  const useAI = request.aiExtractionEnabled !== false;
  let completion;
  try {
    // Raw mode bypasses htmlsift (and its model/markup filtering) entirely.
    // Preserve the live DOM markup, including HTML tags and document type.
    const result = useAI
      ? await extractWithHtmlsift(html)
      : { success: true, text: (typeof request.doctype === 'string' ? request.doctype : '') + html, blocks: 0 };
    if (!result?.success) throw new Error(result?.message || 'AI extraction failed.');
    if (!result.text?.trim()) throw new Error(useAI
      ? 'htmlsift found no main content on this page.' : 'The webpage has no HTML to capture.');
    if (mode === 'save') {
      const stored = await chrome.runtime.sendMessage({ action: 'saveSnapshot', url, title, text: result.text });
      if (!stored?.success) throw new Error(stored?.message || 'Could not save extracted content.');
      completion = { success: true, mode, jobId, blocks: result.blocks, saved: true };
    } else {
      completion = { success: true, mode, jobId, blocks: result.blocks, text: result.text };
    }
  } catch (error) {
    console.error('Manemark htmlsift job failed:', error);
    completion = { success: false, mode, jobId, message: error?.message || String(error) };
  } finally {
    activeHtmlsiftJobs.delete(jobId);
  }
  // The popup listens for this separate event if it is still open. Don't
  // hold the worker or background service worker alive waiting for a response.
  chrome.runtime.sendMessage({ action: 'htmlsiftJobComplete', ...completion }).catch(() => {});
}

let lastSignature = null;
let generation = 0;
let indexStatus = {
  phase: 'idle', indexed: 0, total: 0,
  chunksDone: 0, chunksTotal: 0, stage: '', message: '',
  generation: 0, sequence: 0
};

function stopSemanticIndex() {
  // Abandon in-flight MiniLM inference, but leave HTML extraction and the
  // IndexedDB cache alone. A later enable will reconcile/reuse saved vectors.
  generation++;
  lastSignature = null;
  releaseSemanticWorker();
  publishStatus('idle', { indexed: 0, total: 0 });
}


function notify(action, detail = {}) {
  // Messages are broadcast only within this extension, never to a server.
  chrome.runtime.sendMessage({ action, ...detail }).catch(() => {});
}

// Store the newest progress in this long-lived offscreen page so a popup
// reopened during indexing can immediately display the actual current counts.
function publishStatus(phase, detail = {}, action = 'semanticIndexProgress') {
  indexStatus = {
    phase,
    indexed: detail.indexed ?? indexStatus.indexed,
    total: detail.total ?? indexStatus.total,
    chunksDone: detail.chunksDone ?? 0,
    chunksTotal: detail.chunksTotal ?? 0,
    stage: detail.stage || '',
    message: detail.message || '',
    generation,
    sequence: indexStatus.sequence + 1
  };
  notify(action, { status: indexStatus, indexed: indexStatus.indexed, total: indexStatus.total });
}

function getSemanticWorker() {
  clearTimeout(semanticIdleTimer);
  semanticIdleTimer = null;
  if (worker) return worker;
  const running = new Worker(chrome.runtime.getURL('semantic-worker.js'), { type: 'module' });
  worker = running;
  running.onmessage = ({ data }) => {
    if (handleModelRequest(running, data)) return;
  if (running !== worker) return;
  // An older batch can still have queued events after a new import/delete.
  // Never replace the current footer with progress from that obsolete batch.
  if (data.generation !== generation) return;
  if (data.type === 'index-progress') {
    publishStatus('indexing', data);
  } else if (data.type === 'index-complete') {
    publishStatus('complete', data, 'semanticIndexComplete');
    scheduleSemanticRelease();
  } else if (data.type === 'index-error') {
    lastSignature = null; // Allow a later retry after a recoverable runtime error.
    publishStatus('error', data, 'semanticIndexError');
    scheduleSemanticRelease();
  }
  };
  running.onerror = event => {
    if (running !== worker) return;
    lastSignature = null;
    publishStatus('error', {
      message: event.message || 'The semantic worker could not start.'
    }, 'semanticIndexError');
    console.error('Manemark background semantic index:', event.message);
    releaseSemanticWorker();
  };
  return running;
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.target === 'htmlsiftOffscreen' && request.action === 'queueHtmlsiftJob') {
    if (typeof request.jobId !== 'string' || !request.jobId || activeHtmlsiftJobs.has(request.jobId)) {
      sendResponse({ success: false, message: 'Invalid or duplicate htmlsift job.' });
      return;
    }
    activeHtmlsiftJobs.add(request.jobId);
    // Respond synchronously BEFORE the first expensive ONNX/DOM operation.
    sendResponse({ success: true, queued: true });
    void runHtmlsiftJob(request);
    return;
  }

  if (request.target !== 'semanticOffscreen') return;
  if (request.action === 'downloadModelAsset') {
    getModelAsset(request.path).then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, message: error.message }));
    return true;
  }
  if (request.action === 'ping') {
    // Installed synchronously as soon as this offscreen module has loaded.
    // Unlike document existence, this acknowledges that it can receive jobs.
    sendResponse({ success: true, ready: true });
    return;
  }
  if (request.action === 'stopSemanticIndex') {
    stopSemanticIndex();
    sendResponse({ success: true, status: indexStatus });
    return;
  }
  if (request.action === 'getSemanticIndexStatus') {
    sendResponse({ success: true, status: indexStatus });
    return;
  }
  if (request.action !== 'reconcileSemanticIndex') return;
  // Independently enforce the persisted setting even if a stale background
  // reconciliation request arrives after indexing was switched off.
  void (async () => {
    // Chrome exposes only chrome.runtime in an offscreen document (no
    // chrome.storage). Ask the service worker for the latest persisted value.
    // Capture the generation so a stop arriving during this async read cannot
    // be undone by an older queued reconciliation request.
    const atStart = generation;
    const preference = await chrome.runtime.sendMessage({
      target: 'semanticBackground', action: 'getSemanticSearchEnabled'
    });
    if (!preference?.success || typeof preference.enabled !== 'boolean') {
      throw new Error(preference?.message || 'Unable to read the Semantic Search setting from the background worker.');
    }
    if (generation !== atStart) {
      sendResponse({ success: true, superseded: true, status: indexStatus });
      return;
    }
    if (!preference.enabled) {
      stopSemanticIndex();
      sendResponse({ success: true, disabled: true, status: indexStatus });
      return;
    }
    const snapshots = Array.isArray(request.snapshots) ? request.snapshots : [];
    // Duplicate change events must not abort an identical embedding job.
    const signature = JSON.stringify(snapshots.map(snapshot => [
      String(snapshot?.id), snapshotFingerprint(snapshot || {})
    ]).sort((a, b) => a[0].localeCompare(b[0])));
    if (signature === lastSignature) {
      sendResponse({ success: true, unchanged: true, status: indexStatus });
      return;
    }
    lastSignature = signature;
    generation++;
    publishStatus('checking', { indexed: 0, total: snapshots.length });
    getSemanticWorker().postMessage({ type: 'index', snapshots, generation });
    sendResponse({ success: true, status: indexStatus });
  })().catch(error => {
    lastSignature = null;
    releaseSemanticWorker();
    publishStatus('error', { message: error?.message || String(error) }, 'semanticIndexError');
    sendResponse({ success: false, message: error?.message || String(error) });
  });
  return true;
});
