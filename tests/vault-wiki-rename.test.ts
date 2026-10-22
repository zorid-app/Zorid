import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import { Vault } from '../src/core/vault.ts';
import { MetadataCache, parseMetadata } from '../src/core/metadata.ts';
import { readProperties } from '../src/core/properties.ts';
import type { VaultEntry } from '../src/core/types.ts';
import type { VaultAdapter } from '../src/core/types.ts';

class IdentityAdapter extends MemoryAdapter {
  ids = new Map<string, string>();
  identify(entry: VaultEntry): VaultEntry { let id = this.ids.get(entry.path); if (!id) { id = `entry-${this.ids.size}`; this.ids.set(entry.path, id); } return { ...entry, entryId: id, revision: 'saved-revision' }; }
  override async list() { return (await super.list()).map(entry => this.identify(entry)); }
  override async stat(path: string) { const entry = await super.stat(path); return entry ? this.identify(entry) : null; }
  override async rename(from: string, to: string) {
    await super.rename(from, to);
    for (const [path, id] of [...this.ids]) if (path === from || path.startsWith(`${from}/`)) { this.ids.delete(path); this.ids.set(to + path.slice(from.length), id); }
  }
}
function mutationMetadata(vault: Vault, path: string, source: string): MetadataCache {
  const metadata = new MetadataCache(); metadata.setFiles([...vault.entries.values()].filter(entry => entry.type === 'file').map(entry => entry.path)); metadata.index(path, source, { frontmatterLinks: true }); return metadata;
}

test('rooted escaped wiki rename preserves reserved filename characters, alias/fragment spelling and stable target identity', async () => {
  const destination = `People/Ω #|%[] O'"().md`, encoded = '/People/%CE%A9%20%23%7C%25%5B%5D%20O%27%22%28%29.md';
  const original = '---\nauthor: "[[/Author%20Grace.md|Grace]]" # keep\n---\n![[/Author%20Grace.md#Bio|portrait]]\n';
  const adapter = new IdentityAdapter({ 'Author Grace.md': 'original person', 'People/Keep.md': '', 'Books/Author Grace.md': 'wrong local', [`Books/${destination}`]: 'wrong nested', 'Books/Book.md': original });
  const vault = new Vault(adapter); await vault.initialize(); const id = (await adapter.stat('Author Grace.md'))!.entryId;
  await vault.rename('Author Grace.md', destination);
  const saved = await adapter.read('Books/Book.md');
  assert.equal(saved, `---\nauthor: "[[${encoded}|Grace]]" # keep\n---\n![[${encoded}#Bio|portrait]]\n`);
  const metadata = mutationMetadata(vault, 'Books/Book.md', saved), links = metadata.get('Books/Book.md')!.links;
  assert.equal(links.length, 2);
  for (const link of links) {
    const resolved = metadata.resolveLink('Books/Book.md', link.target, link.kind);
    assert.equal(resolved, destination); assert.equal((await adapter.stat(resolved!))!.entryId, id);
  }
  assert.equal(await adapter.read('Books/Author Grace.md'), 'wrong local');
});

test('all 37 scalar/list frontmatter relations update while comments, prose and code remain byte-exact', async () => {
  const files: Record<string, string> = { 'Author Grace.md': 'person', 'Archive/Keep.md': '' };
  const expected = new Map<string, string>();
  for (let i = 0; i < 37; i++) {
    const value = i % 2 ? `'[[/Author%20Grace.md|Alias ${i}]]'` : `["[[/Author%20Grace.md|Alias ${i}]]"]`;
    const text = `\uFEFF---\r\nauthor: ${value} # preserve ${i}\r\nprose: 'Mention [[/Author%20Grace.md]] in text'\r\n---\r\nBody ${i}\r\n\x60[[/Author%20Grace.md]]\x60\r\n`;
    const path = `Books/Book ${i}.md`; files[path] = text; expected.set(path, text.replace('/Author%20Grace.md|Alias', '/Archive/Author%20Ada.md|Alias'));
  }
  const adapter = new IdentityAdapter(files), vault = new Vault(adapter); await vault.initialize(); const id = (await adapter.stat('Author Grace.md'))!.entryId;
  await vault.rename('Author Grace.md', 'Archive/Author Ada.md');
  for (const [path, text] of expected) {
    assert.equal(await adapter.read(path), text, path);
    const raw = readProperties(text).find(property => property.key === 'author')!.value;
    assert.ok((Array.isArray(raw) ? raw[0] : raw as string).includes('/Archive/Author%20Ada.md'));
    const metadata = mutationMetadata(vault, path, text), links = metadata.get(path)!.links;
    assert.equal(links.length, 1, path); const resolved = metadata.resolveLink(path, links[0].target);
    assert.equal((await adapter.stat(resolved!))!.entryId, id);
  }
});

