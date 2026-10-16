import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { history, historyField, isolateHistory, undo, redo, undoDepth, redoDepth } from '@codemirror/commands';
import { parseWindowTabHandoff, offerWindowHandoff, advanceWindowHandoff, handoffOwner, reconcileHandoffBuffer } from '../src/core/window-handoff.ts';
import type { WindowTabHandoff, WindowHandoffEvent } from '../src/core/window-handoff.ts';
const fixture = (): WindowTabHandoff => ({
  version: 1, transferId: 'transfer-1', sourceWindowId: 'window-source', vaultId: 'desktop:/vault', revision: 4,
  tab: { id: 'leaf-stable', path: 'Note.md', kind: 'note', mode: 'live', subpath: '#Heading' },
  buffer: { text: 'unsaved text', savedText: 'saved text', pendingWrite: 'possibly written', conflicted: false },
  editor: { doc: 'unsaved text', selection: { ranges: [{ anchor: 2, head: 6 }], main: 0 }, history: { done: [], undone: [] }, scrollTop: 80, scrollLeft: 2 },
  scroll: { top: 150.5, left: 0 }, view: { type: 'note', state: { folds: [1, 2] } },
});
const ready = { type: 'target-ready', transferId: 'transfer-1', windowId: 'window-target', revision: 4 } as const;
const commit = { type: 'source-commit', transferId: 'transfer-1', windowId: 'window-source', revision: 4 } as const;

test('handoff clones stable tab identity, unsaved buffer, history, scroll and supported view state', () => {
  const input = fixture(), copied = parseWindowTabHandoff(input);
  assert.deepEqual(copied, input);
  input.tab.id = 'mutated'; input.buffer!.text = 'lost'; input.editor!.selection.ranges[0].head = 0;
  (input.view!.state.folds as number[]).push(9);
  assert.equal(copied.tab.id, 'leaf-stable'); assert.equal(copied.buffer!.text, 'unsaved text');
  assert.equal(copied.editor!.selection.ranges[0].head, 6); assert.deepEqual(copied.view!.state.folds, [1, 2]);
  assert.deepEqual(parseWindowTabHandoff(JSON.parse(JSON.stringify(copied))), copied);
});

test('real CodeMirror snapshot preserves undo and redo branches plus multiple selections', () => {
  const extensions = [history(), EditorState.allowMultipleSelections.of(true)];
  let source = EditorState.create({ doc: 'abc', extensions });
  source = source.update({ changes: { from: 1, insert: 'X' }, selection: { anchor: 2 }, annotations: [Transaction.userEvent.of('input'), isolateHistory.of('full')] }).state;
  source = source.update({ changes: { from: 4, insert: 'Y' }, annotations: [Transaction.userEvent.of('input'), isolateHistory.of('full')] }).state;
  assert.equal(undo({ state: source, dispatch: tr => { source = tr.state; } }), true);
  source = source.update({ selection: EditorSelection.create([EditorSelection.range(0, 1), EditorSelection.cursor(3)], 1) }).state;
  assert.equal(source.doc.toString(), 'aXbc'); assert.equal(undoDepth(source), 1); assert.equal(redoDepth(source), 1);
  const input = fixture();
  input.buffer = { text: source.doc.toString(), savedText: 'abc', conflicted: false };
  input.editor = { ...JSON.parse(JSON.stringify(source.toJSON({ history: historyField }))), scrollTop: 123, scrollLeft: 4 };
  const transfer = parseWindowTabHandoff(input);
  let target = EditorState.fromJSON(transfer.editor, { extensions }, { history: historyField });
  assert.equal(target.doc.toString(), 'aXbc'); assert.deepEqual(target.selection.toJSON(), source.selection.toJSON());
  assert.equal(undoDepth(target), 1); assert.equal(redoDepth(target), 1);
  assert.equal(undo({ state: target, dispatch: tr => { target = tr.state; } }), true); assert.equal(target.doc.toString(), 'abc');
  assert.equal(redo({ state: target, dispatch: tr => { target = tr.state; } }), true); assert.equal(target.doc.toString(), 'aXbc');
  assert.equal(redo({ state: target, dispatch: tr => { target = tr.state; } }), true); assert.equal(target.doc.toString(), 'aXbcY');
});

test('source owns recovery until target readiness and source commit complete in order', () => {
  const offered = offerWindowHandoff(fixture(), 'window-target');
  assert.equal(handoffOwner(offered), 'window-source');
  assert.throws(() => advanceWindowHandoff(offered, commit), /not restored/);
  const staged = advanceWindowHandoff(offered, ready);
  assert.equal(staged.phase, 'ready'); assert.equal(handoffOwner(staged), 'window-source');
  const committed = advanceWindowHandoff(staged, commit);
  assert.equal(committed.phase, 'committed'); assert.equal(handoffOwner(committed), 'window-target');
  assert.equal(offered.phase, 'offered'); assert.equal(staged.phase, 'ready');
  assert.throws(() => advanceWindowHandoff(committed, { type: 'abort', transferId: 'transfer-1', windowId: 'window-source', reason: 'late timeout' }), /settled/);
  assert.throws(() => advanceWindowHandoff(committed, commit), /settled/);
});

