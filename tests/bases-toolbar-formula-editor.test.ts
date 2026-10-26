import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorView } from '@codemirror/view';
import { undo, redo } from '@codemirror/commands';
import { acceptCompletion, closeCompletion, completionStatus, currentCompletions, startCompletion, snippet } from '@codemirror/autocomplete';
import { enhanceBaseFormulaEditor, enhanceBaseSummaryEditor } from '../src/bases/toolbar-formula-editor.ts';
import type { BaseFormulaEditorOptions } from '../src/bases/toolbar-formula-editor.ts';

function fixture(options: BaseFormulaEditorOptions = {}, value = 'note.cost * 2', summary = false) {
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
  const textarea = dom.window.document.querySelector('textarea')!; textarea.value = value; if(summary){textarea.setAttribute('aria-label','Summary expression');textarea.placeholder='values.reduce( ... )';}
  const changes: string[] = []; textarea.addEventListener('input', () => changes.push(textarea.value));
  const editor = summary ? enhanceBaseSummaryEditor(textarea,options) : enhanceBaseFormulaEditor(textarea, options);
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

test('receiver method completion replaces only the member suffix, preserving nested calls and bracket properties', async () => {
  const f = fixture({ propertyIds: ['note.tags', 'note.score'], functionNames: ['round'], methodNames: ['contains', 'format', 'contains()'] });
  try {
    f.editor.focus();
    for (const [expression, expected, method] of [
      ['note.tags.co', 'note.tags.contains()', 'contains()'],
      ['note.tags.', 'note.tags.contains()', 'contains()'],
      ['date("2026-10-21").fo', 'date("2026-10-21").format()', 'format()'],
      ['note["Tags list"].co', 'note["Tags list"].contains()', 'contains()'],
      ['note["Project name"].tags.co', 'note["Project name"].tags.contains()', 'contains()'],
      ['"quoted value".co', '"quoted value".contains()', 'contains()'],
      ['round(note.score) + note.tags.co', 'round(note.score) + note.tags.contains()', 'contains()'],
    ]) {
      closeCompletion(f.view);
      f.view.dispatch({ changes: { from: 0, to: f.view.state.doc.length, insert: expression }, selection: { anchor: expression.length } });
      startCompletion(f.view); await new Promise(resolve => setTimeout(resolve, 170));
      const suggestions = currentCompletions(f.view.state);
      assert.equal(suggestions[0]?.label, method, expression);
      assert.equal(suggestions.filter(item => item.label === 'contains()').length, method === 'contains()' ? 1 : 0, 'method names are deduplicated');
      assert.equal(acceptCompletion(f.view), true, expression);
      assert.equal(f.textarea.value, expected, expression);
      assert.equal(f.view.state.selection.main.head, expected.length - 1);
    }
  } finally { f.cleanup(); }
});

test('namespace properties and global functions remain distinct from receiver methods', async () => {
  const f = fixture({ propertyIds: ['note.score', 'note.Project name', 'file.name', 'this.score'], functionNames: ['round'], methodNames: ['contains', 'format'] });
  try {
    f.editor.focus();
    for (const [expression, expected] of [
      ['note.sc', 'note.score'], ['file.na', 'file.name'], ['this.sc', 'this.score'],
      ['note.Pr', 'note["Project name"]'], ['1 + note.sc', '1 + note.score'],
      ['rou', 'round()'],
    ]) {
      closeCompletion(f.view);
      f.view.dispatch({ changes: { from: 0, to: f.view.state.doc.length, insert: expression }, selection: { anchor: expression.length } });
      startCompletion(f.view); await new Promise(resolve => setTimeout(resolve, 170));
      assert.ok(currentCompletions(f.view.state).length, expression);
      assert.equal(currentCompletions(f.view.state).some(item => item.type === 'method'), false, expression);
      assert.equal(acceptCompletion(f.view), true, expression); assert.equal(f.textarea.value, expected, expression);
    }
  } finally { f.cleanup(); }
});

test('completion never offers properties or methods inside unfinished quoted strings', async () => {
  const f = fixture({ propertyIds: ['note.score'], functionNames: ['round'], methodNames: ['contains'] });
  try {
    f.editor.focus();
    for (const expression of ['"note.tags.co', "'note.tags.co", '"escaped \\" note.tags.co', 'note["Tags co']) {
      closeCompletion(f.view);
      f.view.dispatch({ changes: { from: 0, to: f.view.state.doc.length, insert: expression }, selection: { anchor: expression.length } });
      startCompletion(f.view); await new Promise(resolve => setTimeout(resolve, 80));
      assert.deepEqual(currentCompletions(f.view.state), [], expression);
    }
  } finally { f.cleanup(); }
});

test('typing dots invalidates cached global and namespace completions before receiver methods are offered', async () => {
  const f = fixture({ propertyIds: ['note.tags'], functionNames: ['now'], methodNames: ['contains'] }, 'no');
  try {
    f.editor.focus(); f.view.dispatch({ selection: { anchor: 2 } });
    startCompletion(f.view); await new Promise(resolve => setTimeout(resolve, 170));
    assert.ok(currentCompletions(f.view.state).some(item => item.label === 'note.tags'));
    f.view.dispatch({ changes: { from: 2, insert: 'te.' }, selection: { anchor: 5 }, userEvent: 'input.type' });
    await new Promise(resolve => setTimeout(resolve, 170));
    assert.deepEqual(currentCompletions(f.view.state).map(item => item.label), ['note.tags']);
    f.view.dispatch({ changes: { from: 5, insert: 'tags.co' }, selection: { anchor: 12 }, userEvent: 'input.type' });
    await new Promise(resolve => setTimeout(resolve, 170));
    assert.deepEqual(currentCompletions(f.view.state).map(item => item.label), ['contains()']);
    assert.equal(acceptCompletion(f.view), true); assert.equal(f.textarea.value, 'note.tags.contains()');
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

test('summary editor completes values and implemented globals without exposing note or host context',async()=>{
 const f=fixture({propertyIds:['note.cost','file.name','formula.Total','this.score'],functionNames:['if','list','max','min','number','now','random','file','image','notImplemented']},'',true);
 try{
  assert.equal(f.content.querySelector('.cm-placeholder')?.textContent,'values.reduce( ... )');
  f.editor.focus();startCompletion(f.view);await new Promise(resolve=>setTimeout(resolve,170));
  assert.deepEqual(new Set(currentCompletions(f.view.state).map(item=>item.label)),new Set(['values','if()','list()','max()','min()','number()','now()']));
  closeCompletion(f.view);f.view.dispatch({changes:{from:0,insert:'val'},selection:{anchor:3}});startCompletion(f.view);await new Promise(resolve=>setTimeout(resolve,170));
  assert.equal(acceptCompletion(f.view),true);assert.equal(f.textarea.value,'values');assert.equal(f.content.getAttribute('aria-label'),'Summary expression');
 }finally{f.cleanup();}
});

test('summary list completions preserve receivers and include length without offering scalar or host methods',async()=>{
 const f=fixture({},'',true);
 try{
  f.editor.focus();
  for(const [expression,expected] of [
   ['values.su','values.sum()'],['values.le','values.length'],
   ['values.filter(value > 0).su','values.filter(value > 0).sum()'],
   ['list(2).un','list(2).unique()'],
   ['1 + values.su','1 + values.sum()'],
   ['if(true, values.su','if(true, values.sum()'],
   ['if(true, values, values).su','if(true, values, values).sum()'],
   ['if(true, values.filter(value > 0).su','if(true, values.filter(value > 0).sum()'],
   ['if(true, values.filter(value != ",").su','if(true, values.filter(value != ",").sum()'],
   ['if("a, b + c".isEmpty(), values.su','if("a, b + c".isEmpty(), values.sum()'],
  ]){
   closeCompletion(f.view);f.view.dispatch({changes:{from:0,to:f.view.state.doc.length,insert:expression},selection:{anchor:expression.length}});startCompletion(f.view);await new Promise(resolve=>setTimeout(resolve,170));
   assert.equal(acceptCompletion(f.view),true,expression);assert.equal(f.textarea.value,expected);
  }
  for(const expression of ['note.','file.','formula.','this.','unknown.','1 + unknown.su','if(true, file.su','values.sum().su','"values.su','if(true, "values.su']){
   closeCompletion(f.view);f.view.dispatch({changes:{from:0,to:f.view.state.doc.length,insert:expression},selection:{anchor:expression.length}});startCompletion(f.view);await new Promise(resolve=>setTimeout(resolve,80));
   assert.deepEqual(currentCompletions(f.view.state),[],expression);
  }
 }finally{f.cleanup();}
});

test('summary contextual candidates are restricted to supported methods and Escape respects IME/completion ownership',async()=>{
 let escapes=0;const f=fixture({methodNames:['sum','hasTag','hasLink','notImplemented'],onEscape:()=>escapes++},'values.',true);
 try{
  f.editor.focus();f.view.dispatch({selection:{anchor:f.view.state.doc.length}});startCompletion(f.view);await new Promise(resolve=>setTimeout(resolve,170));
  assert.deepEqual(new Set(currentCompletions(f.view.state).map(item=>item.label)),new Set(['length','sum()']));
  f.key('Escape');assert.equal(completionStatus(f.view.state),null);assert.equal(escapes,0);
  f.content.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',keyCode:229,isComposing:true,bubbles:true,cancelable:true}));assert.equal(escapes,0,'IME Escape must not leave the summary editor');
  f.key('Escape');assert.equal(escapes,1);f.key('Enter');assert.equal(f.textarea.value,'values.\n');assert.ok(f.content.querySelector('span'),'summary tokens share syntax highlighting');
  f.editor.destroy();assert.equal(f.textarea.hidden,false);assert.equal(f.textarea.value,'values.\n');assert.equal(f.editor.hasFocus(),false);
 }finally{f.cleanup();}
});


test('summary explicit Tab commits once without consuming focus navigation or submitting on blur', () => {
  let commits = 0;
  const f = fixture({ onCommit: () => commits++ }, 'values.sum()', true);
  try {
    f.editor.focus();
    const tab = new f.dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    f.content.dispatchEvent(tab);
    assert.equal(commits, 1); assert.equal(tab.defaultPrevented, false); assert.equal(f.textarea.value, 'values.sum()');
    const internal = f.dom.window.document.createElement('button'); f.content.closest('.bases-formula-editor')!.append(internal); internal.focus();
    assert.equal(commits, 1, 'internal focus and blur do not introduce an implicit submit');
    const outside = f.dom.window.document.createElement('button'); f.dom.window.document.body.append(outside); outside.focus();
    assert.equal(commits, 1, 'ordinary blur does not duplicate explicit Tab submission');
    f.editor.focus();
    const backward = new f.dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    f.content.dispatchEvent(backward); assert.equal(commits, 2); assert.equal(backward.defaultPrevented, false);
    f.textarea.value = 'values.length'; f.editor.sync(); assert.equal(commits, 2, 'programmatic synchronization never submits');
  } finally { f.cleanup(); }
});

test('summary snippet Tab navigation takes precedence over explicit submission', () => {
  let commits = 0;
  const f = fixture({ onCommit: () => commits++ }, '', true);
  try {
    f.editor.focus(); snippet('list(${one}, ${two}, ${three})')(f.view, null, 0, 0);
    const first = f.view.state.selection.main;
    assert.equal(f.view.state.sliceDoc(first.from, first.to), 'one');
    const tab = new f.dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    f.content.dispatchEvent(tab);
    const second = f.view.state.selection.main;
    assert.equal(f.view.state.sliceDoc(second.from, second.to), 'two');
    assert.equal(tab.defaultPrevented, true); assert.equal(commits, 0, 'handled snippet navigation never saves a partial formula');
    const reverse = new f.dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    f.content.dispatchEvent(reverse); assert.equal(reverse.defaultPrevented, true); assert.equal(commits, 0);
  } finally { f.cleanup(); }
});

test('summary explicit commit ignores composition, disabled or retired ownership', () => {
  let commits = 0;
  const f = fixture({ onCommit: () => commits++ }, 'values.sum()', true);
  try {
    f.editor.focus();
    f.content.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Tab', isComposing: true, bubbles: true, cancelable: true }));
    f.content.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Tab', keyCode: 229, bubbles: true, cancelable: true }));
    assert.equal(commits, 0);
    const prevented = new f.dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }); prevented.preventDefault(); f.content.dispatchEvent(prevented);
    for(const modifiers of [{altKey:true},{ctrlKey:true},{metaKey:true}])f.content.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true,...modifiers}));
    assert.equal(commits,0,'handled or modified keys do not submit');
    f.textarea.disabled = true; f.editor.sync(); f.key('Tab'); assert.equal(commits, 0);
    f.textarea.disabled = false; f.textarea.readOnly = true; f.editor.sync(); f.key('Tab'); assert.equal(commits, 0);
    f.textarea.readOnly = false; f.editor.sync(); f.editor.focus();
    const wrapper = f.content.closest('.bases-formula-editor')!; wrapper.setAttribute('inert', ''); f.key('Tab'); assert.equal(commits, 0);
    wrapper.removeAttribute('inert'); f.editor.focus(); f.key('Tab'); assert.equal(commits, 1, 'one admitted Tab still submits after negative paths');
    f.editor.destroy(); f.key('Tab'); assert.equal(commits, 1, 'destroy removes the key receiver');
  } finally { f.cleanup(); }
});

