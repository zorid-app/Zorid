import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Compartment, EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { history, redo, undo } from '@codemirror/commands';
import { openSearchPanel, search, SearchQuery, setSearchQuery } from '@codemirror/search';
import { liveCallouts, parseCalloutHeader, renderedCalloutRanges } from '../src/editor/live-callouts.ts';
import type { LiveCalloutOptions } from '../src/editor/live-callouts.ts';
import { liveProperties } from '../src/editor/live-properties.ts';

function setup(t: TestContext, source: string, options: LiveCalloutOptions = {}) {
  const dom = new JSDOM('<!doctype html><body><main></main><button id="outside">Outside</button>', { pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Text: dom.window.Text, Window: dom.window.Window,
    MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  dom.window.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, toJSON() {} });
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const observer = { observed: 0, disconnected: 0 };
  Object.defineProperty(dom.window, 'ResizeObserver', { value: class { observe() { observer.observed++; } disconnect() { observer.disconnected++; } } });
  const readonly = new Compartment(), opened: string[] = [];
  const view = new EditorView({ parent: document.querySelector('main')!, state: EditorState.create({ doc: source, extensions: [
    markdown({ base: markdownLanguage, addKeymap: false }), liveProperties(), history(), search(), EditorState.allowMultipleSelections.of(true),
    readonly.of(EditorState.readOnly.of(false)), liveCallouts({ ...options, open: target => opened.push(target) }),
  ] }) });
  let disposed = false;
  const destroy = () => { if (!disposed) { disposed = true; view.destroy(); } };
  t.after(() => { destroy(); dom.window.close(); for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  const click = (target: Element, extra: MouseEventInit = {}) => { const event = new dom.window.MouseEvent('click', { button: 0, bubbles: true, cancelable: true, ...extra }); target.dispatchEvent(event); return event; };
  const focusAt = async (position: number) => { view.dispatch({ selection: { anchor: position } }); view.focus(); await Promise.resolve(); };
  return { dom, view, readonly, opened, observer, click, focusAt, destroy };
}
const note = 'Before\n\n> [!note] **Title**\n> Body with [[Target|label]].\n\nAfter';

test('callout header accepts metadata/fold markers and normalizes custom types', () => {
  assert.deepEqual(parseCalloutHeader('[! Custom Type |meta]- A title'), { type: 'custom-type', metadata: 'meta', fold: '-', title: 'A title' });
  assert.deepEqual(parseCalloutHeader('[!note]+'), { type: 'note', metadata: '', fold: '+', title: '' });
  for (const text of ['[!note]title', '[!note] + title', '[!] title', '\\[!note] title']) {
    if (text === '[!note] + title') assert.equal(parseCalloutHeader(text)?.fold, ''); else assert.equal(parseCalloutHeader(text), null);
  }
});

test('inactive callouts render type/title/icon/body safely and route links', t => {
  const { view, click, opened } = setup(t, note);
  const callout = view.dom.querySelector<HTMLElement>('.callout')!;
  assert.equal(callout.dataset.callout, 'note'); assert.equal(callout.querySelector('strong')?.textContent, 'Title');
  assert.ok(callout.querySelector('.callout-icon svg')); assert.match(callout.querySelector('.callout-content')!.textContent!, /Body with label/);
  click(callout.querySelector('a')!); assert.deepEqual(opened, ['Target']);
  assert.equal(view.state.doc.toString(), note); assert.equal(renderedCalloutRanges(view.state).length, 1);
  assert.deepEqual(renderedCalloutRanges(EditorState.create()), []);
});

test('nested quotes/callouts, lists and fences retain block ownership', t => {
  const source = '> [!warning|wide]+ Outer\n> - item\n>   > [!tip]- Inner\n>   > nested\n>\n> > ordinary **quote**\n>\n> ```md\n> > [!danger] literal\n> ```\n\nEnd';
  const { view } = setup(t, source), callouts = view.dom.querySelectorAll('.callout');
  assert.equal(callouts.length, 2); assert.equal((callouts[0] as HTMLElement).dataset.calloutMetadata, 'wide');
  assert.equal(callouts[1].querySelector('.callout-title-inner')?.textContent, 'Inner');
  assert.equal(callouts[1].querySelector<HTMLElement>('.callout-content')?.hidden, true);
  assert.equal(view.dom.querySelector('blockquote strong')?.textContent, 'quote');
  assert.equal(view.dom.querySelector('pre code')?.textContent, '> [!danger] literal');
  assert.ok(view.dom.querySelector('.callout-content ul li'));
});

test('folding is local view state, respects title links, and persists through source reveal', async t => {
  const source = '> [!note]- [Title](https://example.com)\n> Content\n\nAfter';
  const { view, click, focusAt, opened } = setup(t, source);
  let callout = view.dom.querySelector('.callout')!, fold = callout.querySelector('button')!;
  assert.equal(callout.classList.contains('is-collapsed'), true);
  click(callout.querySelector('a')!); assert.deepEqual(opened, []); assert.equal(callout.querySelector('a')?.getAttribute('href'), 'https://example.com'); assert.equal(callout.classList.contains('is-collapsed'), true);
  click(fold); assert.equal(callout.classList.contains('is-collapsed'), false); assert.equal(fold.getAttribute('aria-expanded'), 'true');
  assert.equal(view.state.doc.toString(), source); assert.equal(undo(view), false);
  await focusAt(5); assert.equal(view.dom.querySelector('.cm-live-callout'), null);
  await focusAt(source.length); callout = view.dom.querySelector('.callout')!;
  assert.equal(callout.classList.contains('is-collapsed'), false);
});

test('selection reveals complete source, edit action maps after prefix edits, and typing is undoable', async t => {
  const { view, click, focusAt } = setup(t, note);
  const original = view.dom.querySelector('.cm-live-callout')!;
  view.dispatch({ changes: { from: 0, insert: 'Prefix\n' } });
  assert.equal(view.dom.querySelector('.cm-live-callout'), original);
  click(original.querySelector('.cm-callout-edit')!);
  assert.equal(view.dom.querySelector('.cm-live-callout'), null);
  assert.equal(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to), note.slice(note.indexOf('>'), note.indexOf('\n\nAfter')));
  const title = view.state.doc.toString().indexOf('Title'); view.dispatch({ changes: { from: title, to: title + 5, insert: 'Changed' }, selection: { anchor: title + 7 }, userEvent: 'input.type' });
  await focusAt(view.state.doc.length); assert.equal(view.dom.querySelector('.callout-title-inner')?.textContent, 'Changed');
  assert.equal(undo(view), true); assert.match(view.state.doc.toString(), /\*\*Title\*\*/); assert.equal(redo(view), true);
});

test('multiple cursors/search reveal callouts and source-like examples remain literal', async t => {
  const source = '> [!info] One\n> body\n\n> [!tip] Two\n> other\n\n```md\n> [!danger] code\n```\n\n\\> [!note] escaped\n\nEnd';
  const { view, focusAt } = setup(t, source);
  assert.equal(view.dom.querySelectorAll('.cm-live-callout').length, 2);
  await focusAt(source.length);
  view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(4), EditorSelection.cursor(source.indexOf('Two'))]) });
  assert.equal(renderedCalloutRanges(view.state).length, 0);
  await focusAt(source.length); openSearchPanel(view); view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'other' })) });
  assert.equal(view.dom.querySelectorAll('.cm-live-callout').length, 1);
  assert.equal(view.dom.querySelector('.callout-title-inner')?.textContent, 'One');
});

