import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import type {DesktopBridge} from '../src/platform/bridge';
import {createDesktopDurableTransport} from '../src/platform/desktop-durable-transport.ts';
import {createPlatformAdapter} from '../src/platform/index.ts';

// Simulate contextBridge copying plain data and stripping custom Error fields.
function preload(invoke:(...args:any[])=>Promise<unknown>){
  let exposed:any;const calls:any[][]=[];
  const context=vm.createContext({require(name:string){assert.equal(name,'electron');return{
    contextBridge:{exposeInMainWorld(_name:string,value:unknown){exposed=value;}},webUtils:{},
    ipcRenderer:{async invoke(...args:any[]){calls.push(structuredClone(args));return copyIntoPreload(await invoke(...args));}},
  };}});
  // A realm-local plain-data copy retains undefined fields and binary bytes.
  // This models the boundary; actual Electron acceptance remains separate.
  function copyIntoPreload(value:any):any{
    if(value===null||typeof value!=='object')return value;
    if(value instanceof Uint8Array){const bytes=vm.runInContext(`new Uint8Array(${value.length})`,context);bytes.set(value);return bytes;}
    const copy=vm.runInContext(Array.isArray(value)?'[]':'({})',context);
    for(const key of Object.keys(value))Object.defineProperty(copy,key,{value:copyIntoPreload(value[key]),enumerable:true,writable:true,configurable:true});
    return copy;
  }
  vm.runInContext(fs.readFileSync(new URL('../desktop/preload.cjs',import.meta.url),'utf8'),context);
  const bridge=new Proxy({...exposed},{get(target,key){const value=Reflect.get(target,key);if(typeof value!=='function')return value;
    return async(...args:unknown[])=>{try{return structuredClone(await value(...copyIntoPreload(args)));}catch(error){throw new Error((error as Error).message);}};
  }}) as DesktopBridge;
  return{bridge,calls,raw:exposed,evaluate:(source:string)=>vm.runInContext(source,context)};
}

test('generic checkpoint failure crosses actual preload as plain data with renderer-owned error fields',async()=>{
  const f=preload(async()=>({ok:false,error:{code:'checkpoint_storage',commitUncertain:true}}));
  await assert.rejects(f.bridge.durableInvoke!('/vault','admission','checkpoints.compareAndSwap',[{}]),error=>{
    assert.equal((error as any).code,undefined,'legacy Error loses its custom fields');return true;
  });
  const transport=createDesktopDurableTransport(f.bridge);
  await assert.rejects(transport.durableInvoke!('/vault','admission','checkpoints.compareAndSwap',[{}]),error=>{
    assert.ok(error instanceof Error);assert.equal((error as any).code,'checkpoint_storage');
    assert.equal((error as any).source,'host');assert.equal((error as any).commitUncertain,true);return true;
  });
});

for(const code of ['checkpoint_storage','filesystem_io','transport_io','host_timeout','host_exited'])test(`native ${code} and uncertainty survive the bridge`,async()=>{
  for(const commitUncertain of [false,true]){
    const f=preload(async()=>({ok:false,error:{code,commitUncertain}}));
    await assert.rejects(createDesktopDurableTransport(f.bridge).durableInvoke!('/vault','admission','commit',[{}]),error=>{
      assert.equal((error as any).code,code);assert.equal((error as any).commitUncertain,commitUncertain);assert.equal((error as any).source,'host');return true;
    });
  }
});

test('IPC failure is sanitized transport uncertainty, not authoritative host retirement',async()=>{
  const f=preload(async()=>{throw Object.assign(Error('/private/vault/secret'),{code:'host_exited',commitUncertain:true});});
  await assert.rejects(createDesktopDurableTransport(f.bridge).durableInvoke!('/vault','admission','commit',[{}]),error=>{
    assert.equal((error as any).code,'durable_transport_lost');assert.equal((error as any).source,'transport');assert.equal((error as any).commitUncertain,true);
    assert.doesNotMatch((error as Error).message,/private|secret/);return true;
  });
});

test('context, recovery, release and successful generic values use only their existing IPC routes',async()=>{
  const values=[null,{admissionId:'replacement',scope:{vaultId:'v',clientId:'c'}},undefined,{entryId:'e',content:'Exact saved text'}];
  const f=preload(async()=>({ok:true,result:values.shift()})),transport=createDesktopDurableTransport(f.bridge);
  assert.equal(await transport.getDurableContext!('/vault'),null);
  assert.equal((await transport.recoverDurableContext!('/vault','prior')).admissionId,'replacement');
  assert.equal(await transport.releaseDurableContext!('/vault','prior'),undefined);
  assert.deepEqual(await transport.durableInvoke!('/vault','prior','readText',['One.md']),{entryId:'e',content:'Exact saved text'});
  assert.deepEqual(f.calls.map(row=>row.slice(0,3)),[['zorid:getDurableContext','/vault'],['zorid:recoverDurableContext','/vault','prior'],['zorid:releaseDurableContext','/vault','prior'],['zorid:durableInvoke','/vault','prior']]);
});

