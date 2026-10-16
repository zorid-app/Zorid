import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import type { VaultAdapter, VaultEntry } from '../src/core/types.ts';

function seed(count: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`Note ${i}.md`, `# Note ${i}\n[[Note 0]]`]));
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

class MeasuredAdapter extends MemoryAdapter {
  reads: string[] = [];
  lists = 0;
  stats: string[] = [];
  unreadable = '';
  override async list(): Promise<VaultEntry[]> { this.lists++; return super.list(); }
  override async stat(path: string): Promise<VaultEntry | null> { this.stats.push(path); return super.stat(path); }
  override async read(path: string): Promise<string> {
    this.reads.push(path);
    if (path === this.unreadable) throw new Error(`unreadable: ${path}`);
    return super.read(path);
  }
  reset(): void { this.reads = []; this.lists = 0; this.stats = []; }
}

test('saving in a large vault reads only the modified note and updates links, tags, headings and UTF-8 stats', async () => {
  const adapter = new MeasuredAdapter(seed(1500));
  const vault = new Vault(adapter);
  await vault.initialize();
  const unchanged = vault.metadata.get('Note 2.md');
  adapter.reset();
  // An unrelated broken file must not turn a successful note save into a failure.
  adapter.unreadable = 'Note 1499.md';
  const text = '---\naliases: [Changed]\ntags: [edited]\n---\n# 🌱 new heading\n[[Note 1]]';
  const events: string[] = [];
  vault.on('modify', event => events.push(event.path));
  await vault.modify('Note 0.md', text, { expectedContent: '# Note 0\n[[Note 0]]' });
  assert.deepEqual(adapter.reads, ['Note 0.md', 'Note 0.md']);
  assert.equal(adapter.lists, 0);
  assert.deepEqual(adapter.stats, ['Note 0.md']);
  assert.deepEqual(vault.entries.get('Note 0.md'), await adapter.stat('Note 0.md'));
  assert.equal(vault.entries.get('Note 0.md')!.size, new TextEncoder().encode(text).length);
  assert.equal(vault.metadata.get('Note 2.md'), unchanged);
  assert.deepEqual(vault.metadata.get('Note 0.md')!.aliases, ['Changed']);
  assert.deepEqual(vault.metadata.get('Note 0.md')!.tags, ['edited']);
  assert.equal(vault.metadata.get('Note 0.md')!.headings[0].heading, '🌱 new heading');
  assert.deepEqual(vault.metadata.backlinks('Note 1.md').map(link => link.source), ['Note 0.md']);
  assert.equal(vault.metadata.backlinks('Note 0.md').length, 1499);
  assert.deepEqual(events, ['Note 0.md']);
  adapter.unreadable = '';
  await vault.reload();
  // The content snapshot must have advanced with the save; no false reload event.
  assert.deepEqual(events, ['Note 0.md']);
});

test('legacy adapters without stat list metadata once but never reread unrelated content on save', async () => {
  const backing = new MeasuredAdapter(seed(100));
  const adapter: VaultAdapter = {
    list: () => backing.list(), read: path => backing.read(path),
    write: (path, text) => backing.write(path, text), mkdir: path => backing.mkdir(path),
    rename: (from, to) => backing.rename(from, to), trash: path => backing.trash(path),
  };
  const vault = new Vault(adapter);
  await vault.initialize();
  backing.reset();
  backing.unreadable = 'Note 1.md';
  await vault.modify('Note 0.md', 'é🌱');
  assert.deepEqual(backing.reads, ['Note 0.md']);
  assert.equal(backing.lists, 1);
  assert.deepEqual(vault.entries.get('Note 0.md'), await backing.stat('Note 0.md'));
  assert.equal(vault.entries.get('Note 0.md')!.size, 6);
});

test('initial indexing caps read concurrency and still indexes every Markdown note', async () => {
  class SlowAdapter extends MemoryAdapter {
    active = 0;
    maximum = 0;
    total = 0;
    override async read(path: string): Promise<string> {
      this.active++;
      this.maximum = Math.max(this.maximum, this.active);
      this.total++;
      try {
        await new Promise<void>(resolve => setImmediate(resolve));
        return await super.read(path);
      } finally { this.active--; }
    }
  }
  const adapter = new SlowAdapter({ ...seed(100), 'diagram.svg': '<svg></svg>' });
  const vault = new Vault(adapter);
  await vault.initialize();
  assert.equal(adapter.maximum, 8);
  assert.equal(adapter.active, 0);
  assert.equal(adapter.total, 100);
  assert.equal([...vault.metadata.entries()].length, 100);
  assert.equal(vault.metadata.backlinks('Note 0.md').length, 100);
  assert.equal(vault.metadata.resolveLink('Note 0.md', 'diagram.svg'), 'diagram.svg');
});

