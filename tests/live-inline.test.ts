import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { history, undo } from '@codemirror/commands';
import { openSearchPanel, search, SearchQuery, setSearchQuery } from '@codemirror/search';
import { forceParsing, syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import { liveInline, liveInlineMarkdown, refreshLiveInline } from '../src/editor/live-inline.ts';
import type { LiveInlineOptions } from '../src/editor/live-inline.ts';

// Real editor state, parsing, DOM and event routing. Geometry stubs only let
// jsdom run CodeMirror; these tests do not measure browser pointer hit testing.
function setup(t: TestContext, source: string, options: LiveInlineOptions = {}, parseControl?: { paused: boolean }, visible?: { from: number; to: number }[]) {
  const dom = new JSDOM('<!doctype html><html><body><main></main><button id="outside">Outside</button></body></html>', { pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    Text: dom.window.Text, Window: dom.window.Window, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const rect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
  dom.window.Range.prototype.getBoundingClientRect = rect;
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const opened: { target: string; kind: string; button: number; ctrl: boolean; meta: boolean; shift: boolean }[] = [];
  const transactions: Transaction[] = [];
  class TestEditorView extends EditorView {
    get visibleRanges() { return visible ?? super.visibleRanges; }
  }
  const view = new TestEditorView({ parent: document.querySelector('main')!, state: EditorState.create({ doc: source,
    extensions: [markdown({ base: markdownLanguage, addKeymap: false, extensions: [liveInlineMarkdown, {
      wrap(inner) {
        if (!parseControl) return inner;
        // A stopped partial parse must still finish at its current position:
        // CodeMirror's takeTree() relies on that PartialParse contract.
        return { advance: () => parseControl.paused && (inner.stoppedAt == null || inner.stoppedAt > inner.parsedPos) ? null : inner.advance(),
          get parsedPos() { return inner.parsedPos; },
          get stoppedAt() { return inner.stoppedAt; }, stopAt: position => inner.stopAt(position) };
      },
    }] }),
      liveInline({ ...options, open(target, kind, event) { opened.push({ target, kind, button: event.button, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey }); } }),
      history(), search(), EditorState.allowMultipleSelections.of(true),
      EditorView.updateListener.of(update => transactions.push(...update.transactions))] }) });
  let destroyed = false;
  const destroy = () => { if (!destroyed) { view.destroy(); destroyed = true; } };
  t.after(() => {
    destroy(); dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const line = (index: number) => [...view.contentDOM.querySelectorAll<HTMLElement>('.cm-line')][index];
  const cursor = (position: number) => view.dispatch({ selection: { anchor: position } });
  const click = (target: Element, options: MouseEventInit = {}) => {
    const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...options });
    target.dispatchEvent(event); return event;
  };
  const down = (target: Element) => {
    const event = new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    // The selection transaction is supplied explicitly below because jsdom
    // has no caret geometry; the capture-phase interaction listener still runs.
    event.preventDefault(); target.dispatchEvent(event);
  };
  const up = () => document.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true, button: 0 }));
  return { dom, view, opened, transactions, destroy, line, cursor, click, down, up };
}

test('inactive nested emphasis, code, strike, highlights and escapes render from syntax', t => {
  const source = '***one*** __two *three*__ ~~four **five**~~ ==six *seven*==\n`**code**` \\*literal\\*\nplain';
  const { view, line } = setup(t, source);
  assert.equal(line(0).textContent, 'one two three four five six seven');
  assert.equal(line(0).querySelector('.cm-live-emphasis .cm-strong')?.textContent, 'one');
  assert.equal(line(0).querySelector('.cm-strike .cm-strong')?.textContent, 'five');
  assert.equal(line(0).querySelector('.cm-highlight .cm-live-emphasis')?.textContent, 'seven');
  assert.equal(line(1).textContent, '**code** *literal*');
  assert.equal(line(1).querySelector('.cm-live-code')?.textContent, '**code**');
  assert.equal(view.state.doc.toString(), source);
});

test('focused selections reveal token groups while unrelated same-line tokens stay rendered', t => {
  const source = '**first *nested*** and **second**\nplain';
  const { view, line, cursor } = setup(t, source);
  view.focus(); cursor(source.indexOf('nested'));
  assert.equal(line(0).textContent, '**first *nested*** and second');
  cursor(source.indexOf('second'));
  assert.equal(line(0).textContent, 'first nested and **second**');
  view.contentDOM.blur(); cursor(source.length);
  assert.equal(line(0).textContent, 'first nested and second');
});

