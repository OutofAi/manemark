// Popup Script for Manemark Extension
// Handles UI interactions and snapshot management with token-aware export

const snapBtn = document.getElementById('snapBtn');
const copyPageBtn = document.getElementById('copyPageBtn');
const popIcon = document.getElementById('popIcon');
const exportMenuBtn = document.getElementById('exportMenuBtn');
const exportMenu = document.getElementById('exportMenu');
const exportZipBtn = document.getElementById('exportZipBtn');
const exportJsonBtn = document.getElementById('exportJsonBtn');
const exportSearchBtn = document.getElementById('exportSearchBtn');
const importBtn = document.getElementById('importBtn');
const clearAllBtn = document.getElementById('clearAllBtn');
const mainView = document.getElementById('mainView');
const settingsView = document.getElementById('settingsView');
const settingsBtn = document.getElementById('settingsBtn');
const backToLibraryBtn = document.getElementById('backToLibraryBtn');
const aiExtractionCheckbox = document.getElementById('aiExtractionCheckbox');
const semanticSearchCheckbox = document.getElementById('semanticSearchCheckbox');
const searchContainer = document.getElementById('searchContainer');
const settingsFeedback = document.getElementById('settingsFeedback');

// Store the user's capture preference in Chrome's persistent extension storage.
// Absent keys (including existing installations) default to AI extraction ON.
const AI_EXTRACTION_STORAGE_KEY = 'aiExtractionEnabled';
let aiExtractionEnabled = true;
const extractionPreferenceReady = chrome.storage.local.get({ [AI_EXTRACTION_STORAGE_KEY]: true })
  .then(result => {
    aiExtractionEnabled = result[AI_EXTRACTION_STORAGE_KEY] !== false;
    aiExtractionCheckbox.checked = aiExtractionEnabled;
  })
  .catch(error => {
    console.warn('Manemark: could not read AI extraction setting:', error);
    settingsFeedback.textContent = 'Could not read saved settings; using AI extraction.';
  })
  .finally(() => { aiExtractionCheckbox.disabled = false; });

// Absent preference keys keep existing users' MiniLM search enabled by default.
// Start in the unknown state so a previously-disabled popup cannot accidentally
// launch a query worker while its saved preference is being loaded.
const SEMANTIC_SEARCH_STORAGE_KEY = 'semanticSearchEnabled';
let semanticSearchEnabled = null;
const semanticPreferenceReady = chrome.storage.local.get({ [SEMANTIC_SEARCH_STORAGE_KEY]: true })
  .then(result => applySemanticSearchPreference(result[SEMANTIC_SEARCH_STORAGE_KEY] !== false))
  .catch(error => {
    console.warn('Manemark: could not read semantic search setting:', error);
    settingsFeedback.textContent = 'Could not read Semantic Search settings.';
    // Fail closed: don't run local indexing until the preference can be read.
    applySemanticSearchPreference(false);
  })
  .finally(() => { semanticSearchCheckbox.disabled = false; });

function showSettings(show) {
  mainView.hidden = show;
  settingsView.hidden = !show;
  document.querySelector('.container').classList.toggle('settings-open', show);
  settingsBtn.setAttribute('aria-pressed', String(show));
  settingsBtn.setAttribute('aria-label', show ? 'Close settings' : 'Open settings');
  settingsBtn.title = show ? 'Back to Manemarks' : 'Settings';
  if (show) aiExtractionCheckbox.focus();
  else settingsBtn.focus();
}

settingsBtn.addEventListener('click', () => showSettings(settingsView.hidden));
backToLibraryBtn.addEventListener('click', () => showSettings(false));
aiExtractionCheckbox.addEventListener('change', async () => {
  await extractionPreferenceReady;
  const previous = aiExtractionEnabled;
  const next = aiExtractionCheckbox.checked;
  aiExtractionEnabled = next;
  settingsFeedback.textContent = '';
  try {
    await chrome.storage.local.set({ [AI_EXTRACTION_STORAGE_KEY]: next });
  } catch (error) {
    aiExtractionEnabled = previous;
    aiExtractionCheckbox.checked = previous;
    settingsFeedback.textContent = 'Could not save the setting. Please try again.';
    console.error('Manemark: could not save AI extraction setting:', error);
  }
});

semanticSearchCheckbox.addEventListener('change', async () => {
  await semanticPreferenceReady;
  const previous = semanticSearchEnabled;
  const next = semanticSearchCheckbox.checked;
  settingsFeedback.textContent = '';
  // Persist first: background indexing checks this same setting before working.
  semanticSearchCheckbox.disabled = true;
  try {
    await chrome.storage.local.set({ [SEMANTIC_SEARCH_STORAGE_KEY]: next });
    applySemanticSearchPreference(next);
  } catch (error) {
    applySemanticSearchPreference(previous);
    settingsFeedback.textContent = 'Could not save the setting. Please try again.';
    console.error('Manemark: could not save Semantic Search setting:', error);
  } finally {
    semanticSearchCheckbox.disabled = false;
  }
});

// Keep an already-open popup in sync if another instance changes the setting.
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === 'local' && changes.snapshots) loadSnapshots();
  if (area === 'local' && changes[SEMANTIC_SEARCH_STORAGE_KEY]) {
    applySemanticSearchPreference(changes[SEMANTIC_SEARCH_STORAGE_KEY].newValue !== false);
  }
});

const importFile = document.getElementById('importFile');
const snapshotsList = document.getElementById('snapshotsList');
const searchInput = document.getElementById('searchInput');
// A Chrome action popup is destroyed when a link is opened. Keep the query
// in persistent extension-origin storage so it survives popup recreation.
const SEARCH_QUERY_STORAGE_KEY = 'manemark.popup.searchQuery';

function restoreSearchQuery() {
  try {
    searchInput.value = window.localStorage.getItem(SEARCH_QUERY_STORAGE_KEY) || '';
  } catch (error) {
    console.warn('Manemark: unable to restore the search query:', error);
  }
}

function persistSearchQuery() {
  try {
    // This is synchronous, so clicking a result cannot close the popup before
    // its latest query has been saved. An empty query clears the saved filter.
    window.localStorage.setItem(SEARCH_QUERY_STORAGE_KEY, searchInput.value);
  } catch (error) {
    console.warn('Manemark: unable to save the search query:', error);
  }
}

function handleSearchInput() {
  persistSearchQuery();
  scheduleSemanticSearch();
}

const noResultsDescription = document.getElementById('noResultsDescription');
const searchResultCount = document.getElementById('searchResultCount');
const semanticStatus = document.getElementById('semanticStatus');
const indexFooter = document.getElementById('indexFooter');
const indexFooterLabel = document.getElementById('indexFooterLabel');
const indexFooterCount = document.getElementById('indexFooterCount');
const indexFooterDetail = document.getElementById('indexFooterDetail');
const indexFooterTrack = document.getElementById('indexFooterTrack');
const indexFooterFill = document.getElementById('indexFooterFill');
const noResultsState = document.getElementById('noResultsState');
const emptyState = document.getElementById('emptyState');
const statsContainer = document.getElementById('statsContainer');
const snapText = document.getElementById('snapText');

