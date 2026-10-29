import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {BaseEmbedSessions} from '../src/ui/base-embed-sessions.ts';
import type {BaseSession} from '../src/bases/session.ts';

const target=()=>({sourcePath:'Source.md',targetPath:'Recovery.base',viewName:'Table',targetIdentity:Symbol('base'),sourceIdentity:Symbol('source'),occurrence:{}});
function session(root:HTMLElement){
 const input=root.ownerDocument.createElement('input');input.value='9';root.append(input);let pending=true,eligible=true,failed=false,prepared=0,settled=0,closed=0;
 const capsule={async settle(){settled++;if(failed)throw Error('Same operation remains unresolved');pending=false;}};
 const value:BaseSession={ready:Promise.resolve(),state:{version:0,source:'',result:null,error:null},async refresh(){},async selectView(){},hasPendingChanges:()=>pending,async flush(){if(pending)throw Error('Unfinished draft');},async close(){await this.flush();closed++;root.remove();},
  canRecoverAdmission:()=>eligible,prepareAdmissionRecovery(){assert.equal(eligible,true);prepared++;return capsule;}};
 return{value,input,get prepared(){return prepared;},get settled(){return settled;},get closed(){return closed;},eligible(value:boolean){eligible=value;},fail(value:boolean){failed=value;},clear(){pending=false;}};
}

test('embedded Base recovery prepares every retained owner and preserves DOM through a failed settlement',async()=>{
 const dom=new JSDOM('<main></main><aside></aside>'),doc=dom.window.document,views:ReturnType<typeof session>[]=[];
 const manager=new BaseEmbedSessions({recoveryHost:doc.body,create(root){const view=session(root);views.push(view);return view.value;}});
 const first=manager.mount(target(),doc.querySelector('main')!),second=manager.mount(target(),doc.querySelector('aside')!);await Promise.all([first.ready,second.ready]);first.detach();
 try{
  assert.equal(manager.canRecoverAdmission(),true);const capsule=manager.prepareAdmissionRecovery();assert.equal(manager.prepareAdmissionRecovery(),capsule);assert.deepEqual(views.map(view=>view.prepared),[1,1]);
  assert.throws(()=>manager.mount(target(),doc.body),/closing/);views[0].fail(true);await assert.rejects(capsule.settle(),/Same operation remains unresolved/);
  assert.deepEqual(views.map(view=>view.settled),[1,1],'one failure does not strand the other accepted edit');assert.ok(views[0].input.isConnected);assert.equal(views[0].input.value,'9');assert.deepEqual(views.map(view=>view.closed),[0,0]);
  views[0].fail(false);await capsule.settle();assert.equal(manager.hasPendingChanges(),false);await manager.close();assert.deepEqual(views.map(view=>view.closed),[1,1]);
 }finally{for(const view of views)view.clear();await manager.close();dom.window.close();}
});

for(const clean of [false,true])test(`an unrelated ${clean?'clean but unavailable owner':'raw embedded draft'} prevents all preparation without losing either widget`,async()=>{
 const dom=new JSDOM('<main></main><aside></aside>'),doc=dom.window.document,views:ReturnType<typeof session>[]=[];
 const manager=new BaseEmbedSessions({recoveryHost:doc.body,create(root){const view=session(root);views.push(view);return view.value;}});
 await manager.mount(target(),doc.querySelector('main')!).ready;await manager.mount(target(),doc.querySelector('aside')!).ready;views[1].eligible(false);if(clean)views[1].clear();
 try{assert.equal(manager.canRecoverAdmission(),false);assert.throws(()=>manager.prepareAdmissionRecovery(),/drafts are retained/);assert.deepEqual(views.map(view=>view.prepared),[0,0]);assert.equal(manager.hasPendingChanges(),true);assert.ok(views.every(view=>view.input.isConnected&&view.input.value==='9'));}
 finally{for(const view of views)view.clear();await manager.close();dom.window.close();}
});

test('an unresolved embedded session cannot authorize recovery preparation',async()=>{
 const dom=new JSDOM('<main></main>'),doc=dom.window.document;let finish!:()=>void,view:ReturnType<typeof session>|undefined;const held=new Promise<void>(resolve=>{finish=resolve;});
 const manager=new BaseEmbedSessions({recoveryHost:doc.body,async create(root){await held;view=session(root);return view.value;}}),binding=manager.mount(target(),doc.querySelector('main')!);
 try{assert.equal(manager.canRecoverAdmission(),false);assert.throws(()=>manager.prepareAdmissionRecovery(),/drafts are retained/);}
 finally{finish();await binding.ready;view!.clear();await manager.close();dom.window.close();}
});

for(const repairing of [false,true])test(`a detached finishing owner ${repairing?'stays out of error recovery when its admission was prepared':'retains ordinary failure recovery'}`,async()=>{
 const dom=new JSDOM('<main></main>'),doc=dom.window.document;let view!:ReturnType<typeof session>,entered=false,reject!:()=>void;
 const manager=new BaseEmbedSessions({recoveryHost:doc.body,create(root){view=session(root);return view.value;}}),binding=manager.mount(target(),doc.querySelector('main')!);await binding.ready;view.clear();binding.detach();assert.equal(view.input.isConnected,false);
 const close=view.value.close;view.value.close=async()=>{entered=true;await new Promise<void>((_resolve,fail)=>{reject=()=>fail(Error('Original owner close failed'));});};
 const closing=manager.close();void closing.catch(()=>{});for(let n=0;n<100&&!entered;n++)await new Promise(resolve=>setTimeout(resolve,2));assert.equal(entered,true);let capsule:ReturnType<BaseEmbedSessions['prepareAdmissionRecovery']>|undefined;
 try{if(repairing){assert.equal(manager.canRecoverAdmission(),true);capsule=manager.prepareAdmissionRecovery();}reject();await assert.rejects(closing,/Original owner close failed/);assert.equal(view.input.isConnected,!repairing);assert.equal(doc.querySelector<HTMLElement>('.base-embed-recovery')!.hidden,repairing);assert.equal(view.closed,0);}
 finally{reject();view.value.close=close;view.clear();await capsule?.settle();await manager.close();dom.window.close();}
});