test('all focused selections and inclusive token boundaries reveal source without remapping', t => {
  const source = '*one* **two** ~~three~~\nplain';
  const { view, line } = setup(t, source);
  view.focus();
  const selection = EditorSelection.create([EditorSelection.cursor(0), EditorSelection.range(source.indexOf('three') + 3, source.indexOf('three'))], 1);
  view.dispatch({ selection });
  assert.equal(line(0).textContent, '*one* two ~~three~~');
  assert.ok(view.state.selection.eq(selection));
  const edge = source.indexOf('**two**') + '**two**'.length;
  view.dispatch({ selection: { anchor: edge } });
  assert.equal(line(0).textContent, 'one **two** three');
  assert.equal(view.state.selection.main.head, edge);
});

test('ATX and setext headings retain source and reveal markers on the active heading', t => {
  const source = '# *Title* #\n\nSecond\n======\n\nplain';
  const { view, line, cursor } = setup(t, source);
  assert.equal(line(0).textContent, 'Title ');
  assert.ok(line(0).classList.contains('cm-heading-1'));
  assert.ok(line(2).classList.contains('cm-heading-1'));
  assert.equal(line(3).textContent, '');
  view.focus(); cursor(3);
  assert.equal(line(0).textContent, '# *Title* #');
  cursor(source.length);
  assert.equal(line(0).textContent, 'Title ');
  assert.equal(view.state.doc.toString(), source);
});

test('complete wikilinks and Markdown labels render; incomplete and unsupported references remain literal', t => {
  const source = '[[cafe\u0301 note#Heading|雪 😀]] [**Bold** *label*](<folder/a b.md> "title")\n[[unfinished [ref][id] [^note] `unterminated';
  const { view, line } = setup(t, source);
  assert.equal(line(0).textContent, '雪 😀 Bold label');
  assert.equal(line(0).querySelectorAll('.cm-live-inline-link').length, 2);
  assert.equal(line(1).textContent, '[[unfinished [ref][id] [^note] `unterminated');
  assert.equal(view.contentDOM.querySelector('a'), null);
});

test('code blocks, HTML, images, tables and frontmatter keep their separate syntax ownership', t => {
  const source = '---\nvalue: "**raw**"\n---\n\n```md\n# **code** [[Note]]\n```\n\n    **indented**\n\n| a | b |\n| - | - |\n| **cell** | x |\n\n![[image]] ![alt](file.png)\n<img src=x onerror="bad()">\n**real**';
  const { view } = setup(t, source);
  assert.deepEqual([...view.contentDOM.querySelectorAll('.cm-strong')].map(node => node.textContent), ['real']);
  // CodeMirror may create inert img.cm-widgetBuffer caret boundaries itself.
  assert.equal(Boolean(view.contentDOM.querySelector('img[src],img[onerror],script,iframe')), false);
  assert.ok(view.contentDOM.textContent?.includes('![[image]] ![alt](file.png)'));
  assert.ok(view.contentDOM.textContent?.includes('# **code** [[Note]]'));
});

test('comments hide only as complete inline syntax; code and escaped openers remain visible', t => {
  const source = 'before %%[[secret]] **hidden**%% after\n`%%code%%` \\%%literal%%\n%%unfinished\nplain';
  const { view, line, cursor } = setup(t, source);
  assert.equal(line(0).textContent, 'before  after');
  assert.equal(line(1).textContent, '%%code%% %%literal%%');
  assert.equal(line(2).textContent, '%%unfinished');
  view.focus(); cursor(source.indexOf('secret'));
  assert.equal(line(0).textContent, 'before %%[[secret]] **hidden**%% after');
  assert.equal(view.contentDOM.querySelectorAll('.cm-live-inline-link').length, 0);
  assert.ok(syntaxTree(view.state).toString().includes('LiveInlineComment'));
});

test('rendered plain links follow once; revealed syntax requires Ctrl/Meta or middle click', t => {
  const source = '[[Note|Alias]] [web](https://example.com)\nplain';
  const { view, opened, cursor, click, dom } = setup(t, source);
  const link = () => view.contentDOM.querySelector<HTMLElement>('.cm-live-inline-link')!;
  assert.ok(click(link()).defaultPrevented);
  assert.deepEqual(opened.map(item => [item.target, item.kind]), [['Note', 'wiki']]);
  view.focus(); cursor(4);
  assert.equal(link().dataset.liveInlineRendered, 'false');
  assert.equal(click(link()).defaultPrevented, false);
  assert.ok(click(link(), { ctrlKey: true, shiftKey: true }).defaultPrevented);
  assert.ok(click(link(), { metaKey: true }).defaultPrevented);
  const middle = new dom.window.MouseEvent('mousedown', { button: 1, bubbles: true, cancelable: true });
  link().dispatchEvent(middle);
  assert.ok(middle.defaultPrevented);
  assert.deepEqual(opened.map(item => [item.button, item.ctrl, item.meta, item.shift]),
    [[0, false, false, false], [0, true, false, true], [0, false, true, false], [1, false, false, false]]);
});

