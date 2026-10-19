import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createDocumentService } from '../src/core/document-semantics.ts';
import type { DocumentTasksRead, DocumentTransport, DocumentTaskRow } from '../src/core/document-semantics.ts';
import { TasksController, taskReadDiagnostics } from '../src/tasks/controller.ts';
import type { TasksHost } from '../src/tasks/controller.ts';
import { createTasksView } from '../src/tasks/view.ts';
import { createTabViewRuntime } from '../src/ui/tab-view-runtime.ts';
import { freshnessUntil, heldDocumentFreshness } from './fixtures/held-document-freshness.ts';

const snapshot = {localStoreId:'store',generationEpoch:'epoch',generation:'9007199254740993',versions:{schema:1,extraction:'v1',resolver:'v1',query:'v1'}};
const source = {localStoreId:'store',watermark:'9007199254740993'};
const typeWitness = {entryId:'type-file',revision:'type-rev'};
function data(): DocumentTasksRead {
  return {definitions:[{id:'type-file',revision:'type-rev',path:'Types/Task.yaml',kind:'file',deleted:false}],types:[{witness:typeWitness,typeId:'task-type',label:'Task',status:{id:'status-prop',key:'state',label:'Status',datatype:'status',default:'todo',options:[{id:'todo',label:'To do',category:'not_started'},{id:'working',label:'In progress',category:'working'},{id:'done',label:'Done',category:'done'}]},plannedDay:{id:'plan-prop',key:'plan',label:'Planned day',datatype:'date',default:null,options:[]},deadline:{id:'due-prop',key:'due',label:'Deadline',datatype:'date',default:null,options:[]},captureDefaults:[['type','task-type'],['state','todo']]}],result:{snapshotId:snapshot,typeWitnesses:[typeWitness],coverageComplete:true,rows:[{witness:{entryId:'note',revision:'r1'},path:'Tasks/Example.md',title:'Example',typeId:'task-type',statusId:'todo',statusLabel:'To do',category:'not_started',statusDefaulted:false,plannedDay:null,deadline:null}],groups:[],matched:1,truncated:false,diagnostics:[],typeDiagnostics:[],metadataIssues:[]}};
}
function deferred<T>() { let resolve!:(value:T) => void; const promise = new Promise<T>(r => {resolve=r;}); return {promise,resolve}; }
function harness() {
  let current = data(), queryError: unknown, editError: unknown, captureError: unknown, closeFailures = 0;
  let wait: Promise<void> | undefined;
  let closeWait: Promise<void> | undefined;
  const calls: {kind:string;input?:any}[] = [];
  const transport = {
    status:async () => ({source,snapshot,coveredSource:source,current:true,rebuildRequired:false,coverageComplete:true}),
    open:async () => { calls.push({kind:'open'}); return {pinId:'pin',snapshot,source,coverageComplete:true}; },
    tasks:async (input:any) => {calls.push({kind:'query',input}); await wait; if (queryError) throw queryError; return {snapshot,source,coverageComplete:true,value:current};},
    closePin:async () => {calls.push({kind:'close'}); if (closeFailures-- > 0) throw Error('close failed'); await closeWait;},
  } as unknown as DocumentTransport;
  const listeners = new Set<() => void>();
  const host:TasksHost = {
    subscribe:listener => { listeners.add(listener); return () => {listeners.delete(listener);}; },
    documents:createDocumentService(transport),typeDefinitionIds:() => current.definitions.map(entry => entry.id),
    createTask:async input => {calls.push({kind:'create',input}); if (captureError) throw captureError;},
    editTask:async input => {calls.push({kind:'edit',input}); if (editError) throw editError;},
    openTask:async input => {calls.push({kind:'body',input});},
    installPreset:async input => {calls.push({kind:'install',input}); throw Error('Preset path exists; choose another unused path.');},
  };
  return {host,calls,notify:() => {for (const listener of listeners) listener();},subscriptionCount:() => listeners.size,closeWait:(p:Promise<void>) => {closeWait=p;},setData:(value:DocumentTasksRead) => {current=value;},queryError:(e:unknown) => {queryError=e;},editError:(e:unknown) => {editError=e;},captureError:(e:unknown) => {captureError=e;},wait:(p:Promise<void>) => {wait=p;},closeFailures:(n:number) => {closeFailures=n;}};
}
async function cleanup(controller:TasksController) { controller.state.capture.title=''; controller.state.unconfirmedCapture=null; controller.state.drafts.clear(); await controller.dispose(); }
async function settled(controller:TasksController) { await controller.flush(); await new Promise(resolve => setImmediate(resolve)); await controller.flush(); }