let currentTab = null;
let currentSnapshot = null;
let savedSnapshots = [];
// The search may finish after the current tab is detected. Keep the initial
// auto-scroll pending until the active item actually exists in the rendered list.
let activeScrollPending = true;

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = ''; // ignore #section differences
    return u.toString().replace(/\/$/, ''); // ignore trailing slash differences
  } catch {
    return (url || '').replace(/#.*$/, '').replace(/\/$/, '');
  }
}


function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0] || null);
    });
  });
}

function getSnapshots() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'getSnapshots' }, (response) => {
      resolve(response?.snapshots || []);
    });
  });
}


/** Find the item for the open tab without changing the page Save button state. */
function getActiveManemark() {
  if (currentSnapshot && savedSnapshots.some(s => String(s.id) === String(currentSnapshot.id))) {
    return currentSnapshot;
  }
  // Exact fragment URLs can represent a saved text highlight, rather than a
  // full-page Manemark (which currentSnapshot intentionally excludes).
  return savedSnapshots.find(s => s.type === 'highlight' && s.url === currentTab?.url) || null;
}

/** Once per popup opening, centre the open page in the scrollable results. */
function scrollToActiveManemark() {
  if (!activeScrollPending) return;
  const activeSnapshot = getActiveManemark();
  if (!activeSnapshot) return;
  const activeItem = Array.from(snapshotsList.querySelectorAll('.snapshot-item-active'))
    .find(item => item.dataset.snapshotId === String(activeSnapshot.id));
  if (!activeItem) return; // The restored search may still be running.

  const scroller = document.querySelector('.content');
  if (!scroller) return;
  const scrollerRect = scroller.getBoundingClientRect();
  const itemRect = activeItem.getBoundingClientRect();
  const itemTop = itemRect.top - scrollerRect.top - scroller.clientTop + scroller.scrollTop;
  const itemBottom = itemTop + itemRect.height;
  const viewTop = scroller.scrollTop;
  const viewBottom = viewTop + scroller.clientHeight;
  if (itemTop < viewTop || itemBottom > viewBottom) {
    scroller.scrollTop = Math.max(0,
      itemTop - scroller.clientHeight / 2 + itemRect.height / 2);
  }
  activeScrollPending = false; // Don't jump again during later search updates.
}

async function refreshCurrentPageState() {
  currentTab = await getActiveTab();

  if (!currentTab?.url) {
    currentSnapshot = null;
    setSnapButtonState(false);
    revealSnapButton();
    document.querySelector('.controls')?.classList.add('ready');
    return;
  }

  const snapshots = await getSnapshots();
  const activeUrl = normalizeUrl(currentTab.url);

  const previousSnapshotId = currentSnapshot?.id;
  currentSnapshot =
    snapshots.find(s => s.type !== 'highlight' && normalizeUrl(s.url) === activeUrl) || null;
  if (currentSnapshot?.id !== previousSnapshotId) activeScrollPending = true;

  setSnapButtonState(Boolean(currentSnapshot));
  renderSnapshots(snapshots);

  // With a restored search, the active Manemark can only be drawn after the
  // semantic worker replies. drawSnapshots() will finish the pending scroll.
  scrollToActiveManemark();

  revealSnapButton();
  document.querySelector('.controls')?.classList.add('ready');
}

function revealSnapButton() {
  snapBtn.classList.add('ready');
}

function setSnapButtonState(isSaved) {
  const icon = snapBtn.querySelector('.btn-icon');

  if (isSaved) {
    popIcon.src = 'assets/mane.svg';
    icon.src = 'assets/bookmark_full.svg';
    snapText.textContent = 'Manemarked';
    snapBtn.dataset.state = 'saved';
  } else {
    popIcon.src = 'assets/sleepy_mane.svg';
    icon.src = 'assets/bookmark.svg';
    snapText.textContent = 'Manemark';
    snapBtn.dataset.state = 'unsaved';
  }
}

// Restore the previous query before the first snapshots are rendered.
// loadSnapshots() then runs semantic search against the restored text.
restoreSearchQuery();
loadSnapshots();
refreshCurrentPageState();

// Semantic search runs locally in a dedicated worker, never on a remote server.
searchInput.addEventListener('input', handleSearchInput);

// Fixed minimum cosine similarity for search results (20%).
// Scores below 0.20 are excluded; this is not a confidence probability.
const MINIMUM_SEMANTIC_SIMILARITY = 0.20;

// Event listeners
snapBtn.addEventListener('click', async () => {
  if (currentSnapshot) {
    chrome.runtime.sendMessage(
      { action: 'deleteSnapshot', id: currentSnapshot.id },
      (response) => {
        if (response?.success) {
          showToast('✓ Manemark removed');
          loadSnapshots();
          refreshCurrentPageState();
        } else {
          showToast('✗ Failed to remove manemark', 'error');
        }
      }
    );
  } else {
    captureCurrentPageText();
  }
});
// Copy the page using the selected capture mode, without saving a snapshot.
// Completion arrives separately rather than holding a long message callback.
copyPageBtn.addEventListener('click', () => {
  void beginCaptureJob('copy');
});

exportZipBtn.addEventListener('click', () => {
  exportMenu.classList.remove('show');
  handleExportZip();
});

exportJsonBtn.addEventListener('click', () => {
  exportMenu.classList.remove('show');
  handleExportJson();
});

exportSearchBtn.addEventListener('click', () => {
  exportMenu.classList.remove('show');
  exportSearchSnapshotsAsJson();
});
importBtn.addEventListener('click', () => importFile.click());
clearAllBtn.addEventListener('click', clearAllSnapshots);
importFile.addEventListener('change', handleImport);

// Event delegation for dynamic item buttons only
document.addEventListener('click', (e) => {
  const copyBtn = e.target.closest('.btn-copy');
  const deleteBtn = e.target.closest('.btn-delete');
  const copyLinkBtn = e.target.closest('.btn-copy-link');

  if (copyBtn) {
    const snapshotId = parseInt(copyBtn.getAttribute('data-id'), 10);
    if (!Number.isNaN(snapshotId)) {
      copyToClipboard(snapshotId, copyBtn);
    }
  }

  if (copyLinkBtn) {
    const snapshotId = parseInt(copyLinkBtn.getAttribute('data-id'), 10);
    if (!Number.isNaN(snapshotId)) {
      copyLinkToClipboard(snapshotId, copyLinkBtn);
    }
  }

  if (deleteBtn) {
    const snapshotId = parseInt(deleteBtn.getAttribute('data-id'), 10);
    if (!Number.isNaN(snapshotId)) {
      deleteSnapshot(snapshotId);
    }
  }
});

exportMenuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  updateSearchExportOption();
  exportMenu.classList.toggle('show');
});

document.addEventListener('click', (e) => {
  if (
    exportMenu &&
    !exportMenu.contains(e.target) &&
    !exportMenuBtn.contains(e.target)
  ) {
    exportMenu.classList.remove('show');
  }
});

/**
 * Handle Actions dropdown selection
 */
