import test from 'node:test';
import assert from 'node:assert/strict';
import {CalendarController,hasConflicts,blockTitle} from '../src/calendar/controller.ts';
import type {WorkBlockService,WorkBlockRead,WorkBlockPage,WorkBlockWindow} from '../src/core/workblocks.ts';
import {createDesktopWorkBlocks} from '../src/platform/desktop.ts';

const DAY=86_400_000;
const range={start_ms:'1000',end_ms:'2000',timezone:'UTC'};
const block=():WorkBlockRead=>({record:'record',generation:'generation',revision:[1,2],created:true,deleted:false,block:{ranges:[{operation:'r',range}],titles:[{operation:'t',title:'Planning'}],taskRefs:[]},unresolved:{}});
const page=(blocks:readonly WorkBlockRead[]=[],watermark='1',cursor:string|null=null):WorkBlockPage=>({blocks,watermark,cursor,incomplete:!!cursor,scanned:64,bytes:100});
const service=(overrides:Partial<WorkBlockService>={}):WorkBlockService=>({async create(input){return{operation:input.operation,revision:[3],sequence:'2'};},async read(){return block();},async windowPage(){return page();},async move(input){return{operation:input.operation,revision:[3],sequence:'2'};},async title(input){return{operation:input.operation,revision:[3],sequence:'2'};},async delete(input){return{operation:input.operation,revision:[3],sequence:'2'};},async addRef(){throw Error('unused');},async removeRef(){throw Error('unused');},async changes(){return{changes:[],next:'1'};},...overrides});

