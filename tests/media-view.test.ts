import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createMediaView, mediaKind } from '../src/ui/media-view.ts';
import { AttachmentResources, attachmentType } from '../src/ui/attachments.ts';
import type { AttachmentLease } from '../src/ui/attachments.ts';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const dom = new JSDOM('<main><span>Host content</span></main>');
  const doc = dom.window.document, parent = doc.querySelector('main')!;
  const calls: { action: string; element: HTMLMediaElement }[] = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let nextTimer = 0;
  dom.window.setTimeout = ((callback: () => void, delay: number) => {
    const id = ++nextTimer; timers.set(id, { callback, delay }); return id;
  }) as typeof dom.window.setTimeout;
  dom.window.clearTimeout = (id: number) => { timers.delete(id); };
  dom.window.HTMLMediaElement.prototype.pause = function() { calls.push({ action: 'pause', element: this }); };
  dom.window.HTMLMediaElement.prototype.load = function() { calls.push({ action: 'load', element: this }); };
  let releases = 0;
  const lease: AttachmentLease = { url: 'blob:original-media', type: 'audio/wav', release() { releases++; } };
  return { dom, doc, parent, calls, timers, lease, get releases() { return releases; },
    resources: { acquire: async (_path: string) => lease }, close() { dom.window.close(); } };
}
function metadata(f: ReturnType<typeof fixture>, element: HTMLMediaElement, width?: number, height?: number) {
  if (width !== undefined) Object.defineProperty(element, 'videoWidth', { configurable: true, value: width });
  if (height !== undefined) Object.defineProperty(element, 'videoHeight', { configurable: true, value: height });
  element.dispatchEvent(new f.dom.window.Event('loadedmetadata'));
}

test('routes all thirteen local formats case-insensitively and rejects remote/unknown destinations', () => {
  for (const extension of ['mp3','wav','m4a','3gp','flac','ogg','oga','opus']) {
    assert.equal(mediaKind(`Folder/recording.${extension.toUpperCase()}`), 'audio');
    assert.ok(attachmentType(`recording.${extension}`).startsWith('audio/'));
  }
  for (const extension of ['mp4','webm','ogv','mov','mkv']) {
    assert.equal(mediaKind(`Folder/clip.${extension.toUpperCase()}`), 'video');
    assert.ok(attachmentType(`clip.${extension}`).startsWith('video/'));
  }
  for (const path of ['https://host/movie.mp4','file:///movie.mp4','//host/movie.mp4','data:audio/wav,a.wav','note.md','clip.avi','.mp3','folder/.mp3','clip.mp4#t=20','clip.mp4?download=1']) assert.equal(mediaKind(path), null);
  const f = fixture();
  try {
    assert.throws(() => createMediaView(f.parent, 'https://host/movie.mp4', { acquire() { assert.fail('remote acquisition'); } }), /local audio or video/);
    assert.equal(f.parent.childElementCount, 1);
  } finally { f.close(); }
});

test('audio uses destination document/native controls and settles metadata without autoplay', async () => {
  const f = fixture(), view = createMediaView(f.parent, 'Unicode/🎵 café.wav', f.resources);
  try {
    await tick();
    const audio = f.parent.querySelector('audio')!;
    assert.equal(audio.ownerDocument, f.doc);
    assert.equal(audio.controls, true);
    assert.equal(audio.getAttribute('controlsList'), 'nodownload');
    assert.equal(audio.getAttribute('aria-label'), '🎵 café.wav');
    assert.equal(audio.autoplay, false); assert.equal(audio.loop, false);
    assert.equal(audio.getAttribute('src'), 'blob:original-media');
    assert.equal([...f.timers.values()][0].delay, 5000);
    metadata(f, audio); await view.ready;
    assert.equal(f.timers.size, 0);
    assert.equal(f.parent.querySelector<HTMLElement>('.zorid-media-status')!.hidden, true);
    assert.equal(f.releases, 0);
    view.destroy(); view.destroy();
    assert.equal(f.releases, 1);
    assert.deepEqual(f.calls.map(call => call.action), ['pause','load']);
    assert.equal(audio.hasAttribute('src'), false); assert.equal(audio.srcObject, null);
    assert.equal(f.parent.textContent, 'Host content');
  } finally { view.destroy(); f.close(); }
});

