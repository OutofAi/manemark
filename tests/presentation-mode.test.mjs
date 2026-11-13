import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../presentation-background.js', import.meta.url), 'utf8');
async function start(saved = {}, failOpen = false) {
  const calls = []; let listener;
  const state = { popup: 'popup.html', nativeToggle: false, panelOpen: false };
  const context = vm.createContext({ console, chrome: {
    storage: { local: { get: async defaults => ({ ...defaults, ...saved }), set: async values => Object.assign(saved, values) } },
    runtime: { id: 'test-extension', onMessage: { addListener(fn) { listener = fn; } } },
    action: { setPopup: async ({popup}) => { state.popup = popup; calls.push(['popup',popup]); },
      openPopup: async () => { if (failOpen) throw new Error('Popup unavailable'); calls.push(['openPopup']); } },
    sidePanel: { setPanelBehavior: async ({openPanelOnActionClick}) => { state.nativeToggle = openPanelOnActionClick; },
      open: async () => { state.panelOpen = true; calls.push(['openPanel']); },
      close: async () => { state.panelOpen = false; calls.push(['closePanel']); } }
  } });
  vm.runInContext(source, context);
  await vm.runInContext('presentationQueue', context);
  return { saved, state, calls,
    send: action => new Promise(resolve => listener({action,windowId:7},{id:'test-extension'},resolve)) };
}
test('sidebar selection removes toolbar popup and persists across worker restarts', async () => {
  const saved = {};
  const ui = await start(saved);
  assert.equal((await ui.send('switchToSidebar')).success,true);
  assert.equal(saved.presentationMode,'sidebar');
  assert.equal(ui.state.popup,'');
  assert.equal(ui.state.nativeToggle,true);
  // Closing the panel does not mutate preference. Chrome owns toolbar toggling.
  ui.state.panelOpen = false;
  const restarted = await start(saved);
  assert.equal(restarted.state.popup,'');
  assert.equal(restarted.state.nativeToggle,true);
});
test('explicit return restores popup behaviour and closes the panel', async () => {
  const ui=await start({presentationMode:'sidebar'});
  ui.state.panelOpen=true;
  assert.equal((await ui.send('switchToPopup')).success,true);
  assert.equal(ui.saved.presentationMode,'popup');
  assert.equal(ui.state.nativeToggle,false);
  assert.equal(ui.state.popup,'popup.html');
  assert.equal(ui.state.panelOpen,false);
  assert.ok(ui.calls.findIndex(c=>c[0]==='openPopup') < ui.calls.findIndex(c=>c[0]==='closePanel'));
});
test('failed popup opening retains sidebar preference and panel', async () => {
  const ui=await start({presentationMode:'sidebar'},true);
  ui.state.panelOpen=true;
  assert.equal((await ui.send('switchToPopup')).success,false);
  assert.equal(ui.saved.presentationMode,'sidebar');
  assert.equal(ui.state.nativeToggle,true);
  assert.equal(ui.state.popup,'');
  assert.equal(ui.state.panelOpen,true);
});