test('uncertain move retains exact immutable whole range, revision and operation across retry',async()=>{
  const requests:unknown[]=[];let count=0;
  const controller=new CalendarController(service({async move(input){requests.push(input);if(++count===1)throw Error('lost reply');return{operation:input.operation,revision:[3],sequence:'2'};}}));
  const source=block(),proposed={...range,start_ms:'1200',end_ms:'2400'};
  await assert.rejects(controller.move(source,proposed));source.revision[0]=9;proposed.start_ms='9000';
  assert.equal(controller.state.pending,true);await assert.rejects(controller.flush());
  await assert.rejects(controller.title(source,'new'));await controller.retry();
  assert.equal(requests[0],requests[1]);assert.deepEqual((requests[1] as any).expectedRevision,[1,2]);assert.equal((requests[1] as any).range.start_ms,'1200');
  assert.equal(controller.state.pending,false);assert.equal(controller.state.version,1);
});
test('stale revision rejection does not automatically rebase or retry; unknown definite errors stay pending',async()=>{
  let reads=0,moves=0;
  const controller=new CalendarController(service({async read(){reads++;return block();},async move(){moves++;throw Object.assign(Error(),{code:'stale_revision',commitUncertain:false});}}));
  await assert.rejects(controller.move(block(),range));assert.equal(controller.state.pending,false);assert.match(controller.state.error,/changed elsewhere/);assert.equal(moves,1);assert.equal(reads,0);
  const unknown=new CalendarController(service({async delete(){throw Object.assign(Error(),{code:'new_error',commitUncertain:false});}}));await assert.rejects(unknown.delete(block()));assert.equal(unknown.state.pending,true);
});
test('create unknown response replays the same record, generation and operation with no extra create',async()=>{
  const requests:unknown[]=[];const controller=new CalendarController(service({async create(input){requests.push(input);if(requests.length===1)throw Error();return{operation:input.operation,revision:[1],sequence:'1'};}}));
  await assert.rejects(controller.create(range,'Focus'));await controller.retry();assert.equal(requests[0],requests[1]);assert.equal((requests[0] as any).operation,(requests[0] as any).generation);assert.equal(controller.state.pending,false);
});
test('in-flight retry coalesces and flush waits for the actual commit',async()=>{
  let resolve!:()=>void,calls=0;const gate=new Promise<void>(done=>resolve=done);
  const controller=new CalendarController(service({async title(input){calls++;await gate;return{operation:input.operation,revision:[1],sequence:'1'};}}));
  const run=controller.title(block(),'Focus'),retry=controller.retry(),flush=controller.flush();assert.equal(run,retry);resolve();await Promise.all([run,retry,flush]);assert.equal(calls,1);
});
test('42-day grid splits into31-day windows with64-row1MiB budgets and dedupes overlapping blocks',async()=>{
  const queries:WorkBlockWindow[]=[];const controller=new CalendarController(service({async windowPage(input){queries.push(input);return page([block()]);}}));
  const blocks=await controller.window(0,42*DAY);assert.equal(blocks.length,1);assert.deepEqual(queries,[{fromMs:'0',untilMs:String(31*DAY),limit:64,byteLimit:1_048_576,cursor:null},{fromMs:String(31*DAY),untilMs:String(42*DAY),limit:64,byteLimit:1_048_576,cursor:null}]);
});
test('empty match pages with scan continuation are consumed using the same query and budgets',async()=>{
  const queries:WorkBlockWindow[]=[];const controller=new CalendarController(service({async windowPage(input){queries.push(input);return queries.length===1?page([],'1','next'):page([block()]);}}));
  assert.equal((await controller.window(0,DAY)).length,1);assert.deepEqual(queries[1],{...queries[0],cursor:'next'});
});
test('changed fence across pages or adjacent windows rejects the entire aggregate',async()=>{
  for(const continuation of [true,false]){let calls=0;const controller=new CalendarController(service({async windowPage(){return ++calls===1?page([block()],'1',continuation?'next':null):page([block()],'2');}}));await assert.rejects(controller.window(0,42*DAY),/consistent view/);}
});
test('nonadvancing cursor, inconsistent duplicate and missing continuation fail visibly',async()=>{
  const repeating=new CalendarController(service({async windowPage(){return page([],'1','same');}}));await assert.rejects(repeating.window(0,DAY),/advance/);
  let calls=0;const duplicate=new CalendarController(service({async windowPage(){const value=block();if(++calls===2)value.revision=[4];return page([value]);}}));await assert.rejects(duplicate.window(0,42*DAY),/consistent/);
  const missing=new CalendarController(service({async windowPage(){return{...page(),incomplete:true};}}));await assert.rejects(missing.window(0,DAY),/incomplete/);
});
test('cancelled range load stops before another page; deleted blocks do not become events',async()=>{
  let current=true,calls=0;const controller=new CalendarController(service({async windowPage(){calls++;current=false;return page([block()],'1','next');}}));assert.deepEqual(await controller.window(0,DAY,()=>current),[]);assert.equal(calls,1);
  const deleted={...block(),deleted:true};const clean=new CalendarController(service({async windowPage(){return page([deleted]);}}));assert.deepEqual(await clean.window(0,DAY),[]);
});
test('conflict helpers retain every candidate including unknown unresolved statuses',()=>{
  const value=block();value.block!.titles.push({operation:'two',title:'Alternative'});value.block!.ranges.push({operation:'two',range:{...range,start_ms:'0'}});
  assert.equal(hasConflicts(value),true);assert.equal(blockTitle(value),'Planning / Alternative');assert.equal(value.block!.ranges.length,2);assert.equal(hasConflicts({...block(),unresolved:{future_status:'1'}}),true);
});
test('actual binding invalid title and range codec failures never trap a pending request',async()=>{
  let calls=0;const binding=createDesktopWorkBlocks(async()=>{calls++;throw Error('unexpected transport');}),controller=new CalendarController(binding.service);
  assert.throws(()=>controller.create(range,'x'.repeat(513)),/512 bytes/);assert.throws(()=>controller.create(range,'😀'.repeat(129)),/512 bytes/);assert.equal(controller.state.pending,false);
  await assert.rejects(controller.create({...range,start_ms:'invalid'},'Valid title'),{code:'invalid_workblock_request'});assert.equal(controller.state.pending,false);assert.equal(calls,0);await controller.flush();await binding.release();
});
test('fenced window seeds watcher beyond historical backlog and notifies shared panes',async()=>{
  const queries:{after:string;limit:number}[]=[];let notifications=0;
  const controller=new CalendarController(service({async windowPage(){return page([],'6400');},async changes(input){queries.push(input);return{changes:[{sequence:'6401',record_key:'hidden',update_id:'op',status:'applied'}],next:'6401'};}}));
  const stop=controller.subscribe(()=>notifications++);try{await controller.window(0,DAY);await controller.catchUp();assert.deepEqual(queries,[{after:'6400',limit:64}]);assert.equal(notifications,2);assert.equal(controller.state.version,2);}finally{stop();}
});
test('late polling response cannot regress a newer window watermark or miss following changes',async()=>{
  let resolve!:(value:any)=>void;const after:string[]=[];let calls=0;
  const controller=new CalendarController(service({async windowPage(){return page([],'6400');},async changes(input){after.push(input.after);if(++calls===1)return new Promise(done=>resolve=done);return{changes:[],next:input.after};}}));
  const poll=controller.catchUp();await controller.window(0,DAY);resolve({changes:[],next:'0'});await poll;await controller.catchUp();assert.deepEqual(after,['0','6400']);
});
test('watcher failure marks freshness unknown and next success clears that status',async()=>{
  let calls=0;const controller=new CalendarController(service({async changes(input){if(++calls===1)throw Error();return{changes:[],next:input.after};}}));
  await controller.catchUp();assert.match(controller.state.freshnessError,/out of date/);await controller.catchUp();assert.equal(controller.state.freshnessError,'');
});
