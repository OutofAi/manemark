// Content Script for Text Snapper Extension
// Runs on web pages to extract text and communicate with extension

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'captureText') {
    try {
      // Wait for DOM to be ready, then extract text
      waitForDOM(() => {
        // Extract all visible text from the page
        const text = extractPageText();
        
        // Get page URL and title
        const url = window.location.href;
        const title = document.title || 'Untitled Page';
        
        // Validate that we got some text
        if (!text || text.trim().length === 0) {
          sendResponse({ success: false, message: 'No text content found on this page' });
          return;
        }
        
        // Send to background script for storage
        chrome.runtime.sendMessage(
          {
            action: 'saveSnapshot',
            text: text,
            url: url,
            title: title
          },
          (response) => {
            if (response && response.success) {
              sendResponse({ success: true, message: 'Text captured successfully' });
            } else {
              sendResponse({ success: false, message: 'Failed to save snapshot' });
            }
          }
        );
      });
    } catch (error) {
      console.error('Error capturing text:', error);
      sendResponse({ success: false, message: error.message });
    }
    return true; // Will respond asynchronously
  }
});

/**
 * Wait for the DOM to be fully loaded and ready
 * Useful for single-page applications that load content dynamically
 */
function waitForDOM(callback) {
  // If DOM is already ready, call immediately
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    // Give it a small delay to ensure all content is rendered
    setTimeout(callback, 100);
    return;
  }
  
  // Otherwise wait for DOMContentLoaded
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(callback, 100);
  });
}

/**
 * Extract all visible text from the page
 * Excludes script tags, style tags, and hidden elements
 */
function extractPageText() {
  try {
    // First try using the live document body for better results with SPAs
    let text = '';
    
    // Get text from body
    const bodyElement = document.body || document.documentElement;
    
    // Create a clone to avoid modifying the original
    const clone = bodyElement.cloneNode(true);
    
    // Remove unwanted elements
    const unwantedSelectors = [
      'script',
      'style',
      'noscript',
      'meta',
      'link',
      'svg',
      'iframe',
      '[style*="display:none"]',
      '[style*="display: none"]',
      '.hidden',
      '[hidden]'
    ];
    
    unwantedSelectors.forEach(selector => {
      try {
        clone.querySelectorAll(selector).forEach(el => el.remove());
      } catch (e) {
        // Ignore invalid selectors
      }
    });
    
    // Get text content - prefer innerText for better whitespace handling
    if (clone.innerText) {
      text = clone.innerText;
    } else if (clone.textContent) {
      text = clone.textContent;
    }
    
    // If we still don't have text, try getting it from the live document
    if (!text || text.trim().length === 0) {
      text = document.body.innerText || document.body.textContent || '';
    }
    
    // Clean up whitespace
    text = text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n');
    
    return text;
  } catch (error) {
    console.error('Error in extractPageText:', error);
    // Fallback: try to get text directly from document
    try {
      return document.body.innerText || document.body.textContent || '';
    } catch (e) {
      return '';
    }
  }
}