test('normal document wrapper receives definition EntryIds/options and closes its real pin after reading',async () => {
  const h = harness(), c = new TasksController(h.host); await c.refresh();
  assert.deepEqual(h.calls.map(x=>x.kind),['open','query','close']);
  assert.deepEqual(h.calls[1].input.typeIds,['type-file']); assert.equal(h.calls[1].input.options.filter,'all');
  assert.equal(h.calls[1].input.options.maxRows,1000); assert.ok(Number.isSafeInteger(h.calls[1].input.options.clockMs));
  assert.equal(c.state.data?.result.rows[0].witness.revision,'r1'); await cleanup(c);
});

for(const reason of ['refresh','filter','source','close'] as const)test(`Tasks ${reason} aborts its own held freshness and cannot admit a stale pin`,async()=>{
  const held=heldDocumentFreshness(),h=harness(),c=new TasksController({...h.host,documents:{...h.host.documents,maintenance:held.maintenance}});
  const firstRun=c.refresh();await freshnessUntil(()=>held.requests.length===1);const first=held.requests[0];
  let closed:Promise<void>|undefined;
  if(reason==='refresh')void c.refresh();
  else if(reason==='filter')c.setFilter('today');
  else if(reason==='source')h.notify();
  else closed=c.prepareClose();
  assert.equal(h.calls.length,0);held.release(first);await freshnessUntil(()=>held.outcomeAcks.includes(first));
  assert.deepEqual(held.cancellations,[first]);assert.equal(h.calls.length,0);
  if(reason!=='close'){
    await freshnessUntil(()=>held.requests.length===2);closed=c.prepareClose();held.release(held.requests[1]);
  }
  await firstRun;await closed;c.destroy();
  assert.equal(h.calls.length,0);assert.equal(c.state.data,null);assert.equal(c.state.error,null);
  assert.equal(held.subscriptions,0);assert.equal(h.subscriptionCount(),0);
});
test('capture persists type defaults through ordinary host, retains failed draft, refreshes only after durable success',async () => {
  const h = harness(), c = new TasksController(h.host); await c.refresh(); c.state.capture.title = ' New task ';
  h.captureError(Object.assign(Error('disk full'),{commitUncertain:false})); await c.capture(); assert.equal(c.state.capture.title,' New task '); assert.match(c.state.error!,/disk full/);
  h.captureError(undefined); await c.capture(); await settled(c);
  const created = h.calls.filter(x=>x.kind==='create').at(-1)!.input;
  assert.equal(typeof created.captureId,'string'); const {captureId,...createdFields}=created;
  assert.deepEqual(createdFields,{title:'New task',destination:'Tasks',typeWitness,properties:{type:'task-type',state:'todo'}});
  assert.equal(c.state.capture.title,''); await cleanup(c);
});
test('mapped edits retain original note/type witnesses and failed dirty/CAS drafts across refresh',async () => {
  const h = harness(), c = new TasksController(h.host); await c.refresh(); c.beginEdit(c.state.data!.result.rows[0]);
  const draft = c.state.drafts.get('note')!; draft.status='working'; draft.plannedDay='2026-10-18'; draft.deadline='2026-10-20';
  h.editError(Object.assign(Error('note changed or dirty'),{code:'revision_conflict'})); await c.save('note');
  assert.equal(c.state.drafts.get('note'),draft); assert.match(c.state.error!,/revision_conflict/);
  const changed = data(); changed.result.rows[0] = {...changed.result.rows[0],witness:{entryId:'note',revision:'r2'}}; h.setData(changed); await c.refresh();
  await c.save('note'); assert.deepEqual(h.calls.filter(x=>x.kind==='edit').at(-1)!.input,{expectedTypeId:'task-type',witness:{entryId:'note',revision:'r1'},typeWitness,properties:{state:'working',plan:'2026-10-18',due:'2026-10-20'}});
  assert.equal(draft.row.witness.revision,'r1'); c.discard('note'); c.beginEdit(c.state.data!.result.rows[0]); assert.equal(c.state.drafts.get('note')!.row.witness.revision,'r2'); await cleanup(c);
});
test('unknown status preserved on date-only changes; invalid date and replacement status never reach mutation host',async () => {
  const h = harness(), unknown = data(); unknown.result.rows[0] = {...unknown.result.rows[0],statusId:'future-status',statusLabel:null,category:null}; h.setData(unknown);
  const c = new TasksController(h.host); await c.refresh(); c.beginEdit(c.state.data!.result.rows[0]); let draft = c.state.drafts.get('note')!;
  draft.plannedDay='2026-02-30'; await c.save('note'); assert.equal(h.calls.filter(x=>x.kind==='edit').length,0);
  draft.plannedDay='2026-10-18'; await c.save('note'); await settled(c); assert.deepEqual(h.calls.find(x=>x.kind==='edit')!.input.properties,{plan:'2026-10-18'});
  c.beginEdit(c.state.data!.result.rows[0]); draft=c.state.drafts.get('note')!; draft.status='invented'; await c.save('note'); assert.equal(h.calls.filter(x=>x.kind==='edit').length,1); await cleanup(c);
});
test('expired pins surface explicit reopen diagnostics without automatic cross-generation retry',async () => {
  const h = harness(), c = new TasksController(h.host); h.queryError(Object.assign(Error('expired'),{code:'snapshot_expired'})); await c.refresh();
  assert.match(c.state.error!,/expired.*Refresh to reopen/); assert.equal(h.calls.filter(x=>x.kind==='open').length,1); assert.equal(h.calls.at(-1)!.kind,'close');
  h.queryError(undefined); await c.refresh(); assert.ok(c.state.data); assert.equal(h.calls.filter(x=>x.kind==='open').length,2); await cleanup(c);
});
test('dispose drains read before pin close; failed closes remain owned and are retried before another open',async () => {
  const h = harness(), gate = deferred<void>(); h.wait(gate.promise); const c = new TasksController(h.host); const refreshing=c.refresh();
  while (!h.calls.some(x=>x.kind==='query')) await new Promise(resolve=>setImmediate(resolve));
  const disposed=c.dispose(); assert.equal(h.calls.some(x=>x.kind==='close'),false); gate.resolve(); await refreshing; await disposed;
  assert.deepEqual(h.calls.map(x=>x.kind),['open','query','close']); assert.equal(c.state.data,null);
  const h2=harness(), c2=new TasksController(h2.host); h2.closeFailures(1); await c2.refresh(); assert.match(c2.state.error!,/close failed/); await c2.refresh();
  assert.deepEqual(h2.calls.map(x=>x.kind),['open','query','close','close','open','query','close']); await cleanup(c2);
});
test('incomplete/truncated/invalid type and metadata facts are explicit, never an empty-success message',() => {
  const value=data(); Object.assign(value.result,{coverageComplete:false,truncated:true,matched:12,typeDiagnostics:[{witness:typeWitness,code:'invalid_type_yaml'}],diagnostics:[{witness:{entryId:'note',revision:'r1'},property:'due',code:'invalid_date'}],metadataIssues:[{witness:{entryId:'unreadable',revision:'r1'},exclusion:'unreadable',diagnostics:[],propertiesUnavailable:true}]});
  const messages=taskReadDiagnostics(value).join('\n'); for(const text of ['Incomplete','1 of 12','invalid type yaml','invalid date','unreadable']) assert.ok(messages.includes(text));
});
test('DOM capture, accessible status/date controls, stale orphan drafts, body callback, alternate preset paths and teardown',async () => {
  const h=harness(), dom=new JSDOM('<main></main>'), container=dom.window.document.querySelector('main')!;
  const view=createTasksView(container,h.host); await view.ready;
  const byText=(text:string) => [...container.querySelectorAll('button')].find(b=>b.textContent===text)!;
  byText('Example').click(); await view.flush(); assert.deepEqual(h.calls.find(x=>x.kind==='body')!.input,{entryId:'note',revision:'r1'});
  byText('Edit status and dates').click(); const status=[...container.querySelectorAll('label')].find(l=>l.textContent!.startsWith('Status'))!.querySelector('select')!;
  status.value='done'; status.dispatchEvent(new dom.window.Event('change')); assert.equal(view.hasPendingChanges(),true);
  const missing=data(); missing.result.rows=[]; h.setData(missing); await view.controller.refresh(); assert.match(container.textContent!,/Draft task is outside this result/); assert.equal(view.controller.state.drafts.get('note')!.status,'done');
  const typeInput=[...container.querySelectorAll('label')].find(l=>l.textContent==='Type file (inside Types/)')!.querySelector('input')!; typeInput.value='Types/Alternate.yaml'; typeInput.dispatchEvent(new dom.window.Event('input'));
  byText('Install preset').click(); await view.flush(); assert.equal(h.calls.find(x=>x.kind==='install')!.input.type.path,'Types/Alternate.yaml'); assert.match(container.textContent!,/Preset path exists/);
  assert.equal(view.controller.state.drafts.size,1); await assert.rejects(view.close(),/unsaved or unconfirmed/); view.controller.discard('note'); await view.close(); assert.equal(container.children.length,0); dom.window.close();
});