test('video starts at metadata preload and restores height on actual video metadata', async () => {
  const f = fixture(), view = createMediaView(f.parent, 'clip.webm', f.resources);
  try {
    await tick(); const video = f.parent.querySelector('video')!;
    assert.equal(video.controls, true); assert.equal(video.preload, 'metadata');
    assert.equal(video.getAttribute('src'), 'blob:original-media#t=0.001');
    assert.equal(video.style.height, '0px');
    assert.equal(video.autoplay, false); assert.equal(video.hasAttribute('width'), false);
    metadata(f, video, 640, 480); await view.ready;
    assert.equal(video.style.height, ''); assert.equal(f.parent.querySelector('audio'), null);
  } finally { view.destroy(); f.close(); }
});

test('zero-dimension video falls back to audio with the same live lease', async () => {
  const f = fixture(); let acquisitions = 0;
  const view = createMediaView(f.parent, 'audio-only.mp4', { acquire: async () => { acquisitions++; return f.lease; } });
  try {
    await tick(); const video = f.parent.querySelector('video')!;
    metadata(f, video, 0, 0);
    const audio = f.parent.querySelector('audio')!;
    assert.equal(video.isConnected, false); assert.equal(video.hasAttribute('src'), false);
    assert.equal(audio.getAttribute('src'), f.lease.url);
    assert.equal(f.releases, 0); assert.equal(acquisitions, 1);
    video.dispatchEvent(new f.dom.window.Event('error'));
    assert.equal(f.parent.querySelector('.is-error'), null);
    metadata(f, audio); await view.ready;
    view.destroy(); assert.equal(f.releases, 1);
  } finally { view.destroy(); f.close(); }
});

test('timeout settles readiness and late metadata can still switch an audio-only video', async () => {
  const f = fixture(), view = createMediaView(f.parent, 'slow.mp4', f.resources);
  try {
    await tick(); const video = f.parent.querySelector('video')!;
    [...f.timers.values()][0].callback(); await view.ready;
    assert.equal(video.style.height, ''); assert.equal(f.timers.size, 0);
    metadata(f, video, 0, 0);
    assert.ok(f.parent.querySelector('audio'));
    assert.equal(f.releases, 0);
  } finally { view.destroy(); f.close(); }
});

test('native decoder error and failed acquisition settle with bounded error UI', async () => {
  const f = fixture(), view = createMediaView(f.parent, 'broken.wav', f.resources);
  try {
    await tick(); f.parent.querySelector('audio')!.dispatchEvent(new f.dom.window.Event('error'));
    await view.ready;
    assert.equal(f.parent.querySelector('.zorid-media-status')!.textContent, 'Unable to play this media.');
    assert.equal(f.timers.size, 0); assert.equal(f.parent.querySelectorAll('.zorid-media-status').length, 1);
    view.destroy();
    const failed = createMediaView(f.parent, 'denied.wav', { acquire: async () => { throw new Error('Permission denied'); } });
    await failed.ready;
    assert.equal(f.parent.querySelector('.zorid-media-status')!.textContent, 'Permission denied');
    failed.destroy();
  } finally { view.destroy(); f.close(); }
});

test('destroy settles immediately while a delayed read releases its eventual lease without DOM', async () => {
  const f = fixture(); let finish!: (lease: AttachmentLease) => void;
  const pending = new Promise<AttachmentLease>(resolve => { finish = resolve; });
  const view = createMediaView(f.parent, 'late.wav', { acquire: () => pending });
  try {
    await tick(); view.destroy(); await view.ready;
    assert.equal(f.parent.querySelector('.zorid-media-view'), null);
    finish(f.lease); await tick();
    assert.equal(f.releases, 1); assert.equal(f.timers.size, 0); assert.equal(f.calls.length, 0);
    view.destroy(); assert.equal(f.releases, 1);
    let reads = 0;
    const closed = createMediaView(f.parent, 'never.wav', { acquire: async () => { reads++; return f.lease; } });
    closed.destroy(); await closed.ready; await tick(); assert.equal(reads, 0);
  } finally { view.destroy(); f.close(); }
});

