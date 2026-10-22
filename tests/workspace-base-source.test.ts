import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import { Workspace } from '../src/ui/workspace.ts';
import { createEditor } from '../src/ui/editor.ts';
import type { EditorOptions } from '../src/ui/editor.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import type { VaultEntry } from '../src/core/types.ts';
import { BaseDocument } from '../src/bases/document.ts';

const invalid = '# user comment\npluginRoot: {quoted: "001", unknown: [one, two]}\nviews:\n  - type: table\n    name: [broken\n';
const repaired = '# user comment\npluginRoot: {quoted: "001", unknown: [one, two]}\nfilters: file.name == "One"\nviews:\n  - type: table\n    name: Repaired\n    order: [file.name, status]\n';
class Adapter extends MemoryAdapter {
  comparisons: { path: string; expected: string; next: string }[] = [];
  ids = new Map<string, string>(); revisions = new Map<string, number>(); fail = false;
  identify(entry: VaultEntry): VaultEntry { let id = this.ids.get(entry.path); if (!id) { id = `entry-${this.ids.size}`; this.ids.set(entry.path, id); } return { ...entry, entryId: id, revision: String(this.revisions.get(entry.path) ?? 1) }; }
  override async list() { return (await super.list()).map(entry => this.identify(entry)); }
  override async stat(path: string) { const entry = await super.stat(path); return entry ? this.identify(entry) : null; }
  override async write(path: string, value: string) { if (this.fail && path === 'Invalid.base') throw new Error('Source disk full'); await super.write(path, value); this.revisions.set(path, (this.revisions.get(path) ?? 1) + 1); }
  async compareAndWrite(path: string, expected: string, next: string) { this.comparisons.push({ path, expected, next }); if (await this.read(path) !== expected) throw new Error('File changed outside this editor'); await this.write(path, next); }
}
async function setup(t: TestContext) {
  const dom = new JSDOM('<!doctype html><body><div id="app"></div>', { url: 'https://zorid.test/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const matchMedia = (media: string) => ({ matches: false, media, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Text: dom.window.Text, Window: dom.window.Window, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), matchMedia })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.matchMedia = matchMedia as typeof window.matchMedia;
  dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 1000, bottom: 600, width: 1000, height: 600, x: 0, y: 0, toJSON() { return {}; } });
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const root = document.querySelector<HTMLElement>('#app')!, adapter = new Adapter({ 'Invalid.base': invalid, 'One.md': '---\nstatus: Todo\n---\nBody', 'Other.md': 'Other' });
  const editorOptions = new Map<unknown, EditorOptions>();
  const factory = (parent: HTMLElement, options: EditorOptions) => { const handle = createEditor(parent, options); editorOptions.set(handle, options); return handle; };
  let workspace = new Workspace(root, factory);
  t.after(async () => { try { adapter.fail = false; await workspace.destroy(); } finally { dom.window.close(); for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } } });
  await workspace.start({ adapter, id: 'test:base-source', label: 'Test' });
  return { root, adapter, editorOptions, get workspace() { return workspace; }, async restart() { await workspace.destroy(); workspace = new Workspace(root, factory); await workspace.start({ adapter, id: 'test:base-source', label: 'Test' }); return workspace; } };
}
async function until(check: () => boolean, label: string) { const end = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < end, `${label}: ${[...document.querySelectorAll('.notice,.error-message')].map(node=>node.textContent).join(' | ')}`); await new Promise(resolve => setTimeout(resolve, 5)); } }
function sourceEditor(workspace: Workspace): EditorView { const element = workspace.activePane.element.querySelector('.base-source-view .cm-editor'); assert.ok(element); return EditorView.findFromDOM(element as HTMLElement)!; }
function replace(workspace: Workspace, value: string) { const view = sourceEditor(workspace); view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }); }
function sourceToggle(workspace: Workspace, label: string): HTMLButtonElement { const button = workspace.activePane.element.querySelector<HTMLButtonElement>(`.base-source-toggle[aria-label="${label}"]`); assert.ok(button); return button; }
async function editSource(workspace: Workspace) { sourceToggle(workspace, 'Edit source').click(); await until(() => !!workspace.activePane.editor && !!workspace.activePane.element.querySelector('.base-source-view'), 'raw Base editor mounts'); }

