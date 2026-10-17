import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { Compartment, EditorState, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { history, redo, undo } from '@codemirror/commands';
import { liveEmbeds } from '../src/editor/live-embeds.ts';
import { createEditor } from '../src/ui/editor.ts';
import type { EmbedRequest } from '../src/ui/markdown.ts';

// These tests exercise real CM fields/widgets/lifecycle. jsdom geometry cannot
// certify native pointer coordinates, image sizing, IME, or visual parity.
function setup(t: TestContext, source: string, integrated = false) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div>', { pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const observers: { target?: Element; disconnected: boolean; callback: () => void }[] = [];
  const mutations: { target?: Node; options?: MutationObserverInit; disconnected: boolean; calls: number }[] = [];
  const NativeMutationObserver = dom.window.MutationObserver;
  class TrackingMutationObserver extends NativeMutationObserver {
    item: typeof mutations[number];
    constructor(callback: MutationCallback) {
      const item = { disconnected: false, calls: 0 };
      super((records, observer) => { item.calls++; callback(records, observer); });
      this.item = item; mutations.push(item);
    }
    observe(target: Node, options?: MutationObserverInit) { this.item.target = target; this.item.options = options; super.observe(target, options); }
    disconnect() { this.item.disconnected = true; super.disconnect(); }
  }
  dom.window.MutationObserver = TrackingMutationObserver;

  class TestResizeObserver {
    item: typeof observers[number];
    constructor(callback: () => void) { this.item = { callback, disconnected: false }; observers.push(this.item); }
    observe(target: Element) { this.item.target = target; }
    unobserve() {}
    disconnect() { this.item.disconnected = true; }
  }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    Text: dom.window.Text, Window: dom.window.Window, MutationObserver: dom.window.MutationObserver,
    ResizeObserver: TestResizeObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} });
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const renders: { request: EmbedRequest; node: HTMLElement; destroys: number }[] = [];
  const compartment = new Compartment();
  const renderer = (request: EmbedRequest) => {
    const node = document.createElement('span'); node.textContent = `Rendered ${request.target}`;
    if (request.target.endsWith('.wav')) {
      node.className = 'internal-embed media-embed audio-embed';
      const media = document.createElement('div'); media.className = 'zorid-media-view media-embed audio-embed';
      const audio = document.createElement('audio'); audio.controls = true; media.append(audio); node.append(media);
    }
    const link = document.createElement('a'); link.href = '#'; link.textContent = 'Open'; node.append(link);
    const record = { request, node, destroys: 0 }; renders.push(record);
    return { dom: node, destroy() { record.destroys++; } };
  };
  const extension = liveEmbeds(renderer);
  const host = document.querySelector<HTMLElement>('#host')!;
  const editor = integrated ? createEditor(host, { value: source, mode: 'live', paths: () => [], open() {}, onChange() {}, renderEmbed: renderer }) : undefined;
  const view = editor ? EditorView.findFromDOM(host.querySelector('.cm-editor')!)! : new EditorView({ parent: host, state: EditorState.create({ doc: source,
    extensions: [markdown({ base: markdownLanguage }), history(), compartment.of(extension)] }) });
  let closed = false;
  const destroy = () => { if (!closed) { closed = true; if (editor) editor.destroy(); else view.destroy(); } };
  t.after(() => {
    destroy(); dom.window.close();
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
  });
  const click = (node: Element) => node.dispatchEvent(new dom.window.MouseEvent('click', { button: 0, bubbles: true, cancelable: true }));
  return { view, host, renders, destroy, compartment, extension, click, observers, mutations, dom };
}

test('whole-line and inline embeds render without altering the Markdown document', t => {
  const source = 'before\n  ![[note#Heading|Title]]  \na ![a label|200](<images/a b.png> "title") z\nafter';
  const { view, host, renders } = setup(t, source);
  assert.deepEqual(renders.map(item => item.request), [
    { kind: 'wiki', target: 'note#Heading', label: 'Title' },
    { kind: 'markdown', target: 'images/a b.png', label: 'a label|200' },
  ]);
  assert.equal(host.querySelectorAll('.cm-live-embed-block').length, 1);
  assert.equal(host.querySelectorAll('.cm-live-embed-inline').length, 1);
  assert.equal(view.state.doc.toString(), source);
  assert.equal(host.querySelector('.cm-live-embed-block')?.tagName, 'DIV');
});

test('language-owned code, tables, properties and escaped syntax stay out of embed widgets', t => {
  const source = '---\ncover: "![[property.png]]"\n---\n`![[inline.png]]`\n```md\n![[fenced.png]]\n```\n\n    ![[indented.png]]\n\n| A | B |\n| --- | --- |\n| ![[table.png]] | x |\n\n\\![[escaped.png]] \\![alt](escaped.png)\n\\\\![[real.png]]\n![ref][target]\n\n[target]: ref.png';
  const { renders, view } = setup(t, source);
  assert.deepEqual(renders.map(item => item.request.target), ['real.png']);
  assert.equal(view.state.doc.toString(), source);
});

test('unchanged widgets survive cursor movement and edits that move their source positions', t => {
  const source = 'before\n![[photo.png]]\nafter';
  const { view, host, renders } = setup(t, source);
  const widget = host.querySelector('.cm-live-embed');
  view.dispatch({ selection: { anchor: source.length } });
  view.dispatch({ changes: { from: 0, insert: 'prefix\n' } });
  assert.equal(host.querySelector('.cm-live-embed'), widget);
  assert.equal(renders.length, 1);
  assert.equal(renders[0].destroys, 0);
  view.dispatch({ selection: { anchor: 0 } });
  assert.equal(host.querySelector('.cm-live-embed'), widget);
});

