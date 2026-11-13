import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../popup.js', import.meta.url), 'utf8');
function ui() {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { hidden: true, style: {}, attributes: {}, classes: new Set(),
      classList: { toggle(name, value) { value ? get(id).classes.add(name) : get(id).classes.delete(name); } },
      setAttribute(k, v) { this.attributes[k] = v; }, removeAttribute(k) { delete this.attributes[k]; } });
    return elements.get(id);
  };
  const context = vm.createContext({ document: { getElementById: get }, Date, setTimeout: () => 1, clearTimeout() {},
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({}) } } });
  vm.runInContext(source.slice(source.indexOf('// Independent of indexing:')), context);
  return { get, render: value => context.renderModelDownloads(value) };
}
const status = (path, loaded, total, phase = 'downloading') => ({ path, loaded, total, phase, updatedAt: Date.now() });
test('download bar aggregates concurrent transfers independently of indexing', () => {
  const { get, render } = ui();
  get('indexFooter').hidden = false;
  render({ a: status('htmlsift-mini/mini-table-int8.onnx', 50, 100), b: status('Xenova/model.onnx', 25, 50) });
  assert.equal(get('downloadFooter').hidden, false);
  assert.equal(get('indexFooter').hidden, false);
  assert.equal(get('downloadFooterCount').textContent, '50%');
  assert.match(get('downloadFooterLabel').textContent, /One-time/);
  assert.match(get('downloadFooterDetail').textContent, /AI extraction \+ Semantic search/);
});
test('unknown sizes show indeterminate progress; completion and errors are honest', () => {
  const { get, render } = ui();
  render({ a: status('htmlsift-mini/tokenizer.json', 500, 0) });
  assert.equal(get('downloadFooter').classes.has('checking'), true);
  assert.equal(get('downloadFooterTrack').attributes['aria-valuenow'], undefined);
  render({ a: status('htmlsift-mini/tokenizer.json', 500, 500, 'complete') });
  assert.equal(get('downloadFooterCount').textContent, '100%');
  assert.match(get('downloadFooterDetail').textContent, /Cached on this device/);
  render({ a: { ...status('htmlsift-mini/tokenizer.json', 0, 0, 'error'), message: 'Offline' } });
  assert.match(get('downloadFooterDetail').textContent, /retry.*Offline/);
  render({});
  assert.equal(get('downloadFooter').hidden, true);
});
test('model loader reports byte progress, successful caching, and errors', async () => {
  const saved = new Map();
  globalThis.caches = { open: async () => ({ match: async key => saved.get(key)?.clone(), put: async (key, value) => saved.set(key, value.clone()) }) };
  const loader = await import('../model-cache.mjs?progress-test');
  const events = [];
  loader.onModelDownloadProgress(s => events.push(s));
  globalThis.fetch = async () => new Response(new Uint8Array(4096), { headers: { 'content-length': '4096' } });
  await loader.getModelAsset('htmlsift-mini/mini-head-fABC.onnx');
  assert.equal(events[0].phase, 'downloading');
  assert.ok(events.some(e => e.loaded === 4096 && e.total === 4096));
  assert.equal(events.at(-1).phase, 'complete');
  const count = events.length;
  await loader.getModelAsset('htmlsift-mini/mini-head-fABC.onnx');
  assert.equal(events.length, count, 'cache hits do not display download progress');
  globalThis.fetch = async () => { throw new Error('Offline'); };
  await assert.rejects(loader.getModelAsset('htmlsift-mini/tokenizer.json'));
  assert.equal(events.at(-1).phase, 'error');
});
