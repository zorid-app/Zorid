import test from 'node:test';
import assert from 'node:assert/strict';
import {EditorState} from '@codemirror/state';
import {markdown,markdownLanguage} from '@codemirror/lang-markdown';
import {frontmatterMarkdown} from '../src/editor/frontmatter-syntax.ts';
import {slashCommands,filterSlashCommands,slashInsertionTransaction} from '../src/editor/slash-commands.ts';
const commands=slashCommands({inline:true,page:true});
function state(doc:string,at=doc.length){return EditorState.create({doc,selection:{anchor:at},extensions:[markdown({base:markdownLanguage,extensions:[frontmatterMarkdown]})]});}
test('the slash catalogue exposes supported Markdown and supplied database capabilities only',()=>{
 assert.deepEqual(commands.filter(command=>command.kind==='insert').map(command=>command.command).sort(),['editor-insert-callout','editor-insert-code-block','editor-insert-footnote','editor-insert-image','editor-insert-link','editor-insert-math-block','editor-insert-rule','editor-insert-table']);
 assert.deepEqual(commands.filter(command=>command.kind==='prefix').map(command=>command.id),['text','heading-1','heading-2','heading-3','heading-4','bullet','number','todo','quote']);
 assert.equal(slashCommands({inline:false,page:false}).some(command=>command.kind==='database'),false);assert.deepEqual(slashCommands({inline:false,page:true}).filter(command=>command.kind==='database').map(command=>command.id),['database-page']);
 assert.equal(new Set(commands.map(command=>command.id)).size,commands.length);
});
test('keyword search is case insensitive, supports multiple terms and retains catalogue order',()=>{
 assert.deepEqual(filterSlashCommands(commands,'H2').map(command=>command.id),['heading-2']);assert.deepEqual(filterSlashCommands(commands,'TASK').map(command=>command.id),['todo']);assert.deepEqual(filterSlashCommands(commands,'database full').map(command=>command.id),['database-page']);assert.deepEqual(filterSlashCommands(commands,'code block').map(command=>command.id),['editor-insert-code-block']);assert.deepEqual(filterSlashCommands(commands,'missing feature'),[]);
});
for(const [id,prefix]of[['text',''],['heading-1','# '],['heading-2','## '],['heading-3','### '],['heading-4','#### '],['todo','- [ ] '],['bullet','- '],['number','1. '],['quote','> ']]as const)test(`${id} replaces only the captured standalone slash line and puts the cursor after its marker`,()=>{
 const initial=state('Before\n/command\nAfter',15),command=commands.find(command=>command.id===id)!;const plan=slashInsertionTransaction(initial,7,15,command)!;assert.ok(plan);const next=initial.update(plan).state;assert.equal(next.doc.toString(),`Before\n${prefix}\nAfter`);assert.equal(next.selection.main.head,7+prefix.length);
});
for(const [id,fragment]of[['editor-insert-table','| Column 1 | Column 2 |'],['editor-insert-callout','> [!note]'],['editor-insert-code-block','```\n\n```'],['editor-insert-math-block','$$\n\n$$'],['editor-insert-rule','***'],['editor-insert-image','![]()'],['editor-insert-link','[]()'],['editor-insert-footnote','[^1]: ']]as const)test(`${id} composes its existing insertion planner with slash removal atomically`,()=>{
 const initial=state('/command'),plan=slashInsertionTransaction(initial,0,8,commands.find(command=>command.id===id)!)!;assert.ok(plan);const next=initial.update(plan).state;assert.ok(next.doc.toString().includes(fragment));assert.equal(next.doc.toString().includes('/command'),false);assert.equal(next.selection.ranges.length,1);
});
test('readonly, code and malformed captured ranges fail closed without a transaction',()=>{
 const command=commands.find(command=>command.id==='heading-1')!;for(const initial of[state('```\n/command'),EditorState.create({doc:'/command',extensions:[EditorState.readOnly.of(true)]})])assert.equal(slashInsertionTransaction(initial,0,initial.doc.length,command),null);for(const[from,to]of[[-1,8],[0,99],[8,0],[0.5,8]])assert.equal(slashInsertionTransaction(state('/command'),from,to,command),null);
});