test('source action selects mapped syntax and keeps the same rendered instance through reveal and rehide', t => {
  const { view, host, renders, click } = setup(t, 'before\n![[photo.png]]\nafter');
  view.dispatch({ changes: { from: 0, insert: 'prefix\n' } });
  const text = view.state.doc.toString(), start = text.indexOf('![[');
  const widget = host.querySelector('.cm-live-embed')!;
  click(host.querySelector('.cm-live-embed-edit')!);
  assert.equal(view.state.selection.main.from, start);
  assert.equal(view.state.selection.main.to, start + '![[photo.png]]'.length);
  assert.equal(host.querySelector('.cm-live-embed'), widget);
  assert.equal(renders[0].destroys, 0);
  assert.match(view.contentDOM.textContent!, /!\[\[photo\.png\]\]/);
  assert.equal(view.state.doc.toString(), text);
  view.dispatch({ selection: { anchor: 0 } });
  assert.equal(host.querySelector('.cm-live-embed'), widget);
  assert.equal(renders.length, 1);
  assert.doesNotMatch(view.contentDOM.textContent!, /!\[\[photo\.png\]\]/);
});

test('generic widget click reveals source but interactive child clicks keep their own behavior', t => {
  const { view, host, renders, click } = setup(t, 'before\n![[Note]]\nafter');
  let opens = 0;
  const link = renders[0].node.querySelector('a')!;
  link.addEventListener('click', event => { event.preventDefault(); opens++; });
  click(link);
  assert.equal(opens, 1);
  assert.equal(view.state.selection.main.from, 0);
  assert.ok(host.querySelector('.cm-live-embed'));
  click(renders[0].node);
  assert.equal(view.state.selection.main.from, 'before\n'.length);
  assert.ok(host.querySelector('.cm-live-embed'));
  assert.match(view.contentDOM.textContent!, /!\[\[Note\]\]/);
});

test('changing/removing embeds releases each mounted renderer once and undo remounts safely', t => {
  const source = 'before\n![[one.png]]\nafter';
  const { view, renders, destroy } = setup(t, source);
  const start = source.indexOf('one');
  view.dispatch({ changes: { from: start, to: start + 3, insert: 'two' }, userEvent: 'input' });
  assert.equal(renders[0].destroys, 1);
  assert.equal(renders[1].request.target, 'two.png');
  assert.equal(undo(view), true);
  assert.equal(view.state.doc.toString(), source);
  assert.equal(renders[1].destroys, 1);
  assert.equal(renders.at(-1)!.request.target, 'one.png');
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'empty' } });
  assert.ok(renders.every(item => item.destroys === 1));
  destroy();
  assert.ok(renders.every(item => item.destroys === 1));
});

test('resize measurements and renderer leases end on extension removal and editor destruction', t => {
  const { view, renders, observers, compartment, extension, destroy } = setup(t, '![[image.png]]');
  const observer = observers.find(item => item.target?.classList.contains('cm-live-embed'))!;
  assert.ok(observer);
  let measures = 0;
  const original = view.requestMeasure.bind(view);
  view.requestMeasure = request => { measures++; original(request); };
  observer.callback();
  assert.equal(measures, 1);
  view.dispatch({ effects: compartment.reconfigure([]) });
  assert.equal(observer.disconnected, true);
  assert.equal(renders[0].destroys, 1);
  const after = measures; observer.callback(); assert.equal(measures, after);
  view.dispatch({ effects: compartment.reconfigure(extension) });
  assert.equal(renders.length, 2);
  destroy();
  assert.equal(renders[1].destroys, 1);
});

test('editing revealed syntax preserves source mode until the selection leaves the embed', t => {
  const { view, host, click, renders } = setup(t, '![[old.png]]\nend');
  click(host.querySelector('.cm-live-embed-edit')!);
  view.dispatch({ changes: { from: 3, to: 6, insert: 'new' }, selection: { anchor: 6 } });
  assert.ok(host.querySelector('.cm-live-embed'));
  assert.equal(renders[0].destroys, 1);
  assert.equal(renders.at(-1)!.request.target, 'new.png');
  assert.match(view.contentDOM.textContent!, /!\[\[new\.png\]\]/);
  assert.equal(view.state.doc.toString(), '![[new.png]]\nend');
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  assert.equal(renders.at(-1)!.request.target, 'new.png');
});

test('duplicate targets keep distinct renderer ownership and click ranges after insertion', t => {
  const source = 'start\n![[same.png]]\nend';
  const { view, host, renders, click } = setup(t, source);
  const original = host.querySelector('.cm-live-embed')!;
  view.dispatch({ changes: { from: 0, insert: '![[same.png]]\n' } });
  assert.equal(renders.length, 2);
  assert.equal(renders[0].destroys, 0);
  assert.equal(host.querySelectorAll('.cm-live-embed')[1], original);
  click(original.querySelector('.cm-live-embed-edit')!);
  assert.equal(view.state.selection.main.from, view.state.doc.toString().lastIndexOf('![['));
  assert.equal(renders[0].destroys, 0);
  assert.equal(renders[1].destroys, 0);
});

test('embedded images with their own click handlers retain lightbox interaction', t => {
  const { host, renders, click, view } = setup(t, 'start\n![[image.png]]\nend');
  const img = document.createElement('img');
  let opened = 0; img.onclick = () => { opened++; };
  renders[0].node.append(img);
  click(img);
  assert.equal(opened, 1);
  assert.ok(host.querySelector('.cm-live-embed'));
  assert.equal(view.state.selection.main.from, 0);
});

