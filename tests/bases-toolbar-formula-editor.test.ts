import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorView } from '@codemirror/view';
import { undo, redo } from '@codemirror/commands';
import { acceptCompletion, closeCompletion, completionStatus, currentCompletions, startCompletion } from '@codemirror/autocomplete';
import { enhanceBaseFormulaEditor } from '../src/bases/toolbar-formula-editor.ts';
import type { BaseFormulaEditorOptions } from '../src/bases/toolbar-formula-editor.ts';

function fixture(options: BaseFormulaEditorOptions = {}, value = 'note.cost * 2') {
  const dom = new JSDOM('<body><textarea aria-label="Formula expression"></textarea></body>', { pretendToBeVisual: true });
  // CodeMirror uses its owner document for DOM, and browser globals for selection
  // measurement. Install only this fixture's globals and restore every descriptor.
  const names = ['window', 'document', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'HTMLElement', 'Node', 'Window'] as const;
  const previous = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const name of names) {
    const entry = dom.window[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: typeof entry === 'function' && ['requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle'].includes(name) ? entry.bind(dom.window) : entry });
  }
  dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
  const textarea = dom.window.document.querySelector('textarea')!; textarea.value = value;
  const changes: string[] = []; textarea.addEventListener('input', () => changes.push(textarea.value));
  const editor = enhanceBaseFormulaEditor(textarea, options);
  const content = dom.window.document.querySelector<HTMLElement>('.cm-content')!;
  const view = EditorView.findFromDOM(content)!;
  const key = (key: string) => content.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  return { dom, textarea, content, editor, view, changes, key, cleanup() {
    editor.destroy(); dom.window.close();
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  } };
}

test('visible accessible editor owns multiline editing, native input and undo', () => {
  const f = fixture();
  try {
    assert.equal(f.textarea.hidden, true); assert.equal(f.textarea.getAttribute('aria-hidden'), 'true');
    assert.equal(f.content.getAttribute('role'), 'textbox'); assert.equal(f.content.getAttribute('aria-label'), 'Formula expression');
    assert.equal(f.content.getAttribute('aria-multiline'), 'true');
    f.editor.focus(); assert.equal(f.editor.hasFocus(), true);
    f.view.dispatch({ selection: { anchor: f.view.state.doc.length } });
    f.key('Enter');
    assert.equal(f.textarea.value, 'note.cost * 2\n'); assert.deepEqual(f.changes, ['note.cost * 2\n']);
    assert.equal(undo(f.view), true); assert.equal(f.textarea.value, 'note.cost * 2');
    assert.equal(redo(f.view), true); assert.equal(f.textarea.value, 'note.cost * 2\n');
    assert.ok(f.content.querySelector('span'), 'expression tokens are highlighted');
  } finally { f.cleanup(); }
});

test('native drafts synchronize without input loops, and disabled/read-only attributes follow the model', async () => {
  const f = fixture();
  try {
    f.textarea.value = 'note.score + 1'; f.editor.sync();
    assert.equal(f.view.state.doc.toString(), f.textarea.value); assert.deepEqual(f.changes, []);
    f.textarea.value = '2 + 3'; f.textarea.dispatchEvent(new f.dom.window.Event('input'));
    assert.equal(f.view.state.doc.toString(), '2 + 3'); assert.deepEqual(f.changes, ['2 + 3']);
    f.textarea.readOnly = true; f.textarea.setAttribute('aria-label', 'Calculation'); await Promise.resolve();
    assert.equal(f.view.state.readOnly, true); assert.equal(f.content.getAttribute('aria-readonly'), 'true'); assert.equal(f.content.getAttribute('aria-label'), 'Calculation');
    f.textarea.readOnly = false; f.textarea.disabled = true; f.editor.sync(); assert.equal(f.view.state.readOnly, true);
  } finally { f.cleanup(); }
});