test('uncertain capture cannot be replayed by another click or refresh, requires explicit user reconciliation',async () => {
  const h=harness(), c=new TasksController(h.host); await c.refresh(); c.state.capture.title='Original';
  h.captureError(Object.assign(Error('lost acknowledgement'),{code:'outcome_unknown',commitUncertain:true}));
  await c.capture(); const request=c.state.unconfirmedCapture; assert.ok(request); await c.capture(); await c.refresh(); await c.capture();
  assert.equal(h.calls.filter(x=>x.kind==='create').length,1); assert.equal(c.state.unconfirmedCapture,request); assert.equal(c.hasPendingChanges(),true);
  c.resolveCapture(true); await settled(c); assert.equal(c.state.unconfirmedCapture,null); assert.equal(c.state.capture.title,''); await cleanup(c);
});

test('successful status/date clear submits only mapped fields, releases draft and explicitly refreshes',async () => {
  const h=harness(), value=data(); value.result.rows[0]={...value.result.rows[0],plannedDay:'2026-10-18',deadline:'2026-10-20'}; h.setData(value);
  const c=new TasksController(h.host); await c.refresh(); c.beginEdit(c.state.data!.result.rows[0]);
  const draft=c.state.drafts.get('note')!; draft.status='done'; draft.plannedDay=''; await c.save('note'); await settled(c);
  assert.deepEqual(h.calls.find(x=>x.kind==='edit')!.input.properties,{state:'done',plan:null});
  assert.equal(c.state.drafts.size,0); assert.equal(h.calls.filter(x=>x.kind==='query').length,2); await cleanup(c);
});
test('Rust grouping order is displayed and keyboard focus enters edit controls',async () => {
  const h=harness(), value=data(); value.result.groups=[{typeId:'task-type',category:'not_started',statusId:'todo',entryIds:['note']}]; h.setData(value);
  const dom=new JSDOM('<main></main>'), root=dom.window.document.querySelector('main')!;
  const view=createTasksView(root,h.host); await view.ready; assert.match(root.querySelector('.tasks-group h3')!.textContent!,/Task · To do/);
  const edit=[...root.querySelectorAll('button')].find(b=>b.textContent==='Edit status and dates')!; edit.focus(); edit.click(); assert.equal(dom.window.document.activeElement?.tagName,'SELECT');
  view.controller.discard('note'); await view.close(); dom.window.close();
});

