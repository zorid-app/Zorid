import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorSelection, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { historyField, isolateHistory, undo, redo, undoDepth, redoDepth } from '@codemirror/commands';
import { foldState } from '@codemirror/language';
import { createEditor } from '../src/ui/editor.ts';
import { createTabViewRuntime } from '../src/ui/tab-view-runtime.ts';
import type { TabViewOwner, TabViewRuntime, TabViewRuntimeOptions } from '../src/ui/tab-view-runtime.ts';

const owner = (paneId = 'a'): TabViewOwner => ({ paneId, vaultId: 'vault:one', vaultGeneration: 3 });
function setup(t: TestContext, doc = 'first line\n# A\nbody\n# B\nlast') {
  const dom = new JSDOM('<!doctype html><body><section id="a"><main></main><aside></aside></section><section id="b"></section>', { pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, Text: dom.window.Text, Window: dom.window.Window,
    MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} });
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const a = document.querySelector<HTMLElement>('#a')!, b = document.querySelector<HTMLElement>('#b')!, element = document.querySelector<HTMLElement>('main')!;
  let runtime: TabViewRuntime | undefined, disposed = false, flushes = 0, disposals = 0, embeds = 0, releases = 0;
  const changes: { owner: string | undefined; text: string }[] = [];
  const handle = createEditor(element, { value: doc, mode: 'live', paths: () => [], open() {},
    onChange(text) { runtime?.touch(); changes.push({ owner: runtime?.owner.paneId, text }); },
    renderEmbed() { embeds++; const child = document.createElement('div'); child.className = 'owned-embed'; return { dom: child, destroy() { releases++; } }; },
  });
  const view = EditorView.findFromDOM(element.querySelector('.cm-editor')!)!;
  const dispose = () => { if (!disposed) { disposed = true; disposals++; handle.destroy(); } };
  t.after(() => { dispose(); dom.window.close(); for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  const create = (extra: Partial<TabViewRuntimeOptions> = {}) => runtime = createTabViewRuntime({ id: 'tab-one', element, owner: owner(),
    flush() { flushes++; }, dispose, focus: () => handle.focus(), ...extra });
  return { dom, a, b, element, handle, view, changes, create, dispose,
    get flushes() { return flushes; }, get disposals() { return disposals; }, get embeds() { return embeds; }, get releases() { return releases; } };
}
function deferred() { let resolve!: () => void, reject!: (error: Error) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('same-window attach retains actual CM undo/redo, reversed multicarets, folds and scroll through focus effects', async t => {
  const f = setup(t), runtime = f.create(), { view } = f;
  view.dispatch({ changes: { from: 0, insert: 'X' }, annotations: [Transaction.userEvent.of('input.type'), isolateHistory.of('full')] });
  view.dispatch({ changes: { from: view.state.doc.length, insert: 'Y' }, annotations: [Transaction.userEvent.of('input.type'), isolateHistory.of('full')] });
  assert.ok(undo(view));
  view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.range(8, 2)], 1) });
  f.handle.fold!('foldAll'); view.focus(); view.scrollDOM.scrollTop = 45; view.scrollDOM.scrollLeft = 3;
  const state = view.state, selected = state.selection.toJSON(), folded = f.handle.getViewState!().folds, lease = runtime.captureOwnership();
  const transactions: Transaction[] = [], dispatch = view.dispatchTransactions, changesBefore = f.changes.length;
  view.dispatchTransactions = (updates, source) => { transactions.push(...updates); dispatch(updates, source); };
  try {
    assert.equal(runtime.attach(f.b, owner('b'), lease.revision), true);
    // Focus listeners in live math dispatch synchronously; callouts also queue
    // focus effects. Those valid transactions can replace EditorState without
    // reconstructing the editor or changing its document/history/selection.
    await Promise.resolve(); await Promise.resolve();
  } finally { view.dispatchTransactions = dispatch; }
  assert.equal(EditorView.findFromDOM(f.element.querySelector('.cm-editor')!), view);
  assert.equal(view.state.doc, state.doc);
  assert.deepEqual(view.state.selection.toJSON(), selected);
  assert.equal(view.state.field(historyField), state.field(historyField));
  assert.equal(view.state.field(foldState), state.field(foldState));
  assert.ok(transactions.every(transaction => !transaction.docChanged && transaction.startState.selection.eq(transaction.state.selection)), 'attachment and focus must not edit text or selection');
  assert.equal(f.changes.length, changesBefore, 'attachment cannot publish a document edit');
  assert.deepEqual(f.handle.getViewState!().folds, folded); assert.equal(view.hasFocus, true);
  assert.equal(view.scrollDOM.scrollTop, 45); assert.equal(view.scrollDOM.scrollLeft, 3);
  assert.equal(undoDepth(view.state), 1); assert.equal(redoDepth(view.state), 1); assert.ok(redo(view));
  assert.equal(view.state.doc.toString().endsWith('Y'), true); assert.equal(f.changes.at(-1)?.owner, 'b');
  assert.ok(undo(view)); assert.equal(view.state.doc.toString(), state.doc.toString());
  assert.ok(undo(view)); assert.equal(view.state.doc.toString(), state.doc.toString().slice(1));
  assert.ok(redo(view)); assert.ok(redo(view)); assert.equal(view.state.doc.toString(), state.doc.toString() + 'Y');
  assert.ok(f.changes.slice(changesBefore).every(change => change.owner === 'b'), 'retained history continues editing through the destination owner');
  assert.equal(runtime.isCurrent(lease), false); assert.equal(f.flushes, 0); assert.equal(f.disposals, 0);
});

