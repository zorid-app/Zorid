import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';
import { BaseController, createBaseMutationHost } from '../src/bases/controller.ts';
import { createBaseViewActions } from '../src/bases/view-actions.ts';
import { createBaseSession } from '../src/bases/session.ts';
import { baseEditAdmissionReceipt, recordBaseEditAdmission, withBaseEditAdmissionPhase } from '../src/bases/edit-admission-diagnostics.ts';
import type { BaseEditAdmissionSnapshot } from '../src/bases/edit-admission-diagnostics.ts';

const source = '---\nrating: 1\n---\nKeep body.\n';
async function fixture() {
  const adapter = new MemoryAdapter({ 'Work.base': 'views:\n  - {type: table, name: Table, order: [file.name, rating]}\n', 'One.md': source });
  const vault = new Vault(adapter); await vault.initialize();
  let release!: () => void, requested = false; const gate = new Promise<void>(resolve => { release = resolve; });
  const buffer = new NoteBuffer(vault, 'One.md', { debounceMs: 60000 }); await buffer.load();
  const controller = new BaseController({ vault, basePath: 'Work.base', mutations: createBaseMutationHost({ validate() {}, async getBuffer() { requested = true; await gate; return buffer; } }) });
  await controller.refresh();
  return { adapter, vault, controller, buffer, release,
    async waitForBuffer() { for (let i = 0; i < 100 && !requested; i++) await Promise.resolve(); assert.equal(requested, true); },
    requested: () => requested,
    async close() { release(); controller.dispose(); await buffer.dispose(); },
  };
}

test('diagnostic tagging and phase annotation preserve the original error, message, stack and serial', () => {
  const error = new Error('existing guard message'), stack = error.stack;
  const tagged = recordBaseEditAdmission(error, { guard: 'controller', phase: 'controller-guard', reason: 'epoch', submittedVersion: 31, currentVersion: 31, hasResult: true, queryError: false, updating: false, privatePath: 'PRIVATE_PATH', privateContents: 'PRIVATE_CONTENTS' } as BaseEditAdmissionSnapshot);
  assert.equal(tagged, error); const before = baseEditAdmissionReceipt(error)!;
  assert.throws(() => withBaseEditAdmissionPhase('after-buffer-load', () => { throw error; }), actual => actual === error);
  const after = baseEditAdmissionReceipt(error)!;
  assert.equal(after.serial, before.serial); assert.equal(after.phase, 'after-buffer-load'); assert.equal(error.message, 'existing guard message'); assert.equal(error.stack, stack);
  assert.equal(Object.isFrozen(after), true); assert.equal(JSON.stringify(after).includes('PRIVATE'), false); assert.deepEqual(Object.keys(error), []);
  const ordinary = new Error('ordinary'); assert.throws(() => withBaseEditAdmissionPhase('before-buffer', () => { throw ordinary; }), actual => actual === ordinary); assert.equal(baseEditAdmissionReceipt(ordinary), undefined);
});

test('view action version rejection remains before buffer admission and records its original outcome', async () => {
  const f = await fixture(); try {
    const actions = createBaseViewActions(f.controller, { validate() {} });
    await assert.rejects(actions.editProperty({ version: f.controller.state.version - 1, path: 'One.md', property: 'note.rating', value: { type: 'number', value: 5 } }), error => {
      assert.equal((error as Error).message, 'This base result is stale; refresh before editing');
      assert.match((error as Error).stack!.split('\n')[1], /at current /); assert.doesNotMatch((error as Error).stack!, /at rejection /);
      const record = baseEditAdmissionReceipt(error)!; assert.equal(record.guard, 'view-actions'); assert.equal(record.phase, 'action-current'); assert.equal(record.reason, 'version'); assert.equal(record.currentVersion, f.controller.state.version); return true;
    });
    assert.equal(f.requested(), false); assert.equal(await f.vault.read('One.md'), source);
  } finally { await f.close(); }
});

test('an epoch-only rejection during buffer loading records equal versions and preserved file identity without writing', async () => {
  const f = await fixture(); try {
    let observed: unknown;
    const version = f.controller.state.version, pending = f.controller.editProperty({ version, path: 'One.md', property: 'note.rating', value: 5 });
    await f.waitForBuffer(); await f.vault.create('Unrelated.md', 'Unrelated fixture'); f.release();
    await assert.rejects(pending, error => {
      observed = error;
      assert.equal((error as Error).message, 'This base result is stale; refresh before editing'); assert.match((error as Error).stack!.split('\n')[1], /at (?:Object\.)?validate /); assert.doesNotMatch((error as Error).stack!, /at rejection /); const record = baseEditAdmissionReceipt(error)!;
      assert.equal(record.guard, 'controller'); assert.equal(record.phase, 'after-buffer-load'); assert.equal(record.reason, 'epoch');
      assert.equal(record.submittedVersion, version); assert.equal(record.currentVersion, version); assert.ok(record.currentEpoch! > record.capturedEpoch!);
      assert.equal(record.targetIdentityMatches, true); assert.equal(record.baseIdentityMatches, true); assert.equal(record.disposed, false);
      assert.equal(JSON.stringify(record).includes('One.md'), false); assert.equal(JSON.stringify(record).includes('rating'), false); return true;
    });
    await f.controller.refresh(); assert.ok(f.controller.state.version > version); assert.equal(baseEditAdmissionReceipt(observed)!.currentVersion, version, 'Receipt stays at rejection time after later query admission');
    assert.equal(await f.vault.read('One.md'), source); assert.equal(f.buffer.dirty, false);
  } finally { await f.close(); }
});

