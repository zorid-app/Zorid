import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { Compartment, EditorState } from '@codemirror/state';
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
  return { view, host, renders, destroy, compartment, extension, click, observers, dom };
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
