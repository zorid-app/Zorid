import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserCoreRuntime } from '../src/platform/browser-core-runtime.ts';

test('worker runtime gates recovered commands until exact outcome acknowledgement and scopes opening identity', async () => {
  const originals = new Map(['Worker','document','location'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const calls: any[] = [];
  let terminated = false;
  class FixtureWorker {
    onmessage?: (event:any)=>void;
    postMessage(message:any) {
      calls.push(message);
      queueMicrotask(() => this.onmessage?.({data:{id:message.id,ok:true,result:message.operation==='open'?{authorityId:'12345678-1234-4123-8123-123456789abc',recovery:['old-intent']}:message.operation==='execute'?'original-receipt':undefined}}));
    }
    terminate() { terminated = true; }
  }
  try {
    Object.defineProperty(globalThis,'Worker',{configurable:true,value:FixtureWorker});
    Object.defineProperty(globalThis,'document',{configurable:true,value:{addEventListener(){},removeEventListener(){},visibilityState:'visible'}});
    Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'https://zorid.test/',origin:'https://zorid.test'}});
    const runtime = await BrowserCoreRuntime.open({database:'zorid-core-vault:explicit',clientId:'stable-tab-incarnation',
      wasmModuleUrl:'/assets/core.js',allowNewVault:true});
    assert.equal(calls[0].payload.clientId,'stable-tab-incarnation');
    assert.deepEqual(runtime.durableScope,{vaultId:'12345678-1234-4123-8123-123456789abc',clientId:'stable-tab-incarnation'});
    await assert.rejects(runtime.execute('new-intent','{}'),{code:'recovery_required'});
    assert.equal(calls.length,1,'gate sends no fresh mutation to worker');
    assert.equal(await runtime.execute('old-intent','original-json'),'original-receipt');
    assert.deepEqual(calls[1].payload,{intentId:'old-intent',requestJson:'original-json'});
    await runtime.acknowledge('old-intent',{status:'committed',receipt:'original-receipt'});
    const beforePrepare = calls.length;
    await runtime.prepare('new-intent','new-json');
    assert.equal(calls.length,beforePrepare+1);
    assert.equal(calls.at(-1).operation,'prepare','persisting a token does not authorize execution');
    await runtime.commit('new-intent');
    assert.equal(calls.at(-2).payload.intentId,'new-intent');
    const checkpoint={key:'draft',expectedRevision:null,nextRevision:'01234567-89ab-4cde-8123-0123456789ab',encodedState:'x'.repeat(32*1024*1024)};
    const beforeCheckpoint=calls.length;
    await assert.rejects(runtime.checkpoints!.compareAndSwap({...checkpoint,encodedState:checkpoint.encodedState+'x'}),{code:'checkpoint_too_large'});
    await assert.rejects(runtime.checkpoints!.compareAndSwap({...checkpoint,encodedState:'\ud800'}),{code:'checkpoint_too_large'});
    assert.equal(calls.length,beforeCheckpoint,'invalid checkpoint bodies never reach postMessage/structured clone');
    await runtime.checkpoints!.compareAndSwap(checkpoint);
    assert.equal(calls.at(-1).operation,'checkpoint-cas');
    assert.equal(calls.at(-1).payload.encodedState.length,32*1024*1024,'exact limit reaches transport unchanged');
    runtime.close(); assert.equal(terminated,true);
    await assert.rejects(runtime.intents(),{code:'storage_closed'});
  } finally {
    for (const [key,descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis,key,descriptor); else Reflect.deleteProperty(globalThis,key);
    }
  }
});
