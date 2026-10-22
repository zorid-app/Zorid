import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorView } from '@codemirror/view';
import { Workspace } from '../src/ui/workspace.ts';
import { createEditor } from '../src/ui/editor.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import { inlineBaseRequest } from '../src/bases/inline-base.ts';
import type { InlineBaseRequest } from '../src/bases/inline-base.ts';
import type { BaseSession, BaseSessionOptions } from '../src/bases/session.ts';
import type { Checkpoint } from '../src/core/durable-checkpoints.ts';
import type {
  ConditionalSavedSourceCapture, DurableWriteInput,
  DurableWriteIntent, DurableWriteRead, DurableWriteRef, DurableWrites,
} from '../src/core/durable-writes.ts';

const config = 'views:\n  - { type: table, name: Original, order: [ file.name ] }\n';
const renamed = 'views:\n  - { type: table, name: Renamed, order: [ file.name ] }\n';
const source = `Before 😀\n\n\`\`\`base\n${config}\`\`\`\n\nBetween\n\n\`\`\`base\n${config}\`\`\`\n\nBody sentinel\n`;
const replaceSecond = (document: string, next = renamed) => {
  const offset = document.lastIndexOf(config);
  assert.ok(offset >= 0);
  return document.slice(0, offset) + next + document.slice(offset + config.length);
};
const clone = <T>(value: T): T => structuredClone(value);

/** The provider is the sole authority for core text, physical bytes and intent
 * outcomes. Workspace, NoteBuffer, checkpoints and save publication are real. */
