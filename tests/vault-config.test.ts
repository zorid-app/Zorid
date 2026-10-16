import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import { VaultConfig, VaultConfigError, normalizeConfigDir } from '../src/core/vault-config.ts';
import type { ConfigPatch, ConfigAdapter } from '../src/core/vault-config.ts';

const app = '.obsidian/app.json', appearance = '.obsidian/appearance.json';
const isCode = (code: VaultConfigError['code']) => (error: unknown): boolean => error instanceof VaultConfigError && error.code === code;

class HiddenAdapter extends MemoryAdapter {
  writes = 0;
  async list(): Promise<never> { throw new Error('Config service must not discover hidden files through listing'); }
  async write(path: string, content: string): Promise<void> { this.writes++; await super.write(path, content); }
}

test('missing config reads defaults without writing or enumerating the vault', async () => {
  const adapter = new HiddenAdapter(), config = new VaultConfig(adapter);
  const snapshot = await config.read('app');
  assert.equal(snapshot.content, null);
  assert.deepEqual(snapshot.data, {});
  assert.equal(snapshot.preferences.tabSize, 4);
  assert.equal(snapshot.preferences.useMarkdownLinks, false);
  assert.equal(snapshot.preferences.newLinkFormat, 'shortest');
  assert.equal(snapshot.preferences.alwaysUpdateLinks, false);
  assert.deepEqual(snapshot.issues, []);
  assert.equal(await adapter.stat('.obsidian'), null);
  assert.equal(adapter.writes, 0);
  assert.equal(config.atomicCompareAndWrite, false);
});

test('creating a patch creates only the selected config file and never serializes defaults', async () => {
  const adapter = new HiddenAdapter(), config = new VaultConfig(adapter);
  const saved = await config.patch('app', { useTab: false, tabSize: 2 });
  assert.deepEqual(JSON.parse(await adapter.read(app)), { useTab: false, tabSize: 2 });
  assert.equal(saved.preferences.useTab, false);
  assert.equal(saved.preferences.smartIndentList, true);
  assert.equal(await adapter.stat(appearance), null);
  assert.equal((await adapter.stat('.obsidian'))?.type, 'folder');
  assert.equal(adapter.writes, 1);
});

test('patching retains unknown member spelling, unsafe-size numbers, nested data and prototype keys', async () => {
  const original = '{\r\n\t"unknown\\u004bey" : { "escaped":"\\u0041", "items":[1e999,900719925474099312345] },\r\n\t"__proto__": {"safe":true},\r\n\t"tabSize": 4\r\n}\r\n';
  const adapter = new HiddenAdapter({ [app]: original }), config = new VaultConfig(adapter);
  const result = await config.patch('app', { tabSize: 8 });
  assert.ok(result.content!.includes('"unknown\\u004bey" : { "escaped":"\\u0041", "items":[1e999,900719925474099312345] }'));
  assert.ok(result.content!.includes('"__proto__": {"safe":true}'));
  assert.ok(result.content!.includes('\r\n\t"tabSize": 8'));
  assert.deepEqual(result.data.__proto__, { safe: true });
  assert.equal(result.preferences.tabSize, 8);
  assert.equal(({} as { safe?: boolean }).safe, undefined);
});

test('known invalid stored values stay intact and surface issues while typed reads use defaults', async () => {
  const source = '{"tabSize":"four","useMarkdownLinks":null,"newLinkFormat":"mystery","unknown":true}';
  const adapter = new HiddenAdapter({ [app]: source }), config = new VaultConfig(adapter);
  const read = await config.read('app');
  assert.equal(read.preferences.tabSize, 4);
  assert.equal(read.preferences.useMarkdownLinks, false);
  assert.equal(read.preferences.newLinkFormat, 'shortest');
  assert.deepEqual(read.issues.map(issue => issue.key).sort(), ['newLinkFormat', 'tabSize', 'useMarkdownLinks']);
  await config.patch('app', { smartIndentList: false });
  assert.ok((await adapter.read(app)).includes('"tabSize":"four"'));
  assert.ok((await adapter.read(app)).includes('"newLinkFormat":"mystery"'));
  assert.equal(adapter.writes, 1);
});