test('pointer selection freezes replacement geometry until release then uses latest selection', async t => {
  const { view, dom, focusAt } = setup(t, note); await focusAt(0);
  const widget = view.dom.querySelector('.cm-live-callout')!;
  view.contentDOM.dispatchEvent(new dom.window.MouseEvent('mousedown', { button: 0, bubbles: true }));
  view.dispatch({ selection: { anchor: note.indexOf('Body') } });
  assert.equal(view.dom.querySelector('.cm-live-callout'), widget);
  dom.window.document.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 65)); assert.equal(view.dom.querySelector('.cm-live-callout'), null);
});

test('checkbox edits use original quoted source lines, parent history and readonly owner', async t => {
  const source = '> [!todo] Work\n> - [ ] first\n> > [!note] Nested\n> > - [x] second\n\nEnd';
  const { view, click, readonly } = setup(t, source);
  click(view.dom.querySelectorAll('input')[1]); assert.equal(view.state.doc.toString(), source.replace('[x]', '[ ]'));
  assert.equal(undo(view), true); await Promise.resolve(); assert.equal(view.state.doc.toString(), source);
  view.dispatch({ effects: readonly.reconfigure(EditorState.readOnly.of(true)) });
  assert.ok([...view.dom.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].every(input => input.disabled));
  click(view.dom.querySelector('input')!); assert.equal(view.state.doc.toString(), source);
});