test('durable namespace frontmatter rewrites retain coherent source identity and compare-and-write admission', async () => {
  const storage = new IdentityAdapter({ 'Author Grace.md': 'person', 'Book.md': '---\nauthor: "[[/Author%20Grace.md]]"\n---\nbody\n' });
  const read = async (path: string) => { const entry = (await storage.stat(path))!; return { path, entryId: entry.entryId!, revision: entry.revision!, content: await storage.read(path), stat: { ctime: entry.ctime ?? 0, mtime: entry.mtime, size: entry.size } }; };
  const comparisons: unknown[] = [];
  const adapter = { durableNamespace: true, list: () => storage.list(), stat: (path: string) => storage.stat(path), read: (path: string) => storage.read(path),
    mkdir: (path: string) => storage.mkdir(path), trash: (path: string) => storage.trash(path), rename: (from: string, to: string) => storage.rename(from, to),
    write: async () => { throw new Error('blind write forbidden'); },
    durableWrites: { readText: read, readTextById: async (id: string) => { const entry = (await storage.list()).find(entry => entry.entryId === id); return entry ? read(entry.path) : null; } },
    compareAndWrite: async (path: string, expected: string, text: string, witness: unknown) => { comparisons.push(witness); const current = await read(path); assert.deepEqual(witness, { entryId: current.entryId, revision: current.revision }); assert.equal(current.content, expected); await storage.write(path, text); },
  } as unknown as VaultAdapter;
  const vault = new Vault(adapter); await vault.initialize(); const original = await storage.stat('Author Grace.md');
  await vault.rename('Author Grace.md', 'Author Ada.md');
  assert.equal(await storage.read('Book.md'), '---\nauthor: "[[/Author%20Ada.md]]"\n---\nbody\n');
  assert.equal(comparisons.length, 1); assert.equal((await storage.stat('Author Ada.md'))!.entryId, original!.entryId);
});

test('frontmatter source mapping handles doubled single quotes, double-quote escapes, Unicode escapes and aliases', async () => {
  const person = `Author's Old.md`;
  const source = `---\nshared: &person '[[/Author''s%20Old.md|Writer''s note]]' # anchor\nauthor: *person\nlist: [*person, "[[\\/Author's\\u0020Old.md|A\\\"lias]]"]\n'[[/Author''s%20Old.md]]': mapping key stays\n---\nbody\n`;
  const adapter = new IdentityAdapter({ [person]: 'person', 'Book.md': source }), vault = new Vault(adapter); await vault.initialize();
  const ordinary = parseMetadata('Book.md', source); assert.equal(ordinary.links.length, 0, 'normal metadata remains unchanged');
  const local = parseMetadata('Book.md', source, { frontmatterLinks: true }); assert.equal(local.links.length, 2, 'aliases share their original physical scalar');
  await vault.rename(person, `New's Name.md`);
  const saved = await adapter.read('Book.md');
  assert.equal(saved, `---\nshared: &person '[[/New%27s%20Name.md|Writer''s note]]' # anchor\nauthor: *person\nlist: [*person, "[[/New%27s Name.md|A\\\"lias]]"]\n'[[/Author''s%20Old.md]]': mapping key stays\n---\nbody\n`);
  const properties = Object.fromEntries(readProperties(saved).map(property => [property.key, property.value]));
  assert.equal(properties.author, properties.shared); assert.equal((properties.list as string[])[0], properties.shared);
  const metadata = mutationMetadata(vault, 'Book.md', saved);
  for (const link of metadata.get('Book.md')!.links) assert.equal(metadata.resolveLink('Book.md', link.target), `New's Name.md`);
});