test('actual invalid Base UI exposes source repair, saves invalid YAML, then returns repaired source to the normal Base', async t => {
  const f = await setup(t), workspace = f.workspace; await workspace.openNote('Invalid.base');
  assert.ok(workspace.activePane.baseView?.state.error);
  const recovery = workspace.activePane.element.querySelector<HTMLElement>('.base-source-recovery')!; assert.equal(recovery.hidden, false);
  const buffer = workspace.buffers.get('Invalid.base')!, id = workspace.vault.entries.get('Invalid.base')!.entryId;
  recovery.querySelector('button')!.click(); await until(() => !!workspace.activePane.editor, 'error repair opens raw source');
  assert.equal(f.editorOptions.get(workspace.activePane.editor!)!.mode, 'source'); assert.equal(workspace.buffers.get('Invalid.base'), buffer);
  assert.equal(sourceEditor(workspace).state.doc.toString(), invalid); assert.equal(await f.adapter.read('Invalid.base'), invalid);
  const stillInvalid = invalid + 'anotherUnknown: true\n'; replace(workspace, stillInvalid);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
  await until(() => !buffer.dirty, 'normal Save command persists invalid source');
  assert.equal(await f.adapter.read('Invalid.base'), stillInvalid); assert.throws(() => BaseDocument.parse(stillInvalid));
  assert.equal(workspace.activePane.element.querySelector('.base-source-view .cm-content')!.getAttribute('aria-label'), 'Base source');
  replace(workspace, repaired); sourceToggle(workspace, 'Return to Base').click();
  await until(() => !!workspace.activePane.baseView?.state.result && !workspace.activePane.editor, 'repaired normal Base renders');
  assert.equal(workspace.activePane.baseView!.state.result!.view.name, 'Repaired'); assert.equal(await f.adapter.read('Invalid.base'), repaired);
  assert.equal(workspace.vault.entries.get('Invalid.base')!.entryId, id); assert.notEqual(workspace.vault.entries.get('Invalid.base')!.revision, '1');
  assert.deepEqual(f.adapter.comparisons.map(call => call.expected), [invalid, stillInvalid]);
});

test('returning an unchanged invalid source to Base keeps the exact file and a visible source recovery action', async t => {
  const f = await setup(t); await f.workspace.openNote('Invalid.base'); await editSource(f.workspace);
  sourceToggle(f.workspace, 'Return to Base').click(); await until(() => !!f.workspace.activePane.baseView?.state.error, 'invalid Base error returns');
  assert.equal(await f.adapter.read('Invalid.base'), invalid); assert.equal(f.adapter.comparisons.length, 0);
  assert.equal(f.workspace.activePane.element.querySelector<HTMLElement>('.base-source-recovery')!.hidden, false);
});

test('failed source save blocks mode changes and keeps the exact editor, selection and recovery draft for retry', async t => {
  const f = await setup(t); await f.workspace.openNote('Invalid.base'); await editSource(f.workspace);
  const handle = f.workspace.activePane.editor!, view = sourceEditor(f.workspace), buffer = f.workspace.buffers.get('Invalid.base')!;
  replace(f.workspace, repaired); view.dispatch({ selection: EditorSelection.single(8, 19) }); const selection = view.state.selection.toJSON(); f.adapter.fail = true;
  sourceToggle(f.workspace, 'Return to Base').click(); await until(() => !!buffer.error, 'source save failure is retained');
  assert.equal(f.workspace.activePane.editor, handle); assert.deepEqual(view.state.selection.toJSON(), selection); assert.equal(buffer.text, repaired); assert.equal(buffer.dirty, true); assert.equal(await f.adapter.read('Invalid.base'), invalid);
  assert.match(f.root.querySelector('.save-state')?.textContent ?? '', /Couldn’t save/);
  f.adapter.fail = false; sourceToggle(f.workspace, 'Return to Base').click(); await until(() => !!f.workspace.activePane.baseView?.state.result, 'retry returns repaired Base');
  assert.equal(await f.adapter.read('Invalid.base'), repaired); assert.equal(buffer.dirty, false);
});

test('external CAS conflict preserves both the saved Base and exact source editor until an explicit retry', async t => {
  const f = await setup(t); await f.workspace.openNote('Invalid.base'); await editSource(f.workspace);
  const handle = f.workspace.activePane.editor!, view = sourceEditor(f.workspace), buffer = f.workspace.buffers.get('Invalid.base')!;
  replace(f.workspace, repaired); view.dispatch({ selection: EditorSelection.single(4, 17) }); const selection = view.state.selection.toJSON();
  const external = repaired.replace('name: Repaired', 'name: External'); await f.adapter.write('Invalid.base', external);
  sourceToggle(f.workspace, 'Return to Base').click(); await until(() => !!buffer.error, 'external CAS conflict is visible');
  assert.equal(await f.adapter.read('Invalid.base'), external); assert.equal(buffer.text, repaired); assert.equal(f.workspace.activePane.editor, handle); assert.deepEqual(view.state.selection.toJSON(), selection);
  // Restore this fixture's original save precondition, then explicitly retry.
  await f.adapter.write('Invalid.base', invalid); sourceToggle(f.workspace, 'Return to Base').click(); await until(() => !!f.workspace.activePane.baseView?.state.result, 'retained exact draft retries');
  assert.equal(await f.adapter.read('Invalid.base'), repaired);
});

