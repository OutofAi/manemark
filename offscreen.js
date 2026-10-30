// A hidden extension page can own a long-running Web Worker even after the
// popup closes and the Manifest V3 service worker goes idle.
import { snapshotFingerprint } from './semantic-core.mjs';

const worker = new Worker(chrome.runtime.getURL('semantic-worker.js'), { type: 'module' });
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