test('draft baselines and nested capture defaults detach from mutable query/host facts',async () => {
  const h=harness(), value=data(); (value.types[0].captureDefaults as any).push(['tags',['original']]); h.setData(value);
  const c=new TasksController(h.host); await c.refresh(); c.beginEdit(c.state.data!.result.rows[0]);
  const draft=c.state.drafts.get('note')!; draft.status='working';
  (value.result.rows[0].witness as any).revision='r2'; (value.types[0].witness as any).revision='type-r2'; (value.types[0].status as any).key='wrong';
  await c.save('note'); await settled(c); const edit=h.calls.find(x=>x.kind==='edit')!.input;
  assert.deepEqual(edit.witness,{entryId:'note',revision:'r1'}); assert.deepEqual(edit.typeWitness,{entryId:'type-file',revision:'type-rev'}); assert.deepEqual(edit.properties,{state:'working'});
  h.captureError(Object.assign(Error('unknown'),{commitUncertain:true})); c.state.capture.title='Capture'; await c.capture();
  const request=c.state.unconfirmedCapture!; (value.types[0].captureDefaults.at(-1)![1] as any).push('changed');
  assert.deepEqual(request.properties.tags,['original']); assert.ok(Object.isFrozen(request.properties.tags)); assert.ok(Object.isFrozen(draft.row.witness)); assert.ok(Object.isFrozen(draft.type.status)); await cleanup(c);
});