test('a completed newer query records a version rejection at the existing post-load validation', async () => {
  const f = await fixture(); try {
    const version = f.controller.state.version, pending = f.controller.editProperty({ version, path: 'One.md', property: 'note.rating', value: 5 });
    await f.waitForBuffer(); await f.vault.create('Unrelated.md', 'Unrelated fixture'); await f.controller.refresh(); f.release();
    await assert.rejects(pending, error => { const record = baseEditAdmissionReceipt(error)!; assert.equal(record.reason, 'version'); assert.equal(record.phase, 'after-buffer-load'); assert.equal(record.submittedVersion, version); assert.ok(record.currentVersion > version); assert.equal(record.targetIdentityMatches, true); return true; });
    assert.equal(await f.vault.read('One.md'), source);
  } finally { await f.close(); }
});

test('target retirement retains its identity rejection and marks the post-load guard phase', async () => {
  const f = await fixture(); try {
    const pending = f.controller.editProperty({ version: f.controller.state.version, path: 'One.md', property: 'note.rating', value: 5 });
    await f.waitForBuffer(); await f.vault.trash('One.md'); f.release();
    await assert.rejects(pending, error => {
      assert.match((error as Error).stack!.split('\n')[1], /at (?:Object\.)?validateWrite /); const record = baseEditAdmissionReceipt(error)!; assert.equal(record.reason, 'identity'); assert.equal(record.phase, 'after-buffer-load'); assert.equal(record.targetIdentityMatches, false); assert.equal(record.baseIdentityMatches, true); assert.equal(record.currentTargetIdentity, null); return true;
    });
    assert.equal(f.buffer.dirty, false);
  } finally { await f.close(); }
});

test('controller disposal retains its original rejection and records disposal separately from identity', async () => {
  const f = await fixture(); try {
    const pending = f.controller.editProperty({ version: f.controller.state.version, path: 'One.md', property: 'note.rating', value: 5 }); await f.waitForBuffer(); f.controller.dispose(); f.release();
    await assert.rejects(pending, error => { const record = baseEditAdmissionReceipt(error)!; assert.equal(record.reason, 'closed'); assert.equal(record.disposed, true); assert.equal(record.targetIdentityMatches, true); assert.equal(record.phase, 'after-buffer-load'); return true; });
    assert.equal(await f.vault.read('One.md'), source);
  } finally { await f.close(); }
});

test('session publishes only the actual rejection receipt while preserving the editable draft and file', async () => {
  const adapter = new MemoryAdapter({ 'Work.base': 'views:\n  - {type: table, name: Table, order: [file.name, rating]}\n', 'One.md': source });
  const vault = new Vault(adapter); await vault.initialize();
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), host = dom.window.document.querySelector('main')!;
  const buffer = new NoteBuffer(vault, 'One.md', { debounceMs: 60000 }); await buffer.load();
  let release!: () => void, requested = false; const gate = new Promise<void>(resolve => { release = resolve; }), errors: unknown[] = [];
  const session = createBaseSession(host, { vault, basePath: 'Work.base', validate() {}, openFile() {}, onError(error) { errors.push(error); }, buffers: { validate() {}, async getBuffer() { requested = true; await gate; return buffer; } } });
  await session.ready;
  try {
    const cell = host.querySelector<HTMLElement>('[data-path="One.md"][data-property="note.rating"]')!; cell.click(); const input = cell.querySelector('input')!; input.value = '5';
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    for (let i = 0; i < 100 && !requested; i++) await Promise.resolve(); assert.equal(requested, true);
    await vault.create('Unrelated.md', 'unrelated'); release();
    for (let i = 0; i < 100 && !errors.some(error => baseEditAdmissionReceipt(error)); i++) await Promise.resolve();
    const error = errors.find(error => baseEditAdmissionReceipt(error)), record = baseEditAdmissionReceipt(error)!;
    assert.ok(record); const marker = host.querySelector<HTMLElement>('.bases-session')!.dataset.baseLastEditRejection!;
    assert.deepEqual(JSON.parse(marker), record); assert.equal(record.phase, 'after-buffer-load'); assert.equal(record.guard, 'controller');
    assert.equal(marker.includes('One.md'), false); assert.equal(marker.includes('rating'), false); assert.equal(marker.includes('Keep body'), false);
    assert.equal(input.value, '5'); assert.equal(input.getAttribute('aria-invalid'), 'true'); assert.equal(input.disabled, false); assert.equal(await vault.read('One.md'), source);
  } finally {
    release(); const input = host.querySelector('input.metadata-input'); input?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0)); await session.close(); await buffer.dispose(); dom.window.close();
  }
});
