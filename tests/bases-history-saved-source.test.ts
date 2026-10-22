import test from 'node:test';
import assert from 'node:assert/strict';
import { BaseController, BaseBulkEditError, createBaseMutationHost } from '../src/bases/controller.ts';
import type { BaseConditionalSavedSource } from '../src/bases/controller.ts';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import { readProperties } from '../src/core/properties.ts';
import type { NoteBuffer } from '../src/ui/note-buffer.ts';
import type { ConditionalSavedSourceCapture } from '../src/core/durable-writes.ts';

const note = '---\nscore: 9\n---\nOriginal body\n';
const score = (source: string) => readProperties(source).find(p => p.key === 'score')?.value;
const touched = () => new Error('A touched property changed after this command; its current value was preserved');
const check = (expected: number) => (source: string) => { if (score(source) !== expected) throw touched(); };

/** Models the agreed capture ownership protocol, not native physical/CRDT correctness. */
class GuardedBuffer {
  path = 'One.md'; entryId = 'entry-One'; revision = 'r1'; text = note; savedText = note; physical = note;
  dirty = false; error: Error | null = null; captures = 0; releases = 0; updates = 0; flushes = 0;
  statuses = new WeakMap<ConditionalSavedSourceCapture, 'unattached' | 'pending' | 'settled' | 'foreign'>();
  attached?: ConditionalSavedSourceCapture; received: ConditionalSavedSourceCapture[] = [];
  onCapture?: () => void; onFlush?: () => Promise<void>; write?: (text: string) => Promise<void>;
  get savedDurableWitness() { return { entryId: this.entryId, revision: this.revision, path: this.path }; }
  async load() {}
  async captureConditionalSavedSource(witness, validate = () => {}) {
    validate(); assert.deepEqual(witness, this.savedDurableWitness); this.captures++;
    const capture = Object.freeze({ captureId: 'capture-' + this.captures, logicalWitness: Object.freeze({ ...witness }), source: this.physical });
    this.statuses.set(capture, 'unattached'); this.onCapture?.(); return capture;
  }
  async releaseConditionalSavedSource(capture) { assert.equal(this.statuses.get(capture), 'unattached'); this.statuses.set(capture, 'settled'); this.releases++; }
  conditionalSavedSourceStatus(capture) { return this.statuses.get(capture) ?? 'foreign'; }
  update(text, options) {
    options.validateWrite?.();
    if (options.conditionalSavedSource) {
      const capture = options.conditionalSavedSource, status = this.conditionalSavedSourceStatus(capture);
      assert.ok(status === 'unattached' || status === 'pending'); assert.ok(!this.attached || this.attached === capture);
      this.attached = capture; this.received.push(capture); this.statuses.set(capture, 'pending');
    }
    this.text = text; this.dirty = true; this.updates++;
  }
  async flush() {
    this.flushes++; await this.onFlush?.(); await this.write?.(this.text);
    this.savedText = this.text; this.dirty = false; this.error = null;
    if (this.attached) { this.statuses.set(this.attached, 'settled'); this.attached = undefined; this.releases++; }
  }
}
function host(buffer = new GuardedBuffer(), validate = () => {}, onBufferChange = () => {}) {
  return { buffer, mutations: createBaseMutationHost({ getBuffer: () => buffer as unknown as NoteBuffer, validate, onBufferChange }) };
}
function condition(expected = 9): BaseConditionalSavedSource { return { attempt: {}, validate: check(expected) }; }
const replace = (source: string) => { check(9)(source); return source.replace('score: 9', 'score: 1'); };

test('physical touched edit rejects before the shared draft transform or publication', async () => {
  const f = host(); f.buffer.physical = note.replace('score: 9', 'score: 7'); f.buffer.text += 'Unsaved body\n'; f.buffer.dirty = true;
  const original = f.buffer.text; let transforms = 0;
  await assert.rejects(f.mutations.transform('One.md', source => { transforms++; return replace(source); }, () => {}, undefined, f.buffer.savedDurableWitness, condition()), /touched property changed/);
  assert.equal(transforms, 0); assert.equal(f.buffer.updates, 0); assert.equal(f.buffer.flushes, 0);
  assert.equal(f.buffer.text, original); assert.equal(f.buffer.savedText, note); assert.equal(f.buffer.releases, 1);
});

