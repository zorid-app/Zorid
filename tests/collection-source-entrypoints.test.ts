import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountSourceChooser} from '../src/databases/collection-ui.ts';
import type {DatabaseCollection,DatabaseRequest,DatabaseResponse} from '../src/core/databases.ts';

const collection:DatabaseCollection={id:'abcdefghijkl',name:'Tasks',revision:'r1',deleted:false,properties:[]};
const reply=(collections:readonly DatabaseCollection[]=[]):DatabaseResponse=>({collections,entries:[],projection:{pending:0,issues:[]}});
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture(){const dom=new JSDOM('<!doctype html><main></main>');return{dom,doc:dom.window.document,host:dom.window.document.querySelector('main')!};}
function button(host:Element,label:string){const control=[...host.querySelectorAll<HTMLButtonElement>('button')].find(control=>control.textContent===label&&!control.closest('[hidden]'));assert.ok(control,`missing visible ${label}`);return control;}
function name(f:ReturnType<typeof fixture>){return f.host.querySelector<HTMLInputElement>('[aria-label="Collection name"]')!;}
function preset(f:ReturnType<typeof fixture>){return f.host.querySelector<HTMLSelectElement>('[aria-label="Collection preset"]')!;}
function key(f:ReturnType<typeof fixture>,target:Element,value:string){target.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true}));}
function input(f:ReturnType<typeof fixture>,value:string){name(f).value=value;name(f).dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));}

test('initial chooser exposes supported Tasks and configured creation while keeping quick empty first',async()=>{
  const f=fixture(),requests:DatabaseRequest[]=[],sources:unknown[]=[];
  const chooser=mountSourceChooser(f.host,{service:{async request(command){requests.push(command);return reply();}},isCurrent:()=>true,choose:async source=>{sources.push(source);}});
  assert.equal(f.doc.activeElement,button(f.host,'New empty data source'));key(f,f.doc.activeElement!,'ArrowDown');assert.equal(f.doc.activeElement,button(f.host,'Tasks'));
  key(f,f.doc.activeElement!,'ArrowDown');assert.equal(f.doc.activeElement,button(f.host,'New data source with options'));key(f,f.doc.activeElement!,'Enter');
  assert.equal(name(f).value,'');assert.equal(preset(f).value,'blank');assert.equal(f.doc.activeElement,name(f));assert.deepEqual(requests,[]);
  button(f.host,'Back').click();assert.equal(f.doc.activeElement,button(f.host,'New data source with options'));assert.equal(chooser.hasPendingChanges(),false);
  button(f.host,'Tasks').click();assert.equal(name(f).value,'Tasks');assert.equal(preset(f).value,'tasks');assert.equal(f.doc.activeElement,name(f));
  key(f,name(f),'Escape');assert.equal(f.doc.activeElement,button(f.host,'Tasks'));assert.equal(chooser.hasPendingChanges(),false);assert.deepEqual(sources,[]);
  chooser.destroy();f.dom.window.close();
});

test('Tasks uses the existing editable named form and matches its own returned data source',async()=>{
  const f=fixture(),requests:DatabaseRequest[]=[],sources:unknown[]=[];
  const chooser=mountSourceChooser(f.host,{service:{async request(command){requests.push(command);return reply([{...collection,id:'otherotherxx',name:'Other'},{...collection,name:'Work tasks'}]);}},isCurrent:()=>true,choose:async source=>{sources.push(source);}});
  button(f.host,'Tasks').click();input(f,'Work tasks');key(f,name(f),'Enter');await tick();
  assert.equal(requests.length,1);const command=requests[0];assert.equal(command.op,'create');if(command.op==='create'){assert.equal(command.name,'Work tasks');assert.equal(command.preset,'tasks');assert.ok(command.operationId);}
  assert.deepEqual(sources,[{kind:'collection',id:collection.id}]);chooser.destroy();f.dom.window.close();
});

