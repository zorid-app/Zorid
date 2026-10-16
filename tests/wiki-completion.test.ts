import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { CompletionContext, completionStatus, currentCompletions, selectedCompletionIndex, startCompletion } from '@codemirror/autocomplete';
import { wikiCompletion, wikiCompletionSource } from '../src/editor/wiki-completion.ts';
import type { WikiCompletionOptions } from '../src/editor/wiki-completion.ts';

const files: WikiCompletionOptions = {
  paths: () => ['Projects/Alpha.md', 'Beta.md', 'Photo.png'], sourcePath: () => 'Source.md',
  metadata: path => path === 'Projects/Alpha.md' ? { mtime: 20, aliases: ['First'], headings: [{ heading: 'Overview', level: 1 }, { heading: 'Details', level: 2 }], blocks: [{ id: 'one', text: 'A paragraph' }] } : { mtime: 10 },
};
function documentAt(marked: string) {
  const pos = marked.indexOf('¦'); assert.notEqual(pos, -1);
  return { doc: marked.replace('¦', ''), selection: { anchor: pos } };
}
async function result(marked: string, options = files) {
  const initial = documentAt(marked);
  let state = EditorState.create({ ...initial, extensions: [markdown()] });
  const results = await wikiCompletionSource(options)(new CompletionContext(state, state.selection.main.head, false));
  const view = { get state() { return state; }, composing: false, focus() {}, dispatch(spec: Parameters<EditorState['update']>[0]) { state = state.update(spec).state; } } as unknown as EditorView;
  return { results, view, get state() { return state; }, choose(label: string) {
    const option = results?.options.find(item => item.label === label); assert.ok(option, label); assert.equal(typeof option.apply, 'function');
    if (typeof option.apply === 'function') option.apply(view, option, results!.from, results!.to!);
  } };
}

test('file suggestions include attachments, aliases, folder notes and modification ordering', async () => {
  const { results } = await result('[[¦');
  assert.deepEqual(results?.options.map(item => item.label), ['Alpha', 'First', 'Beta', 'Photo.png']);
  assert.equal(results?.filter, false);
});

test('accept inserts closing delimiters once and places caret after them', async () => {
  for (const [input, expected] of [['[[Al¦', '[[Alpha]]'], ['[[Al¦]] rest', '[[Alpha]] rest'], ['![[Al¦pha]]', '![[Alpha]]']]) {
    const session = await result(input); session.choose('Alpha');
    assert.equal(session.state.doc.toString(), expected);
    assert.equal(session.state.selection.main.head, expected.indexOf(']]') + 2);
  }
});

test('replacement consumes only its closing link and retains an existing display alias', async () => {
  const session = await result('before [[Al¦|Already written]] after [[Beta]]'); session.choose('Alpha');
  assert.equal(session.state.doc.toString(), 'before [[Alpha|Already written]] after [[Beta]]');
  assert.equal(session.state.selection.main.head, 32);
});

test('alias and ambiguous paths use valid destination and display text', async () => {
  const alias = await result('[[Fi¦]]'); alias.choose('First'); assert.equal(alias.state.doc.toString(), '[[Alpha|First]]');
  const duplicate = await result('[[Al¦]]', { paths: () => ['A/Alpha.md', 'B/Alpha.md'] });
  duplicate.choose('Alpha'); assert.equal(duplicate.state.doc.toString(), '[[A/Alpha|Alpha]]');
});

test('link text policy callback is used for insertion and attachment extensions are retained', async () => {
  const session = await result('[[Al¦]]', { ...files, linkText: path => `../${path.replace(/\.md$/, '')}` });
  session.choose('Alpha'); assert.equal(session.state.doc.toString(), '[[../Projects/Alpha|Alpha]]');
  const attachment = await result('![[Pho¦]]'); attachment.choose('Photo.png'); assert.equal(attachment.state.doc.toString(), '![[Photo.png]]');
});

test('display mode suggests aliases and retains unmatched user display text', async () => {
  const alias = await result('[[Alpha|Fi¦]]'); alias.choose('First'); assert.equal(alias.state.doc.toString(), '[[Alpha|First]]');
  const typed = await result('[[Alpha|My label¦]]'); typed.choose('My label'); assert.equal(typed.state.doc.toString(), '[[Alpha|My label]]');
});

