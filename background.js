// Background service worker for Manemark.
// Saves full-page snapshots and selected-text highlights in the same local library.

const HIGHLIGHT_MENU_ID = 'save-link-to-highlight-manemark';


// MV3 service workers can be suspended at any time. Run MiniLM inference in a
// dedicated Worker owned by an offscreen document, not in the search popup.
// Storage changes are the single source of truth: ordinary saves, highlight
// saves, deletions, clear, merges and replacement imports all use this path.
let creatingSemanticDocument = null;
const SEMANTIC_OFFSCREEN_TARGET = 'semanticOffscreen';
const SEMANTIC_READY_ATTEMPTS = 12;
const SEMANTIC_READY_DELAY_MS = 200;
const SEMANTIC_SEARCH_STORAGE_KEY = 'semanticSearchEnabled';

async function semanticSearchIsEnabled() {
  const preferences = await chrome.storage.local.get({ [SEMANTIC_SEARCH_STORAGE_KEY]: true });
  return preferences[SEMANTIC_SEARCH_STORAGE_KEY] !== false;
}

function stopSemanticIndex() {
  // Don't create an offscreen page just to stop indexing. If one is already
  // running (including for htmlsift), it will cancel only the MiniLM worker.
  chrome.runtime.sendMessage({ target: 'semanticOffscreen', action: 'stopSemanticIndex' })
    .catch(() => {});
}

async function waitForSemanticDocumentReady() {
  // createDocument() resolves once the page exists, NOT necessarily after its
  // module script has installed chrome.runtime.onMessage. A reconcile sent in
  // that gap resolves without a response and used to throw a generic error.
  let lastError;
  for (let attempt = 0; attempt < SEMANTIC_READY_ATTEMPTS; attempt++) {
    try {
      const reply = await chrome.runtime.sendMessage({
        target: SEMANTIC_OFFSCREEN_TARGET, action: 'ping'
      });
      if (reply?.success === true && reply.ready === true) return;
      if (reply?.message) lastError = reply.message;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    if (attempt + 1 < SEMANTIC_READY_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, SEMANTIC_READY_DELAY_MS));
    }
  }
  throw new Error('The offscreen indexing page did not become ready. Reload Manemark at chrome://extensions' +
    (lastError ? `. Last error: ${lastError}` : '. Inspect its offscreen-page console for startup errors.'));
}

async function ensureSemanticDocument() {
  if (!chrome.offscreen?.createDocument || !chrome.runtime.getContexts) return false;
  if (!creatingSemanticDocument) {
    creatingSemanticDocument = (async () => {
      const url = chrome.runtime.getURL('offscreen.html');
      const existing = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url]
      });
      if (!existing.length) {
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['WORKERS'],
          justification: 'Run local MiniLM indexing and htmlsift ONNX content extraction without blocking the popup.'
        });
      }
      // Also check pre-existing pages: a running but broken module must not be
      // treated as a healthy indexing endpoint.
      await waitForSemanticDocumentReady();
      return true;
    })().finally(() => { creatingSemanticDocument = null; });
  }
  return creatingSemanticDocument;
}

async function reconcileSemanticIndex() {
  // Check before creating anything: a disabled JSON import must not wake MiniLM.
  if (!await semanticSearchIsEnabled()) return { phase: 'idle' };
  if (!await ensureSemanticDocument()) return;
  // Recheck around awaited operations to avoid an in-flight import racing an
  // off toggle. The offscreen page independently verifies this preference.
  if (!await semanticSearchIsEnabled()) return { phase: 'idle' };
  const { snapshots = [] } = await chrome.storage.local.get('snapshots');
  if (!await semanticSearchIsEnabled()) return { phase: 'idle' };
  let response;
  try {
    response = await chrome.runtime.sendMessage({
      target: SEMANTIC_OFFSCREEN_TARGET, action: 'reconcileSemanticIndex',
      snapshots: Array.isArray(snapshots) ? snapshots : []
    });
  } catch (error) {
    throw new Error('Could not contact the offscreen semantic index: ' +
      (error?.message || String(error)));
  }
  if (!response?.success) {
    throw new Error(response?.message ||
      'The offscreen semantic index did not respond. Check chrome://extensions → Manemark → Inspect views.');
  }
  return response.status;
}

function scheduleSemanticReconciliation() {
  void reconcileSemanticIndex().catch(error => {
    console.error('Manemark: background semantic index unavailable:', error);
  });
}

