import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';
import { openBaseNewItemPopover } from '../src/ui/base-new-item-popover.ts';
import type { BaseNewItemPopoverOptions } from '../src/ui/base-new-item-popover.ts';
import type { EditorOptions, EditorHandle } from '../src/ui/editor.ts';
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function setup(source = '---\nstatus: Todo\n---\n# Copied template\nLiteral {{date}}', overrides: Partial<BaseNewItemPopoverOptions> = {}) {
  const dom = new JSDOM('<button id="new">New</button><button id="sibling">Sibling</button>', { pretendToBeVisual: true });
  const anchor = dom.window.document.querySelector<HTMLButtonElement>('#new')!;
  const adapter = new MemoryAdapter({ 'Untitled.md': source }), vault = new Vault(adapter); await vault.initialize();
  const buffer = new NoteBuffer(vault, 'Untitled.md', { debounceMs: 60_000 }); await buffer.load();
  const errors: unknown[] = [], opened: string[] = [], editorOptions: EditorOptions[] = [];
  let destroyedEditor = 0, closed = 0, value = '';
  const factory = (parent: HTMLElement, options: EditorOptions): EditorHandle => { editorOptions.push(options); value = options.value; const input = parent.ownerDocument.createElement('textarea'); parent.append(input); return { getValue: () => value, setValue: next => { value = next; }, focus: () => input.focus(), destroy: () => { destroyedEditor++; input.remove(); }, insert() {} }; };
  const handle = await openBaseNewItemPopover({ anchor, vault, path: 'Untitled.md', getBuffer: async () => buffer, validate() {},
    rename: async (_path, destination, validate) => { validate(); await buffer.rename(destination); }, openFile: path => { opened.push(path); }, onError: error => { errors.push(error); }, onClose: () => { closed++; }, editorFactory: factory, ...overrides,
  });
  const title = handle.element.querySelector<HTMLElement>('.inline-title')!;
  return { dom, anchor, adapter, vault, buffer, handle, title, errors, opened, editorOptions, get destroyedEditor() { return destroyedEditor; }, get closed() { return closed; },
    setTitle(value: string) { title.textContent = value; title.dispatchEvent(new dom.window.Event('input', { bubbles: true })); },
    async cleanup() { if (handle.element.isConnected) { title.textContent = buffer.path.replace(/\.md$/i, ''); try { await handle.close(); } catch {} } await buffer.dispose(); dom.window.close(); },
  };
}

test('New focuses and selects DIV title of already saved note without mounting body editor', async () => {
  const s = await setup(); assert.equal(s.title.tagName, 'DIV'); assert.equal(s.title.contentEditable, 'true'); assert.equal(s.dom.window.document.activeElement, s.title); assert.equal(s.dom.window.getSelection()!.toString(), 'Untitled'); assert.equal(s.editorOptions.length, 0);
  assert.equal(s.handle.element.style.width, '452px'); assert.equal(s.handle.element.querySelector('.metadata-properties-heading')!.getAttribute('aria-expanded'), 'false'); assert.match(s.handle.element.textContent!, /Literal \{\{date\}\}/); assert.equal(s.handle.hasPendingChanges(), false); await s.cleanup();
});

test('title rename uses shared buffer and ordinary namespace service; copied full template remains exact', async () => {
  const source = '---\nstatus: Todo\n---\n# Copied template\nLiteral {{date}}'; const s = await setup(source); s.setTitle('My note'); await s.handle.flush();
  assert.equal(s.handle.path, 'My note.md'); assert.equal(s.buffer.path, 'My note.md'); assert.equal(await s.vault.read('My note.md'), source); assert.equal(s.vault.entries.has('Untitled.md'), false); await s.handle.close(); assert.equal(s.closed, 1); await s.cleanup();
});

test('lazy body and property edits share one buffer; properties preserve newer full body', async () => {
  const s = await setup(); await s.handle.expandBody(); assert.equal(s.editorOptions.length, 1); assert.ok(s.handle.element.classList.contains('is-body-expanded'));
  const next = s.buffer.text + '\nUser body'; s.editorOptions[0].validateChange!(next); s.editorOptions[0].onChange(next);
  s.handle.element.querySelector<HTMLElement>('.metadata-properties-heading')!.click();
  const status = s.handle.element.querySelector<HTMLInputElement>('[aria-label="status value"]')!; status.value = 'Done'; status.dispatchEvent(new s.dom.window.Event('input', { bubbles: true })); status.dispatchEvent(new s.dom.window.Event('change', { bubbles: true })); await tick();
  await s.handle.close(); const saved = await s.vault.read('Untitled.md'); assert.match(saved, /status: Done/); assert.ok(saved.endsWith('User body')); assert.equal(s.destroyedEditor, 1); await s.cleanup();
});

test('failed title rename retains exact draft and surface until successful retry', async () => {
  let reject = true; const s = await setup(undefined, { rename: async () => { if (reject) throw new Error('Name collision'); } });
  s.setTitle('Taken'); await assert.rejects(s.handle.close(), /Name collision/); assert.equal(s.title.textContent, 'Taken'); assert.ok(s.handle.element.isConnected); assert.equal(s.closed, 0); assert.equal(s.handle.hasPendingChanges(), true);
  // Restore the original already-existing name without invoking rename again.
  reject = false; s.setTitle('Untitled'); await s.handle.close(); assert.equal(s.closed, 1); await s.cleanup();
});

