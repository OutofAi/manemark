// Background Service Worker for Text Snapper Extension
// Handles storage and communication between content script and popup

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'saveSnapshot') {
    chrome.storage.local.get(['snapshots'], (result) => {
      const snapshots = result.snapshots || [];

      const newSnapshot = {
        id: Date.now(),
        url: request.url,
        title: request.title,
        text: request.text,
        blocks: request.blocks || [],
        timestamp: new Date().toISOString(),
        textPreview: request.text.substring(0, 150) + (request.text.length > 150 ? '...' : '')
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
    // Save all snapshots at once (used for import)
    chrome.storage.local.set({ snapshots: request.snapshots }, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});