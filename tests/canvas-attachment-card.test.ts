import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { canvasAttachmentKind, createCanvasAttachmentCard } from '../src/canvas/attachment-card.ts';
import type { CanvasAttachmentCardOptions } from '../src/canvas/attachment-card.ts';
import type { AttachmentLease, AttachmentResources } from '../src/ui/attachments.ts';
import type { PdfViewOptions, PdfView } from '../src/ui/pdf-view.ts';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture() {
  const dom = new JSDOM('<main></main>'); const parent = dom.window.document.querySelector('main')!;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  dom.window.HTMLMediaElement.prototype.pause = () => {};
  dom.window.HTMLMediaElement.prototype.load = () => {};
  let reads = 0, releases = 0;
  const resources = { acquire: async () => { reads++; return lease(); } } as unknown as AttachmentResources;
  const lease = (): AttachmentLease => ({ url: 'blob:canvas-fixture', type: 'image/png', arrayBuffer: async () => new ArrayBuffer(8), release() { releases++; } });
  return { dom, parent, resources, lease, get reads() { return reads; }, get releases() { return releases; }, close() { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); dom.window.close(); } };
}

test('classifies supported vault attachments without routing URLs or Markdown into engines', () => {
  for (const [path, expected] of [['A/P.PNG','image'],['Doc.PDF','pdf'],['song.flac','audio'],['clip.webm','video'],['photo#1.png','image'],['What? document.pdf','pdf']]) assert.equal(canvasAttachmentKind(path), expected);
  for (const path of ['https://host/a.png','file:///a.pdf','//host/a.mp4','/absolute.png','x.png?query','x.pdf#page=2','note.md','x.exe','']) assert.equal(canvasAttachmentKind(path), null);
});

test('fixed PDF geometry selectors outrank shared page-height rules regardless of stylesheet order', () => {
  const css = readFileSync(new URL('../src/canvas/attachment-card.css', import.meta.url), 'utf8');
  const dom = new JSDOM('<div class="canvas-attachment-card" data-kind="pdf"><div class="zorid-pdf-view is-embed has-page-height"><div class="zorid-pdf-stage" style="height:900px"></div></div></div>');
  try {
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)];
    for (const [target, required] of [['.zorid-pdf-view','height:100%'],['.zorid-pdf-stage','height:auto!important']] as const) {
      const rule = rules.find(([, selector, body]) => selector.includes('[data-kind=pdf]') && selector.trim().endsWith(target === '.zorid-pdf-view' ? '.is-embed' : target) && body.includes(required));
      assert.ok(rule, `missing scoped ${target} fixed geometry`);
      assert.ok(dom.window.document.querySelector(target)!.matches(rule[1].trim()));
      // Root shared rule has three classes; stage has four. Attribute adds one.
      assert.ok((rule[1].match(/\.[\w-]+|\[[^\]]+\]/g) ?? []).length > (target === '.zorid-pdf-view' ? 3 : 4));
    }
  } finally { dom.window.close(); }
});

test('real image viewer mounts one lease, fits geometry and cannot reopen a retained image after removal', async () => {
  const f = fixture(); const view = createCanvasAttachmentCard(f.parent, { path: 'picture.png', resources: f.resources });
  try {
    await view.ready; const image = view.element.querySelector('img')!;
    assert.equal(image.getAttribute('src'), 'blob:canvas-fixture'); assert.equal(f.reads, 1);
    view.resize(320, 180); assert.equal(view.element.style.width, '320px'); assert.equal(view.element.style.height, '180px');
    view.resize(NaN, -1); assert.equal(view.element.style.width, '320px');
    view.destroy(); view.destroy(); image.click(); await tick();
    assert.equal(f.releases, 1); assert.equal(f.reads, 1); assert.equal(f.parent.childElementCount, 0);
    assert.equal(f.dom.window.document.querySelector('.image-lightbox'), null);
    view.resize(500, 500); assert.equal(view.element.style.width, '320px');
  } finally { view.destroy(); f.close(); }
});

for (const [path, tag] of [['audio.wav','audio'],['movie.mp4','video']] as const) test(`real shared ${tag} uses one lease and native controls without autoplay`, async () => {
  const f = fixture(); const view = createCanvasAttachmentCard(f.parent, { path, resources: f.resources });
  try {
    await tick(); const media = view.element.querySelector(tag)!;
    assert.equal(media.controls, true); assert.equal(media.autoplay, false); assert.equal(f.reads, 1);
    if (tag === 'video') { Object.defineProperty(media, 'videoWidth', { value: 640 }); Object.defineProperty(media, 'videoHeight', { value: 480 }); }
    media.dispatchEvent(new f.dom.window.Event('loadedmetadata')); await view.ready;
    view.destroy(); assert.equal(media.hasAttribute('src'), false); assert.equal(f.releases, 1);
  } finally { view.destroy(); f.close(); }
});

