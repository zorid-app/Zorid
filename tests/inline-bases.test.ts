import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { inlineBaseRequest, replaceInlineBaseSource } from '../src/bases/inline-base.ts';
import type { InlineBaseRequest } from '../src/bases/inline-base.ts';
import { renderMarkdown } from '../src/ui/markdown.ts';
import { liveBases } from '../src/editor/live-bases.ts';
import { liveCallouts } from '../src/editor/live-callouts.ts';

const config = 'views:\n  - type: table\n    name: Table\n';
const fenced = '```base\n' + config + '```';

test('inline edits preserve the exact containing note, fence, CRLF and indentation', () => {
  const source = '---\r\naliases: [Keep]\r\n---\r\n\r\n  ~~~~base\r\n  views: []\r\n  ~~~~~\r\n\r\nLiteral body\r\n';
  const from = source.indexOf('  ~~~~base'), to = source.indexOf('  ~~~~~\r') + '  ~~~~~'.length;
  const request = inlineBaseRequest(source, from, to)!;
  assert.ok(request); assert.equal(request.source, 'views: []\n');
  const next = replaceInlineBaseSource(source, request, config);
  assert.equal(next, source.slice(0, request.contentFrom) + '  views:\r\n    - type: table\r\n      name: Table\r\n' + source.slice(request.contentTo));
  assert.equal(replaceInlineBaseSource(source, request, request.source), source);
});

test('a retained occurrence cannot edit an identical replacement, moved block or changed body', () => {
  const source = 'Before\n\n' + fenced + '\n\n' + fenced + '\nEnd';
  const first = source.indexOf('```base'), request = inlineBaseRequest(source, first, first + fenced.length)!;
  assert.ok(request);
  for (const changed of ['Inserted\n' + source, source.replace('Before', 'After'), source.replace('End', 'Edited body')]) {
    assert.throws(() => replaceInlineBaseSource(changed, request, 'views: []\n'), /containing this Base changed/);
  }
  const next = replaceInlineBaseSource(source, request, 'views: []\n');
  assert.equal(next.slice(next.lastIndexOf('```base')), fenced + '\nEnd');
  assert.throws(() => replaceInlineBaseSource(source, request, 'views: []\n```\n'), /closing fence/);
});

test('CommonMark optional fence indentation and quote spacing normalize without changing source ownership', () => {
  for (const source of ['  ```base\nviews: []\n```', '> > ```base\n>> views: []\n>> ```', '>   ```base\n> views: []\n> ```']) {
    const request = inlineBaseRequest(source, 0, source.length)!;
    assert.ok(request, source); assert.equal(request.source, 'views: []\n');
    assert.equal(replaceInlineBaseSource(source, request, request.source), source);
  }
});

test('Reading and source edits retain exact nested quote/list prefixes and source identity', () => {
  const dom = new JSDOM('<main></main>'), root = dom.window.document.querySelector('main')!;
  try {
    for (const prefix of ['> ', '- ', '> - ']) {
      const continuation = prefix.replace('- ', '  ');
      const block = prefix + '```base\r\n' + continuation + 'views: []\r\n' + continuation + '```';
      const source = 'Before\r\n\r\n' + block + '\r\n\r\nAfter';
      const requests: InlineBaseRequest[] = [];
      renderMarkdown(root, source, () => {}, undefined, { base(request) { requests.push(request); return dom.window.document.createElement('section'); } });
      assert.equal(requests.length, 1, prefix);
      const request = requests[0]; assert.equal(request.documentText, source); assert.equal(request.source, 'views: []\n');
      assert.equal(source.slice(request.from, request.to), block);
      assert.equal(replaceInlineBaseSource(source, request, 'views:\n  - name: Updated\n'),
        'Before\r\n\r\n' + prefix + '```base\r\n' + continuation + 'views:\r\n' + continuation + '  - name: Updated\r\n' + continuation + '```\r\n\r\nAfter');
    }
  } finally { dom.window.close(); }
});

test('Reading source mapping preserves Unicode, CRLF, multiple embeds and subpath offsets', () => {
  const dom = new JSDOM('<main></main>'), root = dom.window.document.querySelector('main')!;
  try {
    const heading = '---\r\nname: 🦀\r\n---\r\n\r\n# Section\r\n\r\n';
    const selected = fenced.replaceAll('\n', '\r\n') + '\r\n\r\n' + fenced.replaceAll('\n', '\r\n');
    const source = heading + selected + '\r\nTail';
    const requests: InlineBaseRequest[] = [];
    renderMarkdown(root, selected, () => {}, undefined, { sourceText: source, sourceOffset: heading.length,
      base(request) { requests.push(request); return dom.window.document.createElement('section'); } });
    assert.equal(requests.length, 2); assert.equal(requests[0].from, heading.length);
    assert.equal(requests[0].documentText, source); assert.equal(requests[1].source, config);
    assert.equal(requests[1].from, source.lastIndexOf('```base'));
    assert.equal(root.querySelector('pre'), null);
  } finally { dom.window.close(); }
});

test('unclosed or ordinary fences remain literal and never acquire a writable Base identity', () => {
  const dom = new JSDOM('<main></main>'), root = dom.window.document.querySelector('main')!;
  try {
    let mounted = 0;
    renderMarkdown(root, '```yaml\n' + fenced + '\n```\n\n```base\nviews: []', () => {}, undefined,
      { base() { mounted++; return dom.window.document.createElement('section'); } });
    assert.equal(mounted, 0); assert.ok(root.querySelector('pre'));
    assert.equal(inlineBaseRequest('```base\nviews: []', 0, 18), null);
  } finally { dom.window.close(); }
});

