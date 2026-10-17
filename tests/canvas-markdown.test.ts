import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorView } from '@codemirror/view';
import { Transaction } from '@codemirror/state';
import { CanvasDocument } from '../src/canvas/document.ts';
import { createCanvasView } from '../src/canvas/view.ts';
import type { CanvasViewOptions } from '../src/canvas/view.ts';

const tick = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
function setup(text: string, options: Partial<CanvasViewOptions> = {}) {
  const dom = new JSDOM('<!doctype html><main></main>', { url: 'https://zorid.test/', pretendToBeVisual: true });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Text: dom.window.Text, Window: dom.window.Window, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 300, bottom: 200, width: 300, height: 200, x: 0, y: 0, toJSON() { return {}; } });
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const host = dom.window.document.querySelector('main')!;
  const source = JSON.stringify({ nodes: [{ id: 'text', type: 'text', x: 0, y: 0, width: 320, height: 240, text, plugin: { keep: true } }], edges: [], custom: 1 }, null, '\t') + '\n';
  const document = CanvasDocument.parse(source), saves: string[] = [], errors: unknown[] = [];
  const view = createCanvasView(host, { document, onChange: value => { saves.push(value); }, onError: error => { errors.push(error); }, ...options });
  const card = () => host.querySelector<HTMLElement>('[data-node-id="text"]')!;
  const edit = async () => { card().dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true })); await tick(); const editor = EditorView.findFromDOM(card().querySelector('.cm-editor')!)!; assert.ok(editor); return editor; };
  return { dom, host, document, source, view, saves, errors, card, edit, close() { view.destroy(); dom.window.dispatchEvent(new dom.window.Event('pagehide')); dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } } };
}
function workerHarness(t: Parameters<Parameters<typeof test>[1]>[0]) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const workers: FakeWorker[] = [];
  class FakeWorker {
    onmessage?: (event: { data: unknown }) => void;
    onerror?: (event: unknown) => void;
    jobs: { id: number; source: string; language: string }[] = [];
    terminated = false;
    constructor() { workers.push(this); }
    postMessage(job: FakeWorker['jobs'][number]) { this.jobs.push(job); }
    terminate() { this.terminated = true; }
    reply() { this.onmessage?.({ data: { id: this.jobs[0].id, tokens: [{ from: 0, to: 5, classes: ['keyword'] }] } }); }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
  t.after(() => { if (prior) Object.defineProperty(globalThis, 'Worker', prior); else Reflect.deleteProperty(globalThis, 'Worker'); });
  return workers;
}
async function mathHarness(ui: ReturnType<typeof setup>) {
  await tick();
  const pending: { text: string; display: boolean; resolve(element: HTMLElement): void }[] = [];
  Object.assign(ui.dom.window, { MathJax: {
    startup: { promise: Promise.resolve() },
    tex2chtmlPromise: (text: string, options: { display: boolean }) => new Promise<HTMLElement>(resolve => pending.push({ text, display: options.display, resolve })),
    chtmlStylesheet: () => null,
  } });
  ui.dom.window.document.querySelector('script[data-zorid-mathjax]')!.dispatchEvent(new ui.dom.window.Event('load'));
  await tick();
  const resolve = (index: number) => { const output = ui.dom.window.document.createElement('mjx-container'); output.textContent = `typeset ${pending[index].text}`; pending[index].resolve(output); };
  return { pending, resolve };
}

