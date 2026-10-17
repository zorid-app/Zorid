import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import { AttachmentImporter, attachmentEmbed, sanitizeAttachmentName } from '../src/core/attachment-import.ts';
import type { AttachmentImportFile, AttachmentImportSettings } from '../src/core/attachment-import.ts';

const data = new Uint8Array([0, 255, 128, 13, 10, 0]);
const now = () => new Date(2026, 9, 16, 14, 23, 5);
const file = (name: string, rest: Partial<AttachmentImportFile> = {}): AttachmentImportFile => ({ name, read: async () => data, ...rest });
async function setup(seed: Record<string, string | Uint8Array> = {}) {
  const adapter = new MemoryAdapter(seed), vault = new Vault(adapter);
  await vault.initialize();
  return { adapter, vault, importer: new AttachmentImporter(vault, { now }) };
}

test('PNG/JPEG web files receive local timestamp names and preserve arbitrary bytes', async () => {
  const { vault, importer } = await setup();
  const png = await importer.import(file('original.png', { type: 'image/png' }), 'Note.md', null);
  const jpeg = await importer.import(file('original.jpeg', { type: 'image/jpeg' }), 'Note.md', null);
  assert.deepEqual(png, { path: 'Pasted image 20261016142305.png', embed: '![[Pasted image 20261016142305.png]]' });
  assert.equal(jpeg.path, 'Pasted image 20261016142305.jpg');
  assert.deepEqual(await vault.readBinary(png.path), data);
  assert.equal(vault.entries.get(png.path)!.size, data.byteLength);
});

test('native filenames and arbitrary MIME files retain names; exact generic basename timestamps', async () => {
  const { importer } = await setup();
  assert.equal((await importer.import(file('photo.png', { type: 'image/png', nativePath: '/external/photo.png' }), '', null)).path, 'photo.png');
  assert.equal((await importer.import(file('Pasted image.png', { nativePath: '/external/Pasted image.png' }), '', null)).path, 'Pasted image 20261016142305.png');
  assert.equal((await importer.import(file('report.bin', { type: 'application/octet-stream' }), '', null)).embed, '![[report.bin]]');
  assert.equal((await importer.import(file('image.webp', { type: 'image/webp' }), '', null)).path, 'image.webp');
});

test('shared per-vault queue serializes imports and case-insensitive numeric suffix allocation', async () => {
  const { vault, importer } = await setup({ 'PHOTO.PNG': data, 'photo 1.png': data });
  const other = new AttachmentImporter(vault, { now });
  const events: string[] = [];
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const first = importer.import(file('photo.png', { read: async () => { events.push('first'); await waiting; return data; } }), '', null);
  const second = other.import(file('photo.png', { read: async () => { events.push('second'); return data; } }), '', null);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['first']);
  release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(result => result.path), ['photo 2.png', 'photo 3.png']);
  assert.deepEqual(events, ['first', 'second']);
  assert.deepEqual(await vault.readBinary('PHOTO.PNG'), data);
});

test('same-second generic image imports are distinct and independently discoverable', async () => {
  const { vault, importer } = await setup();
  const results = await Promise.all(Array.from({ length: 5 }, () => importer.import(file('x.png', { type: 'image/png' }), '', null)));
  assert.deepEqual(results.map(result => result.path), Array.from({ length: 5 }, (_, index) => `Pasted image 20261016142305${index ? ` ${index}` : ''}.png`));
  for (const result of results) assert.equal(vault.metadata.resolveLink('Note.md', result.path), result.path);
});

