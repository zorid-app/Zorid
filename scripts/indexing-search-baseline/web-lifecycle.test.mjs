import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Evaluate the exact browser fixture source, with controlled facade boundaries.
// These are harness-oracle checks; real Worker/WASM/IDB runs remain separate.
const tool=fs.readFileSync(new URL('./web.mjs',import.meta.url),'utf8');
const factory=tool.slice(tool.indexOf('function browserSource()'));
const browser=vm.runInNewContext(factory+'\nbrowserSource();').replace(/^import .*;$/gm,'');
async function fixture({coreLifecycle=true,incomplete=false,wrongPage=false,missingMaintenance=false}={}){
  const calls=[],bytes=new TextEncoder().encode('needle\n'),digest=Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
  const snapshot={localStoreId:'store',generationEpoch:'epoch',generation:'1',versions:{schema:2,extraction:'x',resolver:'r',query:'q'}},source={localStoreId:'store',watermark:'1'};
  const entry={id:'note',revision:'r1',path:'Note.md',kind:'file',deleted:false},range={bytes:[0,6],utf16:[0,6]};
  const row={noteIndex:0,logicalId:'logical',path:entry.path,bytes:bytes.length,sha256:digest};
  const oracle={id:'rare',query:'needle',expected:[{logicalId:row.logicalId,path:entry.path,line:0,range}]};
  let current=coreLifecycle;
  const status=()=>({snapshot:current?snapshot:null,source,current,coverageComplete:current});
  const pin={snapshot,source,coverageComplete:true,async search(){calls.push('query');return {cursor:null,result:{snapshot:wrongPage?{...snapshot,generation:'other'}:snapshot,source,coverageComplete:true,value:{hits:[{entry,line:0,range}],scanComplete:true,complete:true,documents:1,sourceBytes:bytes.length}}};},async close(){calls.push('pin-close');}};
  const manual=name=>{calls.push(name);assert.equal(coreLifecycle,false,'core lifecycle must not call manual '+name);};
  const service={async status(){calls.push('status');return status();},async initialize(){manual('initialize');},async begin(){manual('begin');return {stageId:'stage',progress:{ready:true}};},async pump(){manual('pump');},async publish(){manual('publish');current=true;return snapshot;},async open(){calls.push('pin-open');return pin;},
    ...(missingMaintenance?{}:{maintenance:{async observeAndSubscribe(receive){calls.push('subscribe');receive({freshness:incomplete?'lagging':'current',coverageComplete:!incomplete,published:incomplete?null:snapshot,source});return {snapshot:null,unsubscribe(){calls.push('unsubscribe');}};}}})};
  const runtime={durableScope:{vaultId:'store',clientId:'client'},assertActive(){},async readEntry(){return {entry,bytes,presentation:{}};},close(){calls.push('runtime-close');}};
  const window={};
  const context={window,performance,Uint8Array,TextEncoder,TextDecoder,crypto,setTimeout,requestAnimationFrame:fn=>queueMicrotask(fn),location:{origin:'https://fixture.test'},crossOriginIsolated:false,
    navigator:{userAgent:'unit',platform:'unit',hardwareConcurrency:1,storage:{async estimate(){return {};}}},document:{querySelector(){return {textContent:''};}},
    fetch:async url=>({ok:true,async json(){return url.includes('manifest')?{entries:[row],noteCount:1}:[oracle];}}),
    BrowserCoreRuntime:{async open(options){calls.push(['open',options]);return runtime;}},admitBrowserClient:()=>({async release(){calls.push('client-release');}}),defaultBrowserAdapter:()=>({documentSemantics:service})};
  vm.runInNewContext(browser,context);
  await window.s1.run({phase:coreLifecycle?'startup-query':'derived-cold',coreLifecycle,phaseTimeoutMs:incomplete?1:10000,run:0,database:'owned',clientId:'client',mapping:[{...row,id:entry.id,revision:entry.revision}],expectedSetupSnapshot:snapshot,repeats:1});
  return {record:window.__s1Result,calls};
}

test('core lifecycle startup awaits actual public updates and queries exact pinned source without manual pumping',async()=>{
  const {record,calls}=await fixture();assert.equal(record.status,'passed',JSON.stringify(record.error));
  assert.equal(calls[0][1].documentMaintenance,true);assert.equal(record.index.manualPumps,0);assert.equal(record.index.pumps,null);
  assert.equal(record.queries[0].count,1);assert.ok(calls.includes('unsubscribe'));assert.ok(calls.includes('pin-close'));assert.ok(calls.includes('client-release'));
});
test('incomplete core coverage fails with observations and release, never an empty successful query',async()=>{
  const {record,calls}=await fixture({incomplete:true});assert.equal(record.status,'failed');assert.match(record.error.message,/complete\/current/);
  assert.equal(record.index.lifecycle.lastUpdate.freshness,'lagging');assert.ok(calls.includes('unsubscribe'));assert.ok(calls.includes('client-release'));assert.equal(calls.includes('query'),false);
});
test('core lifecycle requires positive admitted maintenance',async()=>{
  const {record,calls}=await fixture({missingMaintenance:true});assert.equal(record.status,'failed');assert.match(record.error.message,/Positive admitted core maintenance/);assert.equal(calls.includes('query'),false);assert.ok(calls.includes('client-release'));
});
test('core lifecycle rejects a page from another generation and closes its pin',async()=>{
  const {record,calls}=await fixture({wrongPage:true});assert.equal(record.status,'failed');assert.match(record.error.message,/page switched pinned generation/);assert.ok(calls.includes('pin-close'));assert.ok(calls.includes('client-release'));
});
test('default browser baseline keeps explicit manual index construction and absent capability request',async()=>{
  const {record,calls}=await fixture({coreLifecycle:false});assert.equal(record.status,'passed',JSON.stringify(record.error));
  assert.equal(calls[0][1].documentMaintenance,undefined);for(const op of ['initialize','begin','publish'])assert.ok(calls.includes(op));assert.equal(calls.includes('subscribe'),false);
});