async function handleExportZip() {
  try {
    const input = prompt('Enter token limit per file for ZIP export:', '10000');
    if (input === null) return;

    const tokenLimit = Number(input);

    if (!Number.isInteger(tokenLimit) || tokenLimit < 500 || tokenLimit > 100000) {
      showToast('Please enter a valid token limit between 500 and 100000', 'error');
      return;
    }

    await exportSnapshotsAsZipWithTokens(tokenLimit);
  } catch (error) {
    console.error('Export ZIP failed:', error);
    showToast('✗ Export ZIP failed', 'error');
  }
}

async function handleExportJson() {
  try {
    await exportSnapshotsAsJson();
  } catch (error) {
    console.error('Export JSON failed:', error);
    showToast('✗ Export JSON failed', 'error');
  }
}


/**
 * Handle import from JSON file
 */
function handleImport(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const content = e.target.result;
      let snapshots = [];

      const data = JSON.parse(content);

      if (Array.isArray(data)) {
        snapshots = data;
      } else if (data.snapshots && Array.isArray(data.snapshots)) {
        snapshots = data.snapshots;
      } else if (data.chunk_number !== undefined) {
        snapshots = data.snapshots || [];
      }

      if (snapshots.length === 0) {
        showToast('No valid manemark found in file', 'error');
        return;
      }

      const action = confirm(
        `Found ${snapshots.length} manemarks in the file.\n\n` +
        `Click OK to MERGE with existing data\n` +
        `Click Cancel to REPLACE all existing data`
      );

      chrome.runtime.sendMessage(
        { action: 'getSnapshots' },
        (response) => {
          const existingSnapshots = response.snapshots || [];
          let finalSnapshots = [];

          if (action) {
            finalSnapshots = [...snapshots, ...existingSnapshots];
          } else {
            finalSnapshots = snapshots;
          }

          const uniqueSnapshots = Array.from(
            new Map(finalSnapshots.map(s => [s.id, s])).values()
          );

          chrome.runtime.sendMessage(
            { action: 'saveAllSnapshots', snapshots: uniqueSnapshots },
            (saveResponse) => {
              if (saveResponse && saveResponse.success) {
                showToast(`✓ Imported ${snapshots.length} manemarks!`);
                loadSnapshots();
                refreshCurrentPageState();
              } else {
                showToast('✗ Failed to import manemarks', 'error');
              }
            }
          );
        }
      );
    } catch (error) {
      console.error('Import error:', error);
      showToast('✗ Invalid JSON file', 'error');
    }
  };

  reader.readAsText(file);

  // Reset file input so same file can be selected again
  importFile.value = '';
}

/**
 * Open the Chrome storage location info
 */
function openStorageLocation() {
  let storagePath = '';

  if (navigator.platform.indexOf('Win') > -1) {
    storagePath = 'C:\\Users\\[YourUsername]\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Local Storage';
  } else if (navigator.platform.indexOf('Mac') > -1) {
    storagePath = '~/Library/Application Support/Google/Chrome/Default/Local Storage';
  } else {
    storagePath = '~/.config/google-chrome/Default/Local Storage';
  }

  const message =
    `Text Snapper data is stored in Chrome's local storage at:\n\n${storagePath}\n\n` +
    `You can export your data anytime using the Actions dropdown.`;

  alert(message);
  showToast('📁 Storage location info displayed');
}

/**
 * Read the live DOM in a single, isolated-world script execution. Avoid the
 * old content-script → background → offscreen nested sendMessage chain:
 * Chrome can close any of those pending response channels during slow ONNX
 * initialization, leaving only "message port closed" in the popup.
 */
async function captureHtmlFromActiveTab(useAI = false) {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error('No active tab found.');
  if (!/^https?:\/\//i.test(tab.url || '')) {
    throw new Error('Open a normal http(s) webpage to extract its content.');
  }
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [useAI],
    func: (sanitizeForExtraction) => {
      if (!document.documentElement || !document.body) {
        throw new Error('The webpage has no HTML body.');
      }
      let root = document.documentElement;
      if (sanitizeForExtraction) {
        // Import into a template's inert document so cloned page handlers and
        // custom elements never become active. Keep the live page untouched.
        const template = document.createElement('template');
        root = template.content.ownerDocument.importNode(root, true);
        const stripHandlers = node => {
          for (const element of [node, ...node.querySelectorAll('*')]) {
            for (const attribute of Array.from(element.attributes || [])) {
              if (/^on/i.test(attribute.name)) element.removeAttributeNode(attribute);
            }
            if (element.localName === 'template' && element.content) {
              stripHandlers(element.content);
            }
          }
        };
        stripHandlers(root);
      }
      const html = root.outerHTML;
      if (html.length > 8_000_000) {
        throw new Error('The webpage is too large to capture (8 million characters).');
      }
      // The DOCTYPE is separate from documentElement.outerHTML in the DOM.
      const doctype = document.doctype;
      const prefix = doctype ? '<!DOCTYPE ' + doctype.name
        + (doctype.publicId ? ' PUBLIC "' + doctype.publicId + '"' : '')
        + (doctype.systemId ? ' "' + doctype.systemId + '"' : '') + '>\n' : '';
      return { html, doctype: prefix, url: location.href, title: document.title || 'Untitled Page' };
    }
  });
  const page = injection?.result;
  if (!page?.html) throw new Error('Unable to read the webpage HTML.');
  return page;
}

const pendingHtmlsiftJobs = new Map();
const captureModesInFlight = new Set();

// Keep feedback local to the button that initiated the copy.
const copyButtonFeedback = new WeakMap();
function setCopyButtonState(button, state) {
  if (!button) return;
  let feedback = copyButtonFeedback.get(button);
  if (!feedback) {
    feedback = { html: button.innerHTML, label: button.getAttribute('aria-label'), title: button.getAttribute('title') };
    copyButtonFeedback.set(button, feedback);
  }
  clearTimeout(feedback.timer);
  button.disabled = state === 'loading';
  button.classList.toggle('copy-loading', state === 'loading');
  button.classList.toggle('copy-success', state === 'success');
  button.setAttribute('aria-busy', String(state === 'loading'));
  if (state === 'idle') {
    button.innerHTML = feedback.html;
    for (const [attribute, value] of [['aria-label', feedback.label], ['title', feedback.title]]) {
      if (value === null) button.removeAttribute(attribute);
      else button.setAttribute(attribute, value);
    }
    return;
  }
  const label = state === 'loading' ? 'Copying…' : 'Copied!';
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);
  button.innerHTML = state === 'loading'
    ? '<svg class="copy-feedback-icon copy-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9" opacity=".25"/><path d="M12 3a9 9 0 0 1 9 9" stroke-linecap="round"/></svg>'
    : '<svg class="copy-feedback-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
  if (state === 'success') feedback.timer = setTimeout(() => setCopyButtonState(button, 'idle'), 2000);
}

function setCaptureBusy(mode, busy, useAI) {
  if (mode === 'save') {
    snapBtn.disabled = busy;
    if (busy) {
      snapBtn.classList.add('loading');
      snapText.textContent = useAI ? 'AI extracting...' : 'Saving HTML...';
    } else {
      snapBtn.classList.remove('loading');
      if (!currentSnapshot) snapText.textContent = 'Manemark';
    }
  } else {
    setCopyButtonState(copyPageBtn, busy ? 'loading' : 'idle');
  }
}