test('plain Alt/Shift, selections, nested controls and unsafe protocols never follow', t => {
  const source = '[[Note|Alias]] [bad](java&#x73;cript:evil) [data](data:text/html,x)\nplain';
  const { view, opened, click } = setup(t, source);
  const link = view.contentDOM.querySelector<HTMLElement>('.cm-live-inline-link')!;
  assert.equal(click(link, { altKey: true }).defaultPrevented, false);
  assert.equal(click(link, { shiftKey: true }).defaultPrevented, false);
  view.dispatch({ selection: EditorSelection.range(0, 5) });
  assert.equal(click(link).defaultPrevented, false);
  const button = document.createElement('button'); button.textContent = 'nested'; link.append(button);
  assert.equal(click(button, { metaKey: true }).defaultPrevented, false);
  for (const unsafe of view.contentDOM.querySelectorAll('.cm-live-inline-unsafe')) click(unsafe, { ctrlKey: true });
  assert.deepEqual(opened, []);
});

test('link callbacks use current decoded targets after external edits and Unicode normalization', t => {
  const source = '[[cafe\u0301|Label]] [path](folder/a%20b\\(c\\).md)\nplain';
  const { view, opened, click } = setup(t, source);
  click(view.contentDOM.querySelector('.cm-live-inline-link')!);
  assert.equal(opened[0].target, 'café');
  view.dispatch({ changes: { from: 2, to: source.indexOf('|'), insert: 'New' } });
  const links = view.contentDOM.querySelectorAll('.cm-live-inline-link');
  click(links[0]); click(links[1]);
  assert.deepEqual(opened.map(item => item.target), ['café', 'New', 'folder/a b(c).md']);
});

test('pointer capture freezes geometry through release, then reveals latest source selection', async t => {
  const source = '**bold** then *italic*\nplain';
  const { view, line, cursor, down, up } = setup(t, source);
  down(line(0).querySelector('.cm-strong')!); view.focus(); cursor(4);
  assert.equal(line(0).textContent, 'bold then italic');
  up(); cursor(source.indexOf('italic') + 2);
  assert.equal(line(0).textContent, 'bold then italic');
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(line(0).textContent, 'bold then *italic*');
  const position = view.state.selection.main.head;
  view.dispatch({ ...view.state.replaceSelection('!'), annotations: Transaction.userEvent.of('input.type') });
  assert.equal(view.state.doc.toString(), source.slice(0, position) + '!' + source.slice(position));
  assert.ok(undo(view)); assert.equal(view.state.doc.toString(), source);
});

test('composition maps existing decorations and refreshes without replaying selections', async t => {
  const source = '*word*\nplain';
  const { view, dom, line, cursor } = setup(t, source);
  view.contentDOM.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
  view.focus(); cursor(3);
  view.dispatch({ changes: { from: 3, insert: '字' }, selection: { anchor: 4 } });
  assert.equal(line(0).textContent, 'wo字rd');
  view.contentDOM.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }));
  cursor(view.state.doc.length);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(line(0).textContent, 'wo字rd');
  assert.equal(view.state.selection.main.head, view.state.doc.length);
});

test('search matches reveal source while the search field owns focus', t => {
  const { view, line } = setup(t, '**target** and **other**\nplain');
  openSearchPanel(view);
  view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'target' })) });
  assert.equal(line(0).textContent, '**target** and other');
});

test('teardown cancels pending pointer refresh and preserves source-only history', async t => {
  const { view, line, down, up, destroy, transactions } = setup(t, '**word**\nplain');
  down(line(0).querySelector('.cm-strong')!); up();
  const count = transactions.length;
  destroy();
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(transactions.length, count);
  assert.equal(view.state.doc.toString(), '**word**\nplain');
});

