import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createTabDocking, dockZone, tabInsertion } from '../src/ui/tab-docking.ts';
import type { DockIntent, DockPane, DockRect, TearOffIntent } from '../src/ui/tab-docking.ts';
const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const bounds = rect(0, 0, 600, 600);

test('edge regions use strict .33 threshold and normalized nearest edge, with stable ties', () => {
  assert.equal(dockZone({ x: 198, y: 300 }, bounds)?.edge, 'center');
  assert.equal(dockZone({ x: 197, y: 300 }, bounds)?.edge, 'left');
  assert.equal(dockZone({ x: 30, y: 30 }, bounds)?.edge, 'top');
  assert.deepEqual(dockZone({ x: 599, y: 300 }, bounds), { edge: 'right', rect: rect(400, 0, 200, 600) });
  assert.deepEqual(bounds, rect(0, 0, 600, 600));
  assert.equal(dockZone({ x: -1, y: 20 }, bounds), null);
  assert.equal(dockZone({ x: 0, y: 0 }, rect(0, 0, 0, 10)), null);
  assert.equal(dockZone({ x: 1, y: 300 }, bounds, { disabledEdges: ['left'] })?.edge, 'center');
  assert.equal(dockZone({ x: 49, y: 25 }, rect(0, 0, 50, 50))?.rect.width, 40);
});

test('tab header protects center insertion except its top third; stacked content disables side edges', () => {
  const headerRect = rect(0, 0, 600, 30);
  assert.equal(dockZone({ x: 1, y: 10 }, bounds, { headerRect })?.edge, 'top');
  assert.equal(dockZone({ x: 1, y: 11 }, bounds, { headerRect })?.edge, 'center');
  assert.equal(dockZone({ x: 300, y: 40 }, bounds, { headerRect })?.edge, 'center');
  assert.equal(dockZone({ x: 1, y: 300 }, bounds, { headerRect, stacked: true })?.edge, 'center');
  assert.equal(dockZone({ x: 300, y: 599 }, bounds, { headerRect, stacked: true })?.edge, 'bottom');
});

test('tab insertion uses midpoint, 10px marker, and a deterministic empty header', () => {
  const tabs = [rect(10, 0, 100, 30), rect(110, 0, 100, 30)];
  assert.deepEqual(tabInsertion(60, tabs, bounds), { index: 0, rect: rect(5, 0, 10, 30) });
  assert.deepEqual(tabInsertion(61, tabs, bounds), { index: 1, rect: rect(105, 0, 10, 30) });
  assert.equal(tabInsertion(500, tabs, bounds).index, 2);
  assert.deepEqual(tabInsertion(60, [], rect(10, 5, 100, 30)), { index: 0, rect: rect(5, 5, 10, 30) });
});

function setup(dock?: (intent: DockIntent) => void | Promise<void>) {
  const dom = new JSDOM('<!doctype html><body><main></main></body>', { pretendToBeVisual: true });
  const doc = dom.window.document, root = doc.querySelector('main')!;
  const panes: DockPane[] = [];
  const geometry = (el: HTMLElement, r: DockRect) => { el.getBoundingClientRect = () => ({ ...r, left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height, toJSON() { return {}; } }); };
  for (const [id, x, ids] of [['a', 0, ['one', 'two', 'three']], ['b', 600, ['four']]] as const) {
    const element = doc.createElement('section'), tabBar = doc.createElement('header');
    element.append(tabBar); root.append(element); geometry(element, rect(x, 0, 600, 600)); geometry(tabBar, rect(x, 0, 600, 30));
    const tabs = ids.map((id, i) => { const element = doc.createElement('button'); element.draggable = true; element.textContent = id; tabBar.append(element); geometry(element, rect(x + i * 100, 0, 100, 30)); return { id, element }; });
    panes.push({ id, element, tabBar, tabs });
  }
  const actions: DockIntent[] = [], external: TearOffIntent[] = [], errors: unknown[] = [];
  const controller = createTabDocking({ root, getPanes: () => panes, dock: dock ?? (i => { actions.push(i); }), tearOff: i => { external.push(i); }, onError: e => { errors.push(e); } });
  const transfer = { dropEffect: 'none', effectAllowed: 'none', data: new Map<string, string>(), setData(k: string, v: string) { this.data.set(k, v); } };
  const drag = (type: string, target: EventTarget = panes[0].tabs[0].element, x = 50, y = 20, extra: MouseEventInit = {}) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, buttons: 1, clientX: x, clientY: y, screenX: x + 1000, screenY: y + 1000, ...extra });
    Object.defineProperty(event, 'dataTransfer', { value: transfer }); target.dispatchEvent(event); return event;
  };
  const cleanup = () => { controller.destroy(); dom.window.close(); };
  return { dom, doc, root, panes, actions, external, errors, controller, transfer, drag, cleanup };
}

test('five-pixel movement enables move-only preview; center index is adjusted after source removal', () => {
  const s = setup();
  s.drag('dragstart'); assert.equal(s.transfer.effectAllowed, 'move');
  assert.equal(s.drag('dragover', s.panes[0].tabBar, 53, 22).defaultPrevented, false);
  const moved = s.drag('dragover', s.panes[0].tabBar, 290, 20, { ctrlKey: true, altKey: true });
  assert.equal(moved.defaultPrevented, true); assert.equal(s.transfer.dropEffect, 'move');
  assert.equal(s.doc.querySelector<HTMLElement>('.tab-docking-preview')?.dataset.edge, 'center');
  s.drag('drop', s.panes[0].tabBar, 290, 20);
  assert.deepEqual(s.actions, [{ sourcePaneId: 'a', tabId: 'one', targetPaneId: 'a', edge: 'center', index: 2 }]);
  s.drag('dragend'); assert.equal(s.actions.length, 1); assert.equal(s.external.length, 0); s.cleanup();
});