test('stale events cannot change a replacement view, and reset precedes lease release', async () => {
  const f = fixture(); let old!: HTMLMediaElement, released = 0;
  const first = createMediaView(f.parent, 'old.mp4', { acquire: async () => ({...f.lease, release() {
    released++; assert.equal(old.hasAttribute('src'), false); assert.equal(old.srcObject, null);
    assert.ok(f.calls.some(call => call.element === old && call.action === 'load'));
  }}) });
  try {
    await tick(); old = f.parent.querySelector('video')!; first.destroy();
    const replacement = createMediaView(f.parent, 'new.wav', f.resources);
    await tick(); old.dispatchEvent(new f.dom.window.Event('error')); metadata(f, old, 0, 0);
    assert.equal(f.parent.querySelectorAll('audio').length, 1); assert.equal(f.parent.querySelector('.is-error'), null);
    metadata(f, f.parent.querySelector('audio')!); await replacement.ready;
    replacement.destroy(); assert.equal(released, 1);
  } finally { first.destroy(); f.close(); }
});

test('two players share real resource bytes until last release and modification creates a new source', async () => {
  const f = fixture(); let reads = 0, next = 0;
  const revoked: string[] = [];
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => `blob:shared-${++next}`;
  URL.revokeObjectURL = url => { revoked.push(url); };
  // Original minimal RIFF marker bytes; decoding is intentionally simulated by metadata events.
  const bytes = Uint8Array.of(82,73,70,70,0,0,0,0,87,65,86,69);
  const resources = new AttachmentResources({ on: () => () => {}, readBinary: async () => { reads++; return bytes; } } as never);
  const first = createMediaView(f.parent, 'sound.wav', resources), second = createMediaView(f.parent, 'sound.wav', resources);
  try {
    await tick(); assert.equal(reads, 1);
    const players = [...f.parent.querySelectorAll('audio')];
    assert.equal(players[0].src, players[1].src);
    first.destroy(); assert.deepEqual(revoked, []);
    resources.invalidate('sound.wav');
    const third = createMediaView(f.parent, 'sound.wav', resources);
    await tick(); assert.equal(reads, 2);
    assert.notEqual(f.parent.querySelectorAll('audio')[0].src, f.parent.querySelectorAll('audio')[1].src);
    second.destroy(); assert.deepEqual(revoked, ['blob:shared-1']);
    third.destroy(); assert.deepEqual(revoked, ['blob:shared-1','blob:shared-2']);
  } finally { first.destroy(); second.destroy(); resources.destroy(); URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; f.close(); }
});

test('media loading attributes settle on metadata, failure, timeout and pending-acquire disposal',async()=>{
  const f=fixture();
  try {
    const success=createMediaView(f.parent,'audio.wav',f.resources),root=f.parent.querySelector<HTMLElement>('.zorid-media-view')!;
    assert.equal(root.dataset.nativeLoading,'true');assert.equal(root.getAttribute('aria-busy'),'true');await tick();metadata(f,f.parent.querySelector('audio')!);await success.ready;
    assert.equal(root.hasAttribute('data-native-loading'),false);assert.equal(root.getAttribute('aria-busy'),'false');success.destroy();
    const failed=createMediaView(f.parent,'bad.wav',{acquire:async()=>{throw new Error('Missing bytes');}});const errorRoot=f.parent.querySelector<HTMLElement>('.zorid-media-view')!;await failed.ready;
    assert.equal(errorRoot.getAttribute('aria-busy'),'false');assert.match(errorRoot.textContent!,/Missing bytes/);failed.destroy();
    const timeout=createMediaView(f.parent,'slow.wav',f.resources),timeoutRoot=f.parent.querySelector<HTMLElement>('.zorid-media-view')!;await tick();
    [...f.timers.values()][0].callback();await timeout.ready;assert.equal(timeoutRoot.getAttribute('aria-busy'),'false');timeout.destroy();
    let resolve!:(lease:AttachmentLease)=>void;
    const late=createMediaView(f.parent,'late.wav',{acquire:()=>new Promise(r=>{resolve=r;})}),lateRoot=f.parent.querySelector<HTMLElement>('.zorid-media-view')!;await tick();late.destroy();resolve(f.lease);await tick();await late.ready;
    assert.equal(lateRoot.hasAttribute('data-native-loading'),false);assert.equal(lateRoot.getAttribute('aria-busy'),'false');assert.equal(f.parent.querySelector('.zorid-media-view'),null);
  } finally { f.close(); }
});