test('explicit relative wiki paths follow source moves and target moves without changing ordinary aliases or Markdown formatting', async () => {
  const adapter = new MemoryAdapter({ 'People/Old Name.md': 'person', 'Books/Book.md': '[[../People/Old%20Name.md|Person]] [person](../People/Old%20Name.md)\n', 'Books/Local.md': '[[./Book|Alias]]', 'Destination/Keep.md': '' });
  const vault = new Vault(adapter); await vault.initialize();
  await vault.rename('Books', 'Destination/Moved');
  assert.equal(await adapter.read('Destination/Moved/Book.md'), '[[../../People/Old%20Name.md|Person]] [person](../../People/Old%20Name.md)\n');
  assert.equal(await adapter.read('Destination/Moved/Local.md'), '[[./Book|Alias]]');
  await vault.rename('People/Old Name.md', 'People/New Name.md');
  assert.equal(await adapter.read('Destination/Moved/Book.md'), '[[../../People/New%20Name.md|Person]] [person](../../People/New%20Name.md)\n');
});

test('literal percent escapes remain literal filename text after wiki target renames', async () => {
  const adapter = new MemoryAdapter({ 'Old.md': 'person', 'Link.md': '[[Old|label]]' }), vault = new Vault(adapter); await vault.initialize();
  await vault.rename('Old.md', 'New%20Name#Part|End[].md');
  assert.equal(await adapter.read('Link.md'), '[[New%2520Name%23Part%7CEnd%5B%5D|label]]');
  const note = vault.metadata.get('Link.md')!; assert.equal(note.links.length, 1); assert.equal(vault.metadata.resolveLink('Link.md', note.links[0].target), 'New%20Name#Part|End[].md');
});

for (const [destination, target] of [
  ['http:New.md', '/http:New'],
  [' New.md', '%20New'],
  ['New .md', 'New%20'],
  [' New .md', '%20New%20'],
  ['\u00a0New\u00a0.md', '%C2%A0New%C2%A0'],
]) test(`wiki rename resolves scheme-like or edge-whitespace filename ${JSON.stringify(destination)} to the same stable identity`, async () => {
  const adapter = new IdentityAdapter({ 'Old.md': 'person', 'Nested/Book.md': '---\nauthor: "[[Old|Author]]"\n---\n![[Old#Bio|portrait]]\n' });
  const vault = new Vault(adapter); await vault.initialize(); const id = (await adapter.stat('Old.md'))!.entryId;
  await vault.rename('Old.md', destination);
  const saved = await adapter.read('Nested/Book.md');
  assert.equal(saved, `---\nauthor: "[[${target}|Author]]"\n---\n![[${target}#Bio|portrait]]\n`);
  const metadata = mutationMetadata(vault, 'Nested/Book.md', saved);
  for (const link of metadata.get('Nested/Book.md')!.links) {
    const resolved = metadata.resolveLink('Nested/Book.md', link.target, link.kind);
    assert.equal(resolved, destination); assert.equal((await adapter.stat(resolved!))!.entryId, id);
  }
});

test('affected complex YAML links reject before namespace mutation while unrelated complex links do not block a rename', async () => {
  const source = '---\nauthor: |-\n  [[/Author.md]]\n---\nbody\n';
  const adapter = new MemoryAdapter({ 'Author.md': 'author', 'Other.md': 'other', 'Book.md': source }), vault = new Vault(adapter); await vault.initialize();
  await assert.rejects(vault.rename('Author.md', 'Renamed.md'), /Book.md.*complex YAML.*rename was not applied/);
  assert.equal(await adapter.read('Author.md'), 'author'); assert.equal(await adapter.read('Book.md'), source); assert.equal(await adapter.stat('Renamed.md'), null);
  await vault.rename('Other.md', 'Other renamed.md'); assert.equal(await adapter.read('Book.md'), source);
});