test('app and appearance documents preserve separate unknown keys and cloned defaults', async () => {
  const adapter = new HiddenAdapter({ [app]: '{"custom":1}', [appearance]: '{"custom":2,"theme":"moonstone"}' });
  const config = new VaultConfig(adapter), initial = await config.read('appearance');
  assert.equal(initial.preferences.theme, 'moonstone');
  initial.preferences.enabledCssSnippets.push('mutated snapshot');
  assert.deepEqual((await config.read('appearance')).preferences.enabledCssSnippets, []);
  await config.patch('appearance', { theme: 'obsidian', enabledCssSnippets: ['layout'], accentColor: '#123456' });
  assert.equal(await adapter.read(app), '{"custom":1}');
  assert.deepEqual(JSON.parse(await adapter.read(appearance)), { custom: 2, theme: 'obsidian', enabledCssSnippets: ['layout'], accentColor: '#123456' });
});

test('undefined deletes only selected keys; no-op patches preserve exact bytes and avoid file creation', async () => {
  const source = '{\n  "unknown": {"x":1},\n  "tabSize":4,\n  "useTab":true\n}\n';
  const adapter = new HiddenAdapter({ [app]: source }), config = new VaultConfig(adapter);
  await config.patch('app', { tabSize: 4, absent: undefined });
  assert.equal(adapter.writes, 0);
  assert.equal(await adapter.read(app), source);
  await config.patch('app', { tabSize: undefined });
  assert.deepEqual(JSON.parse(await adapter.read(app)), { unknown: { x: 1 }, useTab: true });
  await config.patch('app', { unknown: undefined, useTab: undefined });
  assert.deepEqual(JSON.parse(await adapter.read(app)), {});
  await config.patch('appearance', { absent: undefined });
  assert.equal(await adapter.stat(appearance), null);
});

test('stale snapshots merge independent external changes and preserve their original values', async () => {
  const adapter = new HiddenAdapter({ [app]: '{"tabSize":4,"external":0}' }), config = new VaultConfig(adapter);
  const before = await config.read('app');
  await adapter.write(app, '{"tabSize":4,"external":900719925474099312345,"newSetting":{"ok":true}}');
  const result = await config.patch('app', { tabSize: 2 }, { expectedContent: before.content });
  assert.equal(result.preferences.tabSize, 2);
  assert.ok(result.content!.includes('"external":900719925474099312345'));
  assert.deepEqual(result.data.newSetting, { ok: true });
});

test('stale same-key edits reject without overwriting; already-applied edits are no-ops', async () => {
  const adapter = new HiddenAdapter({ [app]: '{"tabSize":4}' }), config = new VaultConfig(adapter);
  const before = await config.read('app');
  await adapter.write(app, '{"tabSize":8}');
  await assert.rejects(config.patch('app', { tabSize: 2 }, { expectedContent: before.content }), isCode('conflict'));
  assert.equal(await adapter.read(app), '{"tabSize":8}');
  const writes = adapter.writes;
  await config.patch('app', { tabSize: 8 }, { expectedContent: before.content });
  assert.equal(adapter.writes, writes);
  await assert.rejects(config.patch('app', { tabSize: undefined }, { expectedContent: before.content }), isCode('conflict'));
});

test('two services sharing an adapter serialize patches and capture mutable input before queuing', async () => {
  const adapter = new HiddenAdapter(), one = new VaultConfig(adapter), two = new VaultConfig(adapter);
  const patch = { tabSize: 2, nested: { items: ['original'] } };
  const pending = one.patch('app', patch);
  patch.tabSize = 8; patch.nested.items[0] = 'mutated';
  await Promise.all([pending, two.patch('app', { useTab: false }), one.patch('app', { smartIndentList: false })]);
  assert.deepEqual(JSON.parse(await adapter.read(app)), { tabSize: 2, nested: { items: ['original'] }, useTab: false, smartIndentList: false });
});

test('external edit after initial read is rechecked and merged before fallback write', async () => {
  class EditAfterRead extends HiddenAdapter {
    edited = false;
    async read(path: string): Promise<string> {
      const value = await super.read(path);
      if (!this.edited) { this.edited = true; await super.write(path, '{"tabSize":4,"external":true}'); }
      return value;
    }
  }
  const adapter = new EditAfterRead({ [app]: '{"tabSize":4}' }), config = new VaultConfig(adapter);
  await config.patch('app', { tabSize: 2 });
  assert.deepEqual(JSON.parse(await adapter.read(app)), { tabSize: 2, external: true });
});