test('wikilink resolution uses normalized targets, leaves unknown distinct and refreshes without edits', t => {
  const source = '[[cafe\u0301#Heading|Alias]] [[Missing]] [[#Local]] [external](https://example.test)';
  const resolved = new Set(['café#Heading', '#Local']);
  const queried: [string, string][] = [];
  const { view, line, click, opened } = setup(t, source, { isUnresolved(target, kind) {
    queried.push([target, kind]); return !resolved.has(target);
  } });
  const wiki = () => [...view.contentDOM.querySelectorAll<HTMLElement>('.cm-live-wiki')];
  assert.equal(line(0).textContent, 'Alias Missing Local external');
  assert.deepEqual(queried, [['café#Heading', 'wiki'], ['Missing', 'wiki'], ['#Local', 'wiki']]);
  assert.deepEqual(wiki().map(node => node.dataset.liveInlineResolution), ['resolved', 'unresolved', 'resolved']);
  assert.equal(wiki()[1].classList.contains('is-unresolved'), true);
  click(wiki()[1].querySelector('.cm-live-inline-link')!);
  assert.equal(opened[0].target, 'Missing');
  const before = view.state.selection;
  resolved.add('Missing');
  view.dispatch({ effects: refreshLiveInline.of() });
  assert.equal(wiki()[1].classList.contains('is-unresolved'), false);
  assert.equal(wiki()[1].dataset.liveInlineResolution, 'resolved');
  assert.equal(view.state.doc.toString(), source);
  assert.ok(view.state.selection.eq(before));
  assert.equal(undo(view), false);
});

test('wiki aliases retain faint source punctuation and editable target with no invented title tooltip', t => {
  const source = '[[Note#Heading|Alias]] [[#Local]]\nplain';
  const { view, cursor, line } = setup(t, source);
  const unknown = view.contentDOM.querySelector<HTMLElement>('.cm-live-wiki')!;
  assert.equal(unknown.dataset.liveInlineResolution, 'unknown');
  assert.equal(unknown.classList.contains('is-unresolved'), false);
  assert.equal(Boolean(unknown.querySelector('[title]')), false);
  view.focus(); cursor(source.indexOf('Alias'));
  assert.equal(line(0).textContent, '[[Note#Heading|Alias]] Local');
  assert.deepEqual([...line(0).querySelectorAll('.cm-live-link-marker')].map(node => node.textContent), ['[[', '|', ']]']);
  assert.equal(line(0).querySelector('.cm-live-wiki')?.textContent, 'Note#Heading|Alias');
  assert.equal(line(0).querySelector<HTMLElement>('.cm-live-inline-link')?.dataset.liveInlineRendered, 'false');
  cursor(source.indexOf('Local'));
  assert.equal(line(0).textContent, 'Alias [[#Local]]');
  assert.equal(view.state.doc.toString(), source);
});

test('wiki hover notifies once per entered span using current targets, including revealed source', t => {
  const hovered: { target: string; kind: string; element: HTMLElement; event: MouseEvent }[] = [];
  const { view, cursor, dom } = setup(t, '[[First|Alias]] [external](https://example.test) [[javascript:bad]]\nplain', {
    onHover(target, kind, event, element) { hovered.push({ target, kind, event, element }); },
  });
  const emit = (target: Element, relatedTarget: EventTarget | null = null) => {
    const event = new dom.window.MouseEvent('mouseover', { bubbles: true, cancelable: true, relatedTarget });
    target.dispatchEvent(event); return event;
  };
  const label = view.contentDOM.querySelector('.cm-live-inline-link')!;
  const event = emit(label);
  assert.equal(hovered.length, 1);
  assert.equal(hovered[0].target, 'First');
  assert.equal(hovered[0].kind, 'wiki');
  assert.equal(hovered[0].event, event);
  assert.ok(hovered[0].element.contains(label));
  assert.equal(event.defaultPrevented, false);
  emit(label, label.firstChild);
  emit(view.contentDOM.querySelector('.cm-live-markdown-link')!);
  emit(view.contentDOM.querySelector('.cm-live-inline-unsafe')!);
  assert.equal(hovered.length, 1);
  view.dispatch({ changes: { from: 2, to: 7, insert: 'Second' } });
  view.focus(); cursor(3);
  const source = view.contentDOM.querySelector('.cm-live-wiki')!;
  emit(source);
  assert.equal(hovered.at(-1)?.target, 'Second');
  const button = document.createElement('button'); source.appendChild(button); emit(button);
  assert.equal(hovered.length, 2);
});

test('stylesheet applies theme-controlled link decoration only to rendered labels', t => {
  const { view, cursor } = setup(t, '[[Note|Alias]] [[Missing]]\nplain', { isUnresolved: target => target === 'Missing' });
  const style = document.createElement('style');
  style.textContent = readFileSync(new URL('../src/editor/live-inline.css', import.meta.url), 'utf8');
  document.head.appendChild(style);
  const label = () => view.contentDOM.querySelector('.cm-live-inline-link')!;
  assert.equal(getComputedStyle(label()).textDecorationLine, 'var(--link-decoration, underline)');
  assert.equal(getComputedStyle(label()).textDecorationThickness, 'var(--link-decoration-thickness, auto)');
  assert.equal(getComputedStyle(label()).cursor, 'var(--cursor-link, pointer)');
  const missing = view.contentDOM.querySelector('.is-unresolved')!;
  assert.equal(getComputedStyle(missing.querySelector('.cm-live-inline-link')!).textDecorationStyle, 'var(--link-unresolved-decoration-style, solid)');
  view.focus(); cursor(4);
  assert.equal(getComputedStyle(label()).textDecorationLine, '');
  assert.equal(getComputedStyle(label()).cursor, 'text');
  assert.equal(getComputedStyle(view.contentDOM.querySelector('.cm-live-link-marker')!).color, 'var(--text-faint)');
});

