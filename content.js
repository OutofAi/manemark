// Content Script for Text Snapper Extension
// Runs on web pages to extract text and communicate with extension

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'captureText') {
    try {
      // Wait for DOM to be ready, then extract text
      waitForDOM(() => {
        // Extract all visible text from the page
        const { text, blocks } = extractPageText();
        
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
            blocks: blocks,
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
        const { text } = extractPageText();

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

    const blocks = [];
    walkElement(clone, blocks, []);

    const text = blocks
      .map(formatBlockText)
      .filter(line => line.length > 0)
      .join('\n\n')
      .replace(/\n{3,}/g, '\n\n');

    if (text && text.trim().length > 0) {
      return { text, blocks };
    }

    // Fallback: use the live document if the semantic root yields nothing
    return {
      text: document.body.innerText || document.body.textContent || '',
      blocks: []
    };
  } catch (error) {
    console.error('Error in extractPageText:', error);
    try {
      return {
        text: document.body.innerText || document.body.textContent || '',
        blocks: []
      };
    } catch (e) {
      return { text: '', blocks: [] };
    }
  }
}

function formatBlockText(block) {
  if (block.type === 'li') {
    return `- ${block.text}`;
  }
  if (block.type === 'table') {
    return block.text;
  }
  return block.text;
}

function walkElement(node, blocks, headingPath) {
  if (!node) {
    return headingPath;
  }

  if (node.nodeType === Node.TEXT_NODE) {
    const text = normalizeText(node.textContent);
    if (text) {
      blocks.push({ type: 'p', text, headingPath: [...headingPath] });
    }
    return headingPath;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return headingPath;
  }

  if (node.hidden || node.getAttribute('aria-hidden') === 'true') {
    return headingPath;
  }

  const tagName = node.tagName.toUpperCase();

  if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'SVG', 'IFRAME'].includes(tagName)) {
    return headingPath;
  }

  if (['H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(tagName)) {
    const text = getElementText(node);
    if (text) {
      const level = Number(tagName.slice(1));
      const newHeadingPath = headingPath.slice(0, level - 1);
      newHeadingPath.push(text);
      blocks.push({ type: tagName.toLowerCase(), text, headingPath: [...newHeadingPath] });
      return newHeadingPath;
    }
    return headingPath;
  }

  if (tagName === 'P') {
    const text = getElementText(node);
    if (text) {
      blocks.push({ type: 'p', text, headingPath: [...headingPath] });
    }
    return headingPath;
  }

  if (tagName === 'LI') {
    const text = getElementText(node);
    if (text) {
      blocks.push({ type: 'li', text, headingPath: [...headingPath] });
    }
    return headingPath;
  }

  if (tagName === 'PRE') {
    const text = getElementText(node);
    if (text) {
      blocks.push({ type: 'pre', text, headingPath: [...headingPath] });
    }
    return headingPath;
  }

  if (tagName === 'CODE' && !node.closest('pre')) {
    const text = getElementText(node);
    if (text) {
      blocks.push({ type: 'code', text, headingPath: [...headingPath] });
    }
    return headingPath;
  }

  if (tagName === 'TABLE') {
    const rows = Array.from(node.querySelectorAll('tr')).map(row => {
      const cells = Array.from(row.querySelectorAll('th, td')).map(cell => getElementText(cell)).filter(Boolean);
      return cells.join('\t');
    }).filter(Boolean);

    if (rows.length > 0) {
      blocks.push({ type: 'table', text: rows.join('\n'), headingPath: [...headingPath] });
    }
    return headingPath;
  }

  let currentHeadingPath = headingPath;
  Array.from(node.childNodes).forEach(child => {
    currentHeadingPath = walkElement(child, blocks, currentHeadingPath);
  });

  return currentHeadingPath;
}

function normalizeText(text) {
  return text ? text.replace(/\s+/g, ' ').trim() : '';
}

function getElementText(element) {
  return normalizeText(element.innerText || element.textContent || '');
}