test('file created externally during directory creation is merged rather than replaced', async () => {
  class CreateDuringMkdir extends HiddenAdapter {
    async mkdir(path: string): Promise<void> { await super.mkdir(path); await super.write(app, '{"external":true}'); }
  }
  const adapter = new CreateDuringMkdir(), config = new VaultConfig(adapter);
  await config.patch('app', { tabSize: 2 }, { expectedContent: null });
  assert.deepEqual(JSON.parse(await adapter.read(app)), { external: true, tabSize: 2 });
});

test('same-key or malformed external edit during a patch is preserved and rejects', async () => {
  for (const external of ['{"tabSize":8}', '{malformed']) {
    class EditAfterRead extends HiddenAdapter {
      edited = false;
      async read(path: string): Promise<string> {
        const value = await super.read(path);
        if (!this.edited) { this.edited = true; await super.write(path, external); }
        return value;
      }
    }
    const adapter = new EditAfterRead({ [app]: '{"tabSize":4}' }), config = new VaultConfig(adapter);
    await assert.rejects(config.patch('app', { tabSize: 2 }), isCode(external.includes('malformed') ? 'invalid-json' : 'conflict'));
    assert.equal(await adapter.read(app), external);
  }
});

test('optional compare-and-write retries a lost race and never uses the unguarded write method', async () => {
  class ConditionalAdapter extends HiddenAdapter {
    attempts = 0;
    async write(): Promise<never> { throw new Error('Unguarded write'); }
    async writeIfUnchanged(path: string, content: string, expected: string | null): Promise<boolean> {
      this.attempts++;
      if (this.attempts === 1) { await super.write(path, '{"tabSize":4,"external":true}'); return false; }
      const actual = await this.stat(path) ? await this.read(path) : null;
      if (actual !== expected) return false;
      await super.write(path, content); return true;
    }
  }
  const adapter = new ConditionalAdapter({ [app]: '{"tabSize":4}' }), config = new VaultConfig(adapter);
  assert.equal(config.atomicCompareAndWrite, true);
  await config.patch('app', { tabSize: 2 });
  assert.equal(adapter.attempts, 2);
  assert.deepEqual(JSON.parse(await adapter.read(app)), { tabSize: 2, external: true });
});

test('continuous contention is bounded and a failed operation does not poison the queue', async () => {
  class BusyAdapter extends HiddenAdapter {
    attempts = 0; busy = true;
    async writeIfUnchanged(path: string, content: string, expected: string | null): Promise<boolean> {
      this.attempts++;
      if (this.busy) return false;
      assert.equal(await this.read(path), expected);
      await super.write(path, content); return true;
    }
  }
  const adapter = new BusyAdapter({ [app]: '{"tabSize":4}' }), config = new VaultConfig(adapter);
  await assert.rejects(config.patch('app', { tabSize: 2 }), isCode('conflict'));
  assert.equal(adapter.attempts, 4);
  assert.equal(await adapter.read(app), '{"tabSize":4}');
  adapter.busy = false;
  assert.equal((await config.patch('app', { tabSize: 2 })).preferences.tabSize, 2);
});

test('post-write external replacement is reported without a destructive retry', async () => {
  class ReplaceAfterWrite extends HiddenAdapter {
    async write(path: string, content: string): Promise<void> { await super.write(path, content); await super.write(path, '{"external":"winner"}'); }
  }
  const adapter = new ReplaceAfterWrite({ [app]: '{}' }), config = new VaultConfig(adapter);
  await assert.rejects(config.patch('app', { useTab: false }), isCode('conflict'));
  assert.equal(await adapter.read(app), '{"external":"winner"}');
  assert.equal(adapter.writes, 2);
});

test('malformed, non-object and duplicate-key documents are never overwritten', async () => {
  for (const source of ['', '{', 'null', '[]', '1', '{"tabSize":4,"tabSize":8}', '{"x":1,"\\u0078":2}', '\uFEFF{}']) {
    const adapter = new HiddenAdapter({ [app]: source }), config = new VaultConfig(adapter);
    await assert.rejects(config.read('app'), isCode('invalid-json'));
    await assert.rejects(config.patch('app', { tabSize: 2 }), isCode('invalid-json'));
    assert.equal(await adapter.read(app), source);
    assert.equal(adapter.writes, 0);
  }
});

