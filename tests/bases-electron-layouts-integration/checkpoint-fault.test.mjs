import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {columnOrderSource,layoutNoteSurface,assertLayoutCheckpointDraft} from './checkpoint-fault.mjs';

const original='# Independent complete configuration sentinel\nviews:\n  - type: cards\n    name: Other\n    groupOrder: [Done, Todo, Later]\n  - type: kanban\n    name: Board\n    groupBy: { property: status, direction: ASC }\n    groupOrder:\n      - Done\n      - Todo\n      - Later\n    order: [ file.name, rank ]\n  - type: kanban\n    name: Computed board\n    groupOrder: [Done, Todo, Later]\n';
const desired='# Independent complete configuration sentinel\nviews:\n  - type: cards\n    name: Other\n    groupOrder: [Done, Todo, Later]\n  - type: kanban\n    name: Board\n    groupBy: { property: status, direction: ASC }\n    groupOrder:\n      - Todo\n      - Done\n      - Later\n    order: [ file.name, rank ]\n  - type: kanban\n    name: Computed board\n    groupOrder: [Done, Todo, Later]\n';
test('column source oracle authors only the exact known Board order bytes and preserves every other source byte',()=>{
  assert.equal(columnOrderSource(original),desired);
  const inline=original.replace('    groupOrder:\n      - Done\n      - Todo\n      - Later','    groupOrder: [ Done, Todo, Later ]');assert.equal(columnOrderSource(inline),desired);
  for(const wrong of [original.replaceAll('\n','\r\n'),original.replace('name: Board','name: Other board'),original.replace('name: Computed board','name: Board'),original.replace('      - Done\n      - Todo','      - Todo\n      - Done'),original.replace('      - Later\n    order:','      - Unexpected\n    order:'),original.replace('    order: [ file.name, rank ]','    groupOrder: [Done, Todo, Later]')])assert.throws(()=>columnOrderSource(wrong));
});

function note(mode='live',title='Alpha'){
  const body=mode==='live'?'<div class="editor-host"><div class="cm-content" contenteditable="true"></div></div>':'<div class="markdown-preview"></div>';
  return '<section class="pane is-active"><div class="tab is-active" data-tab-id="actual-tab"></div><button data-hotkey-command="toggle-reading" data-hotkey-name="'+(mode==='live'?'Switch to reading view':'Switch to Live Edit')+'"></button><div class="tab-view-content"><div class="note-scroll"><input class="note-title" value="'+title+'">'+body+'</div></div></section>';
}
test('ordinary note readiness observes the actual input value and its own mounted Reading or Live Edit surface',()=>{
  for(const mode of ['reading','live']){const dom=new JSDOM(note(mode));try{assert.equal(dom.window.document.querySelector('.inline-title'),null,'The removed contenteditable title is not a readiness contract');const ready=layoutNoteSurface(dom.window.document,'Alpha');assert.equal(ready.title,'Alpha');assert.equal(ready.mode,mode);assert.equal(ready.tabId,'actual-tab');}finally{dom.window.close();}}
});
test('wrong title, stale mode, nested preview, missing content and multiple active owners cannot admit navigation',()=>{
  const dom=new JSDOM(note());try{
    const d=dom.window.document,input=d.querySelector('.note-title');input.value='Wrong';input.textContent='Alpha';assert.equal(layoutNoteSurface(d,'Alpha'),false);input.value='Alpha';
    d.querySelector('button').dataset.hotkeyName='Switch to Live Edit';assert.equal(layoutNoteSurface(d,'Alpha'),false);
    d.querySelector('.editor-host').remove();d.querySelector('.note-scroll').insertAdjacentHTML('beforeend','<div class="nested"><div class="markdown-preview"></div></div>');assert.equal(layoutNoteSurface(d,'Alpha'),false,'An embedded preview cannot stand in for the ordinary note mode');
    d.querySelector('.nested').remove();d.querySelector('.note-scroll').insertAdjacentHTML('beforeend','<div class="markdown-preview"></div>');assert.equal(layoutNoteSurface(d,'Alpha').mode,'reading');
    d.body.insertAdjacentHTML('beforeend',note());assert.equal(layoutNoteSurface(d,'Alpha'),false);
  }finally{dom.window.close();}
});

function checkpoint(){
  const file='Layouts.base',original='Original whole source\n',desired='Exact retained whole source 😀\n',entry={id:'entry1',revision:'rev1',path:file,kind:'file',deleted:false},held={operationId:'op1',clientId:'client1'};
  const witness={entryId:entry.id,revision:entry.revision,path:file},input={operationId:held.operationId,path:file,expectedEntryId:entry.id,expectedRevision:entry.revision,expectedContent:original,content:desired,conditionalSavedSource:{captureId:'capture1',logicalWitness:witness}};
  const plan={version:1,clientId:held.clientId,entryId:entry.id,operationId:held.operationId,encodedPlan:JSON.stringify({operation_id:held.operationId,mutation:{type:'write',id:entry.id,expected:entry.revision},content_base64:Buffer.from(desired).toString('base64'),source_capture:'capture1'})};
  const state={version:1,base:{...witness,content:original},draft:desired,conflict:false,operation:{content:desired,input,plan}};
  return {expected:{file,original,desired,before:{entry:structuredClone(entry)},held},observation:{entry,source:original,checkpoints:[{clientId:held.clientId,state}],intents:[{operationId:held.operationId,state:'prepared',acknowledged:false}]}};
}
test('native recovery oracle preserves exact running-client base, draft, guard, plan and unauthorized prepared intent',()=>{
  const f=checkpoint(),result=assertLayoutCheckpointDraft(f.observation,f.expected);assert.equal(result.clientId,'client1');assert.equal(result.key,'note/v1/entry1');assert.deepEqual(result.draft,{base:f.expected.original,content:f.expected.desired});assert.equal(result.intent.state,'prepared');
});
test('native recovery oracle rejects foreign heads, changed logical state, altered source/guard/plan and premature authorization',()=>{
  const edits=[v=>v.entry.revision='new',v=>v.source='Changed',v=>v.checkpoints.push(structuredClone(v.checkpoints[0])),v=>v.checkpoints[0].clientId='foreign',v=>v.checkpoints[0].state.version=2,v=>v.checkpoints[0].state.base.content='Different base',v=>v.checkpoints[0].state.base.revision='new',v=>v.checkpoints[0].state.draft='Dropped draft',v=>v.checkpoints[0].state.conflict=true,v=>v.checkpoints[0].state.operation.content='Changed',v=>v.checkpoints[0].state.operation.plan.operationId='replacement',v=>v.checkpoints[0].state.operation.plan.clientId='foreign',v=>v.checkpoints[0].state.operation.ref={token:'already-checkpointed'},v=>v.checkpoints[0].state.operation.pendingAck={status:'committed'},v=>v.checkpoints[0].state.operation.input.expectedContent='Changed',v=>v.checkpoints[0].state.operation.input.conditionalSavedSource.logicalWitness.revision='foreign',v=>{const p=JSON.parse(v.checkpoints[0].state.operation.plan.encodedPlan);p.content_base64=Buffer.from('Wrong bytes').toString('base64');v.checkpoints[0].state.operation.plan.encodedPlan=JSON.stringify(p);},v=>v.intents[0].state='commit_requested',v=>v.intents[0].acknowledged=true,v=>v.intents=[]];
  for(const edit of edits){const f=checkpoint();edit(f.observation);assert.throws(()=>assertLayoutCheckpointDraft(f.observation,f.expected));}
});