function provider(initial: string) {
  const scope = { vaultId: 'physical-cas-vault', clientId: 'physical-cas-client' };
  let current: DurableWriteRead = { entryId: 'source-entry', revision: 'r1', path: 'Source.md', content: initial,
    stat: { ctime: 1, mtime: 1, size: Buffer.byteLength(initial) } };
  let saved = initial, capturesTaken = 0, authorships = 0;
  const adapter = new MemoryAdapter({ 'Source.md': initial }) as MemoryAdapter & { durableWrites: DurableWrites };
  const write = adapter.write.bind(adapter), list = adapter.list.bind(adapter), stat = adapter.stat.bind(adapter);
  // Native inventory and coherent reads name the same logical entry/revision.
  adapter.list = async () => (await list()).map(entry => entry.path === current.path ? { ...entry, entryId: current.entryId, revision: current.revision, ...current.stat } : entry);
  adapter.stat = async path => {
    const entry = await stat(path);
    return entry && entry.path === current.path ? { ...entry, entryId: current.entryId, revision: current.revision, ...current.stat } : entry;
  };
  const checkpoints = new Map<string, Checkpoint>();
  const captures = new Map<string, ConditionalSavedSourceCapture>();
  const inputs = new Map<string, { input: DurableWriteInput; physical?: string }>();
  const intents = new Map<string, DurableWriteIntent>();
  const planned: DurableWriteInput[] = [], prepared: string[] = [], committed: DurableWriteRef[] = [], queried: DurableWriteRef[] = [], released: string[] = [];
  let onCapture: (() => void | Promise<void>) | undefined;
  let onCommit: (() => void | Promise<void>) | undefined;
  let loseCommittedReply = false;
  const reject = (ref: DurableWriteRef, code: string): DurableWriteIntent => ({ ref, state: 'rejected', acknowledged: false,
    error: { operationId: ref.operationId, code, message: 'Conditional saved source changed' } });
  const writes: DurableWrites = {
    checkpoints: {
      scope,
      load: async key => clone(checkpoints.get(key) ?? null),
      compareAndSwap: async change => {
        const old = checkpoints.get(change.key);
        if (old?.revision === change.nextRevision && old.encodedState === change.encodedState) return clone(old);
        assert.equal(change.expectedRevision, old?.revision ?? null);
        const row: Checkpoint = { version: 1, ...scope, key: change.key, revision: change.nextRevision,
          encodedState: change.encodedState, sequence: String(Number(old?.sequence ?? 0) + 1),
          deleted: change.encodedState === null, byteLength: Buffer.byteLength(change.encodedState ?? '') };
        checkpoints.set(change.key, row); return clone(row);
      },
      list: async () => ({ items: [], cursor: null, highWater: '0' }),
      changes: async () => ({ items: [], cursor: null, highWater: '0' }),
    },
    readText: async path => { assert.equal(path, current.path); return clone(current); },
    readTextById: async id => id === current.entryId ? clone(current) : null,
    captureSavedSource: async witness => {
      assert.deepEqual(witness, { entryId: current.entryId, revision: current.revision, path: current.path });
      const capture = { captureId: `capture-${++capturesTaken}`, logicalWitness: clone(witness), source: saved };
      captures.set(capture.captureId, capture);
      await onCapture?.(); return clone(capture);
    },
    releaseSavedSource: async id => { released.push(id); captures.delete(id); },
    planWrite: async input => {
      planned.push(clone(input));
      return { version: 1, ...scope, operationId: input.operationId, entryId: input.expectedEntryId, encodedPlan: JSON.stringify(input) };
    },
    prepare: async plan => {
      prepared.push(plan.encodedPlan);
      const old = intents.get(plan.operationId); if (old) return clone(old);
      const input = JSON.parse(plan.encodedPlan) as DurableWriteInput;
      const ref = { ...scope, operationId: plan.operationId, entryId: plan.entryId, token: `intent-${plan.operationId}` };
      const capture = input.conditionalSavedSource && captures.get(input.conditionalSavedSource.captureId);
      inputs.set(ref.token, { input, physical: capture?.source });
      let intent: DurableWriteIntent = { ref, state: 'prepared', acknowledged: false };
      if (input.conditionalSavedSource && !capture) intent = reject(ref, 'source_capture_expired');
      else if (input.conditionalSavedSource && capture!.source !== saved) intent = reject(ref, 'conditional_source_changed');
      intents.set(ref.operationId, intent); return clone(intent);
    },
    commit: async ref => {
      committed.push(clone(ref));
      const old = intents.get(ref.operationId)!;
      if (old.state === 'committed' || old.state === 'rejected') return clone(old);
      await onCommit?.();
      const held = inputs.get(ref.token)!, input = held.input;
      let outcome: DurableWriteIntent;
      if (input.conditionalSavedSource && held.physical !== saved) outcome = reject(ref, 'conditional_source_changed');
      else {
        assert.equal(input.expectedEntryId, current.entryId);
        assert.equal(input.expectedRevision, current.revision);
        assert.equal(input.expectedContent, current.content);
        authorships++;
        current = { ...current, content: input.content, revision: `r${authorships + 1}`,
          stat: { ...current.stat, mtime: authorships + 1, size: Buffer.byteLength(input.content) } };
        saved = input.content; await write(current.path, saved);
        outcome = { ref, state: 'committed', acknowledged: false, receipt: { operationId: ref.operationId,
          entryId: ref.entryId, revision: current.revision, sequence: String(authorships) } };
      }
      intents.set(ref.operationId, outcome);
      if (loseCommittedReply && outcome.state === 'committed') { loseCommittedReply = false; throw new Error('Committed reply lost'); }
      return clone(outcome);
    },
    query: async ref => { queried.push(clone(ref)); return clone(intents.get(ref.operationId) ?? null); },
    listUnacknowledged: async () => [...intents.values()].filter(intent => !intent.acknowledged).map(clone),
    acknowledge: async (ref, expected) => {
      const intent = intents.get(ref.operationId)!;
      assert.equal(expected.operationId, ref.operationId);
      assert.ok(intent.state === 'committed' || intent.state === 'rejected');
      if (intent.state === 'committed') { assert.equal(expected.status, 'committed'); if (expected.status === 'committed') assert.equal(expected.sequence, intent.receipt.sequence); }
      else { assert.equal(expected.status, 'rejected'); if (expected.status === 'rejected') assert.equal(expected.code, intent.error.code); }
      intents.set(ref.operationId, { ...intent, acknowledged: true });
    },
  };
  adapter.durableWrites = writes;
  return { adapter, writes, planned, prepared, committed, queried, released,
    get current() { return clone(current); }, get saved() { return saved; },
    get capturesTaken() { return capturesTaken; }, get authorships() { return authorships; },
    setCapture(fn: typeof onCapture) { onCapture = fn; }, setCommit(fn: typeof onCommit) { onCommit = fn; },
    loseNextCommittedReply() { loseCommittedReply = true; },
    async external(text: string) { saved = text; await write(current.path, text); },
  };
}

