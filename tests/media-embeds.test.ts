import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Vault } from '../src/core/vault.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import { MarkdownEmbeds } from '../src/ui/embeds.ts';
import { AttachmentResources } from '../src/ui/attachments.ts';
import type { AttachmentLease } from '../src/ui/attachments.ts';
import type { createMediaView } from '../src/ui/media-view.ts';
import { renderMarkdown } from '../src/ui/markdown.ts';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function setup(t: TestContext, seed: Record<string,string>, mediaFactory?: typeof createMediaView) {
  const dom = new JSDOM('<main></main>');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  dom.window.HTMLMediaElement.prototype.pause = function() {};
  dom.window.HTMLMediaElement.prototype.load = function() {};
  const vault = new Vault(new MemoryAdapter({ 'Home.md': '', 'Folder/Note.md': '', ...seed }));
  await vault.initialize();
  const resources = new AttachmentResources(vault), menus: Event[] = [];
  const embeds = new MarkdownEmbeds({ vault, resources, mediaFactory, open() {}, contextMenu(event) {
    menus.push(event); event.preventDefault();
  } });
  const container = dom.window.document.querySelector('main')!;
  t.after(() => {
    embeds.destroy(); resources.destroy(); dom.window.close();
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
  });
  return { dom, vault, resources, embeds, container, menus };
}

test('wiki and encoded relative Markdown syntax map all thirteen local formats into media views', async t => {
  const extensions = ['mp3','wav','m4a','3gp','flac','ogg','oga','opus','mp4','webm','ogv','mov','mkv'];
  const seed = Object.fromEntries(extensions.map(extension => [`Folder/Clip One.${extension.toUpperCase()}`, 'bytes']));
  const calls: { node: HTMLElement; path: string; resources: unknown }[] = [];
  const f = await setup(t, seed, (node, path, resources) => { calls.push({ node, path, resources }); return { ready: Promise.resolve(), destroy() {} }; });
  let acquisitions = 0; f.resources.acquire = async () => { acquisitions++; throw new Error('outer lease'); };
  const text = extensions.map((extension,index) => index % 2
    ? `![Caption|320x180](./Clip%20One.${extension.toUpperCase()})`
    : `![[Folder/Clip One.${extension.toUpperCase()}|Caption|320x180]]`).join('\n\n');
  renderMarkdown(f.container, text, () => {}, undefined, { embed: request => f.embeds.render(request, 'Folder/Note.md') });
  assert.deepEqual(calls.map(call => call.path), Object.keys(seed));
  assert.equal(acquisitions, 0);
  calls.forEach((call,index) => {
    assert.equal(call.resources, f.resources);
    assert.equal(call.node.getAttribute('width'), '320'); assert.equal(call.node.getAttribute('height'), '180');
    assert.equal(call.node.getAttribute('alt'), 'Caption');
    assert.ok(call.node.classList.contains(index < 8 ? 'audio-embed' : 'video-embed'));
    assert.equal(call.node.querySelector('.embed-open'), null);
  });
});

test('refresh destroys old handle before replacement, and releasing a widget leaves its sibling live', async t => {
  const order: string[] = [], calls: { destroyed: number }[] = [];
  const f = await setup(t, { 'sound.wav': '' }, () => {
    const index = calls.length, call = { destroyed: 0 }; calls.push(call); order.push(`mount${index}`);
    return { ready: Promise.resolve(), destroy() { call.destroyed++; order.push(`destroy${index}`); } };
  });
  const first = f.embeds.render({ target: 'sound.wav', kind: 'wiki' }, 'Home.md');
  const second = f.embeds.render({ target: './sound.wav', kind: 'markdown' }, 'Home.md');
  f.container.append(first,second);
  await f.vault.modifyBinary('sound.wav', Uint8Array.of(1));
  assert.deepEqual(order, ['mount0','mount1','destroy0','mount2','destroy1','mount3']);
  f.embeds.releaseEmbed(first); f.embeds.releaseEmbed(first);
  assert.equal(calls[2].destroyed, 1); assert.equal(calls[3].destroyed, 0);
  f.embeds.destroy(); assert.equal(calls[3].destroyed, 1); assert.equal(calls[2].destroyed, 1);
});

