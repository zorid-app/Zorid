import test from 'node:test';
import assert from 'node:assert/strict';
import {Vault} from '../src/core/vault.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return{promise,resolve};};
class Adapter extends MemoryAdapter{calls:string[]=[];async createText(path:string,source:string){this.calls.push(path);if(await this.stat(path))throw Error('exists');await this.write(path,source);}}
async function held(){const adapter=new Adapter(),vault=new Vault(adapter);await vault.initialize();const started=deferred(),resume=deferred(),list=adapter.list.bind(adapter);let first=true;adapter.list=async()=>{if(first){first=false;started.resolve();await resume.promise;}return list();};return{adapter,vault,started,resume};}
test('queued create revalidates owner after refresh and before any durable dispatch',async()=>{
  const{adapter,vault,started,resume}=await held();let admitted=true;const events:string[]=[];vault.on('create',change=>events.push(change.path));
  const creating=vault.create('Captured.md','body',()=>{if(!admitted)throw Error('owner retired');});await started.promise;admitted=false;resume.resolve();await assert.rejects(creating,/owner retired/);assert.deepEqual(adapter.calls,[]);assert.deepEqual(events,[]);assert.equal(await adapter.stat('Captured.md'),null);
});
test('queued create does not switch to a replacement adapter after admission was captured',async()=>{
  const{adapter,vault,started,resume}=await held(),replacement=new Adapter();const creating=vault.create('Captured.md','body');await started.promise;vault.adapter=replacement;resume.resolve();await assert.rejects(creating,/adapter changed/);assert.deepEqual(adapter.calls,[]);assert.deepEqual(replacement.calls,[]);
});
test('optional validation remains synchronous adjacent to dispatch and ordinary callers remain compatible',async()=>{
  const adapter=new Adapter(),vault=new Vault(adapter);await vault.initialize();let checked=false,expired=false;const create=adapter.createText.bind(adapter);adapter.createText=async(path,source)=>{assert.equal(checked,true);assert.equal(expired,false);return create(path,source);};
  await vault.create('Captured.md','body',()=>{checked=true;queueMicrotask(()=>{expired=true;});});assert.equal(await adapter.read('Captured.md'),'body');assert.deepEqual(adapter.calls,['Captured.md']);
  adapter.createText=create;await vault.create('Ordinary.md','ordinary');assert.equal(await adapter.read('Ordinary.md'),'ordinary');
});