test('moving a focused table child keeps its actual editor, selection and parent undo', async t => {
  const f = setup(t, '| H |\n| --- |\n| first |'), runtime = f.create();
  const cell = f.element.querySelector<HTMLElement>('td')!;
  cell.dispatchEvent(new f.dom.window.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
  const child = EditorView.findFromDOM(cell.querySelector('.cm-editor')!)!;
  child.dispatch({ changes: { from: 0, insert: 'X' }, annotations: Transaction.userEvent.of('input.type') });
  child.dispatch({ selection: EditorSelection.range(4, 1) });
  const selected = child.state.selection.toJSON(); assert.equal(child.hasFocus, true);
  runtime.attach(f.b, owner('b')); await Promise.resolve();
  assert.equal(EditorView.findFromDOM(cell.querySelector('.cm-editor')!), child); assert.equal(child.hasFocus, true);
  assert.deepEqual(child.state.selection.toJSON(), selected); assert.equal(undoDepth(f.view.state), 1);
  child.dispatch({ changes: { from: 0, insert: 'Y' }, annotations: Transaction.userEvent.of('input.type') });
  assert.equal(f.changes.at(-1)?.owner, 'b'); assert.equal(f.handle.getValue().includes('YXfirst'), true);
});

test('local moves preserve embed leases and disposal releases them once after flush', async t => {
  const f = setup(t, '![[Note]]\n\ntext'), runtime = f.create(), embed = f.element.querySelector('.owned-embed');
  assert.ok(embed); assert.equal(f.embeds, 1);
  runtime.attach(f.b, owner('b')); runtime.attach(f.a, owner());
  assert.equal(f.element.querySelector('.owned-embed'), embed); assert.equal(f.embeds, 1); assert.equal(f.releases, 0);
  await runtime.destroy(); await runtime.destroy();
  assert.equal(f.flushes, 1); assert.equal(f.disposals, 1); assert.equal(f.releases, 1); assert.equal(f.element.isConnected, false);
});

test('failed DOM attachment rolls back sibling order, owner and focus without disposing', t => {
  const f = setup(t), runtime = f.create(), next = f.element.nextSibling;
  f.view.focus(); const previous = runtime.captureOwnership(), append = f.b.appendChild.bind(f.b);
  f.b.appendChild = ((node: Node) => { append(node); throw new Error('destination failed after insertion'); }) as typeof f.b.appendChild;
  assert.throws(() => runtime.attach(f.b, owner('b')), /destination failed/);
  assert.equal(f.element.parentNode, f.a); assert.equal(f.element.nextSibling, next); assert.deepEqual(runtime.owner, owner());
  assert.equal(runtime.phase, 'active'); assert.equal(f.view.hasFocus, true); assert.equal(runtime.isCurrent(previous), false);
  assert.equal(f.disposals, 0); assert.equal(f.flushes, 0);
});

test('failed focus adapter rolls back attachment and restores source through the adapter', t => {
  const f = setup(t); let restores = 0;
  const runtime = f.create({ captureFocus: () => () => { if (++restores === 1) throw new Error('adapter failed'); f.view.focus(); } });
  assert.throws(() => runtime.attach(f.b, owner('b')), /adapter failed/);
  assert.equal(restores, 2); assert.equal(f.element.parentNode, f.a); assert.equal(f.view.hasFocus, true);
  assert.equal(runtime.phase, 'active'); assert.equal(f.disposals, 0);
});

test('focus capture owns the transition and rejects reentrant lifecycle mutations', async t => {
  const f = setup(t); let runtime!: TabViewRuntime, closing: Promise<void> | undefined;
  runtime = f.create({ captureFocus() {
    assert.equal(runtime.phase, 'moving');
    assert.throws(() => runtime.attach(f.b, owner('b')), /moving/);
    assert.throws(() => runtime.detach(), /moving/);
    closing = runtime.destroy();
    return () => {};
  } });
  assert.equal(runtime.attach(f.b, owner('b')), true);
  await assert.rejects(closing!, /moving/);
  assert.equal(runtime.phase, 'active'); assert.equal(f.flushes, 0); assert.equal(f.disposals, 0);
});

test('thrown capture or content mutation during capture leaves source active and attached', t => {
  const f = setup(t); let runtime!: TabViewRuntime, mode = 'throw';
  runtime = f.create({ captureFocus() {
    if (mode === 'throw') throw new Error('capture failed');
    runtime.touch(); return () => {};
  } });
  assert.throws(() => runtime.attach(f.b, owner('b')), /capture failed/);
  assert.equal(runtime.phase, 'active'); assert.equal(f.element.parentNode, f.a);
  mode = 'change'; assert.throws(() => runtime.attach(f.b, owner('b')), /changed while capturing/);
  assert.equal(runtime.phase, 'active'); assert.equal(f.element.parentNode, f.a); assert.equal(f.disposals, 0);
});

test('owner copies, stale revisions and invalid destinations cannot redirect live content', t => {
  const f = setup(t), input = owner(), runtime = f.create({ owner: input }), token = runtime.captureOwnership();
  input.paneId = 'changed'; assert.equal(runtime.owner.paneId, 'a'); assert.equal(Object.isFrozen(runtime.owner), true);
  assert.equal(runtime.attach(f.a, owner()), false); assert.equal(runtime.isCurrent(token), true);
  runtime.touch(); assert.throws(() => runtime.attach(f.b, owner('b'), token.revision), /ownership changed/);
  const otherDocument = document.implementation.createHTMLDocument('Other');
  for (const [host, value] of [[f.b, { ...owner('b'), vaultId: 'other' }], [f.b, { ...owner('b'), vaultGeneration: 4 }],
    [f.view.contentDOM, owner('b')], [document.createElement('div'), owner('b')], [otherDocument.body, owner('b')]] as const) {
    assert.throws(() => runtime.attach(host, value)); assert.equal(f.element.parentNode, f.a);
  }
  assert.equal(f.flushes, 0); assert.equal(f.disposals, 0);
});

test('ownership tokens cannot authorize another runtime even with the same tab ID and revision', t => {
  const f = setup(t), first = f.create(), old = first.captureOwnership();
  const replacement = createTabViewRuntime({ id: first.id, owner: owner(), element: document.createElement('div'), flush() {}, dispose() {} });
  assert.equal(replacement.revision, old.revision); assert.equal(replacement.isCurrent(old), false);
  assert.equal(first.isCurrent({ ...old }), false); assert.equal(first.isCurrent(old), true);
});

test('detach retains editor resources and explicit attach reuses the same runtime', t => {
  const f = setup(t), runtime = f.create(), before = runtime.captureOwnership();
  assert.equal(runtime.detach(before.revision), true); assert.equal(runtime.detach(), false);
  assert.equal(f.element.isConnected, false); assert.equal(f.disposals, 0); assert.equal(runtime.isCurrent(before), false);
  runtime.attach(f.b, owner('b')); runtime.focus();
  assert.equal(EditorView.findFromDOM(f.element.querySelector('.cm-editor')!), f.view); assert.equal(f.view.hasFocus, true);
});

test('concurrent close requests await one flush and dispose once; pending close blocks movement', async t => {
  const f = setup(t), flush = deferred(); let calls = 0;
  const runtime = f.create({ flush() { calls++; return flush.promise; } }), before = runtime.captureOwnership();
  const first = runtime.destroy(), second = runtime.destroy(); assert.equal(first, second);
  assert.equal(runtime.phase, 'closing'); assert.equal(runtime.isCurrent(before), false); assert.equal(f.element.isConnected, true);
  assert.throws(() => runtime.attach(f.b, owner('b')), /closing/); assert.throws(() => runtime.detach(), /closing/);
  assert.equal(f.disposals, 0); flush.resolve(); await first;
  assert.equal(calls, 1); assert.equal(f.disposals, 1); assert.equal(runtime.phase, 'disposed');
  assert.throws(() => runtime.touch(), /disposed/); assert.throws(() => runtime.focus(), /disposed/);
});

test('a close requested synchronously from the flush callback shares the published operation', async t => {
  const f = setup(t); let runtime!: TabViewRuntime, nested: Promise<void> | undefined;
  runtime = f.create({ flush() { nested = runtime.destroy(); } });
  const closing = runtime.destroy(); await closing;
  assert.equal(nested, closing); assert.equal(f.disposals, 1);
});

test('failed flush preserves dirty state and live DOM, allowing a later retry', async t => {
  const f = setup(t); let reject = true;
  const runtime = f.create({ flush() { if (reject) throw new Error('disk unavailable'); } });
  f.view.dispatch({ changes: { from: 0, insert: 'dirty ' }, annotations: Transaction.userEvent.of('input.type') });
  const state = f.view.state;
  await assert.rejects(runtime.destroy(), /disk unavailable/);
  assert.equal(runtime.phase, 'active'); assert.equal(f.view.state, state); assert.equal(f.element.parentNode, f.a); assert.equal(f.disposals, 0);
  runtime.attach(f.b, owner('b')); reject = false; await runtime.destroy(); assert.equal(f.disposals, 1);
});

test('edits while a close flush waits invalidate disposal and retain the new source state', async t => {
  const f = setup(t), flush = deferred(), runtime = f.create({ flush: () => flush.promise });
  const closing = runtime.destroy();
  await Promise.resolve();
  f.view.dispatch({ changes: { from: 0, insert: 'late ' }, annotations: Transaction.userEvent.of('input.type') });
  flush.resolve(); await assert.rejects(closing, /changed while closing/);
  assert.equal(runtime.phase, 'active'); assert.equal(f.disposals, 0); assert.equal(f.handle.getValue().startsWith('late '), true);
  assert.equal(undoDepth(f.view.state), 1); await runtime.destroy(); assert.equal(f.disposals, 1);
});

test('disposal rejection is terminal and does not run a partially completed disposer twice', async t => {
  const f = setup(t); let attempts = 0;
  const runtime = f.create({ dispose() { attempts++; f.dispose(); throw new Error('resource release failed'); } });
  const first = runtime.destroy(); await assert.rejects(first, /resource release failed/);
  assert.equal(runtime.phase, 'disposed'); assert.equal(f.element.isConnected, false);
  assert.equal(runtime.destroy(), first); await assert.rejects(runtime.destroy(), /resource release failed/); assert.equal(attempts, 1);
});

test('DOM focus restoration preserves immutable reversed selection endpoints', t => {
  const f = setup(t), editable = document.createElement('div'); editable.contentEditable = 'true'; editable.tabIndex = 0; editable.textContent = 'abcdef'; f.element.append(editable);
  const runtime = f.create(), text = editable.firstChild!, selection = document.getSelection()!;
  editable.focus(); selection.setBaseAndExtent(text, 5, text, 2);
  runtime.attach(f.b, owner('b'));
  assert.equal(document.activeElement, editable); assert.equal(selection.toString(), 'cde');
  assert.equal(selection.anchorNode, text); assert.equal(selection.anchorOffset, 5); assert.equal(selection.focusOffset, 2);
});