function inlineDecorations(view: EditorView) {
  const ranges: { from: number; to: number; className: string }[] = [];
  for (const provider of view.state.facet(EditorView.decorations)) {
    const decorations = typeof provider === 'function' ? provider(view) : provider;
    decorations.between(0, view.state.doc.length, (from, to, value) => {
      ranges.push({ from, to, className: value.spec.class ?? '' });
    });
  }
  return ranges;
}

// Count public syntax navigation during one synchronous refresh, not wall time
// or parser work. This catches both full-document and full-paragraph scans.
function navigationCount(view: EditorView, action: () => void): number {
  const prototypes = new Set<object>();
  for (let node = syntaxTree(view.state).topNode; node; node = node.firstChild!) prototypes.add(Object.getPrototypeOf(node));
  const restore: (() => void)[] = [];
  let calls = 0;
  for (const prototype of prototypes) {
    for (const key of ['firstChild', 'lastChild', 'nextSibling', 'prevSibling', 'childAfter', 'childBefore']) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
      if (!descriptor) continue;
      const replacement = descriptor.get ? { ...descriptor, get(this: unknown) { calls++; return descriptor.get!.call(this); } }
        : { ...descriptor, value(this: unknown, ...args: unknown[]) { calls++; return descriptor.value.apply(this, args); } };
      Object.defineProperty(prototype, key, replacement);
      restore.push(() => Object.defineProperty(prototype, key, descriptor));
    }
  }
  try { action(); } finally { for (const undo of restore) undo(); }
  return calls;
}

function setVisibleRanges(view: EditorView, ranges: { from: number; to: number }[]): void {
  // A controlled viewport avoids pretending jsdom has scrolling/font geometry.
  // Parser/state/decoration code remains the real CodeMirror implementation.
  Object.defineProperty(view, 'visibleRanges', { configurable: true, get: () => ranges });
  view.dispatch({ effects: refreshLiveInline.of() });
}

test('visible traversal stays bounded near the end of a 100000-block document', t => {
  const block = '**one**\n\n', count = 100000, source = block.repeat(count);
  const from = block.length * (count - 3);
  const { view } = setup(t, source, {}, undefined, [{ from, to: from + block.length }]);
  assert.equal(forceParsing(view, source.length, 2000), true);
  setVisibleRanges(view, [{ from, to: from + block.length }]);
  const operations = navigationCount(view, () => view.dispatch({ effects: refreshLiveInline.of() }));
  assert.ok(operations < 120, `visible refresh used ${operations} syntax navigation operations`);
  const strong = inlineDecorations(view).filter(range => range.className === 'cm-strong');
  assert.deepEqual(strong.map(range => range.from), [from + 2, from + block.length + 2]);
  assert.equal(view.state.doc.toString(), source);
});

test('visible traversal skips unrelated inline children in a long single paragraph and link label', t => {
  const content = '**one** '.repeat(2000);
  const source = `[${content}](Target)\nplain`;
  const from = 1 + content.length - 3 * '**one** '.length;
  const { view } = setup(t, source, {}, undefined, [{ from, to: from + 6 }]);
  assert.equal(forceParsing(view, source.length, 2000), true);
  setVisibleRanges(view, [{ from, to: from + 6 }, { from: from + 2, to: from + 5 }]);
  const operations = navigationCount(view, () => view.dispatch({ effects: refreshLiveInline.of() }));
  assert.ok(operations < 150, `visible refresh used ${operations} syntax navigation operations`);
  const marks = inlineDecorations(view);
  assert.equal(marks.filter(range => range.className.includes('cm-live-inline-link')).length, 1);
  assert.deepEqual(marks.filter(range => range.className === 'cm-strong').map(range => range.from), [from + 2]);
});