test('invalid known preferences, unserializable values and unsafe config paths reject before I/O', async () => {
  const adapter = new HiddenAdapter(), config = new VaultConfig(adapter);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const patch of [{ tabSize: 0 }, { tabSize: 1.5 }, { useTab: 'yes' }, { newLinkFormat: 'guess' },
    { attachmentFolderPath: '../outside' }, { newFileFolderPath: '/outside' }, { anything: Infinity },
    { anything: new Date() }, { anything: [undefined] }, { anything: cyclic }]) {
    assert.throws(() => config.patch('app', patch as ConfigPatch<'app'>), isCode('invalid-value'));
  }
  for (const path of ['', '.', '..', '../escape', '.obsidian/../outside', '/.obsidian', '.obsidian\\other', '.obsidian\0', 'normal', '.bad:', '.bad ']) {
    assert.throws(() => new VaultConfig(adapter, { configDir: path }), /hidden vault-relative/);
  }
  assert.throws(() => config.read('../outside' as 'app'), /Unsupported/);
  assert.equal(normalizeConfigDir('.Cafe\u0301'), '.Café');
  assert.equal(adapter.writes, 0);
  assert.equal(await adapter.stat('.obsidian'), null);
});

test('custom hidden directory stays within its own namespace', async () => {
  const adapter = new HiddenAdapter(), config = new VaultConfig(adapter, { configDir: '.custom' });
  await config.patch('app', { tabSize: 3 });
  assert.equal((await config.read('app')).path, '.custom/app.json');
  assert.deepEqual(JSON.parse(await adapter.read('.custom/app.json')), { tabSize: 3 });
  assert.equal(await adapter.stat(app), null);
});

test('permission and write errors propagate, retaining disk data and allowing later work', async () => {
  class FailureAdapter extends HiddenAdapter {
    failRead = false; failWrite = false; failStat = false;
    async stat(path: string) { if (this.failStat) throw new Error('stat denied'); return super.stat(path); }
    async read(path: string) { if (this.failRead) throw new Error('read denied'); return super.read(path); }
    async write(path: string, content: string) { if (this.failWrite) throw new Error('write denied'); return super.write(path, content); }
  }
  const adapter = new FailureAdapter({ [app]: '{"tabSize":4}' }), config = new VaultConfig(adapter);
  adapter.failStat = true; await assert.rejects(config.read('app'), /stat denied/); adapter.failStat = false;
  adapter.failRead = true; await assert.rejects(config.patch('app', { tabSize: 2 }), /read denied/); adapter.failRead = false;
  adapter.failWrite = true; await assert.rejects(config.patch('app', { tabSize: 2 }), /write denied/); adapter.failWrite = false;
  assert.equal(await adapter.read(app), '{"tabSize":4}');
  assert.equal((await config.patch('app', { tabSize: 2 })).preferences.tabSize, 2);
});

test('directory/file obstructions fail without replacing existing content', async () => {
  const adapter = new HiddenAdapter({ '.obsidian': 'not a folder' }), config = new VaultConfig(adapter);
  await assert.rejects(config.patch('app', { tabSize: 2 }), isCode('not-file'));
  assert.equal(await adapter.read('.obsidian'), 'not a folder');
  const second = new HiddenAdapter(); await second.mkdir('.obsidian'); await second.mkdir(app);
  await assert.rejects(new VaultConfig(second).read('app'), isCode('not-file'));
});

test('adapters without stat recognize only explicit ENOENT, not generic read failures', async () => {
  const backing = new MemoryAdapter();
  const adapter: ConfigAdapter = {
    list: () => backing.list(), mkdir: path => backing.mkdir(path), rename: (from, to) => backing.rename(from, to), trash: path => backing.trash(path),
    write: (path, content) => backing.write(path, content),
    read: async path => {
      if (!(await backing.stat(path))) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return backing.read(path);
    },
  };
  const config = new VaultConfig(adapter);
  assert.equal((await config.read('app')).content, null);
  await config.patch('app', { useTab: false });
  adapter.read = async () => { throw new Error('unclassified read error'); };
  await assert.rejects(config.patch('app', { useTab: true }), /unclassified read error/);
  assert.deepEqual(JSON.parse(await backing.read(app)), { useTab: false });
});