test('HTML comments, tag attributes, link destinations and unsupported images exclude nested wiki syntax', t => {
  const source = '<!-- ![[comment.png]] -->\n\ntext <span title="![[attribute.png]]">body</span>\n\n'
    + '[link](path/![[destination.png]])\n\n<https://example.test/![[autolink.png]]>\n\n'
    + '![![[reference.png]]][ref]\n\n[ref]: path.png\n\n![![[nested.png]]](outer.png)\n\n![[visible.png]]';
  const { renders } = setup(t, source);
  assert.deepEqual(renders.map(item => item.request.target), ['outer.png', 'visible.png']);
});

test('merging source ranges does not transfer revealed ownership to the resulting embed', t => {
  const source = '![[first]] tail ![[second]]\nend';
  const { view, host, click, renders } = setup(t, source);
  click(host.querySelector('.cm-live-embed-edit')!);
  assert.equal(host.querySelectorAll('.cm-live-embed').length, 2);
  view.dispatch({ changes: { from: source.indexOf(']]'), to: source.indexOf('second') },
    selection: { anchor: 4 } });
  assert.equal(view.state.doc.toString(), '![[firstsecond]]\nend');
  assert.equal(host.querySelectorAll('.cm-live-embed').length, 1);
  assert.equal(renders.at(-1)!.request.target, 'firstsecond');
  assert.ok(renders.slice(0, -1).every(item => item.destroys === 1));
});

test('nested editors, interactive regions and native controls preserve pointer behavior', t => {
  const { view, host, renders, click } = setup(t, 'start\n![[note]]\nend');
  for (const markup of ['<div class="cm-editor"><span>nested editor</span></div>',
    '<div class="interactive-child"><span>custom control</span></div>',
    '<details><summary>details</summary></details>',
    '<div contenteditable=""><span>editable</span></div>']) {
    const container = document.createElement('span'); container.innerHTML = markup;
    renders[0].node.append(container);
    const target = container.querySelector('span, summary')!;
    const down = new window.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true });
    target.dispatchEvent(down);
    assert.equal(down.defaultPrevented, false);
    click(target);
    assert.equal(view.state.selection.main.from, 0);
    assert.ok(host.querySelector('.cm-live-embed'));
  }
});

test('removed widgets cannot dispatch source edits through retained DOM references', t => {
  const { view, host, click, compartment, renders } = setup(t, '![[note]]\nend');
  const wrapper = host.querySelector('.cm-live-embed')!;
  const action = wrapper.querySelector('button')!;
  view.dispatch({ effects: compartment.reconfigure([]), selection: { anchor: view.state.doc.length } });
  click(action); click(wrapper);
  assert.equal(view.state.selection.main.from, view.state.doc.length);
  assert.equal(renders[0].destroys, 1);
});

for (const syntax of ['![[Note#Heading]]', '![[image.png|240]]', '![alt](image.png)', '![[document.pdf#page=2]]', '![[board.canvas]]']) {
  test(`source reveal preserves the rendered child and editable DOM offsets for ${syntax}`, t => {
    const source = `before\n${syntax}\nafter`;
    const { view, host, renders, click, destroy } = setup(t, source);
    const widget = host.querySelector('.cm-live-embed')!, child = renders[0].node;
    // Stand in for state owned by a nested note/PDF/Canvas/image renderer.
    child.dataset.retainedState = 'page-or-pan-or-selection';
    click(widget.querySelector('.cm-live-embed-edit')!);
    const position = source.indexOf(syntax) + 4;
    view.dispatch({ selection: { anchor: position } });
    const point = view.domAtPos(position);
    assert.equal(view.posAtDOM(point.node, point.offset), position);
    assert.equal((point.node.nodeType === 1 ? point.node as Element : point.node.parentElement)!.closest('.cm-live-embed'), null);
    assert.equal(host.querySelector('.cm-live-embed'), widget);
    assert.equal(widget.contains(child), true);
    assert.equal(child.dataset.retainedState, 'page-or-pan-or-selection');
    assert.equal(view.contentDOM.querySelector('.cm-line')?.nextElementSibling?.textContent, syntax);
    assert.equal(renders.length, 1);
    assert.equal(renders[0].destroys, 0);
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    assert.equal(host.querySelector('.cm-live-embed'), widget);
    assert.equal(renders.length, 1);
    assert.equal(view.state.doc.toString(), source);
    destroy(); assert.equal(renders[0].destroys, 1);
  });
}

test('inline reveal leaves source before the same point widget and hides only source on exit', t => {
  const source = 'before ![[Note]] after\nend';
  const { view, host, renders, click } = setup(t, source);
  const widget = host.querySelector('.cm-live-embed')!;
  click(widget.querySelector('.cm-live-embed-edit')!);
  assert.equal(widget.parentElement?.classList.contains('cm-line'), true);
  assert.match(widget.parentElement!.textContent!, /^before !\[\[Note\]\]Rendered Note/);
  assert.match(widget.parentElement!.textContent!, / after$/);
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  assert.equal(host.querySelector('.cm-live-embed'), widget);
  assert.doesNotMatch(widget.parentElement!.textContent!, /!\[\[Note\]\]/);
  assert.equal(renders.length, 1);
});