test('native summary fallback shares the same single unhandled Tab submit contract', () => {
  const dom = new JSDOM('<textarea aria-label="Summary expression"></textarea><button>Next</button>', { pretendToBeVisual: true });
  const textarea = dom.window.document.querySelector('textarea')!; textarea.value = 'values.length';
  let commits = 0; const editor = enhanceBaseSummaryEditor(textarea, { onCommit: () => commits++ });
  const tab = (extra: KeyboardEventInit = {}) => { const event = new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true, ...extra }); textarea.dispatchEvent(event); return event; };
  try {
    assert.equal(textarea.hidden, false); editor.focus(); assert.equal(tab().defaultPrevented, false); assert.equal(commits, 1);
    dom.window.document.querySelector('button')!.focus(); assert.equal(commits, 1); tab(); assert.equal(commits, 1, 'a non-owner cannot submit');
    editor.focus(); tab({ isComposing: true }); tab({ keyCode: 229 }); tab({altKey:true}); tab({ctrlKey:true}); tab({metaKey:true}); assert.equal(commits, 1);
    textarea.disabled = true; tab(); textarea.disabled = false; textarea.readOnly = true; tab(); assert.equal(commits, 1);
    textarea.readOnly = false; editor.focus(); assert.equal(tab({ shiftKey: true }).defaultPrevented, false); assert.equal(commits, 2);
    editor.destroy(); tab(); assert.equal(commits, 2);
  } finally { editor.destroy(); dom.window.close(); }
});
