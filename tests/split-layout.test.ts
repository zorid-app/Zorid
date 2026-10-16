import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { SplitLayout, normalizeSplitLayout } from '../src/ui/split-layout.ts';
import type { SplitNode, SplitBranch, SplitChangeReason } from '../src/ui/split-layout.ts';
import { EditorView } from '@codemirror/view';
import { undo, undoDepth } from '@codemirror/commands';
import { createEditor } from '../src/ui/editor.ts';

const leaf = (paneId: string): SplitNode => ({ type: 'leaf', paneId });
const group = (id: string, direction: 'vertical' | 'horizontal', children: SplitNode[], sizes = children.map(() => 1)): SplitBranch => ({ type: 'split', id, direction, children, sizes });
const ids = (node: SplitNode | null): string[] => !node ? [] : node.type === 'leaf' ? [node.paneId] : node.children.flatMap(ids);
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} equals ${b}`);
function setup(names = ['a']) {
  const dom = new JSDOM('<!doctype html><body><main></main></body>', { pretendToBeVisual: true });
  const doc = dom.window.document, host = doc.querySelector('main')!;
  const changes: { tree: SplitNode | null; reason: SplitChangeReason }[] = [];
  const layout = new SplitLayout(host, { onChange: (tree, reason) => changes.push({ tree, reason }) });
  const panes = new Map<string, HTMLElement>();
  const make = (id: string) => {
    const pane = doc.createElement('section'); pane.className = 'pane'; pane.dataset.paneId = id;
    const editor = doc.createElement('textarea'); editor.value = `Editor ${id}`; pane.append(editor); panes.set(id, pane); return pane;
  };
  names.forEach(make); layout.setPanes(panes); changes.length = 0;
  const geometry = (width = 1006, height = 806) => {
    for (const element of host.querySelectorAll<HTMLElement>('.split-layout-group')) element.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON() { return {}; } });
  };
  const divider = (index = 0) => host.querySelectorAll<HTMLElement>('.split-layout-separator')[index];
  const pointer = (target: EventTarget, type: string, x: number, y = 0, pointerId = 1) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    Object.defineProperty(event, 'pointerId', { value: pointerId }); target.dispatchEvent(event); return event;
  };
  const key = (target: EventTarget, value: string, shiftKey = false) => {
    const event = new dom.window.KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true }); target.dispatchEvent(event); return event;
  };
  return { dom, doc, host, panes, layout, changes, make, geometry, divider, pointer, key };
}

test('splits right and below form nested topology while preserving pane/editor identity and focus', () => {
  const { dom, doc, panes, layout, make, host } = setup();
  const original = panes.get('a')!, editor = original.querySelector('textarea')!;
  const sentinel = {}; (editor as unknown as { editorInstance: object }).editorInstance = sentinel;
  let inputEvents = 0; editor.addEventListener('input', () => inputEvents++);
  editor.focus(); editor.setSelectionRange(2, 5);
  assert.equal(layout.split('a', 'b', make('b'), 'right'), true);
  assert.equal(layout.split('a', 'c', make('c'), 'bottom'), true);
  const tree = layout.serialize() as SplitBranch;
  assert.equal(tree.direction, 'vertical');
  assert.equal((tree.children[0] as SplitBranch).direction, 'horizontal');
  assert.deepEqual(ids(tree), ['a', 'c', 'b']);
  assert.equal(host.querySelector('[data-pane-id=a]'), original); assert.equal(original.querySelector('textarea'), editor);
  assert.equal((editor as unknown as { editorInstance: object }).editorInstance, sentinel);
  assert.equal(doc.activeElement, editor); assert.equal(editor.selectionStart, 2); assert.equal(editor.selectionEnd, 5);
  editor.dispatchEvent(new dom.window.Event('input')); assert.equal(inputEvents, 1);
  layout.destroy(); dom.window.close();
});

test('same-direction split inserts beside the target and halves only its size', () => {
  const { dom, layout, make } = setup(['a', 'b']);
  layout.restore(group('root', 'vertical', [leaf('a'), leaf('b')], [3, 1]));
  layout.split('a', 'c', make('c'), 'right');
  const tree = layout.serialize() as SplitBranch;
  assert.equal(tree.children.length, 3); assert.deepEqual(ids(tree), ['a', 'c', 'b']);
  assert.deepEqual(tree.sizes, [.375, .375, .25]); layout.destroy(); dom.window.close();
});

test('remove collapses singleton ancestors, normalizes surviving sizes, and returns the owned leaf', () => {
  const { dom, layout, panes } = setup(['a', 'b', 'c']);
  layout.restore(group('root', 'vertical', [group('inside', 'horizontal', [leaf('a'), leaf('b')]), leaf('c')], [3, 1]));
  assert.equal(layout.remove('b'), panes.get('b'));
  const tree = layout.serialize() as SplitBranch;
  assert.deepEqual(tree.children, [leaf('a'), leaf('c')]); assert.deepEqual(tree.sizes, [.75, .25]);
  layout.remove('c'); assert.deepEqual(layout.serialize(), leaf('a'));
  layout.remove('a'); assert.equal(layout.serialize(), null); assert.equal(layout.remove('missing'), null);
  layout.destroy(); dom.window.close();
});

test('moving an existing pane across nested groups preserves every leaf and active selection', () => {
  const { dom, doc, layout, panes } = setup(['a', 'b', 'c']);
  layout.restore(group('root', 'vertical', [group('inside', 'horizontal', [leaf('a'), leaf('b')]), leaf('c')]));
  const editor = panes.get('b')!.querySelector('textarea')!; editor.focus(); editor.setSelectionRange(1, 4);
  assert.equal(layout.move('b', 'c', 'right'), true);
  assert.deepEqual(ids(layout.serialize()), ['a', 'c', 'b']);
  assert.equal((layout.serialize() as SplitBranch).children.length, 3);
  assert.equal(doc.activeElement, editor); assert.equal(editor.selectionStart, 1); assert.equal(editor.selectionEnd, 4);
  assert.equal(layout.move('a', 'a', 'left'), false); assert.equal(layout.move('a', 'missing', 'left'), false);
  layout.destroy(); dom.window.close();
});

test('restoring arbitrary nested layout retains valid stable IDs, ordering and normalized sizes', () => {
  const { dom, layout, panes } = setup(['a', 'b', 'c', 'd']);
  const saved = group('outer', 'horizontal', [group('upper', 'vertical', [leaf('d'), leaf('a')], [1, 3]), group('lower', 'vertical', [leaf('b'), leaf('c')], [2, 1])], [2, 3]);
  layout.restore(saved); const result = layout.serialize() as SplitBranch;
  assert.equal(result.id, 'outer'); assert.equal(result.direction, 'horizontal'); close(result.sizes[0], .4); close(result.sizes[1], .6);
  assert.deepEqual(ids(result), ['d', 'a', 'b', 'c']);
  const serialized = layout.serialize(); layout.setPanes(panes, serialized); assert.deepEqual(layout.serialize(), serialized);
  (result.children[0] as SplitBranch).sizes[0] = 99;
  assert.notDeepEqual(layout.serialize(), result, 'serialized snapshots cannot mutate live state');
  layout.destroy(); dom.window.close();
});

test('malformed layouts discard unknown/duplicate leaves and retain all registered panes', () => {
  const damaged = group('same', 'vertical', [leaf('missing'), leaf('a'), leaf('a'), group('same', 'horizontal', [leaf('b'), leaf('c')])], [NaN, -1, 0, Infinity]);
  const result = normalizeSplitLayout(damaged, ['a', 'b', 'c', 'd']) as SplitBranch;
  assert.deepEqual(ids(result).sort(), ['a', 'b', 'c', 'd']);
  assert.ok(result.sizes.every(value => Number.isFinite(value) && value > 0)); close(result.sizes.reduce((a, b) => a + b, 0), 1);
  assert.notEqual(result.id, (result.children.find(child => child.type === 'split') as SplitBranch).id);
  assert.deepEqual(normalizeSplitLayout({ type: 'split', direction: 'diagonal' }, ['a']), leaf('a'));
  assert.equal(normalizeSplitLayout(null, []), null);
  const cycle: Record<string, unknown> = { type: 'split', direction: 'vertical' }; cycle.children = [cycle];
  assert.deepEqual(normalizeSplitLayout(cycle, ['a']), leaf('a'));
  const huge = normalizeSplitLayout(group('huge', 'vertical', [leaf('a'), leaf('b')], [Number.MAX_VALUE, Number.MAX_VALUE]), ['a', 'b']) as SplitBranch;
  assert.deepEqual(huge.sizes, [.5, .5]);
});

test('pointer resize redistributes across siblings, clamps each at 200px and commits once', () => {
  const { dom, doc, layout, changes, geometry, divider, pointer } = setup(['a', 'b', 'c']);
  geometry(1212, 800); const separator = divider();
  assert.equal(pointer(separator, 'pointerdown', 400).defaultPrevented, true);
  pointer(doc, 'pointermove', 900);
  const during = layout.serialize() as SplitBranch;
  close(during.sizes[0], 2 / 3); close(during.sizes[1], 1 / 6); close(during.sizes[2], 1 / 6);
  assert.equal(changes.length, 0, 'drag previews do not persist repeatedly');
  pointer(doc, 'pointerup', 900); assert.deepEqual(changes.map(change => change.reason), ['resize']);
  assert.equal(separator.getAttribute('aria-valuenow'), '67'); assert.equal(separator.getAttribute('aria-valuemax'), '67');
  layout.destroy(); dom.window.close();
});

test('resize cancel, Escape and loss of window focus restore the original persisted sizes', () => {
  for (const cancel of ['pointercancel', 'Escape', 'blur']) {
    const { dom, doc, layout, changes, geometry, divider, pointer, key, host } = setup(['a', 'b']);
    geometry(); const original = layout.serialize(); pointer(divider(), 'pointerdown', 500); pointer(doc, 'pointermove', 650);
    assert.notDeepEqual(layout.serialize(), original);
    if (cancel === 'Escape') key(doc, 'Escape');
    else if (cancel === 'blur') dom.window.dispatchEvent(new dom.window.Event('blur'));
    else pointer(doc, cancel, 650);
    assert.deepEqual(layout.serialize(), original, cancel); assert.equal(changes.length, 0); assert.equal(host.classList.contains('is-resizing'), false);
    pointer(doc, 'pointermove', 800); assert.deepEqual(layout.serialize(), original, 'listeners removed after cancel');
    layout.destroy(); dom.window.close();
  }
});

test('a second pointer cannot commit or alter the active resize', () => {
  const { dom, doc, layout, geometry, divider, pointer, changes } = setup(['a', 'b']);
  geometry(); const original = layout.serialize(); pointer(divider(), 'pointerdown', 500, 0, 1);
  pointer(doc, 'pointermove', 700, 0, 2); pointer(doc, 'pointerup', 700, 0, 2);
  assert.deepEqual(layout.serialize(), original); assert.equal(changes.length, 0);
  pointer(doc, 'pointermove', 600, 0, 1); pointer(doc, 'pointerup', 600, 0, 1);
  close((layout.serialize() as SplitBranch).sizes[0], .6); assert.equal(changes.length, 1);
  layout.destroy(); dom.window.close();
});

test('horizontal divider keyboard resize, limits and reset expose separator semantics', () => {
  const { dom, doc, layout, geometry, divider, key } = setup(['a', 'b']);
  layout.restore(group('root', 'horizontal', [leaf('a'), leaf('b')])); geometry(1000, 806);
  const separator = divider(); separator.focus();
  assert.equal(separator.role, 'separator'); assert.equal(separator.getAttribute('aria-orientation'), 'horizontal');
  assert.equal(separator.tabIndex, 0); assert.match(separator.getAttribute('aria-controls')!, /zorid-pane/);
  key(separator, 'ArrowDown', true); close((layout.serialize() as SplitBranch).sizes[0], 450 / 800);
  key(separator, 'End'); close((layout.serialize() as SplitBranch).sizes[0], .75);
  key(separator, 'Home'); close((layout.serialize() as SplitBranch).sizes[0], .25);
  key(separator, 'Enter'); close((layout.serialize() as SplitBranch).sizes[0], .5);
  assert.equal(doc.activeElement, separator); layout.destroy(); dom.window.close();
});

test('RTL vertical pointer movement and keyboard arrows use visual direction', () => {
  const { dom, doc, layout, geometry, divider, pointer, key, host } = setup(['a', 'b']);
  geometry(); host.querySelector<HTMLElement>('.split-layout-group')!.style.direction = 'rtl';
  pointer(divider(), 'pointerdown', 500); pointer(doc, 'pointerup', 600);
  close((layout.serialize() as SplitBranch).sizes[0], .4);
  key(divider(), 'ArrowLeft'); close((layout.serialize() as SplitBranch).sizes[0], .41);
  layout.destroy(); dom.window.close();
});

test('compact containers keep every pane visible when absolute minimums cannot fit', () => {
  const { dom, doc, layout, geometry, divider, pointer } = setup(['a', 'b']);
  geometry(306, 300); pointer(divider(), 'pointerdown', 150); pointer(doc, 'pointerup', 280);
  const tree = layout.serialize() as SplitBranch; assert.deepEqual(tree.sizes, [.5, .5]);
  layout.destroy(); dom.window.close();
});

test('nested same-axis subtree contributes all descendant minimums when its outer divider resizes', () => {
  const { dom, doc, layout, geometry, divider, pointer } = setup(['a', 'b', 'c']);
  layout.restore(group('root', 'vertical', [group('inner', 'vertical', [leaf('a'), leaf('b')]), leaf('c')]));
  geometry(1006, 800);
  const outer = [...dom.window.document.querySelectorAll<HTMLElement>('.split-layout-separator')].find(element => element.parentElement?.dataset.splitId === 'root')!;
  pointer(outer, 'pointerdown', 500); pointer(doc, 'pointerup', 0);
  close((layout.serialize() as SplitBranch).sizes[0], .406);
  layout.destroy(); dom.window.close();
});

test('destroy cancels drag, preserves leaves and restores their original styling and focus', () => {
  const { dom, doc, host, layout, panes, geometry, divider, pointer } = setup(['a', 'b']);
  const editor = panes.get('a')!.querySelector('textarea')!; editor.focus(); geometry();
  pointer(divider(), 'pointerdown', 500); pointer(doc, 'pointermove', 600); layout.destroy();
  assert.equal(host.querySelector('.split-layout-group'), null); assert.equal(host.querySelector('.split-layout-separator'), null);
  assert.equal(host.children[0], panes.get('a')); assert.equal(host.children[1], panes.get('b'));
  assert.equal(panes.get('a')!.style.flex, ''); assert.equal(panes.get('a')!.id, ''); assert.equal(doc.activeElement, editor);
  pointer(doc, 'pointermove', 700); assert.throws(() => layout.restore(null), /destroyed/);
  layout.destroy(); dom.window.close();
});

test('registered pane replacement and invalid nested registration do not duplicate leaf ownership', () => {
  const { dom, doc, layout, panes } = setup(['a', 'b']);
  const replacement = doc.createElement('section'); const previous = panes.get('a')!;
  layout.setPanes(new Map([['a', replacement], ['b', panes.get('b')!]]));
  assert.equal(previous.isConnected, false); assert.deepEqual(ids(layout.serialize()), ['a', 'b']);
  assert.throws(() => layout.setPanes(new Map([['a', replacement], ['b', replacement]])), /registration/);
  const inner = doc.createElement('div'); replacement.append(inner);
  assert.throws(() => layout.setPanes(new Map([['a', replacement], ['b', inner]])), /contain/);
  layout.destroy(); dom.window.close();
});

test('real Live Edit CodeMirror instance, selection and undo survive split and move operations', t => {
  const { dom, doc, panes, layout, make } = setup();
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: doc, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Text: dom.window.Text, Window: dom.window.Window,
    MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} });
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const pane = panes.get('a')!; pane.replaceChildren();
  const editor = createEditor(pane, { value: '**Original** text', mode: 'live', paths: () => [], onChange() {}, open() {} });
  t.after(() => {
    editor.destroy(); layout.destroy(); dom.window.close();
    for (const [key, value] of saved) if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key);
  });
  const cmNode = pane.querySelector<HTMLElement>('.cm-editor')!, view = EditorView.findFromDOM(cmNode)!;
  view.dispatch({ changes: { from: view.state.doc.length, insert: ' edited' }, userEvent: 'input.type' });
  view.dispatch({ selection: { anchor: 2, head: 7 } }); view.focus();
  const selection = view.state.selection, depth = undoDepth(view.state);
  assert.ok(depth > 0);
  layout.split('a', 'b', make('b'), 'right'); layout.split('b', 'c', make('c'), 'bottom'); layout.move('a', 'c', 'bottom');
  assert.equal(pane.querySelector('.cm-editor'), cmNode); assert.equal(EditorView.findFromDOM(cmNode), view);
  assert.equal(doc.activeElement, view.contentDOM); assert.ok(view.state.selection.eq(selection));
  assert.equal(undoDepth(view.state), depth); assert.equal(editor.getValue(), '**Original** text edited');
  assert.ok(undo(view)); assert.equal(editor.getValue(), '**Original** text');
});

test('forward and reverse DOM selections retain immutable text endpoints through leaf reparenting', () => {
  for (const reverse of [false, true]) {
    const { dom, doc, layout, panes, make } = setup();
    const editable = doc.createElement('div'); editable.contentEditable = 'true'; editable.tabIndex = 0; editable.textContent = 'abcdef';
    panes.get('a')!.replaceChildren(editable); editable.focus();
    const text = editable.firstChild!, selection = doc.getSelection()!;
    selection.setBaseAndExtent(text, reverse ? 5 : 2, text, reverse ? 2 : 5);
    assert.equal(selection.toString(), 'cde');
    layout.split('a', 'b', make('b'), 'right'); layout.move('a', 'b', 'bottom');
    assert.equal(doc.activeElement, editable); assert.equal(selection.toString(), 'cde');
    assert.equal(selection.anchorNode, text); assert.equal(selection.focusNode, text);
    assert.equal(selection.anchorOffset, reverse ? 5 : 2); assert.equal(selection.focusOffset, reverse ? 2 : 5);
    layout.destroy(); dom.window.close();
  }
});
