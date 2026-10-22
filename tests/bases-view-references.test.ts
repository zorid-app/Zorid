import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import { Vault } from '../src/core/vault.ts';
import type { VaultEntry } from '../src/core/types.ts';
import type { DocumentEntry, DocumentLink, DocumentService } from '../src/core/document-semantics.ts';
import { baseViewReferenceKey, closeBaseViewReferenceQueries, prepareBaseViewReferences } from '../src/bases/view-references.ts';

const snapshot = { localStoreId: 'store', generationEpoch: 'epoch', generation: '1', versions: { schema: 1, extraction: 'md1', resolver: 'r1', query: 'q1' } };
const source = { localStoreId: 'store', watermark: '1' };
const range = (start: number, end: number) => ({ utf16: [start, end] as const, bytes: [start, end] as const });
const texts = { 'Work.base': 'views: [{type: table, name: Old View}]', 'One.md': '😀 ![[Work.base#OLD VIEW|Alias]]\n[shown][ref]\n[ref]: <Work.base#Old%20View> "title"\n[[Work.base#Other]]\n', 'Two.md': 'before [[Work.base#Old View]] after' };
class Adapter extends MemoryAdapter {
  documentSemantics?: DocumentService;
  revisions = new Map<string, number>();
  ids = new Map<string, string>();
  identify(entry: VaultEntry): VaultEntry { return { ...entry, entryId: this.ids.get(entry.path) ?? entry.path.replace(/\W/g, '_'), revision: String(this.revisions.get(entry.path) ?? 1) }; }
  override async list() { return (await super.list()).map(entry => this.identify(entry)); }
  override async stat(path: string) { const entry = await super.stat(path); return entry ? this.identify(entry) : null; }
  override async write(path: string, text: string) { await super.write(path, text); this.revisions.set(path, (this.revisions.get(path) ?? 1) + 1); }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean) { for (let n = 0; n < 200 && !check(); n++) await new Promise(resolve => setTimeout(resolve, 1)); assert.ok(check()); }
async function fixture() {
  const adapter = new Adapter(texts), vault = new Vault(adapter); await vault.initialize();
  const toEntry = (entry: VaultEntry): DocumentEntry => ({ id: entry.entryId!, revision: entry.revision!, path: entry.path, kind: 'file', deleted: false });
  const base = { ...vault.entries.get('Work.base')! }, target = toEntry(base);
  const links = (path: keyof typeof texts) => {
    const text = texts[path], result: DocumentLink[] = [];
    for (const raw of ['Work.base#OLD VIEW', 'Work.base#Old%20View', 'Work.base#Old View', 'Work.base#Other']) {
      const start = text.indexOf(raw); if (start < 0) continue;
      result.push({ kind: raw.includes('%20') ? 'markdown' : 'wiki', embed: raw.includes('OLD VIEW'), target: 'Work.base', fragment: raw.slice('Work.base'.length), destination: raw,
        targetRange: range(start, start + 'Work.base'.length), range: range(start, start + raw.length), definitionRange: raw.includes('%20') ? range(start - 1, start + raw.length + 1) : null });
    }
    return result;
  };
  const edges = ['One.md', 'Two.md'].flatMap(path => links(path as keyof typeof texts).map((link, linkIndex) => ({ source: toEntry(vault.entries.get(path)!), target, linkIndex, link })));
  // Two uses of a reference-style definition must rewrite its shared range once.
  edges.push({ ...edges.find(edge => edge.link.kind === 'markdown')!, linkIndex: 99 });
  const events: string[] = [], calls: any[] = [], writes: string[] = [];
  const buffers = new Map<string, string>();
  let live = true, failPath: string | undefined, failBacklinks = false, closeFailures = 0, partial = false, drift = false;
  let gate: ReturnType<typeof deferred> | undefined;
  const unused = async (): Promise<never> => { throw new Error('Unexpected index operation'); };
  const service = {
    status: async () => ({ snapshot, source, coveredSource: source, current: !drift, coverageComplete: true, rebuildRequired: false }),
    initialize: unused, rebuild: unused, begin: unused, pump: unused, publish: unused, discard: unused,
    open: async () => { events.push('open'); return { pinId: 'pin', snapshot, source, coverageComplete: true,
      close: async () => { events.push('close'); if (closeFailures-- > 0) throw new Error('close failed'); },
      metadata: async () => ({ snapshot, source, coverageComplete: true, value: { entry: target, metadata: null, exclusion: null } }),
      backlinks: async (input: unknown) => {
        calls.push(input); events.push('backlinks'); if (gate) await gate.promise; if (failBacklinks) throw new Error('core unavailable');
        return { result: { snapshot, source, coverageComplete: !partial, value: { snapshot, edges, next: null, scanComplete: true, coverageComplete: !partial, complete: !partial } }, cursor: null };
      }, search: unused, base: unused,
    }; },
  } as unknown as DocumentService;
  adapter.documentSemantics = service;
  const validate = () => { if (!live) throw new Error('stale owner'); };
  const input = { vault, base, from: 'Old View', to: 'New & Name', validate, validateWrite: validate, validateRenamed: async () => { validate(); },
    mutations: { async transform(path: string, transform: (source: string) => string, check: () => void, _write: unknown, witness: any) {
      check(); const entry = await adapter.stat(path); check();
      assert.ok(witness); if (entry?.entryId !== witness.entryId || entry?.revision !== witness.revision) throw new Error('saved reference identity changed');
      const before = buffers.get(path) ?? await adapter.read(path), after = transform(before); buffers.set(path, after); check();
      if (path === failPath) throw new Error('reference save failed');
      await adapter.write(path, after); writes.push(path);
    } },
  };
  return { adapter, vault, input, calls, events, writes, buffers, edges, service,
    fail(path?: string) { failPath = path; }, failCore() { failBacklinks = true; }, failClose() { closeFailures = 1; }, partial() { partial = true; }, stale() { live = false; }, drift() { drift = true; },
    hold() { gate = deferred(); return gate; },
  };
}

