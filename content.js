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

  if (request.action === 'copyPageText') {
    try {
      waitForDOM(() => {
        const text = extractPageText();

        if (!text || text.trim().length === 0) {
          sendResponse({ success: false, message: 'No text content found on this page' });
          return;
        }

        sendResponse({ success: true, text });
      });
    } catch (error) {
      console.error('Error copying page text:', error);
      sendResponse({ success: false, message: error.message });
    }
    return true;
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
    const rootElement = document.querySelector('main, article, [role="main"]') || document.body || document.documentElement;
    const clone = rootElement.cloneNode(true);

    const unwantedSelectors = [
      'script',
      'style',
      'noscript',
      'meta',
      'link',
      'svg',
      'iframe',
      'nav',
      'header',
      'footer',
      'aside',
      '[role="navigation"]',
      '[role="complementary"]',
      '.sidebar',
      '.toc',
      '.menu',
      '.breadcrumbs',
      '.cookie',
      '.banner',
      '.advertisement',
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

    clone.querySelectorAll('[aria-hidden="true"]').forEach(el => el.remove());

    const lines = [];
    walkElement(clone, lines);

    const text = lines
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n');

    if (text && text.trim().length > 0) {
      return text;
    }

    // Fallback: use the live document if the semantic root yields nothing
    return document.body.innerText || document.body.textContent || '';
  } catch (error) {
    console.error('Error in extractPageText:', error);
    try {
      return document.body.innerText || document.body.textContent || '';
    } catch (e) {
      return '';
    }
  }
}

function walkElement(node, lines) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) {
    if (node && node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent.replace(/\s+/g, ' ').trim();
      if (text) {
        lines.push(text);
      }
    }
    return;
  }

  if (node.hidden || node.getAttribute('aria-hidden') === 'true') {
    return;
  }

  const tagName = node.tagName.toUpperCase();

  if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'SVG', 'IFRAME'].includes(tagName)) {
    return;
  }

  if (['H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(tagName)) {
    const text = node.innerText.trim();
    if (text) {
      lines.push(text, '');
    }
    return;
  }

  if (tagName === 'P') {
    const text = node.innerText.trim();
    if (text) {
      lines.push(text, '');
    }
    return;
  }

  if (tagName === 'LI') {
    const text = node.innerText.trim();
    if (text) {
      lines.push(`- ${text}`);
    }
    return;
  }

  if (tagName === 'PRE' || tagName === 'CODE') {
    const text = node.innerText.trim();
    if (text) {
      lines.push(text, '');
    }
    return;
  }

  if (tagName === 'TABLE') {
    const tableRows = Array.from(node.querySelectorAll('tr')).map(row => {
      const cells = Array.from(row.querySelectorAll('th, td')).map(cell => cell.innerText.trim()).filter(Boolean);
      return cells.join('\t');
    }).filter(Boolean);

    if (tableRows.length > 0) {
      lines.push(...tableRows, '');
    }
    return;
  }

  if (tagName === 'BR') {
    lines.push('');
    return;
  }

  const childNodes = Array.from(node.childNodes);
  childNodes.forEach(child => walkElement(child, lines));

  if (['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'ASIDE', 'NAV', 'HEADER', 'FOOTER'].includes(tagName)) {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== '') {
      lines.push('');
    }
  }
}