test('view retirement disables input while retained pin cleanup drains',async () => {
  const h=harness(); h.closeFailures(1); const dom=new JSDOM('<main></main>'), root=dom.window.document.querySelector('main')!;
  const view=createTasksView(root,h.host); await view.ready; const gate=deferred<void>(); h.closeWait(gate.promise);
  const closing=view.close(); await new Promise(resolve=>setImmediate(resolve));
  const title=[...root.querySelectorAll('label')].find(l=>l.textContent==='Title')!.querySelector('input')!; title.value='Late input'; title.dispatchEvent(new dom.window.Event('input')); assert.equal(view.controller.state.capture.title,'');
  assert.equal((root.firstElementChild as HTMLElement).inert,true); assert.ok([...root.querySelectorAll('input,select,button')].every(e=>(e as HTMLInputElement).disabled));
  gate.resolve(); await closing; assert.equal(root.children.length,0); dom.window.close();
});


test('failed retained pin close keeps actual runtime active and view usable; retry drains before nofail disposal',async () => {
  const h=harness(); h.closeFailures(2); const dom=new JSDOM('<main></main>'), container=dom.window.document.querySelector('main')!;
  const view=createTasksView(container,h.host); await view.ready;
  const runtime=createTabViewRuntime({id:'tasks',element:container,owner:{paneId:'pane',vaultId:'vault',vaultGeneration:1},flush:() => view.prepareClose(),dispose:() => {const result=view.destroy(); assert.equal(result,undefined);}});
  await assert.rejects(runtime.destroy(),/close failed/);
  assert.equal(runtime.phase,'active'); assert.equal(view.controller.phase,'active'); assert.equal(h.subscriptionCount(),1);
  const title=[...container.querySelectorAll('label')].find(l=>l.textContent==='Title')!.querySelector('input')!;
  assert.equal(title.disabled,false); assert.equal((container.firstElementChild as HTMLElement).inert,false);
  title.value='Retained draft'; title.dispatchEvent(new dom.window.Event('input'));
  assert.equal(view.controller.state.capture.title,'Retained draft'); await assert.rejects(runtime.destroy(),/unsaved or unconfirmed/);
  assert.equal(view.controller.phase,'active'); assert.equal(h.subscriptionCount(),1);
  const restoredTitle=[...container.querySelectorAll('label')].find(l=>l.textContent==='Title')!.querySelector('input')!;
  restoredTitle.value=''; restoredTitle.dispatchEvent(new dom.window.Event('input'));
  await runtime.destroy(); assert.equal(runtime.phase,'disposed'); assert.equal(view.controller.phase,'disposed'); assert.equal(h.subscriptionCount(),0);
  assert.equal(h.calls.filter(x=>x.kind==='close').length,3); assert.doesNotThrow(() => view.destroy()); dom.window.close();
});

