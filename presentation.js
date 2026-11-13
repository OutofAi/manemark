// One shared interface, sized for either the toolbar popup or Chrome side panel.
const inSidePanel = new URLSearchParams(location.search).get('view') === 'sidepanel';
document.documentElement.classList.toggle('side-panel', inSidePanel);
const inFullPage = new URLSearchParams(location.search).get('view') === 'page';
document.documentElement.classList.toggle('full-page', inFullPage);

document.addEventListener('DOMContentLoaded', () => {
  if (inFullPage) return;
  const button = document.getElementById('presentationBtn');
  const icon = document.getElementById('presentationIcon');
  const feedback = document.getElementById('presentationFeedback');
  const label = inSidePanel ? 'Switch to popup' : 'Open in sidebar';
  button.title = label;
  button.setAttribute('aria-label', label);
  icon.src = inSidePanel ? 'assets/open-popup.svg' : 'assets/open-sidebar.svg';
  let windowId;
  button.disabled = true;
  chrome.windows.getCurrent().then(current => {
    windowId = current.id;
    button.disabled = false;
  }).catch(() => { feedback.textContent = 'Could not find this browser window. Reopen Manemark to try again.'; feedback.hidden = false; });

  button.addEventListener('click', () => {
    if (button.disabled || !Number.isInteger(windowId)) return;
    feedback.hidden = true;
    button.disabled = true;
    // Send directly from the click handler to preserve Chrome's user gesture.
    const operation = inSidePanel
      ? chrome.runtime.sendMessage({ action: 'switchToPopup', windowId })
      : chrome.runtime.sendMessage({ action: 'switchToSidebar', windowId });
    Promise.resolve(operation).then(result => {
      if (!result?.success) throw new Error(result?.message || 'Could not switch views.');
      if (!inSidePanel) {
        window.close(); // Only close once Chrome has opened the destination.
      }
    }).catch(error => {
      feedback.textContent = 'Could not switch views. ' + (error.message || String(error));
      feedback.hidden = false;
    }).finally(() => { button.disabled = false; });
  });
});
