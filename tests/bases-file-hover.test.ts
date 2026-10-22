import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createBaseFileHover} from '../src/ui/base-file-hover.ts';
import type {BaseFileHoverContent, BaseFileHoverOptions, BaseFileHoverTarget} from '../src/ui/base-file-hover.ts';
import type {NoteBuffer} from '../src/ui/note-buffer.ts';
const drain = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return {promise, resolve}; }
function setup(t: TestContext, changes: Partial<Pick<BaseFileHoverOptions, 'isMac' | 'requiresModifier'>> = {}) {
  t.mock.timers.enable({apis: ['setTimeout']});
  const dom = new JSDOM('<main><a id="alpha">Alpha</a><a id="beta">Beta</a></main>', {pretendToBeVisual: true}), document = dom.window.document;
  const parent = document.querySelector('main')!, alpha = document.querySelector<HTMLElement>('#alpha')!, beta = document.querySelector<HTMLElement>('#beta')!;
  const target: BaseFileHoverTarget = {path: 'Alpha#literal.md', entryId: 'alpha', revision: 'r1'}, second: BaseFileHoverTarget = {path: 'Beta.md', entryId: 'beta', revision: 'r1'};
  const registry = new Map([[target.path, {...target}], [second.path, {...second}]]), errors: unknown[] = [], reads: BaseFileHoverTarget[] = [], mounts: BaseFileHoverTarget[] = [];
  let loadGate: ReturnType<typeof deferred<void>> | undefined, mountGate: ReturnType<typeof deferred<void>> | undefined;
  let saveFails = false, disposalFails = false, dirty = false, disposed = 0, flushes = 0, saved = 0;
  let contentContext: Parameters<BaseFileHoverOptions['mount']>[1] | undefined;
  const buffer = (captured: BaseFileHoverTarget) => ({path: captured.path, text: 'original', savedText: 'original', get savedDurableWitness() { return registry.get(captured.path); }, async load(_id: string, validate: () => void) { validate(); }}) as unknown as NoteBuffer;
  const helper = createBaseFileHover({parent, isMac: true, ...changes,
    isCurrent: captured => { const current = registry.get(captured.path); return current?.entryId === captured.entryId && current.revision === captured.revision; },
    async getBuffer(captured, validate) { reads.push(captured); await loadGate?.promise; validate(); return buffer(captured); },
    async mount(host, context) {
      mounts.push(context.target); contentContext = context;
      const rendered = document.createElement('p'); rendered.className = 'rendered-markdown'; rendered.textContent = context.buffer!.text;
      const edit = document.createElement('button'); edit.textContent = 'Edit body'; host.append(rendered, edit);
      edit.onclick = () => { const input = document.createElement('input'); input.setAttribute('aria-label', 'Preview body'); input.value = context.buffer!.text; input.oninput = () => { dirty = true; context.onStateChange(); }; host.replaceChildren(input); input.focus(); };
      await mountGate?.promise;
      const content: BaseFileHoverContent = {async flush() { flushes++; context.validate(); if (saveFails) throw Error('Disk full'); if (dirty) { saved++; dirty = false; registry.set(context.target.path, {...context.target, revision: 'r2'}); } },
        hasPendingChanges: () => dirty, isCurrent: () => registry.get(context.target.path)?.entryId === context.target.entryId,
        owns: node => (node as HTMLElement).id === 'owned-picker',
        async dispose() { if (disposalFails) throw Error('Nested editor must finish'); disposed++; host.replaceChildren(); }};
      return content;
    }, onError: error => errors.push(error),
  });
  t.after(() => { dom.window.close(); });
  const hover = (anchor = alpha, captured = target, modifiers = {metaKey: true}) => helper.hover({...captured, values: {}}, new dom.window.MouseEvent('mouseover', modifiers), anchor);
  const advance = async (ms: number) => { t.mock.timers.tick(ms); await drain(); };
  const leave = (anchor = alpha) => anchor.dispatchEvent(new dom.window.MouseEvent('mouseout', {bubbles: true, relatedTarget: document.body}));
  return {dom, document, parent, alpha, beta, target, second, registry, errors, reads, mounts, helper, hover, advance, leave,
    set loadGate(value: typeof loadGate) {loadGate = value;}, set mountGate(value: typeof mountGate) {mountGate = value;},
    set saveFails(value: boolean) {saveFails = value;}, set disposalFails(value: boolean) {disposalFails = value;},
    get dirty() {return dirty;}, get disposed() {return disposed;}, get flushes() {return flushes;}, get saved() {return saved;}, get contentContext() {return contentContext;},
  };
}