function editor(t: TestContext, source: string, callouts = false) {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true, url: 'https://zorid.test/' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Text: dom.window.Text, Window: dom.window.Window,
    MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0, toJSON: () => ({}) });
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const requests: InlineBaseRequest[] = [],occurrences:(object|undefined)[]=[]; let destroyed = 0;
  const render = (request: InlineBaseRequest,context?:{occurrence:object}) => {
    requests.push(request);occurrences.push(context?.occurrence); const node = dom.window.document.createElement('section'); node.className = 'mounted-base';
    const input = dom.window.document.createElement('input'); node.append(input);
    return { dom: node, destroy() { destroyed++; } };
  };
  const view = new EditorView({ parent: document.querySelector('main')!, state: EditorState.create({ doc: source,
    extensions: [markdown(), ...(callouts ? [liveCallouts({ renderBase: render })] : []), liveBases(render)] }) });
  let closed = false;
  const close = () => { if (!closed) { closed = true; view.destroy(); } };
  t.after(() => { close(); dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  return { dom, view, requests, occurrences, close, get destroyed() { return destroyed; } };
}

test('Live Edit mounts the exact fence, retains child drafts on selection elsewhere, and reveals source', t => {
  const source = 'Before\n\n' + fenced + '\n\nAfter', ui = editor(t, source);
  assert.equal(ui.requests.length, 1); const input = ui.view.dom.querySelector('input')!; input.value = 'unfinished property';
  ui.view.dispatch({ selection: { anchor: 2 } });
  assert.equal(ui.view.dom.querySelector('input'), input); assert.equal(ui.requests.length, 1);
  ui.view.dom.querySelector<HTMLButtonElement>('[aria-label="Edit Base source"]')!.click();
  assert.equal(ui.view.dom.querySelector('.mounted-base'), null); assert.equal(ui.destroyed, 1);
  assert.equal(ui.view.state.doc.toString(), source); assert.equal(ui.view.state.selection.main.anchor, source.indexOf('views:'));
  ui.view.dispatch({ selection: { anchor: 0 } }); assert.equal(ui.requests.length, 2);
  ui.close(); assert.equal(ui.destroyed, 2);
});

test('Live Edit parser maps nested list, quote and callout fences to their containing note', t => {
  const source = 'Before\n\n> [!note] Details\n>\n> - ```base\n>   views: []\n>   ```\n\nAfter', ui = editor(t, source, true);
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].documentText, source); assert.equal(ui.requests[0].source, 'views: []\n');
  assert.equal(source.slice(ui.requests[0].from, ui.requests[0].to), '> - ```base\n>   views: []\n>   ```');
  ui.close(); assert.equal(ui.destroyed, 1);
});

test('a Live callout remounts inline source guards when another part of its note changes', t => {
  const source = 'Before\n\n> [!note] Details\n> ```base\n> views: []\n> ```\n\nAfter', ui = editor(t, source, true);
  assert.equal(ui.requests.length, 1);
  ui.view.dispatch({ changes: { from: source.length, insert: ' dirty body' } });
  assert.equal(ui.requests.length, 2); assert.equal(ui.destroyed, 1);
  assert.equal(ui.requests[1].documentText, source + ' dirty body');
  assert.equal(ui.requests[1].from, ui.requests[0].from);
  assert.throws(() => replaceInlineBaseSource(ui.requests[1].documentText, ui.requests[0], 'views: []\n'), /containing this Base changed/);
});

test('an initial fence renders while unfocused and focusing its property input does not reveal parent source', async t => {
  const ui = editor(t, fenced + '\n\nAfter');
  assert.equal(ui.requests.length, 1); const input = ui.view.dom.querySelector('input')!;
  input.focus(); input.value = 'unfinished property'; await Promise.resolve();
  assert.equal(ui.view.dom.querySelector('input'), input); assert.equal(ui.destroyed, 0);
  ui.view.focus(); await Promise.resolve();
  assert.equal(ui.view.dom.querySelector('.mounted-base'), null);
  assert.equal(ui.view.state.doc.toString(), fenced + '\n\nAfter');
});


test('a configuration-only Live fence rewrite keeps its logical token but refreshes exact source guards',t=>{
  const source='Before\n\n'+fenced+'\n\nAfter',ui=editor(t,source),from=source.indexOf('name: Table')+'name: '.length;
  const original=ui.requests[0],occurrence=ui.occurrences[0];assert.ok(occurrence);
  ui.view.dispatch({changes:{from,to:from+'Table'.length,insert:'Renamed'}});
  assert.equal(ui.requests.length,2);assert.equal(ui.occurrences[1],occurrence);assert.notEqual(ui.requests[1].documentText,original.documentText);
  assert.throws(()=>replaceInlineBaseSource(ui.requests[1].documentText,original,'views: []\n'),/containing this Base changed/);
});

test('a foreign fence shell or combined outside/configuration rewrite gets a new Live token',t=>{
  const source='Before\n\n'+fenced+'\n\nAfter',ui=editor(t,source),first=ui.occurrences[0];
  const changed=source.replace('name: Table','name: Renamed').replace('After','External body');
  ui.view.dispatch({changes:{from:0,to:source.length,insert:changed}});assert.notEqual(ui.occurrences.at(-1),first);
  const previous=ui.occurrences.at(-1),shell=changed.replace('```base','~~~~base').replace('\n```','\n~~~~');
  ui.view.dispatch({changes:{from:0,to:changed.length,insert:shell}});assert.notEqual(ui.occurrences.at(-1),previous);
});