test('configured form returns to the route that opened it and retains unsent raw changes',async()=>{
  const f=fixture();let cancelled=0;
  const chooser=mountSourceChooser(f.host,{service:{async request(){return reply();}},isCurrent:()=>true,choose:async()=>{},onCancel:()=>{cancelled++;}});
  button(f.host,'New data source with options').click();input(f,'Raw draft');key(f,name(f),'Escape');button(f.host,'Back').click();button(f.host,'Cancel').click();
  assert.equal(name(f).value,'Raw draft');assert.equal(cancelled,0);assert.equal(chooser.hasPendingChanges(),true);
  input(f,'');button(f.host,'Back').click();assert.equal(f.doc.activeElement,button(f.host,'New data source with options'));
  button(f.host,'Link to existing data source').click();await tick();button(f.host,'Create a collection').click();key(f,name(f),'Escape');await tick();
  assert.equal(f.doc.activeElement,button(f.host,'Create a collection'));assert.equal(f.host.querySelector('.collection-source-choices')?.hasAttribute('hidden'),true);
  chooser.destroy();f.dom.window.close();
});

test('uncertain configured creation locks its capsule and retries exactly despite changed DOM input',async()=>{
  const f=fixture(),requests:DatabaseRequest[]=[],sources:unknown[]=[];let failed=true,cancelled=0;
  const chooser=mountSourceChooser(f.host,{service:{async request(command){requests.push(command);if(failed){failed=false;throw new Error('Reply lost');}return reply([collection]);}},isCurrent:()=>true,choose:async source=>{sources.push(source);},onCancel:()=>{cancelled++;}});
  button(f.host,'Tasks').click();key(f,name(f),'Enter');await tick();assert.equal(name(f).readOnly,true);assert.equal(preset(f).disabled,true);assert.equal(button(f.host,'Back').disabled,true);assert.equal(button(f.host,'Cancel').disabled,true);
  input(f,'A different create');key(f,name(f),'Escape');button(f.host,'Back').click();key(f,name(f),'Enter');await tick();
  assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);assert.deepEqual(sources,[{kind:'collection',id:collection.id}]);assert.equal(cancelled,0);
  chooser.destroy();f.dom.window.close();
});

test('accepted creation retries only linking its captured source after a view-save failure',async()=>{
  const f=fixture(),requests:DatabaseRequest[]=[],sources:unknown[]=[];
  const chooser=mountSourceChooser(f.host,{service:{async request(command){requests.push(command);return reply([collection]);}},isCurrent:()=>true,choose:async source=>{sources.push(source);if(sources.length===1)throw new Error('View save failed');}});
  button(f.host,'Tasks').click();key(f,name(f),'Enter');await tick();assert.equal(button(f.host,'Back').disabled,true);button(f.host,'Create collection').click();await tick();
  assert.equal(requests.length,1);assert.deepEqual(sources,[{kind:'collection',id:collection.id},{kind:'collection',id:collection.id}]);chooser.destroy();f.dom.window.close();
});

test('positive pending publication retains the exact request even after a later rejection',async()=>{
  const f=fixture(),requests:DatabaseRequest[]=[];let calls=0;
  const chooser=mountSourceChooser(f.host,{service:{async request(command){requests.push(command);if(++calls===1)return{...reply([collection]),projection:{pending:1,issues:[]}};if(calls===2)throw Object.assign(new Error('Later rejected'),{source:'host',commitUncertain:false});return reply([collection]);}},isCurrent:()=>true,choose:async()=>{}});
  button(f.host,'Tasks').click();key(f,name(f),'Enter');await tick();assert.equal(name(f).readOnly,true);button(f.host,'Create collection').click();await tick();
  assert.equal(name(f).readOnly,true);input(f,'Must not replace accepted create');button(f.host,'Create collection').click();await tick();
  assert.equal(requests.length,3);assert.deepEqual(requests[0],requests[1]);assert.deepEqual(requests[1],requests[2]);chooser.destroy();f.dom.window.close();
});

test('a first definite no-commit rejection unlocks named correction with a new operation',async()=>{
  const f=fixture(),requests:DatabaseRequest[]=[];
  const chooser=mountSourceChooser(f.host,{service:{async request(command){requests.push(command);if(requests.length===1)throw Object.assign(new Error('Name rejected'),{source:'host',commitUncertain:false});return reply([{...collection,name:'Corrected'}]);}},isCurrent:()=>true,choose:async()=>{}});
  button(f.host,'Tasks').click();key(f,name(f),'Enter');await tick();assert.equal(name(f).readOnly,false);input(f,'Corrected');key(f,name(f),'Enter');await tick();
  assert.equal(requests.length,2);if(requests[0].op==='create'&&requests[1].op==='create'){assert.notEqual(requests[0].operationId,requests[1].operationId);assert.equal(requests[1].name,'Corrected');}chooser.destroy();f.dom.window.close();
});

