import test from 'node:test';
import assert from 'node:assert/strict';
import {MobileWebRouter} from '../src/ui/mobile-web-router.ts';
import {MobileDocumentViewWindow} from '../src/ui/mobile-document-view-window.ts';
import type {MobileDocumentView,MobileDocumentSnapshot,MobileViewWindowHost} from '../src/ui/mobile-document-view-window.ts';
import {captureWebRouteCommand,captureWebRouteProgress,captureWebRouteState} from '../src/platform/mobile-web-routing.ts';
import type {WebRouteAction,WebRouteCommand,WebRouteState} from '../src/platform/mobile-web-routing.ts';

const clientId='abcdef01-1234-4567-8abc-abcdef012345';
function gate(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return{promise,resolve};}
async function until(check:()=>boolean){for(let n=0;n<100;n++){if(check())return;await new Promise<void>(yes=>setImmediate(yes));}assert.fail('router fixture timed out');}
interface View extends MobileDocumentView {entryId:string;text:string;active:boolean;disposed:boolean;canMutate:()=>boolean;undo:string[]}
function fixture(restored?:string){
  const files=new Map<string,MobileDocumentSnapshot>(['A','B','C','D','E'].map(id=>[id,{route:{kind:'document',entryId:id,path:id+'.md',revision:'rev1',recovery:'none'},content:id+' text'}]));
  const views:View[]=[],states:WebRouteState[]=[],events:string[]=[],created=new Map<string,string>();
  let current=true,readHold:Promise<void>|undefined,admitHold:Promise<void>|undefined,flushHold:Promise<void>|undefined,readEntered=false,admitEntered=false,flushEntered=false;
  let failPublish=false,failSave=false,failDispose=false,failAdmit:boolean|string=false,maxLive=0,reads=0,saves=0;
  const host:MobileViewWindowHost<View>={
    isCurrent:()=>current,
    async read(entryId,check){reads++;readEntered=true;if(readHold)await readHold;check();const row=files.get(entryId);if(!row)throw new Error('missing entry');return structuredClone(row);},
    async render(visit,snapshot,canMutate){
      assert.equal(canMutate(),false,'a passive constructor can never write');
      const view:View={visitId:visit.id,entryId:visit.entryId,text:snapshot.content,active:false,disposed:false,canMutate,undo:[],setInteractionState(state){this.active=state.active;}};
      views.push(view);maxLive=Math.max(maxLive,views.filter(v=>!v.disposed).length);assert.ok(maxLive<=3,'no fourth view allocation');return view;
    },
    async flush(view){flushEntered=true;events.push('flush:'+view.entryId);if(flushHold)await flushHold;
      const row=files.get(view.entryId)!;if(row.content!==view.text){row.content=view.text;row.route.revision='rev_'+crypto.randomUUID();}return structuredClone(row);},
    async admit(view,entryId,check){admitEntered=true;if(admitHold)await admitHold;check();if(failAdmit===true||failAdmit===entryId)throw new Error('admission rejected');assert.equal(view.entryId,entryId);events.push('admit:'+entryId);return structuredClone(files.get(entryId)!.route);},
    async dispose(view){if(failDispose)throw new Error('cleanup failed');view.disposed=true;events.push('dispose:'+view.entryId);},
    present(source,target,_direction,fraction){events.push('present:'+(source?.entryId??'home')+':'+(target?.entryId??'none')+':'+fraction);},
  };
  const window=new MobileDocumentViewWindow(host);
  const router=new MobileWebRouter({localStoreId:'Store_Mixed',clientId},window,{
    isCurrent:()=>current,
    async publish(state){captureWebRouteState(state);if(failPublish)throw new Error('receipt lost');states.push(structuredClone(state));},
    save(){if(failSave)throw new Error('persistence failed');saves++;},
    async createNote(id,check){check();let entryId=created.get(id);if(!entryId){entryId='New_'+created.size;created.set(id,entryId);files.set(entryId,{route:{kind:'document',entryId,path:entryId+'.md',revision:'rev1',recovery:'none'},content:''});}return entryId;},
  },restored);
  const command=(action:WebRouteAction):WebRouteCommand=>({id:crypto.randomUUID(),webSessionId:router.webSessionId,expectedVersion:router.snapshot().version,action});
  const run=(action:WebRouteAction)=>router.dispatch(command(action));
  const selected=()=>{const state=router.snapshot();return state.tabs.find(tab=>tab.id===state.selectedTabId)!;};
  const active=()=>views.find(view=>!view.disposed&&view.active&&view.canMutate());
  const write=(text:string)=>{const view=active();assert.ok(view);view.undo.push(view.text);view.text=text;};
  return{router,window,host,files,views,states,events,created,command,run,selected,active,write,
    get maxLive(){return maxLive;},get reads(){return reads;},get saves(){return saves;},get readEntered(){return readEntered;},get admitEntered(){return admitEntered;},get flushEntered(){return flushEntered;},
    holdRead(value:Promise<void>|undefined){readHold=value;readEntered=false;},holdAdmit(value:Promise<void>|undefined){admitHold=value;admitEntered=false;},holdFlush(value:Promise<void>|undefined){flushHold=value;flushEntered=false;},
    failPublish(value:boolean){failPublish=value;},failSave(value:boolean){failSave=value;},failDispose(value:boolean){failDispose=value;},failAdmit(value:boolean|string){failAdmit=value;},current(value:boolean){current=value;}};
}

