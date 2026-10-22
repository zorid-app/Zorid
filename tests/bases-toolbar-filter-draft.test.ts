import test from 'node:test';
import assert from 'node:assert/strict';
import {createBaseFilterDraft,newBaseFilterCondition,newBaseFilterGroup,readBaseFilterDraft,updateBaseFilterCondition,updateBaseFilterExpression,captureBaseFilterAcknowledgement} from '../src/bases/toolbar-filter.ts';
import type {BaseFilterDraftCondition} from '../src/bases/toolbar-filter.ts';

test('new blank rows and nested groups never become saved truth or falsehood',()=>{
  const root=createBaseFilterDraft(undefined);assert.equal(readBaseFilterDraft(root),undefined);
  root.conjunction='or';root.children.push(newBaseFilterGroup('and'),newBaseFilterGroup('not'));assert.equal(readBaseFilterDraft(root),undefined);
  const row=root.children[0] as BaseFilterDraftCondition;updateBaseFilterCondition(row,{property:'file.file',operator:'hasLink',text:'Items/A.md',type:'text',values:['Items/A.md']});
  assert.deepEqual(readBaseFilterDraft(root),{or:['file.hasLink("Items/A.md")']});
});
test('persisted empty AND OR NOT retain their exact authority, including inside OR',()=>{
  for(const conjunction of ['and','or','not'] as const){const source={[conjunction]:[]} as {and:[]};const root=createBaseFilterDraft(source);assert.deepEqual(readBaseFilterDraft(root),source);root.children.push(newBaseFilterGroup());assert.deepEqual(readBaseFilterDraft(root),source);}
  const source={or:[{or:[]},'note.score > 4']};const root=createBaseFilterDraft(source);root.children.push(newBaseFilterGroup('and'));assert.deepEqual(readBaseFilterDraft(root),source);
});
test('accepted clause becoming incomplete blocks every serialized sibling and scope save',()=>{
  const root=createBaseFilterDraft({and:['file.hasLink("A.md")','note.score > 4']});
  updateBaseFilterCondition(root.children[0] as BaseFilterDraftCondition,{property:'file.file',operator:'hasLink',text:'',type:'text',values:[]});
  assert.throws(()=>readBaseFilterDraft(root),/existing filter/);
  root.children.splice(0,1);assert.deepEqual(readBaseFilterDraft(root),{and:['note.score > 4']});
});
test('advanced syntax, explicit NOT groups and scalar empty literals roundtrip unchanged',()=>{
  const source={not:['  file.hasLink(link("A", "Alias"))  ',{or:['note.title == ""','note.score > 1']}]};
  assert.deepEqual(readBaseFilterDraft(createBaseFilterDraft(source)),source);
  const root=createBaseFilterDraft('note.title == ""');assert.equal(readBaseFilterDraft(root),'note.title == ""');
});
test('acknowledgement records the exact submitted row even when newer text is incomplete',()=>{
  const root=createBaseFilterDraft(undefined),row=root.children[0] as BaseFilterDraftCondition;
  updateBaseFilterCondition(row,{property:'file.file',operator:'hasLink',text:'A.md',type:'text',values:['A.md']});const acknowledge=captureBaseFilterAcknowledgement(root);
  updateBaseFilterCondition(row,{property:'file.file',operator:'hasLink',text:'',type:'text',values:[]});assert.equal(readBaseFilterDraft(root),undefined);
  acknowledge();assert.throws(()=>readBaseFilterDraft(root),/existing filter/);assert.equal(row.acceptedSource,'file.hasLink("A.md")');
});
test('new invalid numeric values remain guarded; new untouched blank may be dismissed',()=>{
  const row=newBaseFilterCondition();updateBaseFilterCondition(row,{property:'note.score',operator:'gt',text:'NaN',type:'number'});assert.throws(()=>readBaseFilterDraft(row),/finite decimal/);
  updateBaseFilterCondition(row,{property:'note.score',operator:'gt',text:'',type:'number'});assert.equal(readBaseFilterDraft(row),undefined);
  updateBaseFilterExpression(row,'note.score +');assert.equal(readBaseFilterDraft(row),'note.score +');
});
test('a formerly empty group adopts its exact nonempty saved baseline before later removal',()=>{
  const root=createBaseFilterDraft({or:[]}),row=root.children[0] as BaseFilterDraftCondition;
  updateBaseFilterCondition(row,{property:'file.file',operator:'hasLink',text:'A.md',type:'text',values:['A.md']});
  const acknowledge=captureBaseFilterAcknowledgement(root);acknowledge();root.children.splice(0,1);
  assert.equal(readBaseFilterDraft(root),undefined,'Explicit removal clears the now nonempty accepted group');
});
test('an implicit single condition must become an explicit NOT group when its conjunction changes',()=>{
  const root=createBaseFilterDraft('file.hasProperty("status")');root.conjunction='not';
  assert.deepEqual(readBaseFilterDraft(root),{not:['file.hasProperty("status")']});
});