test('new renderer retains old bridge behavior and dynamic legacy recovery capability',async()=>{
  const expected=Object.assign(Error('Legacy error'),{code:'legacy'});let admission='old';
  const bridge={durableInvoke:async()=>{throw expected;},recoverDurableContext:async()=>({admissionId:admission})} as unknown as DesktopBridge;
  const transport=createDesktopDurableTransport(bridge);
  await assert.rejects(transport.durableInvoke!('/vault','a','commit',[]),error=>error===expected);
  bridge.recoverDurableContext=async()=>({admissionId:'new'}) as any;admission='ignored';
  assert.equal((await transport.recoverDurableContext!('/vault','a')).admissionId,'new');
  assert.equal(transport.getDurableContext,undefined);
});

test('conditional saved-source rejection keeps its bounded factual message only for its definitive guard',async()=>{
  for(const method of ['captureSavedSource','releaseSavedSource','listSavedSourceRequests','commit'])for(const commitUncertain of [false,true]){
    const f=preload(async()=>({ok:false,error:{code:'conditional_source_changed',commitUncertain}}));
    await assert.rejects(createDesktopDurableTransport(f.bridge).durableInvoke!('/vault','a',method,[{}]),error=>{
      assert.equal((error as any).code,'conditional_source_changed');
      assert.equal((error as Error).message.includes('file changed or was replaced'),method!=='commit'&&!commitUncertain);return true;
    });
  }
});

test('shared source-capture capacity crosses the real preload with host provenance and exact code',async()=>{
  for(const method of ['captureSavedSource','releaseSavedSource','listSavedSourceRequests']){
    const f=preload(async()=>({ok:false,error:{code:'source_capture_capacity',commitUncertain:false}}));
    await assert.rejects(createDesktopDurableTransport(f.bridge).durableInvoke!('/vault','admission',method,[]),error=>{
      assert.equal((error as any).code,'source_capture_capacity');assert.equal((error as any).source,'host');assert.equal((error as any).commitUncertain,false);return true;
    });
  }
});

test('malformed main failures never forward private extra fields or pretend to be host errors',async()=>{
  const invalid=[null,{ok:false,error:{code:'checkpoint_storage',commitUncertain:true,path:'/secret'}},
    {ok:false,error:{code:'host_exited'}},{ok:false,error:{code:'host_exited',commitUncertain:'true'}},
    {ok:false,error:{code:'bad/path',commitUncertain:true}},{ok:true}, {ok:1,result:4},
    {ok:false,error:{code:'host_exited',commitUncertain:true},extra:1}];
  for(const reply of invalid){
    const f=preload(async()=>reply);
    await assert.rejects(createDesktopDurableTransport(f.bridge).durableInvoke!('/vault','a','query',[{}]),error=>{
      assert.equal((error as any).code,'invalid_durable_response');assert.equal((error as any).source,'protocol');assert.equal('path' in (error as any),false);return true;
    });
  }
});

test('renderer rejects malformed, inherited, accessor and extra-field DTOs without trusting their code',async()=>{
  let accessed=0;const valid={durableError:true,schemaVersion:1,error:{code:'host_exited',commitUncertain:true,source:'host'}};
  const accessor={...valid};Object.defineProperty(accessor,'error',{enumerable:true,get(){accessed++;return valid.error;}});
  const cases=[{...valid,extra:1},{...valid,schemaVersion:2},{...valid,durableError:false},{...valid,error:{...valid.error,extra:'secret'}},
    {...valid,error:{...valid.error,source:'unknown'}},Object.create(valid),accessor,{...valid,error:Object.assign(Object.create({}),valid.error)},
    Object.assign({...valid},{[Symbol('extra')]:1})];
  for(const value of cases){
    const transport=createDesktopDurableTransport({durableRequest:async()=>value} as unknown as DesktopBridge);
    await assert.rejects(transport.durableInvoke!('/vault','a','commit',[]),error=>{
      assert.equal((error as any).code,'invalid_durable_response');assert.equal((error as any).source,'protocol');return true;
    });
  }
  assert.equal(accessed,0);
});

test('preload rejects unlisted routes and malformed request records before IPC',async()=>{
  const f=preload(async()=>({ok:true,result:1}));
  for(const expression of [
    "({kind:'arbitrary',vault:'/vault',admissionId:'a'})",
    "({kind:'invoke',vault:'/vault',admissionId:'a',method:'write',args:[]})",
    "({kind:'invoke',vault:'/vault',admissionId:'a',method:'commit',args:[1,2,3]})",
    "({kind:'context',vault:'/vault',extra:1})",
    "Object.assign(Object.create({}),{kind:'context',vault:'/vault'})",
    "({get kind(){throw Error('must not access')},vault:'/vault'})",
    "({kind:'release',vault:'/vault',admissionId:''})",
    "({kind:'context',vault:'/vault',[Symbol('extra')]:true})",
  ]){
    const result=await f.raw.durableRequest(f.evaluate(expression));
    assert.equal(result.error.code,'invalid_durable_request');assert.equal(result.error.source,'protocol');
  }
  assert.equal(f.calls.length,0);
});