async function beginCaptureJob(mode) {
  if (mode !== 'save' && mode !== 'copy') return;
  if (captureModesInFlight.has(mode)) return;
  captureModesInFlight.add(mode);
  if (mode === 'copy') setCopyButtonState(copyPageBtn, 'loading');
  // Avoid racing the initial preferences load on popup creation.
  await extractionPreferenceReady;
  const useAI = aiExtractionEnabled;
  setCaptureBusy(mode, true, useAI);
  let jobId;
  try {
    const page = await captureHtmlFromActiveTab(useAI);
    jobId = crypto.randomUUID();
    pendingHtmlsiftJobs.set(jobId, { mode, useAI });
    const accepted = await chrome.runtime.sendMessage({
      action: 'startHtmlsiftJob', jobId, mode,
      aiExtractionEnabled: useAI,
      ...page
    });
    if (!accepted?.success) {
      throw new Error(accepted?.message || 'Could not start page capture.');
    }
    // The offscreen page sends a completion event for both AI and raw HTML.
  } catch (error) {
    if (jobId) pendingHtmlsiftJobs.delete(jobId);
    captureModesInFlight.delete(mode);
    setCaptureBusy(mode, false, useAI);
    showToast(`✗ ${error?.message || 'Could not capture the page.'}`, 'error');
  }
}

function captureCurrentPageText() {
  void beginCaptureJob('save');
}

chrome.runtime.onMessage.addListener(message => {
  if (message?.action !== 'htmlsiftJobComplete') return;
  const job = pendingHtmlsiftJobs.get(message.jobId);
  if (!job) return;
  pendingHtmlsiftJobs.delete(message.jobId);
  if (job.mode === 'save' || !message.success) {
    captureModesInFlight.delete(job.mode);
    setCaptureBusy(job.mode, false, job.useAI);
  }
  if (!message.success) {
    showToast(`✗ ${message.message || 'Page capture failed.'}`, 'error');
    return;
  }
  if (job.mode === 'save') {
    showToast(job.useAI ? '✓ Main content saved!' : '✓ Raw HTML saved!');
    loadSnapshots();
    void refreshCurrentPageState();
  } else {
    void navigator.clipboard.writeText(message.text || '')
      .then(() => {
        setCopyButtonState(copyPageBtn, 'success');
        showToast(job.useAI ? '✓ Main content copied!' : '✓ Raw HTML copied!');
      })
      .catch(error => {
        setCopyButtonState(copyPageBtn, 'idle');
        showToast(`✗ Clipboard access failed: ${error?.message || String(error)}`, 'error');
      })
      .finally(() => captureModesInFlight.delete(job.mode));
  }
});

/**
 * Load and display all snapshots
 */
function loadSnapshots() {
  chrome.runtime.sendMessage(
    { action: 'getSnapshots' },
    (response) => {
      const snapshots = response?.snapshots || [];
      renderSnapshots(snapshots);
      renderStats(snapshots);
    }
  );
}

/**
 * MiniLM-powered search: a background offscreen worker maintains the document
 * index; this popup worker only embeds the query and ranks cached vectors.
 * Keyword matching is intentionally not used as a hidden fallback.
 */
let semanticWorker;
let semanticTimer;
let semanticSequence = 0;
let semanticMatches = null;

function setSemanticStatus(message = '', isError = false) {
  semanticStatus.textContent = message;
  semanticStatus.classList.toggle('visible', Boolean(message));
  semanticStatus.classList.toggle('error', isError);
}

function getSemanticWorker() {
  if (semanticSearchEnabled !== true) return null;
  if (semanticWorker) return semanticWorker;
  semanticWorker = new Worker(chrome.runtime.getURL('semantic-worker.js'), { type: 'module' });
  const queryWorker = semanticWorker;
  semanticWorker.onmessage = ({ data }) => {
    if (data?.type === 'model-download-request') {
      chrome.runtime.sendMessage({ action: 'ensureModelAsset', path: data.path })
        .then(result => queryWorker.postMessage({ type: 'model-download-response', requestId: data.requestId, ...result }))
        .catch(error => queryWorker.postMessage({ type: 'model-download-response', requestId: data.requestId, success: false, message: error.message }));
      return;
    }
    if (semanticSearchEnabled !== true || data.id !== semanticSequence || !searchInput.value.trim()) return;
    if (data.type === 'progress') {
      setSemanticStatus(data.message);
    } else if (data.type === 'results') {
      semanticMatches = data.ranked;
      if (data.pending) {
        setSemanticStatus(`${data.total - data.pending} of ${data.total} indexed · preparing the rest in the background`);
      } else {
        setSemanticStatus(data.mode === 'ivf'
          ? 'Approximate semantic results · processed locally'
          : 'Results ranked by semantic similarity · processed locally');
      }
      drawSnapshots();
    } else if (data.type === 'error') {
      semanticMatches = null;
      setSemanticStatus('Semantic search unavailable: ' + data.message, true);
      drawSnapshots();
    }
  };
  semanticWorker.onerror = (event) => {
    semanticMatches = null;
    setSemanticStatus('Could not load the local semantic-search runtime. Run the setup steps in SETUP_MINILM.md.', true);
    drawSnapshots();
    console.error('MiniLM worker error:', event.message);
    semanticWorker.terminate();
    semanticWorker = null;
  };
  return semanticWorker;
}

function scheduleSemanticSearch() {
  clearTimeout(semanticTimer);
  const query = semanticSearchEnabled === true ? searchInput.value.trim() : '';
  semanticSequence++;
  semanticMatches = null;
  if (!query || !savedSnapshots.length) {
    setSemanticStatus();
    drawSnapshots();
    return;
  }
  setSemanticStatus('Searching cached Manemarks…');
  drawSnapshots();
  const id = semanticSequence;
  semanticTimer = setTimeout(() => {
    if (semanticSearchEnabled !== true) return;
    try {
      getSemanticWorker().postMessage({
        type: 'search',
        id,
        query,
        snapshots: savedSnapshots.map(({ id, title, url, text }) => ({ id, title, url, text }))
      });
    } catch (error) {
      setSemanticStatus('Semantic search unavailable: ' + error.message, true);
    }
  }, 350);
}

