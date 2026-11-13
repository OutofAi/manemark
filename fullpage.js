import { renderMarkdown, safeLink } from './markdown-renderer.mjs';
if (new URLSearchParams(location.search).get('view') === 'page') {
  const viewer = document.createElement('main');
  viewer.className = 'document-viewer';
  viewer.setAttribute('aria-label', 'Saved Manemark viewer');
  viewer.innerHTML = `
    <header class="viewer-header">
      <div class="viewer-heading"><div class="viewer-eyebrow">Manemark / document</div>
        <h1 class="viewer-title">Select a Manemark</h1><a class="viewer-source" target="_blank" rel="noopener noreferrer" hidden></a><div class="viewer-meta"></div>
      </div>
      <div class="viewer-controls" role="group" aria-label="Document view">
        <button type="button" id="markdownViewBtn" aria-pressed="true">Markdown</button>
        <button type="button" id="rawViewBtn" aria-pressed="false">Raw</button>
        <button type="button" class="viewer-copy" id="viewerCopyBtn" aria-label="Copy document text" title="Copy document text" disabled>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"/></svg>
        </button>
      </div>
    </header>
    <div class="viewer-feedback" role="status" aria-live="polite"></div>
    <div class="viewer-scroll" tabindex="0" aria-label="Document content">
      <div class="viewer-empty"><h2>Your saved web, with room to read.</h2><p>Select an item on the left to open its full content.</p></div>
      <article class="viewer-markdown" hidden></article><pre class="viewer-raw" hidden></pre>
    </div>`;
  document.body.append(viewer);
  const find = selector => viewer.querySelector(selector);
  const markdown = find('.viewer-markdown'), raw = find('.viewer-raw');
  const markdownButton = find('#markdownViewBtn'), rawButton = find('#rawViewBtn');
  const copy = find('#viewerCopyBtn');
  const list = document.getElementById('snapshotsList');
  let snapshots = [], selected = null, lastText = null, lastId = null, lastUrl = null;
  let mode = 'markdown', copyTimer;
  try { selected = sessionStorage.getItem('manemark.reader.selected'); } catch {}
  function markSelection() {
    list.querySelectorAll('.snapshot-item').forEach(row => {
      const active = row.dataset.snapshotId === selected;
      row.classList.toggle('reader-selected', active);
      row.tabIndex = 0;
      row.setAttribute('aria-label', 'Read ' + (row.querySelector('.snapshot-title')?.textContent || 'Manemark'));
      if (active) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current');
    });
  }
  function paint() {
    const item = snapshots.find(s => String(s.id) === selected);
    markSelection();
    markdownButton.disabled = rawButton.disabled = copy.disabled = !item;
    find('.viewer-empty').hidden = Boolean(item);
    markdown.hidden = !item || mode !== 'markdown';
    raw.hidden = !item || mode !== 'raw';
    markdownButton.setAttribute('aria-pressed', String(mode === 'markdown'));
    rawButton.setAttribute('aria-pressed', String(mode === 'raw'));
    if (!item) {
      find('.viewer-title').textContent = 'Select a Manemark';
      find('.viewer-source').hidden = true;
      find('.viewer-meta').textContent = '';
      markdown.replaceChildren(); raw.textContent = '';
      lastText = lastId = lastUrl = null;
      return;
    }
    find('.viewer-title').textContent = item.title || 'Untitled Manemark';
    const source = find('.viewer-source');
    const url = safeLink(item.url || '');
    source.hidden = !url;
    if (url) { source.href = url; source.textContent = item.url; }
    const text = String(item.text || '');
    find('.viewer-meta').textContent = `${text.length.toLocaleString()} characters · ${item.type === 'highlight' ? 'Highlight' : 'Saved page'}`;
    if (lastId !== selected || lastText !== text || lastUrl !== item.url) {
      raw.textContent = text;
      try { markdown.innerHTML = renderMarkdown(text, item.url); }
      catch { markdown.textContent = text; }
      find('.viewer-scroll').scrollTop = 0;
      find('.viewer-feedback').textContent = '';
      lastId = selected; lastText = text; lastUrl = item.url;
    }
  }
  function select(id) {
    selected = String(id);
    try { sessionStorage.setItem('manemark.reader.selected', selected); } catch {}
    paint();
  }
  function update(items) {
    snapshots = Array.isArray(items) ? items : [];
    if (selected && !snapshots.some(s => String(s.id) === selected)) selected = null;
    paint();
  }
  list.addEventListener('click', event => {
    if (event.target.closest('a,button,input')) return;
    const row = event.target.closest('.snapshot-item');
    if (row) select(row.dataset.snapshotId);
  });
  list.addEventListener('keydown', event => {
    if (!['Enter', ' '].includes(event.key) || !event.target.matches('.snapshot-item')) return;
    event.preventDefault(); select(event.target.dataset.snapshotId);
  });
  markdownButton.addEventListener('click', () => { mode = 'markdown'; paint(); });
  rawButton.addEventListener('click', () => { mode = 'raw'; paint(); });
  copy.addEventListener('click', async () => {
    const item = snapshots.find(s => String(s.id) === selected);
    if (!item) return;
    clearTimeout(copyTimer);
    try {
      await navigator.clipboard.writeText(String(item.text || ''));
      find('.viewer-feedback').textContent = 'Copied document text.';
    } catch { find('.viewer-feedback').textContent = 'Could not copy. Select text in Raw view and copy it manually.'; }
    copyTimer = setTimeout(() => { find('.viewer-feedback').textContent = ''; }, 2500);
  });
  let sawLiveData = false;
  window.addEventListener('manemark-library-rendered', event => {
    sawLiveData = true; update(event.detail.snapshots);
  });
  chrome.storage.local.get({ snapshots: [] }).then(result => {
    if (!sawLiveData) update(result.snapshots);
  });
}
