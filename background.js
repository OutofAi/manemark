// Background Service Worker for Manemark
// Handles snapshot storage and communication between content script and popup.
// When native custom storage is configured, manemark-data.json is the durable copy;
// chrome.storage.local remains a working cache/fallback for reliability.

importScripts('storage-manager.js');

async function getCachedSnapshots() {
  const result = await chromeStorageGet(['snapshots']);
  return result.snapshots || [];
}

async function setCachedSnapshots(snapshots) {
  await chromeStorageSet({ snapshots });
}

async function loadSnapshots() {
  const external = await readSnapshotsFromConfiguredFolder();

  if (external.ok) {
    await setCachedSnapshots(external.snapshots);
    return {
      snapshots: external.snapshots,
      storage: 'folder',
      externalSync: true
    };
  }

  return {
    snapshots: await getCachedSnapshots(),
    storage: 'chrome',
    externalSync: external.reason === 'chrome-mode',
    externalReason: external.reason
  };
}

async function persistSnapshots(snapshots) {
  // Always keep a local cache so the extension still works if a selected
  // drive/folder is temporarily unavailable or Chrome asks for permission again.
  await setCachedSnapshots(snapshots);

  const external = await writeSnapshotsToConfiguredFolder(snapshots);
  return {
    externalSync: external.ok || external.reason === 'chrome-mode',
    externalReason: external.ok ? null : external.reason
  };
}

async function handleMessage(request) {
  if (request.action === 'saveSnapshot') {
    const { snapshots } = await loadSnapshots();

    const newSnapshot = {
      id: Date.now(),
      url: request.url,
      title: request.title,
      text: request.text,
      timestamp: new Date().toISOString(),
      textPreview: request.text.substring(0, 150) + (request.text.length > 150 ? '...' : '')
    };

    const existingIndex = snapshots.findIndex(s => s.url === request.url);
    if (existingIndex !== -1) {
      snapshots[existingIndex] = newSnapshot;
    } else {
      snapshots.unshift(newSnapshot);
    }

    const storageResult = await persistSnapshots(snapshots);
    return { success: true, snapshot: newSnapshot, ...storageResult };
  }

  if (request.action === 'getSnapshots') {
    return loadSnapshots();
  }

  if (request.action === 'deleteSnapshot') {
    const { snapshots } = await loadSnapshots();
    const filtered = snapshots.filter(s => s.id !== request.id);
    const storageResult = await persistSnapshots(filtered);
    return { success: true, ...storageResult };
  }

  if (request.action === 'clearAll') {
    const storageResult = await persistSnapshots([]);
    return { success: true, ...storageResult };
  }

  if (request.action === 'saveAllSnapshots') {
    const snapshots = Array.isArray(request.snapshots) ? request.snapshots : [];
    const storageResult = await persistSnapshots(snapshots);
    return { success: true, ...storageResult };
  }

  if (request.action === 'getStorageStatus') {
    const settings = await getManemarkStorageSettings();
    let helperConnected = false;
    try {
      await pingManemarkNativeHost();
      helperConnected = true;
    } catch (_) {}

    return {
      success: true,
      settings,
      folderPath: settings.folderPath || '',
      helperConnected
    };
  }

  return { success: false, message: 'Unknown action' };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request)
    .then(sendResponse)
    .catch((error) => {
      console.error('Manemark background error:', error);
      sendResponse({ success: false, message: error?.message || 'Unexpected storage error' });
    });

  return true;
});