test('one retained core backlink plan preserves aliases, reference definitions, Unicode and exact saved witnesses', async () => {
  const f = await fixture(), operation = await prepareBaseViewReferences(f.input);
  assert.equal(f.writes.length, 0); assert.equal(f.events.at(-1), 'close');
  assert.deepEqual(f.calls, [{ targetId: 'Work_base', limit: 1000 }]); assert.equal(operation.plan.mode, 'core');
  assert.deepEqual(operation.plan.changes.map(change => [change.path, change.references]), [['One.md', 2], ['Two.md', 1]]);
  const report = await operation.run(); assert.equal(report.references, 3); assert.deepEqual(report.failedPaths, []);
  assert.equal(await f.adapter.read('One.md'), '😀 ![[Work.base#New & Name|Alias]]\n[shown][ref]\n[ref]: <Work.base#New%20%26%20Name> "title"\n[[Work.base#Other]]\n');
  assert.equal(await f.adapter.read('Two.md'), 'before [[Work.base#New & Name]] after');
  assert.deepEqual(operation.plan.changes[0].witness, { entryId: 'One_md', revision: '1' });
});
test('a failed reference retains exact draft, reports independent successes and retries only original failed files', async () => {
  const f = await fixture(), operation = await prepareBaseViewReferences(f.input); f.fail('One.md');
  await assert.rejects(operation.run(), error => { const e = error as any; assert.deepEqual(e.report.completedPaths, ['Two.md']); assert.deepEqual(e.report.failedPaths, ['One.md']); assert.equal(e.report.references, 1); return true; });
  assert.match(f.buffers.get('One.md')!, /#New & Name/); assert.equal(await f.adapter.read('One.md'), texts['One.md']);
  f.fail(); await operation.run(); assert.deepEqual(f.writes, ['Two.md', 'One.md']);
});
test('dirty or replaced source is preserved rather than guessed into an original reference transform', async () => {
  const f = await fixture(), operation = await prepareBaseViewReferences(f.input);
  f.buffers.set('One.md', `${texts['One.md']}unsaved typing`); f.adapter.ids.set('Two.md', 'replacement');
  await assert.rejects(operation.run(), error => { assert.deepEqual((error as any).report.failedPaths, ['One.md', 'Two.md']); return true; });
  assert.equal(f.buffers.get('One.md'), `${texts['One.md']}unsaved typing`); assert.equal(await f.adapter.read('Two.md'), texts['Two.md']); assert.deepEqual(f.writes, []);
});
test('advertised core failures, incomplete pages and source motion never fall back to legacy parsing', async () => {
  for (const failure of ['core', 'partial', 'drift'] as const) {
    const f = await fixture();
    if (failure === 'core') f.failCore(); else if (failure === 'partial') f.partial(); else f.drift();
    await assert.rejects(prepareBaseViewReferences(f.input)); assert.equal(f.writes.length, 0);
    if (failure !== 'drift') assert.equal(f.events.filter(event => event === 'close').length, 1);
  }
});
test('stale core completion retires its original pin and publishes no plan', async () => {
  const f = await fixture(), gate = f.hold(), pending = prepareBaseViewReferences(f.input);
  await until(() => f.events.includes('backlinks')); f.stale(); gate.resolve(); await assert.rejects(pending, /stale owner/); assert.equal(f.events.at(-1), 'close');
});
test('a failed preparation close stays owned and is acknowledged before another generation opens', async () => {
  const f = await fixture(); f.failClose();
  await assert.rejects(prepareBaseViewReferences(f.input), /close failed/); assert.deepEqual(f.writes, []);
  await closeBaseViewReferenceQueries(f.service); await prepareBaseViewReferences(f.input);
  assert.deepEqual(f.events.filter(event => event === 'close' || event === 'open'), ['open', 'close', 'close', 'open', 'close']);
});
test('reference matching follows punctuation and whitespace normalized heading keys', () => {
  assert.equal(baseViewReferenceKey('  MY   view!?  '), baseViewReferenceKey('my view'));
});