test('unavailable and retired source choosers cannot start either direct creation route',()=>{
  const f=fixture();const unavailable=mountSourceChooser(f.host,{isCurrent:()=>true,choose:async()=>{}});assert.equal(button(f.host,'Tasks').disabled,true);assert.equal(button(f.host,'New data source with options').disabled,true);assert.ok(f.doc.activeElement?.textContent?.startsWith('Notes in your vault'));unavailable.destroy();
  let current=true;const chooser=mountSourceChooser(f.host,{service:{async request(){throw new Error('must not run');}},isCurrent:()=>current,choose:async()=>{}});current=false;button(f.host,'Tasks').click();button(f.host,'New data source with options').click();assert.equal(name(f),null);chooser.destroy();f.dom.window.close();
});

test('quick empty also retains a positively accepted pending request after a later rejection',async()=>{
  const f=fixture(),requests:DatabaseRequest[]=[];let creates=0;
  const chooser=mountSourceChooser(f.host,{service:{async request(command){requests.push(command);if(command.op==='list')return reply();if(++creates===1)return{...reply([{...collection,name:'New database'}]),projection:{pending:1,issues:[]}};if(creates===2)throw Object.assign(new Error('Later rejected'),{source:'host',commitUncertain:false});return reply([{...collection,name:'New database'}]);}},isCurrent:()=>true,choose:async()=>{}});
  button(f.host,'New empty data source').click();await tick();button(f.host,'Retry data source').click();await tick();assert.equal(button(f.host,'Tasks').disabled,true);assert.equal(chooser.hasPendingChanges(),true);
  button(f.host,'Retry data source').click();await tick();const mutations=requests.filter(command=>command.op==='create');assert.equal(mutations.length,3);assert.deepEqual(mutations[0],mutations[1]);assert.deepEqual(mutations[1],mutations[2]);assert.equal(requests.filter(command=>command.op==='list').length,1);chooser.destroy();f.dom.window.close();
});

test('a configured creation retired while awaiting its response never links into the new owner',async()=>{
  const f=fixture();let current=true,resolve!:(value:DatabaseResponse)=>void,chosen=0;
  const chooser=mountSourceChooser(f.host,{service:{request(){return new Promise(done=>{resolve=done;});}},isCurrent:()=>current,choose:async()=>{chosen++;}});
  button(f.host,'Tasks').click();key(f,name(f),'Enter');current=false;resolve(reply([collection]));await tick();assert.equal(chosen,0);chooser.destroy();f.dom.window.close();
});

for(const route of ['tasks','empty'] as const)test(`an uncertain ${route} operation survives a later definitive rejection`,async()=>{
  const f=fixture(),requests:DatabaseRequest[]=[];let attempts=0;
  const chooser=mountSourceChooser(f.host,{service:{async request(command){requests.push(command);if(command.op==='list')return reply();if(++attempts===1)throw new Error('Reply lost');if(attempts===2)throw Object.assign(new Error('Later transport admission rejected'),{source:'host',commitUncertain:false});return reply([{...collection,name:route==='tasks'?'Tasks':'New database'}]);}},isCurrent:()=>true,choose:async()=>{}});
  if(route==='tasks'){button(f.host,'Tasks').click();key(f,name(f),'Enter');}else button(f.host,'New empty data source').click();await tick();
  const retry=()=>button(f.host,route==='tasks'?'Create collection':'Retry data source').click();retry();await tick();
  assert.equal(chooser.hasPendingChanges(),true);if(route==='tasks')assert.equal(name(f).readOnly,true);else assert.equal(button(f.host,'Tasks').disabled,true);
  retry();await tick();const creates=requests.filter(command=>command.op==='create');assert.equal(creates.length,3);assert.deepEqual(creates[0],creates[1]);assert.deepEqual(creates[1],creates[2]);chooser.destroy();f.dom.window.close();
});