test('syntax diagnostics preserve invalid text and never evaluate functions or properties', () => {
  const diagnostics: (string | undefined)[] = [], f = fixture({ onDiagnostics: message => diagnostics.push(message) });
  try {
    f.view.dispatch({ changes: { from: 0, to: f.view.state.doc.length, insert: 'note.cost +' } });
    assert.equal(f.textarea.value, 'note.cost +'); assert.equal(f.content.getAttribute('aria-invalid'), 'true');
    const error = f.dom.window.document.querySelector<HTMLElement>('.bases-formula-editor-error')!;
    assert.equal(error.hidden, false); assert.ok(error.textContent); assert.equal(diagnostics.length, 1);
    f.view.dispatch({ changes: { from: 0, to: f.view.state.doc.length, insert: 'unknownFunction(note.missing)' } });
    assert.equal(error.hidden, true); assert.equal(f.content.getAttribute('aria-invalid'), 'false');
    assert.equal(diagnostics.at(-1), undefined, 'unknown runtime function is syntactically valid');
  } finally { f.cleanup(); }
});

test('property and function completions work; Escape dismisses completion before exiting the editor', async () => {
  let escapes = 0;
  const f = fixture({ propertyIds: ['note.cost', 'note.Project name'], functionNames: ['round'], onEscape: () => escapes++ }, 'note.');
  try {
    f.editor.focus(); f.view.dispatch({ selection: { anchor: f.view.state.doc.length } });
    startCompletion(f.view); await new Promise(resolve => setTimeout(resolve, 170));
    assert.deepEqual(currentCompletions(f.view.state).map(item => item.label), ['note.cost', 'note.Project name']);
    assert.equal(currentCompletions(f.view.state)[1].apply, 'note["Project name"]');
    f.key('Escape'); assert.equal(completionStatus(f.view.state), null); assert.equal(escapes, 0);
    f.key('Escape'); assert.equal(escapes, 1);
    f.view.dispatch({ changes: { from: 0, to: f.view.state.doc.length, insert: 'rou' }, selection: { anchor: 3 } });
    startCompletion(f.view); await new Promise(resolve => setTimeout(resolve, 170));
    assert.equal(currentCompletions(f.view.state)[0]?.label, 'round()');
    assert.equal(acceptCompletion(f.view), true); assert.equal(f.textarea.value, 'round()');
    assert.equal(f.view.state.selection.main.head, 6, 'function insertion leaves caret between parentheses');
    closeCompletion(f.view);
  } finally { f.cleanup(); }
});

test('destroy restores native attributes and does not overwrite the latest draft', () => {
  const f = fixture();
  try {
    f.view.dispatch({ changes: { from: 0, to: f.view.state.doc.length, insert: '42' } });
    f.editor.destroy(); f.editor.destroy();
    assert.equal(f.textarea.value, '42'); assert.equal(f.textarea.hidden, false);
    assert.equal(f.textarea.hasAttribute('aria-hidden'), false); assert.equal(f.textarea.hasAttribute('tabindex'), false);
    assert.equal(f.dom.window.document.querySelector('.bases-formula-editor'), null);
    assert.equal(f.editor.hasFocus(), false); f.editor.sync();
  } finally { f.cleanup(); }
});

test('owner-document-only hosts keep a native editor and cleanly restore its location', () => {
  const dom = new JSDOM('<main><textarea aria-label="Formula expression"></textarea><button>Next</button></main>');
  const textarea = dom.window.document.querySelector('textarea')!;
  const editor = enhanceBaseFormulaEditor(textarea);
  try {
    assert.equal(textarea.hidden, false); assert.ok(textarea.closest('.bases-formula-editor'));
    textarea.value = 'note.cost +'; textarea.dispatchEvent(new dom.window.Event('input'));
    assert.ok(dom.window.document.querySelector('.bases-formula-editor-error')?.textContent);
    editor.destroy(); assert.equal(textarea.parentElement?.tagName, 'MAIN');
    assert.equal(textarea.nextElementSibling?.tagName, 'BUTTON');
  } finally { editor.destroy(); dom.window.close(); }
});