test('editing revealed source remaps the caret, updates target and does not remount again on rehide', t => {
  const source = 'start\n![[old.pdf#page=2]]\nend';
  const { view, host, renders, click } = setup(t, source);
  click(host.querySelector('.cm-live-embed-edit')!);
  const from = source.indexOf('old');
  view.dispatch({ changes: { from, to: from + 3, insert: 'new-long' }, selection: { anchor: from + 8 }, userEvent: 'input' });
  assert.equal(view.state.doc.toString(), source.replace('old', 'new-long'));
  assert.equal(view.state.selection.main.head, from + 8);
  const point = view.domAtPos(from + 8);
  assert.equal(view.posAtDOM(point.node, point.offset), from + 8);
  assert.equal(renders.length, 2); assert.equal(renders[0].destroys, 1);
  assert.equal(renders[1].request.target, 'new-long.pdf#page=2');
  const replacement = host.querySelector('.cm-live-embed');
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  assert.equal(host.querySelector('.cm-live-embed'), replacement);
  assert.equal(renders.length, 2); assert.equal(renders[1].destroys, 0);
});

const mediaFixture = '# Media verification\n\n![[Native media tone.wav]]\n\nAfter audio.\n';
for (const line of [2, 4]) for (const key of ['Backspace', 'Delete']) test(`actual editor ${key} on blank line ${line} preserves media source and balanced rendered ownership`, async t => {
  const { view, host, renders, dom } = setup(t, mediaFixture, true);
  const position = view.state.doc.line(line).from;
  view.focus(); view.dispatch({ selection: { anchor: position } }); await Promise.resolve();
  const event = new dom.window.KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true });
  view.contentDOM.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  const removed = key === 'Backspace' ? position - 1 : position;
  assert.equal(view.state.doc.toString(), mediaFixture.slice(0, removed) + mediaFixture.slice(removed + 1));
  assert.ok(host.querySelector('.cm-live-embed'), 'media remains rendered');
  assert.ok(host.querySelector('audio[controls]'));
  assert.equal(renders.filter(record => record.destroys === 0).length, 1);
  assert.ok(renders.every(record => record.destroys <= 1));
  assert.equal(undo(view), true); assert.equal(view.state.doc.toString(), mediaFixture);
  assert.ok(host.querySelector('audio[controls]'));
  assert.equal(redo(view), true); assert.ok(host.querySelector('audio[controls]'));
  assert.equal(renders.filter(record => record.destroys === 0).length, 1);
});

for (const prefix of ['# Media verification', 'Media verification']) for (const key of ['Backspace', 'Delete']) test(`actual editor ${key} joining audio to ${prefix.startsWith('#') ? 'heading' : 'prose'} retains embed source and controls`, async t => {
  const source = prefix + '\n![[Native media tone.wav]]\n\nAfter audio.\n';
  const { view, host, renders, dom } = setup(t, source, true);
  const position = key === 'Backspace' ? view.state.doc.line(2).from : view.state.doc.line(1).to;
  view.focus(); view.dispatch({ selection: { anchor: position } }); await Promise.resolve();
  view.contentDOM.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
  assert.equal(view.state.doc.toString(), source.replace('verification\n', 'verification'));
  assert.ok(host.querySelector('.cm-live-embed-inline'), 'joined source still renders its embed');
  assert.equal(renders.at(-1)!.request.target, 'Native media tone.wav');
  assert.equal(renders.at(-1)!.destroys, 0);
  assert.ok(host.querySelector('.cm-live-embed-inline audio[controls]'));
  assert.equal(renders.filter(record => record.destroys === 0).length, 1);
  assert.equal(undo(view), true); assert.equal(view.state.doc.toString(), source);
  assert.ok(host.querySelector('.cm-live-embed-block audio[controls]'));
  assert.equal(redo(view), true); assert.ok(host.querySelector('.cm-live-embed-inline audio[controls]'));
  assert.equal(renders.filter(record => record.destroys === 0).length, 1);
});


test('inline audio gets available width while image embeds keep their existing sizing rules', t => {
  const { view, host, renders } = setup(t, 'Text ![[Native media tone.wav]] and ![[image.png|240]]', true);
  const style = document.createElement('style'); style.textContent = readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8'); document.head.append(style);
  const audio = host.querySelector<HTMLElement>('.cm-live-embed-inline:has(.audio-embed)')!;
  const imageRecord = renders.find(record => record.request.target === 'image.png')!;
  const image = document.createElement('img'); image.width = 240; imageRecord.node.append(image);
  const imageWrapper = image.closest<HTMLElement>('.cm-live-embed-inline')!;
  assert.equal(getComputedStyle(audio).width, '100%'); assert.equal(getComputedStyle(audio).maxWidth, '100%');
  assert.notEqual(getComputedStyle(imageWrapper).width, '100%'); assert.equal(image.getAttribute('width'), '240');
  assert.equal(view.state.doc.toString(), 'Text ![[Native media tone.wav]] and ![[image.png|240]]');
});