test('a formatting ancestor spanning the viewport retains nested reveal and deduplicates visible ranges', t => {
  const source = '**start\n' + 'text\n'.repeat(300) + '*inside*\n' + 'text\n'.repeat(300) + 'end**';
  const { view, cursor } = setup(t, source);
  assert.equal(forceParsing(view, source.length, 2000), true);
  const from = source.indexOf('inside');
  setVisibleRanges(view, [{ from, to: from + 3 }, { from: from + 2, to: from + 5 }]);
  let marks = inlineDecorations(view);
  assert.equal(marks.filter(range => range.className === 'cm-strong').length, 1);
  assert.equal(marks.filter(range => range.className === 'cm-live-emphasis').length, 1);
  assert.ok(marks.some(range => range.from === from - 1 && range.to === from && range.className === ''));
  view.focus(); cursor(3); // Focused part of the ancestor is outside the viewport.
  marks = inlineDecorations(view);
  assert.equal(marks.filter(range => range.className === 'cm-strong').length, 1);
  assert.equal(marks.filter(range => range.className === 'cm-live-emphasis').length, 1);
  assert.equal(marks.some(range => range.className === ''), false);
  assert.equal(view.state.doc.toString(), source);
  assert.equal(view.state.selection.main.head, 3);
});

test('an incomplete parser maps existing decorations until the viewport is parsed again', t => {
  const control = { paused: false }, source = '**first**\n\n*last*';
  const { view } = setup(t, source, {}, control);
  const initial = inlineDecorations(view);
  assert.ok(initial.some(range => range.className === 'cm-strong'));
  control.paused = true;
  view.dispatch({ changes: { from: 0, insert: 'prefix\n\n' } });
  assert.equal(syntaxTreeAvailable(view.state, view.viewport.to), false);
  const mapped = inlineDecorations(view);
  assert.deepEqual(mapped, initial.map(range => ({ ...range, from: range.from + 8, to: range.to + 8 })));
  control.paused = false;
  assert.equal(forceParsing(view, view.state.doc.length, 2000), true);
  assert.equal(syntaxTreeAvailable(view.state, view.viewport.to), true);
  assert.deepEqual(inlineDecorations(view), mapped);
  assert.equal(view.state.doc.toString(), 'prefix\n\n' + source);
});


const nativeSource='[web](https://example.com) [[Note|Alias]]\nplain';
function nativeLinkFixture(t:TestContext, current=()=>true) {
  const f=setup(t,nativeSource,{nativeTouch:{isCurrent:current}});
  f.cursor(nativeSource.length);f.view.focus();
  const label=()=>f.view.contentDOM.querySelector<HTMLElement>('.cm-live-inline-link')!;
  Object.defineProperty(f.dom.window.document,'elementFromPoint',{configurable:true,value:()=>label()});
  return {...f,label};
}
function nativeTouch(f:ReturnType<typeof setup>,target:EventTarget,type:string,points=[{identifier:1,clientX:10,clientY:10}],active=type==='touchend'||type==='touchcancel'?[]:points,cancelable=true,modifiers:Partial<TouchEvent>={}) {
 const event=new f.dom.window.Event(type,{bubbles:true,cancelable});
 Object.defineProperties(event,{touches:{value:active},targetTouches:{value:active},changedTouches:{value:points}});
 for(const [key,value]of Object.entries(modifiers))Object.defineProperty(event,key,{value});
 target.dispatchEvent(event);return event;
}
function compatibilityClick(f:ReturnType<typeof setup>,target:Element) {return f.click(target,{detail:1,clientX:10,clientY:10});}

