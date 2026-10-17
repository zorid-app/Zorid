import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorView } from '@codemirror/view';
import { Transaction } from '@codemirror/state';
import { undo, undoDepth } from '@codemirror/commands';
import { CanvasDocument } from '../src/canvas/document.ts';
import { createCanvasView } from '../src/canvas/view.ts';
import { createCanvasMarkdownCard } from '../src/canvas/markdown-card.ts';
import type { CanvasMarkdownSession } from '../src/canvas/markdown-card.ts';

function environment(t: TestContext) {
  const dom = new JSDOM('<!doctype html><main></main>', { url: 'https://zorid.test/', pretendToBeVisual: true });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Text: dom.window.Text, Window: dom.window.Window, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const rect = () => ({ top: 0, left: 0, right: 300, bottom: 200, width: 300, height: 200, x: 0, y: 0, toJSON() { return {}; } });
  dom.window.Range.prototype.getBoundingClientRect = rect;
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  t.after(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  return { dom, document: dom.window.document, parent: dom.window.document.querySelector('main')! };
}
function sessionFixture(initial = '# Courses\n\n**Read** the notes.\n\n- Item') {
  let text = initial, saved = initial, failure: unknown, destroyed = 0, flushes = 0;
  const updates: { next: string; expected: string }[] = [], listeners = new Set<(text: string) => void>();
  const session: CanvasMarkdownSession = {
    getText: () => text,
    update(next, expected) { if (text !== expected) throw new Error('Note changed in another editor'); updates.push({ next, expected }); text = next; for (const listener of listeners) listener(text); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async flush() { flushes++; if (failure) throw failure; saved = text; },
    hasPendingChanges: () => text !== saved,
    destroy() { destroyed++; },
  };
  return { session, updates, listeners, get text() { return text; }, get saved() { return saved; }, get destroyed() { return destroyed; }, get flushes() { return flushes; }, fail(error?: unknown) { failure = error; },
    external(next: string, notify = true) { text = saved = next; if (notify) for (const listener of listeners) listener(next); } };
}
const tick = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
const editor = (element: HTMLElement) => EditorView.findFromDOM(element.querySelector('.cm-editor')!)!;
const type = (view: EditorView, text: string) => view.dispatch({ changes: { from: view.state.doc.length, insert: text }, annotations: Transaction.userEvent.of('input.type') });

function card(t: TestContext, fixture = sessionFixture(), subpath = '') {
  const ui = environment(t), errors: unknown[] = [];
  const card = createCanvasMarkdownCard(ui.document, { load: async () => fixture.session, subpath, onError: error => errors.push(error) });
  ui.parent.append(card.element, card.toolbar); t.after(() => card.destroy());
  return { ...ui, fixture, card, errors };
}

test('file card renders real shared Markdown and edits the full note through shared Live editor with independent undo', async t => {
  const ui = card(t); await ui.card.ready;
  assert.equal(ui.card.element.querySelector('h1')?.textContent, 'Courses'); assert.equal(ui.card.element.querySelector('strong')?.textContent, 'Read');
  assert.equal(ui.fixture.updates.length, 0); await ui.card.activate();
  const cm = editor(ui.card.element); assert.equal(cm.contentDOM.getAttribute('contenteditable'), 'true');
  type(cm, '\nNew course'); assert.equal(ui.fixture.text, '# Courses\n\n**Read** the notes.\n\n- Item\nNew course');
  assert.equal(ui.fixture.updates[0].expected, '# Courses\n\n**Read** the notes.\n\n- Item'); assert.equal(ui.card.hasPendingChanges(), true); assert.equal(undoDepth(cm.state), 1);
  await ui.card.deactivate(); assert.equal(ui.fixture.saved, ui.fixture.text); assert.equal(ui.card.isEditing(), false);
  await ui.card.activate(); assert.equal(editor(ui.card.element), cm); assert.equal(undo(cm), true);
  await ui.card.flush(); assert.equal(ui.fixture.saved, '# Courses\n\n**Read** the notes.\n\n- Item'); assert.equal(ui.card.hasPendingChanges(), false);
});

test('failed note persistence retains editing and the draft; subsequent retry flushes it', async t => {
  const ui = card(t); await ui.card.activate(); const cm = editor(ui.card.element); type(cm, '\nRetain draft');
  ui.fixture.fail(new Error('Disk unavailable')); await assert.rejects(ui.card.deactivate(), /Disk unavailable/);
  assert.equal(ui.card.isEditing(), true); assert.equal(editor(ui.card.element), cm); assert.equal(ui.card.hasPendingChanges(), true); assert.match(cm.state.doc.toString(), /Retain draft/);
  ui.fixture.fail(); await ui.card.deactivate(); assert.equal(ui.card.isEditing(), false); assert.match(ui.fixture.saved, /Retain draft/);
});

test('compare-and-set rejection keeps local editor text and refuses to overwrite a newer shared note', async t => {
  const ui = card(t); await ui.card.activate(); const cm = editor(ui.card.element), before = ui.fixture.text;
  ui.fixture.external('Changed elsewhere', false); type(cm, '\nLocal draft');
  assert.equal(ui.fixture.text, 'Changed elsewhere'); assert.equal(ui.card.hasPendingChanges(), true);
  ui.fixture.external('Newer shared snapshot'); assert.match(cm.state.doc.toString(), /Local draft/);
  await assert.rejects(ui.card.flush(), /another editor/); assert.equal(ui.fixture.text, 'Newer shared snapshot');
  ui.fixture.external(before, false); await ui.card.flush(); assert.match(ui.fixture.saved, /Local draft/);
});

test('shared note updates refresh preview and live text without publishing another edit', async t => {
  const ui = card(t); await ui.card.ready; ui.fixture.external('## External **preview**');
  assert.equal(ui.card.element.querySelector('h2 strong')?.textContent, 'preview'); await ui.card.activate(); const cm = editor(ui.card.element);
  cm.dispatch({ selection: { anchor: 3 } }); ui.fixture.external('## External **live**');
  assert.equal(cm.state.doc.toString(), '## External **live**'); assert.equal(ui.fixture.updates.length, 0); assert.equal(cm.state.selection.main.anchor, 3);
});

test('heading/block cards and read-only sessions never expose a partial note as editable source', async t => {
  const ui = card(t, sessionFixture('# First\nFirst text\n\n# Second\nSecond text'), '#Second'); await ui.card.ready;
  assert.match(ui.card.element.textContent!, /Second text/); assert.doesNotMatch(ui.card.element.textContent!, /First text/);
  await ui.card.activate(); assert.equal(ui.card.element.querySelector('.cm-editor'), null); assert.equal(ui.card.toolbar.querySelector('button')!.disabled, true); assert.equal(ui.fixture.updates.length, 0);
  const fixture = sessionFixture('Read only'); Object.defineProperty(fixture.session, 'readOnly', { value: true });
  const second = createCanvasMarkdownCard(ui.document, { load: async () => fixture.session }); ui.parent.append(second.element); t.after(() => second.destroy());
  await second.activate(); assert.equal(second.element.querySelector('.cm-editor'), null); assert.equal(second.toolbar.querySelector('button')!.disabled, true);
});

test('late file loading and repeated teardown release one session without reviving a closed card', async t => {
  const ui = environment(t), fixture = sessionFixture(); let resolve!: (session: CanvasMarkdownSession) => void;
  const card = createCanvasMarkdownCard(ui.document, { load: () => new Promise(done => { resolve = done; }) }); ui.parent.append(card.element); await tick();
  card.destroy(); card.destroy(); resolve(fixture.session); await card.ready;
  assert.equal(fixture.destroyed, 1); assert.equal(ui.parent.children.length, 0); assert.equal(fixture.listeners.size, 0);
});

test('preview link and embed owners are disposed on refresh, activation and destroy', async t => {
  const ui = environment(t), fixture = sessionFixture('[[First]] ![[Embed]]'), opened: string[] = []; let disposed = 0;
  Object.defineProperty(fixture.session, 'editorOptions', { value: { paths: () => [], open: (target: string) => opened.push(target), renderEmbed: () => ({ dom: ui.document.createElement('span'), destroy() { disposed++; } }) } });
  const card = createCanvasMarkdownCard(ui.document, { load: async () => fixture.session }); ui.parent.append(card.element); t.after(() => card.destroy()); await card.ready;
  const old = card.element.querySelector<HTMLAnchorElement>('a')!; old.click(); assert.deepEqual(opened, ['First']);
  fixture.external('[[Second]] ![[Other]]'); old.click(); assert.deepEqual(opened, ['First']); assert.equal(disposed, 1);
  const next = card.element.querySelector<HTMLAnchorElement>('a')!; await card.activate(); next.click(); assert.equal(disposed, 2);
  card.destroy(); assert.equal(fixture.destroyed, 1); assert.equal(fixture.listeners.size, 0);
});

test('same-text settings notifications reconfigure live list editing without a source write', async t => {
  const ui = environment(t), fixture = sessionFixture('- item'); const listOptions = { useTab: true, tabSize: 4, smartIndentList: true };
  Object.defineProperty(fixture.session, 'editorOptions', { value: { paths: () => [], open() {}, listOptions } });
  const card = createCanvasMarkdownCard(ui.document, { load: async () => fixture.session }); ui.parent.append(card.element); t.after(() => card.destroy()); await card.activate();
  const cm = editor(card.element); assert.equal(cm.state.tabSize, 4); listOptions.useTab = false; listOptions.tabSize = 2; fixture.external(fixture.text); await tick();
  assert.equal(editor(card.element), cm); assert.equal(cm.state.tabSize, 2); assert.equal(fixture.updates.length, 0); assert.equal(cm.state.doc.toString(), '- item');
});

test('Canvas file cards retain the live editor across geometry changes and never put note text into Canvas JSON', async t => {
  const ui = environment(t), fixture = sessionFixture(), saves: string[] = [];
  const source = JSON.stringify({ nodes: [{ id: 'note', type: 'file', file: 'Courses.md', x: 0, y: 0, width: 300, height: 200 }], edges: [], custom: true });
  const model = CanvasDocument.parse(source), view = createCanvasView(ui.parent, { document: model, onChange: value => { saves.push(value); }, openMarkdownFile: async path => { assert.equal(path, 'Courses.md'); return fixture.session; } }); t.after(() => view.destroy());
  await tick(); assert.equal(ui.parent.querySelector('.zorid-canvas-node-label')?.textContent, 'Courses'); assert.equal(ui.parent.querySelector('h1')?.textContent, 'Courses');
  ui.parent.querySelector<HTMLButtonElement>('[aria-label="Edit note"]')!.click(); await tick();
  const cm = editor(ui.parent); type(cm, '\nNew note text'); await view.flush();
  assert.equal(model.toString(), source); assert.deepEqual(saves, []); assert.match(fixture.saved, /New note text/);
  const viewport = ui.parent.querySelector<HTMLElement>('.zorid-canvas-viewport')!;
  const pointer = (target: Element, type: string, x: number) => { const event = new ui.dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x }); Object.defineProperty(event, 'pointerId', { value: 1 }); target.dispatchEvent(event); return event; };
  const label = ui.parent.querySelector('.zorid-canvas-node-label')!; pointer(label, 'pointerdown', 0); pointer(viewport, 'pointermove', 30); pointer(viewport, 'pointerup', 30); await view.flush();
  assert.equal(editor(ui.parent), cm); assert.equal(model.getNode('note')?.x, 30); assert.equal(saves.length, 1); assert.equal(model.getNode('note')?.text, undefined);
  assert.equal(undo(cm), true); await view.flush(); assert.doesNotMatch(fixture.saved, /New note text/);
});