for (const inline of [false, true]) test(`actual editor ${inline ? 'inline' : 'block'} audio hides the edit overlay and source reveal retains its owner`, t => {
  const source = `${inline ? 'Audio ' : ''}![[Native media tone.wav]]\n\nAfter audio.`;
  const { view, host, renders, dom, click } = setup(t, source, true);
  const style = document.createElement('style');
  style.textContent = readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8') + readFileSync(new URL('../src/ui/media-view.css', import.meta.url), 'utf8');
  document.head.append(style);
  const wrapper = host.querySelector<HTMLElement>('.cm-live-embed')!;
  const owner = renders[0], audio = wrapper.querySelector('audio')!;
  assert.equal(wrapper.querySelector('.cm-live-embed-edit'), null, 'audio does not construct a source overlay');
  assert.equal(getComputedStyle(owner.node).display, 'block');
  if (inline) assert.equal(getComputedStyle(wrapper).width, '100%');
  else { assert.equal(getComputedStyle(wrapper).paddingTop, '0px'); assert.equal(getComputedStyle(wrapper).paddingBottom, '0px'); }
  assert.equal(getComputedStyle(audio).height, '42px'); assert.equal(getComputedStyle(audio).width, '100%');
  view.dispatch({ selection: { anchor: source.length } });
  const nativeClick = new dom.window.MouseEvent('click', { button: 0, bubbles: true, cancelable: true });
  audio.dispatchEvent(nativeClick);
  assert.equal(nativeClick.defaultPrevented, false); assert.equal(view.state.selection.main.head, source.length);
  click(wrapper);
  assert.equal(view.state.doc.sliceString(view.state.selection.main.from, view.state.selection.main.to), '![[Native media tone.wav]]');
  assert.ok(view.contentDOM.textContent?.includes('![[Native media tone.wav]]'));
  assert.equal(host.querySelector('audio'), audio, 'source reveal preserves the native player');
  assert.equal(renders.length, 1); assert.equal(owner.destroys, 0); assert.equal(view.state.doc.toString(), source);
});

test('audio overlay rules preserve image, PDF and enclosing note actions', t => {
  const { host, renders } = setup(t, '![[photo.png]]\n\n![[paper.pdf]]\n\n![[Note]]', true);
  const style = document.createElement('style'); style.textContent = readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8'); document.head.append(style);
  renders[0].node.className = 'internal-embed image-embed';
  renders[1].node.className = 'internal-embed pdf-embed';
  renders[2].node.className = 'internal-embed markdown-embed';
  const nested = document.createElement('div'); nested.className = 'audio-embed'; renders[2].node.append(nested);
  for (const wrapper of host.querySelectorAll<HTMLElement>('.cm-live-embed-block')) {
    assert.notEqual(getComputedStyle(wrapper.querySelector('button')!).display, 'none');
    assert.equal(getComputedStyle(wrapper).paddingTop, '12px'); assert.equal(getComputedStyle(wrapper).paddingBottom, '12px');
  }
});


const settleControls = async () => { await Promise.resolve(); await Promise.resolve(); };
function installEmbedCSS() {
  const style = document.createElement('style');
  style.textContent = readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
  document.head.append(style);
}

test('resolved video removes generic source action without intercepting native controls or replacing renderer', async t => {
  const source = 'before\n![[movie.mp4]]\nafter';
  const { host, renders, click, view } = setup(t, source, true);
  const root = renders[0].node, wrapper = root.parentElement!;
  root.className = 'internal-embed media-embed video-embed';
  const video = document.createElement('video'); video.controls = true; root.replaceChildren(video);
  await settleControls();
  assert.equal(wrapper.dataset.embedType, 'video');
  assert.equal(wrapper.querySelector('.cm-live-embed-edit'), null);
  assert.equal(click(video), true, 'native default remains available');
  assert.equal(view.state.selection.main.from, 0);
  click(root);
  assert.equal(view.state.selection.main.from, source.indexOf('![['));
  assert.equal(root.parentElement, wrapper); assert.equal(renders[0].destroys, 0);
  assert.equal(view.state.doc.toString(), source);
});

test('note Open link reuses navigation capability and invalidates retained links after replacement and teardown', async t => {
  const { host, renders, view, click, destroy } = setup(t, 'before\n![[Note]]\nafter', true);
  const root = renders[0].node, wrapper = root.parentElement!;
  let opened = 0;
  const makeLink = () => {
    const link = document.createElement('a'); link.className = 'embed-open'; link.href = '#note';
    link.onclick = event => { event.preventDefault(); opened++; }; return link;
  };
  const first = makeLink(); root.className = 'internal-embed markdown-embed'; root.replaceChildren(first);
  await settleControls();
  assert.equal(wrapper.querySelector('.cm-live-embed-edit'), null);
  assert.equal(first.getAttribute('aria-label'), 'Open link'); assert.ok(first.querySelector('svg'));
  click(first); assert.equal(opened, 1); assert.equal(view.state.selection.main.from, 0);
  const second = makeLink(); root.replaceChildren(second);
  click(first); assert.equal(opened, 1, 'detached link cannot navigate before observer delivery');
  await settleControls(); click(second); assert.equal(opened, 2);
  click(root); assert.equal(view.state.selection.main.from, 7); assert.equal(renders[0].destroys, 0);
  destroy(); assert.equal(click(second), false, 'retained anchor default navigation is suppressed'); assert.equal(opened, 2); assert.equal(renders[0].destroys, 1);
  assert.equal(host.querySelector('.cm-live-embed'), null);
});