// Index progress is shown only while work is pending (or when it fails).
// The footer has a constant height while active, even between documents.
let lastIndexSequence = -1;
function renderIndexFooter(status) {
  if (semanticSearchEnabled !== true || !status || !['idle', 'checking', 'indexing', 'complete', 'error'].includes(status.phase)) return;
  if (!Number.isFinite(status.sequence) || status.sequence < lastIndexSequence) return;
  lastIndexSequence = status.sequence;

  // 100% means the index worker has finished. Hide the footer entirely;
  // a later save/import will show it again when a new batch starts.
  if (status.phase === 'complete' || status.phase === 'idle') {
    indexFooter.hidden = true;
    return;
  }

  const total = Math.max(0, Number(status.total) || 0);
  const indexed = Math.max(0, Math.min(total, Number(status.indexed) || 0));
  const chunkTotal = Math.max(0, Number(status.chunksTotal) || 0);
  const chunksDone = Math.max(0, Math.min(chunkTotal, Number(status.chunksDone) || 0));
  const progress = total ? 100 * (indexed + (chunkTotal ? chunksDone / chunkTotal : 0)) / total : 0;
  // Do not display 100% until the worker reports completion and is idle.
  const percent = Math.max(0, Math.min(99, Math.floor(progress)));

  indexFooter.hidden = false;
  indexFooter.classList.remove('checking', 'indexing', 'complete', 'error');
  indexFooter.classList.add(status.phase);
  indexFooterFill.style.width = status.phase === 'checking' ? '35%' : `${percent}%`;
  indexFooterTrack.setAttribute('aria-valuenow', String(percent));
  indexFooterTrack.setAttribute('aria-valuetext', status.phase === 'checking'
    ? 'Checking cached Manemarks' : `${indexed} of ${total} Manemarks indexed`);

  if (status.phase === 'checking') {
    indexFooterLabel.textContent = 'Checking local search index…';
    indexFooterCount.textContent = `${total} Manemarks`;
    indexFooterDetail.textContent = '';
  } else if (status.phase === 'indexing') {
    indexFooterLabel.textContent = 'Indexing in background';
    indexFooterCount.textContent = `${indexed} / ${total} · ${percent}%`;
    indexFooterDetail.textContent = status.stage === 'loading-model'
      ? 'Preparing AI model (first use downloads it)…'
      : chunkTotal && indexed < total
        ? `Manemark ${indexed + 1} · chunk ${chunksDone} of ${chunkTotal}`
        : '';
  } else {
    indexFooterLabel.textContent = 'Background indexing paused';
    indexFooterCount.textContent = `${indexed} / ${total}`;
    indexFooterDetail.textContent = status.message || 'Indexing failed; reopen the popup to retry.';
    indexFooterDetail.title = indexFooterDetail.textContent;
  }
  if (status.phase !== 'error') indexFooterDetail.removeAttribute('title');
}

// A hidden worker reports progress while this popup is open. On reopening,
// ensureSemanticIndex also returns the current status from the offscreen page.
chrome.runtime.onMessage.addListener(message => {
  if (semanticSearchEnabled !== true || !['semanticIndexProgress', 'semanticIndexComplete', 'semanticIndexError'].includes(message.action)) return;
  renderIndexFooter(message.status);
  if (message.action === 'semanticIndexComplete' && searchInput.value.trim()) {
    scheduleSemanticSearch();
  }
});

function requestSemanticIndex() {
  if (semanticSearchEnabled !== true) return;
  chrome.runtime.sendMessage({ action: 'ensureSemanticIndex' })
    .then(response => {
      if (semanticSearchEnabled !== true) return;
      if (!response?.success) throw new Error(response?.message || 'Index service not available');
      renderIndexFooter(response.status);
    })
    .catch(error => {
      if (semanticSearchEnabled !== true) return;
      console.error('Manemark: cannot read background index status:', error);
      // Do not overwrite a newer state that arrived in a live progress message.
      if (lastIndexSequence < 0) {
        renderIndexFooter({ phase: 'error', indexed: 0, total: savedSnapshots.length,
          sequence: 0, message: 'Could not start background indexing: ' + error.message });
      }
    });
}

function applySemanticSearchPreference(enabled) {
  if (semanticSearchEnabled === enabled) return;
  semanticSearchEnabled = enabled;
  semanticSearchCheckbox.checked = enabled;
  searchContainer.hidden = !enabled;
  semanticStatus.hidden = !enabled;
  lastIndexSequence = -1;
  if (!enabled) {
    clearTimeout(semanticTimer);
    semanticSequence++;
    semanticMatches = null;
    if (semanticWorker) {
      semanticWorker.terminate();
      semanticWorker = null;
    }
    setSemanticStatus();
    indexFooter.hidden = true;
    drawSnapshots(); // Ignore a saved search query and show every Manemark.
  } else {
    scheduleSemanticSearch(); // Restore the query/filter from before disabling.
    requestSemanticIndex();
  }
}

/** Refresh list after captures, deletes, imports and tab state updates. */
function renderSnapshots(snapshots) {
  savedSnapshots = snapshots;
  scheduleSemanticSearch();
}

/** The same qualifying, ranked semantic matches are used by display and export. */
function getQualifiedSemanticMatches() {
  return (semanticMatches || []).filter(row =>
    Number.isFinite(row.score) && row.score >= MINIMUM_SEMANTIC_SIMILARITY
  );
}

/** Null means no active query or that the search has not finished yet. */
function getSearchResultSnapshots() {
  if (semanticSearchEnabled !== true || !searchInput.value.trim() || !semanticMatches) return null;
  const snapshotsById = new Map(savedSnapshots.map(snapshot => [String(snapshot.id), snapshot]));
  return getQualifiedSemanticMatches()
    .map(match => snapshotsById.get(String(match.id)))
    .filter(Boolean);
}

function updateSearchExportOption() {
  const isSearching = semanticSearchEnabled === true && Boolean(searchInput.value.trim());
  const results = getSearchResultSnapshots();
  exportSearchBtn.hidden = !isSearching;
  exportSearchBtn.disabled = !results || results.length === 0;
  exportSearchBtn.title = !results ? 'Waiting for search results'
    : results.length === 0 ? 'No matching Manemarks to export'
    : `Export ${results.length} matching Manemark${results.length === 1 ? '' : 's'} as JSON`;
}