test('web owns selected tabs and per-tab history, with three passive/writer-fenced runtimes',async()=>{
  const f=fixture();await f.router.start();const first=f.selected().id;
  assert.equal((await f.run({type:'open',entryId:'A',disposition:'current'})).status,'applied');const a=f.active()!;
  f.write('A authored');await f.run({type:'open',entryId:'B',disposition:'current'});const b=f.active()!;
  assert.equal(f.selected().canBack,true);await f.run({type:'traverse',direction:-1});
  assert.equal(f.active(),a);assert.deepEqual(a.undo,['A text']);assert.equal(a.text,'A authored');
  await f.run({type:'traverse',direction:1});assert.equal(f.active(),b);
  await f.run({type:'open',entryId:'C',disposition:'newTab'});const second=f.selected().id;assert.notEqual(first,second);
  assert.equal(f.router.snapshot().tabs.find(tab=>tab.id===first)!.canBack,true);
  await f.run({type:'selectTab',tabId:first});assert.equal(f.selected().route.kind==='document'&&f.selected().route.entryId,'B');
  assert.ok(f.maxLive<=3);assert.equal(f.views.filter(view=>view.canMutate()).length,1);
});

test('gesture shows real source and target handles; progress/cancel never edits history or writes',async()=>{
  const f=fixture();await f.router.start();await f.run({type:'open',entryId:'A',disposition:'current'});await f.run({type:'open',entryId:'B',disposition:'current'});
  const source=f.active(),gestureId=crypto.randomUUID(),route=structuredClone(f.selected().route);
  const begin=await f.run({type:'gestureBegin',gestureId,direction:-1});assert.equal(begin.status,'applied');assert.equal(f.active(),undefined);
  const reads=f.reads,saves=f.saves;
  assert.equal(f.router.progress({webSessionId:f.router.webSessionId,gestureId,sequence:'2',fraction:0.55}),true);
  assert.equal(f.router.progress({webSessionId:f.router.webSessionId,gestureId,sequence:'1',fraction:0.2}),false);
  assert.equal(f.reads,reads);assert.equal(f.saves,saves);assert.deepEqual(f.selected().route,route);
  const result=await f.router.dispatch({id:crypto.randomUUID(),webSessionId:f.router.webSessionId,action:{type:'gestureEnd',gestureId,sequence:'3',decision:'cancel'}});
  assert.equal(result.status,'cancelled');assert.equal(f.active(),source);assert.deepEqual(f.selected().route,route);
});

test('accepted gesture end uses its exact loan, not the version changed by its own begin',async()=>{
  const f=fixture();await f.router.start();await f.run({type:'open',entryId:'A',disposition:'current'});const a=f.active();
  await f.run({type:'open',entryId:'B',disposition:'current'});const gestureId=crypto.randomUUID();
  const version=f.router.snapshot().version;await f.run({type:'gestureBegin',gestureId,direction:-1});assert.notEqual(f.router.snapshot().version,version);
  assert.equal((await f.router.dispatch({id:crypto.randomUUID(),webSessionId:f.router.webSessionId,action:{type:'gestureEnd',gestureId,sequence:'0',decision:'commit'}})).status,'applied');
  assert.equal(f.active(),a);assert.equal(f.selected().canForward,true);
  assert.equal((await f.router.dispatch({id:crypto.randomUUID(),webSessionId:f.router.webSessionId,action:{type:'gestureEnd',gestureId,sequence:'1',decision:'commit'}})).status,'stale');
});

test('stale sessions/version and duplicate create command cannot manufacture another note',async()=>{
  const f=fixture();await f.router.start();const command=f.command({type:'createNote'});
  const [a,b]=await Promise.all([f.router.dispatch(command),f.router.dispatch(command)]);assert.deepEqual(a,b);assert.equal(f.created.size,1);
  assert.equal((await f.router.dispatch({...command,action:{type:'newTab'}})).status,'stale');assert.equal(f.created.size,1);
  assert.equal((await f.router.dispatch({...f.command({type:'newTab'}),webSessionId:crypto.randomUUID()})).status,'stale');
  assert.equal((await f.router.dispatch({...f.command({type:'newTab'}),expectedVersion:'0'})).status,'stale');assert.equal(f.router.snapshot().tabs.length,1);
});

