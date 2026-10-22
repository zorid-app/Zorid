import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlatformAdapter } from '../src/platform/index.ts';

test('captured desktop creation retains original command identity and validates its original receipt after lost ACK', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const calls: any[] = []; let lose = true;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { zorid: {
    getVault: async () => ({ path: '/fixture', name: 'Fixture' }),
    getDurableContext: async () => ({ admissionId: 'admitted', scope: { vaultId: 'authority', clientId: 'client' }, textCreateReceiptsAvailable: true }),
    releaseDurableContext: async () => {},
    durableInvoke: async (_path: string, _admission: string, method: string, args: any[]) => {
      assert.equal(method, 'createTextReceipt'); const request = structuredClone(args[0]); calls.push(request);
      if (lose) throw Object.assign(new Error('lost ACK'), { code: 'host_timeout', commitUncertain: true });
      return { operation_id: request.operationId, sequence: '7', changes: [{ before: null, after: { id: request.entryId, path: request.path, kind: 'file', revision: 'created-revision', deleted: false } }] };
    },
  } } });
  try {
    const { adapter } = (await createPlatformAdapter())!, captured = adapter.captureTextCreate!('New.md', 'literal');
    await assert.rejects(captured.run(), /lost ACK/); lose = false;
    const receipt = await captured.run(); assert.deepEqual(calls[0], calls[1]);
    assert.equal(receipt.entryId, captured.entryId); assert.equal(receipt.operationId, captured.operationId); assert.equal(receipt.revision, 'created-revision');
    await captured.run(); assert.equal(calls.length, 2);
  } finally { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); }
});

for (const lateOutcome of ['success', 'terminal rejection']) {
  test(`late duplicate ${lateOutcome} preserves a newer uncertain operation ID`, async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const calls: { request: any; resolve: () => void; reject: (error: unknown) => void }[] = [];
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { zorid: {
      getVault: async () => ({ path: '/fixture', name: 'Fixture' }),
      getDurableContext: async () => ({ admissionId: 'admitted', scope: { vaultId: 'authority', clientId: 'client' } }),
      releaseDurableContext: async () => {},
      durableInvoke: (_path: string, _admission: string, method: string, args: unknown[]) => {
        assert.equal(method, 'fileCommand');
        return new Promise<void>((resolve, reject) => calls.push({ request: args[0], resolve, reject }));
      },
    } } });
    try {
      const { adapter } = (await createPlatformAdapter())!;
      const first = adapter.write('Note.md', 'A');
      const duplicate = adapter.write('Note.md', 'A');
      assert.equal(calls[0].request.operationId, calls[1].request.operationId);
      calls[0].resolve(); await first;
      const next = adapter.write('Note.md', 'B');
      const nextId = calls[2].request.operationId;
      assert.notEqual(nextId, calls[0].request.operationId);
      if (lateOutcome === 'success') { calls[1].resolve(); await duplicate; }
      else {
        const rejected = assert.rejects(duplicate, { code: 'revision_conflict' });
        calls[1].reject(Object.assign(new Error('Old request rejected'), { code: 'revision_conflict', commitUncertain: false }));
        await rejected;
      }
      const uncertain = assert.rejects(next, { code: 'host_timeout' });
      calls[2].reject(Object.assign(new Error('ACK unknown'), { code: 'host_timeout', commitUncertain: true }));
      await uncertain;
      const retry = adapter.write('Note.md', 'B');
      calls[3].resolve(); await retry;
      assert.equal(calls[3].request.operationId, nextId);
      assert.equal(calls[3].request.entryId, calls[2].request.entryId);
    } finally {
      if (previous) Object.defineProperty(globalThis, 'window', previous);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });
}