test('prepare close coalesces, fences host refresh and late input, drains held query; cancellation restores subscribed view',async () => {
  const h=harness(), dom=new JSDOM('<main></main>'), container=dom.window.document.querySelector('main')!;
  const view=createTasksView(container,h.host); await view.ready; const gate=deferred<void>(); h.wait(gate.promise);
  const reading=view.refresh(); while(h.calls.filter(x=>x.kind==='query').length<2) await new Promise(resolve=>setImmediate(resolve));
  const first=view.prepareClose(); assert.equal(first,view.prepareClose()); assert.equal(view.controller.phase,'preparing');
  h.notify(); await view.refresh(); view.controller.setFilter('today'); assert.equal(view.controller.state.filter,'all');
  const title=[...container.querySelectorAll('label')].find(l=>l.textContent==='Title')!.querySelector('input')!;
  title.value='Late draft'; title.dispatchEvent(new dom.window.Event('input')); assert.equal(view.controller.state.capture.title,'');
  assert.equal(h.calls.filter(x=>x.kind==='close').length,1); view.cancelClose(); assert.equal(view.controller.phase,'preparing');
  gate.resolve(); await reading; await assert.rejects(first,/cancelled/); assert.equal(view.controller.phase,'active'); assert.equal(h.subscriptionCount(),1);
  await view.prepareClose(); assert.equal(view.controller.phase,'prepared'); assert.equal(h.subscriptionCount(),0);
  h.notify(); await view.refresh(); assert.equal(h.calls.filter(x=>x.kind==='open').length,2);
  view.cancelClose(); assert.equal(view.controller.phase,'active'); assert.equal(h.subscriptionCount(),1);
  h.notify(); await view.flush(); assert.equal(h.calls.filter(x=>x.kind==='query').length,3);
  await view.prepareClose(); const closes=h.calls.filter(x=>x.kind==='close').length; assert.equal(view.destroy(),undefined); assert.equal(h.calls.filter(x=>x.kind==='close').length,closes); dom.window.close();
});

test('capture title survives removed or invalid Type; explicit discard permits destructive runtime close',async () => {
  for (const invalid of [false,true]) {
    const h=harness(), dom=new JSDOM('<main></main>'), container=dom.window.document.querySelector('main')!;
    const view=createTasksView(container,h.host); await view.ready;
    const runtime=createTabViewRuntime({id:'tasks',element:container,owner:{paneId:'pane',vaultId:'vault',vaultGeneration:1},flush:() => view.prepareClose(),dispose:() => view.destroy()});
    const title=container.querySelector<HTMLInputElement>('.tasks-capture input')!;
    title.value='Retain my exact title '; title.dispatchEvent(new dom.window.Event('input'));
    const missing=data(); missing.types=[]; missing.result.rows=[];
    if (invalid) missing.result.typeDiagnostics=[{witness:typeWitness,code:'invalid_type_yaml'}];
    else { missing.definitions=[]; missing.result.typeWitnesses=[]; }
    h.setData(missing); await view.refresh();
    const retained=container.querySelector<HTMLInputElement>('.tasks-capture input')!;
    assert.equal(retained.value,'Retain my exact title '); assert.equal(retained.disabled,false);
    assert.match(container.textContent!,/Type is unavailable.*draft is retained/);
    assert.equal(container.querySelector<HTMLSelectElement>('.tasks-capture select')!.options.length,0);
    assert.equal(container.querySelector<HTMLButtonElement>('.tasks-capture button[type=submit]')!.disabled,true);
    container.querySelector('form.tasks-capture')!.dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
    await view.flush(); assert.equal(h.calls.filter(x=>x.kind==='create').length,0);
    assert.equal(view.hasPendingChanges(),true); await assert.rejects(runtime.destroy(),/unsaved or unconfirmed/);
    const discard=[...container.querySelectorAll('button')].find(b=>b.textContent==='Discard capture draft')!;
    assert.equal(discard.disabled,false); discard.click(); assert.equal(view.hasPendingChanges(),false);
    await runtime.destroy(); assert.equal(runtime.phase,'disposed'); assert.equal(container.children.length,0); dom.window.close();
  }
});