test('caret motion outside cached callouts does not reparse or recreate their content', async t => {
  let mounted = 0, released = 0;
  const { view, focusAt } = setup(t, '> [!note] Media\n> ![[image.png]]\n\nOutside', { renderEmbed: () => { mounted++; return { dom: document.createElement('img'), destroy() { released++; } }; } });
  await focusAt(view.state.doc.length); const widget = view.dom.querySelector('.cm-live-callout');
  const parser = markdownLanguage.parser, parse = parser.parse; let parsed = 0;
  parser.parse = function(...args) { parsed++; return parse.apply(this, args); };
  try { for (let index = 0; index < 15; index++) view.dispatch({ selection: { anchor: view.state.doc.length - index % 4 } }); }
  finally { parser.parse = parse; }
  assert.equal(parsed, 0); assert.equal(mounted, 1); assert.equal(released, 0); assert.equal(view.dom.querySelector('.cm-live-callout'), widget);
});

test('teardown cancels pending source selection and releases observers/embedded children once', async t => {
  let released = 0;
  const { view, click, destroy, observer } = setup(t, '> [!note] Media\n> ![[image.png]]\n\nEnd', { renderEmbed: () => ({ dom: document.createElement('img'), destroy() { released++; } }) });
  click(view.dom.querySelector('.callout-content p')!); destroy(); destroy();
  await new Promise(resolve => setTimeout(resolve, 170));
  assert.equal(released, 1); assert.equal(observer.observed, 1); assert.equal(observer.disconnected, 1);
});


test('unknown/prototype-like types use safe default icons and title HTML stays literal', t => {
  const { view } = setup(t, '> [!constructor] <img src=x onerror=alert(1)>\n> [bad](javascript:alert(1))\n\n> [!__proto__]\n> safe\n\nEnd');
  assert.equal(view.dom.querySelectorAll('.callout').length, 2);
  assert.equal(view.dom.querySelectorAll('.callout-icon svg').length, 2);
  assert.equal(view.dom.querySelector('.callout-title-inner img'), null);
  assert.match(view.dom.querySelector('.callout-title-inner')!.textContent!, /<img/);
  assert.equal(view.dom.querySelector('.callout-content a')?.hasAttribute('href'), false);
});

test('title folding waits for link/default handlers and stale DOM controls cannot edit replacement source', async t => {
  const source = '> [!tip]+ Title\n> - [ ] task\n\nEnd';
  const { view, click } = setup(t, source);
  const title = view.dom.querySelector<HTMLElement>('.callout-title')!, task = view.dom.querySelector('input')!, edit = view.dom.querySelector('.cm-callout-edit')!;
  title.addEventListener('click', event => event.preventDefault(), { once: true }); click(title);
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(view.dom.querySelector('.callout')!.classList.contains('is-collapsed'), false);
  click(title); await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(view.dom.querySelector('.callout')!.classList.contains('is-collapsed'), true);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'Replacement' } });
  click(task); click(edit); await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(view.state.doc.toString(), 'Replacement'); assert.equal(view.state.selection.main.empty, true);
});

test('frontmatter, fenced examples and ordinary quoted marker text do not become callout widgets', t => {
  const source = '---\nexample: "> [!note] yaml"\n---\n\n```md\n> [!note] fenced\n```\n\n> ordinary\n> [!note] later paragraph\n\nEnd';
  const { view } = setup(t, source);
  assert.equal(view.dom.querySelector('.cm-live-callout'), null);
  assert.deepEqual(renderedCalloutRanges(view.state), []);
});

