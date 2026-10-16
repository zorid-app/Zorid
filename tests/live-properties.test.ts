import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { cursorDocStart, selectAll } from '@codemirror/commands';
import { bodyStart, liveProperties, propertyUpdate } from '../src/editor/live-properties.ts';

const source = '---\ntitle: "Keep quoted" # comment\ntags: [one, two]\n---\nBody 😀\nSecond line';
function create(doc = source): EditorState {
  const state = EditorState.create({ doc, extensions: [liveProperties(), EditorState.allowMultipleSelections.of(true)] });
  return state.update({ selection: { anchor: bodyStart(state) } }).state;
}
function ranges(state: EditorState) {
  const result: { from: number; to: number; block: boolean }[] = [];
  for (const value of state.facet(EditorView.decorations)) {
    assert.notEqual(typeof value, 'function', 'block replacement must be supplied directly by a state field');
    if (typeof value !== 'function') value.between(0, state.doc.length, (from, to, decoration) => {
      result.push({ from, to, block: decoration.spec.block });
    });
  }
  return result;
}

test('valid property mapping is hidden as a direct block replacement without changing source', () => {
  const state = create();
  const start = source.indexOf('Body');
  assert.equal(bodyStart(state), start);
  assert.equal(state.doc.toString(), source);
  assert.deepEqual(ranges(state), [{ from: 0, to: start, block: true }]);
  assert.equal(state.selection.main.head, start);
});

test('BOM, comments, empty YAML, alternate delimiter and CRLF are supported', () => {
  for (const doc of ['\uFEFF--- # open\ntitle: x\n... # close\nbody', '---\n# empty mapping\n---\nbody', '---\n{}\n---\nbody']) {
    const state = create(doc);
    assert.equal(bodyStart(state), doc.indexOf('body'));
    assert.equal(state.doc.toString(), doc);
  }
  const doc = '\uFEFF---\r\ntitle: x\r\n---\r\nbody';
  const state = EditorState.create({ doc, extensions: [liveProperties(), EditorState.lineSeparator.of('\r\n')] });
  assert.equal(state.sliceDoc(), doc);
  assert.equal(state.doc.sliceString(bodyStart(state)), 'body');
});

test('malformed, duplicate, unsupported or non-map YAML stays visible and editable', () => {
  for (const doc of ['---\ntitle: [\n---\nBody', '---\nx: 1\nx: 2\n---\nBody', '---\n- item\n---\nBody',
    '---\nscalar\n---\nBody', '---\nx: !custom value\n---\nBody', '---\nx: 1\nBody', 'ordinary body']) {
    const state = create(doc);
    assert.equal(bodyStart(state), 0);
    assert.deepEqual(ranges(state), []);
    assert.equal(state.update({ changes: { from: 0, insert: 'a' }, userEvent: 'input.type' }).newDoc.toString(), 'a' + doc);
  }
});

test('ordinary body edits preserve exact hidden text and reuse the field decoration', () => {
  const state = create(), start = bodyStart(state);
  const value = state.facet(EditorView.decorations)[0];
  const next = state.update({ changes: { from: start, insert: 'Edited ' }, userEvent: 'input.type' }).state;
  assert.equal(next.doc.sliceString(0, start), source.slice(0, start));
  assert.equal(next.doc.sliceString(start), 'Edited Body 😀\nSecond line');
  assert.equal(next.facet(EditorView.decorations)[0], value);
  assert.equal(bodyStart(next), start);
});

test('backspace, prefix deletion and multicursor changes cannot edit hidden properties', () => {
  const state = create(), start = bodyStart(state);
  for (const changes of [{ from: start - 1, to: start }, { from: 0, to: state.doc.length }, { from: 2, insert: 'x' },
    [{ from: 3, insert: 'x' }, { from: start, insert: 'visible edit' }]]) {
    for (const userEvent of ['delete.backward', 'delete.cut', 'input.paste', 'input.type']) {
      const next = state.update({ changes, userEvent }).state;
      assert.equal(next.doc.toString(), source);
      assert.ok(next.selection.eq(state.selection));
    }
  }
});