test('desktop reconciliation status catches subscription gaps and remains scoped through retry',async()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window');
  const initial={scanId:'startup',complete:true,scanComplete:true,finished:true,observed:0,imported:0,namespaceApplied:0,issueCount:0,issuesTruncated:false,issues:[]};
  const pending={...initial,scanId:'pending',complete:false,scanComplete:false,issueCount:1,issues:[{path:null,code:'scan_limit'}]};
  let listener:(change:any)=>void=()=>{},stops=0,reads=0;
  Object.defineProperty(globalThis,'window',{configurable:true,value:{zorid:{
    getVault:async()=>({path:'/fixture',name:'Fixture',reconciliation:reads++?pending:initial}),
    onChange:(next:(change:any)=>void)=>{listener=next;return ()=>{stops++;};},
    retryReconciliation:async(root:string)=>{assert.equal(root,'/fixture');return initial;},
  }}});
  try {
    const vault=(await createPlatformAdapter())!;const statuses:unknown[]=[];
    assert.equal(vault.reconciliation!.getStatus()!.complete,true);
    const stop=vault.reconciliation!.subscribe(status=>statuses.push(status));
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(vault.reconciliation!.getStatus()!.scanId,'pending');
    listener({vault:'/other',reconciliation:initial});assert.equal(statuses.length,1);
    listener({vault:'/fixture',reconciliation:{...pending,scanId:'current'}});assert.equal(vault.reconciliation!.getStatus()!.scanId,'current');
    await vault.reconciliation!.retry();assert.equal(vault.reconciliation!.getStatus()!.complete,true);
    stop();assert.equal(stops,1);
  } finally {if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');}
});

test('drained binary capability stays retired while exact context release is pending or unknown',async()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window');
  let failRelease!:(error:unknown)=>void,entered!:()=>void,releases=0,invocations=0;
  const releasing=new Promise<void>(resolve=>{entered=resolve;});
  Object.defineProperty(globalThis,'window',{configurable:true,value:{zorid:{
    getVault:async()=>({path:'/fixture',name:'Fixture'}),
    getDurableContext:async()=>({admissionId:'admitted',scope:{vaultId:'authority',clientId:'client'},binaryLimits:{maxFileBytes:'67108864',maxChunkBytes:131072,smallReadBytes:'16777216'}}),
    durableInvoke:async(_path:string,_admission:string,method:string)=>{invocations++;assert.equal(method,'checkpoints.list');return{items:[],cursor:null,highWater:'0'};},
    releaseDurableContext:async(path:string,admission:string)=>{assert.equal(path,'/fixture');assert.equal(admission,'admitted');if(++releases===1){entered();await new Promise<void>((_resolve,reject)=>{failRelease=reject;});}},
  }}});
  try {
    const platform=(await createPlatformAdapter())!,streams=platform.adapter.binaryStreams!;
    const release=platform.release!();await releasing;
    const before=invocations;
    await assert.rejects(streams.openRead({entryId:'entry'}),/context released/);
    const unknown=assert.rejects(release,/lost release/);failRelease(new Error('lost release'));await unknown;
    await assert.rejects(streams.openRead({entryId:'entry'}),/context released/);
    await platform.release!();assert.equal(releases,2);assert.equal(invocations,before);
  } finally {if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');}
});


test('desktop rename forwards the captured witness and preserves its exact uncertain retry',async()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window'),calls:any[]=[];let fail=true;
  Object.defineProperty(globalThis,'window',{configurable:true,value:{zorid:{
    getVault:async()=>({path:'/fixture',name:'Fixture'}),
    getDurableContext:async()=>({admissionId:'admitted',scope:{vaultId:'authority',clientId:'client'}}),
    releaseDurableContext:async()=>{},
    durableInvoke:async(_path:string,_admission:string,method:string,args:unknown[])=>{assert.equal(method,'fileCommand');calls.push(structuredClone(args[0]));if(fail)throw Object.assign(new Error('lost ACK'),{code:'host_timeout',commitUncertain:true});},
  }}});
  try{
    const {adapter}=(await createPlatformAdapter())!,expected={entryId:'selected',revision:'selected-revision'};
    const pending=adapter.rename('Note.md','Renamed.md',expected);expected.revision='replacement-revision';
    await assert.rejects(pending,{code:'host_timeout'});
    assert.equal(calls[0].expectedEntryId,'selected');assert.equal(calls[0].expectedRevision,'selected-revision');
    await assert.rejects(adapter.rename('Note.md','Renamed.md',expected),/different file operation/);
    await assert.rejects(adapter.rename('Note.md','Renamed.md'),/different file operation/);
    assert.equal(calls.length,1);fail=false;
    await adapter.rename('Note.md','Renamed.md',{entryId:'selected',revision:'selected-revision'});
    assert.deepEqual(calls[1],calls[0]);
  }finally{if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');}
});

test('legacy desktop rename cannot silently drop an expected identity',async()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window');let calls=0;
  Object.defineProperty(globalThis,'window',{configurable:true,value:{zorid:{
    getVault:async()=>({path:'/fixture',name:'Fixture'}),rename:async()=>{calls++;},
  }}});
  try{
    const {adapter}=(await createPlatformAdapter())!;
    await assert.rejects(adapter.rename('Note.md','Renamed.md',{entryId:'selected',revision:'selected-revision'}),{code:'revision_conflict'});
    assert.equal(calls,0);await adapter.rename('Note.md','Renamed.md');assert.equal(calls,1);
  }finally{if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');}
});

