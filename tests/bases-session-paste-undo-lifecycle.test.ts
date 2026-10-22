import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parse } from 'yaml';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';
import { createBaseSession } from '../src/bases/session.ts';
import { baseHistoryReadiness } from './bases-electron-integration/history-readiness.mjs';

const base = 'views:\n - type: table\n   name: Books\n   order: [file.name, rating, status]\n   sort: [{property: file.name, direction: ASC}]\n';
const one = '---\nrating: 5\nstatus: Reading\nkeep: original\n---\nFirst body\n';
const two = '---\nrating: 2\nstatus: Reading\nkeep: second\n---\nSecond body\n';
const fm = (source: string) => parse(source.match(/^---\n([\s\S]*?)\n---/)![1]);
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 1));
async function until(check: () => boolean | Promise<boolean>) { for (let i = 0; i < 500; i++) { if (await check()) return; await tick(); } assert.ok(await check()); }

class FlushTail {
  reached = false;
  private held = true;
  private releaseTail!: () => void;
  private tail = new Promise<void>(resolve => { this.releaseTail = resolve; });
  release() { this.held = false; this.releaseTail(); }
  async afterFlush(buffer: NoteBuffer) {
    if (this.held && buffer.path === 'Book 001.md' && fm(buffer.savedText).rating === 4) { this.reached = true; await this.tail; }
  }
}

test('diagnostic: durable rectangular paste alone does not acknowledge table history readiness', async () => {
  const tail = new FlushTail(), adapter = new MemoryAdapter({ 'Library.base': base, 'Book 001.md': one, 'Book 002.md': two });
  const vault = new Vault(adapter); await vault.initialize();
  const dom = new JSDOM('<div class="pane is-active"><main></main></div>', { pretendToBeVisual: true }), doc = dom.window.document, host = doc.querySelector('main')!;
  const buffers = new Map<string, NoteBuffer>(), errors: unknown[] = [];
  const session = createBaseSession(host, { vault, basePath: 'Library.base', validate() {}, openFile() {}, onError: error => errors.push(error), buffers: {
    validate() {}, async getBuffer(path) { let buffer = buffers.get(path); if (!buffer) { buffer = new NoteBuffer(vault, path, { debounceMs: 60000 }); const flush = buffer.flush.bind(buffer), owned = buffer; buffer.flush = async () => { await flush(); await tail.afterFlush(owned); }; buffers.set(path, buffer); } await buffer.load(); return buffer; },
  } });
  const cell = () => host.querySelector<HTMLElement>('[role="gridcell"][data-path="Book 001.md"][data-property="note.rating"]')!;
  const key = (redo = false) => { const event = new dom.window.KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: redo, bubbles: true, cancelable: true }); doc.activeElement!.dispatchEvent(event); return event; };
  try {
    await session.ready; await until(() => host.querySelector('.bases-session-content')?.getAttribute('aria-busy') === 'false'); cell().focus();
    const paste = new dom.window.Event('paste', { bubbles: true, cancelable: true }), raw = [[{ type: 'note', data: 4 }, { type: 'note', data: 'Finished' }], [{ type: 'note', data: 2 }, { type: 'note', data: 'Reading' }]];
    Object.defineProperty(paste, 'clipboardData', { value: { getData: (type: string) => type === 'obsidian/bases-cells' ? JSON.stringify(raw) : type === 'text/plain' ? '4\tFinished\n2\tReading' : '' } }); cell().dispatchEvent(paste); assert.equal(paste.defaultPrevented, true);
    await until(() => tail.reached);
    // Exactly the heavy journey's physical + ordinary Vault read precondition.
    assert.equal(await adapter.read('Book 001.md'), await vault.read('Book 001.md'));
    assert.equal(fm(await vault.read('Book 001.md')).rating, 4); assert.equal(fm(await vault.read('Book 001.md')).status, 'Finished');
    assert.equal(fm(await vault.read('Book 002.md')).rating, 2); assert.equal(fm(await vault.read('Book 002.md')).status, 'Reading');
    assert.equal(doc.activeElement, cell()); assert.equal(host.querySelector('.bases-session-content')!.getAttribute('aria-busy'), 'true');
    const undo = key(); await tick(); assert.equal(undo.defaultPrevented, false); assert.deepEqual(errors, []);
    assert.equal(fm(await vault.read('Book 001.md')).rating, 4, 'The pending command owns the table; this shortcut was not admitted');
    assert.equal(baseHistoryReadiness(doc, 'Book 001.md', 'note.rating').ready, false);
    tail.release();
    await until(() => baseHistoryReadiness(doc, 'Book 001.md', 'note.rating').ready);
    assert.equal(key().defaultPrevented, true, 'One fresh Cmd+Z reaches Base history after public readiness');
    await until(async () => fm(await vault.read('Book 001.md')).rating === 5 && baseHistoryReadiness(doc, 'Book 001.md', 'note.rating').ready);
    assert.equal(await vault.read('Book 001.md'), one, 'Undo restores exact pre-paste source, unrelated keys and body');
    assert.equal(await vault.read('Book 002.md'), two);
    assert.deepEqual(errors, []);
    assert.equal(key(true).defaultPrevented, true);
    await until(async () => fm(await vault.read('Book 001.md')).rating === 4 && baseHistoryReadiness(doc, 'Book 001.md', 'note.rating').ready);
    assert.equal(fm(await vault.read('Book 001.md')).status, 'Finished'); assert.equal(fm(await vault.read('Book 001.md')).keep, 'original');
    assert.ok((await vault.read('Book 001.md')).endsWith('First body\n')); assert.equal(await vault.read('Book 002.md'), two); assert.deepEqual(errors, []);
    for (const name of ['ArrowRight', 'ArrowDown', 'Delete']) doc.activeElement!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name, shiftKey: name !== 'Delete', bubbles: true, cancelable: true }));
    await until(async () => fm(await vault.read('Book 001.md')).rating === null && baseHistoryReadiness(doc, 'Book 002.md', 'note.status').ready);
    assert.equal(fm(await vault.read('Book 002.md')).rating, null);
    assert.equal(key().defaultPrevented, true);
    await until(async () => fm(await vault.read('Book 001.md')).rating === 4 && baseHistoryReadiness(doc, 'Book 002.md', 'note.status').ready);
    assert.equal(fm(await vault.read('Book 001.md')).status, 'Finished'); assert.equal(await vault.read('Book 002.md'), two); assert.deepEqual(errors, []);
  } finally {
    tail.release(); await until(() => !session.hasPendingChanges()); await session.close(); for (const buffer of buffers.values()) await buffer.dispose(); dom.window.close();
  }
});
