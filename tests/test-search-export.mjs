import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../popup.html', import.meta.url), 'utf8');
assert.match(html, /id="exportSearchBtn"\s+hidden\s+disabled/);
assert.match(html, /\.dropdown-item\[hidden\]\s*\{\s*display:\s*none/);
assert.match(source, /exportSearchBtn\.addEventListener\('click'/);
assert.match(source, /exportMenuBtn\.addEventListener\('click',[\s\S]*?updateSearchExportOption\(\)/);
const names = ['getQualifiedSemanticMatches', 'getSearchResultSnapshots', 'updateSearchExportOption', 'exportSearchSnapshotsAsJson'];
const funcs = names.map(name => {
  const impl = source.match(new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0];
  assert.ok(impl, `${name} exists`);
  return impl;
}).join('\n');

const documents = [
  {id:1, title:'Active tab, not a match', url:'https://example.com/active', text:'excluded text', textPreview:'excluded', timestamp:1},
  {id:2, title:'Match 2', url:'https://example.com/match2', text:'matching text 2', textPreview:'matching', timestamp:2},
  {id:3, title:'Below threshold', url:'https://example.com/low', text:'low text', textPreview:'low', timestamp:3},
  {id:4, title:'Match 1', url:'https://example.com/match1', text:'matching text 1', textPreview:'matching', timestamp:4}
];
let download = null;
const messages = [];
const url = {
  createObjectURL(blob) { download = {blob}; return 'blob:example'; },
  revokeObjectURL(value) { assert.equal(value, 'blob:example'); }
};
const document = {
  createElement(tag) {
    assert.equal(tag,'a');
    const a = {href: null, download: '', click() {
      download.filename = a.download;
      download.href = a.href;
    }};
    return a;
  }
};
const input = {value: ''};
const button = {hidden:true, disabled:true, title:''};
const ctx = vm.createContext({
  searchInput:input, exportSearchBtn:button, Blob, URL:url, document,
  showToast:(msg,kind) => messages.push([msg,kind]),
  console
});
vm.runInContext(`const MINIMUM_SEMANTIC_SIMILARITY = 0.2;
let savedSnapshots = ${JSON.stringify(documents)};
let semanticMatches = null;
${funcs}
this.matches = getSearchResultSnapshots;
this.update = updateSearchExportOption;
this.exportSearch = exportSearchSnapshotsAsJson;
this.setMatches = value => { semanticMatches = value; };`, ctx);

// Empty search: hidden; even a previous result set cannot make it exportable.
ctx.setMatches([{id:2,score:0.85}]);
ctx.update();
assert.equal(button.hidden, true);
assert.equal(button.disabled, true);
ctx.exportSearch();
assert.equal(download,null);

// Search has been typed: the option is present, but disabled while loading.
input.value = '  interesting articles  ';
ctx.setMatches(null);
ctx.update();
assert.equal(button.hidden, false);
assert.equal(button.disabled, true);
ctx.exportSearch();
assert.equal(download, null);

// Only valid semantic matches, in displayed rank order; not the active tab,
// not below-threshold matches and not IDs that don't exist in the library.
ctx.setMatches([{id:4,score:0.96},{id:3,score:0.19},{id:2,score:0.54},
  {id:1,score:0.18},{id:300,score:0.95}]);
ctx.update();
assert.equal(button.hidden,false);
assert.equal(button.disabled,false);
assert.equal(ctx.matches().length,2);
ctx.exportSearch();
assert.ok(download);
assert.match(download.filename,/^manemark-search-\d{4}-\d{2}-\d{2}\.json$/);
assert.equal(download.href, 'blob:example');
const exportData = JSON.parse(await download.blob.text());
assert.equal(exportData.search_query,'interesting articles');
assert.equal(exportData.total_manemarks,2);
assert.deepEqual(exportData.snapshots.map(s => s.id),[4,2]);
assert.deepEqual(exportData.snapshots.map(s => s.text),['matching text 1','matching text 2']);
assert.ok(exportData.export_date);

// A query with zero matches keeps the option visible but not clickable.
download=null;
ctx.setMatches([]);
ctx.update();
assert.equal(button.hidden,false);
assert.equal(button.disabled,true);
ctx.exportSearch();
assert.equal(download,null);

// Clearing or restoring a query changes visibility without touching JSON/ZIP.
input.value = ' ';
ctx.update();
assert.equal(button.hidden,true);
assert.equal(button.disabled,true);
assert.match(source,/exportJsonBtn\.addEventListener/);
assert.match(source,/exportZipBtn\.addEventListener/);
console.log('PASS: SEARCH export is conditional and downloads only full matching Manemarks as importable JSON');
