// Popup Script for Text Snapper Extension
// Handles UI interactions and snapshot management with token-aware export

const snapBtn = document.getElementById('snapBtn');
const popIcon = document.getElementById('popIcon');
const exportMenuBtn = document.getElementById('exportMenuBtn');
const exportMenu = document.getElementById('exportMenu');
const exportZipBtn = document.getElementById('exportZipBtn');
const exportJsonBtn = document.getElementById('exportJsonBtn');
const importBtn = document.getElementById('importBtn');
const clearAllBtn = document.getElementById('clearAllBtn');

const importFile = document.getElementById('importFile');
const snapshotsList = document.getElementById('snapshotsList');
const emptyState = document.getElementById('emptyState');
const statsContainer = document.getElementById('statsContainer');
const snapText = document.getElementById('snapText');

let currentTab = null;
let currentSnapshot = null;

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

  currentSnapshot =
    snapshots.find(s => normalizeUrl(s.url) === activeUrl) || null;

  setSnapButtonState(Boolean(currentSnapshot));
  renderSnapshots(snapshots);

  if (currentSnapshot) {
    const activeItem = snapshotsList.querySelector(
      `[data-snapshot-id="${currentSnapshot.id}"]`
    );

    if (activeItem) {
      const scroller = document.querySelector('.content');

      if (scroller) {
        const itemTop = activeItem.offsetTop;
        const itemBottom = itemTop + activeItem.offsetHeight;
        const viewTop = scroller.scrollTop;
        const viewBottom = viewTop + scroller.clientHeight;

        if (itemTop < viewTop || itemBottom > viewBottom) {
          const targetScrollTop =
            itemTop - (scroller.clientHeight / 2) + (activeItem.offsetHeight / 2);

          scroller.scrollTop = Math.max(0, targetScrollTop);
        }
      }
    }
  }

  revealSnapButton();
  document.querySelector('.controls')?.classList.add('ready');
}

function revealSnapButton() {
  snapBtn.classList.add('ready');
}

function setSnapButtonState(isSaved) {
  const icon = snapBtn.querySelector('.btn-icon');

  if (isSaved) {
    popIcon.src = 'assets/mane.png';
    icon.src = 'assets/bookmark_full.svg';
    snapText.textContent = 'Manemarked';
    snapBtn.dataset.state = 'saved';
  } else {
    popIcon.src = 'assets/sleepy_mane.png';
    icon.src = 'assets/bookmark.svg';
    snapText.textContent = 'Manemark';
    snapBtn.dataset.state = 'unsaved';
  }
}

// Load snapshots when popup opens
loadSnapshots();
refreshCurrentPageState();

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
exportZipBtn.addEventListener('click', () => {
  exportMenu.classList.remove('show');
  handleExportZip();
});

exportJsonBtn.addEventListener('click', () => {
  exportMenu.classList.remove('show');
  handleExportJson();
});
importBtn.addEventListener('click', () => importFile.click());
clearAllBtn.addEventListener('click', clearAllSnapshots);
importFile.addEventListener('change', handleImport);