test('lost native publication cannot rollback or reclassify committed web route; latest state retries',async()=>{
  const f=fixture();await f.router.start();f.failPublish(true);
  assert.equal((await f.run({type:'open',entryId:'A',disposition:'current'})).status,'applied');assert.equal(f.active()?.entryId,'A');
  f.failPublish(false);await f.router.republish();assert.equal(f.states.at(-1)?.selectedTabId,f.router.snapshot().selectedTabId);
  assert.deepEqual(f.states.at(-1)?.tabs,f.router.snapshot().tabs);
});

test('failed save/admission retains original route/runtime/writer and no provisional route is published',async()=>{
  for(const failure of ['save','admit']){
    const f=fixture();await f.router.start();await f.run({type:'open',entryId:'A',disposition:'current'});const source=f.active(),original=f.selected().route;
    if(failure==='save')f.failSave(true);else f.failAdmit('B');
    assert.equal((await f.run({type:'open',entryId:'B',disposition:'current'})).status,'failed');assert.equal(f.active(),source);assert.deepEqual(f.selected().route,original);
    assert.ok(f.states.every(state=>state.tabs.every(tab=>tab.route.kind!=='document'||tab.route.path!=='pending.md')));
  }
});

test('native overlay waits source flush and keeps claim/tab/history with zero writers until re-admission',async()=>{
  const f=fixture();await f.router.start();await f.run({type:'open',entryId:'A',disposition:'current'});const source=f.active(),route=f.selected().route,pending=gate();
  f.holdFlush(pending.promise);const hiding=f.run({type:'setPresentation',surface:'native'});await until(()=>f.flushEntered);assert.equal(f.active(),undefined);
  assert.equal(f.router.snapshot().presentation,'editor');pending.resolve();assert.equal((await hiding).status,'applied');
  assert.equal(f.router.snapshot().presentation,'native');assert.equal(f.active(),undefined);assert.deepEqual(f.selected().route,route);
  f.holdFlush(undefined);f.failAdmit(true);assert.equal((await f.run({type:'setPresentation',surface:'editor'})).status,'failed');assert.equal(f.active(),undefined);
  assert.equal(f.router.snapshot().presentation,'native');f.failAdmit(false);await f.run({type:'setPresentation',surface:'editor'});assert.equal(f.active(),source);
});

test('closing final tab admits a fresh Home in the same router; restart metadata restores tabs via immutable admission',async()=>{
  const f=fixture();await f.router.start();await f.run({type:'open',entryId:'A',disposition:'current'});await f.run({type:'open',entryId:'B',disposition:'newTab'});
  const restored=fixture(f.router.encode());await restored.router.start();assert.equal(restored.router.snapshot().tabs.length,2);assert.equal(restored.active()?.entryId,'B');
  assert.equal(restored.selected().id,f.selected().id);assert.notEqual(restored.router.webSessionId,f.router.webSessionId);
  for(const tab of [...restored.router.snapshot().tabs])await restored.run({type:'closeTab',tabId:tab.id});
  assert.equal(restored.router.snapshot().tabs.length,1);assert.equal(restored.selected().route.kind,'home');assert.equal(restored.active(),undefined);
});

test('lifecycle invalidates pending admission before draining; old completion cannot restore a writer',async()=>{
  const f=fixture();await f.router.start();await f.run({type:'open',entryId:'A',disposition:'current'});const pending=gate();f.holdAdmit(pending.promise);
  const command=f.run({type:'open',entryId:'B',disposition:'current'});await until(()=>f.admitEntered);const drain=f.router.drain();assert.equal(f.active(),undefined);
  pending.resolve();assert.equal((await command).status,'stale');await drain;assert.equal(f.active(),undefined);assert.equal(f.selected().route.kind==='document'&&f.selected().route.entryId,'A');
  f.holdAdmit(undefined);await f.router.resume();assert.equal(f.active()?.entryId,'A');
});

test('ordinary web link supersedes a pending gesture and stale end cannot move newer cursor',async()=>{
  const f=fixture();await f.router.start();await f.run({type:'open',entryId:'A',disposition:'current'});await f.run({type:'open',entryId:'B',disposition:'current'});
  const gestureId=crypto.randomUUID();await f.run({type:'gestureBegin',gestureId,direction:-1});await f.router.followEntry('C');
  assert.equal((await f.router.dispatch({id:crypto.randomUUID(),webSessionId:f.router.webSessionId,action:{type:'gestureEnd',gestureId,sequence:'1',decision:'commit'}})).status,'stale');assert.equal(f.active()?.entryId,'C');
});