test('failed file writes block card removal and retain source; file-card scrolling does not pan Canvas', async t => {
  const ui = environment(t), fixture = sessionFixture(), errors: unknown[] = [];
  const model = CanvasDocument.parse(JSON.stringify({ nodes: [{ id: 'note', type: 'file', file: 'Courses.md', x: 0, y: 0, width: 300, height: 200 }], edges: [] }));
  const view = createCanvasView(ui.parent, { document: model, onChange() {}, openMarkdownFile: async () => fixture.session, onError: error => errors.push(error) }); t.after(() => view.destroy()); await tick();
  const preview = ui.parent.querySelector<HTMLElement>('.zorid-canvas-note-preview')!, world = ui.parent.querySelector<HTMLElement>('.zorid-canvas-world')!, before = world.style.transform;
  const wheel = new ui.dom.window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 40 }); preview.dispatchEvent(wheel); assert.equal(wheel.defaultPrevented, false); assert.equal(world.style.transform, before);
  ui.parent.querySelector<HTMLButtonElement>('[aria-label="Edit note"]')!.click(); await tick(); type(editor(ui.parent), '\nKeep draft'); fixture.fail(new Error('File write failed'));
  assert.throws(() => view.setDocument(CanvasDocument.parse('{"nodes":[],"edges":[]}')), /unsaved changes/);
  await assert.rejects(view.flush(), /File write failed/); assert.ok(ui.parent.querySelector('.cm-editor')); assert.ok(model.getNode('note')); assert.equal(view.hasPendingChanges(), true);
  fixture.fail(); await view.flush(); view.setDocument(CanvasDocument.parse('{"nodes":[],"edges":[]}')); assert.equal(ui.parent.querySelector('.cm-editor'), null); assert.equal(fixture.destroyed, 1);
});