test('modified body clicks preserve rendered source and current selection', async t => {
  const { view, click } = setup(t, note);
  const body = view.dom.querySelector('.callout-content p')!;
  for (const modifier of ['shiftKey', 'ctrlKey', 'metaKey', 'altKey']) click(body, { [modifier]: true });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(view.state.selection.main.head, 0); assert.ok(view.dom.querySelector('.cm-live-callout'));
});

test('delayed text activation yields to a newer selection but maps unrelated prefix edits', async t => {
  const { view, dom, click, focusAt } = setup(t, note); await focusAt(0);
  dom.window.Range.prototype.getClientRects = () => Object.assign([{ left: 0, right: 20, top: 0, bottom: 20 }], { item: () => null }) as unknown as DOMRectList;
  click(view.dom.querySelector('.callout-content p')!, { clientX: 10, clientY: 10 });
  await focusAt(note.length);
  await new Promise(resolve => setTimeout(resolve, 170));
  assert.equal(view.state.selection.main.head, note.length); assert.ok(view.dom.querySelector('.cm-live-callout'));
  click(view.dom.querySelector('.callout-content p')!, { clientX: 10, clientY: 10 });
  view.dispatch({ changes: { from: 0, insert: 'Prefix\n' } });
  await new Promise(resolve => setTimeout(resolve, 170));
  assert.equal(view.state.selection.main.head, note.indexOf('>') + 7);
  assert.equal(view.state.selection.main.anchor, note.indexOf('\n\nAfter') + 7);
});

test('search matches crossing a callout boundary reveal the complete source', async t => {
  const { view, focusAt } = setup(t, note); await focusAt(0);
  openSearchPanel(view); view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'label]].\n\nAfter' })) });
  assert.equal(renderedCalloutRanges(view.state).length, 0);
  view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'Before\n\n> [!note]' })) });
  assert.equal(renderedCalloutRanges(view.state).length, 0);
});

test('a failed later embed releases children already mounted during callout construction', t => {
  let mounted = 0, released = 0;
  const { view, destroy } = setup(t, '> [!note] Embeds\n> ![[one.png]] ![[two.png]]\n\nEnd', { renderEmbed() {
    if (++mounted === 2) throw new Error('Expected failed second embed');
    return { dom: document.createElement('span'), destroy() { released++; } };
  } });
  assert.equal(mounted, 2); assert.equal(released, 1);
  assert.match(view.dom.querySelector('.callout-source-fallback')!.textContent!, /two.png/);
  destroy(); assert.equal(released, 1);
});

test('deep callout nesting bounds recursive parsing and keeps the remaining source visible', t => {
  let source = 'Tail content'; for (let depth = 0; depth < 80; depth++) source = '> [!note] Level\n> ' + source.replace(/\n/g, '\n> ');
  const parse = markdownLanguage.parser.parse; let calls = 0, units = 0;
  const { view } = setup(t, 'Outside');
  markdownLanguage.parser.parse = function(input, ...rest) { calls++; if (typeof input === 'string') units += input.length; return parse.call(this, input, ...rest); };
  try { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source } }); }
  finally { markdownLanguage.parser.parse = parse; }
  assert.ok(calls <= 32, `Nested parse count ${calls}`);
  assert.ok(units <= Math.min(1_000_000, Math.max(32_768, source.length * 8)), `Nested parsed units ${units}`);
  assert.match(view.dom.querySelector('.callout-source-fallback')!.textContent!, /Tail content/);
});

test('one throwing embed disposer does not skip sibling resources or retry cleanup', t => {
  let mounted = 0; const released: number[] = [];
  const { destroy } = setup(t, '> [!note] Embeds\n> ![[one.png]] ![[two.png]]\n\nEnd', { renderEmbed() {
    const id = ++mounted; return { dom: document.createElement('span'), destroy() { released.push(id); if (id === 2) throw new Error('Expected disposer failure'); } };
  } });
  destroy(); destroy(); assert.deepEqual(released.sort(), [1, 2]);
});
