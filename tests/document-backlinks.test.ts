import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { DocumentSemanticsError } from '../src/core/document-semantics.ts';
import type {
  DocumentCursor, DocumentEntry, DocumentPage, DocumentPin, DocumentPinId,
  DocumentRelationshipPage, DocumentService, DocumentSnapshotId, DocumentStageId, DocumentStatus,
} from '../src/core/document-semantics.ts';
import { mountDocumentBacklinks } from '../src/ui/document-backlinks.ts';
import type { DocumentBacklinksTarget } from '../src/ui/document-backlinks.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const snapshot = (generation = '1'): DocumentSnapshotId => ({ localStoreId: 'store', generationEpoch: 'epoch', generation,
  versions: { schema: 1, extraction: 'markdown-1', resolver: 'resolver-1', query: 'query-1' } });
const source = { localStoreId: 'store', watermark: '10' };
const target: DocumentBacklinksTarget = { id: 'target', path: 'Target.md' };
const entry = (id: string, path: string): DocumentEntry => ({ id, path, revision: `revision-${id}`, kind: 'file', deleted: false });
function page(sources: readonly DocumentEntry[] = [], options: { target?: DocumentBacklinksTarget; coverage?: boolean; cursor?: DocumentCursor | null; snapshot?: DocumentSnapshotId } = {}): DocumentPage<DocumentRelationshipPage> {
  const id = options.snapshot ?? snapshot(), coverage = options.coverage ?? true, cursor = options.cursor ?? null;
  const destination = entry((options.target ?? target).id, (options.target ?? target).path);
  return { result: { snapshot: id, source, coverageComplete: coverage, value: {
    snapshot: id, next: null, scanComplete: cursor === null, coverageComplete: coverage, complete: cursor === null && coverage,
    edges: sources.map((item, index) => ({ source: item, target: destination, linkIndex: index,
      link: { kind: 'wiki', embed: false, target: 'Target', fragment: '', destination: 'Target',
        range: { bytes: [0, 10], utf16: [0, 10] }, targetRange: { bytes: [2, 8], utf16: [2, 8] }, definitionRange: null } })),
  } }, cursor };
}
function makePin(read: DocumentPin['backlinks'] = async () => page(), coverage = true) {
  const closed = deferred<void>(); let closeCount = 0;
  const unused = async (): Promise<never> => { throw new Error('Unexpected UI query'); };
  const pin: DocumentPin = { pinId: 'owned-pin' as DocumentPinId, snapshot: snapshot(), source, coverageComplete: coverage,
    close: async () => { closeCount++; closed.resolve(); }, backlinks: read, metadata: unused, search: unused, base: unused };
  return { pin, closed: closed.promise, get closeCount() { return closeCount; } };
}
function makeService(open: DocumentService['open'], initial?: DocumentStatus) {
  const ready: DocumentStatus = { source, snapshot: snapshot(), coveredSource: source, current: true, rebuildRequired: false, coverageComplete: true };
  let status = initial ?? ready, rebuilds = 0, opens = 0;
  const stage = { stageId: 'owned-stage' as DocumentStageId, snapshot: snapshot(), progress: null };
  const service: DocumentService = {
    status: async () => status, initialize: async () => {},
    open: async () => { opens++; return open(); },
    rebuild: async () => { rebuilds++; status = { ...ready, snapshot: null, coveredSource: null, current: false, coverageComplete: null }; },
    begin: async () => stage,
    pump: async () => ({ ...stage, progress: { prepared: 1, total: 1, reused: 0, ready: true } }),
    publish: async () => { status = ready; return snapshot(); }, discard: async () => {},
  };
  return { service, get rebuilds() { return rebuilds; }, get opens() { return opens; }, setStatus(value: DocumentStatus) { status = value; } };
}
function setup(t: TestContext, service: DocumentService | undefined, limits: { maxPages?: number; maxSources?: number } = {}) {
  const dom = new JSDOM('<!doctype html><main></main>'), container = dom.window.document.querySelector<HTMLElement>('main')!;
  const context = { active: true, vault: 'vault', target: target as DocumentBacklinksTarget | null };
  const opened: { id: string; path: string }[] = [];
  const view = mountDocumentBacklinks(container, { service, target, vaultIdentity: 'vault',
    isCurrent: (vault, expected) => context.active && context.vault === vault
      && context.target?.id === expected?.id && context.target?.path === expected?.path,
    onOpenStableEntry: (id, path) => { opened.push({ id, path }); }, ...limits });
  t.after(() => { view.dispose(); dom.window.close(); });
  return { dom, container, context, opened, view };
}

test('shared backlinks deduplicate source IDs and navigate by saved identity', async t => {
  const first = entry('a', 'Folder/Alpha.md'), second = entry('b', 'Beta.md');
  let reads = 0;
  const owned = makePin(async () => ++reads === 1 ? page([first, first], { cursor: 'second-page' as DocumentCursor }) : page([second]));
  const foreign = makePin();
  const service = makeService(async () => owned.pin);
  const ui = setup(t, service.service); await ui.view.ready;
  assert.equal(ui.view.element.dataset.state, 'ready');
  const buttons = [...ui.container.querySelectorAll<HTMLButtonElement>('button[data-entry-id]')];
  assert.deepEqual(buttons.map(button => button.textContent), ['Alpha', 'Beta']);
  assert.deepEqual(buttons.map(button => button.dataset.revision), ['revision-a', 'revision-b']);
  assert.equal(buttons[0].getAttribute('aria-label'), 'Open linked note: Folder/Alpha.md');
  buttons[0].click(); assert.deepEqual(ui.opened, [{ id: 'a', path: 'Folder/Alpha.md' }]);
  ui.context.active = false; buttons[1].click(); assert.equal(ui.opened.length, 1);
  assert.equal(owned.closeCount, 1); assert.equal(foreign.closeCount, 0);
});