test('full-note preview tasks save through CAS, preserve source endings, and reject retained old controls', async t => {
  const ui = card(t, sessionFixture('- [ ] Task\r\n\r\n> - [/] Nested\r\n')); await ui.card.ready;
  const old = ui.card.element.querySelector<HTMLInputElement>('input[type="checkbox"]')!; old.click(); await ui.card.flush();
  assert.equal(ui.fixture.saved, '- [x] Task\r\n\r\n> - [/] Nested\r\n');
  assert.equal(ui.fixture.updates[0].expected, '- [ ] Task\r\n\r\n> - [/] Nested\r\n');
  ui.fixture.external('- [ ] Different task'); old.click(); await tick(); assert.equal(ui.fixture.saved, '- [ ] Different task'); assert.equal(ui.fixture.updates.length, 1);
});

test('preview task CAS rejection restores marker state without fabricating a writable editor draft', async t => {
  const ui = card(t, sessionFixture('- [ ] Task')); await ui.card.ready;
  ui.fixture.external('- [ ] Changed elsewhere', false);
  ui.card.element.querySelector<HTMLInputElement>('input')!.click();
  assert.equal(ui.card.element.querySelector<HTMLInputElement>('input')!.checked, false);
  assert.equal(ui.fixture.text, '- [ ] Changed elsewhere'); assert.equal(ui.card.hasPendingChanges(), false); assert.equal(ui.fixture.updates.length, 0);
  assert.match(ui.card.element.querySelector('[role="status"]')!.textContent!, /another editor/);
  await ui.card.flush(); assert.equal(ui.fixture.saved, '- [ ] Changed elsewhere');
});