test('failed refresh retains the complete prior snapshot and drains workers before queued work', async () => {
  const started = deferred(), fail = deferred(), drain = deferred();
  class FailingAdapter extends MemoryAdapter {
    failing = false;
    readsStarted = 0;
    override async read(path: string): Promise<string> {
      if (this.failing) {
        if (++this.readsStarted === 8) started.resolve();
        if (path === 'Note 0.md') { await fail.promise; throw new Error('cannot read note'); }
        await drain.promise;
      }
      return super.read(path);
    }
  }
  const adapter = new FailingAdapter(seed(30)), vault = new Vault(adapter);
  await vault.initialize();
  const oldEntries = vault.entries, oldMetadata = vault.metadata;
  await adapter.write('Note 9.md', '# external');
  adapter.failing = true;
  let settled = false, queuedReadFinished = false;
  const reload = vault.reload().then(() => { settled = true; }, error => { settled = true; throw error; });
  const rejection = assert.rejects(reload, /cannot read note/);
  const queuedRead = vault.read('Note 1.md').then(() => { queuedReadFinished = true; });
  await started.promise;
  fail.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(queuedReadFinished, false);
  assert.equal(vault.entries, oldEntries);
  assert.equal(vault.metadata, oldMetadata);
  adapter.failing = false;
  drain.resolve();
  await rejection;
  await queuedRead;
  assert.equal(adapter.readsStarted, 8);
  assert.equal(vault.entries, oldEntries);
  assert.equal(vault.metadata, oldMetadata);
  assert.equal(vault.metadata.get('Note 9.md')!.headings[0].heading, 'Note 9');
  await vault.reload();
  assert.equal(vault.metadata.get('Note 9.md')!.headings[0].heading, 'external');
});

test('failed write or post-write stat does not publish a partial index or silently overwrite later changes', async () => {
  class FailingAdapter extends MemoryAdapter {
    failWrite = false;
    failStat = false;
    override async write(path: string, text: string): Promise<void> {
      if (this.failWrite) throw new Error('disk full');
      await super.write(path, text);
    }
    override async stat(path: string): Promise<VaultEntry | null> {
      if (this.failStat) throw new Error('cannot stat');
      return super.stat(path);
    }
  }
  const adapter = new FailingAdapter({ 'One.md': '# original' }), vault = new Vault(adapter);
  await vault.initialize();
  const originalEntry = vault.entries.get('One.md'), originalMetadata = vault.metadata.get('One.md');
  const events: string[] = [];
  vault.on('modify', event => events.push(event.path));
  adapter.failWrite = true;
  await assert.rejects(vault.modify('One.md', '# draft', { expectedContent: '# original' }), /disk full/);
  assert.equal(await adapter.read('One.md'), '# original');
  adapter.failWrite = false;
  adapter.failStat = true;
  await assert.rejects(vault.modify('One.md', '# draft', { expectedContent: '# original' }), /cannot stat/);
  assert.equal(await adapter.read('One.md'), '# draft');
  assert.equal(vault.entries.get('One.md'), originalEntry);
  assert.equal(vault.metadata.get('One.md'), originalMetadata);
  assert.deepEqual(events, []);
  adapter.failStat = false;
  await adapter.write('One.md', '# external');
  await assert.rejects(vault.modify('One.md', '# retry', { expectedContent: '# original' }), /outside this editor/);
  assert.equal(await adapter.read('One.md'), '# external');
  await vault.reload();
  assert.equal(vault.metadata.get('One.md')!.headings[0].heading, 'external');
});

test('path reload catches equal-size equal-timestamp edits without rereading unrelated notes or duplicating own saves', async () => {
  class FixedClockAdapter extends MeasuredAdapter {
    override async list(): Promise<VaultEntry[]> { return (await super.list()).map(entry => ({ ...entry, mtime: 12 })); }
    override async stat(path: string): Promise<VaultEntry | null> {
      const entry = await super.stat(path);
      return entry ? { ...entry, mtime: 12 } : null;
    }
  }
  const adapter = new FixedClockAdapter({ 'One.md': '# old', ...seed(1000) });
  const vault = new Vault(adapter);
  await vault.initialize();
  const events: string[] = [];
  vault.on('modify', event => events.push(event.path));
  const old = vault.entries.get('One.md');
  await adapter.write('One.md', '# new');
  adapter.reset();
  adapter.unreadable = 'Note 999.md';
  await vault.reload(['One.md', './One.md']);
  assert.deepEqual(adapter.reads, ['One.md']);
  assert.deepEqual(adapter.stats, ['One.md']);
  assert.equal(adapter.lists, 0);
  assert.deepEqual(vault.entries.get('One.md'), old);
  assert.equal(vault.metadata.get('One.md')!.headings[0].heading, 'new');
  assert.deepEqual(events, ['One.md']);
  await vault.modify('One.md', '# own', { expectedContent: '# new' });
  const savedMetadata = vault.metadata.get('One.md');
  adapter.reset();
  await vault.reload(['One.md']);
  assert.deepEqual(adapter.reads, ['One.md']);
  assert.equal(adapter.lists, 0);
  assert.equal(vault.metadata.get('One.md'), savedMetadata);
  assert.deepEqual(events, ['One.md', 'One.md']);
});

