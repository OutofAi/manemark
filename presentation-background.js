// Native toolbar behaviour persists independently of whether the panel is open.
// Closing it (including with Chrome's X) does not reset the chosen mode.
const PRESENTATION_MODE_KEY = 'presentationMode';
async function applyPresentationMode(mode) {
  const sidebar = mode === 'sidebar';
  await chrome.action.setPopup({ popup: sidebar ? '' : 'popup.html' });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: sidebar });
}
let presentationQueue = chrome.storage.local.get({ [PRESENTATION_MODE_KEY]: 'popup' })
  .then(saved => applyPresentationMode(saved[PRESENTATION_MODE_KEY]))
  .catch(error => console.warn('Manemark: could not restore presentation mode:', error));
function queuePresentationChange(work) {
  const result = presentationQueue.catch(() => {}).then(work);
  presentationQueue = result.catch(() => {});
  return result;
}
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !['switchToSidebar', 'switchToPopup'].includes(request.action)) return;
  if (!Number.isInteger(request.windowId)) {
    sendResponse({ success: false, message: 'Invalid browser window.' });
    return;
  }
  if (request.action === 'switchToSidebar') {
    // Call before any await/storage work: opening the panel needs a user gesture.
    const opening = chrome.sidePanel.open({ windowId: request.windowId });
    opening.then(() => queuePresentationChange(async () => {
      try {
        await applyPresentationMode('sidebar');
        await chrome.storage.local.set({ [PRESENTATION_MODE_KEY]: 'sidebar' });
      } catch (error) {
        await applyPresentationMode('popup');
        await chrome.sidePanel.close({ windowId: request.windowId });
        throw error;
      }
    })).then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, message: error.message }));
  } else {
    queuePresentationChange(async () => {
      try {
        await applyPresentationMode('popup');
        await chrome.action.openPopup({ windowId: request.windowId });
        await chrome.sidePanel.close({ windowId: request.windowId });
        await chrome.storage.local.set({ [PRESENTATION_MODE_KEY]: 'popup' });
      } catch (error) {
        await applyPresentationMode('sidebar');
        throw error;
      }
    }).then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, message: error.message }));
  }
  return true;
});