test('native short touchend consumes caret default and opens once with fresh validation',t=>{
 const f=nativeLinkFixture(t),selection=f.view.state.selection,doc=f.view.state.doc,before=f.transactions.length;
 assert.equal(nativeTouch(f,f.label(),'touchstart').defaultPrevented,false,'start preserves pan/longpress');
 assert.equal(f.opened.length,0);
 assert.ok(nativeTouch(f,f.label(),'touchend').defaultPrevented);
 assert.deepEqual(f.opened.map(x=>x.target),['https://example.com']);
 assert.equal((f.view as unknown as {inputState:{touchActive:boolean}}).inputState.touchActive,false,'CM touch observer must settle before admission');
 assert.ok(compatibilityClick(f,f.label()).defaultPrevented);assert.equal(f.opened.length,1);
 assert.ok(f.view.state.selection.eq(selection));assert.equal(f.view.state.doc,doc);
 assert.equal(f.transactions.slice(before).some(tx=>tx.selection),false,'no selection rewrite/restore');
});
for(const reason of ['drag','scroll','longpress','contextmenu','cancel','multitouch','owner','document','selection','modal','composition','noncancelable','endOutside'] as const)
 test(`native ${reason} preserves touch defaults and rejects matching navigation`,t=>{
  let current=true,now=100;const f=nativeLinkFixture(t,()=>current);t.mock.method(Date,'now',()=>now);
  assert.equal(nativeTouch(f,f.label(),'touchstart').defaultPrevented,false);
  if(reason==='drag')assert.equal(nativeTouch(f,f.label(),'touchmove',[{identifier:1,clientX:30,clientY:10}]).defaultPrevented,false);
  if(reason==='scroll')document.dispatchEvent(new f.dom.window.Event('scroll'));
  if(reason==='longpress')now+=600;
  if(reason==='contextmenu')assert.equal(f.label().dispatchEvent(new f.dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true})),true);
  if(reason==='cancel')nativeTouch(f,f.label(),'touchcancel');
  if(reason==='multitouch')nativeTouch(f,f.label(),'touchstart',[{identifier:1,clientX:10,clientY:10},{identifier:2,clientX:20,clientY:20}]);
  if(reason==='owner')current=false;
  if(reason==='document')f.view.dispatch({changes:{from:nativeSource.length,insert:'!'}});
  if(reason==='selection')f.view.dispatch({selection:{anchor:nativeSource.length-2,head:nativeSource.length}});
  if(reason==='modal'){const modal=document.createElement('div');modal.setAttribute('aria-modal','true');document.body.append(modal);}
  if(reason==='composition')f.view.contentDOM.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart',{bubbles:true}));
  if(reason==='endOutside')Object.defineProperty(document,'elementFromPoint',{configurable:true,value:()=>document.body});
  const selection=f.view.state.selection;
  assert.equal(nativeTouch(f,f.label(),'touchend',undefined,undefined,reason!=='noncancelable').defaultPrevented,false);
  assert.equal(compatibilityClick(f,f.label()).defaultPrevented,false,'rejected gesture is not consumed');
  assert.deepEqual(f.opened,[]);assert.ok(f.view.state.selection.eq(selection));
 });

test('native rejected start cannot reacquire owner at touchend or compatibility click',t=>{
 let current=false;const f=nativeLinkFixture(t,()=>current);
 nativeTouch(f,f.label(),'touchstart');current=true;
 assert.equal(nativeTouch(f,f.label(),'touchend').defaultPrevented,false);
 compatibilityClick(f,f.label());assert.deepEqual(f.opened,[]);
});

test('native noncollapsed selection and revealed source preserve start/end defaults',async t=>{
 const f=nativeLinkFixture(t);
 f.view.dispatch({selection:{anchor:nativeSource.length-2,head:nativeSource.length}});
 nativeTouch(f,f.label(),'touchstart');assert.equal(nativeTouch(f,f.label(),'touchend').defaultPrevented,false);assert.deepEqual(f.opened,[]);
 await new Promise(resolve=>setTimeout(resolve,80));f.cursor(4);assert.equal(f.label().dataset.liveInlineRendered,'false');
 nativeTouch(f,f.label(),'touchstart');assert.equal(nativeTouch(f,f.label(),'touchend').defaultPrevented,false);assert.deepEqual(f.opened,[]);
});

test('desktop rendered touch stays default and follows only real click',t=>{
 const f=setup(t,nativeSource),label=f.view.contentDOM.querySelector('.cm-live-inline-link')!;
 assert.equal(nativeTouch(f,label,'touchstart').defaultPrevented,false);
 assert.equal(nativeTouch(f,label,'touchend').defaultPrevented,false);assert.equal(f.opened.length,0);
 f.click(label);assert.equal(f.opened.length,1);
});

test('native compatibility fence is bounded and never swallows keyboard/AT click',t=>{
 let now=100;const f=nativeLinkFixture(t);t.mock.method(Date,'now',()=>now);
 nativeTouch(f,f.label(),'touchstart');nativeTouch(f,f.label(),'touchcancel');
 f.click(f.label(),{detail:0});assert.equal(f.opened.length,1,'AT click remains available');
 nativeTouch(f,f.label(),'touchstart');nativeTouch(f,f.label(),'touchcancel');now+=1100;
 compatibilityClick(f,f.label());assert.equal(f.opened.length,2,'expired witness cannot consume a new activation');
});

test('native cancel releases rendering freeze and fresh tap remains usable',async t=>{
 const f=nativeLinkFixture(t);nativeTouch(f,f.label(),'touchstart');nativeTouch(f,f.label(),'touchcancel');
 f.cursor(4);await new Promise(resolve=>setTimeout(resolve,80));assert.equal(f.label().dataset.liveInlineRendered,'false');
 f.cursor(nativeSource.length);nativeTouch(f,f.label(),'touchstart');nativeTouch(f,f.label(),'touchend');assert.equal(f.opened.length,1);
});


