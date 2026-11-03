// A hidden extension page can own a long-running Web Worker even after the
// popup closes and the Manifest V3 service worker goes idle.
import { snapshotFingerprint } from './semantic-core.mjs';

const worker = new Worker(chrome.runtime.getURL('semantic-worker.js'), { type: 'module' });
const extractionWorker = new Worker(chrome.runtime.getURL('htmlsift-worker.js'), { type: 'module' });
let extractionId = 0;
let extractionWorkerFailed = null;
const extractionJobs = new Map();
const JOB_TIMEOUT_MS = 180000;

function finishWorkerJob(id, response) {
  const job = extractionJobs.get(id);
  if (!job) return;
  extractionJobs.delete(id);
  clearTimeout(job.timeout);
  job.resolve(response);
}

extractionWorker.onmessage = ({ data }) => {
  if (!data || typeof data.id !== 'number') return;
  if (data.type === 'extract-result') {
    finishWorkerJob(data.id, { success: true, text: data.text, blocks: data.blocks });
  } else if (data.type === 'extract-error') {
    finishWorkerJob(data.id, { success: false, message: data.message || 'AI inference failed.' });
  }
};
extractionWorker.onerror = event => {
  extractionWorkerFailed = event.message || 'The htmlsift model worker failed to start.';
  console.error('Manemark htmlsift worker:', extractionWorkerFailed);
  for (const id of [...extractionJobs.keys()]) {
    finishWorkerJob(id, { success: false, message: extractionWorkerFailed });
  }
};
extractionWorker.onmessageerror = () => {
  extractionWorkerFailed = 'The htmlsift worker could not read a message.';
  for (const id of [...extractionJobs.keys()]) {
    finishWorkerJob(id, { success: false, message: extractionWorkerFailed });
  }
};

async function extractWithHtmlsift(html) {
  if (extractionWorkerFailed) throw new Error(extractionWorkerFailed + ' Reload the extension after checking its errors.');
  // DOMParser exists in an offscreen document, not in a Web Worker.
  const { renderBlocks } = await import('./htmlsift/render.mjs');
  const { blocks, features } = renderBlocks(html);
  if (!blocks.length) return { success: false, message: 'No readable HTML lines.' };
  const id = ++extractionId;
  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      finishWorkerJob(id, { success: false, message:
        'htmlsift did not respond within 3 minutes. Check the checkpoint files and available RAM.' });
    }, JOB_TIMEOUT_MS);
    extractionJobs.set(id, { resolve, timeout });
    try {
      extractionWorker.postMessage({ type: 'extract', id, blocks, features }, [features.buffer]);
    } catch (error) {
      finishWorkerJob(id, { success: false, message: error?.message || String(error) });
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
    const rawHtml = (typeof request.doctype === 'string' ? request.doctype : '') + html;
    const result = useAI
      ? await extractWithHtmlsift(html)
      : { success: true, text: rawHtml, blocks: 0 };
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

worker.onmessage = ({ data }) => {
  // An older batch can still have queued events after a new import/delete.
  // Never replace the current footer with progress from that obsolete batch.
  if (data.generation !== generation) return;
  if (data.type === 'index-progress') {
    publishStatus('indexing', data);
  } else if (data.type === 'index-complete') {
    publishStatus('complete', data, 'semanticIndexComplete');
  } else if (data.type === 'index-error') {
    lastSignature = null; // Allow a later retry after a recoverable runtime error.
    publishStatus('error', data, 'semanticIndexError');
  }
};

worker.onerror = event => {
  lastSignature = null;
  publishStatus('error', {
    message: event.message || 'The semantic worker could not start.'
  }, 'semanticIndexError');
  console.error('Manemark background semantic index:', event.message);
};

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
  if (request.action === 'getSemanticIndexStatus') {
    sendResponse({ success: true, status: indexStatus });
    return;
  }
  if (request.action !== 'reconcileSemanticIndex') return;
  const snapshots = Array.isArray(request.snapshots) ? request.snapshots : [];
  // Opening the popup or receiving duplicate change events must not abort a
  // long in-flight embedding job with an identical refresh request.
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
  worker.postMessage({ type: 'index', snapshots, generation });
  sendResponse({ success: true, status: indexStatus });
});