test('hover preloads at200ms and shows at300ms without autofocus or invented hash subpath', async t => {
  const f = setup(t); f.hover(); await f.advance(199); assert.equal(f.reads.length, 0); assert.equal(f.document.querySelector('[aria-label="File preview"]'), null);
  await f.advance(1); assert.deepEqual(f.reads, [f.target]); assert.equal(f.mounts.length, 0);
  await f.advance(99); assert.equal(f.document.querySelector('[aria-label="File preview"]'), null);
  await f.advance(1); assert.deepEqual(f.mounts, [f.target]); assert.equal(f.document.activeElement, f.document.body);
  assert.equal(f.document.querySelector('.rendered-markdown')?.textContent, 'original'); assert.equal(Object.hasOwn(f.mounts[0], 'subpath'), false);
  await f.helper.destroy(); assert.equal(f.disposed, 1);
});
test('default plain hover waits for a modifier pressed after entry; key release does not dismiss', async t => {
  const f = setup(t); f.hover(f.alpha, f.target, {metaKey: false}); await f.advance(500); assert.equal(f.reads.length, 0);
  f.document.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', {key: 'Meta', metaKey: true})); await f.advance(300);
  assert.equal(f.mounts.length, 1); f.document.dispatchEvent(new f.dom.window.KeyboardEvent('keyup', {key: 'Meta', metaKey: false})); await f.advance(600);
  assert.ok(f.document.querySelector('[aria-label="File preview"]')); await f.helper.destroy();
});
test('Ctrl elsewhere and the optional source modifier setting do not fork hover behavior', async t => {
  const f = setup(t, {isMac: false}); f.hover(); await f.advance(300); assert.equal(f.mounts.length, 0);
  f.document.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', {key: 'Control', ctrlKey: true})); await f.advance(300); assert.equal(f.mounts.length, 1); await f.helper.destroy();
});
test('a source setting may permit ordinary hover without changing its timers', async t => {
  const f = setup(t, {requiresModifier: () => false}); f.hover(f.alpha, f.target, {metaKey: false}); await f.advance(299); assert.equal(f.mounts.length, 0); await f.advance(1); assert.equal(f.mounts.length, 1); await f.helper.destroy();
});
test('reference geometry uses below-left alignment with a10px gap and fits the viewport', async t => {
  const f = setup(t); Object.defineProperties(f.dom.window, {innerWidth: {value: 1024, configurable: true}, innerHeight: {value: 800, configurable: true}});
  f.alpha.getBoundingClientRect = () => ({x: 352, y: 154.516, left: 352, top: 154.516, right: 410, bottom: 171.579, width: 58, height: 17.063, toJSON() {}});
  f.hover(); await f.advance(300); const popup = f.document.querySelector<HTMLElement>('[aria-label="File preview"]')!;
  Object.defineProperties(popup, {offsetWidth: {get: () => 452}, offsetHeight: {get: () => 260.352}});
  f.dom.window.dispatchEvent(new f.dom.window.Event('resize')); assert.equal(popup.style.left, '352px'); assert.equal(popup.style.top, '181.579px');
  f.alpha.getBoundingClientRect = () => ({x: 950, y: 700, left: 950, top: 700, right: 1000, bottom: 720, width: 50, height: 20, toJSON() {}});
  f.dom.window.dispatchEvent(new f.dom.window.Event('resize')); assert.equal(popup.style.left, '564px'); assert.equal(popup.style.top, '429.648px'); await f.helper.destroy();
});
test('fast leave cancels immediately and a late read cannot mount a recycled target', async t => {
  const f = setup(t); const gate = deferred<void>(); f.loadGate = gate; f.hover(); await f.advance(200); assert.equal(f.reads.length, 1);
  f.leave(); gate.resolve(); await drain(); await f.advance(300); assert.equal(f.mounts.length, 0); assert.equal(f.document.querySelector('[aria-label="File preview"]'), null); await f.helper.destroy();
});
test('async admission rechecks exact identity/revision after loading and never retargets a replacement', async t => {
  const f = setup(t); const gate = deferred<void>(); f.loadGate = gate; f.hover(); await f.advance(200);
  f.registry.set(f.target.path, {...f.target, entryId: 'replacement'}); gate.resolve(); await drain(); await f.advance(300);
  assert.equal(f.mounts.length, 0); assert.equal(f.document.querySelector('[aria-label="File preview"]'), null); await f.helper.destroy();
});
test('popup hover and focus retain content; leaving a shown popup closes after300ms', async t => {
  const f = setup(t); f.hover(); await f.advance(300); const popup = f.document.querySelector<HTMLElement>('[aria-label="File preview"]')!;
  f.leave(); popup.dispatchEvent(new f.dom.window.MouseEvent('mouseover', {relatedTarget: f.alpha})); await f.advance(500); assert.ok(popup.isConnected);
  popup.querySelector<HTMLButtonElement>('button')!.focus(); popup.dispatchEvent(new f.dom.window.MouseEvent('mouseout', {relatedTarget: f.document.body})); await f.advance(500); assert.ok(popup.isConnected);
  (f.document.activeElement as HTMLElement).blur(); await drain(); await f.advance(299); assert.ok(popup.isConnected); await f.advance(1); assert.equal(popup.isConnected, false); await f.helper.destroy();
});
test('editing is provided by the shared-buffer factory and own save revisions remain current', async t => {
  const f = setup(t); f.hover(); await f.advance(300); f.document.querySelector<HTMLButtonElement>('.bases-file-hover button')!.click();
  const input = f.document.querySelector<HTMLInputElement>('[aria-label="Preview body"]')!; input.value = 'changed'; input.dispatchEvent(new f.dom.window.Event('input'));
  assert.equal(f.helper.hasPendingChanges(), true); f.leave(); await f.advance(500); assert.ok(input.isConnected);
  await f.helper.flush(); assert.equal(f.saved, 1); assert.equal(f.registry.get(f.target.path)?.revision, 'r2'); f.contentContext!.validate(); await f.advance(500); assert.ok(input.isConnected);
  await f.helper.destroy(); assert.equal(f.disposed, 1);
});
test('concurrent close coalesces; failed flush and nested disposal pin the exact editable surface', async t => {
  const f = setup(t); f.hover(); await f.advance(300); f.document.querySelector<HTMLButtonElement>('.bases-file-hover button')!.click();
  const input = f.document.querySelector<HTMLInputElement>('input')!; input.value = 'unsaved'; input.dispatchEvent(new f.dom.window.Event('input'));
  f.saveFails = true; const first = f.helper.close(), second = f.helper.close(); assert.equal(first, second);
  await assert.rejects(first, /Disk full/); assert.equal(f.disposed, 0); assert.equal(input.value, 'unsaved'); assert.ok(input.isConnected);
  f.saveFails = false; f.disposalFails = true; await assert.rejects(f.helper.close(), /Nested editor/); assert.ok(input.isConnected); assert.equal(f.disposed, 0);
  f.disposalFails = false; await f.helper.close(); assert.equal(input.isConnected, false); assert.equal(f.disposed, 1); await f.helper.destroy();
});
test('clean parent detach closes and disposes', async t => {
  const f = setup(t); f.hover(); await f.advance(300); f.parent.remove(); await drain(); assert.equal(f.document.querySelector('[aria-label="File preview"]'), null); assert.equal(f.disposed, 1); await f.helper.destroy();
});
test('pending inert mount cancels immediately and disposes its late handle exactly once', async t => {
  const f = setup(t), gate = deferred<void>(); f.mountGate = gate; f.hover(); await f.advance(300);
  const popup = f.document.querySelector<HTMLElement>('[aria-label="File preview"]')!;
  assert.equal(popup.inert, true); assert.equal(f.contentContext!.signal.aborted, false);
  let closed = false; const close = f.helper.close().then(() => {closed = true;}); await drain();
  assert.equal(closed, true); assert.equal(f.contentContext!.signal.aborted, true); assert.equal(popup.isConnected, false); assert.equal(f.disposed, 0);
  gate.resolve(); await drain(); assert.equal(f.disposed, 1); assert.equal(f.errors.length, 0); await close; await f.helper.destroy(); assert.equal(f.disposed, 1);
});
test('detaching a parent cancels a pending mount without waiting for late factory completion', async t => {
  const f = setup(t), gate = deferred<void>(); f.mountGate = gate; f.hover(); await f.advance(300); f.parent.remove(); await drain();
  assert.equal(f.contentContext!.signal.aborted, true); assert.equal(f.document.querySelector('[aria-label="File preview"]'), null);
  gate.resolve(); await drain(); assert.equal(f.disposed, 1); await f.helper.destroy();
});
test('navigation flush cancels a pre-editor mount instead of waiting for unbounded loading', async t => {
  const f = setup(t), gate = deferred<void>(); f.mountGate = gate; f.hover(); await f.advance(300);
  await f.helper.flush(); assert.equal(f.contentContext!.signal.aborted, true); assert.equal(f.document.querySelector('[aria-label="File preview"]'), null);
  gate.resolve(); await drain(); assert.equal(f.disposed, 1); await f.helper.destroy();
});
test('dirty detach retains the recovery surface until reattachment permits a successful flush', async t => {
  const f = setup(t); f.hover(); await f.advance(300); f.document.querySelector<HTMLButtonElement>('.bases-file-hover button')!.click();
  const input = f.document.querySelector<HTMLInputElement>('input')!; input.value = 'kept'; input.dispatchEvent(new f.dom.window.Event('input'));
  f.parent.remove(); await drain(); assert.ok(input.isConnected); assert.equal(input.value, 'kept'); assert.equal(f.helper.hasPendingChanges(), true); assert.equal(f.disposed, 0);
  f.document.body.append(f.parent); await f.helper.close(); assert.equal(f.saved, 1); assert.equal(f.disposed, 1); await f.helper.destroy();
});
test('a preview-owned floating picker retains hover without taking keyboard focus', async t => {
  const f = setup(t); f.hover(); await f.advance(300); const picker = f.document.createElement('div'); picker.id = 'owned-picker'; f.document.body.append(picker);
  f.leave(); picker.dispatchEvent(new f.dom.window.MouseEvent('mouseover', {bubbles: true, relatedTarget: f.alpha})); await f.advance(700);
  assert.ok(f.document.querySelector('[aria-label="File preview"]')); assert.equal(f.document.activeElement, f.document.body);
  picker.dispatchEvent(new f.dom.window.MouseEvent('mouseout', {bubbles: true, relatedTarget: f.document.body})); await f.advance(300);
  assert.equal(f.document.querySelector('[aria-label="File preview"]'), null); await f.helper.destroy();
});
test('binary resources receive no buffer, bind exact revision, and release late aborted mounts', async t => {
  t.mock.timers.enable({apis: ['setTimeout']}); const dom = new JSDOM('<main><a>Cover</a></main>', {pretendToBeVisual: true}); t.after(() => dom.window.close());
  const document = dom.window.document, parent = document.querySelector('main')!, anchor = document.querySelector('a')!;
  const target = {path: 'Cover#literal.png', entryId: 'cover', revision: 'r1'}, errors: unknown[] = [];
  let revision = 'r1', disposed = 0, context!: Parameters<BaseFileHoverOptions['mount']>[1], calls = 0;
  const gate = deferred<void>();
  const helper = createBaseFileHover({parent, isMac: true, isCurrent: captured => captured.revision === revision,
    async getBuffer() {return undefined;}, async mount(host, next) { calls++; context = next; assert.equal(next.buffer, undefined); host.append(document.createElement('img')); await gate.promise;
      return {async flush() {next.validate();}, hasPendingChanges: () => false, isCurrent: () => true, dispose() {disposed++;}};
    }, onError: error => errors.push(error)});
  helper.hover({...target, values: {}}, new dom.window.MouseEvent('mouseover', {metaKey: true}), anchor); t.mock.timers.tick(300); await drain(); assert.equal(calls, 1);
  revision = 'r2'; assert.throws(() => context.validate(), /changed/);
  await helper.close(); assert.equal(context.signal.aborted, true); gate.resolve(); await drain(); assert.equal(disposed, 1); assert.equal(errors.length, 0); await helper.destroy();
});
test('binary mount waiting for its abort signal cannot hold destroy open', async t => {
  t.mock.timers.enable({apis: ['setTimeout']}); const dom = new JSDOM('<main><a>Video</a></main>', {pretendToBeVisual: true}); t.after(() => dom.window.close());
  const document = dom.window.document, parent = document.querySelector('main')!, anchor = document.querySelector('a')!; let disposed = 0;
  const helper = createBaseFileHover({parent, isMac: true, isCurrent: () => true, async getBuffer() {return undefined;},
    async mount(_host, context) {await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), {once: true})); return {async flush() {}, hasPendingChanges: () => false, isCurrent: () => true, dispose() {disposed++;}};}, onError(error) {throw error;}});
  helper.hover({path: 'clip.mp4', entryId: 'clip', revision: 'r1', values: {}}, new dom.window.MouseEvent('mouseover', {metaKey: true}), anchor); t.mock.timers.tick(300); await drain();
  await helper.destroy(); await drain(); assert.equal(disposed, 1); assert.equal(document.querySelector('[aria-label="File preview"]'), null);
});
test('binary revision changes during async mount dispose the stale resource before admitting interaction', async t => {
  t.mock.timers.enable({apis: ['setTimeout']}); const dom = new JSDOM('<main><a>PDF</a></main>', {pretendToBeVisual: true}); t.after(() => dom.window.close());
  const document = dom.window.document, parent = document.querySelector('main')!, anchor = document.querySelector('a')!, gate = deferred<void>(), errors: unknown[] = [];
  let revision = 'r1', disposed = 0;
  const helper = createBaseFileHover({parent, isMac: true, isCurrent: target => target.revision === revision, async getBuffer() {return undefined;},
    async mount() {await gate.promise; return {async flush() {}, hasPendingChanges: () => false, isCurrent: () => true, dispose() {disposed++;}};}, onError: error => errors.push(error)});
  helper.hover({path: 'paper.pdf', entryId: 'paper', revision: 'r1', values: {}}, new dom.window.MouseEvent('mouseover', {metaKey: true}), anchor); t.mock.timers.tick(300); await drain();
  revision = 'r2'; gate.resolve(); await drain(); assert.equal(disposed, 1); const root = document.querySelector<HTMLElement>('[aria-label="File preview"]')!;
  assert.equal(root.inert, true); assert.equal(root.hasAttribute('aria-busy'), false); assert.equal(errors.length, 1);
  await helper.close(); assert.equal(root.isConnected, false); assert.equal(disposed, 1); await helper.destroy();
});
test('legacy rows never invent file identity and modifier character shortcuts cancel waiting opportunity', async t => {
  const f = setup(t); f.helper.hover({path: 'Old.md', values: {}}, new f.dom.window.MouseEvent('mouseover', {metaKey: true}), f.alpha); await f.advance(300); assert.equal(f.reads.length, 0);
  f.hover(f.alpha, f.target, {metaKey: false}); f.document.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', {key: 'c', metaKey: true})); await f.advance(400); assert.equal(f.reads.length, 0); await f.helper.destroy();
});
