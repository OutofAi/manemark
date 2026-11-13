import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../presentation.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function setup(sidepanel = false, fail = false) {
  const elements = Object.fromEntries(['presentationBtn','presentationIcon','presentationFeedback'].map(id => [id, { hidden: true, setAttribute(k,v) { this[k]=v; }, addEventListener(event,fn) { this[event]=fn; } }]));
  const calls=[]; let ready;
  const context = vm.createContext({ URLSearchParams, location: { search: sidepanel ? '?view=sidepanel' : '' },
    document: { documentElement: { classList: { toggle(name,value) { if (name === 'side-panel') calls.push(['mode', value]); } } },
      getElementById: id => elements[id], addEventListener(event,fn) { ready=fn; } },
    window: { close() { calls.push(['close']); } },
    chrome: { windows: { getCurrent: async () => ({ id: 7 }) },
      sidePanel: { open(options) { calls.push(['open', options]); return fail ? Promise.reject(new Error('Blocked')) : Promise.resolve(); } },
      runtime: { sendMessage: async message => { calls.push(['message', message]); return fail ? { success: false, message: 'Blocked' } : { success: true }; } } }
  });
  vm.runInContext(source, context); ready(); await tick();
  return { elements, calls, async click() { elements.presentationBtn.click(); await tick(); } };
}
test('popup opens current-window sidebar before closing itself', async () => {
  const ui=await setup(); await ui.click();
  assert.equal(ui.elements.presentationBtn['aria-label'],'Open in sidebar');
  assert.equal(ui.elements.presentationIcon.src,'assets/open-sidebar.svg');
  assert.equal(ui.calls[1][0],'message'); assert.equal(ui.calls[1][1].action,'switchToSidebar'); assert.equal(ui.calls[1][1].windowId,7);
  assert.equal(ui.calls[2][0],'close');
});
test('sidebar requests popup and displays the alternate SVG', async () => {
  const ui=await setup(true); await ui.click();
  assert.equal(ui.elements.presentationBtn['aria-label'],'Switch to popup');
  assert.equal(ui.elements.presentationIcon.src,'assets/open-popup.svg');
  assert.equal(ui.calls[1][1].action,'switchToPopup');
  assert.equal(ui.calls[1][1].windowId,7);
});
test('failed transitions retain current view and allow retry', async () => {
  for (const mode of [false,true]) {
    const ui=await setup(mode,true); await ui.click();
    assert.ok(!ui.calls.some(c=>c[0]==='close'));
    assert.equal(ui.elements.presentationFeedback.hidden,false);
    assert.match(ui.elements.presentationFeedback.textContent,/Blocked/);
    assert.equal(ui.elements.presentationBtn.disabled,false);
  }
});