type CapturedHost = { element: HTMLElement; options: BaseSessionOptions };
async function fixture(t: TestContext, initial = source) {
  const authority = provider(initial);
  const dom = new JSDOM('<!doctype html><body><main></main></body>', { url: 'https://zorid.test/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const matchMedia = (media: string) => ({ matches: false, media, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Text: dom.window.Text, Window: dom.window.Window,
    MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), matchMedia })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.matchMedia = matchMedia as typeof window.matchMedia;
  dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 1000, bottom: 600, width: 1000, height: 600, x: 0, y: 0, toJSON() { return {}; } });
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const hosts: CapturedHost[] = [], contractSessions: BaseSession[] = [];
  const workspace = new Workspace(document.querySelector('main')!, createEditor, {
    base: (element, options) => {
      hosts.push({ element, options });
      // This adapter captures the real Workspace host contract only. No query,
      // toolbar or user-interface acceptance is inferred from these host tests.
      return { ready: Promise.resolve(), state: { error: null } as BaseSession['state'], refresh: async () => {},
        selectView: async () => {}, setCurrentFile: async () => {}, rebindViewName: () => false,
        flush: async () => {}, close: async () => {}, hasPendingChanges: () => false };
    },
  });
  t.after(async () => {
    await Promise.allSettled(contractSessions.map(session => session.close()));
    try { await workspace.destroy(); } catch { /* Deliberate recovery conflicts retain their draft. */ }
    finally {
      await Promise.allSettled([...workspace.buffers.values()].map(buffer => buffer.dispose()));
      dom.window.close();
      for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    }
  });
  await workspace.start({ adapter: authority.adapter, id: 'test:inline-physical-cas', label: 'Physical CAS' });
  await workspace.openNote('Source.md');
  await until(() => hosts.length >= 2, 'both real inline source hosts mount');
  const buffer = workspace.buffers.get('Source.md')!;
  const editor = () => EditorView.findFromDOM(workspace.activePane.element.querySelector('.cm-editor')!)!;
  const liveHost = () => {
    const match = hosts.filter(host => host.options.inlineSource && host.element.isConnected && host.element.closest('.cm-live-base,.markdown-preview')).at(-1);
    assert.ok(match, 'a current rendered inline host exists'); return match;
  };
  const contractHost = (documentText: string, acknowledged: () => boolean = () => true) => {
    const from = documentText.lastIndexOf('```base\n'), to = documentText.indexOf('```', from + 8) + 3;
    const request = inlineBaseRequest(documentText, from, to); assert.ok(request);
    const pane = workspace.activePane, validate = liveHost().options.validate;
    const element = document.createElement('div'); pane.element.append(element);
    // Normal remount prepares (and flushes) the containing file first. This
    // explicitly exercises the host contract with an already captured latest
    // request while the real shared NoteBuffer still owns its unsaved body.
    const session = (workspace as unknown as { createWorkspaceBaseSession(
      element: HTMLElement, path: string, owner: () => typeof pane, validate: () => void,
      sourcePath: string, viewName: undefined, request: InlineBaseRequest,
      onSourceError: undefined, onInlineSourceSaved: () => boolean,
    ): BaseSession }).createWorkspaceBaseSession(element, 'Source.md', () => pane, validate,
      'Source.md', undefined, request, undefined, acknowledged);
    contractSessions.push(session);
    return hostSource(hosts.at(-1)!);
  };
  return { authority, planned: authority.planned, prepared: authority.prepared, committed: authority.committed,
    queried: authority.queried, released: authority.released, workspace, buffer, hosts, editor, liveHost, contractHost };
}

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 2000;
  while (!check()) { assert.ok(Date.now() < deadline, label); await new Promise(resolve => setTimeout(resolve, 5)); }
}
const hostSource = (host: CapturedHost) => { assert.ok(host.options.inlineSource); return host.options.inlineSource; };

