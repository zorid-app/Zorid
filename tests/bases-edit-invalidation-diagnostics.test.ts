import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';
import { BaseController, createBaseMutationHost } from '../src/bases/controller.ts';
import { baseEditAdmissionReceipt, recordBaseEditAdmission } from '../src/bases/edit-admission-diagnostics.ts';
import type { BaseEditAdmissionReceipt, BaseEditAdmissionSnapshot } from '../src/bases/edit-admission-diagnostics.ts';
import type { BaseClockHost } from '../src/bases/clock.ts';
import type { BaseQueryResult } from '../src/bases/query.ts';
const base = 'views:\n  - {type: table, name: First, order: [file.name, rating]}\n  - {type: table, name: Second}\n';
class Clock implements BaseClockHost {
  visible = true; now = 100; zone = 'UTC'; listeners = new Set<() => void>();
  capture() { return { clockMs: this.now, timezone: this.zone }; }
  isVisible() { return this.visible; }
  subscribeWake(callback: () => void) { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; }
  scheduleAt() { return () => {}; }
  wake() { for (const callback of this.listeners) callback(); }
}
class Adapter extends MemoryAdapter {
  fail = false;
  override async write(path: string, text: string) { if (this.fail) throw new Error('fixture disk full'); return super.write(path, text); }
}
// The same validator handed to the mutation host; no production test seam.
// Clock branch fixtures supply deterministic existing core advice separately.
type GuardAccess = { guard(version: number, path: string): { validate(): void }; stale: boolean; lastCapture: { clockMs: number; timezone: string }; current: { result: BaseQueryResult; version: number } };
async function fixture() {
  const adapter = new Adapter({ 'Work.base': base, 'One.md': '---\nrating: 1\n---\n', 'Other.md': 'Other' });
  const vault = new Vault(adapter); await vault.initialize(); const clock = new Clock(), buffers = new Map<string, NoteBuffer>();
  const getBuffer = async (path: string) => { let buffer = buffers.get(path); if (!buffer) { buffer = new NoteBuffer(vault, path, { debounceMs: 60000 }); buffers.set(path, buffer); } await buffer.load(); return buffer; };
  const controller = new BaseController({ vault, basePath: 'Work.base', clock, delayMs: 10000, mutations: createBaseMutationHost({ validate() {}, getBuffer }) });
  await controller.refresh(); const access = controller as unknown as GuardAccess;
  return { adapter, vault, controller, clock, access, getBuffer, guard: () => access.guard(controller.state.version, 'One.md'), async close() { adapter.fail = false; controller.dispose(); for (const buffer of buffers.values()) await buffer.dispose(); } };
}
function rejected(guard: { validate(): void }): BaseEditAdmissionReceipt {
  let receipt: BaseEditAdmissionReceipt | undefined;
  assert.throws(() => guard.validate(), error => { assert.equal((error as Error).message, 'This base result is stale; refresh before editing'); receipt = baseEditAdmissionReceipt(error); return !!receipt; });
  assert.ok(receipt); assert.equal(JSON.stringify(receipt).includes('Work.base'), false); assert.equal(JSON.stringify(receipt).includes('One.md'), false); return receipt;
}
test('causal schema whitelists enum values and never copies private data', () => {
  const error = new Error('original'), stack = error.stack;
  recordBaseEditAdmission(error, { guard: 'controller', phase: 'controller-guard', reason: 'epoch', submittedVersion: 1, currentVersion: 1, hasResult: true, queryError: false, updating: true, capturedInvalidationKind: 'initial', currentInvalidationKind: 'PRIVATE_PATH', invalidationTargetAffected: true, targetEntryMatches: false, privateRevision: 'PRIVATE_REVISION' } as unknown as BaseEditAdmissionSnapshot);
  const record = baseEditAdmissionReceipt(error)!;
  assert.equal(record.capturedInvalidationKind, 'initial'); assert.equal(Object.hasOwn(record, 'currentInvalidationKind'), false); assert.equal(record.invalidationTargetAffected, true); assert.equal(record.targetEntryMatches, false);
  assert.equal(JSON.stringify(record).includes('PRIVATE'), false); assert.equal(error.stack, stack); assert.deepEqual(Object.keys(error), []);
});
test('all Vault event kinds report only target, Base and other-path roles', async () => {
  for (const event of ['create', 'modify', 'rename', 'delete', 'ready', 'base-modify'] as const) {
    const f = await fixture(); try {
      const guard = f.guard();
      if (event === 'create') await f.vault.create('New.md', 'new');
      if (event === 'modify') await f.vault.modify('One.md', 'Changed target');
      if (event === 'rename') await f.vault.rename('One.md', 'Moved.md');
      if (event === 'delete') await f.vault.trash('One.md');
      if (event === 'ready') await f.vault.initialize();
      if (event === 'base-modify') await f.vault.modify('Work.base', base + '\n# changed\n');
      const record = rejected(guard); assert.equal(record.currentInvalidationKind, `vault-${event === 'base-modify' ? 'modify' : event}`);
      assert.equal(record.invalidationTargetAffected, ['modify', 'rename', 'delete'].includes(event)); assert.equal(record.invalidationBaseAffected, event === 'base-modify');
      assert.equal(record.invalidationOtherPath, ['create', 'rename'].includes(event)); assert.equal(record.capturedStale, false); assert.equal(record.currentStale, true); assert.equal(record.capturedInvalidationKind, 'initial');
    } finally { await f.close(); }
  }
});
test('cached witnesses distinguish unchanged, modified, replaced and unavailable data', async () => {
  for (const change of ['unrelated', 'revision', 'replacement', 'missing', 'no-revision'] as const) {
    const f = await fixture(); try {
      for (const path of ['One.md', 'Work.base']) f.vault.entries.set(path, { ...f.vault.entries.get(path)!, entryId: `PRIVATE_ID_${path}`, revision: 'PRIVATE_REVISION_1' });
      if (change === 'no-revision') f.vault.entries.set('One.md', { ...f.vault.entries.get('One.md')!, revision: undefined });
      const guard = f.guard(), target = { ...f.vault.entries.get('One.md')! }, definition = { ...f.vault.entries.get('Work.base')! };
      await f.vault.create('New.md', 'unrelated');
      // MemoryAdapter's create refreshes its complete legacy entry list. Supply
      // the intended cached receipt frame after that event without host reads.
      f.vault.entries.set('One.md', target); f.vault.entries.set('Work.base', definition);
      if (change === 'revision') f.vault.entries.set('One.md', { ...f.vault.entries.get('One.md')!, revision: 'PRIVATE_REVISION_2' });
      if (change === 'replacement') f.vault.entries.set('One.md', { ...f.vault.entries.get('One.md')!, entryId: 'PRIVATE_OTHER_ID' });
      if (change === 'missing') f.vault.entries.delete('One.md');
      const record = rejected(guard);
      assert.equal(record.capturedTargetEntryAvailable, true); assert.equal(record.currentTargetEntryAvailable, change !== 'missing');
      assert.equal(record.capturedTargetRevisionAvailable, change !== 'no-revision'); assert.equal(record.currentTargetRevisionAvailable, !['missing', 'no-revision'].includes(change));
      assert.equal(record.targetEntryMatches, !['missing', 'replacement'].includes(change)); assert.equal(record.targetRevisionMatches, change === 'unrelated');
      assert.equal(record.baseEntryMatches, true); assert.equal(record.baseRevisionMatches, true); assert.equal(JSON.stringify(record).includes('PRIVATE'), false);
    } finally { await f.close(); }
  }
});
test('clock causes distinguish hidden abort, stale, timezone, deadline and backwards', async () => {
  for (const reason of ['hidden-refresh-abort', 'stale', 'timezone', 'deadline', 'backwards'] as const) {
    const f = await fixture(); try {
      f.access.lastCapture = { clockMs: 100, timezone: 'UTC' };
      f.access.current = { ...f.access.current, result: { ...f.access.current.result, shared: { ...f.access.current.result.shared, refreshHint: { dependency: 'instant', nextWakeMs: 200, timezone: 'UTC' } } } as BaseQueryResult };
      const guard = f.guard(); let pending: Promise<void> | undefined;
      if (reason === 'hidden-refresh-abort') { pending = f.controller.refresh(); f.clock.visible = false; }
      if (reason === 'stale') f.access.stale = true;
      if (reason === 'timezone') f.clock.zone = 'Europe/Paris';
      if (reason === 'deadline') f.clock.now = 201;
      if (reason === 'backwards') f.clock.now = 99;
      f.clock.wake(); const record = rejected(guard); assert.equal(record.currentInvalidationKind, `clock-${reason}`);
      assert.equal(record.invalidationTargetAffected, false); assert.equal(record.invalidationBaseAffected, false); assert.equal(record.invalidationOtherPath, false); assert.equal(record.currentStale, true); await pending;
    } finally { await f.close(); }
  }
});
test('view, search, current-file and disposal causes retain original guard outcomes', async () => {
  for (const kind of ['view-selection', 'search-change', 'current-file-change', 'controller-dispose'] as const) {
    const f = await fixture(); try {
      const guard = f.guard(); let pending: Promise<void> | undefined;
      if (kind === 'view-selection') pending = f.controller.setView(1);
      if (kind === 'search-change') pending = f.controller.setSearchTerms(['fixture']);
      if (kind === 'current-file-change') pending = f.controller.setCurrentFilePath('Other.md');
      if (kind === 'controller-dispose') f.controller.dispose();
      const record = rejected(guard); assert.equal(record.currentInvalidationKind, kind); assert.equal(record.reason, kind === 'controller-dispose' ? 'closed' : 'epoch');
      assert.equal(record.invalidationTargetAffected, false); assert.equal(record.invalidationBaseAffected, false); assert.equal(record.invalidationOtherPath, false); await pending;
    } finally { await f.close(); }
  }
});
test('configuration commit and recovery acknowledgement record their own epoch causes', async () => {
  for (const recovery of [false, true]) {
    const f = await fixture(); try {
      const guard = f.guard(), version = f.controller.state.version;
      if (recovery) { f.adapter.fail = true; await assert.rejects(f.controller.updateConfiguration(version, { view: { rowHeight: 60 } }), /fixture disk full/); f.adapter.fail = false; await (await f.getBuffer('Work.base')).flush(); assert.equal(await f.controller.acknowledgeConfigurationRetry(), true); }
      else await f.controller.updateConfiguration(version, { view: { rowHeight: 60 } });
      const record = rejected(guard); assert.equal(record.currentInvalidationKind, recovery ? 'configuration-retry-ack' : 'configuration-commit');
      assert.equal(record.invalidationTargetAffected, false); assert.equal(record.invalidationBaseAffected, false); assert.equal(record.invalidationOtherPath, false); assert.match(await f.vault.read('Work.base'), /rowHeight: 60/);
    } finally { await f.close(); }
  }
});
test('missing legacy identity or revision never claims durable unchanged data', async () => {
  const f = await fixture(); try {
    const guard = f.guard(); await f.vault.create('New.md', 'new'); const record = rejected(guard);
    for (const key of ['capturedTargetEntryAvailable', 'currentTargetEntryAvailable', 'capturedTargetRevisionAvailable', 'currentTargetRevisionAvailable', 'targetEntryMatches', 'targetRevisionMatches', 'capturedBaseEntryAvailable', 'currentBaseEntryAvailable', 'capturedBaseRevisionAvailable', 'currentBaseRevisionAvailable', 'baseEntryMatches', 'baseRevisionMatches'] as const) assert.equal(record[key], false, key);
  } finally { await f.close(); }
});