test('targeted reload publishes complete batches before events and preserves all old state on read failure', async () => {
  const adapter = new MeasuredAdapter({ 'One.md': '# old one', 'Two.md': '# old two' });
  const vault = new Vault(adapter);
  await vault.initialize();
  const oldOne = vault.metadata.get('One.md'), oldTwo = vault.metadata.get('Two.md');
  const oldEntries = [...vault.entries];
  const events: string[] = [];
  const observedHeadings: string[][] = [];
  vault.on('modify', event => {
    events.push(event.path);
    observedHeadings.push([
      vault.metadata.get('One.md')!.headings[0].heading,
      vault.metadata.get('Two.md')!.headings[0].heading,
    ]);
  });
  await adapter.write('One.md', '# new one');
  await adapter.write('Two.md', '# new two');
  adapter.unreadable = 'Two.md';
  await assert.rejects(vault.reload(['One.md', 'Two.md']), /unreadable/);
  assert.deepEqual([...vault.entries], oldEntries);
  assert.equal(vault.metadata.get('One.md'), oldOne);
  assert.equal(vault.metadata.get('Two.md'), oldTwo);
  assert.deepEqual(events, []);
  adapter.unreadable = '';
  await vault.reload(['One.md', 'Two.md']);
  assert.deepEqual(events, ['One.md', 'Two.md']);
  assert.deepEqual(observedHeadings, [['new one', 'new two'], ['new one', 'new two']]);
  await vault.reload(['One.md', 'Two.md']);
  assert.deepEqual(events, ['One.md', 'Two.md']);
});

test('targeted reload bounds both stat and content operations for large watcher batches', async () => {
  class SlowAdapter extends MemoryAdapter {
    reads = 0;
    stats = 0;
    maxReads = 0;
    maxStats = 0;
    override async stat(path: string): Promise<VaultEntry | null> {
      this.maxStats = Math.max(this.maxStats, ++this.stats);
      try {
        await new Promise<void>(resolve => setImmediate(resolve));
        return await super.stat(path);
      } finally { this.stats--; }
    }
    override async read(path: string): Promise<string> {
      this.maxReads = Math.max(this.maxReads, ++this.reads);
      try {
        await new Promise<void>(resolve => setImmediate(resolve));
        return await super.read(path);
      } finally { this.reads--; }
    }
  }
  const adapter = new SlowAdapter(seed(50)), vault = new Vault(adapter);
  await vault.initialize();
  adapter.maxReads = 0;
  await vault.reload([...vault.entries.keys()]);
  assert.equal(adapter.maxReads, 8);
  assert.equal(adapter.maxStats, 8);
  assert.equal(adapter.reads, 0);
  assert.equal(adapter.stats, 0);
});

test('missing, unknown, folder and root watcher paths fall back to a full structural refresh', async () => {
  const adapter = new MeasuredAdapter({ 'One.md': '# One', 'Folder/Two.md': '# Two' });
  const vault = new Vault(adapter);
  await vault.initialize();
  const events: string[] = [];
  for (const type of ['create', 'delete'] as const) vault.on(type, event => events.push(`${type}:${event.path}`));
  adapter.reset();
  await adapter.trash('One.md');
  await vault.reload(['One.md']);
  assert.equal(adapter.lists, 1);
  assert.deepEqual(events, ['delete:One.md']);
  await adapter.write('New.md', '# New');
  await vault.reload(['New.md']);
  assert.equal(adapter.lists, 2);
  assert.deepEqual(events, ['delete:One.md', 'create:New.md']);
  await adapter.rename('Folder/Two.md', 'Folder/Moved.md');
  await vault.reload(['Folder']);
  assert.equal(adapter.lists, 3);
  assert.deepEqual(events.slice(-2), ['delete:Folder/Two.md', 'create:Folder/Moved.md']);
  await adapter.write('Root notification.md', '# Root');
  await vault.reload(['']);
  assert.equal(adapter.lists, 4);
  assert.equal(events.at(-1), 'create:Root notification.md');
});

test('targeted reload falls back for adapters without stat', async () => {
  const backing = new MeasuredAdapter(seed(20));
  const adapter: VaultAdapter = {
    list: () => backing.list(), read: path => backing.read(path),
    write: (path, text) => backing.write(path, text), mkdir: path => backing.mkdir(path),
    rename: (from, to) => backing.rename(from, to), trash: path => backing.trash(path),
  };
  const vault = new Vault(adapter);
  await vault.initialize();
  backing.reset();
  await backing.write('Note 0.md', '# changed');
  await vault.reload(['Note 0.md']);
  assert.equal(backing.lists, 1);
  assert.equal(backing.reads.length, 20);
  assert.equal(vault.metadata.get('Note 0.md')!.headings[0].heading, 'changed');
});
