import test from 'node:test';
import assert from 'node:assert/strict';
import { openBrowserClientSlot } from '../src/platform/browser-client-slots.ts';

const database = 'zorid-core-vault:default-v1';
const prefix = `zorid:client-slots:v1:${database}`;
const pointer = `${prefix}:preferred`;
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
function session() {
  const values = new Map<string,string>();
  return { values, getItem(key:string){return values.get(key) ?? null;},setItem(key:string,value:string){values.set(key,value);},removeItem(key:string){values.delete(key);} };
}
/** Deliberately small transaction fixture: writes are staged until completion and abort discards them.
 * This tests selection/lifecycle logic, not browser IndexedDB implementation conformance.
 */
function fixture() {
  let record:any, exists=false, failCommit=false, strict=true, puts=0;
  const transactions:any[]=[];
  const held = new Set<string>(), queues=new Map<string,Array<()=>void>>();
  const locks={request(name:string, options:LockOptions, callback:(lock:Lock|null)=>unknown) {
    return new Promise<any>((resolve,reject)=>{
      const run=()=>{
        if(held.has(name)) {
          if(options.ifAvailable){Promise.resolve().then(()=>callback(null)).then(resolve,reject);return;}
          const queue=queues.get(name)??[];queue.push(run);queues.set(name,queue);return;
        }
        held.add(name);
        Promise.resolve().then(()=>callback({name,mode:'exclusive'} as Lock)).then(resolve,reject).finally(()=>{
          held.delete(name);const queue=queues.get(name);const next=queue?.shift();if(!queue?.length)queues.delete(name);next?.();
        });
      };run();
    });
  }} as Pick<LockManager,'request'>;
  const factory={open(name:string,version:number) {
    assert.equal(name,`${database}:client-slots:v1`);assert.equal(version,1);
    const request:any={};
    const db:any={
      objectStoreNames:{length:1,contains(name:string){return name==='registry';}},close(){},
      createObjectStore(name:string){assert.equal(name,'registry');return {put(value:any,key:string){assert.equal(key,'state');record=structuredClone(value);}};},
      transaction(name:string,mode:string,options:any){
        assert.equal(name,'registry');assert.equal(mode,'readwrite');assert.deepEqual(options,{durability:'strict'});
        let aborted=false, staged:any, scheduled=false;
        const tx:any={durability:strict?'strict':'relaxed',
          abort(){if(aborted)return;aborted=true;queueMicrotask(()=>tx.onabort?.());},
          objectStore(){return {
            get(key:string){assert.equal(key,'state');const r:any={};queueMicrotask(()=>{if(aborted)return;r.result=structuredClone(record);r.onsuccess?.();schedule();});return r;},
            put(value:any,key:string){assert.equal(key,'state');puts++;staged=structuredClone(value);schedule();},
          };},
        };
        function schedule(){if(scheduled)return;scheduled=true;queueMicrotask(()=>{
          if(aborted)return;if(failCommit){failCommit=false;tx.abort();return;}
          if(staged!==undefined)record=staged;tx.oncomplete?.();
        });}
        transactions.push(tx);return tx;
      },
    };
    request.result=db;
    queueMicrotask(()=>{
      if(!exists){exists=true;request.transaction={abort(){request.onerror?.();}};request.onupgradeneeded?.({oldVersion:0});}
      request.onsuccess?.();
    });return request;
  }} as unknown as IDBFactory;
  return {locks,indexedDB:factory,held,transactions,get record(){return record;},set record(value:any){exists=true;record=structuredClone(value);},get puts(){return puts;},
    failNextCommit(){failCommit=true;},relax(){strict=false;},open(storage=session()){return openBrowserClientSlot({database,storage,locks,indexedDB:factory});}};
}

