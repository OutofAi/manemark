import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const popup = fs.readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
const names = ['normalizeUrl', 'getActiveManemark', 'scrollToActiveManemark', 'getQualifiedSemanticMatches', 'getSearchResultSnapshots', 'updateSearchExportOption', 'drawSnapshots'];
const functions = names.map(name => {
  const match = popup.match(new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, 'm'));
  assert.ok(match, `popup has ${name}`);
  return match[0];
}).join('\n');

function fixture({query = 'saved query', matches = null, currentUrl = 'https://example.com/current',
  pageId = 'current', snapshots = undefined, fullPage = true} = {}) {
  const docs = snapshots ?? [
    {id: 'one', url:'https://example.com/one', title:'One'},
    {id: 'two', url:'https://example.com/two', title:'Two'},
    {id: 'current', url:'https://example.com/current', title:'Current'},
  ].map(row => ({...row, textPreview: 'Preview', timestamp: 1}));
  const scroller = {
    scrollTop:0, clientTop:0, clientHeight:110,
    getBoundingClientRect:() => ({top: 0})
  };
  const list = {
    rows: [], html: '',
    get innerHTML() {return this.html;},
    set innerHTML(html) {
      this.html = html;
      this.rows = [...html.matchAll(/class="snapshot-item (snapshot-item-active|)"\s+data-snapshot-id="([^"]+)"/g)]
        .map((m, index) => ({
          dataset: {snapshotId: m[2]}, active: m[1] === 'snapshot-item-active',
          getBoundingClientRect: () => ({top: index * 160 - scroller.scrollTop, height: 90})
        }));
    },
    querySelectorAll(selector) {
      assert.equal(selector, '.snapshot-item-active');
      return this.rows.filter(r => r.active);
    }
  };
  const searchInput = {value:query};
  const searchResultCount = {textContent:''};
  const noResultsState = {style:{display:''}};
  const emptyState = {style:{display:''}};
  const exportSearchBtn = {hidden:true, disabled:true, title:''};
  const ctx = vm.createContext({
    document: {querySelector: name => name === '.content' ? scroller : null},
    snapshotsList:list, searchInput, searchResultCount, noResultsState, emptyState, exportSearchBtn,
    noResultsDescription:{textContent:''}, URL,
    escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    safeManemarkUrl: url => url,
    formatTime: () => 'today'
  });
  vm.runInContext(`const MINIMUM_SEMANTIC_SIMILARITY = 0.20;
    let savedSnapshots = [], currentTab = null, currentSnapshot = null;
    let semanticMatches = null, activeScrollPending = true;
    ${functions}
    this.setState = x => {
      savedSnapshots = x.snapshots;
      currentTab = x.tab;
      currentSnapshot = x.currentSnapshot;
      semanticMatches = x.matches;
    };
    this.isScrollPending = () => activeScrollPending;
    this.draw = drawSnapshots;`, ctx);
  ctx.setState({snapshots:docs, tab:{url:currentUrl},
    currentSnapshot:fullPage ? docs.find(s => s.id === pageId) ?? null : null, matches});
  return {ctx, list, scroller, searchResultCount, noResultsState};
}

// Saved query: the first render is empty while the semantic worker is busy.
// After async results arrive, the open page is focused.
const matched = fixture();
matched.ctx.draw();
assert.equal(matched.list.rows.length, 0);
assert.equal(matched.ctx.isScrollPending(), true);
matched.ctx.setState({
  snapshots:[{id:'one',url:'https://example.com/one',title:'One'},
    {id:'two',url:'https://example.com/two',title:'Two'},
    {id:'current',url:'https://example.com/current',title:'Current'}]
    .map(row => ({...row, textPreview: 'Preview', timestamp: 1})),
  tab:{url:'https://example.com/current'},
  currentSnapshot:{id:'current',url:'https://example.com/current',title:'Current'},
  matches:[{id:'one',score:.9},{id:'two',score:.8},{id:'current',score:.7}]
});
matched.ctx.draw();
assert.equal(matched.list.rows.length, 3);
assert.ok(matched.list.rows[2].active, 'current page is orange/active');
assert.ok(matched.scroller.scrollTop > 0, 'current page scrolls into view after search completes');
assert.equal(matched.ctx.isScrollPending(), false);
assert.ok(!matched.list.html.includes('Current page</span>'), 'matched Manemark is not duplicated or mislabelled');
const scrollAfterFocus = matched.scroller.scrollTop;
matched.ctx.draw();
assert.equal(matched.scroller.scrollTop, scrollAfterFocus, 'later list updates do not repeatedly force-scroll');

// Saved query that does NOT match current page: keep it separately visible.
const filtered = fixture({matches:[{id:'one',score:.72}]});
filtered.ctx.draw();
assert.deepEqual(filtered.list.rows.map(r => r.dataset.snapshotId), ['one','current']);
assert.ok(filtered.list.rows[1].active, 'the unranked current page remains highlighted');
assert.ok(filtered.list.html.includes('Current page</span>'));
assert.equal(filtered.searchResultCount.textContent, '1 of 3 Manemarks · current page also shown');
assert.ok(filtered.scroller.scrollTop > 0);

// No search matches at all: current page remains visible, with zero search hits.
const noSearchMatches = fixture({matches:[]});
noSearchMatches.ctx.draw();
assert.equal(noSearchMatches.list.rows.length, 1);
assert.equal(noSearchMatches.list.rows[0].dataset.snapshotId, 'current');
assert.equal(noSearchMatches.searchResultCount.textContent, '0 of 3 Manemarks · current page also shown');
assert.equal(noSearchMatches.noResultsState.style.display, 'none');

// A normal unfiltered list still auto-scrolls to the active entry.
const unfiltered = fixture({query:'', matches:null});
unfiltered.ctx.draw();
assert.equal(unfiltered.list.rows.length, 3);
assert.ok(unfiltered.scroller.scrollTop > 0);

// Highlight deep-links can be focused even when no full-page snapshot exists.
const highlight = fixture({currentUrl:'https://example.com/a#:~:text=hello',
  fullPage:false, matches:[{id:'one',score:.6}],
  snapshots:[
    {id:'one',type:'page',url:'https://example.com/one',title:'One',timestamp:1,textPreview:'One'},
    {id:'hi',type:'highlight',url:'https://example.com/a#:~:text=hello',title:'Highlighted',timestamp:1,textPreview:'Hello'}
  ]});
highlight.ctx.draw();
assert.deepEqual(highlight.list.rows.map(r => r.dataset.snapshotId), ['one','hi']);
assert.ok(highlight.list.rows[1].active);

console.log('PASS: current tab focuses after async search, is visible when filtered out, and does not repeatedly jump');