test('all destination modes use active-file folder while links use receiving owner', async () => {
  const modes = new Map([['/', 'photo.png'], ['.', 'Active/photo.png'], ['./', 'Active/photo.png'], ['./Images', 'Active/Images/photo.png'], ['Shared/Assets', 'Shared/Assets/photo.png']]);
  for (const [attachmentFolderPath, expected] of modes) {
    const { vault, importer } = await setup({ 'Active/Current.md': 'active', 'Receiving/Owner.md': 'owner' });
    const result = await importer.import(file('photo.png'), 'Receiving/Owner.md', 'Active/Current.md', { attachmentFolderPath, newLinkFormat: 'relative' });
    assert.equal(result.path, expected);
    assert.equal(result.embed, `![[../${expected}]]`);
    assert.deepEqual(await vault.readBinary(expected), data);
  }
  const { importer } = await setup();
  assert.equal((await importer.import(file('x'), '', null, { attachmentFolderPath: '.' })).path, 'x');
});

test('live active path is sampled after reading bytes while the receiving owner remains fixed', async () => {
  const { vault, importer } = await setup({ 'Before/Active.md': '', 'After/Active.md': '', 'Receiving/Owner.md': '' });
  let activePath: string | null = 'Before/Active.md', samples = 0;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const pending = importer.import(file('photo.png', { read: async () => { await waiting; return data; } }), 'Receiving/Owner.md',
    () => { samples++; return activePath; }, { attachmentFolderPath: './Images', newLinkFormat: 'relative' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(samples, 0);
  activePath = 'After/Active.md';
  release();
  assert.deepEqual(await pending, { path: 'After/Images/photo.png', embed: '![[../After/Images/photo.png]]' });
  assert.equal(samples, 1);
  assert.deepEqual(await vault.readBinary('After/Images/photo.png'), data);
  activePath = null;
  assert.equal((await importer.import(file('root.bin'), '', () => activePath, { attachmentFolderPath: '.' })).path, 'root.bin');
});

test('existing destination file or obstructing ancestor falls back to root', async () => {
  for (const folder of ['Attachments', 'Attachments/Nested']) {
    const { vault, importer } = await setup({ Attachments: 'keep' });
    const result = await importer.import(file('photo.png'), '', null, { attachmentFolderPath: folder });
    assert.equal(result.path, 'photo.png');
    assert.equal(await vault.read('Attachments'), 'keep');
  }
});

test('existing folder casing is reused and file/folder names both occupy collision slots', async () => {
  const { adapter, importer } = await setup({ 'ASSETS/old.bin': data });
  await adapter.mkdir('ASSETS/photo.png');
  const result = await importer.import(file('photo.png'), '', null, { attachmentFolderPath: 'assets' });
  assert.equal(result.path, 'ASSETS/photo 1.png');
});

test('existing vault files are reused without reading supplied bytes or creating duplicates', async () => {
  const { importer, vault } = await setup({ 'Assets/photo.png': data });
  const count = vault.entries.size;
  const result = await importer.import(file('ignored.png', { type: 'image/png', existingVaultPath: 'Assets/photo.png', read: async () => { throw new Error('must not read'); } }), 'Note.md', null);
  assert.deepEqual(result, { path: 'Assets/photo.png', embed: '![[photo.png]]' });
  assert.equal(vault.entries.size, count);
  await assert.rejects(importer.import(file('missing', { existingVaultPath: 'missing.png' }), '', null), /does not exist/);
  await assert.rejects(importer.import(file('folder', { existingVaultPath: 'Assets' }), '', null), /does not exist/);
});

test('shortest lookup falls back to full path when basename is ambiguous', async () => {
  const { vault, importer } = await setup({ 'Other/photo.png': data });
  const result = await importer.import(file('photo.png'), 'Notes/Owner.md', null, { attachmentFolderPath: 'Assets' });
  assert.equal(result.embed, '![[Assets/photo.png]]');
  assert.equal(attachmentEmbed(vault, result.path, 'Assets/Owner.md'), '![[Assets/photo.png]]');
  assert.equal(attachmentEmbed(vault, result.path, 'Notes/Owner.md', { newLinkFormat: 'absolute' }), '![[Assets/photo.png]]');
  assert.equal(attachmentEmbed(vault, result.path, 'Notes/Owner.md', { newLinkFormat: 'relative' }), '![[../Assets/photo.png]]');
});

test('shortest wiki and Markdown generation requires a unique candidate even when the first result matches', async () => {
  const { vault } = await setup({ 'Assets/photo.png': data, 'Other/photo.png': data });
  const owner = 'Assets/Owner.md', path = 'Assets/photo.png';
  for (const kind of ['wiki', 'markdown'] as const) {
    assert.equal(vault.metadata.resolveLink(owner, 'photo.png', kind), path);
    assert.equal(vault.metadata.resolveLinkCandidates(owner, 'photo.png', kind).length, 2);
  }
  assert.equal(attachmentEmbed(vault, path, owner), '![[Assets/photo.png]]');
  assert.equal(attachmentEmbed(vault, path, owner, { useMarkdownLinks: true }), '![](Assets/photo.png)');
  const unique = await setup({ 'Assets/photo.png': data });
  assert.equal(attachmentEmbed(unique.vault, path, owner), '![[photo.png]]');
  assert.equal(attachmentEmbed(unique.vault, path, owner, { useMarkdownLinks: true }), '![](photo.png)');
});

test('wiki links omit Markdown extension, Markdown links label notes and safely encode destinations', async () => {
  const { vault } = await setup({ 'Assets/My note.md': '# Note', 'Assets/a (1) é.png': data });
  assert.equal(attachmentEmbed(vault, 'Assets/My note.md', 'Owner.md'), '![[My note]]');
  assert.equal(attachmentEmbed(vault, 'Assets/My note.md', 'Owner.md', { useMarkdownLinks: true }), '![My note](My%20note.md)');
  assert.equal(attachmentEmbed(vault, 'Assets/a (1) é.png', 'Notes/Owner.md', { useMarkdownLinks: true, newLinkFormat: 'relative' }), '![](../Assets/a%20%281%29%20é.png)');
});

test('relative links explicitly select same-folder and descendant files despite root collisions', async () => {
  const { vault } = await setup({
    'photo.png': data, 'Notes/photo.png': data,
    'Images/photo.png': data, 'Notes/Images/photo.png': data,
  });
  for (const target of ['photo.png', 'Images/photo.png']) {
    const path = `Notes/${target}`;
    assert.equal(attachmentEmbed(vault, path, 'Notes/Owner.md', { newLinkFormat: 'relative' }), `![[./${target}]]`);
    assert.equal(attachmentEmbed(vault, path, 'Notes/Owner.md', { newLinkFormat: 'relative', useMarkdownLinks: true }), `![](./${target})`);
    for (const kind of ['wiki', 'markdown'] as const) assert.equal(vault.metadata.resolveLink('Notes/Owner.md', `./${target}`, kind), path);
  }
});

test('sanitization is bounded, predictable and prevents filename traversal', async () => {
  assert.equal(sanitizeAttachmentName('  A:#[]^|/\\\nB%%  C  '), 'A B C');
  assert.equal(sanitizeAttachmentName('..'), 'attachment');
  const { vault, importer } = await setup();
  const result = await importer.import(file('../unsafe.bin'), '', null);
  assert.equal(result.path, '.. unsafe.bin');
  const long = await importer.import(file('a'.repeat(300) + '.bin'), '', null);
  assert.equal(long.path, 'a'.repeat(250) + '.bin');
  const astral = await importer.import(file('a'.repeat(249) + '😀.bin'), '', null);
  assert.equal(astral.path, 'a'.repeat(249) + '.bin');
  assert.equal(vault.entries.size, 3);
  await assert.rejects(importer.import(file('x'), '', null, { attachmentFolderPath: '../outside' }), /escape/);
});

test('read/write failure yields no successful import and does not poison following queue entries', async () => {
  class FailingAdapter extends MemoryAdapter {
    fail = true;
    override async writeBinary(path: string, bytes: Uint8Array) {
      if (this.fail) throw new Error('write failed');
      return super.writeBinary(path, bytes);
    }
    override async createBinary(path: string, bytes: Uint8Array) {
      if (this.fail) throw new Error('write failed');
      return super.createBinary(path, bytes);
    }
  }
  const adapter = new FailingAdapter(), vault = new Vault(adapter);
  await vault.initialize();
  const importer = new AttachmentImporter(vault);
  await assert.rejects(importer.import(file('x', { read: async () => { throw new Error('read failed'); } }), '', null), /read failed/);
  await assert.rejects(importer.import(file('x'), '', null), /write failed/);
  assert.equal(vault.entries.size, 0);
  adapter.fail = false;
  assert.equal((await importer.import(file('x'), '', null)).path, 'x');
});

test('queued settings and file names are snapshots, and binary buffers are detached from readers', async () => {
  const { vault, importer } = await setup();
  const input = new Uint8Array([0, 255]), entry = file('first.bin', { read: async () => input });
  const settings: Partial<AttachmentImportSettings> = { attachmentFolderPath: 'Original' };
  const pending = importer.import(entry, '', null, settings);
  entry.name = 'changed.bin'; settings.attachmentFolderPath = 'Changed';
  const result = await pending;
  input.fill(7);
  assert.equal(result.path, 'Original/first.bin');
  assert.deepEqual(await vault.readBinary(result.path), new Uint8Array([0, 255]));
});

test('fresh metadata allocation sees external case-insensitive collisions without reading other files', async () => {
  class CountingAdapter extends MemoryAdapter {
    reads = 0;
    override async read(path: string) { this.reads++; return super.read(path); }
  }
  const adapter = new CountingAdapter({ 'Note.md': 'body' }), vault = new Vault(adapter);
  await vault.initialize(); adapter.reads = 0;
  await adapter.writeBinary('EXTERNAL.BIN', data);
  const result = await new AttachmentImporter(vault).import(file('external.bin'), 'Note.md', null);
  assert.equal(result.path, 'external 1.bin');
  assert.equal(adapter.reads, 0);
  assert.deepEqual(await adapter.readBinary('EXTERNAL.BIN'), data);
});

test('configuration and timestamp failures do not create destination folders or block later imports', async () => {
  const { vault, importer } = await setup();
  let reads = 0;
  const input = file('image.png', { type: 'image/png', read: async () => { reads++; return data; } });
  await assert.rejects(importer.import(input, '', null, { newLinkFormat: 'unknown' as AttachmentImportSettings['newLinkFormat'] }), /Unsupported/);
  await assert.rejects(importer.import(input, '', null, { attachmentFolderPath: '../outside' }), /escape/);
  assert.equal(reads, 0);
  const invalidClock = new AttachmentImporter(vault, { now: () => new Date(NaN) });
  await assert.rejects(invalidClock.import(input, '', null, { attachmentFolderPath: 'Images' }), /timestamp/);
  assert.equal(vault.entries.size, 0);
  assert.equal((await importer.import(file('good.bin'), '', null)).path, 'good.bin');
});

test('folder creation failure does not write attachment bytes and the shared queue recovers', async () => {
  class FailingFolderAdapter extends MemoryAdapter {
    fail = true;
    writes = 0;
    override async mkdir(path: string) {
      if (this.fail) throw new Error('folder failed');
      return super.mkdir(path);
    }
    override async writeBinary(path: string, bytes: Uint8Array) {
      this.writes++;
      return super.writeBinary(path, bytes);
    }
  }
  const adapter = new FailingFolderAdapter(), vault = new Vault(adapter);
  await vault.initialize();
  const importer = new AttachmentImporter(vault);
  await assert.rejects(importer.import(file('x.bin'), '', null, { attachmentFolderPath: 'Images' }), /folder failed/);
  assert.equal(adapter.writes, 0);
  assert.equal(vault.entries.size, 0);
  adapter.fail = false;
  const result = await new AttachmentImporter(vault).import(file('x.bin'), '', null, { attachmentFolderPath: 'Images' });
  assert.equal(result.path, 'Images/x.bin');
  assert.deepEqual(await vault.readBinary(result.path), data);
});