test('physical source guard and latest shared draft guard stay separate without adopting physical bytes as baseline', async () => {
  const f = host(); f.buffer.physical += 'External unrelated body\n'; f.buffer.text += 'Local dirty body\n'; f.buffer.dirty = true;
  let capturedBaseline = '';
  const mutations = createBaseMutationHost({ getBuffer: () => f.buffer as unknown as NoteBuffer, validate() {}, onBufferChange() { capturedBaseline = f.buffer.savedText; } });
  await mutations.transform('One.md', replace, () => {}, undefined, f.buffer.savedDurableWitness, condition());
  assert.equal(capturedBaseline, note); assert.equal(score(f.buffer.text), 1); assert.match(f.buffer.text, /Local dirty body/);
  assert.doesNotMatch(f.buffer.text, /External unrelated body/); assert.match(f.buffer.received[0].source, /External unrelated body/);
  assert.equal(f.buffer.received[0].logicalWitness.revision, 'r1'); assert.equal(f.buffer.captures, 1);
});

test('typing delivered during the physical capture is included in the later shared-draft transform', async () => {
  const f = host(); const capture = f.buffer.captureConditionalSavedSource.bind(f.buffer);
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; });
  f.buffer.captureConditionalSavedSource = async (witness, validate) => { entered(); await waiting; return capture(witness, validate); };
  const run = f.mutations.transform('One.md', replace, () => {}, undefined, f.buffer.savedDurableWitness, condition());
  await ready; f.buffer.text += 'Typed during capture\n'; f.buffer.dirty = true; release(); await run;
  assert.equal(score(f.buffer.text), 1); assert.match(f.buffer.text, /Typed during capture/); assert.equal(f.buffer.savedText, f.buffer.text);
});

test('queued conditional descriptors retain the originally accepted callback and attempt identity', async () => {
  const buffer = new GuardedBuffer(); let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const mutations = createBaseMutationHost({ async getBuffer() { await waiting; return buffer as unknown as NoteBuffer; }, validate() {} });
  const original = condition(), operation = mutations.transform('One.md', replace, () => {}, undefined, buffer.savedDurableWitness, original);
  original.validate = () => { throw Error('Caller replaced validator'); }; (original as any).attempt = {};
  release(); await operation; assert.equal(score(buffer.text), 1); assert.equal(buffer.captures, 1);
});

test('a touched local draft rejects after the physical check and releases only the unattached capture', async () => {
  const f = host(); f.buffer.text = note.replace('score: 9', 'score: 7'); f.buffer.dirty = true;
  await assert.rejects(f.mutations.transform('One.md', replace, () => {}, undefined, f.buffer.savedDurableWitness, condition()), /touched property changed/);
  assert.equal(f.buffer.updates, 0); assert.equal(f.buffer.releases, 1); assert.equal(score(f.buffer.text), 7);
});

test('host retirement and replacement during saved-source capture cannot publish a draft', async () => {
  for (const mode of ['owner', 'identity']) {
    let alive = true; const f = host(new GuardedBuffer(), () => { if (!alive) throw Error('Retired host'); });
    f.buffer.onCapture = () => { if (mode === 'owner') alive = false; else f.buffer.entryId = 'replacement'; };
    await assert.rejects(f.mutations.transform('One.md', replace, () => {}, undefined, f.buffer.savedDurableWitness, condition()), /Retired host|replaced or moved/);
    assert.equal(f.buffer.updates, 0); assert.equal(f.buffer.flushes, 0); assert.equal(f.buffer.releases, 1);
  }
});

