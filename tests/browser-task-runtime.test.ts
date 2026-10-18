import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserCoreRuntime} from '../src/platform/browser-core-runtime.ts';

/** This worker double verifies admission/RPC/lifetime wiring only. Rust task
 * semantics are covered separately by the WASM and actual browser fixtures. */
test('normal browser runtime advertises Tasks and bounds/captures requests before queued RPC',async()=>{
  const originals=new Map(['Worker','document','location'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const calls:any[]=[];let blocked:any,worker:any;
  class FixtureWorker {
    onmessage?: (event:any)=>void;
    constructor(){worker=this;}
    postMessage(message:any){calls.push(message);if(message.operation==='inventory'){blocked=message;return;}
      queueMicrotask(()=>this.onmessage?.({data:{id:message.id,ok:true,result:message.operation==='open'?{authorityId:'12345678-1234-4123-8123-123456789abc',recovery:[],documentIndexAvailable:true}:undefined}}));}
    terminate(){}
  }
  let runtime:BrowserCoreRuntime|undefined;
  try{
    Object.defineProperty(globalThis,'Worker',{configurable:true,value:FixtureWorker});
    Object.defineProperty(globalThis,'document',{configurable:true,value:{addEventListener(){},removeEventListener(){},visibilityState:'visible'}});
    Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'https://zorid.test/',origin:'https://zorid.test'}});
    runtime=await BrowserCoreRuntime.open({database:'zorid-core-vault:tasks',clientId:'22222222-2222-4222-8222-222222222222',wasmModuleUrl:'/core.js',allowNewVault:true});
    const index=runtime.documentIndex!;assert.equal(typeof index.tasks,'function');
    const first=runtime.inventory();await new Promise<void>(resolve=>queueMicrotask(resolve));
    const input={pinId:'pin-1',typeIds:['type-file'],options:{filter:'today' as const,clockMs:0,timezone:'America/Toronto'}};
    const read=index.tasks(input);input.typeIds[0]='changed';input.options.clockMs=99;
    const before=calls.length;
    for(const value of [{...input,typeIds:Array.from({length:129},(_,i)=>'x'+i)},{...input,typeIds:['x','x']},{...input,options:{timezone:'x'.repeat(129)}},{...input,options:{configuration:{}}}])await assert.rejects(index.tasks(value as any),{code:'index_invalid_request'});
    assert.equal(calls.length,before,'invalid Tasks requests never reach postMessage');
    assert.ok(blocked);worker.onmessage({data:{id:blocked.id,ok:true,result:[]}});await first;await read;
    const task=calls.find(c=>c.operation==='document-index-tasks');assert.deepEqual(task.payload,{pinId:'pin-1',typeIds:['type-file'],options:{filter:'today',clockMs:0,timezone:'America/Toronto'}});
    runtime.close();await assert.rejects(index.tasks({pinId:'pin-1',typeIds:['type-file']}),{code:'storage_closed'});
  }finally{
    runtime?.close();for(const[key,descriptor]of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
  }
});
