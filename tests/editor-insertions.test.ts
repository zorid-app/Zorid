import test from 'node:test';
import assert from 'node:assert/strict';
import {EditorState, EditorSelection} from '@codemirror/state';
import {markdown, markdownLanguage} from '@codemirror/lang-markdown';
import {history, undo, undoDepth} from '@codemirror/commands';
import {frontmatterMarkdown} from '../src/editor/frontmatter-syntax.ts';
import {mathMarkdown} from '../src/editor/math-syntax.ts';
import {INSERTION_COMMANDS, insertionTransaction, canInsert} from '../src/editor/insertion-commands.ts';
import {EDITOR_HOTKEY_COMMANDS, HotkeyPreferences} from '../src/ui/hotkeys.ts';
import {formatMenuForEditor} from '../src/editor/format-menu.ts';

function source(doc:string, selection=EditorSelection.cursor(doc.length)){
  return EditorState.create({doc,selection,extensions:[history(),EditorState.allowMultipleSelections.of(true),
    markdown({base:markdownLanguage,extensions:[frontmatterMarkdown,mathMarkdown]})]});
}
function insert(state:EditorState,id:Parameters<typeof insertionTransaction>[1]){
  const spec=insertionTransaction(state,id);assert.ok(spec,id);return state.update(spec).state;
}
function undoState(state:EditorState){let next=state;assert.ok(undo({state,dispatch:transaction=>{next=transaction.state;}}));return next;}

test('all eight insertion commands are configurable without new default bindings',()=>{
  const preferences=new HotkeyPreferences({getItem:()=>null,setItem(){}},'other');
  for(const command of INSERTION_COMMANDS){
    const entry=EDITOR_HOTKEY_COMMANDS.find(item=>item.id===command.id);assert.ok(entry);assert.deepEqual(entry.defaults,[]);
    preferences.set(command.id,[{key:'F9',modifiers:[]}]);assert.deepEqual(preferences.effectiveBindings(command.id),[{key:'F9',modifiers:[]}]);preferences.set(command.id,[]);
  }
});

test('table keeps selected text, inserts valid block boundaries and selects first header',()=>{
  const before=source('left selected right',EditorSelection.range(5,13));const after=insert(before,'editor-insert-table');
  assert.equal(after.doc.toString(),'left \n\nselected\n\n| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n\n right');
  assert.equal(after.sliceDoc(after.selection.main.from,after.selection.main.to),'Column 1');assert.equal(undoDepth(after),1);
  const restored=undoState(after);assert.equal(restored.doc.toString(),before.doc.toString());assert.ok(restored.selection.eq(before.selection));
});

test('multiline callout retains blank lines and reverse selection',()=>{
  const text='one\n\ntwo',before=source(text,EditorSelection.range(text.length,0));const after=insert(before,'editor-insert-callout');
  assert.equal(after.doc.toString(),'> [!note]\n> one\n> \n> two');assert.ok(after.selection.main.anchor>after.selection.main.head);
  assert.equal(after.sliceDoc(after.selection.main.from,after.selection.main.to),'one\n> \n> two');assert.ok(undoState(after).selection.eq(before.selection));
});

test('code block keeps selected backticks and uses a longer fence',()=>{
  const text='one ``` literal\ntwo',before=source(text,EditorSelection.range(0,text.length));const after=insert(before,'editor-insert-code-block');
  assert.equal(after.doc.toString(),'````\n'+text+'\n````');assert.equal(after.sliceDoc(after.selection.main.from,after.selection.main.to),text);assert.equal(undoState(after).doc.toString(),text);
});

test('code block can wrap a complete inline-code span but never split its interior',()=>{
  const text='one `two` three';assert.equal(insertionTransaction(source(text,EditorSelection.cursor(6)),'editor-insert-code-block'),null);
  assert.equal(insert(source(text,EditorSelection.range(0,text.length)),'editor-insert-code-block').doc.toString(),'```\n'+text+'\n```');
});

test('math block wraps content, rejects its own delimiter and preserves selected bytes',()=>{
  const before=source('a + b',EditorSelection.range(0,5)),after=insert(before,'editor-insert-math-block');assert.equal(after.doc.toString(),'$$\na + b\n$$');
  assert.equal(after.sliceDoc(after.selection.main.from,after.selection.main.to),'a + b');assert.equal(insertionTransaction(source('x $$ y',EditorSelection.range(0,6)),'editor-insert-math-block'),null);
});

test('horizontal rule retains selected text and avoids frontmatter at document start',()=>{
  assert.equal(insert(source(''),'editor-insert-rule').doc.toString(),'***\n\n');
  const after=insert(source('Keep',EditorSelection.range(0,4)),'editor-insert-rule');assert.equal(after.doc.toString(),'Keep\n\n***\n\n');assert.equal(after.selection.main.head,after.doc.length);
});