test('uncertain retry retains the same original capture despite physical changes and core revision advance', async () => {
  const f = host(), original = condition(); let first = true;
  f.buffer.onFlush = async () => { if (first) { first = false; throw Error('Uncertain original save'); } };
  const reverse = (source: string) => score(source) === 1 ? source : replace(source);
  await assert.rejects(f.mutations.transform('One.md', reverse, () => {}, undefined, f.buffer.savedDurableWitness, original), /Uncertain/);
  const capture = f.buffer.received[0]; f.buffer.physical = note.replace('score: 9', 'score: 7');
  await f.mutations.transform('One.md', reverse, () => {}, undefined, { ...f.buffer.savedDurableWitness, revision: 'own-committed-revision' }, original);
  assert.equal(f.buffer.captures, 1); assert.deepEqual(f.buffer.received, [capture]); assert.equal(f.buffer.flushes, 2); assert.equal(f.buffer.releases, 1);
});

test('generic flush settlement acknowledges the original history attempt without reattaching a released capture', async () => {
  const f = host(), original = condition(); let first = true;
  f.buffer.onFlush = async () => { if (first) { first = false; throw Error('Uncertain original save'); } };
  const reverse = (source: string) => score(source) === 1 ? source : replace(source);
  await assert.rejects(f.mutations.transform('One.md', reverse, () => {}, undefined, f.buffer.savedDurableWitness, original), /Uncertain/);
  await f.buffer.flush(); f.buffer.revision = 'r2'; f.buffer.physical = f.buffer.text;
  await f.mutations.transform('One.md', reverse, () => {}, undefined, f.buffer.savedDurableWitness, original);
  assert.equal(f.buffer.captures, 1); assert.equal(f.buffer.received.length, 1); assert.equal(f.buffer.updates, 1); assert.equal(f.buffer.flushes, 2);
});

test('another semantic attempt cannot adopt an uncertain capture; the original retry stays usable', async () => {
  const f = host(), original = condition(); let first = true;
  f.buffer.onFlush = async () => { if (first) { first = false; throw Error('Uncertain original save'); } };
  const reverse = (source: string) => score(source) === 1 ? source : replace(source);
  await assert.rejects(f.mutations.transform('One.md', reverse, () => {}, undefined, f.buffer.savedDurableWitness, original), /Uncertain/);
  await assert.rejects(f.mutations.transform('One.md', reverse, () => {}, undefined, f.buffer.savedDurableWitness, condition()), /original conditional Base command/);
  assert.equal(f.buffer.updates, 1); assert.equal(f.buffer.captures, 1);
  await f.mutations.transform('One.md', reverse, () => {}, undefined, f.buffer.savedDurableWitness, original);
});

test('an original retry cannot recapture through a replacement shared buffer of the same identity', async () => {
  const originalBuffer = new GuardedBuffer(), replacement = new GuardedBuffer(); let current = originalBuffer, first = true;
  originalBuffer.onFlush = async () => { if (first) { first = false; throw Error('Uncertain original save'); } };
  const mutations = createBaseMutationHost({ getBuffer: () => current as unknown as NoteBuffer, validate() {} }), original = condition();
  const reverse = (source: string) => score(source) === 1 ? source : replace(source);
  await assert.rejects(mutations.transform('One.md', reverse, () => {}, undefined, originalBuffer.savedDurableWitness, original), /Uncertain/);
  current = replacement;
  await assert.rejects(mutations.transform('One.md', reverse, () => {}, undefined, replacement.savedDurableWitness, original), /original conditional Base buffer was replaced/);
  assert.equal(replacement.captures, 0); assert.equal(replacement.updates, 0); current = originalBuffer;
  await mutations.transform('One.md', reverse, () => {}, undefined, originalBuffer.savedDurableWitness, original);
  assert.equal(originalBuffer.captures, 1);
});

test('a settled but rejected original guard remains a failed save rather than becoming success', async () => {
  const f = host(), original = condition();
  f.buffer.onFlush = async () => { const capture = f.buffer.received[0]; f.buffer.statuses.set(capture, 'settled'); f.buffer.error = Error('Original native guard rejected'); throw f.buffer.error; };
  const reverse = (source: string) => score(source) === 1 ? source : replace(source);
  await assert.rejects(f.mutations.transform('One.md', reverse, () => {}, undefined, f.buffer.savedDurableWitness, original), /native guard rejected/);
  await assert.rejects(f.mutations.transform('One.md', reverse, () => {}, undefined, f.buffer.savedDurableWitness, original), /native guard rejected/);
  assert.equal(f.buffer.captures, 1); assert.equal(f.buffer.received.length, 1); assert.ok(f.buffer.error);
});