function drawSnapshots() {
  const query = semanticSearchEnabled === true ? searchInput.value.trim() : '';
  const isSearching = Boolean(query);
  const searchResults = getSearchResultSnapshots();
  let visibleSnapshots = isSearching ? (searchResults || []) : savedSnapshots;
  const filteredMatches = getQualifiedSemanticMatches();
  const scoresById = new Map(filteredMatches.map(row => [String(row.id), row.score]));
  updateSearchExportOption();
  // The user may be viewing a Manemark that is not semantically related to
  // an older saved query. Keep it available as "Current page", distinct from
  // actual search matches, rather than hiding the orange active-page marker.
  const matchingResultCount = visibleSnapshots.length;
  const activeManemark = getActiveManemark();
  const showCurrentPageSeparately = Boolean(isSearching && semanticMatches && activeManemark &&
    !visibleSnapshots.some(s => String(s.id) === String(activeManemark.id)));
  if (showCurrentPageSeparately) visibleSnapshots = [...visibleSnapshots, activeManemark];

  noResultsDescription.textContent = 'Try a different question or clear the search.';
  const activeUrl = normalizeUrl(currentTab?.url || '');

  emptyState.style.display = savedSnapshots.length === 0 ? 'flex' : 'none';
  noResultsState.style.display = isSearching && semanticMatches && visibleSnapshots.length === 0 ? 'flex' : 'none';
  searchResultCount.textContent = isSearching && semanticMatches
    ? `${matchingResultCount} of ${savedSnapshots.length} Manemarks${showCurrentPageSeparately ? ' · current page also shown' : ''}`
    : '';

  snapshotsList.innerHTML = visibleSnapshots
    .map(snapshot => {
      const similarityScore = isSearching ? scoresById.get(String(snapshot.id)) : undefined;
      const isCurrentPageOnly = showCurrentPageSeparately && String(snapshot.id) === String(activeManemark.id);
      const isActive = snapshot.type === 'highlight'
        ? snapshot.url === currentTab?.url
        : normalizeUrl(snapshot.url) === activeUrl;

      return `
        <div
          class="snapshot-item ${isActive ? 'snapshot-item-active' : ''}"
          data-snapshot-id="${escapeHtml(snapshot.id)}"
        >
          <div class="snapshot-header">
            <div class="snapshot-title">${escapeHtml(snapshot.title)}${snapshot.type === 'highlight' ? ' <span class="snapshot-kind">Highlight</span>' : ''}${isCurrentPageOnly ? ' <span class="snapshot-kind">Current page</span>' : ''}</div>
            <div class="snapshot-time">${formatTime(snapshot.timestamp)}${Number.isFinite(similarityScore) ? `<span class="snapshot-similarity" title="Cosine similarity score, not a probability">Similarity ${Math.round(similarityScore * 100)}%</span>` : ''}</div>
          </div>
          <a href="${escapeHtml(safeManemarkUrl(snapshot.url))}" target="_blank" rel="noopener noreferrer" class="snapshot-url" title="${escapeHtml(snapshot.url)}">
            ${escapeHtml(snapshot.url.substring(0, 60))}${snapshot.url.length > 60 ? '...' : ''}
          </a>
          <div class="snapshot-preview">${escapeHtml(snapshot.textPreview)}</div>
          <div class="snapshot-actions">
            ${snapshot.type === 'highlight' ? `<button class="btn-small btn-copy-link" data-id="${escapeHtml(snapshot.id)}" aria-label="Copy highlight link" title="Copy highlight link">
              <svg class="btn-icon-item" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M10 13a5 5 0 0 0 7 .5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
                <path d="M14 11a5 5 0 0 0-7-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
              </svg>
            </button>` : ''}
            <button class="btn-small btn-copy" data-id="${escapeHtml(snapshot.id)}" aria-label="Copy">
              <svg class="btn-icon-item" viewBox="-0.5 -0.5 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
                <path d="M6.875 5.625h5.625s1.25 0 1.25 1.25v5.625s0 1.25 -1.25 1.25h-5.625s-1.25 0 -1.25 -1.25v-5.625s0 -1.25 1.25 -1.25" stroke-width="1"></path>
                <path d="M3.125 9.375H2.5a1.25 1.25 0 0 1 -1.25 -1.25V2.5a1.25 1.25 0 0 1 1.25 -1.25h5.625a1.25 1.25 0 0 1 1.25 1.25v0.625" stroke-width="1"></path>
              </svg>
            </button>
            <button class="btn-small btn-delete" data-id="${escapeHtml(snapshot.id)}" aria-label="Delete">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="-0.5 -0.5 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" class="feather feather-trash-2" id="Trash-2--Streamline-Feather" height="16" width="16">
                <path d="m1.875 3.75 1.25 0 10 0" stroke-width="1"></path>
                <path d="M11.875 3.75v8.75a1.25 1.25 0 0 1 -1.25 1.25H4.375a1.25 1.25 0 0 1 -1.25 -1.25V3.75m1.875 0V2.5a1.25 1.25 0 0 1 1.25 -1.25h2.5a1.25 1.25 0 0 1 1.25 1.25v1.25" stroke-width="1"></path>
                <path d="m6.25 6.875 0 3.75" stroke-width="1"></path>
                <path d="m8.75 6.875 0 3.75" stroke-width="1"></path>
              </svg>
            </button>
          </div>
        </div>
      `;
    })
    .join('');

  // This happens after the semantic search has produced real DOM rows, not
  // during its initial blank/loading render.
  scrollToActiveManemark();
  window.dispatchEvent(new CustomEvent('manemark-library-rendered', { detail: { snapshots: savedSnapshots } }));
}

/**
 * Render statistics
 */
function renderStats(snapshots) {
  const totalSnapshots = snapshots.length;
  const counter = globalThis.ManeTokenCounter;
  // Count stored document content. JSON ZIP files are counted separately,
  // because their metadata/escaping contribute additional GPT tokens.
  let tokenLabel = 'tokenizer not built';
  if (counter && counter.encoding === 'o200k_base' && typeof counter.countTokens === 'function') {
    try {
      const totalTokens = snapshots.reduce(
        (sum, snapshot) => sum + calculateSnapshotTokens(snapshot), 0
      );
      tokenLabel = `<strong>${totalTokens.toLocaleString()}</strong> content tokens`;
    } catch (error) {
      console.error('Manemark: token count failed:', error);
      tokenLabel = 'token count unavailable';
    }
  }

  statsContainer.innerHTML = `
    <div class="stats">
      <strong>${totalSnapshots}</strong> manemark${totalSnapshots !== 1 ? 's' : ''} •
      ${tokenLabel}
    </div>
  `;
}

/**
 * Copy snapshot text to clipboard
 */
function copyToClipboard(id, button) {
  if (button?.disabled) return;
  setCopyButtonState(button, 'loading');
  chrome.runtime.sendMessage(
    { action: 'getSnapshots' },
    (response) => {
      if (chrome.runtime.lastError || !response || !response.snapshots) {
        setCopyButtonState(button, 'idle');
        showToast('Error: Could not retrieve snapshot', 'error');
        return;
      }

      const snapshot = response.snapshots.find(s => s.id === id);
      if (snapshot && snapshot.text) {
        navigator.clipboard.writeText(snapshot.text).then(() => {
          setCopyButtonState(button, 'success');
          showToast('✓ Text copied to clipboard!');
        }).catch((err) => {
          setCopyButtonState(button, 'idle');
          console.error('Copy failed:', err);
          showToast('✗ Failed to copy text', 'error');
        });
      } else {
        setCopyButtonState(button, 'idle');
        showToast('Error: Snapshot not found', 'error');
      }
    }
  );
}

/**
 * Copy a saved highlight's direct URL, rather than its selected text.
 */
function copyLinkToClipboard(id, button) {
  if (button?.disabled) return;
  setCopyButtonState(button, 'loading');
  const snapshot = savedSnapshots.find(s => s.id === id && s.type === 'highlight');
  if (!snapshot?.url) {
    setCopyButtonState(button, 'idle');
    showToast('✗ Highlight link not found', 'error');
    return;
  }

  navigator.clipboard.writeText(snapshot.url).then(() => {
    setCopyButtonState(button, 'success');
    showToast('✓ Highlight link copied!');
  }).catch(() => {
    setCopyButtonState(button, 'idle');
    showToast('✗ Failed to copy highlight link', 'error');
  });
}

/**
 * Delete a single snapshot
 */
function deleteSnapshot(id) {
  if (confirm('Delete this snapshot?')) {
    chrome.runtime.sendMessage(
      { action: 'deleteSnapshot', id: id },
      (response) => {
        if (response && response.success) {
          showToast('✓ Manemark deleted');
          loadSnapshots();
          refreshCurrentPageState();
        } else {
          showToast('✗ Failed to delete snapshot', 'error');
        }
      }
    );
  }
}

/**
 * Clear all snapshots
 */
