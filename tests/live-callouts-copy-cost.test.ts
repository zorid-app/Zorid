import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, Text } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { liveCallouts, renderedCalloutRanges } from '../src/editor/live-callouts.ts';

test('opening and editing a large plain note avoids full document materialization for callouts', () => {
  const source = 'x'.repeat(432000);
  const original = Text.prototype.toString;
  let fullCopies = 0;
  Text.prototype.toString = function () {
    if (this.length >= source.length) fullCopies++;
    return original.call(this);
  };
  try {
    const state = EditorState.create({ doc: source, extensions: [markdown(), liveCallouts()] });
    assert.deepEqual(renderedCalloutRanges(state), []);
    const edited = state.update({ changes: { from: 0, insert: 'y' } }).state;
    assert.deepEqual(renderedCalloutRanges(edited), []);
    assert.equal(fullCopies, 0, 'callout discovery must leave the large plain document as Text');
  } finally {
    Text.prototype.toString = original;
  }
});