test('current admitted generic, checkpoint, document and binary methods are all routed',async()=>{
  const methods=['readText','readTextById','composeNote','planWrite','prepare','commit','query','listUnacknowledged','acknowledge',
    'checkpoints.load','checkpoints.compareAndSwap','checkpoints.list','checkpoints.changes','createText','createTextReceipt','fileCommand',
    'captureSavedSource','releaseSavedSource','listSavedSourceRequests','databaseCommand','workblockCommand','documentCommand','documentDrafts','binaryCommand',
    'documentRuntimeObserve','documentRuntimeControl','documentRuntimeAckControl','documentRuntimeAckOutcome'];
  const f=preload(async()=>({ok:true,result:'accepted'})),transport=createDesktopDurableTransport(f.bridge);
  for(const method of methods)await transport.durableInvoke!('/vault','a',method,[]);
  assert.deepEqual(f.calls.map(row=>row[3]),methods);
  assert.ok(f.calls.every(row=>row[0]==='zorid:durableInvoke'));
});

test('binary request and raw success preserve their actual bytes through the new preload route',async()=>{
  const f=preload(async(_channel,_vault,_admission,method,args)=>{
    assert.equal(method,'binaryCommand');assert.deepEqual([...args[0]],[0,127,255]);
    return{ok:true,result:new Uint8Array([255,1,0])};
  });
  const result=await createDesktopDurableTransport(f.bridge).durableInvoke!('/vault','a','binaryCommand',[new Uint8Array([0,127,255])]);
  assert.ok(result instanceof Uint8Array);assert.deepEqual([...result],[255,1,0]);
});

test('a missing or malformed optional capability fails closed without silently invoking legacy write',async()=>{
  let legacyCalls=0;
  for(const capability of [null,1,'unsupported']){
    const transport=createDesktopDurableTransport({durableRequest:capability,durableInvoke:async()=>{legacyCalls++;}} as unknown as DesktopBridge);
    await assert.rejects(transport.durableInvoke!('/vault','a','commit',[]),error=>{
      assert.equal((error as any).code,'invalid_durable_response');assert.equal((error as any).source,'protocol');return true;
    });
  }
  assert.equal(legacyCalls,0);
});

test('existing domain envelopes are identical through legacy and new route, including IPC loss',async()=>{
  for(const method of ['databaseCommand','planWrite','workblockCommand','documentRuntimeObserve','documentRuntimeControl','documentRuntimeAckControl','documentRuntimeAckOutcome','documentCommand','documentDrafts','binaryCommand']){
    for(const outcome of ['success','failure','lost']){
      const f=preload(async()=>{if(outcome==='lost')throw Error('private IPC detail');return outcome==='success'?{ok:true,result:{documents:true,schemaVersion:1,ok:false,error:{code:'search_compile',commitUncertain:false,details:{diagnostic:'bounded'}}}}:{ok:false,error:{code:'host_exited',commitUncertain:true}};});
      const compare=async(action:()=>Promise<unknown>)=>{try{return{value:await action()};}catch(error){return{message:(error as Error).message};}};
      const legacy=await compare(()=>f.bridge.durableInvoke!('/vault','a',method,[]));
      const current=await compare(()=>createDesktopDurableTransport(f.bridge).durableInvoke!('/vault','a',method,[]));
      if(['documentCommand','documentDrafts','binaryCommand'].includes(method)&&outcome!=='success')continue; // Generic error transport is deliberately upgraded.
      assert.deepEqual(current,legacy,`${method}/${outcome}`);
    }
  }
});

test('desktop platform durable writes negotiate the plain failure route',async t=>{
  const f=preload(async channel=>channel==='zorid:getVault'?{path:'/vault',name:'Fixture'}:
    channel==='zorid:getDurableContext'?{ok:true,result:{admissionId:'admission',scope:{vaultId:'vault-id',clientId:'client-id'}}}:
    {ok:false,error:{code:'filesystem_io',commitUncertain:false}});
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window');
  Object.defineProperty(globalThis,'window',{configurable:true,value:{zorid:{...f.bridge,onDocumentRuntimeNudge:undefined}}});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');});
  const platform=(await createPlatformAdapter())!;
  await assert.rejects(platform.adapter.durableWrites!.readText('One.md'),error=>{
    assert.equal((error as any).code,'filesystem_io');assert.equal((error as any).source,'host');return true;
  });
});