test('switching panes replaces preview and emits current edge without touching DOM or editor state', () => {
  const s = setup(); const editor = s.doc.createElement('textarea'); editor.value = 'unsaved'; s.panes[0].element.append(editor);
  editor.focus(); editor.setSelectionRange(2, 4); const history = { undo: ['prior'] }; (editor as any).history = history;
  s.drag('dragstart'); s.drag('dragover', s.panes[1].element, 1190, 300);
  assert.equal(s.doc.querySelector<HTMLElement>('.tab-docking-preview')?.dataset.edge, 'right');
  s.drag('dragover', s.panes[1].element, 900, 590);
  assert.equal(s.doc.querySelector<HTMLElement>('.tab-docking-preview')?.dataset.edge, 'bottom');
  s.drag('drop', s.panes[1].element, 900, 590);
  assert.equal(s.actions[0].edge, 'bottom'); assert.equal(s.actions[0].targetPaneId, 'b');
  assert.equal(s.panes[0].element.querySelector('textarea'), editor); assert.equal(editor.value, 'unsaved');
  assert.equal(editor.selectionStart, 2); assert.equal(editor.selectionEnd, 4); assert.equal((editor as any).history, history); s.cleanup();
});

test('same index and splitting a sole tab into its own group are no-ops', () => {
  const s = setup(); s.drag('dragstart'); s.drag('drop', s.panes[0].tabBar, 60, 20); assert.equal(s.actions.length, 0);
  s.drag('dragstart', s.panes[1].tabs[0].element, 650, 20); s.drag('drop', s.panes[1].element, 1190, 300);
  assert.equal(s.actions.length, 0); s.cleanup();
});

test('unregistered file drags and invalid pane drops never become tab transfers', () => {
  const s = setup(); s.drag('dragstart', s.root); s.drag('drop', s.panes[1].element, 1190, 300);
  assert.equal(s.actions.length, 0); s.drag('dragstart'); s.drag('drop', s.root, 1400, 300); s.drag('dragend');
  assert.equal(s.actions.length, 0); assert.equal(s.external.length, 0); s.cleanup();
});

test('leaving the window then ending with no successful drop requests a bounded handoff once', async () => {
  const s = setup(); s.drag('dragstart'); s.drag('dragover', s.panes[1].element, 900, 300);
  s.drag('dragleave', s.root, 1300, 300); await new Promise(r => setTimeout(r, 20)); s.transfer.dropEffect = 'none';
  s.drag('dragend', s.panes[0].tabs[0].element, 1300, 300); s.drag('dragend');
  assert.deepEqual(s.external, [{ sourcePaneId: 'a', tabId: 'one', screenX: 2300, screenY: 1300, width: 600, height: 600 }]);
  assert.equal(s.panes[0].tabs[0].element.isConnected, true); s.cleanup();
});

test('re-entry, explicit cancel, Escape, destroy and a successful external drop suppress tear-off', async () => {
  for (const action of ['enter', 'cancel', 'escape', 'destroy', 'successful']) {
    const s = setup(); s.drag('dragstart'); s.drag('dragleave', s.root, 1300, 300); await new Promise(r => setTimeout(r, 15));
    if (action === 'enter') s.drag('dragenter', s.root, 1000, 300);
    if (action === 'cancel') s.controller.cancel();
    if (action === 'escape') s.root.dispatchEvent(new s.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    if (action === 'destroy') s.controller.destroy();
    s.transfer.dropEffect = action === 'successful' ? 'move' : 'none';
    s.drag('dragend', s.panes[0].tabs[0].element, 1300, 300); assert.equal(s.external.length, 0, action); s.cleanup();
  }
});

test('pending and rejected host transitions cannot trigger duplicate callbacks or remove source', async () => {
  let reject!: (e: unknown) => void, calls = 0;
  const s = setup(() => { calls++; return new Promise((_resolve, r) => { reject = r; }); });
  s.drag('dragstart'); s.drag('drop', s.panes[1].element, 1190, 300);
  s.drag('dragstart'); s.drag('drop', s.panes[1].element, 1190, 300); assert.equal(calls, 1);
  reject(new Error('Target unavailable')); await new Promise(r => setTimeout(r, 0));
  assert.equal(s.errors.length, 1); assert.equal(s.panes[0].tabs[0].element.isConnected, true);
  assert.equal(s.doc.querySelector<HTMLElement>('.tab-docking-preview')?.hidden ?? true, true); s.cleanup();
});


test('retired or disconnected source ownership cannot request an outside handoff', async () => {
  for (const retired of ['pane', 'tab', 'pane-dom', 'tab-dom', 'moved-tab']) {
    const s = setup();
    const source = s.panes[0], tab = source.tabs[0];
    s.drag('dragstart'); s.drag('dragleave', s.root, 1300, 300);
    await new Promise(resolve => setTimeout(resolve, 15));
    if (retired === 'pane') s.panes.splice(0, 1);
    if (retired === 'tab') source.tabs = source.tabs.slice(1);
    if (retired === 'pane-dom') source.element.remove();
    if (retired === 'tab-dom') tab.element.remove();
    if (retired === 'moved-tab') s.panes[1].tabBar.append(tab.element);
    s.transfer.dropEffect = 'none';
    s.drag('dragend', s.root, 1300, 300);
    assert.deepEqual(s.external, [], retired);
    assert.deepEqual(s.actions, [], retired);
    s.cleanup();
  }
});
