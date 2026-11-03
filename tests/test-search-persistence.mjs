import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the actual popup storage handlers in isolated popup lifecycles.
const popup = fs.readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
const handlers = ['restoreSearchQuery', 'persistSearchQuery', 'handleSearchInput'];
const source = handlers.map(name => {
  const functionSource = popup.match(new RegExp(`^function ${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0];
  assert.ok(functionSource, `${name} exists in popup.js`);
  return functionSource;
}).join('\n');
assert.match(popup, /restoreSearchQuery\(\);\s*loadSnapshots\(\);/,
  'Restore search text before loading/rendering saved Manemarks');
assert.match(popup, /searchInput\.addEventListener\('input', handleSearchInput\)/,
  'Search input saves query and schedules semantic search');

const values = new Map();
const storage = {
  getItem: key => values.has(key) ? values.get(key) : null,
  setItem: (key, value) => values.set(key, String(value))
};
let runs = 0;
function newPopup(window = {localStorage: storage}) {
  const searchInput = {value: ''};
  const context = vm.createContext({
    window, searchInput,
    scheduleSemanticSearch() { runs++; },
    console: {warn() {}}
  });
  vm.runInContext(`const SEARCH_QUERY_STORAGE_KEY = 'manemark.popup.searchQuery';
    ${source}
    this.handlers = {restoreSearchQuery, persistSearchQuery, handleSearchInput};`, context);
  return {searchInput, ...context.handlers};
}

// Search survives closing the popup after opening a result link.
const first = newPopup();
first.restoreSearchQuery();
assert.equal(first.searchInput.value, '');
first.searchInput.value = 'interesting semantic search';
first.handleSearchInput();
assert.equal(runs, 1);
assert.equal(values.get('manemark.popup.searchQuery'), 'interesting semantic search');
const reopened = newPopup();
reopened.restoreSearchQuery();
assert.equal(reopened.searchInput.value, 'interesting semantic search');

// The input's native clear button also removes the persistent filter.
reopened.searchInput.value = '';
reopened.handleSearchInput();
const reopenedAfterClear = newPopup();
reopenedAfterClear.restoreSearchQuery();
assert.equal(reopenedAfterClear.searchInput.value, '');
assert.equal(runs, 2);

// A storage API failure does not break the ability to type and search.
const blocked = newPopup({localStorage: {
  getItem() { throw new Error('Blocked'); },
  setItem() { throw new Error('Blocked'); }
}});
blocked.restoreSearchQuery();
blocked.searchInput.value = 'fallback';
blocked.handleSearchInput();
assert.equal(runs, 3);
assert.equal(blocked.searchInput.value, 'fallback');
console.log('PASS: search query survives popup reopen, clears correctly, and tolerates storage errors');