test('late pin open closes only the retired request and cannot replace a new target', async t => {
  const opening = deferred<DocumentPin>(), started = deferred<void>();
  const old = makePin(async () => page([entry('old', 'Old.md')]));
  const nextTarget = { id: 'next-target', path: 'Next.md' };
  const fresh = makePin(async () => page([entry('fresh', 'Fresh.md')], { target: nextTarget }));
  let calls = 0;
  const service = makeService(async () => { if (++calls === 1) { started.resolve(); return opening.promise; } return fresh.pin; });
  const ui = setup(t, service.service), retired = ui.view.ready;
  await started.promise;
  ui.context.target = nextTarget; await ui.view.refresh(nextTarget);
  assert.deepEqual([...ui.container.querySelectorAll('button[data-entry-id]')].map(row => (row as HTMLElement).dataset.entryId), ['fresh']);
  opening.resolve(old.pin); await retired;
  assert.equal(old.closeCount, 1); assert.equal(fresh.closeCount, 1);
  assert.doesNotMatch(ui.container.textContent ?? '', /Old/);
});

for (const reason of ['vault', 'cancel', 'dispose'] as const) test(`pending backlinks ${reason} cannot write stale DOM and releases its pin`, async t => {
  const response = deferred<DocumentPage<DocumentRelationshipPage>>(), started = deferred<void>();
  const owned = makePin(async () => { started.resolve(); return response.promise; });
  const service = makeService(async () => owned.pin), ui = setup(t, service.service), retired = ui.view.ready;
  await started.promise;
  if (reason === 'vault') ui.context.vault = 'other-vault';
  else if (reason === 'cancel') ui.view.cancel();
  else ui.view.dispose();
  const replacement = ui.dom.window.document.createElement('p'); replacement.textContent = 'Replacement content'; ui.container.replaceChildren(replacement);
  response.resolve(page([entry('late', 'Late.md')])); await retired;
  assert.equal(ui.container.textContent, 'Replacement content'); assert.equal(owned.closeCount, 1);
});

test('incomplete zero matches never look like a legitimate empty result', async t => {
  const partial = makePin(async () => page([], { coverage: false }), false);
  const partialService = makeService(async () => partial.pin);
  const ui = setup(t, partialService.service); await ui.view.ready;
  assert.equal(ui.view.element.dataset.state, 'incomplete');
  assert.match(ui.container.textContent ?? '', /may be missing/); assert.doesNotMatch(ui.container.textContent ?? '', /No backlinks found/);
  const full = makePin(), completeService = makeService(async () => full.pin), empty = setup(t, completeService.service); await empty.view.ready;
  assert.equal(empty.view.element.dataset.state, 'empty'); assert.match(empty.container.textContent ?? '', /No backlinks found/);
  assert.equal(partial.closeCount, 1); assert.equal(full.closeCount, 1);
});

test('resource truncation and snapshot expiry are explicit rather than empty', async t => {
  const limited = makePin(async () => page([entry('a', 'A.md'), entry('b', 'B.md')]));
  const limitedService = makeService(async () => limited.pin), ui = setup(t, limitedService.service, { maxSources: 1 }); await ui.view.ready;
  assert.equal(ui.view.element.dataset.state, 'incomplete'); assert.match(ui.container.textContent ?? '', /not shown/);
  assert.equal(ui.container.querySelectorAll('button[data-entry-id]').length, 1); assert.equal(limited.closeCount, 1);
  const expired = makePin(async () => { throw new DocumentSemanticsError('snapshot_expired'); });
  const expiredService = makeService(async () => expired.pin), failed = setup(t, expiredService.service); await failed.view.ready;
  assert.equal(failed.view.element.dataset.state, 'unavailable'); assert.match(failed.container.textContent ?? '', /changed while loading/);
  assert.doesNotMatch(failed.container.textContent ?? '', /No backlinks found/); assert.equal(expired.closeCount, 1);
});

test('a mismatched report snapshot cannot supply rows for the current target', async t => {
  const owned = makePin(async () => page([entry('wrong', 'Wrong.md')], { snapshot: snapshot('2') }));
  const service = makeService(async () => owned.pin), ui = setup(t, service.service); await ui.view.ready;
  assert.equal(ui.view.element.dataset.state, 'unavailable'); assert.equal(ui.container.querySelectorAll('[data-entry-id]').length, 0);
  assert.equal(owned.closeCount, 1); assert.doesNotMatch(ui.container.textContent ?? '', /No backlinks found/);
});

test('an explicit cache-corruption rebuild stays visible and precedes a valid empty result', async t => {
  const owned = makePin(), start = deferred<void>(), finish = deferred<void>();
  const service = makeService(async () => owned.pin, { source, snapshot: null, coveredSource: null, current: false, rebuildRequired: true, coverageComplete: null });
  const rebuild = service.service.rebuild;
  service.service.rebuild = async () => { start.resolve(); await finish.promise; await rebuild(); };
  const ui = setup(t, service.service); await start.promise;
  assert.match(ui.container.textContent ?? '', /Rebuilding the note index/); assert.equal(service.opens, 0);
  finish.resolve(); await ui.view.ready;
  assert.equal(service.rebuilds, 1); assert.equal(ui.view.element.dataset.state, 'empty'); assert.equal(owned.closeCount, 1);
});