test('failed buffer flush retains body draft and does not dispose shared buffer', async () => {
  const s = await setup(); await s.handle.expandBody(); s.editorOptions[0].onChange(s.buffer.text + '\nUnsaved');
  const original = s.adapter.write.bind(s.adapter); let reject = true; s.adapter.write = async (path, text) => { if (reject) throw new Error('Disk unavailable'); await original(path, text); };
  await assert.rejects(s.handle.close(), /Disk unavailable/); assert.ok(s.handle.element.isConnected); assert.equal(s.destroyedEditor, 0); assert.match(s.buffer.text, /Unsaved/);
  reject = false; await s.handle.close(); assert.match(await s.vault.read('Untitled.md'), /Unsaved/); assert.equal(s.destroyedEditor, 1); s.buffer.update(s.buffer.text + '\nStill shared'); await s.buffer.flush(); await s.cleanup();
});

test('outside dismissal preserves sibling focus and flushes note; Escape respects title composition', async () => {
  const s = await setup(); s.title.dispatchEvent(new s.dom.window.CompositionEvent('compositionstart', { bubbles: true })); s.title.dispatchEvent(new s.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(); assert.ok(s.handle.element.isConnected);
  s.title.dispatchEvent(new s.dom.window.CompositionEvent('compositionend', { bubbles: true })); const sibling = s.dom.window.document.querySelector<HTMLButtonElement>('#sibling')!; sibling.focus(); sibling.dispatchEvent(new s.dom.window.MouseEvent('pointerdown', { bubbles: true })); await tick(); assert.equal(s.handle.element.isConnected, false); assert.equal(s.dom.window.document.activeElement, sibling); await s.cleanup();
});

test('closing during lazy factory load disposes late editor without taking sibling focus', async () => {
  let release!: (factory: EditorHandle) => void; let destroyed = 0; const gate = new Promise<EditorHandle>(resolve => { release = resolve; });
  const s = await setup(undefined, { editorFactory: () => gate }); const loading = s.handle.expandBody(); await s.handle.close(); release({ getValue: () => '', setValue() {}, focus() { throw new Error('late focus'); }, destroy() { destroyed++; }, insert() {} }); await loading;
  assert.equal(destroyed, 1); assert.equal(s.closed, 1); await s.cleanup();
});


test('empty notes hide empty Properties and preserve full source without an eager editor', async () => {
  const s = await setup(''); assert.equal(s.handle.element.querySelector<HTMLElement>('.bases-new-item-properties')!.hidden, true); assert.equal(s.editorOptions.length, 0); await s.handle.close(); assert.equal(await s.vault.read('Untitled.md'), ''); await s.cleanup();
});

test('uncertain rename acknowledgement reconciles only the same buffer destination before retry', async () => {
  let s: Awaited<ReturnType<typeof setup>>, calls = 0; s = await setup(undefined, {rename: async (_path, destination, validate) => { calls++; validate(); await s.buffer.rename(destination); throw new Error('Rename acknowledgement interrupted'); }});
  s.setTitle('Renamed'); await assert.rejects(s.handle.flush(), /acknowledgement/); assert.equal(s.handle.path, 'Renamed.md'); assert.equal(s.title.textContent, 'Renamed'); await s.handle.close(); assert.equal(calls, 1); assert.equal(s.vault.entries.has('Renamed.md'), true); await s.cleanup();
});

test('invalid property drafts prevent dismissal and remain editable until corrected', async () => {
  const s = await setup('---\ncount: 2\n---\nBody'); s.handle.element.querySelector<HTMLElement>('.metadata-properties-heading')!.click();
  const count = s.handle.element.querySelector<HTMLInputElement>('[aria-label="count value"]')!; count.value = 'invalid'; count.dispatchEvent(new s.dom.window.Event('input',{bubbles:true})); count.dispatchEvent(new s.dom.window.Event('change',{bubbles:true})); await tick();
  assert.equal(s.handle.hasPendingChanges(), true); await assert.rejects(s.handle.close(), /number|Invalid value/); assert.ok(s.handle.element.isConnected); assert.equal(count.value, 'invalid');
  count.value = '3'; count.dispatchEvent(new s.dom.window.Event('input',{bubbles:true})); count.dispatchEvent(new s.dom.window.Event('change',{bubbles:true})); await tick(); await s.handle.close(); assert.match(await s.vault.read('Untitled.md'), /count: 3/); await s.cleanup();
});

test('initial expanded-body factory failure retains a managed surface and shared note', async () => {
  const s = await setup(undefined, {bodyExpanded:true,editorFactory:()=>{throw new Error('Editor unavailable');}}); assert.ok(s.handle.element.isConnected); assert.match(s.handle.element.textContent!, /Editor unavailable/); await s.handle.close(); await s.cleanup();
});


test('a late editor starts from the latest shared source and cleanup survives a throwing child', async () => {
  let release!: (editor: EditorHandle) => void, displayed = ''; const gate = new Promise<EditorHandle>(resolve => { release = resolve; });
  const s = await setup(undefined, {editorFactory:()=>gate}); const loading = s.handle.expandBody(); s.buffer.update(s.buffer.text+'\nNewer while loading');
  release({getValue:()=>displayed,setValue:next=>{displayed=next;},focus(){},destroy(){throw new Error('child disposal');},insert(){}}); await loading; assert.ok(displayed.endsWith('Newer while loading')); await s.handle.close(); assert.equal(s.handle.element.isConnected,false); assert.equal(s.closed,1); assert.ok(s.errors.some(error=>String(error).includes('child disposal'))); await s.cleanup();
});

test('the note Properties context menu remains owned by the New surface', async () => {
  const s = await setup(); s.handle.element.querySelector<HTMLElement>('.metadata-properties-heading')!.dispatchEvent(new s.dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:10,clientY:10}));
  const menu = s.dom.window.document.querySelector<HTMLElement>('.context-menu')!; assert.ok(menu); menu.dispatchEvent(new s.dom.window.MouseEvent('pointerdown',{bubbles:true})); await tick(); assert.ok(s.handle.element.isConnected); await s.cleanup();
});