test('Canvas text cards use shared mixed Markdown, math and highlighted fence DOM without changing source', async t => {
  const workers = workerHarness(t);
  const text = '# Title **bold**\r\n\r\nAn *emphasis* and $x^2$.\r\n\r\n```js\r\nconst a = 1;\r\n```\r\n\r\n$$\r\ny^2\r\n$$\r\n\r\n- item\r\n\r\n| A | B |\r\n| --- | --- |\r\n| c | d |';
  const ui = setup(text); t.after(ui.close);
  assert.equal(ui.card().querySelector('h1 strong')?.textContent, 'bold');
  assert.equal(ui.card().querySelector('p em')?.textContent, 'emphasis');
  assert.equal(ui.card().querySelector('li')?.textContent, 'item'); assert.equal(ui.card().querySelectorAll('td').length, 2);
  const math = await mathHarness(ui);
  assert.equal(math.pending[0].text, 'x^2'); assert.equal(math.pending[0].display, false);
  math.resolve(0); await tick(); assert.equal(math.pending[1].display, true); math.resolve(1); await tick();
  assert.equal(ui.card().querySelectorAll('mjx-container').length, 2);
  assert.equal(workers.length, 1); assert.equal(workers[0].jobs[0].language, 'js'); workers[0].reply(); await tick();
  assert.equal(ui.card().querySelector('code .token-keyword')?.textContent, 'const');
  assert.equal(ui.card().querySelector('code')?.textContent, 'const a = 1;');
  assert.ok(ui.card().querySelector('[aria-label="Copy code"]'));
  await ui.view.flush(); assert.equal(ui.document.toString(), ui.source); assert.deepEqual(ui.saves, []); assert.equal(ui.view.hasPendingChanges(), false);
});

test('refresh and destroy dispose in-flight math, fence workers and embed owners with inert retained controls', async t => {
  const workers = workerHarness(t), destroyed: string[] = [], opened: string[] = [];
  let ownerDocument: Document;
  // Embed construction receives an owner document through the host closure.
  const dom = new JSDOM('<main></main>', { url: 'https://zorid.test/' }); ownerDocument = dom.window.document;
  const ui = setup('$old$\n\n```js\nconst old = 1;\n```\n\n![[embed]]', { renderMarkdownEmbed(request) { const element = ownerDocument.createElement('button'); element.textContent = request.target; element.onclick = () => opened.push(request.target); return { element, destroy() { destroyed.push(request.target); } }; } });
  t.after(() => { ui.close(); dom.window.close(); });
  const math = await mathHarness(ui), oldMath = ui.card().querySelector('.math')!, oldCode = ui.card().querySelector('code')!, copy = ui.card().querySelector<HTMLButtonElement>('.zorid-code-copy')!, embed = ui.card().querySelector<HTMLButtonElement>('.markdown-preview > p > button')!;
  assert.ok(embed); assert.equal(math.pending.length, 1); assert.equal(workers.length, 1);
  ui.view.setDocument(CanvasDocument.parse(JSON.stringify({ nodes: [{ ...ui.document.nodes[0], text: '**fresh** ![[next]]' }], edges: [] })));
  assert.deepEqual(destroyed, ['embed']); assert.equal(workers[0].terminated, true); assert.equal(copy.onclick, null);
  math.resolve(0); workers[0].reply(); await tick(); embed.click();
  assert.deepEqual(opened, []); assert.equal(oldMath.querySelector('mjx-container'), null); assert.equal(oldCode.querySelector('.token-keyword'), null);
  assert.equal(ui.card().querySelector('strong')?.textContent, 'fresh');
  const next = ui.card().querySelector<HTMLButtonElement>('.markdown-preview button')!;
  ui.view.destroy(); ui.view.destroy(); next.click();
  assert.deepEqual(destroyed, ['embed', 'next']); assert.deepEqual(opened, []); assert.deepEqual(ui.saves, []);
});

