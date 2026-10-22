import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';
import { createBaseSession } from '../src/bases/session.ts';
import type { BaseSessionOptions } from '../src/bases/session.ts';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 8));
async function fixture(files: Record<string, string>, overrides: Partial<BaseSessionOptions> = {}) {
  const vault = new Vault(new MemoryAdapter(files)); await vault.initialize();
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), host = dom.window.document.querySelector('main')!;
  const buffers = new Map<string, NoteBuffer>(), errors: unknown[] = [], opened: string[] = [];
  const session = createBaseSession(host, { vault, basePath: 'Work.base', validate() {}, openFile(path) { opened.push(path); }, onError(error) { errors.push(error); },
    buffers: { validate() {}, async getBuffer(path) { let buffer = buffers.get(path); if (!buffer) { buffer = new NoteBuffer(vault, path); buffers.set(path, buffer); } await buffer.load(); return buffer; } }, ...overrides,
  }); await session.ready;
  const key = (element: Element, key: string) => element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  return { vault, dom, host, session, errors, opened, key, async cleanup() { for (const input of host.querySelectorAll('.bases-session-content input')) key(input, 'Escape'); for (const button of dom.window.document.querySelectorAll<HTMLButtonElement>('.bases-toolbar-popover button')) if (button.textContent === 'Cancel') button.click(); await session.close(); for (const buffer of buffers.values()) await buffer.dispose(); dom.window.close(); } };
}
const base = 'filters: file.ext == "md"\nviews:\n  - {type: table, name: Table, order: [file.name, status]}\n';

test('New copies complete literal template and opens one committed note', async () => {
  const template = '---\nstatus: Todo\n---\n# {{title}}\n\nLiteral body.\n';
  const f = await fixture({ 'Work.base': `newItemTemplate: Templates/Book.md\nnewItemFolder: Books\n${base}`, 'Templates/Book.md': template, 'Books/Existing.md': 'Existing' });
  try {
    f.host.querySelector<HTMLButtonElement>('[aria-label="New"]')!.click();
    for (let i = 0; i < 30 && !f.opened.length; i++) await tick();
    assert.equal(f.opened.length, 1); assert.ok(f.opened[0].startsWith('Books/'));
    assert.equal(await f.vault.read(f.opened[0]), template); assert.equal(await f.vault.read('Templates/Book.md'), template);
    assert.deepEqual(f.errors, []);
  } finally { await f.cleanup(); }
});

test('a second New closes its existing note popover before preparing another file', async () => {
  let existing = false, opened = 0;
  const f = await fixture({ 'Work.base': base, 'One.md': 'Existing' }, {
    openCreatedFile() { existing = true; opened++; },
    async closeCreatedFile() { if (!existing) return false; existing = false; return true; },
  });
  try {
    const newItem = () => f.host.querySelector<HTMLButtonElement>('[aria-label="New"]')!.click();
    newItem(); for (let i = 0; i < 30 && (!existing || f.session.hasPendingChanges()); i++) await tick();
    const created = [...f.vault.entries.keys()].filter(path => path.endsWith('.md'));
    assert.equal(opened, 1); assert.equal(created.length, 2);
    newItem(); for (let i = 0; i < 30 && (existing || f.session.hasPendingChanges()); i++) await tick();
    assert.equal(existing, false); assert.equal(opened, 1);
    assert.deepEqual([...f.vault.entries.keys()].filter(path => path.endsWith('.md')), created);
  } finally { await f.cleanup(); }
});

test('reused table renderer can edit again after its own saved refresh', async () => {
  const f = await fixture({ 'Work.base': base, 'One.md': '---\nstatus: Todo\n---\nbody\n' });
  try {
    for (const value of ['Doing', 'Done']) {
      const cell = f.host.querySelector('[data-path="One.md"][data-property="note.status"][role="gridcell"]')!;
      f.key(cell, 'Enter'); const input = cell.querySelector('input')!; input.value = value; f.key(input, 'Enter');
      for (let i = 0; i < 30 && !((await f.vault.read('One.md')).includes(`status: ${value}`)); i++) await tick();
      await tick();
      assert.ok((await f.vault.read('One.md')).includes(`status: ${value}`));
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.cleanup(); }
});

test('invalid shared property settings leave results visible and values read-only', async () => {
  const f = await fixture({ 'Work.base': base, 'One.md': '---\nstatus: Todo\n---\n', 'Properties.yaml': 'properties: [invalid]\n' });
  try {
    const cell = f.host.querySelector('[data-path="One.md"][data-property="note.status"][role="gridcell"]')!;
    assert.ok(cell); f.key(cell, 'Enter'); assert.equal(cell.querySelector('input'), null);
    assert.match(f.host.querySelector('.bases-session-status')!.textContent!, /properties must be a mapping/);
    assert.match(await f.vault.read('One.md'), /Todo/);
  } finally { await f.cleanup(); }
});
