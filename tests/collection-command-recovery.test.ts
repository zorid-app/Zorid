import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createPlatformAdapter} from '../src/platform/index.ts';
import {mountSourceChooser} from '../src/databases/collection-ui.ts';
import type {DatabaseRequest,DesktopDatabaseRequest} from '../src/core/databases.ts';

const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(check:()=>boolean){for(let i=0;i<60&&!check();i++)await tick();assert.ok(check());}
const response=(collections:unknown[]=[],entries:unknown[]=[])=>({databases:true,schemaVersion:1,ok:true,value:{collections,entries,projection:{pending:0,issues:[]}}});
async function fixture(t:TestContext){
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window'),dom=new JSDOM('<!doctype html><main></main>',{url:'https://zorid.test/'}),requests:DesktopDatabaseRequest[]=[],scope={vaultId:'collection-store',clientId:'collection-client'};let mutations=0;
  const bridge={getVault:async()=>({path:'/collection-recovery',name:'Collection recovery'}),getDurableContext:async()=>({admissionId:'same-admission',scope,databases:true}),releaseDurableContext:async()=>{},onChange:()=>()=>{},
    durableInvoke:async(_root:string,admission:string,method:string,args:unknown[])=>{
      assert.equal(admission,'same-admission');assert.equal(method,'databaseCommand');const request=structuredClone(args[0]) as DesktopDatabaseRequest;requests.push(request);
      const command=request.command;if(command.op==='list')return response();
      if(++mutations===1)return{databases:true,schemaVersion:1,ok:false,error:{code:'storage_busy',source:'host',commitUncertain:false}};
      if(command.op==='create')return response([{id:'abcdefghijkl',name:command.name,revision:'collection-1',deleted:false,properties:[]}]);
      if(command.op==='set_entry')return response([{id:'abcdefghijkl',name:'Notes',revision:'collection-before',deleted:false,properties:[]}],[{entryId:command.entryId,collectionId:'abcdefghijkl',revision:'entry-after',fileRevision:'file-after',path:'One.md',values:command.values,deleted:false,pendingProjection:false}]);
      assert.fail('Unexpected command '+command.op);
    }};
  Object.assign(dom.window,{zorid:bridge});Object.defineProperty(globalThis,'window',{configurable:true,value:dom.window});
  const platform=(await createPlatformAdapter())!,host=dom.window.document.querySelector('main')!;t.after(async()=>{await platform.release?.();dom.window.close();if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');});
  return{dom,host,platform,requests,get mutations(){return mutations;}};
}

test('real collection chooser stays pending through a trusted same-admission temporary create failure and automatically continues its original command',async t=>{
  const f=await fixture(t),chosen:unknown[]=[];t.mock.timers.enable({apis:['setTimeout']});const chooser=mountSourceChooser(f.host,{service:f.platform.databases!,isCurrent:()=>true,choose:async source=>{chosen.push(source);}});t.after(()=>chooser.destroy());
  const create=[...f.host.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='New empty data source')!;create.click();await until(()=>f.mutations===1);await tick();
  assert.equal(chooser.element.getAttribute('aria-busy'),'true','A trusted temporary command failure must not expose Retry or unlock a new operation');assert.equal(f.host.querySelector<HTMLElement>('[role="alert"]')!.hidden,true);assert.doesNotMatch(create.textContent!,/Retry/);
  t.mock.timers.tick(500);await until(()=>chosen.length===1);const creates=f.requests.filter(request=>request.command.op==='create');assert.equal(creates.length,2);assert.deepEqual(creates[1],creates[0]);assert.deepEqual(chosen,[{kind:'collection',id:'abcdefghijkl'}]);assert.equal(chooser.hasPendingChanges(),false);
});

test('same-admission set_entry retains its original outer promise instead of rejecting into the property widget',async t=>{
  const f=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});const command:DatabaseRequest={op:'set_entry',operationId:crypto.randomUUID(),entryId:'entry-one',expectedRevision:'entry-before',expectedCollectionRevision:'collection-before',values:{rating000001:9}};let rejected=false;
  const pending=f.platform.databases!.request(command);void pending.catch(()=>{rejected=true;});await until(()=>f.mutations===1);await tick();assert.equal(rejected,false,'Typed Native busy must retain the exact admitted promise through automatic backoff');
  t.mock.timers.tick(500);const saved=await pending;assert.equal(saved.entries[0].values.rating000001,9);assert.equal(f.mutations,2);assert.deepEqual(f.requests[1],f.requests[0]);
});
