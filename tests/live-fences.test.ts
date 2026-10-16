import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { history, undo } from '@codemirror/commands';
import { search, openSearchPanel, SearchQuery, setSearchQuery } from '@codemirror/search';
import { forceParsing } from '@codemirror/language';
import { liveFences, refreshLiveFences } from '../src/editor/live-fences.ts';
import type { LiveFenceOptions } from '../src/editor/live-fences.ts';
import { appendCodeBlock, destroyCodeBlocks, readCodeFence } from '../src/ui/code-block.ts';
import { codeCopyText, codeLanguage, createCodeHighlighter } from '../src/editor/code-highlight.ts';
import type { CodeToken } from '../src/editor/code-highlight.ts';

const tick = (ms = 5) => new Promise<void>(resolve => setTimeout(resolve, ms));
function setup(t: TestContext, source: string, options: LiveFenceOptions = {}, visible?: { from: number; to: number }[]) {
  const dom = new JSDOM('<main></main><button id="outside">Outside</button>', { pretendToBeVisual: true, url: 'https://zorid.test/' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Text: dom.window.Text, Window: dom.window.Window,
    MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0, toJSON: () => ({}) });
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  class View extends EditorView { get visibleRanges() { return visible ?? super.visibleRanges; } }
  const copied: string[] = [], errors: unknown[] = [];
  const view = new View({ parent: document.querySelector('main')!, state: EditorState.create({ doc: source, extensions: [
    markdown(), history(), search(), EditorState.allowMultipleSelections.of(true), liveFences({ highlight: async () => [], copyText: value => { copied.push(value); }, onError: error => errors.push(error), ...options }),
  ] }) });
  let closed = false; const destroy = () => { if (!closed) { closed = true; view.destroy(); } };
  t.after(() => { destroy(); dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  const refresh = () => view.dispatch({ effects: refreshLiveFences.of() });
  const cursor = (anchor: number, head = anchor) => view.dispatch({ selection: { anchor, head } });
  return { dom, view, copied, errors, destroy, refresh, cursor };
}

test('Reading fence parser respects marker kind/length, metadata, indentation and incomplete fences', () => {
  const lines = ['  ````js title', '  const value = "```";', '  ```', '  ```` extra', '  `````', 'after'];
  assert.deepEqual(readCodeFence(lines, 0), { info: 'js title', code: 'const value = "```";\n```\n```` extra', endLine: 4, closed: true });
  assert.equal(readCodeFence(['    ```js', 'x'], 0), null); assert.equal(readCodeFence(['```foo`bar'], 0), null);
  assert.deepEqual(readCodeFence(['~~~unknown', 'a', '```'], 0), { info: 'unknown', code: 'a\n```', endLine: 2, closed: false });
  assert.equal(codeLanguage(' TypeScript title="a" '), 'typescript'); assert.equal(codeCopyText('a\n\n'), 'a\n');
});

test('complete live fences conceal markers, retain editable code and reveal on all focused selections', async t => {
  const source = 'before\n\n```js\nconst x = 1;\n```\n\nafter', ui = setup(t, source);
  assert.equal(ui.view.contentDOM.textContent!.includes('```'), false); assert.match(ui.view.contentDOM.textContent!, /const x/);
  assert.equal(ui.view.contentDOM.querySelectorAll('.cm-fence-flair').length, 1);
  ui.view.focus(); ui.cursor(source.indexOf('const') + 2); assert.equal(ui.view.contentDOM.textContent!.includes('```js'), true);
  ui.view.dispatch({ changes: { from: source.indexOf('x ='), insert: 'new_' } });
  assert.match(ui.view.state.doc.toString(), /const new_x/); assert.ok(undo(ui.view)); assert.equal(ui.view.state.doc.toString(), source);
  ui.view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.range(source.indexOf('```') + 1, source.indexOf('const'))]) });
  assert.equal(ui.view.contentDOM.textContent!.includes('```js'), true);
  (ui.dom.window.document.querySelector('#outside') as HTMLElement).focus(); await tick(); ui.refresh(); assert.equal(ui.view.contentDOM.textContent!.includes('```'), false);
  assert.equal(ui.view.state.doc.toString(), source);
});