test('stale tokens, changed revisions, duplicate readiness and wrong participants cannot commit', () => {
  const offered = offerWindowHandoff(fixture(), 'window-target');
  assert.throws(() => advanceWindowHandoff(offered, { ...ready, transferId: 'old' }), /token/);
  assert.throws(() => advanceWindowHandoff(offered, { ...ready, revision: 5 }), /revision/);
  assert.throws(() => advanceWindowHandoff(offered, { ...ready, windowId: 'window-source' }), /participant/);
  assert.throws(() => advanceWindowHandoff(offered, { ...ready, type: 'invented' } as unknown as WindowHandoffEvent), /Unknown/);
  const staged = advanceWindowHandoff(offered, ready);
  assert.throws(() => advanceWindowHandoff(staged, ready), /already ready/);
  assert.throws(() => advanceWindowHandoff(staged, { ...commit, revision: 5 }), /revision/);
  assert.throws(() => offerWindowHandoff(fixture(), 'window-source'), /must differ/);
});

test('target restore failure or cancelled offer returns ownership to source without dropping its snapshot', () => {
  for (const staged of [false, true]) {
    let state = offerWindowHandoff(fixture(), 'window-target');
    if (staged) state = advanceWindowHandoff(state, ready);
    assert.throws(() => advanceWindowHandoff(state, { type: 'abort', transferId: 'transfer-1', windowId: 'stranger', reason: 'failed' }), /participant/);
    const aborted = advanceWindowHandoff(state, { type: 'abort', transferId: 'transfer-1', windowId: 'window-target', reason: 'restore failed' });
    assert.equal(aborted.phase, 'aborted'); assert.equal(handoffOwner(aborted), 'window-source');
    assert.equal(aborted.snapshot.buffer!.text, 'unsaved text');
    assert.throws(() => advanceWindowHandoff(aborted, ready), /settled/);
  }
});

test('disk reconciliation accepts only the saved base or explicit pending write and never implies a write', () => {
  const buffer = fixture().buffer!;
  assert.equal(reconcileHandoffBuffer(buffer, 'saved text'), 'base');
  assert.equal(reconcileHandoffBuffer(buffer, 'possibly written'), 'pending-write');
  assert.equal(reconcileHandoffBuffer(buffer, 'another window edited'), 'conflict');
  assert.equal(reconcileHandoffBuffer(buffer, buffer.text), 'conflict');
  assert.deepEqual(buffer, fixture().buffer);
});

test('malformed transfer versions, paths, selections, document mismatches and non-JSON data fail explicitly', () => {
  for (const alter of [
    (s: any) => { s.version = 2; }, (s: any) => { s.tab.path = '../outside.md'; },
    (s: any) => { s.tab.path = '/absolute.md'; }, (s: any) => { s.tab.path = 'a//b.md'; },
    (s: any) => { s.editor.doc = 'different'; }, (s: any) => { s.editor.selection.ranges[0].head = 999; },
    (s: any) => { s.editor.selection.main = 2; }, (s: any) => { s.editor.selection.ranges = []; },
    (s: any) => { s.scroll.top = Infinity; }, (s: any) => { s.revision = -1; },
    (s: any) => { s.buffer.conflicted = undefined; }, (s: any) => { s.view.state = new Date(); },
    (s: any) => { s.view.state = { fn() {} }; }, (s: any) => { s.view.state.cycle = s; },
    (s: any) => { s.editor.history = null; }, (s: any) => { s.view.state.values = new Array(250001); },
    (s: any) => { s.view.state = JSON.parse('{"__proto__":{}}'); },
  ]) { const input = fixture(); alter(input); assert.throws(() => parseWindowTabHandoff(input), /Invalid window handoff/); }
  let accessed = false;
  const input = fixture(); Object.defineProperty(input, 'buffer', { enumerable: true, get() { accessed = true; return {}; } });
  assert.throws(() => parseWindowTabHandoff(input), /accessors/); assert.equal(accessed, false);
});

test('empty and graph tabs transfer without pretending to have a text editor or buffer', () => {
  for (const kind of ['note', 'graph'] as const) {
    const input: WindowTabHandoff = { version: 1, transferId: 'x', sourceWindowId: 'a', vaultId: 'desktop:/vault', revision: 0,
      tab: { id: 'same-leaf', path: null, kind, mode: kind === 'graph' ? 'reading' : 'live' }, scroll: { top: 0, left: 0 } };
    assert.deepEqual(parseWindowTabHandoff(input), input);
  }
});

test('transfer size budget counts oversized keys even when their values are primitive', () => {
  const input = fixture();
  input.view!.state = { ['k'.repeat(32 * 1024 * 1024 + 1)]: false };
  assert.throws(() => parseWindowTabHandoff(input), /transfer limit/);
});
