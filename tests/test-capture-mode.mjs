import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const popupHtml = readFileSync(resolve(root, 'popup.html'), 'utf8');
const popupJs = readFileSync(resolve(root, 'popup.js'), 'utf8');
const backgroundJs = readFileSync(resolve(root, 'background.js'), 'utf8');
const offscreenJs = readFileSync(resolve(root, 'offscreen.js'), 'utf8');

assert.match(popupHtml, /id="aiExtractionCheckbox"[^>]*checked/);
assert.match(popupHtml, /id="settingsBtn"/);
assert.match(popupHtml, /class="library-footer"/);
assert.match(popupJs, /chrome\.storage\.local\.get\(\{ \[AI_EXTRACTION_STORAGE_KEY\]: true \}\)/);
assert.match(popupJs, /aiExtractionEnabled: useAI/);
assert.match(backgroundJs, /aiExtractionEnabled: request\.aiExtractionEnabled !== false/);

// Test the real offscreen request handler with Chrome/Worker stubs. Raw mode
// must return/store untouched DOM markup without sending anything to the AI.
const listeners = [];
const sent = [];
const workers = [];
class FakeWorker {
  constructor() { this.messages = []; workers.push(this); }
  postMessage(message) { this.messages.push(message); }
}
const chrome = {
  runtime: {
    getURL: path => path,
    onMessage: { addListener: fn => listeners.push(fn) },
    sendMessage: async request => {
      sent.push(request);
      if (request.action === 'saveSnapshot') return { success: true };
      return { success: true };
    }
  }
};
// Imports of semantic-core and DOM rendering are not needed in raw mode.
const source = offscreenJs.replace("import { snapshotFingerprint } from './semantic-core.mjs';", 'const snapshotFingerprint = () => "";');
vm.runInNewContext(source, { Worker: FakeWorker, chrome, console, setTimeout, clearTimeout, Map, Set }, { filename: 'offscreen.js' });
const handler = listeners[0];
assert.equal(typeof handler, 'function');

async function queue(request) {
  let accepted;
  handler({ target: 'htmlsiftOffscreen', action: 'queueHtmlsiftJob', ...request }, null,
    response => { accepted = response; });
  assert.equal(accepted?.queued, true);
  for (let i = 0; i < 100; i++) {
    const done = sent.find(message => message.action === 'htmlsiftJobComplete' && message.jobId === request.jobId);
    if (done) return done;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('No raw capture completion');
}

const html = '<html><head><script>const x=1</script></head><body data-keep="yes"><aside>Sidebar</aside><main><b>Hello</b></main></body></html>';
const doctype = '<!DOCTYPE html>\n';
const save = await queue({jobId: 'raw-save', mode: 'save', html, doctype, aiExtractionEnabled: false, url:'https://example.com', title:'Raw page'});
assert.equal(save.success, true);
const stored = sent.find(message => message.action === 'saveSnapshot');
assert.equal(stored.text, doctype + html);
assert.equal(stored.url, 'https://example.com');
const copy = await queue({jobId: 'raw-copy', mode: 'copy', html, doctype, aiExtractionEnabled: false, url:'https://example.com', title:'Raw page'});
assert.equal(copy.success, true);
assert.equal(copy.text, doctype + html);
assert.equal(sent.filter(message => message.action === 'saveSnapshot').length, 1);
assert.equal(workers[1].messages.length, 0, 'raw mode should not call htmlsift');
console.log('PASS: default-on AI checkbox is wired; raw Save/Copy preserve HTML and bypass AI');