test('a conditional no-op releases its unused capture without updating or flushing a draft', async () => {
  const f = host(); await f.mutations.transform('One.md', source => source, () => {}, undefined, f.buffer.savedDurableWitness, condition());
  assert.equal(f.buffer.releases, 1); assert.equal(f.buffer.updates, 0); assert.equal(f.buffer.flushes, 0);
});

test('release failure retains the unused original capture and reports both failures', async () => {
  const f = host(); f.buffer.physical = note.replace('score: 9', 'score: 7'); const original = condition();
  const release = f.buffer.releaseConditionalSavedSource.bind(f.buffer); let first = true;
  f.buffer.releaseConditionalSavedSource = async capture => { if (first) { first = false; throw Error('Release unavailable'); } await release(capture); };
  await assert.rejects(f.mutations.transform('One.md', replace, () => {}, undefined, f.buffer.savedDurableWitness, original), error => error instanceof AggregateError && /touched property changed/.test(error.message) && error.errors.some(e => /Release unavailable/.test(e.message)));
  await assert.rejects(f.mutations.transform('One.md', replace, () => {}, undefined, f.buffer.savedDurableWitness, original), /touched property changed/);
  assert.equal(f.buffer.captures, 1); assert.equal(f.buffer.releases, 1); assert.equal(f.buffer.updates, 0);
});

test('ordinary Base property transforms do not acquire physical captures', async () => {
  const f = host(); await f.mutations.transform('One.md', replace, () => {}, undefined, f.buffer.savedDurableWitness);
  assert.equal(f.buffer.captures, 0); assert.equal(f.buffer.received.length, 0); assert.equal(score(f.buffer.text), 1);
});

test('missing capture seams and advertised native capture errors never fall back to draft transformation', async () => {
  for (const mode of ['missing', 'partial', 'native-unsupported', 'native-error']) {
    const f = host();
    if (mode === 'missing') f.buffer.captureConditionalSavedSource = undefined as any;
    else if (mode === 'partial') f.buffer.releaseConditionalSavedSource = undefined as any;
    else f.buffer.captureConditionalSavedSource = async () => { throw Error(mode === 'native-unsupported' ? 'Physical saved-source capture is unsupported by this native host' : 'Native capture rejected'); };
    await assert.rejects(f.mutations.transform('One.md', replace, () => {}, undefined, f.buffer.savedDurableWitness, condition()), /capture is unavailable|unsupported by this native host|Native capture rejected/);
    assert.equal(f.buffer.updates, 0); assert.equal(f.buffer.flushes, 0);
  }
});

test('explicit paired provider absence preserves browser logical CAS without fabricating a physical capture', async () => {
  const f = host(); let physicalChecks = 0;
  f.buffer.captureConditionalSavedSource = async () => undefined as any;
  await f.mutations.transform('One.md', replace, () => {}, undefined, f.buffer.savedDurableWitness, { attempt: {}, validate() { physicalChecks++; } });
  assert.equal(physicalChecks, 0); assert.equal(f.buffer.received.length, 0); assert.equal(f.buffer.updates, 1); assert.equal(f.buffer.flushes, 1); assert.equal(score(f.buffer.text), 1);
});