test('local and global headings and existing block IDs have bounded insertion support', async () => {
  const local = await result('[[Alpha#O¦]]'); local.choose('Overview'); assert.equal(local.state.doc.toString(), '[[Alpha#Overview]]');
  const global = await result('[[##Det¦]]'); global.choose('Details'); assert.equal(global.state.doc.toString(), '[[Alpha#Details]]');
  const block = await result('[[Alpha^par¦]]'); block.choose('A paragraph'); assert.equal(block.state.doc.toString(), '[[Alpha#^one]]');
  const nested = await result('[[Alpha#Overview#De¦]]'); nested.choose('Details'); assert.equal(nested.state.doc.toString(), '[[Alpha#Overview#Details]]');
});

test('unmatched query stays available as a raw link and result count is bounded', async () => {
  const session = await result('[[New note¦]]'); session.choose('No match found'); assert.equal(session.state.doc.toString(), '[[New note]]');
  const many = await result('[[¦', { paths: () => Array.from({ length: 150 }, (_, i) => `${i}.md`) }); assert.equal(many.results?.options.length, 100);
});

test('suggestions refresh metadata and exclude ignored files only for empty queries', async () => {
  let mtime = 1;
  const options = { paths: () => ['A.md', 'B.md', 'Hidden.md'], metadata: (path: string) => ({ mtime: path === 'A.md' ? mtime : 5, ignored: path === 'Hidden.md' }) };
  assert.deepEqual((await result('[[¦', options)).results?.options.map(item => item.label), ['B', 'A']);
  mtime = 10; assert.equal((await result('[[¦', options)).results?.options[0].label, 'A');
  assert.equal((await result('[[Hid¦', options)).results?.options[0].label, 'Hidden');
});

test('completion does not trigger outside an open same-line link or in parsed code', async () => {
  for (const input of ['plain¦', '[[Alpha]]¦', '[[\nAl¦', '`[[Al¦`', '```\n[[Al¦\n```', '[[Photo.png|20¦]]']) assert.equal((await result(input)).results, null, input);
  const state = EditorState.create({ doc: '[[Alpha', selection: EditorSelection.range(2, 7) });
  assert.equal(await wikiCompletionSource(files)(new CompletionContext(state, 7, false)), null);
});

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'completion update timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function setup(t: TestContext, marked: string, options = files) {
  const dom = new JSDOM('<!doctype html><body><main></main>', { pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, Text: dom.window.Text, Window: dom.window.Window,
    MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} });
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const view = new EditorView({ parent: document.querySelector('main')!, state: EditorState.create({ ...documentAt(marked), extensions: [markdown(), history(), wikiCompletion(options), keymap.of([{ key: 'Enter', run(view) { view.dispatch(view.state.replaceSelection('\n')); return true; } }])] }) });
  view.focus();
  t.after(() => { view.destroy(); dom.window.close(); for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  return { view, dom, async open() { startCompletion(view); await until(() => completionStatus(view.state) === 'active' && !!view.dom.querySelector('.wiki-suggestion-instructions')); await Promise.resolve(); }, key(key: string, shiftKey = false) {
    const event = new dom.window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }); view.contentDOM.dispatchEvent(event); return event.defaultPrevented;
  } };
}

test('blank popup starts unselected; arrows wrap; Enter consumes selected completion', async t => {
  const { view, open, key } = setup(t, '[[¦]]'); await open();
  assert.equal(selectedCompletionIndex(view.state), null);
  assert.ok(key('Enter')); assert.equal(view.state.doc.toString(), '[[]]');
  assert.ok(key('ArrowUp')); assert.equal(selectedCompletionIndex(view.state), 3);
  assert.ok(key('ArrowDown')); assert.equal(selectedCompletionIndex(view.state), 0);
  assert.ok(key('Enter')); assert.equal(view.state.doc.toString(), '[[Alpha]]'); assert.equal(view.state.selection.main.head, 9);
  assert.ok(undo(view)); assert.equal(view.state.doc.toString(), '[[]]');
});

test('nonempty popup selects first; Tab keeps caret inside and selects alias', async t => {
  const { view, open, key } = setup(t, '[[Fi¦]]'); await open(); assert.equal(selectedCompletionIndex(view.state), 0);
  assert.ok(key('Tab')); assert.equal(view.state.doc.toString(), '[[Alpha|First]]');
  assert.equal(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to), 'First');
});

test('Tab without alias leaves caret before closing pair; Shift-Enter accepts raw query', async t => {
  const { view, open, key } = setup(t, '[[Al¦]]'); await open(); assert.ok(key('Tab')); assert.equal(view.state.selection.main.head, 7);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '[[Al]]' }, selection: { anchor: 4 } });
  await open(); assert.ok(key('Enter', true)); assert.equal(view.state.doc.toString(), '[[Al]]'); assert.equal(view.state.selection.main.head, 6);
});