test('strict durable allocation precedes admission and preferred restart preserves exact client identity',async()=>{
  const f=fixture(), storage=session();const first=await f.open(storage);
  assert.equal(f.record.version,1);assert.deepEqual(f.record.slots,[{slotId:first.slotId,clientId:first.clientId,restore:true}]);
  assert.equal(storage.getItem(pointer),first.slotId);assert.equal(f.held.size,1);
  first.retire();const reopened=await f.open(storage);
  assert.equal(reopened.slotId,first.slotId);assert.equal(reopened.clientId,first.clientId);
  await reopened.release({restore:true});assert.equal(storage.getItem(pointer),first.slotId);
  assert.ok(f.transactions.every(tx=>tx.durability==='strict'));
});
test('copied active preferred pointer fails explicitly without allocating or changing recovery state',async()=>{
  const f=fixture(), original=session(), copied=session();const a=await f.open(original);
  copied.setItem(pointer,a.slotId);const before=structuredClone(f.record),puts=f.puts;
  await assert.rejects(f.open(copied),{code:'client_slot_in_use'});
  assert.deepEqual(f.record,before);assert.equal(f.puts,puts);assert.equal(copied.getItem(pointer),a.slotId);
  await a.release({restore:true});
});
test('simultaneous fresh tabs get distinct clients and a fresh tab restores a free retained slot first',async()=>{
  const f=fixture();const [a,b]=await Promise.all([f.open(),f.open()]);
  assert.notEqual(a.slotId,b.slotId);assert.notEqual(a.clientId,b.clientId);assert.equal(f.record.slots.length,2);
  a.retire();const restored=await f.open();assert.equal(restored.clientId,a.clientId);
  await Promise.all([b.release({restore:true}),restored.release({restore:true})]);
});
test('successful clean release clears only its pointer and permits bounded slot reuse',async()=>{
  const f=fixture(), storage=session(), a=await f.open(storage);
  await a.release({restore:false});await a.release({restore:false});
  assert.equal(storage.getItem(pointer),null);assert.equal(f.record.slots[0].restore,false);
  const b=await f.open(storage);assert.equal(b.slotId,a.slotId);assert.equal(b.clientId,a.clientId);
  assert.equal(f.record.slots[0].restore,true);await b.release({restore:true});
});
test('retirement is idempotent and cannot be converted into a clean release',async()=>{
  const f=fixture(), a=await f.open();a.retire();a.retire();
  await assert.rejects(a.release({restore:false}),{code:'client_slot_ownership_lost'});
  assert.equal(f.record.slots[0].restore,true);
  const b=await f.open();assert.equal(b.clientId,a.clientId);await b.release({restore:true});
});
test('pointer write failure retains durable restore selection for a fresh tab',async()=>{
  const f=fixture(), storage=session();storage.setItem=()=>{throw new Error('storage denied');};
  await assert.rejects(f.open(storage),{code:'client_slot_storage_unavailable'});
  assert.equal(f.record.slots.length,1);assert.equal(f.record.slots[0].restore,true);
  const saved=structuredClone(f.record.slots[0]),a=await f.open();assert.equal(a.clientId,saved.clientId);await a.release({restore:true});
});
test('abort during clean release retains recovery marker and ownership for exact retry',async()=>{
  const f=fixture(), storage=session(), a=await f.open(storage);f.failNextCommit();
  await assert.rejects(a.release({restore:false}),{code:'client_slot_storage_unavailable'});
  assert.equal(f.record.slots[0].restore,true);assert.equal(f.held.size,1);
  await a.release({restore:false});assert.equal(f.record.slots[0].restore,false);assert.equal(f.held.size,0);
});
test('retire while release is queued preserves restore and does not allow late clean mutation',async()=>{
  const f=fixture(),a=await f.open();let unblock!:()=>void,entered!:()=>void;
  const admitted=new Promise<void>(resolve=>{entered=resolve;});
  const blocked=f.locks.request(`${prefix}:registry`,{mode:'exclusive'},async()=>{entered();await new Promise<void>(resolve=>{unblock=resolve;});});
  await admitted;const releasing=assert.rejects(a.release({restore:false}),{code:'client_slot_ownership_lost'});
  a.retire();unblock();await blocked;await releasing;assert.equal(f.record.slots[0].restore,true);
});
test('invalid pointer and missing preferred slot fail closed without persistent writes',async()=>{
  const f=fixture(),storage=session();storage.setItem(pointer,'bad');
  await assert.rejects(f.open(storage),{code:'client_slot_pointer_invalid'});assert.equal(f.transactions.length,0);
  storage.setItem(pointer,id(99));await assert.rejects(f.open(storage),{code:'client_slot_unknown'});assert.equal(f.puts,0);
});
test('malformed, unsupported, duplicate and oversized registry records are never overwritten',async()=>{
  const row={slotId:id(1),clientId:id(2),restore:true};
  for(const value of [undefined,{}, {version:2,slots:[]},{version:1,slots:[{...row,extra:true}]},{version:1,slots:[row,row]},
    {version:1,slots:[row,{slotId:id(3),clientId:id(2),restore:true}]},{version:1,slots:[{...row,restore:'true'}]},
    {version:1,slots:Array.from({length:1025},(_,i)=>({slotId:id(i*2),clientId:id(i*2+1),restore:true}))}]){
    const f=fixture();f.record=value;await assert.rejects(f.open(),{code:'client_slot_registry_invalid'});assert.deepEqual(f.record,value);assert.equal(f.puts,0);
  }
});
test('registry size is bounded and active slots are never stolen',async()=>{
  const f=fixture();f.record={version:1,slots:Array.from({length:1024},(_,i)=>({slotId:id(i*2),clientId:id(i*2+1),restore:true}))};
  for(const row of f.record.slots)f.held.add(`${prefix}:slot:${row.slotId}`);
  await assert.rejects(f.open(),{code:'client_slot_registry_full'});assert.equal(f.puts,0);assert.equal(f.record.slots.length,1024);
});
test('missing locks, relaxed durability and failed registry commit never admit a consumer',async()=>{
  const f=fixture();await assert.rejects(openBrowserClientSlot({database,storage:session(),locks:{} as LockManager,indexedDB:f.indexedDB}),{code:'client_locks_unavailable'});
  f.relax();await assert.rejects(f.open(),{code:'client_slot_storage_unavailable'});assert.equal(f.puts,0);
  const g=fixture();g.failNextCommit();await assert.rejects(g.open(),{code:'client_slot_storage_unavailable'});assert.deepEqual(g.record,{version:1,slots:[]});
});