test('links and images escape selected labels and place caret in destination',()=>{
  for(const id of ['editor-insert-link','editor-insert-image'] as const){
    const text='x [y] \\ z';const after=insert(source(text,EditorSelection.range(0,text.length)),id);
    assert.equal(after.doc.toString(),(id==='editor-insert-image'?'!':'')+'[x \\[y\\] \\\\ z]()');assert.equal(after.selection.main.head,after.doc.length-1);
    assert.equal(undoState(after).doc.toString(),text);
  }
});

test('multiple selections retain main range and remain one undo unit',()=>{
  const before=source('one two',EditorSelection.create([EditorSelection.range(3,0),EditorSelection.range(4,7)],1));
  const after=insert(before,'editor-insert-callout');assert.equal(after.selection.ranges.length,2);assert.equal(after.selection.mainIndex,1);assert.equal(undoDepth(after),1);
  const restored=undoState(after);assert.equal(restored.doc.toString(),'one two');assert.ok(restored.selection.eq(before.selection));
});

test('footnote allocates around references and definitions, appends once and undoes atomically',()=>{
  const text='Selected [^1]\n\n[^3]: Used';const before=source(text,EditorSelection.range(8,0)),after=insert(before,'editor-insert-footnote');
  assert.equal(after.doc.toString(),'[^2] [^1]\n\n[^3]: Used\n\n[^2]: Selected\n');assert.equal(after.sliceDoc(after.selection.main.from,after.selection.main.to),'Selected');assert.ok(after.selection.main.anchor>after.selection.main.head);
  assert.equal(undoDepth(after),1);const restored=undoState(after);assert.equal(restored.doc.toString(),text);assert.ok(restored.selection.eq(before.selection));
});

test('multiple footnotes receive different identifiers even at EOF and keep main index',()=>{
  const before=source('one two',EditorSelection.create([EditorSelection.range(0,3),EditorSelection.range(4,7)],1));const after=insert(before,'editor-insert-footnote');
  assert.equal(after.doc.toString(),'[^1] [^2]\n\n[^1]: one\n[^2]: two\n');assert.equal(after.selection.mainIndex,1);assert.equal(after.selection.ranges.length,2);
  assert.equal(undoState(after).doc.toString(),'one two');
  assert.equal(insert(source(''),'editor-insert-footnote').doc.toString(),'[^1]\n\n[^1]: \n');
});

test('table child permits inline edits only; rectangle and readonly reject every insertion',()=>{
  const state=source('plain',EditorSelection.range(0,5));
  for(const command of INSERTION_COMMANDS){assert.equal(canInsert(state,command.id,{rectangle:true}),false);
    assert.equal(canInsert(state,command.id,{inTableCell:true}),['editor-insert-link','editor-insert-image'].includes(command.id));
    assert.equal(insertionTransaction(EditorState.create({doc:'plain',extensions:[EditorState.readOnly.of(true)]}),command.id),null);
  }
});

test('late fenced code is never authorized by an incomplete syntax tree',()=>{
  const prefix='paragraph\n\n'.repeat(1800),doc=prefix+'```\ninside\n```';const state=source(doc,EditorSelection.cursor(prefix.length+5));
  for(const command of INSERTION_COMMANDS)assert.equal(insertionTransaction(state,command.id),null);
});

test('context menu uses the same insertion actions and reevaluates readonly at invocation',()=>{
  let state=source('selected',EditorSelection.range(0,8));const view={get state(){return state;},composing:false,dom:{isConnected:true},focus(){},dispatch(spec:Parameters<EditorState['update']>[0]){state=state.update(spec).state;}} as any;
  const menu=formatMenuForEditor(view),insertMenu=menu.find(item=>'id'in item&&item.id==='insert');assert.ok(insertMenu&&'submenu'in insertMenu);assert.equal(insertMenu.enabled,true);
  const table=insertMenu.submenu.find(item=>'id'in item&&item.id==='insert-table');assert.ok(table&&'run'in table);assert.equal(table.run(),true);assert.match(state.doc.toString(),/selected\n\n\| Column 1/);
  state=EditorState.create({doc:'No',extensions:[EditorState.readOnly.of(true)]});assert.equal(table.run(),false);assert.equal(state.doc.toString(),'No');
});


test('context action identities keep existing wiki links distinct from inserted Markdown links',()=>{
  let state=source('Label',EditorSelection.range(0,5));const view={get state(){return state;},composing:false,compositionStarted:false,dom:{isConnected:true},focus(){},dispatch(spec:Parameters<EditorState['update']>[0]){state=state.update(spec).state;}} as any;
  const menu=formatMenuForEditor(view),actions=new Map<string,()=>boolean>();
  const collect=(items:ReturnType<typeof formatMenuForEditor>)=>{for(const item of items){if('id'in item){assert.equal(actions.has(item.id),false,item.id);if('run'in item)actions.set(item.id,item.run);if('submenu'in item)collect(item.submenu);}}};collect(menu);
  assert.equal(actions.get('insert-link')!(),true);assert.equal(state.doc.toString(),'[[Label]]');
  state=source('Label',EditorSelection.range(0,5));assert.equal(actions.get('insert-markdown-link')!(),true);assert.equal(state.doc.toString(),'[Label]()');
});