test('hash acceptance continues inside heading query and Escape leaves text untouched', async t => {
  const { view, open, key } = setup(t, '[[Al¦]]'); await open(); assert.ok(key('#'));
  assert.equal(view.state.doc.toString(), '[[Alpha#]]'); assert.equal(view.state.selection.main.head, 8);
  await until(() => completionStatus(view.state) === 'active'); assert.ok(key('Escape')); assert.equal(completionStatus(view.state), null);
  assert.equal(view.state.doc.toString(), '[[Alpha#]]');
});

test('popup hover selects, mousedown retains text/focus, click accepts the hovered row', async t => {
  const { view, dom, open } = setup(t, '[[¦]]'); await open();
  const popup = view.dom.querySelector('.cm-wiki-completion')!;
  assert.equal(popup.querySelector('.wiki-suggestion-title')?.textContent, 'Alpha');
  assert.equal(popup.querySelector('.wiki-suggestion-note')?.textContent, 'Projects/');
  const beta = [...popup.querySelectorAll('[role="option"]')].find(row => row.querySelector('.wiki-suggestion-title')?.textContent === 'Beta')!;
  beta.dispatchEvent(new dom.window.MouseEvent('mousemove', { bubbles: true })); assert.equal(selectedCompletionIndex(view.state), 2);
  beta.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true })); assert.equal(view.state.doc.toString(), '[[]]'); assert.ok(view.hasFocus);
  beta.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); assert.equal(view.state.doc.toString(), '[[Beta]]'); assert.equal(view.state.selection.main.head, 8);
});

test('typing opens completion without explicit start and filters after further typing', async t => {
  const { view } = setup(t, '¦');
  for (const text of ['[', '[']) view.dispatch({ ...view.state.replaceSelection(text), userEvent: 'input.type' });
  await until(() => completionStatus(view.state) === 'active');
  view.dispatch({ ...view.state.replaceSelection('Be'), userEvent: 'input.type' });
  await until(() => currentCompletions(view.state)[0]?.label === 'Beta');
});


test('completion within destination preserves explicit suffix alias over generated and metadata aliases', async () => {
  for (const [input, label, options, expected] of [
    ['[[Al¦pha|Already written]]', 'Alpha', files, '[[Alpha|Already written]]'],
    ['[[Al¦|Already written]]', 'Alpha', { paths: () => ['A/Alpha.md', 'B/Alpha.md'] }, '[[A/Alpha|Already written]]'],
    ['[[Fi¦rst|Explicit]]', 'First', files, '[[Alpha|Explicit]]'],
    ['[[Al¦pha|]]', 'Alpha', { paths: () => ['A/Alpha.md', 'B/Alpha.md'] }, '[[A/Alpha|]]'],
  ] as const) {
    const session = await result(input, options); session.choose(label);
    assert.equal(session.state.doc.toString(), expected);
    assert.equal(session.state.selection.main.head, expected.length);
  }
});

test('suffix alias extraction never crosses another link or line boundary', async () => {
  for (const [input, expected] of [
    ['[[Al¦ [[Beta|Other]]', '[[Alpha]] [[Beta|Other]]'],
    ['[[Al¦\n[[Beta|Other]]', '[[Alpha]]\n[[Beta|Other]]'],
    ['[[Al¦pha|Mine]] after [[Beta|Other]]', '[[Alpha|Mine]] after [[Beta|Other]]'],
  ]) {
    const session = await result(input); session.choose('Alpha');
    assert.equal(session.state.doc.toString(), expected);
  }
});

test('late-document fenced and inline code are excluded even when initial parse is incomplete', async () => {
  const prefix = 'plain\n\n'.repeat(2000);
  for (const tail of ['```\n[[Al¦\n```', '`[[Al¦`']) assert.equal((await result(prefix + tail)).results, null);
  const state = EditorState.create(documentAt('[[Al¦'));
  assert.equal(await wikiCompletionSource(files)(new CompletionContext(state, state.selection.main.head, false)), null, 'no parser cannot establish safe syntax context');
});

test('Tab selects an explicit suffix alias after replacing a partial target', async t => {
  const { view, open, key } = setup(t, '[[Al¦ph|Already written]]'); await open();
  assert.ok(key('Tab'));
  assert.equal(view.state.doc.toString(), '[[Alpha|Already written]]');
  assert.equal(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to), 'Already written');
  assert.ok(undo(view)); assert.equal(view.state.doc.toString(), '[[Alph|Already written]]');
});