test('rich card source edits, save failures, retry and undo retain the original Markdown and unknown data', async t => {
  let fail = true, calls = 0;
  const text = '**original**\r\n\r\n- item';
  const ui = setup(text, { onChange() { calls++; if (fail) throw new Error('write refused'); } }); t.after(ui.close);
  const input = await ui.edit(); assert.equal(input.state.doc.toString(), text.replace(/\r\n/g, '\n'));
  // The shared editor normalizes its document; entering and leaving must preserve untouched source bytes.
  await ui.view.flush(); assert.equal(ui.document.toString(), ui.source); assert.equal(calls, 0);
  const next = await ui.edit(); next.dispatch({ changes: { from: 0, to: next.state.doc.length, insert: '# Changed\n\n`literal`' }, annotations: Transaction.userEvent.of('input.type') });
  await assert.rejects(ui.view.flush(), /write refused/);
  assert.equal(next.state.doc.toString(), '# Changed\n\n`literal`'); assert.equal(ui.view.hasPendingChanges(), true);
  assert.equal(ui.document.getNode('text')?.text, '# Changed\n\n`literal`'); assert.deepEqual(ui.document.getNode('text')?.plugin, { keep: true });
  // Live input publishes immediately; flush may have retried an already failed synchronous write.
  const failedAttempts = calls; assert.ok(failedAttempts >= 1);
  fail = false; await ui.view.flush(); assert.equal(calls, failedAttempts + 1); assert.equal(ui.view.hasPendingChanges(), false);
  await ui.view.flush(); assert.equal(calls, failedAttempts + 1, 'a successful retry must not publish twice');
  ui.view.undo(); await ui.view.flush(); assert.equal(ui.document.toString(), ui.source); assert.equal(next.state.doc.toString(), text.replace(/\r\n/g, '\n'));
  next.contentDOM.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await tick(); assert.equal(ui.card().querySelector('strong')?.textContent, 'original');
});

test('Markdown links preserve target kinds, use external hook and refuse stale or destroyed owners', async t => {
  const opened: string[] = [], external: string[] = [];
  const ui = setup('[[Note#Section]] [relative](other.md) [outside](https://example.test/) [bad](javascript:bad)', { openMarkdownLink(target, kind) { opened.push(`${kind}:${target}`); }, openLink(target) { external.push(target); } }); t.after(ui.close);
  const anchors = [...ui.card().querySelectorAll<HTMLAnchorElement>('a')];
  anchors.forEach(anchor => anchor.click());
  assert.deepEqual(opened, ['wiki:Note#Section', 'markdown:other.md']); assert.deepEqual(external, ['https://example.test/']);
  anchors[0].dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true })); assert.equal(ui.card().querySelector('.cm-editor'), null);
  ui.document.setRoot('nodes', [{ ...ui.document.nodes[0], text: 'external replacement' }]); anchors.forEach(anchor => anchor.click());
  assert.equal(opened.length, 2); assert.equal(external.length, 1);
  ui.view.setDocument(CanvasDocument.parse(ui.source)); anchors.forEach(anchor => anchor.click()); assert.equal(opened.length, 2);
  const current = ui.card().querySelector<HTMLAnchorElement>('a')!; ui.view.destroy(); current.click(); assert.equal(opened.length, 2); assert.deepEqual(ui.saves, []);
});

test('unhandled external links retain browser defaults; internal links fall back to the file hook', t => {
  const files: string[] = [], ui = setup('[[Note#Heading]] [outside](https://example.test/)', { openFile(path, subpath) { files.push(path + (subpath ?? '')); } }); t.after(ui.close);
  ui.card().querySelector<HTMLAnchorElement>('.internal-link')!.click(); assert.deepEqual(files, ['Note#Heading']);
  let defaultAllowed = false;
  const external = ui.card().querySelector<HTMLAnchorElement>('.external-link')!;
  external.addEventListener('click', event => { defaultAllowed = !event.defaultPrevented; event.preventDefault(); }); external.click(); assert.equal(defaultAllowed, true);
});