test('PDF source action reserves toolbar space and reveals syntax without replacing the viewer', async t => {
  const { renders, click, view } = setup(t, 'before\n![[file.pdf]]\nafter', true);
  installEmbedCSS();
  const root = renders[0].node, wrapper = root.parentElement!;
  root.className = 'internal-embed pdf-embed';
  const viewer = document.createElement('div'); viewer.className = 'zorid-pdf-view';
  const toolbar = document.createElement('div'); toolbar.className = 'zorid-pdf-toolbar';
  const open = document.createElement('button'); open.textContent = 'Open PDF';
  let opens = 0; open.onclick = () => { opens++; }; toolbar.append(open); viewer.append(toolbar); root.replaceChildren(viewer);
  await settleControls();
  const action = wrapper.querySelector<HTMLElement>('.cm-live-embed-edit')!;
  assert.equal(getComputedStyle(action).opacity, '1'); assert.equal(getComputedStyle(action).top, '6px');
  assert.equal(getComputedStyle(action).insetInlineEnd, '4px'); assert.equal(getComputedStyle(toolbar).paddingInlineEnd, '36px');
  assert.equal(getComputedStyle(wrapper).paddingTop, '0px');
  click(open); assert.equal(opens, 1); assert.equal(view.state.selection.main.from, 0);
  click(action); assert.equal(view.state.selection.main.from, 7);
  assert.equal(root.firstElementChild, viewer); assert.equal(renders[0].destroys, 0);
});

test('actual Bases and Canvas capabilities differ from unsupported extension fallbacks', async t => {
  const { renders, click, view } = setup(t, 'before\n![[data.base]]\n![[board.canvas]]\nafter', true);
  const base = renders[0].node, canvas = renders[1].node;
  for (const root of [base, canvas]) {
    root.className = 'internal-embed markdown-embed';
    const error = document.createElement('div'); error.className = 'embed-error'; root.replaceChildren(error);
  }
  await settleControls();
  for (const root of [base, canvas]) {
    assert.equal(root.parentElement!.dataset.embedType, 'unavailable');
    assert.ok(root.parentElement!.querySelector('.cm-live-embed-edit'));
  }
  base.className = 'internal-embed bases-embed'; base.replaceChildren(document.createElement('div'));
  canvas.className = 'internal-embed canvas-embed'; canvas.replaceChildren(document.createElement('div'));
  await settleControls();
  assert.equal(base.parentElement!.dataset.embedType, 'base');
  assert.ok(base.parentElement!.querySelector('.cm-live-embed-edit'));
  assert.equal(canvas.parentElement!.dataset.embedType, 'canvas');
  assert.equal(canvas.parentElement!.querySelector('.cm-live-embed-edit'), null);
  click(base.parentElement!.querySelector('.cm-live-embed-edit')!);
  assert.equal(view.state.selection.main.from, 7); assert.ok(renders.every(item => item.destroys === 0));
});

test('async control observer is shallow, does not observe its own actions, and disconnects before renderer release', async t => {
  const { renders, mutations, destroy, click, view } = setup(t, 'before\n![[late]]\nafter', true);
  const root = renders[0].node, wrapper = root.parentElement!;
  const observer = mutations.find(item => item.target === root)!;
  assert.deepEqual(observer.options, { attributes: true, attributeFilter: ['class'], childList: true });
  const loading = document.createElement('span'); loading.className = 'embed-loading'; root.replaceChildren(loading);
  await settleControls(); assert.equal(wrapper.dataset.embedType, 'loading'); assert.equal(wrapper.querySelector('button'), null);
  root.className = 'internal-embed pdf-embed'; const body = document.createElement('div'); root.replaceChildren(body);
  await settleControls(); const count = observer.calls;
  body.append(document.createElement('div')); body.className = 'nested-content';
  await settleControls(); assert.equal(observer.calls, count, 'nested render churn is not observed');
  const action = wrapper.querySelector('.cm-live-embed-edit')!;
  assert.ok(action); await settleControls(); assert.equal(observer.calls, count, 'own controls do not create observer feedback');
  destroy(); assert.equal(observer.disconnected, true); assert.equal(renders[0].destroys, 1);
  const selection = view.state.selection.main.from; click(action); assert.equal(view.state.selection.main.from, selection);
  root.className = 'audio-embed'; root.replaceChildren(document.createElement('audio'));
  await settleControls(); assert.equal(observer.calls, count); assert.equal(wrapper.dataset.embedType, 'pdf');
});


test('same note anchor recovers after loading and preserves fallback navigation after asynchronous failure', async t => {
  const { renders, click, destroy } = setup(t, 'before\n![[Note]]\nafter', true);
  const root = renders[0].node;
  const link = document.createElement('a'); link.className = 'embed-open'; link.href = '#Note'; link.textContent = 'Note';
  link.title = 'Original title'; link.setAttribute('aria-label', 'Open Note');
  let opened = 0; link.onclick = event => { event.preventDefault(); opened++; };
  root.className = 'markdown-embed'; root.replaceChildren(link); await settleControls();
  click(link); assert.equal(opened, 1);
  const loading = document.createElement('span'); loading.className = 'embed-loading'; root.append(loading); await settleControls();
  assert.equal(click(link), false); assert.equal(opened, 1);
  loading.remove(); await settleControls(); click(link); assert.equal(opened, 2);
  const error = document.createElement('span'); error.className = 'embed-error'; root.append(error); await settleControls();
  assert.equal(root.parentElement!.dataset.embedType, 'unavailable');
  assert.equal(link.textContent, 'Note'); assert.equal(link.title, 'Original title'); assert.equal(link.getAttribute('aria-label'), 'Open Note');
  assert.equal(link.classList.contains('cm-live-embed-open'), false);
  click(link); assert.equal(opened, 3);
  error.remove(); await settleControls(); assert.equal(link.getAttribute('aria-label'), 'Open link'); click(link); assert.equal(opened, 4);
  destroy(); assert.equal(click(link), false); assert.equal(opened, 4);
});