test('Ctrl-Home and select-all commands address the editable body', () => {
  let state = create();
  state = state.update({ selection: { anchor: state.doc.length } }).state;
  const target = { get state() { return state; }, dispatch(transaction: Transaction) { state = transaction.state; } };
  assert.equal(cursorDocStart(target), true);
  assert.equal(state.selection.main.head, bodyStart(state));
  assert.equal(selectAll(target), true);
  assert.equal(state.selection.main.from, bodyStart(state));
  assert.equal(state.selection.main.to, state.doc.length);
  const next = state.update({ ...state.replaceSelection('Replacement'), userEvent: 'input.type' }).state;
  assert.equal(next.doc.toString(), source.slice(0, bodyStart(state)) + 'Replacement');
});

test('reverse and multiple selections retain direction while clamping to body', () => {
  const state = create(), start = bodyStart(state);
  const selection = EditorSelection.create([EditorSelection.range(start + 4, 0), EditorSelection.cursor(state.doc.length)], 1);
  const next = state.update({ selection, userEvent: 'select.pointer' }).state;
  assert.equal(next.selection.ranges[0].anchor, start + 4);
  assert.equal(next.selection.ranges[0].head, start);
  assert.equal(next.selection.mainIndex, 1);
});

test('external property updates bypass protection and recompute valid/invalid presentation', () => {
  const state = create();
  const invalid = '---\nx: [\n---\nBody';
  const next = state.update({ changes: { from: 0, to: state.doc.length, insert: invalid },
    selection: { anchor: 0 }, userEvent: 'input', annotations: propertyUpdate.of(true) }).state;
  assert.equal(next.doc.toString(), invalid);
  assert.equal(bodyStart(next), 0);
  assert.deepEqual(ranges(next), []);
  const valid = next.update({ changes: { from: 0, to: next.doc.length, insert: source }, annotations: propertyUpdate.of(true) }).state;
  assert.equal(bodyStart(valid), source.indexOf('Body'));
  assert.equal(ranges(valid).length, 1);
  assert.equal(valid.selection.main.head, bodyStart(valid));
});

test('unannotated programmatic document updates remain possible and selection is clamped', () => {
  const state = create();
  const next = state.update({ changes: { from: 0, to: state.doc.length, insert: '---\nx: y\n---\nnew' }, selection: { anchor: 0 } }).state;
  assert.equal(next.doc.toString(), '---\nx: y\n---\nnew');
  assert.equal(next.selection.main.head, bodyStart(next));
});

test('typing into a metadata-only document adds a body line without damaging the delimiter', () => {
  for (const source of ['---\nx: y\n---', '---\nx: y\n---\n']) {
    const state = create(source), start = bodyStart(state);
    assert.equal(state.doc.toString(), source, 'initial source is untouched');
    const next = state.update({ changes: { from: start, insert: 'body' }, selection: { anchor: start + 4 }, userEvent: 'input.type' }).state;
    assert.equal(next.doc.toString(), '---\nx: y\n---\nbody');
    assert.equal(next.doc.sliceString(bodyStart(next)), 'body');
    assert.equal(next.selection.main.head, next.doc.length);
  }
});

test('a metadata-only first newline is not duplicated and follows normal body selection', () => {
  const state = create('---\nx: y\n---'), start = bodyStart(state);
  const next = state.update({ changes: { from: start, insert: '\nbody' }, selection: { anchor: start + 5 }, userEvent: 'input.paste' }).state;
  assert.equal(next.doc.toString(), '---\nx: y\n---\nbody');
  assert.equal(next.selection.main.head, next.doc.length);
  assert.equal(next.doc.sliceString(bodyStart(next)), 'body');
});

test('authoritative snapshots bypass EOF body-newline normalization', () => {
  const source = '---\nx: y\n---', state = create(source);
  const next = state.update({ changes: { from: source.length, insert: 'invalid suffix' },
    userEvent: 'input', annotations: propertyUpdate.of(true) }).state;
  assert.equal(next.doc.toString(), source + 'invalid suffix');
  assert.equal(bodyStart(next), 0);
});

test('removing externally supplied frontmatter restores full-document editing', () => {
  const state = create();
  const next = state.update({ changes: { from: 0, to: bodyStart(state) }, annotations: propertyUpdate.of(true) }).state;
  assert.equal(bodyStart(next), 0);
  assert.deepEqual(ranges(next), []);
  assert.equal(next.update({ selection: { anchor: 0 } }).newSelection.main.head, 0);
});