test('failed embed construction disposes partial owners and preserves editable literal source', async t => {
  let disposed = 0, constructed = 0;
  const other = new JSDOM('<main></main>');
  const text = '![[first]] ![[broken]]', ui = setup(text, { renderMarkdownEmbed(request) { if (request.target === 'broken') throw new Error('embed failed'); constructed++; return { element: other.window.document.createElement('span'), destroy() { disposed++; } }; } });
  t.after(() => { ui.close(); other.window.close(); });
  assert.equal(disposed, 1); assert.equal(ui.card().querySelector('.zorid-canvas-note-preview')?.textContent, text); assert.equal(ui.errors.length, 1);
  assert.equal((await ui.edit()).state.doc.toString(), text); await ui.view.flush(); assert.equal(ui.document.toString(), ui.source);
  ui.view.destroy(); assert.equal(disposed, constructed, 'every successful preview and Live embed owner is released exactly once');
});

test('nested controls keep pointer, keyboard, double-click and wheel ownership while ordinary card content still drags', async t => {
  const other = new JSDOM('<main></main>');
  const ui = setup('![[controls]]\n\nOrdinary card text', { renderMarkdownEmbed() {
    const element = other.window.document.createElement('div');
    element.innerHTML = '<select><option>Zoom</option></select><div contenteditable="plaintext-only" tabindex="0"><span>Editable</span></div><video controls></video>';
    return { element, destroy() {} };
  } });
  t.after(() => { ui.close(); other.window.close(); });
  const viewport = ui.host.querySelector<HTMLElement>('.zorid-canvas-viewport')!;
  const originalTransform = ui.host.querySelector<HTMLElement>('.zorid-canvas-world')!.style.transform;
  for (const target of ui.card().querySelectorAll<HTMLElement>('select,[contenteditable] span,video')) {
    const focus = target.closest<HTMLElement>('[contenteditable]') ?? target; focus.focus();
    for (const event of [new ui.dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }), new ui.dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'z', ctrlKey: true }), new ui.dom.window.MouseEvent('dblclick', { bubbles: true, cancelable: true }), new ui.dom.window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 30 })]) {
      target.dispatchEvent(event); assert.equal(event.defaultPrevented, false);
    }
    assert.notEqual(ui.dom.window.document.activeElement, viewport, target.outerHTML); assert.equal(ui.card().querySelector('.cm-editor'), null);
    if (target.tagName !== 'VIDEO') {
      const context = new ui.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      target.dispatchEvent(context); assert.equal(context.defaultPrevented, false);
    }
  }
  assert.equal(ui.host.querySelector<HTMLElement>('.zorid-canvas-world')!.style.transform, originalTransform);
  const ordinary = ui.card().querySelectorAll('p')[1];
  const pointer = (target: Element, type: string, x: number) => { const event = new ui.dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x }); Object.defineProperty(event, 'pointerId', { value: 1 }); target.dispatchEvent(event); return event; };
  const oldCard = ui.card(); assert.equal(pointer(ordinary, 'pointerdown', 0).defaultPrevented, true);
  pointer(viewport, 'pointermove', 20); assert.equal(ui.card(), oldCard); assert.equal(ui.card().style.left, '20px'); pointer(viewport, 'pointerup', 20); await ui.view.flush();
  assert.equal(ui.document.getNode('text')?.x, 20); assert.equal(ui.saves.length, 1);
});

test('Canvas respects embed-prevented input even outside native controls', t => {
  const ui = setup('Plain card'); t.after(ui.close);
  const paragraph = ui.card().querySelector('p')!;
  for (const type of ['pointerdown', 'dblclick', 'keydown', 'wheel']) paragraph.addEventListener(type, event => event.preventDefault());
  paragraph.dispatchEvent(new ui.dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
  paragraph.dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  paragraph.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: ' ', ctrlKey: false }));
  const before = ui.host.querySelector<HTMLElement>('.zorid-canvas-world')!.style.transform;
  paragraph.dispatchEvent(new ui.dom.window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 20 }));
  assert.equal(ui.host.querySelector<HTMLElement>('.zorid-canvas-world')!.style.transform, before);
  assert.equal(ui.card().getAttribute('aria-selected'), 'false'); assert.equal(ui.card().querySelector('.cm-editor'), null); assert.deepEqual(ui.saves, []);
});