test('typed renderer failure exposes fallback source action but nested viewer errors keep viewer policy', async t => {
  const { renders, click, view } = setup(t, 'before\n![[sound.wav]]\nafter', true);
  const root = renders[0].node, wrapper = root.parentElement!;
  const error = document.createElement('span'); error.className = 'embed-error';
  root.querySelector('div')!.append(error); await settleControls();
  assert.equal(wrapper.dataset.embedType, 'audio'); assert.equal(wrapper.querySelector('.cm-live-embed-edit'), null);
  root.append(error); await settleControls();
  assert.equal(wrapper.dataset.embedType, 'unavailable');
  click(wrapper.querySelector('.cm-live-embed-edit')!); assert.equal(view.state.selection.main.from, 7);
  assert.equal(renders[0].destroys, 0);
});

async function resolveTestImage(root: HTMLElement) {
  root.className = 'internal-embed image-embed';
  const image = document.createElement('img'); image.alt = 'Owned image';
  Object.defineProperty(image, 'offsetWidth', { value: 240 });
  let zooms = 0; image.onclick = () => { zooms++; };
  root.replaceChildren(image); await settleControls();
  return { image, zooms: () => zooms };
}

test('actual image first click selects source-start without reveal; selected click zooms and editor movement clears selection', async t => {
  const source = 'before\n![[photo.png|240]]\nafter';
  const { renders, click, view, host } = setup(t, source, true);
  const root = renders[0].node, { image, zooms } = await resolveTestImage(root);
  assert.equal(root.parentElement!.querySelector('.cm-live-embed-edit'), null);
  click(image);
  assert.equal(zooms(), 0); assert.equal(view.state.selection.main.from, 7); assert.equal(view.state.selection.main.empty, true);
  assert.equal(root.classList.contains('zorid-image-selected'), true);
  assert.doesNotMatch(view.contentDOM.textContent!, /!\[\[/);
  click(image); assert.equal(zooms(), 1);
  view.dispatch({ selection: { anchor: 7 + '![[photo.png|240]]'.length } });
  assert.equal(root.classList.contains('zorid-image-selected'), true, 'image end retains selected identity');
  view.dispatch({ selection: { anchor: source.length } });
  assert.equal(root.classList.contains('zorid-image-selected'), false);
  click(image); assert.equal(zooms(), 1); assert.equal(root.classList.contains('zorid-image-selected'), true);
  host.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(root.classList.contains('zorid-image-selected'), false);
  assert.equal(renders[0].destroys, 0);
});

for (const [syntax, target] of [
  ['![[  photo.png#part |240]]', 'photo.png#part'],
  ['![label](<images/photo one.png> "caption")', 'images/photo one.png'],
  ['![label](images/photo.png)', 'images/photo.png'],
]) test(`image source action selects only mapped target in ${syntax}`, async t => {
  const { renders, click, view } = setup(t, `before\n${syntax}\nafter`, true);
  const root = renders[0].node; await resolveTestImage(root);
  view.dispatch({ changes: { from: 0, insert: 'prefix\n' } });
  const wrapper = root.parentElement!;
  click(root.querySelector('[aria-label="Edit image source"]')!);
  assert.equal(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to), target);
  assert.equal(view.state.selection.main.from, view.state.doc.toString().indexOf(target));
  assert.equal(root.classList.contains('zorid-image-selected'), true);
  assert.equal(root.parentElement, wrapper); assert.equal(renders.length, 1); assert.equal(renders[0].destroys, 0);
  assert.ok(view.contentDOM.textContent!.includes(syntax));
  view.dispatch({ selection: { anchor: 0 } });
  assert.equal(root.classList.contains('zorid-image-selected'), false);
  assert.equal(root.parentElement, wrapper); assert.equal(renders[0].destroys, 0);
});

test('image selection is exclusive per editor and follows identity through inserted source', async t => {
  const { renders, click, view } = setup(t, 'before\n![[one.png]]\n![[two.png]]\nafter', true);
  const first = await resolveTestImage(renders[0].node), second = await resolveTestImage(renders[1].node);
  click(first.image); assert.equal(renders[0].node.classList.contains('zorid-image-selected'), true);
  view.dispatch({ changes: { from: 0, insert: 'prefix\n' } });
  assert.equal(renders[0].node.classList.contains('zorid-image-selected'), true);
  click(second.image);
  assert.equal(renders[0].node.classList.contains('zorid-image-selected'), false);
  assert.equal(renders[1].node.classList.contains('zorid-image-selected'), true);
  assert.equal(view.state.selection.main.from, view.state.doc.toString().indexOf('![[two'));
  assert.ok(renders.every(record => record.destroys === 0));
});

test('image helpers end before renderer release and do not survive type changes or editor destruction', async t => {
  const { renders, click, view, destroy, mutations } = setup(t, 'before\n![[photo.png]]\nafter', true);
  const root = renders[0].node; const { image } = await resolveTestImage(root);
  click(image);
  const source = root.querySelector('[aria-label="Edit image source"]')!;
  const imageObserver = mutations.find(item => item.target === root && !item.options?.attributes)!;
  assert.ok(imageObserver);
  root.className = 'internal-embed media-embed audio-embed'; root.replaceChildren(document.createElement('audio'));
  await settleControls();
  assert.equal(imageObserver.disconnected, true); assert.equal(root.querySelector('.zorid-image-embed-actions'), null);
  const selected = view.state.selection.main.from; click(source); assert.equal(view.state.selection.main.from, selected);
  await resolveTestImage(root); assert.equal(root.querySelectorAll('.zorid-image-embed-actions').length, 1);
  assert.equal(root.classList.contains('zorid-image-selected'), false, 'definitive type change does not resurrect selected-image state');
  const secondObserver = mutations.filter(item => item.target === root && !item.options?.attributes).at(-1)!;
  destroy(); assert.equal(secondObserver.disconnected, true); assert.equal(renders[0].destroys, 1);
  assert.equal(root.querySelector('.zorid-image-embed-actions'), null);
  document.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
});

async function resizeFixture(t: TestContext, source: string) {
  const f = setup(t, source, true), root = f.renders[0].node;
  const { image } = await resolveTestImage(root);
  Object.defineProperties(image, { offsetHeight: { value: 120 }, clientWidth: { get: () => image.width || 240 } });
  Object.defineProperty(f.view.contentDOM, 'offsetWidth', { value: 600 });
  image.getBoundingClientRect = () => ({ x: 10, y: 20, left: 10, top: 20, right: 250, bottom: 140, width: 240, height: 120, toJSON() {} });
  const corner = root.querySelector('.zorid-image-resize-corner')!;
  const pointer = (type: string, x = 250, y = 140) => {
    const event = new f.dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } });
    (type === 'pointerdown' ? corner : document).dispatchEvent(event);
  };
  const frame = () => new Promise<void>(resolve => f.dom.window.requestAnimationFrame(() => resolve()));
  const reset = () => corner.dispatchEvent(new f.dom.window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  return { ...f, root, image, pointer, frame, reset };
}