test('unclosed fences remain visible and syntax inside inline code or frontmatter is not concealed', t => {
  const source = '---\nvalue: "```"\n---\n\n`~~~`\n\n```js\nlet x = 1', ui = setup(t, source);
  assert.match(ui.view.contentDOM.textContent!, /```js/); assert.equal(ui.view.contentDOM.querySelector('.cm-fence-flair'), null); assert.equal(ui.view.state.doc.toString(), source);
});

test('copy flair resolves current mapped source, handles failure, and becomes inert after teardown', async t => {
  let reject = false; const values: string[] = [], ui = setup(t, '```js\nconst x = 1;\n```', { copyText: value => { if (reject) throw new Error('denied'); values.push(value); } });
  let button = ui.view.contentDOM.querySelector<HTMLButtonElement>('.cm-fence-flair')!; button.click(); await tick(); assert.deepEqual(values, ['const x = 1;']);
  ui.view.dispatch({ changes: { from: 0, insert: 'prefix\n\n' } }); button = ui.view.contentDOM.querySelector<HTMLButtonElement>('.cm-fence-flair')!;
  button.click(); await tick(); assert.deepEqual(values, ['const x = 1;', 'const x = 1;']);
  reject = true; button.click(); await tick(); assert.equal(button.getAttribute('aria-label'), 'Unable to copy code'); assert.equal(ui.errors.length, 1);
  const click = button.onclick!; ui.destroy(); button.click(); await click.call(button, new ui.dom.window.MouseEvent('click')); assert.equal(values.length, 2);
});

test('Reading highlighting constructs literal DOM and clipboard preserves exact source whitespace', async t => {
  const ui = setup(t, ''), parent = ui.dom.window.document.createElement('article'); ui.dom.window.document.body.append(parent);
  const source = '<img src=x onerror=bad>\n\n';
  const handle = appendCodeBlock(parent, source, 'html', { highlight: async () => [{ from: 0, to: 4, classes: ['attr-value', 'punctuation', 'bad class'] }], copyText: value => { ui.copied.push(value); } });
  await handle.ready; assert.equal(handle.element.querySelector('code')!.textContent, source); assert.equal(handle.element.querySelector('img'), null);
  assert.equal(handle.element.querySelectorAll('.token-punctuation').length, 1);
  assert.equal(handle.element.querySelector<HTMLElement>('.token-punctuation')!.style.color, 'var(--code-punctuation, var(--text-muted))'); assert.equal(handle.element.querySelector('.bad'), null);
  handle.element.querySelector('button')!.click(); await tick(); assert.deepEqual(ui.copied, ['<img src=x onerror=bad>\n\n']); handle.destroy();
});

test('Reading lazy observer and teardown prevent late highlight/copy mutations', async t => {
  const ui = setup(t, ''), parent = ui.dom.window.document.createElement('article'); ui.dom.window.document.body.append(parent);
  let notify!: (entries: { isIntersecting: boolean }[]) => void, calls = 0, resolve!: (tokens: CodeToken[]) => void;
  Object.defineProperty(ui.dom.window, 'IntersectionObserver', { value: class { constructor(callback: typeof notify) { notify = callback; } observe() {} disconnect() {} } });
  const handle = appendCodeBlock(parent, 'let x = 1', 'js', { highlight: () => { calls++; return new Promise(done => { resolve = done; }); }, copyText: value => { ui.copied.push(value); } });
  assert.equal(calls, 0); notify([{ isIntersecting: false }]); assert.equal(calls, 0); notify([{ isIntersecting: true }]); await tick(); assert.equal(calls, 1);
  const button = handle.element.querySelector('button')!; handle.destroy(); resolve([{ from: 0, to: 3, classes: ['keyword'] }]); await handle.ready; await tick();
  assert.equal(handle.element.querySelector('.token-keyword'), null); button.click(); assert.deepEqual(ui.copied, []);
});

test('live token ranges update source marks and reject stale asynchronous highlight results', async t => {
  const jobs: { source: string; resolve: (tokens: CodeToken[]) => void; signal?: AbortSignal }[] = [];
  const source = '```js\nconst x = 1;\n```', ui = setup(t, source, { highlight: (source, _, signal) => new Promise(resolve => jobs.push({ source, resolve, signal })) });
  await tick(); assert.equal(jobs.length, 1); ui.view.dispatch({ changes: { from: source.indexOf('const'), to: source.indexOf('const') + 5, insert: 'let' } }); await tick();
  assert.equal(jobs[0].signal!.aborted, true); assert.equal(jobs.length, 2);
  jobs[0].resolve([{ from: 0, to: 5, classes: ['wrong'] }]); jobs[1].resolve([{ from: 0, to: 3, classes: ['keyword'] }]); await tick(15);
  assert.equal(ui.view.contentDOM.querySelector('.token-wrong'), null); assert.equal(ui.view.contentDOM.querySelector('.token-keyword')!.textContent, 'let');
  const before = ui.view.state.doc.toString(); ui.cursor(0); ui.refresh(); await tick(); assert.equal(jobs.length, 2); assert.equal(ui.view.state.doc.toString(), before);
});

test('only visible fences invoke highlighting and duplicate code shares a job', async t => {
  const source = '```js\none\n```\n\n```js\ntwo\n```\n\n```js\ntwo\n```', visible = [{ from: source.indexOf('two'), to: source.length }], calls: string[] = [];
  const ui = setup(t, source, { highlight: async source => { calls.push(source); return []; } }, visible); await tick(15);
  assert.deepEqual(calls, ['two']); assert.equal(ui.view.state.doc.toString(), source);
});

test('nested quote code maps token marks to code rather than quote prefixes', async t => {
  const source = '> ```js\n> let x = 1\n> let y = 2\n> ```', seen: string[] = [], ui = setup(t, source, { highlight: async code => { seen.push(code); return [{ from: 0, to: 3, classes: ['keyword'] }, { from: 10, to: 13, classes: ['keyword'] }]; } });
  await tick(15); assert.deepEqual(seen, ['let x = 1\nlet y = 2']); assert.deepEqual([...ui.view.contentDOM.querySelectorAll('.token-keyword')].map(node => node.textContent), ['let', 'let']);
});

test('pointer and composition preserve hidden-marker geometry through edits before delayed reveal', async t => {
  const source = '```js\nlet x = 1\n```\n\nafter', ui = setup(t, source);
  const target = ui.view.contentDOM.querySelector('.cm-line')!, down = new ui.dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }); down.preventDefault(); target.dispatchEvent(down);
  ui.view.focus(); ui.cursor(source.indexOf('let')); assert.equal(ui.view.contentDOM.textContent!.includes('```'), false);
  ui.view.dispatch({ changes: { from: source.indexOf('let'), insert: 'a' } }); assert.equal(ui.view.contentDOM.textContent!.includes('```'), false);
  ui.dom.window.document.dispatchEvent(new ui.dom.window.MouseEvent('mouseup', { bubbles: true })); await tick(65); assert.equal(ui.view.contentDOM.textContent!.includes('```'), true);
  ui.cursor(ui.view.state.doc.length); ui.view.contentDOM.dispatchEvent(new ui.dom.window.Event('compositionstart', { bubbles: true }));
  ui.cursor(1); assert.equal(ui.view.contentDOM.textContent!.includes('```'), false);
  ui.view.contentDOM.dispatchEvent(new ui.dom.window.Event('compositionend', { bubbles: true })); await tick(30); assert.equal(ui.view.contentDOM.textContent!.includes('```'), true);
});

test('search overlap reveals code fences with search input focus; host-owned languages are untouched', async t => {
  const ui = setup(t, '```js\nconst x = 1\n```\n\n```mermaid\ngraph TD\n```', { handledLanguages: new Set(['mermaid']) });
  assert.equal(ui.view.contentDOM.querySelectorAll('.cm-fence-flair').length, 1); assert.match(ui.view.contentDOM.textContent!, /```mermaid/);
  openSearchPanel(ui.view); ui.view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'const' })) }); ui.refresh(); assert.match(ui.view.contentDOM.textContent!, /```js/);
});

test('worker client cancels active work, preserves queued requests and ignores stale responses', async () => {
  class FakeWorker { onmessage: ((event: { data: unknown }) => void) | null = null; onerror: ((event: { message: string }) => void) | null = null; sent: any[] = []; terminated = false; postMessage(value: unknown) { this.sent.push(value); } terminate() { this.terminated = true; } }
  const workers: FakeWorker[] = [], highlighter = createCodeHighlighter('https://zorid.test/lib/prism/prism.js', () => { const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker; });
  const abort = new AbortController(), first = highlighter('old', 'js', abort.signal), rejected = assert.rejects(first, { name: 'AbortError' }), second = highlighter('new', 'js');
  assert.equal(workers.length, 1); abort.abort(); await rejected; assert.equal(workers[0].terminated, true); assert.equal(workers.length, 2);
  workers[0].onerror!({ message: 'stale worker error' });
  workers[0].onmessage!({ data: { id: workers[0].sent[0].id, tokens: [{ from: 0, to: 3, classes: ['wrong'] }] } });
  workers[1].onmessage!({ data: { id: workers[1].sent[0].id, tokens: [{ from: 0, to: 3, classes: ['keyword'] }] } });
  assert.deepEqual(await second, [{ from: 0, to: 3, classes: ['keyword'] }]); highlighter.destroy(); await assert.rejects(highlighter('later', 'js'), { name: 'AbortError' });
});


test('Reading normalized body preserves blank lines while Live follows the separately observed final-LF trim', async t => {
  const source = '```js\na\n\n```', ui = setup(t, source);
  const parsed = readCodeFence(source.split('\n'), 0)!; assert.equal(parsed.code, 'a\n');
  const parent = ui.dom.window.document.createElement('article'); ui.dom.window.document.body.append(parent);
  const handle = appendCodeBlock(parent, parsed.code, parsed.info, { highlight: async () => [], copyText: value => { ui.copied.push(value); } });
  await handle.ready; handle.element.querySelector('button')!.click(); await tick(); assert.deepEqual(ui.copied, ['a\n']);
  ui.view.contentDOM.querySelector<HTMLButtonElement>('.cm-fence-flair')!.click(); await tick(); assert.deepEqual(ui.copied, ['a\n', 'a']); handle.destroy();
});


test('unchanged selection refresh reuses extracted code and container cleanup aborts nested Reading owners', async t => {
  const ui = setup(t, '```js\n' + 'let value = 1;\n'.repeat(200) + '```');
  forceParsing(ui.view, ui.view.state.doc.length, 100); ui.refresh(); await tick();
  const doc = ui.view.state.doc, original = doc.sliceString.bind(doc); let longSlices = 0;
  doc.sliceString = (from = 0, to = doc.length, separator = '\n') => { if (to - from > 100) longSlices++; return original(from, to, separator); };
  ui.refresh(); ui.refresh(); assert.equal(longSlices, 0); doc.sliceString = original;
  const parent = ui.dom.window.document.createElement('article'), nested = ui.dom.window.document.createElement('section'); parent.append(nested); ui.dom.window.document.body.append(parent);
  let signal: AbortSignal | undefined;
  const handle = appendCodeBlock(nested, 'pending', 'js', { highlight: (_, __, abort) => { signal = abort; return new Promise(() => {}); } });
  await tick(); destroyCodeBlocks(parent); await handle.ready; assert.equal(signal!.aborted, true);
});