// Event delegation for dynamic item buttons only
document.addEventListener('click', (e) => {
  const copyBtn = e.target.closest('.btn-copy');
  const deleteBtn = e.target.closest('.btn-delete');

  if (copyBtn) {
    const snapshotId = parseInt(copyBtn.getAttribute('data-id'), 10);
    if (!Number.isNaN(snapshotId)) {
      copyToClipboard(snapshotId);
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

    const tokenLimit = parseInt(input, 10);

    if (isNaN(tokenLimit) || tokenLimit < 500 || tokenLimit > 100000) {
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
 * Capture text from the current active tab
 */
function captureCurrentPageText() {
  snapBtn.classList.add('loading');
  snapText.textContent = 'Capturing...';

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.id) {
      snapBtn.classList.remove('loading');
      snapText.textContent = 'Manemark';
      showToast('✗ No active tab found', 'error');
      return;
    }

    chrome.scripting.executeScript(
      {
        target: { tabId: tab.id },
        files: ['content.js']
      },
      () => {
        if (chrome.runtime.lastError) {
          snapBtn.classList.remove('loading');
          snapText.textContent = 'Manemark';
          showToast(`✗ ${chrome.runtime.lastError.message}`, 'error');
          return;
        }

        chrome.tabs.sendMessage(
          tab.id,
          { action: 'captureText' },
          (response) => {
            snapBtn.classList.remove('loading');
            snapText.textContent = 'Manemarked';

            if (chrome.runtime.lastError) {
              showToast(`✗ ${chrome.runtime.lastError.message}`, 'error');
              return;
            }

            if (response && response.success) {
              showToast('✓ Text captured successfully!');
              loadSnapshots();
              refreshCurrentPageState();
            } else {
              showToast('✗ Failed to capture text', 'error');
            }
          }
        );
      }
    );
  });
}

/**
 * Load and display all snapshots
 */
function loadSnapshots() {
  chrome.runtime.sendMessage(
    { action: 'getSnapshots' },
    (response) => {
      const snapshots = response.snapshots || [];

      if (snapshots.length === 0) {
        snapshotsList.innerHTML = '';
        emptyState.style.display = 'flex';
        statsContainer.innerHTML = '';
      } else {
        emptyState.style.display = 'none';
        renderSnapshots(snapshots);
        renderStats(snapshots);
      }
    }
  );
}

/**
 * Render snapshots in the UI
 */
function renderSnapshots(snapshots) {
  const activeUrl = normalizeUrl(currentTab?.url || '');

  snapshotsList.innerHTML = snapshots
    .map(snapshot => {
      const isActive = normalizeUrl(snapshot.url) === activeUrl;

      return `
        <div
          class="snapshot-item ${isActive ? 'snapshot-item-active' : ''}"
          data-snapshot-id="${snapshot.id}"
        >
          <div class="snapshot-header">
            <div class="snapshot-title">${escapeHtml(snapshot.title)}</div>
            <div class="snapshot-time">${formatTime(snapshot.timestamp)}</div>
          </div>
          <a href="${escapeHtml(snapshot.url)}" target="_blank" class="snapshot-url" title="${escapeHtml(snapshot.url)}">
            ${escapeHtml(snapshot.url.substring(0, 60))}${snapshot.url.length > 60 ? '...' : ''}
          </a>
          <div class="snapshot-preview">${escapeHtml(snapshot.textPreview)}</div>
          <div class="snapshot-actions">
            <button class="btn-small btn-copy" data-id="${snapshot.id}"><img src="assets/copy.svg" alt="" class="btn-icon-item"></button>
            <button class="btn-small btn-delete" data-id="${snapshot.id}"><img src="assets/bin.svg" alt="" class="btn-icon-item"></button>
          </div>
        </div>
      `;
    })
    .join('');
}

/**
 * Render statistics
 */
function renderStats(snapshots) {
  const totalSnapshots = snapshots.length;
  const totalCharacters = snapshots.reduce((sum, s) => sum + s.text.length, 0);

  statsContainer.innerHTML = `
    <div class="stats">
      <strong>${totalSnapshots}</strong> manemark${totalSnapshots !== 1 ? 's' : ''} • 
      <strong>${formatBytes(totalCharacters)}</strong> of text
    </div>
  `;
}

/**
 * Copy snapshot text to clipboard
 */
function copyToClipboard(id) {
  chrome.runtime.sendMessage(
    { action: 'getSnapshots' },
    (response) => {
      if (!response || !response.snapshots) {
        showToast('Error: Could not retrieve snapshot', 'error');
        return;
      }

      const snapshot = response.snapshots.find(s => s.id === id);
      if (snapshot && snapshot.text) {
        navigator.clipboard.writeText(snapshot.text).then(() => {
          showToast('✓ Text copied to clipboard!');
        }).catch((err) => {
          console.error('Copy failed:', err);
          showToast('✗ Failed to copy text', 'error');
        });
      } else {
        showToast('Error: Snapshot not found', 'error');
      }
    }
  );
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
 * Estimate token count using a simple heuristic
 * Approximate: 1 token ≈ 4 characters
 */
function estimateTokens(text) {
  const words = text.trim().split(/\s+/).length;
  return Math.ceil(words * 1.3);
}

/**
 * Calculate total tokens for a snapshot including metadata
 */
function calculateSnapshotTokens(snapshot) {
  const textTokens = estimateTokens(snapshot.text);
  const titleTokens = estimateTokens(snapshot.title);
  const urlTokens = estimateTokens(snapshot.url);
  const overhead = 50;

  return textTokens + titleTokens + urlTokens + overhead;
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
 * Export snapshots as token-aware chunked JSON files in a ZIP
 * Each JSON file respects the token limit
 */
function exportSnapshotsAsZipWithTokens(tokenLimitPerFile) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { action: 'getSnapshots' },
      async (response) => {
        try {
          const snapshots = response.snapshots || [];

          if (snapshots.length === 0) {
            showToast('No manemarks to export', 'error');
            resolve();
            return;
          }

          if (typeof JSZip === 'undefined') {
            console.error('JSZip library not loaded');
            showToast('✗ ZIP library not available', 'error');
            resolve();
            return;
          }

          const chunks = createTokenAwareChunks(snapshots, tokenLimitPerFile);
          const zip = new JSZip();

          chunks.forEach((chunk, index) => {
            const chunkData = {
              chunk_number: index + 1,
              total_chunks: chunks.length,
              entries_in_chunk: chunk.snapshots.length,
              estimated_tokens: chunk.totalTokens,
              token_limit: tokenLimitPerFile,
              manemarks: chunk.snapshots,
              exported_at: new Date().toISOString()
            };

            const fileName = `manemarks_chunk_${String(index + 1).padStart(3, '0')}.json`;
            zip.file(fileName, JSON.stringify(chunkData, null, 2));
          });

          const totalTokens = chunks.reduce((sum, chunk) => sum + chunk.totalTokens, 0);
          const metadata = {
            export_date: new Date().toISOString(),
            total_manemarks: snapshots.length,
            total_chunks: chunks.length,
            token_limit_per_file: tokenLimitPerFile,
            estimated_total_tokens: totalTokens,
            description: 'Text Snapper Export - Token-aware chunked JSON files for RAG compatibility'
          };

          zip.file('README.json', JSON.stringify(metadata, null, 2));

          const blob = await zip.generateAsync({ type: 'blob' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');

          link.href = url;
          link.download = `text-snapper-export-${new Date().toISOString().split('T')[0]}.zip`;
          link.click();

          URL.revokeObjectURL(url);
          showToast(`✓ Exported ${snapshots.length} manemarks in ${chunks.length} token-aware files`);
        } catch (error) {
          console.error('Export error:', error);
          showToast('✗ Failed to create ZIP file', 'error');
        } finally {
          resolve();
        }
      }
    );
  });
}

/**
 * Create token-aware chunks from snapshots
 * Respects token limit per file
 */
function createTokenAwareChunks(snapshots, tokenLimit) {
  const chunks = [];
  let currentChunk = {
    snapshots: [],
    totalTokens: 0
  };

  for (const snapshot of snapshots) {
    const snapshotTokens = calculateSnapshotTokens(snapshot);

    if (currentChunk.totalTokens + snapshotTokens > tokenLimit && currentChunk.snapshots.length > 0) {
      chunks.push(currentChunk);
      currentChunk = {
        snapshots: [],
        totalTokens: 0
      };
    }

    currentChunk.snapshots.push(snapshot);
    currentChunk.totalTokens += snapshotTokens;
  }

  if (currentChunk.snapshots.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
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
  }, 3000);
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