test('clean inline save changes only the selected duplicate fence and carries the original saved witness', async t => {
  const f = await fixture(t), host = hostSource(f.liveHost());
  await host.transform(config, renamed, () => {});
  const expected = replaceSecond(source);
  assert.equal(f.authority.saved, expected); assert.equal(f.buffer.text, expected); assert.equal(f.buffer.savedText, expected);
  assert.equal(f.editor().state.doc.toString(), expected);
  assert.equal(f.authority.capturesTaken, 1); assert.equal(f.authority.authorships, 1);
  assert.equal(f.planned[0].expectedContent, source);
  assert.deepEqual(f.planned[0].conditionalSavedSource, { captureId: 'capture-1', logicalWitness: { entryId: 'source-entry', revision: 'r1', path: 'Source.md' } });
  assert.equal('source' in f.planned[0].conditionalSavedSource!, false);
  assert.deepEqual(f.released, ['capture-1']);
});

test('dirty body and exact latest fence save together while physical CAS uses the original saved source', async t => {
  const f = await fixture(t), latest = source + 'Local body draft 😀\n';
  f.buffer.update(latest);
  const host = f.contractHost(latest);
  assert.equal(f.buffer.text, latest); assert.equal(f.buffer.savedText, source);
  await host.transform(config, renamed, () => {});
  assert.equal(f.authority.saved, replaceSecond(latest));
  assert.equal(f.planned[0].expectedContent, source, 'the saved baseline never adopts unsaved body text');
  assert.equal(f.planned[0].content, replaceSecond(latest));
  assert.equal(f.authority.capturesTaken, 1); assert.equal(f.authority.authorships, 1);
});

test('external physical change before capture rejects without changing either draft or core', async t => {
  const f = await fixture(t), host = hostSource(f.liveHost()), external = source + 'External saved marker\n';
  await f.authority.external(external);
  await assert.rejects(host.transform(config, renamed, () => {}), /saved containing note changed outside/);
  assert.equal(f.buffer.text, source); assert.equal(f.buffer.savedText, source);
  assert.equal(f.authority.current.content, source); assert.equal(f.authority.saved, external);
  assert.equal(f.planned.length, 0); assert.equal(f.authority.authorships, 0);
  assert.deepEqual(f.released, ['capture-1']); assert.equal(host.captureSaveRetry?.(), undefined);
});

test('physical change after capture rejects native authorship and retains the exact newest shared draft', async t => {
  const f = await fixture(t), host = hostSource(f.liveHost());
  const external = source + 'External after capture\n', latest = replaceSecond(source) + 'Newer shared typing\n';
  f.authority.setCommit(async () => { await f.authority.external(external); f.buffer.update(latest); });
  await assert.rejects(host.transform(config, renamed, () => {}), /draft preserved/);
  assert.equal(f.buffer.text, latest); assert.equal(f.buffer.savedText, source);
  assert.equal(f.buffer.hasRecoveryConflict, true);
  assert.equal(f.authority.current.content, source); assert.equal(f.authority.saved, external);
  assert.equal(f.authority.authorships, 0); assert.equal(f.planned.length, 1);
  assert.equal(f.planned[0].content, replaceSecond(source)); assert.deepEqual(f.released, ['capture-1']);
});

for (const invalidation of ['draft', 'owner'] as const) test(`an ${invalidation === 'draft' ? 'edited draft' : 'owner retired'} during source capture releases its unused proof`, async t => {
  const f = await fixture(t), host = hostSource(f.liveHost()), pane = f.workspace.activePane, runtime = pane.runtime;
  const latest = source + 'Changed while capture was pending\n';
  f.authority.setCapture(() => { if (invalidation === 'draft') f.buffer.update(latest); else pane.runtime = undefined; });
  try {
    await assert.rejects(host.transform(config, renamed, () => {}), /changed|closed|superseded/i);
    assert.deepEqual(f.released, ['capture-1']); assert.equal(f.planned.length, 0);
    assert.equal(f.authority.current.content, source); assert.equal(f.authority.saved, source);
    assert.equal(f.buffer.text, invalidation === 'draft' ? latest : source);
  } finally { pane.runtime = runtime; }
});

