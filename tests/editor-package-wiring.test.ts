// @vitest-environment happy-dom

import { Prec } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  composeEditorExtensions,
  createMarkdownEditorState,
  createMountedMarkdownEditor,
} from '../packages/editor/src/index';

describe('@zorid/editor CodeMirror ownership', () => {
  it('creates CodeMirror editor state from the editor package boundary', () => {
    const state = createMarkdownEditorState('# Owned by editor');

    expect(state.doc.toString()).toBe('# Owned by editor');
  });

  it('guards unknown plugin extension contributions before composing CodeMirror extensions', () => {
    const valid = Prec.highest([]);
    const composition = composeEditorExtensions([
      { id: 'valid-extension', extension: valid },
      { id: 'invalid-extension', extension: 'not a codemirror extension' },
    ]);

    expect(composition.extensions).toEqual([valid]);
    expect(composition.diagnostics).toEqual([
      {
        id: 'invalid-extension',
        reason: 'Editor extension contributions must be CodeMirror extension objects, functions, or arrays.',
      },
    ]);
  });

  it('mounts an EditorView, emits user edits, and treats external replacements as silent by default', () => {
    const parent = document.createElement('div');
    const changes: string[] = [];
    const editor = createMountedMarkdownEditor({
      parent,
      text: 'initial',
      onChange: (text) => changes.push(text),
    });

    editor.view.dispatch({
      changes: { from: editor.view.state.doc.length, insert: ' edit' },
    });
    expect(editor.getText()).toBe('initial edit');
    expect(changes).toEqual(['initial edit']);

    editor.setText('external replacement');
    expect(editor.getText()).toBe('external replacement');
    expect(changes).toEqual(['initial edit']);

    editor.destroy();
  });
});