test('native initial multitouch cannot become a fresh link tap after fingers leave',t=>{
 const f=nativeLinkFixture(t),points=[{identifier:1,clientX:10,clientY:10},{identifier:2,clientX:20,clientY:20}];
 nativeTouch(f,f.label(),'touchstart',points);
 assert.equal(nativeTouch(f,f.label(),'touchend').defaultPrevented,false);
 compatibilityClick(f,f.label());assert.deepEqual(f.opened,[]);
});

test('native unsafe rendered link never intercepts touch defaults or opens',t=>{
 const f=setup(t,'[unsafe](javascript:alert(1))\nplain',{nativeTouch:{isCurrent:()=>true}});
 const label=f.view.contentDOM.querySelector<HTMLElement>('.cm-live-inline-unsafe')!;
 assert.ok(label);assert.equal(nativeTouch(f,label,'touchstart').defaultPrevented,false);
 assert.equal(nativeTouch(f,label,'touchend').defaultPrevented,false);f.click(label);assert.deepEqual(f.opened,[]);
});


for(const modifier of ['ctrlKey','metaKey','shiftKey','altKey'] as const)
 for(const phase of ['touchstart','touchend'] as const)test(`native ${modifier} at ${phase} preserves platform defaults`,t=>{
  const f=nativeLinkFixture(t);
  const start=nativeTouch(f,f.label(),'touchstart',undefined,undefined,true,phase==='touchstart'?{[modifier]:true}:{});
  const end=nativeTouch(f,f.label(),'touchend',undefined,undefined,true,phase==='touchend'?{[modifier]:true}:{});
  assert.equal(start.defaultPrevented,false);assert.equal(end.defaultPrevented,false);
  compatibilityClick(f,f.label());assert.deepEqual(f.opened,[]);
 });

// Real native dispatch can checkpoint microtasks between document capture and
// CM's bubble listener. Split/replay the same unconsumed TouchEvent at that
// boundary; ordinary synchronous jsdom dispatch cannot expose this ordering.
function pauseNativeEndAtCapture(f:ReturnType<typeof setup>) {
 let paused=false;
 const pause=(event:Event)=>{if(!paused){paused=true;event.stopPropagation();}};
 f.dom.window.document.addEventListener('touchend',pause,{capture:true,once:true});
}

test('native touch witness survives capture microtasks until the real CM end handler',async t=>{
 const f=nativeLinkFixture(t),selection=f.view.state.selection;
 nativeTouch(f,f.label(),'touchstart');pauseNativeEndAtCapture(f);
 const end=nativeTouch(f,f.label(),'touchend');
 assert.equal(end.defaultPrevented,false);assert.deepEqual(f.opened,[]);
 await Promise.resolve(); // Capture fallback microtask runs here in the old code.
 f.label().dispatchEvent(end);
 assert.ok(end.defaultPrevented,'the original witness must reach CM after the checkpoint');
 assert.equal(f.opened.length,1);assert.ok(f.view.state.selection.eq(selection));
 compatibilityClick(f,f.label());assert.equal(f.opened.length,1);
});

test('a new touch supersedes only a completed end awaiting fallback cleanup',async t=>{
 const f=nativeLinkFixture(t);
 nativeTouch(f,f.label(),'touchstart');pauseNativeEndAtCapture(f);nativeTouch(f,f.label(),'touchend');
 // Another input task may win over the queued cleanup task. It is not a second
 // finger in the old gesture: the captured end already had zero active touches.
 nativeTouch(f,f.label(),'touchstart');await Promise.resolve();
 assert.ok(nativeTouch(f,f.label(),'touchend').defaultPrevented);
 assert.equal(f.opened.length,1);
 await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.opened.length,1);
});

test('consumed native end still releases rendering freeze after dispatch',async t=>{
 const f=nativeLinkFixture(t);
 nativeTouch(f,f.label(),'touchstart');pauseNativeEndAtCapture(f);nativeTouch(f,f.label(),'touchend');
 await new Promise(resolve=>setTimeout(resolve,10));
 f.cursor(4);await new Promise(resolve=>setTimeout(resolve,80));
 assert.equal(f.label().dataset.liveInlineRendered,'false');assert.deepEqual(f.opened,[]);
});

test('destroy with native end cleanup pending cannot navigate or update the dead view',async t=>{
 const f=nativeLinkFixture(t);
 nativeTouch(f,f.label(),'touchstart');pauseNativeEndAtCapture(f);nativeTouch(f,f.label(),'touchend');
 const transactions=f.transactions.length;f.destroy();
 await new Promise(resolve=>setTimeout(resolve,80));
 assert.deepEqual(f.opened,[]);assert.equal(f.transactions.length,transactions);
});
