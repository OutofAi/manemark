// Background Service Worker for Text Snapper Extension
// Handles storage and communication between content script and popup

const CHUNK_CONFIG = {
  chunkSize: 1200,
  chunkOverlap: 200,
  method: 'word_window'
};

function estimateTokens(text) {
  const safe = String(text || '').trim();
  if (!safe) return 0;
  const words = safe.split(/\s+/).length;
  return Math.ceil(words * 1.3);
}

function chunkText(text, snapshotId, config = CHUNK_CONFIG) {
  const safeText = String(text || '').trim();
  if (!safeText) return [];

  const words = safeText.split(/\s+/);
  const chunkSize = Math.max(1, config.chunkSize || 1200);
  const chunkOverlap = Math.max(0, config.chunkOverlap || 0);
  const step = Math.max(1, chunkSize - chunkOverlap);

  const chunks = [];
  let chunkIndex = 0;

  for (let start = 0; start < words.length; start += step) {
    const end = Math.min(start + chunkSize, words.length);
    const chunkWords = words.slice(start, end);
    const chunkTextValue = chunkWords.join(' ').trim();

    if (!chunkTextValue) continue;

    chunks.push({
      chunk_id: `${snapshotId}_${chunkIndex}`,
      chunk_index: chunkIndex,
      text: chunkTextValue,
      token_count: estimateTokens(chunkTextValue)
    });

    chunkIndex += 1;

    if (end >= words.length) break;
  }

  return chunks;
}

function normalizeSnapshot(snapshot) {
  if (!snapshot) return snapshot;

  const id = snapshot.id || Date.now();
  const text = String(snapshot.text || '');
  const title = String(snapshot.title || 'Untitled Page');
  const url = String(snapshot.url || '');
  const timestamp = snapshot.timestamp || new Date().toISOString();

  const chunks = Array.isArray(snapshot.chunks) && snapshot.chunks.length > 0
    ? snapshot.chunks.map((chunk, index) => ({
        chunk_id: chunk.chunk_id || `${id}_${index}`,
        chunk_index: Number.isFinite(chunk.chunk_index) ? chunk.chunk_index : index,
        text: String(chunk.text || ''),
        token_count: Number.isFinite(chunk.token_count)
          ? chunk.token_count
          : estimateTokens(chunk.text || '')
      }))
    : chunkText(text, id);

  return {
    ...snapshot,
    id,
    url,
    title,
    text,
    timestamp,
    textPreview: snapshot.textPreview || text.substring(0, 150) + (text.length > 150 ? '...' : ''),
    token_count: Number.isFinite(snapshot.token_count)
      ? snapshot.token_count
      : estimateTokens(text),
    chunk_count: Number.isFinite(snapshot.chunk_count)
      ? snapshot.chunk_count
      : chunks.length,
    chunk_config: snapshot.chunk_config || {
      chunk_size: CHUNK_CONFIG.chunkSize,
      chunk_overlap: CHUNK_CONFIG.chunkOverlap,
      chunk_method: CHUNK_CONFIG.method
    },
    chunks
  };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'saveSnapshot') {
    chrome.storage.local.get(['snapshots'], (result) => {
      const snapshots = (result.snapshots || []).map(normalizeSnapshot);

      const snapshotId = Date.now();
      const text = String(request.text || '');
      const chunks = chunkText(text, snapshotId);

      const newSnapshot = {
        id: snapshotId,
        url: request.url,
        title: request.title,
        text,
        timestamp: new Date().toISOString(),
        textPreview: text.substring(0, 150) + (text.length > 150 ? '...' : ''),
        token_count: estimateTokens(text),
        chunk_count: chunks.length,
        chunk_config: {
          chunk_size: CHUNK_CONFIG.chunkSize,
          chunk_overlap: CHUNK_CONFIG.chunkOverlap,
          chunk_method: CHUNK_CONFIG.method
        },
        chunks
      };

      const existingIndex = snapshots.findIndex(s => s.url === request.url);

      if (existingIndex !== -1) {
        snapshots[existingIndex] = newSnapshot;
      } else {
        snapshots.unshift(newSnapshot);
      }

      chrome.storage.local.set({ snapshots }, () => {
        sendResponse({ success: true, snapshot: newSnapshot });
      });
    });

    return true;
  }

  if (request.action === 'getSnapshots') {
    chrome.storage.local.get(['snapshots'], (result) => {
      const snapshots = (result.snapshots || []).map(normalizeSnapshot);
      sendResponse({ snapshots });
    });
    return true;
  }

  if (request.action === 'deleteSnapshot') {
    chrome.storage.local.get(['snapshots'], (result) => {
      const snapshots = (result.snapshots || []).map(normalizeSnapshot);
      const filtered = snapshots.filter(s => s.id !== request.id);
      chrome.storage.local.set({ snapshots: filtered }, () => {
        sendResponse({ success: true });
      });
    });
    return true;
  }

  if (request.action === 'clearAll') {
    chrome.storage.local.set({ snapshots: [] }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.action === 'saveAllSnapshots') {
    const snapshots = (request.snapshots || []).map(normalizeSnapshot);
    chrome.storage.local.set({ snapshots }, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});