test('long route sequences never allocate a fourth view; failed disposal prevents replacement',async()=>{
  const f=fixture();await f.router.start();for(let n=0;n<12;n++)await f.run({type:'open',entryId:['A','B','C','D','E'][n%5],disposition:'current'});
  assert.ok(f.maxLive<=3);assert.ok(f.window.size<=3);await f.run({type:'traverse',direction:-1});const source=f.active();f.failDispose(true);
  assert.equal((await f.run({type:'open',entryId:'E',disposition:'current'})).status,'failed');assert.equal(f.active(),source);assert.ok(f.window.size<=3);
});

test('path reuse/revision change cannot silently replace a prepared editor and its undo state',async()=>{
  const f=fixture();await f.router.start();await f.run({type:'open',entryId:'A',disposition:'current'});const a=f.active();await f.run({type:'open',entryId:'B',disposition:'current'});const source=f.active();
  f.files.get('A')!.route.revision='external-revision';assert.equal((await f.run({type:'traverse',direction:-1})).status,'failed');assert.equal(f.active(),source);assert.equal(a?.disposed,false);
});

test('strict protocol rejects roots, foreign fields, malformed routing IDs, noncanonical versions and invalid animation',()=>{
  const id=crypto.randomUUID(),webSessionId=crypto.randomUUID();
  for(const expectedVersion of ['01','-1','18446744073709551616'])assert.throws(()=>captureWebRouteCommand({id,webSessionId,expectedVersion,action:{type:'newTab'}}));
  assert.throws(()=>captureWebRouteCommand({id,webSessionId,expectedVersion:'0',action:{type:'open',entryId:'A',disposition:'current',path:'/tmp'}}));
  for(const fraction of [NaN,Infinity,-1,2])assert.throws(()=>captureWebRouteProgress({webSessionId,gestureId:id,sequence:'1',fraction}));
  assert.throws(()=>captureWebRouteCommand({id:id.toUpperCase(),webSessionId,expectedVersion:'0',action:{type:'newTab'}}));
  for(const decision of [['cancel'],null,{},true])assert.throws(()=>captureWebRouteCommand({id,webSessionId,action:{type:'gestureEnd',gestureId:id,sequence:'0',decision}}));
  for(const disposition of [['newTab'],null,{},true])assert.throws(()=>captureWebRouteCommand({id,webSessionId,expectedVersion:'0',action:{type:'open',entryId:'A',disposition}}));
  const f=fixture();const state=f.router.snapshot();state.tabs[0].route={kind:'document',entryId:'A',path:'../A.md',revision:'R',recovery:'none'};assert.throws(()=>captureWebRouteState(state));
  for(const status of [['ready'],null,{},true])assert.throws(()=>captureWebRouteState({...f.router.snapshot(),status}));
});
test('failed destruction remains fenced and retries the exact retained resource cleanup',async()=>{
  const f=fixture();await f.router.start();await f.run({type:'open',entryId:'A',disposition:'current'});f.failDispose(true);
  await assert.rejects(f.window.destroy(),/cleanup failed/);assert.equal(f.active(),undefined);assert.equal(f.window.size,1);
  f.failDispose(false);await f.window.destroy();assert.equal(f.window.size,0);assert.equal(f.views.filter(v=>!v.disposed).length,0);
});
test('background resume requires fresh source admission and never revives a failed source writer',async()=>{
  const f=fixture();await f.router.start();await f.run({type:'open',entryId:'A',disposition:'current'});await f.router.drain();f.failAdmit('A');
  await assert.rejects(f.router.resume(),/admission rejected/);assert.equal(f.active(),undefined);
  f.failAdmit(false);await f.router.resume();assert.equal(f.active()?.entryId,'A');
});
test('document commands atomically leave retained native overlay; failed commands keep it hidden',async()=>{
  const f=fixture();await f.router.start();await f.run({type:'open',entryId:'A',disposition:'current'});await f.run({type:'setPresentation',surface:'native'});
  f.failAdmit('B');assert.equal((await f.run({type:'open',entryId:'B',disposition:'current'})).status,'failed');assert.equal(f.router.snapshot().presentation,'native');assert.equal(f.active(),undefined);
  f.failAdmit(false);assert.equal((await f.run({type:'open',entryId:'B',disposition:'current'})).status,'applied');assert.equal(f.router.snapshot().presentation,'editor');assert.equal(f.active()?.entryId,'B');
});