test('Edit source cannot abandon an unfinished rendered property editor', async t => {
  const f = await setup(t); await f.adapter.write('Invalid.base', repaired); await f.workspace.vault.reload(); await f.workspace.openNote('Invalid.base');
  const session = f.workspace.activePane.baseView!, cell = f.workspace.activePane.element.querySelector('[data-property="note.status"][role="gridcell"]')!;
  cell.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  const input = cell.querySelector<HTMLInputElement>('input')!; assert.ok(input); input.value = 'Unfinished';
  sourceToggle(f.workspace, 'Edit source').click(); await until(() => [...document.querySelectorAll('.notice')].some(node => node.textContent?.includes('Finish or cancel')), 'pending control blocks source switch');
  assert.equal(f.workspace.activePane.baseView, session); assert.equal(input.isConnected, true); assert.equal(input.value, 'Unfinished'); assert.equal(f.workspace.activePane.editor, undefined);
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
});

test('split source panes share one Base buffer and external clean changes update source without replacing editor instances', async t => {
  const f = await setup(t); await f.workspace.openNote('Invalid.base'); await editSource(f.workspace);
  const first = f.workspace.activePane, firstEditor = first.editor!;
  await (f.workspace as any).split('right', first); const second = f.workspace.activePane, secondEditor = second.editor!;
  assert.notEqual(second, first); assert.equal(f.workspace.buffers.size, 1);
  replace(f.workspace, repaired); assert.equal(first.editor!.getValue(), repaired); await f.workspace.flush();
  const external = repaired.replace('name: Repaired', 'name: External'); await f.adapter.write('Invalid.base', external); await f.workspace.vault.reload();
  await until(() => first.editor?.getValue() === external && second.editor?.getValue() === external, 'clean source panes reconcile saved change');
  assert.equal(first.editor, firstEditor); assert.equal(second.editor, secondEditor);
  sourceToggle(f.workspace, 'Return to Base').click(); await until(() => !!f.workspace.activePane.baseView?.state.result, 'one source pane returns to Base');
  assert.equal(first.editor, firstEditor); assert.equal(first.element.querySelector('.base-source-view') !== null, true);
});

test('same-path replacement retires source authoring and cannot receive the previous Base draft', async t => {
  const f = await setup(t); await f.workspace.openNote('Invalid.base'); await editSource(f.workspace);
  const handle = f.workspace.activePane.editor!, options = f.editorOptions.get(handle)!, buffer = f.workspace.buffers.get('Invalid.base')!;
  replace(f.workspace, repaired); f.adapter.ids.set('Invalid.base', 'replacement'); await f.adapter.write('Invalid.base', 'views: [{type: table, name: Replacement}]'); await f.workspace.vault.reload();
  assert.throws(() => options.onChange('must never save'), /no longer current|changed/);
  await assert.rejects(buffer.flush(), /no longer current|changed/);
  assert.equal(buffer.text, repaired); assert.match(await f.adapter.read('Invalid.base'), /Replacement/);
  // Explicitly discard only this disposable fixture draft for test teardown.
  buffer.update(buffer.savedText); await buffer.reload();
});

test('source mode persists only for standalone Base tabs and does not leak to Markdown', async t => {
  const f = await setup(t); await f.workspace.openNote('Invalid.base'); await editSource(f.workspace);
  await f.restart(); assert.ok(f.workspace.activePane.editor); assert.ok(f.workspace.activePane.element.querySelector('.base-source-view'));
  await f.workspace.openNote('Other.md'); assert.equal(f.editorOptions.get(f.workspace.activePane.editor!)!.mode, 'live'); assert.equal(f.workspace.activePane.element.querySelector('.base-source-toggle'), null);
  assert.equal((f.workspace.activePane.tabs.find(tab => tab.id === f.workspace.activePane.active) as any).baseSource, undefined);
});

test('standalone source selection does not turn sidebar, file embeds or fenced Bases into raw source editors', async t => {
  const f = await setup(t); await f.workspace.openNote('Invalid.base'); await editSource(f.workspace);
  await f.adapter.write('Other.md', `![[Invalid.base]]\n\n\x60\x60\x60base\n${invalid}\x60\x60\x60\n`); await f.workspace.vault.reload(); await f.workspace.openNote('Other.md');
  await until(() => f.workspace.activePane.element.querySelectorAll('.base-embed-session .bases-session').length >= 2, 'file and fenced Base sessions mount');
  assert.equal(f.workspace.activePane.element.querySelector('.base-source-view,.base-source-toggle,.base-source-recovery'), null);
  await (f.workspace as any).openBaseSidebar('Invalid.base');
  assert.ok(f.root.querySelector('.sidebar-base-host .bases-session'));
  assert.equal(f.root.querySelector('.sidebar-base-host .base-source-view,.sidebar-base-host .base-source-toggle,.sidebar-base-host .base-source-recovery'), null);
});

test('source controls captured from a retired Base cannot switch the newer tab or write its buffer', async t => {
  const f = await setup(t); await f.workspace.openNote('Invalid.base'); const retired = sourceToggle(f.workspace, 'Edit source');
  await f.workspace.openNote('Other.md'); const handle = f.workspace.activePane.editor!; retired.click(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.workspace.activePane.editor, handle); assert.equal(f.workspace.activePane.element.querySelector('.base-source-view'), null); assert.equal(await f.adapter.read('Other.md'), 'Other');
});