for (const [syntax, resized, reset] of [
  ['![[photo.png]]', '![[photo.png|300]]', '![[photo.png]]'],
  ['![[photo.png|Description|240x120]]', '![[photo.png|Description|300]]', '![[photo.png|Description]]'],
  ['![Description|240x120](<photo one.png> "caption")', '![Description|300](<photo one.png> "caption")', '![Description](<photo one.png> "caption")'],
  ['![240](photo.png)', '![300](photo.png)', '![](photo.png)'],
]) test(`image resize maps source, keeps aliases and titles, and isolates undo for ${syntax}`, async t => {
  const original = `before\n${syntax}\nafter`;
  const f = await resizeFixture(t, original);
  f.pointer('pointerdown'); f.pointer('pointermove', 310, 170); await f.frame();
  assert.equal(f.image.width, 300); assert.equal(f.view.state.doc.toString(), original);
  assert.equal(f.renders[0].destroys, 0, 'preview retains original renderer');
  f.view.dispatch({ changes: { from: 0, insert: 'prefix\n' } });
  f.pointer('pointerup');
  assert.equal(f.view.state.doc.toString(), `prefix\nbefore\n${resized}\nafter`);
  assert.equal(f.renders[0].destroys, 1, 'one committed syntax change releases the superseded renderer');
  assert.equal(undo(f.view), true); assert.equal(f.view.state.doc.toString(), `prefix\n${original}`);
  assert.equal(redo(f.view), true); assert.equal(f.view.state.doc.toString(), `prefix\nbefore\n${resized}\nafter`);
  // A fresh actual image after undo/redo receives a fresh resize owner.
  const current = f.renders.at(-1)!.node; await resolveTestImage(current);
  current.querySelector('.zorid-image-resize-corner')!.dispatchEvent(new f.dom.window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  assert.equal(f.view.state.doc.toString(), `prefix\nbefore\n${reset}\nafter`);
});

for (const mode of ['cancel', 'source edit', 'delete', 'destroy']) test(`image resize ${mode} cannot commit stale source`, async t => {
  const original = 'before\n![[photo.png|caption]]\nafter';
  const f = await resizeFixture(t, original);
  f.pointer('pointerdown'); f.pointer('pointermove', 310, 170); await f.frame();
  if (mode === 'cancel') f.pointer('pointercancel');
  else if (mode === 'source edit') f.view.dispatch({ changes: { from: original.indexOf('caption'), to: original.indexOf('caption') + 7, insert: 'edited caption' } });
  else if (mode === 'delete') f.view.dispatch({ changes: { from: 7, to: original.indexOf('\nafter'), insert: '' } });
  else f.destroy();
  const expected = f.view.state.doc.toString(); f.pointer('pointerup'); await f.frame();
  assert.equal(f.view.state.doc.toString(), expected);
  assert.equal(f.image.hasAttribute('width'), false);
});

test('reset without size is a no-op and preserves an empty wiki alias delimiter', async t => {
  const source = 'before\n![[photo.png|]]\nafter';
  const f = await resizeFixture(t, source); f.reset();
  assert.equal(f.view.state.doc.toString(), source); assert.equal(f.renders[0].destroys, 0);
});


for (const timing of ['before', 'during']) test(`read-only ${timing} resizing cannot mutate Markdown`, async t => {
  const source = 'before\n![[photo.png]]\nafter', f = await resizeFixture(t, source);
  const readOnly = () => f.view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
  if (timing === 'before') readOnly();
  f.pointer('pointerdown'); f.pointer('pointermove', 310, 170); await f.frame();
  if (timing === 'during') readOnly();
  f.pointer('pointerup'); f.reset();
  assert.equal(f.view.state.doc.toString(), source); assert.equal(f.image.hasAttribute('width'), false);
});

test('Markdown escaped size delimiter resets to valid image syntax', async t => {
  const f = await resizeFixture(t, String.raw`before
![caption\|240](photo.png)
after`);
  f.reset(); assert.equal(f.view.state.doc.toString(), 'before\n![caption](photo.png)\nafter');
  assert.equal(f.renders.at(-1)!.request.target, 'photo.png'); assert.equal(f.renders.at(-1)!.request.label, 'caption');
});