test('desktop bridge preserves pre-open metadata capability without granting it to legacy contexts',async()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window');
  try{
    for(const metadataRowsAvailable of [undefined,false,true]){
      let commands=0;
      Object.defineProperty(globalThis,'window',{configurable:true,value:{zorid:{getVault:async()=>({path:'/fixture',name:'Fixture'}),getDurableContext:async()=>({admissionId:'admitted',scope:{vaultId:'authority',clientId:'client'},documentSemantics:true,metadataRowsAvailable}),durableInvoke:async()=>{commands++;throw Error('No generation should open for capability discovery');},releaseDurableContext:async()=>{}}}});
      const platform=(await createPlatformAdapter())!;assert.equal(platform.documentSemantics!.metadataRowsAvailable===true,metadataRowsAvailable===true);assert.equal(commands,0);await platform.release!();
    }
    Object.defineProperty(globalThis,'window',{configurable:true,value:{zorid:{getVault:async()=>({path:'/fixture',name:'Fixture'}),getDurableContext:async()=>({admissionId:'admitted',scope:{vaultId:'authority',clientId:'client'},metadataRowsAvailable:true}),durableInvoke:async()=>{},releaseDurableContext:async()=>{}}}});
    await assert.rejects(createPlatformAdapter(),/Incomplete document metadata capability/);
  }finally{if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');}
});

test('desktop pre-open draft capability composes the same common service and retires before native release',async()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window');let observer=()=>{},retireObserver=()=>{},stops=0,releases=0,invocations=0,resolve!:(value:unknown)=>void;
  Object.defineProperty(globalThis,'window',{configurable:true,value:{zorid:{
    getVault:async()=>({path:'/fixture',name:'Fixture'}),
    getDurableContext:async()=>({admissionId:'admitted',scope:{vaultId:'authority',clientId:'client'},documentSemantics:true,documentMaintenance:true,draftsAvailable:true}),
    onDocumentRuntimeNudge:(path:string,admission:string,listener:()=>void,onRetire:()=>void)=>{assert.equal(path,'/fixture');assert.equal(admission,'admitted');observer=listener;retireObserver=onRetire;return()=>{stops++;};},
    durableInvoke:(_path:string,_admission:string,method:string,args:unknown[])=>{assert.equal(method,'documentDrafts');assert.deepEqual(args[0],{op:'snapshot'});invocations++;return new Promise<unknown>(yes=>{resolve=yes;});},
    releaseDurableContext:async()=>{releases++;},
  }}});
  try{
    const platform=(await createPlatformAdapter())!,drafts=platform.documentSemantics!.drafts!;assert.equal(platform.documentSemantics!.draftsAvailable,true);assert.equal(invocations,0);assert.equal(drafts,platform.adapter.documentSemantics!.drafts);
    let hints=0,retired=0;drafts.subscribe(()=>{hints++;},()=>{retired++;});observer();assert.equal(hints,1);
    const pending=drafts.snapshot(),rejected=assert.rejects(pending,{code:'client_not_admitted'}),release=platform.release!();await Promise.resolve();assert.equal(releases,0);assert.equal(retired,1);
    resolve({documentDrafts:true,schemaVersion:1,ok:true,value:{result:{state:null,transfer:null,transfer_scratch_bytes:0},bytes:new Uint8Array()}});await rejected;await release;assert.equal(releases,1);assert.equal(stops,1);retireObserver();assert.equal(retired,1);
  }finally{if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');}
});
test('positive desktop draft advertisement requires document semantics and scoped nudge channel before use',async()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window');
  try{for(const extra of [{documentSemantics:false},{documentSemantics:true}]){
    Object.defineProperty(globalThis,'window',{configurable:true,value:{zorid:{getVault:async()=>({path:'/fixture',name:'Fixture'}),getDurableContext:async()=>({admissionId:'admitted',scope:{vaultId:'authority',clientId:'client'},draftsAvailable:true,...extra}),durableInvoke:assert.fail,releaseDurableContext:async()=>{}}}});
    await assert.rejects(createPlatformAdapter(),/Incomplete document draft capability/);
  }}finally{if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');}
});
