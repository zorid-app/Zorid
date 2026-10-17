import test from 'node:test';
import assert from 'node:assert/strict';
import {EditorState, EditorSelection} from '@codemirror/state';
import {markdown, markdownLanguage} from '@codemirror/lang-markdown';
import {frontmatterMarkdown} from '../src/editor/frontmatter-syntax.ts';
import {mathMarkdown} from '../src/editor/math-syntax.ts';
import {liveInlineMarkdown} from '../src/editor/live-inline.ts';
import {INSERTION_COMMANDS, insertionTransaction} from '../src/editor/insertion-commands.ts';

function state(doc:string, from:number, to=from){
  return EditorState.create({doc,selection:EditorSelection.range(from,to),extensions:[
    markdown({base:markdownLanguage,extensions:[frontmatterMarkdown,mathMarkdown,liveInlineMarkdown]}),
  ]});
}

test('insertion respects real frontmatter and math parser owners',()=>{
  for(const [doc,needle] of [
    ['---\nstatus: Todo\n---\nBody','Todo'],
    ['Before\n\n$$\nx+y\n$$\n\nAfter','x+y'],
    ['Before $x+y$ after','x+y'],
  ]){
    const source=state(doc,doc.indexOf(needle)+1);
    for(const command of INSERTION_COMMANDS)assert.equal(insertionTransaction(source,command.id),null,`${command.id}: ${doc}`);
  }
});

test('block insertion cannot split inline code or wiki destinations',()=>{
  for(const [doc,needle] of [['Before `value` after','value'],['Before [[Target]] after','Target']]){
    const source=state(doc,doc.indexOf(needle)+2);
    for(const id of ['editor-insert-table','editor-insert-callout','editor-insert-code-block','editor-insert-rule'] as const)
      assert.equal(insertionTransaction(source,id),null,`${id}: ${doc}`);
  }
});

test('footnote definitions cannot be appended into terminal unfinished containers',()=>{
  for(const suffix of ['```','```js','~~~','<!-- unfinished','$$\nx+y']){
    const source=state('Before\n\n'+suffix,2);
    assert.equal(insertionTransaction(source,'editor-insert-footnote'),null,suffix);
  }
});

test('footnote insertion after a closed terminal fence stays one valid source edit',()=>{
  const source=state('Before\n\n```\nvalue\n```',6);
  const spec=insertionTransaction(source,'editor-insert-footnote');assert.ok(spec);
  const next=source.update(spec).state;
  assert.equal(next.doc.toString(),'Before[^1]\n\n```\nvalue\n```\n\n[^1]: \n');
});

test('a document-start rule never becomes metadata',()=>{
  const source=state('',0),spec=insertionTransaction(source,'editor-insert-rule');assert.ok(spec);
  const next=source.update(spec).state;
  assert.equal(insertionTransaction(next,'editor-insert-link')===null,false);
  assert.doesNotMatch(next.doc.toString(),/^---(?:\n|$)/);
});