test('preview task save failure keeps the accepted note draft and retries without losing the checked marker', async t => {
  const ui = card(t, sessionFixture('- [ ] Task')); await ui.card.ready; ui.fixture.fail(new Error('Write refused'));
  ui.card.element.querySelector<HTMLInputElement>('input')!.click(); await assert.rejects(ui.card.flush(), /Write refused/);
  assert.equal(ui.card.element.querySelector<HTMLInputElement>('input')!.checked, true); assert.equal(ui.fixture.saved, '- [ ] Task'); assert.equal(ui.card.hasPendingChanges(), true);
  ui.fixture.fail(); await ui.card.flush(); assert.equal(ui.fixture.saved, '- [x] Task'); assert.equal(ui.card.hasPendingChanges(), false);
});

test('read-only and heading previews disable task controls and do not change their note source', async t => {
  const ui = environment(t);
  for (const subpath of ['', '#Section']) {
    const fixture = sessionFixture('# Section\n- [ ] Task'); if (!subpath) Object.defineProperty(fixture.session, 'readOnly', { value: true });
    const card = createCanvasMarkdownCard(ui.document, { load: async () => fixture.session, subpath }); ui.parent.append(card.element); t.after(() => card.destroy()); await card.ready;
    const input = card.element.querySelector<HTMLInputElement>('input')!; assert.equal(input.disabled, true); input.click(); await card.flush();
    assert.equal(input.checked, false); assert.equal(fixture.saved, '# Section\n- [ ] Task'); assert.equal(fixture.updates.length, 0);
  }
});

test('plain Canvas text-card task controls commit Canvas text and undo restores exact source', async t => {
  const ui = environment(t), source = JSON.stringify({ nodes: [{ id: 'text', type: 'text', text: '- [ ] Task', x: 0, y: 0, width: 300, height: 200 }], edges: [] }), saves: string[] = [];
  const model = CanvasDocument.parse(source), view = createCanvasView(ui.parent, { document: model, onChange: source => { saves.push(source); } }); t.after(() => view.destroy());
  ui.parent.querySelector<HTMLInputElement>('.task-list-item-checkbox')!.click(); await view.flush(); assert.equal(model.getNode('text')?.text, '- [x] Task'); assert.equal(saves.length, 1);
  view.undo(); await view.flush(); assert.equal(model.toString(), source); assert.equal(ui.parent.querySelector<HTMLInputElement>('.task-list-item-checkbox')!.checked, false);
});

test('preview task writes follow alternating list/quote containers and retain other bracket text', async t => {
  const source = '- > - [ ] Nested [ ] prose\r\n\r\n> 1. > - [/] Other\r\n', ui = card(t, sessionFixture(source)); await ui.card.ready;
  const inputs = ui.card.element.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'); assert.equal(inputs.length, 2);
  inputs[0].click(); await ui.card.flush(); assert.equal(ui.fixture.saved, source.replace('- [ ] Nested', '- [x] Nested'));
  ui.card.element.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1].click(); await ui.card.flush();
  assert.equal(ui.fixture.saved, source.replace('- [ ] Nested', '- [x] Nested').replace('- [/] Other', '- [ ] Other'));
});
