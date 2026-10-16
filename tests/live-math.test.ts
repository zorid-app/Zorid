import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Compartment, EditorSelection, EditorState, StateField, StateEffect } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { history, undo } from '@codemirror/commands';
import type { LiveMathOptions } from '../src/editor/live-math.ts';
import { liveMath, liveMathMarkdown } from '../src/editor/live-math.ts';
import { liveInlineMarkdown } from '../src/editor/live-inline.ts';

function setup(t: TestContext, source: string, options: LiveMathOptions = {}, before: Extension = []) {
  const dom = new JSDOM('<!doctype html><body><main></main>', { pretendToBeVisual: true });
  const observers: { callback: () => void; disconnected: boolean }[] = [];
  class TestResizeObserver {
    record: typeof observers[number];
    constructor(callback: () => void) { this.record = { callback, disconnected: false }; observers.push(this.record); }
    observe() {}
    disconnect() { this.record.disconnected = true; }
  }
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Text: dom.window.Text,
    Window: dom.window.Window, MutationObserver: dom.window.MutationObserver, ResizeObserver: TestResizeObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} });
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const records: { source: string; display: boolean; parent: HTMLElement; disposed: number; ready: () => void }[] = [];
  const compartment = new Compartment();
  const extension = liveMath({ ...options, render(parent, source, options) {
    parent.textContent = `Rendered ${source}`;
    const anchor = parent.ownerDocument.createElement('a'); anchor.href = '#safe'; anchor.textContent = 'Link'; parent.append(anchor);
    const record = { source, display: !!options.display, parent, disposed: 0, ready: options.onReady ?? (() => {}) }; records.push(record);
    return { ready: Promise.resolve(true), dispose() { record.disposed++; } };
  } });
  const view = new EditorView({ parent: document.querySelector('main')!, state: EditorState.create({ doc: source,
    extensions: [markdown({ base: markdownLanguage, extensions: [liveInlineMarkdown, liveMathMarkdown] }),
      history(), EditorState.allowMultipleSelections.of(true), before, compartment.of(extension)] }) });
  let destroyed = false;
  const destroy = () => { if (!destroyed) { destroyed = true; view.destroy(); } };
  t.after(() => { destroy(); dom.window.close(); for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  } });
  const click = (target: Element) => target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  return { dom, view, records, destroy, compartment, click, observers, widgets: () => [...view.dom.querySelectorAll('.cm-live-math')] };
}

test('inline and display rendering preserves source and distinguishes layout from TeX display mode', t => {
  const source = 'a $x^2$ b $$y$$ c\n\n$$\n\\frac{1}{2}\n$$\nend';
  const { view, records, widgets } = setup(t, source);
  assert.deepEqual(records.map(record => [record.source, record.display]), [['x^2', false], ['y', true], ['\n\\frac{1}{2}\n', true]]);
  assert.equal(widgets().length, 3); assert.equal(view.dom.querySelectorAll('.cm-live-math-block').length, 1);
  assert.equal(view.state.doc.toString(), source);
});

test('focused selections expose inline source while display preview stays mounted after its source', t => {
  const source = '$x$\n\n$$\ny\n$$\nend', { view, records, widgets } = setup(t, source);
  const block = view.dom.querySelector('.cm-live-math-block');
  view.focus(); view.dispatch({ selection: { anchor: source.indexOf('y') } });
  assert.equal(view.dom.querySelector('.cm-live-math-block'), block);
  assert.ok(view.dom.textContent?.includes('$$')); assert.equal(records.length, 3); // inline focus reveal/remount
  view.dispatch({ selection: { anchor: 1 } });
  assert.equal(widgets().length, 1); assert.ok(view.dom.textContent?.includes('$x$'));
  view.contentDOM.blur();
  assert.equal(widgets().length, 2); assert.equal(view.state.doc.toString(), source);
});

test('multiple and reversed selections expose every intersecting formula', t => {
  const source = '$one$ $two$ $$three$$\nend', { view, widgets } = setup(t, source);
  view.focus(); view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.range(19, 14)]) });
  assert.equal(widgets().length, 2);
  assert.ok(view.dom.textContent?.includes('$one$')); assert.ok(view.dom.textContent?.includes('$$three$$'));
});

test('math edit controls resolve current positions after edits and preserve renderer links', t => {
  const source = 'before\n$$\nx+y\n$$\nend', { view, click, records } = setup(t, source);
  const block = view.dom.querySelector('.cm-live-math-block')!;
  view.dispatch({ changes: { from: 0, insert: 'prefix\n' } });
  assert.equal(view.dom.querySelector('.cm-live-math-block'), block); assert.equal(records.length, 1);
  const originalSelection = view.state.selection;
  click(block.querySelector('a')!); assert.ok(view.state.selection.eq(originalSelection));
  click(block.querySelector('button')!);
  assert.equal(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to), 'x+y');
  assert.equal(view.dom.querySelector('.cm-live-math-block'), block);
});

