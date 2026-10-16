import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorView } from '@codemirror/view';
import { undo, redo } from '@codemirror/commands';
import { createEditor } from '../src/ui/editor.ts';
import { createMediaView } from '../src/ui/media-view.ts';
import type { AttachmentLease } from '../src/ui/attachments.ts';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function setup(t: TestContext, source: string, deferred = false) {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Text: dom.window.Text, Window: dom.window.Window,
    MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  dom.window.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0, toJSON() {} });
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  // Browser media decoding/geometry is outside these DOM/state lifecycle probes.
  dom.window.HTMLMediaElement.prototype.pause = () => {};
  dom.window.HTMLMediaElement.prototype.load = () => {};
  const host = document.querySelector<HTMLElement>('main')!;
  const leases: { releases: number; lease: AttachmentLease }[] = [];
  const pending: (() => void)[] = [];
  const editor = createEditor(host, { value: source, mode: 'live', paths: () => [], open() {}, onChange() {}, renderEmbed(request) {
    const node = document.createElement('span'); node.className = 'internal-embed media-embed audio-embed';
    const media = createMediaView(node, request.target, { acquire: async path => {
      assert.equal(path, 'tone.wav');
      const record = { releases: 0, lease: { url: `blob:audio-${leases.length}`, type: 'audio/wav', release() { record.releases++; } } }; leases.push(record);
      if (deferred) await new Promise<void>(resolve => pending.push(resolve));
      return record.lease;
    } });
    return { dom: node, destroy() { media.destroy(); } };
  } });
  const view = EditorView.findFromDOM(host.querySelector('.cm-editor')!)!;
  let destroyed = false; const destroy = () => { if (!destroyed) { destroyed = true; editor.destroy(); } };
  t.after(() => { destroy(); dom.window.close(); for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  } });
  const key = (name: string, position: number) => {
    view.focus(); view.dispatch({ selection: { anchor: position } });
    const event = new dom.window.KeyboardEvent('keydown', { key: name, code: name, bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
  };
  return { dom, host, editor, view, leases, pending, destroy, key };
}

for (const prefix of ['# Heading', 'Prose']) for (const gap of ['\n', '\n\n']) for (const key of ['Backspace', 'Delete']) {
  test(`${key} across ${gap.length === 1 ? 'joined' : 'blank'} ${prefix.startsWith('#') ? 'heading' : 'prose'} boundary balances actual media leases`, async t => {
    const source = prefix + gap + '![[tone.wav]]\n\nTail';
    const f = setup(t, source); await tick();
    const offset = prefix.length + gap.length - 1;
    const expected = source.slice(0, offset) + source.slice(offset + 1);
    f.key(key, key === 'Backspace' ? offset + 1 : offset); await tick();
    assert.equal(f.editor.getValue(), expected);
    assert.equal(f.host.querySelectorAll('audio[controls]').length, 1);
    assert.equal(f.leases.filter(record => record.releases === 0).length, 1);
    assert.ok(undo(f.view)); await tick(); assert.equal(f.editor.getValue(), source);
    assert.equal(f.host.querySelectorAll('audio[controls]').length, 1);
    assert.ok(redo(f.view)); await tick(); assert.equal(f.editor.getValue(), expected);
    assert.equal(f.host.querySelectorAll('audio[controls]').length, 1);
    assert.equal(f.leases.filter(record => record.releases === 0).length, 1);
    f.destroy(); assert.ok(f.leases.length > 0); assert.ok(f.leases.every(record => record.releases === 1));
  });
}

test('rapid audio boundary delete and undo release obsolete deferred leases without stale players', async t => {
  const source = '# Heading\n![[tone.wav]]\n\nTail';
  const f = setup(t, source, true); await tick();
  f.key('Backspace', source.indexOf('!')); await tick();
  assert.ok(undo(f.view)); await tick();
  assert.equal(f.editor.getValue(), source);
  assert.ok(f.pending.length >= 2, 'boundary transition acquired replacement media owners');
  for (const resolve of f.pending) resolve(); await tick(); await tick();
  assert.equal(f.host.querySelectorAll('audio[controls]').length, 1);
  assert.equal(f.leases.filter(record => record.releases === 0).length, 1);
  assert.ok(f.leases.every(record => record.releases <= 1));
  f.destroy(); assert.ok(f.leases.every(record => record.releases === 1));
});