test('PDF delegates byte acquisition, fixed embed sizing, fragment, mobile and initialization to shared factory', async () => {
  const f = fixture(); const pending = deferred<void>(); let configuration!: PdfViewOptions, release!: () => void, destroys = 0;
  const pdfFactory: NonNullable<CanvasAttachmentCardOptions['pdfFactory']> = (parent, path, resources, options) => {
    assert.equal(path, 'document.pdf'); assert.ok(parent.classList.contains('canvas-attachment-content')); configuration = options!;
    void resources.acquire(path).then(lease => { release = lease.release; });
    return { ready: pending.promise, destroy() { destroys++; release?.(); } } as PdfView;
  };
  const view = createCanvasAttachmentCard(f.parent, { path: 'document.pdf', subpath: '#page=2', resources: f.resources, pdfFactory, mobile: true });
  try {
    await tick(); assert.equal(f.reads, 1); assert.equal(configuration.embed, true); assert.equal(configuration.height, 'auto');
    assert.equal(configuration.subpath, '#page=2'); assert.equal(configuration.mobile, true);
    let ready = false; void view.ready.then(() => { ready = true; }); await tick(); assert.equal(ready, false);
    pending.resolve(); await view.ready; view.destroy(); view.destroy(); assert.equal(destroys, 1); assert.equal(f.releases, 1);
  } finally { view.destroy(); f.close(); }
});

test('destroy settles readiness immediately and releases a late resource without resurrecting the old card', async () => {
  const f = fixture(); const request = deferred<AttachmentLease>();
  const view = createCanvasAttachmentCard(f.parent, { path: 'old.png', resources: { acquire: () => request.promise } as unknown as AttachmentResources });
  try {
    const oldImage = view.element.querySelector('img')!; view.destroy(); await view.ready;
    request.resolve(f.lease()); await tick(); assert.equal(f.releases, 1); assert.equal(oldImage.hasAttribute('src'), false); assert.equal(f.parent.childElementCount, 0);
  } finally { view.destroy(); f.close(); }
});

test('old request failure stays silent after replacement while current failure is visible', async () => {
  const f = fixture(); const old = deferred<AttachmentLease>(); const errors: unknown[] = [];
  const view = createCanvasAttachmentCard(f.parent, { path: 'old.png', resources: { acquire: () => old.promise } as unknown as AttachmentResources, onError: error => errors.push(error) });
  view.destroy();
  const current = createCanvasAttachmentCard(f.parent, { path: 'new.png', resources: { acquire: async () => { throw new Error('File is missing'); } } as unknown as AttachmentResources, onError: error => errors.push(error) });
  try {
    old.reject(new Error('Stale failure')); await current.ready; await tick();
    assert.equal(errors.length, 1); assert.match(current.element.textContent!, /File is missing/);
    assert.doesNotMatch(f.parent.textContent!, /Stale failure/);
  } finally { current.destroy(); f.close(); }
});

test('open callback preserves fragment and retained controls become inert after destroy', async () => {
  const f = fixture(); const opened: unknown[] = [];
  const view = createCanvasAttachmentCard(f.parent, { path: 'image.png', subpath: '#detail', resources: f.resources, openFile: (...args) => { opened.push(args); } });
  try {
    await view.ready; const button = view.element.querySelector('button')!;
    button.click(); assert.deepEqual(opened, [['image.png','#detail']]); view.destroy(); button.click(); assert.equal(opened.length, 1);
  } finally { view.destroy(); f.close(); }
});

test('unsupported files fail visibly without reading vault bytes', async () => {
  const f = fixture(); const view = createCanvasAttachmentCard(f.parent, { path: 'archive.zip', resources: f.resources });
  try { await view.ready; assert.equal(f.reads, 0); assert.match(view.element.textContent!, /cannot be displayed/); }
  finally { view.destroy(); f.close(); }
});

test('destroy while PDF engine initializes settles card and ignores a late initialization error', async () => {
  const f = fixture(); const loading = deferred<void>(); const errors: unknown[] = []; let destroys = 0;
  const view = createCanvasAttachmentCard(f.parent, { path: 'doc.pdf', resources: f.resources, onError: error => errors.push(error), pdfFactory: () => ({ ready: loading.promise, destroy() { destroys++; } }) as PdfView });
  try { view.destroy(); await view.ready; loading.reject(new Error('Late engine error')); await tick(); assert.equal(destroys, 1); assert.deepEqual(errors, []); }
  finally { view.destroy(); f.close(); }
});

test('factory failure releases late acquisitions even when host diagnostics throw', async () => {
  const f = fixture(); const pending = deferred<AttachmentLease>(); let childRead!: Promise<AttachmentLease>;
  const view = createCanvasAttachmentCard(f.parent, { path: 'doc.pdf', resources: { acquire: () => pending.promise } as unknown as AttachmentResources,
    pdfFactory(_parent, path, resources) { childRead = resources.acquire(path); throw new Error('Construction failed'); },
    onError() { throw new Error('Host reporter failed'); },
  });
  try {
    await view.ready; assert.match(view.element.textContent!, /Construction failed/);
    const rejection = assert.rejects(childRead, { name: 'AbortError' }); pending.resolve(f.lease()); await rejection;
    assert.equal(f.releases, 1);
  } finally { view.destroy(); f.close(); }
});

test('fresh transferable bytes cannot escape after their card is destroyed', async () => {
  const f = fixture(); const bytes = deferred<ArrayBuffer>(); let leased!: AttachmentLease;
  const view = createCanvasAttachmentCard(f.parent, { path: 'doc.pdf', resources: { acquire: async () => ({ ...f.lease(), arrayBuffer: () => bytes.promise }) } as unknown as AttachmentResources,
    pdfFactory(_parent, path, resources) { return { ready: resources.acquire(path).then(value => { leased = value; }), destroy() {} } as PdfView; },
  });
  try {
    await view.ready; const result = leased.arrayBuffer!(); view.destroy(); bytes.resolve(new ArrayBuffer(4));
    await assert.rejects(result, { name: 'AbortError' }); assert.equal(f.releases, 1);
  } finally { view.destroy(); f.close(); }
});