test('desktop direct hidden-file access works even though normal listing hides configuration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'zorid-vault-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { VaultService } = createRequire(import.meta.url)('../desktop/vault-service.cjs');
  const adapter = await VaultService.open(root), config = new VaultConfig(adapter);
  await config.patch('app', { tabSize: 2, externalPlugin: { enabled: true } });
  await config.patch('appearance', { theme: 'moonstone' });
  assert.deepEqual(await adapter.list(), []);
  assert.deepEqual(JSON.parse(await readFile(join(root, app), 'utf8')), { tabSize: 2, externalPlugin: { enabled: true } });
  const previous = await config.read('app');
  await config.patch('app', { smartIndentList: false }, { expectedContent: previous.content });
  assert.equal((await config.read('app')).preferences.smartIndentList, false);
});

test('member scanning handles escaped keys, punctuation inside strings and deep unknown values', async () => {
  const source = JSON.stringify({ '': [1, { text: '},: [ \"' }], 'quoted"key': { items: [null, true, { value: 'end\\' }] }, tabSize: 4 }, null, 2);
  const adapter = new HiddenAdapter({ [app]: source }), config = new VaultConfig(adapter);
  const result = await config.patch('app', { tabSize: 2, added: ['hello', { nested: false }] });
  assert.deepEqual(result.data[''], JSON.parse(source)['']);
  assert.deepEqual(result.data['quoted"key'], JSON.parse(source)['quoted"key']);
  await config.patch('app', { '': undefined, 'quoted"key': undefined });
  assert.deepEqual(JSON.parse(await adapter.read(app)), { tabSize: 2, added: ['hello', { nested: false }] });
});

test('patches reject accessors and toJSON hooks without executing them or writing', async () => {
  const adapter = new HiddenAdapter({ [app]: '{}' }), config = new VaultConfig(adapter);
  let invoked = 0;
  const getter = { get useTab() { invoked++; return false; } };
  const nestedGetter = { get allowed() { invoked++; return 1; } };
  const custom = { allowed: 1 };
  Object.defineProperty(custom, 'toJSON', { enumerable: false, value() { invoked++; return { actual: Infinity }; } });
  const enumerableHook = { allowed: 1, toJSON() { invoked++; return null; } };
  const arrayGetter: unknown[] = [1];
  Object.defineProperty(arrayGetter, '0', { enumerable: true, get() { invoked++; return 2; } });
  const iterator = [1];
  Object.defineProperty(iterator, Symbol.iterator, { value() { invoked++; throw new Error('Unexpected iteration'); } });
  for (const patch of [getter, { custom: nestedGetter }, { custom }, { custom: enumerableHook }, { custom: arrayGetter }, { custom: iterator }]) {
    assert.throws(() => config.patch('app', patch as ConfigPatch<'app'>), isCode('invalid-value'));
  }
  assert.equal(invoked, 0);
  assert.equal(adapter.writes, 0);
  assert.equal(await adapter.read(app), '{}');
});

test('patch snapshots reject hidden properties and sparse/extended arrays while retaining inert JSON keys', async () => {
  const adapter = new HiddenAdapter({ [app]: '{}' }), config = new VaultConfig(adapter);
  const hidden = Object.defineProperty({ allowed: 1 }, 'secret', { enumerable: false, value: 2 });
  const sparse = new Array(2); sparse[1] = 1;
  const extra = Object.assign([1], { unexpected: 2 });
  for (const custom of [hidden, sparse, extra]) assert.throws(() => config.patch('app', { custom } as ConfigPatch<'app'>), isCode('invalid-value'));
  const plain = JSON.parse('{"toJSON":"ordinary key","__proto__":{"safe":true},"constructor":null}');
  await config.patch('app', { custom: plain, items: [1, null, { flag: true }] });
  assert.deepEqual(JSON.parse(await adapter.read(app)), { custom: plain, items: [1, null, { flag: true }] });
  assert.equal(({} as { safe?: boolean }).safe, undefined);
});