test('actual media views release deferred obsolete reads and never mount after widget release', async t => {
  const f = await setup(t, { 'sound.wav': '' });
  const pending: ((lease: AttachmentLease) => void)[] = [], released: number[] = [];
  f.resources.acquire = () => new Promise(resolve => pending.push(resolve));
  const node = f.embeds.render({ target: 'sound.wav', kind: 'wiki' }, 'Home.md'); f.container.append(node);
  await tick(); assert.equal(pending.length, 1);
  f.embeds.invalidate('sound.wav'); await tick(); assert.equal(pending.length, 2);
  pending[0]({ url: 'blob:old', type: 'audio/wav', release() { released.push(0); } }); await tick();
  assert.deepEqual(released, [0]); assert.equal(node.querySelector('audio'), null);
  pending[1]({ url: 'blob:current', type: 'audio/wav', release() { released.push(1); } }); await tick();
  assert.equal(node.querySelector('audio')!.getAttribute('src'), 'blob:current');
  f.embeds.invalidate('sound.wav'); await tick();
  assert.deepEqual(released, [0,1]);
  f.embeds.releaseEmbed(node);
  pending[2]({ url: 'blob:late', type: 'audio/wav', release() { released.push(2); } }); await tick();
  assert.deepEqual(released, [0,1,2]); assert.equal(node.querySelector('audio'), null);
  assert.equal(node.querySelector('.embed-error'), null);
});

test('native media context menu keeps its default action and does not reach file or editor menus', async t => {
  const f = await setup(t, { 'sound.wav': '', 'clip.mp4': '' });
  f.resources.acquire = async () => ({ url: 'blob:media', type: 'audio/wav', release() {} });
  let editorMenus = 0; f.container.addEventListener('contextmenu', () => { editorMenus++; });
  for (const path of ['sound.wav','clip.mp4']) {
    const node = f.embeds.render({ target: path, kind: 'wiki' }, 'Home.md'); f.container.append(node); await tick();
    const native = new f.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    node.querySelector('audio,video')!.dispatchEvent(native);
    assert.equal(native.defaultPrevented, false);
    assert.equal(f.menus.length, 0); assert.equal(editorMenus, 0);
  }
  const wrapper = new f.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  f.container.querySelector('.internal-embed')!.dispatchEvent(wrapper);
  assert.equal(wrapper.defaultPrevented, true); assert.equal(f.menus.length, 1);
});

test('external Markdown remains an image while unsupported and missing local files retain fallbacks', async t => {
  let calls = 0;
  const f = await setup(t, { 'unknown.bin': '' }, () => { calls++; return { ready: Promise.resolve(), destroy() {} }; });
  const external = f.embeds.render({ target: 'https://example.invalid/movie.mp4', kind: 'markdown' }, 'Home.md');
  const unknown = f.embeds.render({ target: 'unknown.bin', kind: 'wiki' }, 'Home.md');
  const missing = f.embeds.render({ target: 'missing.wav', kind: 'wiki' }, 'Home.md');
  await tick();
  assert.ok(external.querySelector('img')); assert.equal(external.querySelector('video'), null);
  assert.match(unknown.textContent!, /not implemented/); assert.match(missing.textContent!, /File not found/);
  assert.equal(calls, 0);
});

test('parent note replacement and media deletion destroy nested media without stale error publication', async t => {
  const calls: { destroyed: number; reject: (error: Error) => void }[] = [];
  const f = await setup(t, { 'Note.md': '![[sound.wav]]', 'sound.wav': '' }, () => {
    let reject!: (error: Error) => void;
    const ready = new Promise<void>((_resolve, failure) => { reject = failure; });
    const call = { destroyed: 0, reject }; calls.push(call);
    return { ready, destroy() { call.destroyed++; } };
  });
  const parent = f.embeds.render({ target: 'Note', kind: 'wiki' }, 'Home.md'); f.container.append(parent); await tick();
  assert.equal(calls.length, 1);
  await f.vault.modify('Note.md', 'Replacement'); await tick();
  assert.equal(calls[0].destroyed, 1); calls[0].reject(new Error('stale read')); await tick();
  assert.equal(parent.querySelector('.embed-error'), null); assert.match(parent.textContent!, /Replacement/);
  const media = f.embeds.render({ target: 'sound.wav', kind: 'wiki', label: '320x180' }, 'Home.md');
  await f.vault.trash('sound.wav');
  assert.equal(calls[1].destroyed, 1); assert.match(media.textContent!, /File not found/);
  assert.equal(media.hasAttribute('width'), false); assert.equal(media.hasAttribute('height'), false);
  calls[1].reject(new Error('deleted read')); await tick(); assert.equal(media.querySelectorAll('.embed-error').length, 1);
});

test('factory failures produce one local error without invoking image or PDF paths', async t => {
  const f = await setup(t, { 'sound.wav': '' }, () => { throw new Error('Media factory failed'); });
  const node = f.embeds.render({ target: 'sound.wav', kind: 'wiki' }, 'Home.md');
  assert.equal(node.querySelectorAll('.embed-error').length, 1);
  assert.match(node.textContent!, /Media factory failed/);
  assert.equal(node.querySelector('img, iframe'), null);
});