function clearAllSnapshots() {
  if (confirm('Delete all manemarks? This cannot be undone.')) {
    chrome.runtime.sendMessage(
      { action: 'clearAll' },
      (response) => {
        if (response && response.success) {
          showToast('✓ All manemarks cleared');
          loadSnapshots();
          refreshCurrentPageState();
        } else {
          showToast('✗ Failed to clear manemarks', 'error');
        }
      }
    );
  }
}

/**
 * GPT tokenizer is bundled locally at build time, NOT loaded from a CDN.
 * Do not report heuristic numbers when the tokenizer is missing.
 */
function countGptTokens(text) {
  const counter = globalThis.ManeTokenCounter;
  if (!counter || counter.encoding !== 'o200k_base' || typeof counter.countTokens !== 'function') {
    throw new Error('GPT tokenizer bundle missing. Run npm install && npm run build in the Manemark folder.');
  }
  return counter.countTokens(String(text ?? ''));
}

/**
 * Stored text token counts are cached per fetched snapshot object. This makes
 * repeated search redraws cheap without persisting any extra browser data.
 */
const snapshotTokenCache = new WeakMap();
function calculateSnapshotTokens(snapshot) {
  if (snapshotTokenCache.has(snapshot)) return snapshotTokenCache.get(snapshot);
  const count = countGptTokens(snapshot.text || '');
  snapshotTokenCache.set(snapshot, count);
  return count;
}

/**
 * Export snapshots as single JSON file
 */
function exportSnapshotsAsJson() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { action: 'getSnapshots' },
      (response) => {
        try {
          const snapshots = response.snapshots || [];

          if (snapshots.length === 0) {
            showToast('No manemarks to export', 'error');
            resolve();
            return;
          }

          const exportData = {
            export_date: new Date().toISOString(),
            total_manemarks: snapshots.length,
            snapshots: snapshots
          };

          const dataStr = JSON.stringify(exportData, null, 2);
          const dataBlob = new Blob([dataStr], { type: 'application/json' });
          const url = URL.createObjectURL(dataBlob);
          const link = document.createElement('a');

          link.href = url;
          link.download = `text-snapper-all-${new Date().toISOString().split('T')[0]}.json`;
          link.click();

          URL.revokeObjectURL(url);
          showToast(`✓ Exported ${snapshots.length} manemarks as JSON`);
        } catch (error) {
          console.error('Export error:', error);
          showToast('✗ Failed to export JSON', 'error');
        } finally {
          resolve();
        }
      }
    );
  });
}

/**
 * Export only true semantic-search matches, never the separately shown
 * "Current page" Manemark unless it also passed the search threshold.
 * Use the standard JSON schema so this file can be imported as well.
 */
function exportSearchSnapshotsAsJson() {
  const snapshots = getSearchResultSnapshots();
  if (!snapshots) {
    showToast('Search is still loading', 'error');
    return;
  }
  if (snapshots.length === 0) {
    showToast('No matching Manemarks to export', 'error');
    return;
  }

  try {
    const exportData = {
      export_date: new Date().toISOString(),
      search_query: searchInput.value.trim(),
      total_manemarks: snapshots.length,
      snapshots
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `manemark-search-${new Date().toISOString().split('T')[0]}.json`;
    link.click();
    URL.revokeObjectURL(url);
    showToast(`✓ Exported ${snapshots.length} search result${snapshots.length === 1 ? '' : 's'} as JSON`);
  } catch (error) {
    console.error('Search export failed:', error);
    showToast('✗ Search export failed', 'error');
  }
}

/**
 * Exact count of the entire JSON export file. The token count includes
 * field names, JSON escapes, metadata, and pretty-print whitespace.
 */
function makeZipChunkPayload(snapshots, index, total, tokenLimit, exportedAt) {
  const payload = {
    chunk_number: index,
    total_chunks: total,
    entries_in_chunk: snapshots.length,
    estimated_tokens: 0,
    token_limit: tokenLimit,
    manemarks: snapshots,
    exported_at: exportedAt
  };
  // estimated_tokens itself changes the JSON. Recount until stable.
  for (let i = 0; i < 12; i++) {
    const count = countGptTokens(JSON.stringify(payload, null, 2));
    if (count === payload.estimated_tokens) return payload;
    payload.estimated_tokens = count;
  }
  // Very rare possibility of a token-count oscillation: use a conservative
  // value but always independently validate the final file below.
  return payload;
}

function countZipChunk(snapshots, limit, timestamp, index = 999999, total = 999999) {
  const json = JSON.stringify(makeZipChunkPayload(snapshots, index, total, limit, timestamp), null, 2);
  return countGptTokens(json);
}

/**
 * Split a single oversized snapshot's text into lossless ordered parts.
 * Only ZIP chunks are split; the saved Manemark and ordinary JSON exports
 * remain unchanged. Part metadata lets a consumer reconstruct the text.
 */
function splitOversizedSnapshot(snapshot, tokenLimit, timestamp) {
  if (typeof snapshot.text !== 'string' || snapshot.text.length === 0) {
    throw new Error(`Manemark "${snapshot.title || snapshot.id}" has metadata larger than the ZIP token limit.`);
  }

  const originalText = snapshot.text;
  const parts = [];
  let offset = 0;
  // The provisional 6-digit fields over-budget the final short counters.
  // Keep a margin so packaging fields don't accidentally exceed the limit.
  const budget = Math.max(0, tokenLimit - 24);

  while (offset < originalText.length) {
    const makePart = (text, partIndex) => ({
      ...snapshot,
      text,
      textPreview: text.slice(0, 160),
      part_number: partIndex,
      total_parts: 999999,
      source_snapshot_id: snapshot.id
    });
    const partIndex = parts.length + 1;
    const remaining = originalText.length - offset;
    let lo = 1;
    let hi = remaining;
    let best = 0;
    // Binary search the maximum UTF-16 slice that fits the full JSON file.
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const section = originalText.slice(offset, offset + mid);
      const candidate = makePart(section, partIndex);
      if (countZipChunk([candidate], tokenLimit, timestamp) <= budget) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best === 0) {
      throw new Error(`Token limit ${tokenLimit} is too small for Manemark "${snapshot.title || snapshot.id}" and its metadata.`);
    }

    let end = offset + best;
    // Do not split surrogate pairs (emoji or other supplementary characters).
    if (end < originalText.length && end > offset &&
        /[\uD800-\uDBFF]/.test(originalText[end - 1]) &&
        /[\uDC00-\uDFFF]/.test(originalText[end])) {
      end--;
    }
    if (end === offset) {
      throw new Error('Token limit is too small to preserve a complete Unicode character.');
    }
    // Prefer a recent line break, without dropping any characters.
    const lastLineBreak = originalText.lastIndexOf('\n', end - 1);
    if (lastLineBreak > offset + Math.floor((end - offset) * 0.6)) {
      end = lastLineBreak + 1;
    }

    parts.push(makePart(originalText.slice(offset, end), partIndex));
    offset = end;
  }
  for (const part of parts) part.total_parts = parts.length;
  return parts;
}

/**
 * Greedy packing: count real UTF-8/JSON text using GPT o200k_base BPE.
 * Never produce an over-limit output, including for giant documents.
 */