// Catch all mutation paths, including future changes made directly to storage.
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area !== 'local') return;
  if (Object.prototype.hasOwnProperty.call(changes, SEMANTIC_SEARCH_STORAGE_KEY)) {
    if (changes[SEMANTIC_SEARCH_STORAGE_KEY].newValue === false) {
      stopSemanticIndex();
    } else {
      scheduleSemanticReconciliation();
    }
  } else if (Object.prototype.hasOwnProperty.call(changes, 'snapshots')) {
    // Includes both merge/replace JSON imports and ordinary save/delete flows.
    scheduleSemanticReconciliation();
  }
});

chrome.runtime.onStartup?.addListener(scheduleSemanticReconciliation);

// Chrome retains context-menu registrations when an MV3 service worker goes idle.
// Register once on installation/update, rather than each time it starts up.
chrome.runtime.onInstalled.addListener(() => {
  scheduleSemanticReconciliation();
  chrome.contextMenus.create({
    id: HIGHLIGHT_MENU_ID,
    title: 'Save link to highlight to Manemark',
    contexts: ['selection'],
    documentUrlPatterns: ['http://*/*', 'https://*/*']
  });
});

/**
 * Store an entry using the same format as the original Manemark snapshots.
 * Highlight links differ from full-page links, so neither overwrites the other.
 */
async function saveSnapshot({ url, title, text, type = 'page', sourceUrl }) {
  if (!url || typeof text !== 'string' || !text.trim()) {
    throw new Error('Missing URL or text to save');
  }

  const { snapshots: storedSnapshots = [] } = await chrome.storage.local.get('snapshots');
  const snapshots = Array.isArray(storedSnapshots) ? storedSnapshots : [];
  const existingIndex = snapshots.findIndex(snapshot => snapshot.url === url);

  // Popup actions use numeric IDs. Make sure two saves in one millisecond do
  // not accidentally give different entries the same delete/copy ID.
  let id = Date.now();
  while (snapshots.some(snapshot => snapshot.id === id)) id += 1;

  const newSnapshot = {
    id,
    url,
    title: title || 'Untitled Page',
    text,
    timestamp: new Date().toISOString(),
    textPreview: text.substring(0, 150) + (text.length > 150 ? '...' : '')
  };

  if (type === 'highlight') {
    newSnapshot.type = 'highlight';
    newSnapshot.sourceUrl = sourceUrl;
  }

  if (existingIndex !== -1) {
    snapshots[existingIndex] = newSnapshot;
  } else {
    snapshots.unshift(newSnapshot);
  }

  await chrome.storage.local.set({ snapshots });
  return newSnapshot;
}

function normalizeSelection(text) {
  return (text || '').replace(/\s+/gu, ' ').trim();
}

// Text-fragment syntax requires percent-encoding hyphens as well.
function encodeTextFragmentPart(text) {
  return encodeURIComponent(text).replace(/-/g, '%2D');
}

/**
 * A short selection becomes #:~:text=exact-selected-text.
 * For a long selection, textStart,textEnd highlights the range without
 * creating an enormous URL (as supported by the Text Fragments standard).
 */
function textDirectiveFor(selectionText, context) {
  const text = normalizeSelection(selectionText);
  if (!text) throw new Error('No selected text');

  let start = text;
  let end = '';
  if (text.length > 300) {
    start = text.slice(0, 120);
    const startBoundary = start.lastIndexOf(' ');
    if (startBoundary > 60) start = start.slice(0, startBoundary);

    end = text.slice(-120);
    const endBoundary = end.indexOf(' ');
    if (endBoundary !== -1 && endBoundary < 60) end = end.slice(endBoundary + 1);
  }

  let directive = encodeTextFragmentPart(start);
  if (end) directive += ',' + encodeTextFragmentPart(end);

  // If the selected text occurs more than once, use neighboring words to
  // disambiguate, but only when they are separated by whitespace.
  if (context?.hasDuplicates) {
    if (context.prefix) directive = encodeTextFragmentPart(context.prefix) + '-,' + directive;
    if (context.suffix) directive += ',-' + encodeTextFragmentPart(context.suffix);
  }

  return directive;
}

function createHighlightUrl(pageUrl, selectionText, context) {
  const url = new URL(pageUrl);
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error('Highlight links require a regular webpage');
  }

  // Keep any existing #section anchor, but replace previous :~: directives.
  const anchor = url.hash.split(':~:')[0];
  url.hash = `${anchor || '#'}:~:text=${textDirectiveFor(selectionText, context)}`;
  return url.toString();
}