test('lost committed reply retries the original capture, plan and ref without publishing early or authoring twice', async t => {
  const f = await fixture(t), host = hostSource(f.liveHost()), expected = replaceSecond(source);
  f.authority.loseNextCommittedReply();
  await assert.rejects(host.transform(config, renamed, () => {}), /retain its original ref/);
  assert.equal(f.authority.saved, expected, 'the provider really committed before its reply was lost');
  assert.equal(f.buffer.text, expected); assert.equal(f.buffer.savedText, source);
  assert.equal(f.editor().state.doc.toString(), source, 'the held configuration is not published before reconciliation');
  const retry = host.captureSaveRetry?.(); assert.ok(retry);
  const original = clone(f.planned[0]), ref = clone(f.committed[0]);
  await retry();
  assert.equal(f.buffer.savedText, expected); assert.equal(f.editor().state.doc.toString(), expected);
  assert.deepEqual(f.planned, [original]); assert.equal(f.prepared.length, 1);
  assert.deepEqual(f.committed, [ref]); assert.ok(f.queried.length >= 2);
  for (const queried of f.queried) assert.deepEqual(queried, ref);
  assert.equal(f.authority.capturesTaken, 1); assert.equal(f.authority.authorships, 1);
  assert.deepEqual(f.released, ['capture-1']); assert.equal(host.captureSaveRetry?.(), undefined);
});

test('a moved duplicate occurrence fails the latest whole-document guard before physical capture', async t => {
  const f = await fixture(t), stale = hostSource(f.liveHost());
  f.editor().dispatch({ changes: { from: 0, insert: 'Moved prefix\n' } });
  const latest = 'Moved prefix\n' + source;
  await assert.rejects(stale.transform(config, renamed, () => {}), /changed before its Base configuration/);
  assert.equal(f.authority.capturesTaken, 0); assert.equal(f.planned.length, 0);
  assert.equal(f.buffer.text, latest); assert.equal(f.authority.saved, source);
});

test('CRLF Reading fences retain original byte spelling and only the selected duplicate is rewritten', async t => {
  const original = source.replace(/\n/g, '\r\n'), f = await fixture(t, original);
  await (f.workspace as unknown as { toggleReading(pane: unknown): Promise<void> }).toggleReading(f.workspace.activePane);
  await until(() => f.hosts.some(host => host.element.isConnected && !!host.element.closest('.markdown-preview')), 'Reading source hosts finish mounting');
  await hostSource(f.liveHost()).transform(config, renamed, () => {});
  const expected = original.replace(`\r\nBetween\r\n\r\n\`\`\`base\r\n${config.replace(/\n/g, '\r\n')}`, `\r\nBetween\r\n\r\n\`\`\`base\r\n${renamed.replace(/\n/g, '\r\n')}`);
  assert.notEqual(expected, original); assert.equal(f.authority.saved, expected);
  assert.equal(f.planned[0].expectedContent, original); assert.equal(f.planned[0].content, expected);
  assert.equal(f.authority.capturesTaken, 1); assert.equal(f.authority.authorships, 1);
});

test('already clean exact source is a no-op and releases an unused physical proof without a new intent', async t => {
  const f = await fixture(t), host = hostSource(f.liveHost());
  await host.transform(config, config, () => {});
  assert.equal(f.buffer.text, source); assert.equal(f.buffer.savedText, source);
  assert.equal(f.authority.saved, source); assert.equal(f.planned.length, 0);
  assert.equal(f.authority.capturesTaken, 1); assert.equal(f.authority.authorships, 0);
  assert.deepEqual(f.released, ['capture-1']);
});

test('late owner acknowledgement failure cannot author another intent for already durable exact source', async t => {
  const f = await fixture(t), host = f.contractHost(source, () => false), expected = replaceSecond(source);
  await assert.rejects(host.transform(config, renamed, () => {}), /saved Base session is no longer current/);
  assert.equal(f.authority.saved, expected); assert.equal(f.buffer.savedText, expected); assert.equal(f.buffer.dirty, false);
  assert.equal(f.editor().state.doc.toString(), source, 'a rejected owner cannot publish into the editor');
  await host.transform(config, renamed, () => {});
  assert.equal(f.planned.length, 1); assert.equal(f.authority.authorships, 1);
  assert.equal(f.authority.capturesTaken, 2); assert.deepEqual(f.released, ['capture-1', 'capture-2']);
  assert.equal(f.editor().state.doc.toString(), source, 'the clean no-op does not replay a publication acknowledgement');
});
