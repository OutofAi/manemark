// Manemark content bridge. Extraction runs in an extension-owned ONNX worker,
// never in the webpage context. No HTML is sent to a remote server.
(() => {
  if (globalThis.__manemarkHtmlsiftListener) return;
  globalThis.__manemarkHtmlsiftListener = true;

  function getPage() {
    if (!document.documentElement || !document.body) throw new Error('Page has no HTML body.');
    const html = document.documentElement.outerHTML;
    if (html.length > 8_000_000) throw new Error('Page HTML is larger than the 8-million-character limit.');
    return { html, url: location.href, title: document.title || 'Untitled Page' };
  }

  function whenReady(callback) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', callback, { once: true });
    } else callback();
  }

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action !== 'captureText' && request.action !== 'copyPageText') return;
    whenReady(() => {
      try {
        chrome.runtime.sendMessage({
          action: request.action === 'captureText' ? 'captureHtmlsift' : 'extractHtmlsift',
          ...getPage()
        }, response => {
          if (chrome.runtime.lastError) {
            sendResponse({ success: false, message: chrome.runtime.lastError.message });
            return;
          }
          sendResponse(response || { success: false, message: 'htmlsift did not respond.' });
        });
      } catch (error) {
        sendResponse({ success: false, message: error.message || String(error) });
      }
    });
    return true;
  });
})();