test('unconfirmed capture keeps reconciliation after Type loss; plain discard cannot clear uncertainty or permit replay',async () => {
  for (const found of [false,true]) {
    const h=harness(), dom=new JSDOM('<main></main>'), container=dom.window.document.querySelector('main')!;
    const view=createTasksView(container,h.host); await view.ready;
    const oldDiscard=[...container.querySelectorAll('button')].find(b=>b.textContent==='Discard capture draft')!;
    const title=container.querySelector<HTMLInputElement>('.tasks-capture input')!;
    title.value='Unconfirmed task'; title.dispatchEvent(new dom.window.Event('input'));
    h.captureError(Object.assign(Error('lost acknowledgement'),{commitUncertain:true})); await view.controller.capture();
    const request=view.controller.state.unconfirmedCapture; assert.ok(request);
    const missing=data(); missing.types=[]; missing.result.rows=[]; h.setData(missing); await view.refresh();
    oldDiscard.click(); assert.equal(view.controller.state.unconfirmedCapture,request); assert.equal(view.controller.state.capture.title,'Unconfirmed task');
    assert.equal(container.querySelector<HTMLInputElement>('.tasks-capture input')!.value,'Unconfirmed task');
    assert.equal(container.querySelector<HTMLInputElement>('.tasks-capture input')!.disabled,true);
    assert.equal([...container.querySelectorAll('button')].some(b=>b.textContent==='Discard capture draft'),false);
    const reconcile=container.querySelector('[aria-label="Unconfirmed capture"]')!;
    assert.match(reconcile.textContent!,/Unconfirmed task/); assert.equal(reconcile.querySelectorAll('button').length,2);
    await view.controller.capture(); assert.equal(h.calls.filter(x=>x.kind==='create').length,1);
    await assert.rejects(view.close(),/unsaved or unconfirmed/);
    [...container.querySelectorAll('button')].find(b=>b.textContent===(found?'I checked: task exists':'I checked: task was not created'))!.click();
    await settled(view.controller); assert.equal(view.controller.state.unconfirmedCapture,null);
    if (!found) {
      assert.equal(container.querySelector<HTMLInputElement>('.tasks-capture input')!.value,'Unconfirmed task');
      assert.equal(container.querySelector<HTMLButtonElement>('.tasks-capture button[type=submit]')!.disabled,true);
      [...container.querySelectorAll('button')].find(b=>b.textContent==='Discard capture draft')!.click();
    }
    assert.equal(view.hasPendingChanges(),false); assert.equal(h.calls.filter(x=>x.kind==='create').length,1);
    await view.close(); dom.window.close();
  }
});

test('initial empty or unsupported Tasks view still offers useful preset installation without inventing a Type',async () => {
  for (const unsupported of [false,true]) {
    const h=harness(), missing=data(); missing.types=[]; missing.result.rows=[]; h.setData(missing);
    if (unsupported) h.queryError(Error('Tasks queries are unavailable in this vault.'));
    const dom=new JSDOM('<main></main>'), container=dom.window.document.querySelector('main')!;
    const view=createTasksView(container,h.host); await view.ready;
    assert.equal(container.querySelector('.tasks-capture'),null); assert.equal(view.hasPendingChanges(),false);
    const install=[...container.querySelectorAll('button')].find(b=>b.textContent==='Install preset')!;
    assert.equal(install.disabled,false); install.click(); await view.flush(); assert.equal(h.calls.filter(x=>x.kind==='install').length,1);
    assert.equal(h.calls.filter(x=>x.kind==='create').length,0); await view.close(); dom.window.close();
  }
});