function createTokenAwareChunks(snapshots, tokenLimit, timestamp = new Date().toISOString()) {
  if (!Number.isInteger(tokenLimit) || tokenLimit < 500 || tokenLimit > 100000) {
    throw new Error('Token limit must be an integer between 500 and 100000.');
  }
  // Ensure the tokenizer has been built even if snapshots is empty.
  countGptTokens('');
  const chunks = [];
  let pending = [];
  const budget = tokenLimit - 24;
  const flush = () => {
    if (pending.length) chunks.push(pending);
    pending = [];
  };

  for (const snapshot of snapshots) {
    const singleCount = countZipChunk([snapshot], tokenLimit, timestamp);
    if (singleCount > budget) {
      flush();
      for (const part of splitOversizedSnapshot(snapshot, tokenLimit, timestamp)) {
        chunks.push([part]);
      }
    } else if (pending.length && countZipChunk([...pending, snapshot], tokenLimit, timestamp) > budget) {
      flush();
      pending.push(snapshot);
    } else {
      pending.push(snapshot);
    }
  }
  flush();

  const output = chunks.map((entries, index) => {
    const payload = makeZipChunkPayload(entries, index + 1, chunks.length, tokenLimit, timestamp);
    const json = JSON.stringify(payload, null, 2);
    const actualTokens = countGptTokens(json);
    if (actualTokens > tokenLimit) {
      throw new Error(`ZIP part ${index + 1} would contain ${actualTokens} tokens (limit ${tokenLimit}).`);
    }
    return { json, totalTokens: actualTokens, snapshots: entries };
  });
  return output;
}

/** Export ZIP with exactly counted, limit-checked JSON chunks. */
function exportSnapshotsAsZipWithTokens(tokenLimitPerFile) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'getSnapshots' }, async (response) => {
      try {
        const snapshots = response?.snapshots || [];
        if (snapshots.length === 0) {
          showToast('No manemarks to export', 'error');
          return;
        }
        if (typeof JSZip === 'undefined') {
          throw new Error('ZIP library not available.');
        }

        const timestamp = new Date().toISOString();
        const chunks = createTokenAwareChunks(snapshots, tokenLimitPerFile, timestamp);
        const zip = new JSZip();
        chunks.forEach((chunk, index) => {
          const filename = `manemarks_chunk_${String(index + 1).padStart(3, '0')}.json`;
          zip.file(filename, chunk.json);
        });
        const totalTokens = chunks.reduce((sum, chunk) => sum + chunk.totalTokens, 0);
        zip.file('README.json', JSON.stringify({
          export_date: timestamp,
          total_manemarks: snapshots.length,
          total_chunks: chunks.length,
          token_limit_per_file: tokenLimitPerFile,
          estimated_total_tokens: totalTokens,
          tokenizer_encoding: 'o200k_base',
          split_documents: 'For split entries, join text in part_number order for each source_snapshot_id.',
          description: 'Manemark export: locally GPT-tokenized JSON chunks. Token counts include JSON serialization.'
        }, null, 2));

        const blob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `manemark-gpt-tokens-${timestamp.slice(0, 10)}.zip`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        showToast(`✓ Exported ${snapshots.length} manemarks in ${chunks.length} GPT-counted JSON files`);
      } catch (error) {
        console.error('Export ZIP failed:', error);
        showToast(`✗ ${error.message || 'Failed to create ZIP file'}`, 'error');
      } finally {
        resolve();
      }
    });
  });
}

/**
 * Show toast notification
 */
function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type === 'error' ? 'error' : ''}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, type === 'error' ? 8500 : 3000);
}

/**
 * Format timestamp to readable format
 */
function formatTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}

/**
 * Format bytes to human readable format
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

/** Only open normal web links from imported Manemarks. */
function safeManemarkUrl(url) {
  try {
    const parsed = new URL(String(url));
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '#';
  } catch {
    return '#';
  }
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  const safeText = String(text ?? '');
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return safeText.replace(/[&<>"']/g, m => map[m]);
}
// Independent of indexing: both bars can be displayed simultaneously.
let downloadView = {};
let downloadRefreshTimer;
let receivedLiveDownloads = false;
function renderModelDownloads(downloads) {
  downloadView = downloads;
  const footer = document.getElementById('downloadFooter');
  const entries = Object.values(downloads);
  const active = entries.filter(s => ['downloading', 'saving'].includes(s.phase) && Date.now() - s.updatedAt < 20 * 60 * 1000);
  const errors = entries.filter(s => s.phase === 'error');
  const recent = entries.filter(s => s.phase === 'complete' && Date.now() - s.updatedAt < 5000);
  const visible = active.length ? active : errors.length ? errors : recent;
  footer.hidden = !visible.length;
  clearTimeout(downloadRefreshTimer);
  if (!visible.length) return;
  const failed = !active.length && errors.length > 0;
  const complete = !active.length && !failed;
  const total = active.reduce((sum, s) => sum + s.total, 0);
  const loaded = active.reduce((sum, s) => sum + s.loaded, 0);
  const known = active.length > 0 && active.every(s => s.total > 0);
  const percent = complete ? 100 : known ? Math.min(99, Math.floor(loaded / total * 100)) : 0;
  footer.classList.toggle('checking', !failed && !complete && !known);
  footer.classList.toggle('error', failed);
  const label = document.getElementById('downloadFooterLabel');
  const count = document.getElementById('downloadFooterCount');
  const detail = document.getElementById('downloadFooterDetail');
  const track = document.getElementById('downloadFooterTrack');
  document.getElementById('downloadFooterFill').style.width = known || complete ? percent + '%' : '35%';
  if (known || complete) track.setAttribute('aria-valuenow', String(percent));
  else track.removeAttribute('aria-valuenow');
  const names = [...new Set(visible.map(s => s.path.startsWith('htmlsift-mini/') ? 'AI extraction' : 'Semantic search'))].join(' + ');
  label.textContent = failed ? 'Model download interrupted' : complete ? 'Model files saved for offline use' : 'One-time model download';
  const mb = n => (n / 1048576).toFixed(1) + ' MB';
  count.textContent = complete ? '100%' : failed ? '' : known ? percent + '%' : loaded ? mb(loaded) : 'Connecting…';
  detail.textContent = failed ? 'Try the feature again to retry. ' + errors[0].message
    : complete ? 'Cached on this device — no download needed next time.'
    : names + ' · ' + (known ? mb(loaded) + ' / ' + mb(total) + ' · ' : '') + 'Continues if you close this popup.';
  detail.title = detail.textContent;
  track.setAttribute('aria-valuetext', label.textContent + '. ' + count.textContent);
  if (!failed) downloadRefreshTimer = setTimeout(() => renderModelDownloads(downloadView), 1000);
}
chrome.runtime.onMessage.addListener(message => {
  if (message.action !== 'modelDownloadsChanged') return;
  receivedLiveDownloads = true;
  renderModelDownloads(message.downloads);
});
chrome.runtime.sendMessage({ action: 'getModelDownloads' }).then(result => {
  if (!receivedLiveDownloads) renderModelDownloads(result?.downloads || {});
}).catch(() => {});