/**
 * Optionally read the current DOM selection for surrounding text. Chrome's
 * context-menu selectionText is always used as the actual saved excerpt;
 * this enhancement is not required for saving if injection is unavailable.
 */
async function findSelectionContext(tabId, frameId, selectionText) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [typeof frameId === 'number' ? frameId : 0] },
      func: () => {
        try {
          const selection = window.getSelection();
          if (!selection || selection.isCollapsed || !selection.rangeCount || !document.body) return null;

          const range = selection.getRangeAt(0);
          const selected = selection.toString().replace(/\s+/gu, ' ').trim();

          // Finding duplicate occurrences helps keep the common-case URL short.
          const bodyText = (document.body.innerText || document.body.textContent || '')
            .replace(/\s+/gu, ' ').toLocaleLowerCase();
          const needle = selected.toLocaleLowerCase();
          const firstIndex = bodyText.indexOf(needle);
          const hasDuplicates = firstIndex !== -1 && bodyText.indexOf(needle, firstIndex + 1) !== -1;
          if (!hasDuplicates) return { selected, hasDuplicates: false };

          const before = document.createRange();
          before.selectNodeContents(document.body);
          before.setEnd(range.startContainer, range.startOffset);
          const beforeText = before.toString();

          const after = document.createRange();
          after.selectNodeContents(document.body);
          after.setStart(range.endContainer, range.endOffset);
          const afterText = after.toString();

          const prefixWords = beforeText.trim().split(/\s+/u);
          const suffixWords = afterText.trim().split(/\s+/u);
          return {
            selected,
            hasDuplicates: true,
            prefix: /\s$/u.test(beforeText) ? prefixWords.slice(-2).join(' ') : '',
            suffix: /^\s/u.test(afterText) ? suffixWords.slice(0, 2).join(' ') : ''
          };
        } catch {
          return null;
        }
      }
    });

    const result = results?.[0]?.result;
    return result && result.selected === normalizeSelection(selectionText) ? result : null;
  } catch {
    // A tab may have navigated away or deny script injection. The text from
    // chrome.contextMenus still lets us construct a basic highlight link.
    return null;
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== HIGHLIGHT_MENU_ID) return;

  const selectedText = info.selectionText?.trim();
  // An embedded frame may own the selection rather than the outer document.
  // Opening the frame URL in a new top-level tab enables text-fragment matching.
  const pageUrl = info.frameUrl?.startsWith('https://') || info.frameUrl?.startsWith('http://')
    ? info.frameUrl
    : (info.pageUrl || tab?.url);

  if (!selectedText || !pageUrl) return;

  try {
    const context = tab?.id !== undefined
      ? await findSelectionContext(tab.id, info.frameId, selectedText)
      : null;
    const url = createHighlightUrl(pageUrl, selectedText, context);
    await saveSnapshot({
      url,
      title: tab?.title || 'Untitled Page',
      text: selectedText,
      type: 'highlight',
      sourceUrl: pageUrl
    });

    // Brief confirmation that the selection was saved, without opening a tab.
    if (tab?.id !== undefined) {
      try {
        await chrome.action.setBadgeBackgroundColor({ color: '#783393', tabId: tab.id });
        await chrome.action.setBadgeText({ text: '✓', tabId: tab.id });
        setTimeout(() => chrome.action.setBadgeText({ text: '', tabId: tab.id }).catch(() => {}), 2500);
      } catch {
        // A badge failure must never be treated as a failed save.
      }
    }
  } catch (error) {
    console.error('Manemark: failed to save highlight link:', error);
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Offscreen documents have chrome.runtime but not chrome.storage. Keep all
  // persisted preference reads in this MV3 service worker and relay the value.
  if (request?.target === 'semanticBackground' && request.action === 'getSemanticSearchEnabled') {
    semanticSearchIsEnabled()
      .then(enabled => sendResponse({ success: true, enabled }))
      .catch(error => sendResponse({ success: false, message: error?.message || String(error) }));
    return true;
  }
  if (request.action === 'ensureSemanticIndex') {
    reconcileSemanticIndex()
      .then(status => sendResponse({ success: true, status }))
      .catch(error => sendResponse({ success: false, message: error.message }));
    return true;
  }

  // Queue htmlsift work without keeping a long-lived runtime.sendMessage port
  // open across a WASM model load (which can take many seconds or minutes).
  // Completion is delivered separately to the popup by the offscreen document.
  // Save jobs are committed by the offscreen document even if the popup closes.
  if (!request.target && request.action === 'startHtmlsiftJob') {
    (async () => {
      if (typeof request.html !== 'string' || !request.html.trim()) {
        throw new Error('No page HTML was supplied.');
      }
      if (request.html.length > 8_000_000) {
        throw new Error('Page HTML exceeds the 8-million-character limit.');
      }
      if (request.mode !== 'save' && request.mode !== 'copy') {
        throw new Error('Unknown extraction action.');
      }
      if (!request.jobId || typeof request.jobId !== 'string') {
        throw new Error('The extraction job has no ID.');
      }
      if (request.mode === 'save' && !/^https?:\/\//i.test(request.url || '')) {
        throw new Error('Only ordinary http(s) pages can be saved.');
      }
      if (!await ensureSemanticDocument()) {
        throw new Error('Chrome cannot create an offscreen page for the AI model.');
      }
      // The offscreen document sends an immediate acknowledgement; it never
      // waits for ONNX inference on this message channel.
      let accepted;
      try {
        accepted = await chrome.runtime.sendMessage({
          target: 'htmlsiftOffscreen',
          action: 'queueHtmlsiftJob',
          jobId: request.jobId,
          mode: request.mode,
          html: request.html,
          doctype: request.doctype,
          aiExtractionEnabled: request.aiExtractionEnabled !== false,
          url: request.url,
          title: request.title
        });
      } catch (error) {
        throw new Error('The offscreen AI worker is unavailable. Reload Manemark under chrome://extensions. Details: ' +
          (error?.message || String(error)));
      }
      if (!accepted?.success) {
        throw new Error(accepted?.message || 'AI extraction worker did not accept the job.');
      }
      return { success: true, queued: true };
    })().then(sendResponse).catch(error => {
      sendResponse({ success: false, message: error?.message || String(error) });
    });
    return true;
  }

  // Older Manemark content scripts cannot safely hold their callback open while
  // htmlsift starts. Return a specific upgrade error rather than a closed port.
  if (!request.target && (request.action === 'captureHtmlsift' || request.action === 'extractHtmlsift')) {
    sendResponse({
      success: false,
      message: 'Use the Manemark popup from the updated extension; reload Manemark under chrome://extensions.'
    });
    return;
  }

  if (request.action === 'saveSnapshot') {
    saveSnapshot(request)
      .then(snapshot => sendResponse({ success: true, snapshot }))
      .catch(error => sendResponse({ success: false, message: error.message }));
    return true;
  }

  if (request.action === 'getSnapshots') {
    chrome.storage.local.get(['snapshots'], (result) => {
      sendResponse({ snapshots: result.snapshots || [] });
    });
    return true;
  }

  if (request.action === 'deleteSnapshot') {
    chrome.storage.local.get(['snapshots'], (result) => {
      const snapshots = result.snapshots || [];
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
    // Save all snapshots at once (used for import).
    chrome.storage.local.set({ snapshots: request.snapshots }, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});

// Serialize status writes so concurrent model downloads cannot overwrite each other.
let modelStatusQueue = Promise.resolve();
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  if (request.action === 'modelDownloadProgress') {
    modelStatusQueue = modelStatusQueue.catch(() => {}).then(async () => {
      const { modelDownloads = {} } = await chrome.storage.session.get('modelDownloads');
      modelDownloads[request.status.path] = request.status;
      await chrome.storage.session.set({ modelDownloads });
      chrome.runtime.sendMessage({ action: 'modelDownloadsChanged', downloads: modelDownloads }).catch(() => {});
    });
    return;
  }
  if (request.action === 'getModelDownloads') {
    modelStatusQueue.catch(() => {}).then(() => chrome.storage.session.get('modelDownloads'))
      .then(result => sendResponse({ downloads: result.modelDownloads || {} }));
    return true;
  }
  if (request.action === 'ensureModelAsset') {
    (async () => {
      if (!await ensureSemanticDocument()) throw new Error('Background model download unavailable.');
      return chrome.runtime.sendMessage({ target: 'semanticOffscreen', action: 'downloadModelAsset', path: request.path });
    })().then(sendResponse).catch(error => sendResponse({ success: false, message: error.message }));
    return true;
  }
});

// Persist presentation mode and let Chrome toggle its native sidebar.
importScripts('presentation-background.js');