async function controllerFixture() {
  class Adapter extends MemoryAdapter {
    versions = new Map<string, number>();
    decorate(row) { return row && { ...row, entryId: 'id-' + row.path, revision: 'r' + (this.versions.get(row.path) ?? 0) }; }
    override async list() { return (await super.list()).map(row => this.decorate(row)); }
    override async stat(path) { return this.decorate(await super.stat(path)); }
    override async write(path, source) { await super.write(path, source); this.versions.set(path, (this.versions.get(path) ?? 0) + 1); }
  }
  const initial = note.replace('score: 9', 'score: 1'), adapter = new Adapter({ 'Work.base': 'views:\n  - type: table\n    name: Table\n    order: [file.name, score]\n', 'One.md': initial, 'Two.md': initial });
  const vault = new Vault(adapter); await vault.initialize(); const buffers = new Map<string, GuardedBuffer>();
  const getBuffer = async (path: string) => {
    let buffer = buffers.get(path); if (buffer) return buffer as unknown as NoteBuffer;
    buffer = new GuardedBuffer(); buffer.path = path; buffer.entryId = 'id-' + path; buffer.revision = 'r0'; buffer.text = buffer.savedText = buffer.physical = await adapter.read(path);
    const own = buffer; own.write = async source => { await vault.modify(path, source); own.revision = vault.entries.get(path)!.revision!; own.physical = source; };
    buffers.set(path, own); return own as unknown as NoteBuffer;
  };
  const controller = new BaseController({ vault, basePath: 'Work.base', mutations: createBaseMutationHost({ getBuffer, validate() {} }), delayMs: 1000 });
  await controller.refresh(); return { vault, controller, buffers, getBuffer, stop() { controller.dispose(); } };
}

test('actual history commands reject physical-only touched changes before changing cached draft, for both undo and redo', async () => {
  for (const direction of ['undo', 'redo'] as const) {
    const f = await controllerFixture(); try {
      await f.controller.editProperty({ version: f.controller.state.version, path: 'One.md', property: 'score', value: 9 });
      if (direction === 'redo') await f.controller.undo();
      const buffer = f.buffers.get('One.md')!, updates = buffer.updates, source = buffer.text;
      buffer.physical = source.replace(/score: \d/, 'score: 7');
      await assert.rejects(f.controller[direction](), /touched property changed/);
      assert.equal(buffer.text, source); assert.equal(buffer.updates, updates); assert.equal(score(await f.vault.read('One.md')), direction === 'undo' ? 9 : 1); assert.equal(score(buffer.physical), 7);
    } finally { f.stop(); }
  }
});

test('partial multi-file undo retains the successful prefix in redo and the failed touched file in undo', async () => {
  const f = await controllerFixture(); try {
    await f.controller.editProperties(['One.md', 'Two.md'].map(path => ({ version: f.controller.state.version, path, property: 'score', value: 9 })));
    f.buffers.get('One.md')!.physical = note.replace('score: 9', 'score: 7');
    await assert.rejects(f.controller.undo(), error => error instanceof BaseBulkEditError && error.completedPaths.join(',') === 'Two.md' && /touched property/.test(error.message));
    assert.equal(score(await f.vault.read('Two.md')), 1); assert.equal(score(await f.vault.read('One.md')), 9);
    assert.equal(f.controller.canUndo, true); assert.equal(f.controller.canRedo, true);
    await f.controller.redo(); assert.equal(score(await f.vault.read('Two.md')), 9); assert.equal(score(f.buffers.get('One.md')!.physical), 7);
  } finally { f.stop(); }
});

test('generic shared-buffer Save can settle a failed undo, then original Undo acknowledges history without a new capture', async () => {
  const f = await controllerFixture(); try {
    await f.controller.editProperty({ version: f.controller.state.version, path: 'One.md', property: 'score', value: 9 });
    const buffer = f.buffers.get('One.md')!; let first = true;
    buffer.onFlush = async () => { if (first) { first = false; throw Error('Uncertain original undo'); } };
    await assert.rejects(f.controller.undo(), /Uncertain original undo/);
    assert.equal(f.controller.canUndo, true); assert.equal(f.controller.canRedo, false); assert.equal(score(buffer.text), 1);
    await buffer.flush(); await f.controller.refresh();
    await f.controller.undo();
    assert.equal(buffer.captures, 1); assert.equal(buffer.received.length, 1); assert.equal(score(await f.vault.read('One.md')), 1);
    assert.equal(f.controller.canUndo, false); assert.equal(f.controller.canRedo, true);
  } finally { f.stop(); }
});
