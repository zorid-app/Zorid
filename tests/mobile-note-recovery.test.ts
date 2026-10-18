import test from 'node:test';
import assert from 'node:assert/strict';
import {readPassiveMobileNote,MobileRecoveryInventory} from '../src/ui/mobile-note-recovery.ts';
import type {Checkpoint,CheckpointMetadata,CheckpointPage,DurableCheckpoints} from '../src/core/durable-checkpoints.ts';

const scope={vaultId:'Store',clientId:crypto.randomUUID()};
const observed={entryId:'Entry_A',path:'A.md',revision:'revision_now',content:'Current disk',stat:{ctime:1,mtime:1,size:12}};
const metadata=(key='note/v1/Entry_A',sequence='1'):CheckpointMetadata=>({version:1,...scope,key,revision:'head_rev',sequence,deleted:false,byteLength:20});
function fixture(){
  let reads=0,loads=0,writes=0;const order:string[]=[],listCalls:any[]=[],changeCalls:any[]=[];
  let head:Checkpoint|null={...metadata(),encodedState:JSON.stringify({version:1,writer:'writer',generation:1,base:{...observed,revision:'revision_old',content:'Old base'},draft:'Retained draft',conflict:true})};
  const lists:CheckpointPage[]=[{items:[metadata()],cursor:null,highWater:'1'}],changes:CheckpointPage[]=[{items:[],cursor:null,highWater:'1'}];
  const checkpoints:DurableCheckpoints={scope,
    load:async()=>{loads++;order.push('load');return head;},compareAndSwap:async()=>{writes++;throw new Error('Passive recovery cannot write');},
    list:async input=>{listCalls.push(input);return lists.shift()!;},changes:async input=>{changeCalls.push(input);return changes.shift()!;},
  };
  return{checkpoints,order,lists,changes,listCalls,changeCalls,
    input:{entryId:'Entry_A',readById:async(id:string)=>{reads++;order.push('read:'+id);return{...observed};},checkpoints,check:()=>{}},
    get reads(){return reads;},get loads(){return loads;},get writes(){return writes;},get head(){return head;},setHead(value:Checkpoint|null){head=value;}};
}
test('passive preview observes immutable ID before checkpoint and displays retained text without recovery writes',async()=>{
  const f=fixture(),preview=await readPassiveMobileNote(f.input);
  assert.deepEqual(f.order,['read:Entry_A','load']);assert.equal(preview.content,'Retained draft');assert.equal(preview.route.recovery,'retainedDraft');assert.equal(f.writes,0);
});
test('missing, replaced and superseded entries cannot load or replay any checkpoint',async()=>{
  for(const mode of ['missing','replaced','superseded']){
    const f=fixture();let current=true;
    const read=async()=>{if(mode==='superseded')current=false;return mode==='missing'?null:{...observed,entryId:mode==='replaced'?'Other':observed.entryId};};
    await assert.rejects(readPassiveMobileNote({...f.input,readById:read,check:()=>{if(!current)throw new Error('superseded');}}));assert.equal(f.loads,0);assert.equal(f.writes,0);
  }
});
test('clean stale saved editor state shows current disk, and pending operation is retained without replay',async()=>{
  const f=fixture();const raw=JSON.parse(f.head!.encodedState!);raw.draft=raw.base.content;raw.conflict=false;f.setHead({...f.head!,encodedState:JSON.stringify(raw)});
  const clean=await readPassiveMobileNote(f.input);assert.equal(clean.content,observed.content);assert.equal(clean.route.recovery,'none');
  raw.operation={plan:{operationId:'original'}};f.setHead({...f.head!,encodedState:JSON.stringify(raw)});
  const pending=await readPassiveMobileNote(f.input);assert.equal(pending.route.recovery,'retainedDraft');assert.equal(f.writes,0);
});
test('inventory follows empty continuation and actual high water into changes without loading bodies',async()=>{
  const f=fixture();f.lists.splice(0,f.lists.length,{items:[],cursor:'page_2',highWater:'5'},{items:[metadata('note/v1/Entry_A','3')],cursor:null,highWater:'5'});
  f.changes.splice(0,1,{items:[metadata('native-file-menu/v1/pending','6')],cursor:null,highWater:'6'});
  const inventory=new MobileRecoveryInventory(f.checkpoints,()=>true);
  assert.equal((await inventory.next()).hasMore,true);const notes=await inventory.next();assert.equal(notes.items[0].status,'uninspected');assert.equal(notes.items[0].kind,'savedEditorState');
  const changed=await inventory.next();assert.equal(changed.complete,true);assert.equal(changed.items[0].kind,'legacyNativeOperation');assert.equal(changed.status,'metadataObserved');
  assert.equal(f.listCalls[1].cursor,'page_2');assert.deepEqual(f.changeCalls,[{after:'5',limit:50}]);assert.equal(f.loads,0);assert.equal(f.writes,0);
});
test('inventory holds only current bounded page and does not infer dirty or clear from metadata',async()=>{
  const f=fixture();f.lists.splice(0,1,{items:Array.from({length:50},(_,n)=>metadata('note/v1/Entry_'+n)),cursor:'more',highWater:'1'},{items:[metadata('note/v1/Entry_Last')],cursor:null,highWater:'1'});
  const inventory=new MobileRecoveryInventory(f.checkpoints,()=>true);assert.equal((await inventory.next()).items.length,50);const last=await inventory.next();
  assert.equal(last.items.length,1);assert.equal(last.recordsObserved,51);assert.equal(last.status,'metadataObserved');assert.equal(f.loads,0);
});
test('failed inventory page preserves last page and cursor for explicit retry, never clear',async()=>{
  const f=fixture();f.lists.splice(0,1,{items:[metadata()],cursor:'more',highWater:'1'},{items:[],cursor:'more',highWater:'1'},{items:[],cursor:null,highWater:'1'});
  const inventory=new MobileRecoveryInventory(f.checkpoints,()=>true);await inventory.next();await assert.rejects(inventory.next());
  assert.equal(inventory.snapshot().status,'unavailable');assert.equal(inventory.snapshot().items.length,1);assert.equal(inventory.snapshot().complete,false);
  await inventory.next();assert.equal(f.listCalls[2].cursor,'more');assert.equal(f.loads,0);
});
test('foreign scope or invalid metadata/highwater fails safely without body reads',async()=>{
  const f=fixture();f.lists.splice(0,1,{items:[{...metadata(),clientId:'foreign'}],cursor:null,highWater:'1'});
  const inventory=new MobileRecoveryInventory(f.checkpoints,()=>true);await assert.rejects(inventory.next());assert.equal(inventory.snapshot().status,'unavailable');assert.equal(f.loads,0);
});
test('completed inventory rejects a retired owner rather than certifying cached metadata',async()=>{
  const f=fixture();let current=true;const inventory=new MobileRecoveryInventory(f.checkpoints,()=>current);
  await inventory.next();assert.equal((await inventory.next()).complete,true);current=false;
  await assert.rejects(inventory.next(),/owner changed/);assert.equal(inventory.snapshot().status,'unavailable');assert.equal(inventory.snapshot().complete,false);
  assert.equal(f.listCalls.length,1);assert.equal(f.changeCalls.length,1);assert.equal(f.loads,0);
});
test('completed inventory rejects client or vault scope drift on the cached terminal path',async()=>{
  for(const field of ['vaultId','clientId'] as const){
    const f=fixture(),mutableScope={...scope};Object.assign(f.checkpoints,{scope:mutableScope});
    const inventory=new MobileRecoveryInventory(f.checkpoints,()=>true);await inventory.next();assert.equal((await inventory.next()).complete,true);
    mutableScope[field]='foreign';await assert.rejects(inventory.next(),/owner changed/);
    assert.equal(inventory.snapshot().status,'unavailable');assert.equal(inventory.snapshot().complete,false);assert.equal(f.loads,0);
  }
});
