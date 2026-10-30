import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, Text } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { forceParsing } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { JSDOM } from 'jsdom';
import type { InlineBaseRequest } from '../src/bases/inline-base.ts';
import { liveCallouts, renderedCalloutRanges } from '../src/editor/live-callouts.ts';

test('opening and editing a large plain note avoids full document materialization for callouts', () => {
  const source = 'x'.repeat(432000);
  const original = Text.prototype.toString;
  let fullCopies = 0;
  Text.prototype.toString = function () {
    if (this.length >= source.length) fullCopies++;
    return original.call(this);
  };
  try {
    const state = EditorState.create({ doc: source, extensions: [markdown(), liveCallouts()] });
    assert.deepEqual(renderedCalloutRanges(state), []);
    const edited = state.update({ changes: { from: 0, insert: 'y' } }).state;
    assert.deepEqual(renderedCalloutRanges(edited), []);
    assert.equal(fullCopies, 0, 'callout discovery must leave the large plain document as Text');
  } finally {
    Text.prototype.toString = original;
  }
});

test('ordinary blockquotes in a large note do not require full document materialization', () => {
  const source = '> Ordinary quotation\n> Still no callout header\n\n' + 'x'.repeat(432000);
  const original = Text.prototype.toString;
  let fullCopies = 0;
  Text.prototype.toString = function () {
    if (this.length >= source.length) fullCopies++;
    return original.call(this);
  };
  try {
    const state = EditorState.create({ doc: source, extensions: [markdown(), liveCallouts()] });
    assert.deepEqual(renderedCalloutRanges(state), []);
    assert.deepEqual(renderedCalloutRanges(state.update({ changes: { from: source.length, insert: 'y' } }).state), []);
    assert.equal(fullCopies, 0);
  } finally {
    Text.prototype.toString = original;
  }
});

test('multiple actual callouts share one containing-document capture per discovery', () => {
  const source = '> [!note] One\n> First body\n\n> [!tip] Two\n> Second body\n\nAfter';
  const original = Text.prototype.toString;
  let fullCopies = 0;
  Text.prototype.toString = function () {
    if (this.length >= source.length) fullCopies++;
    return original.call(this);
  };
  try {
    const state = EditorState.create({ doc: source, extensions: [markdown(), liveCallouts()] });
    assert.equal(renderedCalloutRanges(state).length, 2);
    assert.equal(fullCopies, 1);
    const edited = state.update({ changes: { from: 0, insert: 'Prefix\n\n' } }).state;
    assert.equal(renderedCalloutRanges(edited).length, 2);
    assert.equal(fullCopies, 2);
    edited.update({ selection: { anchor: edited.doc.length } });
    assert.equal(fullCopies, 2);
  } finally {
    Text.prototype.toString = original;
  }
});

test('mounted callout Bases keep exact document and duplicate occurrence after parse progress and edits', t => {
  const dom = new JSDOM('<!doctype html><body><main></main>', { pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    Text: dom.window.Text, Window: dom.window.Window, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  dom.window.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, toJSON() {} });
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const requests: InlineBaseRequest[] = [];
  const block = '> [!note] Base\n> ```base\n> views: []\n> ```';
  let source = block + '\n\n' + block + '\n\n' + 'Plain paragraph.\n\n'.repeat(4000) + '> [!tip] Parsed later\n> Body\n\nAfter';
  let view: EditorView | undefined;
  t.after(() => {
    view?.destroy(); dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  });
  view = new EditorView({ parent: document.querySelector('main')!, state: EditorState.create({ doc: source,
    extensions: [markdown(), liveCallouts({ renderBase: request => {
      requests.push(request);
      const element = document.createElement('div'); element.textContent = request.source;
      return { dom: element, destroy() {} };
    } })] }) });
  assert.equal(forceParsing(view, view.state.doc.length, 2000), true);
  const verify = () => {
    assert.equal(renderedCalloutRanges(view!.state).length, 3);
    const current = requests.slice(-2);
    assert.equal(current.length, 2);
    assert.deepEqual(current.map(request => request.from), [source.indexOf('> ```base'), source.lastIndexOf('> ```base')]);
    for (const request of current) {
      assert.equal(request.documentText, source);
      assert.equal(source.slice(request.from, request.to), '> ```base\n> views: []\n> ```');
      assert.equal(request.source, 'views: []\n');
    }
  };
  verify();
  const before = requests.length;
  view.dispatch({ changes: { from: 0, insert: 'Prefix\n\n' } });
  source = 'Prefix\n\n' + source;
  assert.equal(forceParsing(view, view.state.doc.length, 2000), true);
  assert.ok(requests.length >= before + 2, 'containing-document changes remount both exact occurrences');
  verify();
});