test('unclosed formulas and code, comments, wiki targets, HTML and properties remain source', t => {
  const source = '---\nmath: $meta$\n---\n`$code$` [[note $wiki$]] %% $comment$ %%\n\n<div>$html$</div>\n\n$valid$\n\n$$\nunclosed';
  const { records, view } = setup(t, source);
  assert.deepEqual(records.map(record => record.source), ['valid']); assert.equal(view.state.doc.toString(), source);
});

test('editing and undo replace obsolete renderings and dispose on extension removal', t => {
  const source = 'before $x$ after', { view, records, compartment } = setup(t, source);
  view.dispatch({ changes: { from: 8, to: 9, insert: 'y' } });
  assert.deepEqual(records.map(record => record.source), ['x', 'y']); assert.equal(records[0].disposed, 1);
  assert.ok(undo(view)); assert.equal(view.state.doc.toString(), source); assert.equal(records[1].disposed, 1);
  view.dispatch({ effects: compartment.reconfigure([]) }); assert.ok(records.every(record => record.disposed === 1));
});

test('pointer selection freezes replacement geometry until mouse release settles', async t => {
  const { view, dom, widgets } = setup(t, 'a $x$ b\nend');
  view.focus(); view.dispatch({ selection: { anchor: 0 } });
  const widget = widgets()[0];
  const down = new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }); down.preventDefault(); widget.dispatchEvent(down);
  view.dispatch({ selection: { anchor: 3 } }); assert.equal(widgets()[0], widget);
  document.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 65)); assert.equal(widgets().length, 0);
});

test('composition freezes source reveal and late resize callbacks are inert after destroy', async t => {
  const { view, dom, widgets, records, destroy, observers } = setup(t, 'a $x$ b\nend');
  view.focus(); view.dispatch({ selection: { anchor: 0 } });
  view.contentDOM.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
  view.dispatch({ selection: { anchor: 3 } }); assert.equal(widgets().length, 1);
  view.contentDOM.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 65)); assert.equal(widgets().length, 0);
  destroy(); for (const record of records) { assert.equal(record.disposed, 1); record.ready(); }
  for (const observer of observers) { assert.equal(observer.disconnected, true); observer.callback(); }
});


test('whole-container ownership suppresses math until source reveal, including state-only changes', t => {
  const source = '> [!note] Math\n> $inside$\n\n$outside$\nend';
  const boundary = source.indexOf('\n\n'), inside = source.indexOf('inside');
  const forceClosed = StateEffect.define<boolean>();
  const owner = StateField.define<boolean>({
    create: () => true,
    update(previous, transaction) {
      for (const effect of transaction.effects) if (effect.is(forceClosed)) return effect.value;
      if (transaction.selection) return !transaction.state.selection.ranges.some(range => range.from > 0 && range.from < boundary);
      return previous;
    },
  });
  const { view, widgets, records } = setup(t, source,
    { excludes: state => state.field(owner) ? [{ from: 0, to: boundary }] : [] }, owner);
  assert.deepEqual(records.map(record => record.source), ['outside']);
  view.focus(); view.dispatch({ selection: { anchor: inside } });
  // Revealed inline math keeps source while the containing block is editable.
  assert.equal(widgets().length, 1); assert.ok(view.dom.textContent?.includes('$inside$'));
  view.dispatch({ selection: { anchor: source.indexOf('Math') } });
  assert.equal(widgets().length, 2); assert.equal(records.at(-1)?.source, 'inside');
  view.dispatch({ effects: forceClosed.of(true) }); assert.equal(widgets().length, 1);
  assert.equal(records.at(-1)?.disposed, 1);
  view.dispatch({ effects: forceClosed.of(false) }); assert.equal(widgets().length, 2);
  assert.equal(view.state.doc.toString(), source);
});

test('retained edit controls become inert after the extension is removed', t => {
  const { view, compartment, click } = setup(t, 'before\n$$\nx\n$$\nafter');
  const control = view.dom.querySelector('.cm-live-math-edit')!;
  view.dispatch({ effects: compartment.reconfigure([]) });
  const selection = view.state.selection;
  assert.doesNotThrow(() => click(control)); assert.ok(selection.eq(view.state.selection));
});

test('unsorted overlapping exclusions merge while adjacent non-overlapping math stays rendered', t => {
  const source = '$a$ $b$ $c$ $d$\nend';
  const { records } = setup(t, source, { excludes: () => [
    { from: 8, to: 11 }, { from: 4, to: 7 }, { from: 5, to: 9 }, { from: 7, to: 8 },
    { from: 100, to: 101 }, { from: Number.NaN, to: 5 },
  ] });
  assert.deepEqual(records.map(record => record.source), ['a', 'd']);
});
