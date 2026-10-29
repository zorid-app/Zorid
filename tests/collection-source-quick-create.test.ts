import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountSourceChooser} from '../src/databases/collection-ui.ts';
import type {DatabaseCollection,DatabaseRequest,DatabaseResponse} from '../src/core/databases.ts';

const collection:DatabaseCollection={id:'abcdefghijkl',name:'New database',revision:'r1',deleted:false,properties:[]};
const reply=(collections:readonly DatabaseCollection[]=[]):DatabaseResponse=>({collections,entries:[],projection:{pending:0,issues:[]}});
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture(){const dom=new JSDOM('<!doctype html><main></main>');return{dom,doc:dom.window.document,host:dom.window.document.querySelector('main')!};}
function button(host:Element,label:string){const node=[...host.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent===label);assert.ok(node,`missing ${label}`);return node;}
function key(f:ReturnType<typeof fixture>,target:Element,key:string){const event=new f.dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true});target.dispatchEvent(event);return event;}

test('primary focus and Enter create a usable empty collection without another form',async()=>{
  const f=fixture(),requests:DatabaseRequest[]=[],sources:unknown[]=[];
  const chooser=mountSourceChooser(f.host,{service:{async request(command){requests.push(command);return command.op==='list'?reply():reply([collection]);}},isCurrent:()=>true,choose:async source=>{sources.push(source);}});
  const primary=button(f.host,'New empty data source');assert.equal(f.doc.activeElement,primary);key(f,primary,'Enter');key(f,primary,'Enter');await tick();
  assert.deepEqual(requests.map(request=>request.op),['list','create']);const create=requests[1];assert.equal(create.op,'create');if(create.op==='create'){assert.equal(create.name,'New database');assert.equal(create.preset,'blank');assert.ok(create.operationId);}
  assert.deepEqual(sources,[{kind:'collection',id:collection.id}]);assert.equal(chooser.hasPendingChanges(),false);chooser.destroy();f.dom.window.close();
});

test('quick creation retains exact operation after an uncertain reply and fences alternate sources',async()=>{
  const f=fixture(),requests:DatabaseRequest[]=[],sources:unknown[]=[];let fail=true;
  const chooser=mountSourceChooser(f.host,{service:{async request(command){requests.push(command);if(command.op==='create'&&fail){fail=false;throw new Error('Reply lost');}return command.op==='list'?reply():reply([collection]);}},isCurrent:()=>true,choose:async source=>{sources.push(source);}});
  button(f.host,'New empty data source').click();await tick();assert.equal(chooser.hasPendingChanges(),true);assert.equal(button(f.host,'Link to existing data source').disabled,true);assert.equal(f.host.querySelector<HTMLButtonElement>('button')?.disabled,false);
  button(f.host,'Retry data source').click();await tick();const creates=requests.filter(request=>request.op==='create');assert.deepEqual(creates[0],creates[1]);assert.equal(requests.filter(request=>request.op==='list').length,1);assert.deepEqual(sources,[{kind:'collection',id:collection.id}]);chooser.destroy();f.dom.window.close();
});

test('view-save failure retries the already returned source without another creation',async()=>{
  const f=fixture(),requests:DatabaseRequest[]=[],sources:unknown[]=[];
  const chooser=mountSourceChooser(f.host,{service:{async request(command){requests.push(command);return command.op==='list'?reply():reply([collection]);}},isCurrent:()=>true,choose:async source=>{sources.push(source);if(sources.length===1)throw new Error('View save failed');}});
  button(f.host,'New empty data source').click();await tick();assert.equal(f.host.querySelector('[role="alert"]')?.textContent,'View save failed');button(f.host,'Retry data source').click();await tick();assert.deepEqual(sources,[{kind:'collection',id:collection.id},{kind:'collection',id:collection.id}]);assert.equal(requests.filter(request=>request.op==='create').length,1);assert.equal(chooser.hasPendingChanges(),false);chooser.destroy();f.dom.window.close();
});

test('pending file publication retries the captured creation before linking',async()=>{
  const f=fixture(),requests:DatabaseRequest[]=[],sources:unknown[]=[];let pending=true;
  const chooser=mountSourceChooser(f.host,{service:{async request(command){requests.push(command);if(command.op==='list')return reply();if(pending){pending=false;return{...reply([collection]),projection:{pending:1,issues:[]}};}return reply([collection]);}},isCurrent:()=>true,choose:async source=>{sources.push(source);}});
  button(f.host,'New empty data source').click();await tick();assert.deepEqual(sources,[]);button(f.host,'Retry data source').click();await tick();const creates=requests.filter(request=>request.op==='create');assert.deepEqual(creates[0],creates[1]);assert.equal(sources.length,1);chooser.destroy();f.dom.window.close();
});

test('default names avoid active and trashed collections and bind the matching response',async()=>{
  const f=fixture(),requests:DatabaseRequest[]=[],sources:unknown[]=[];const created={...collection,id:'newnewnewnew',name:'New database 3'};
  const chooser=mountSourceChooser(f.host,{service:{async request(command){requests.push(command);return command.op==='list'?reply([collection,{...collection,id:'deletedentry',name:'NEW DATABASE 2',deleted:true}]):reply([collection,created]);}},isCurrent:()=>true,choose:async source=>{sources.push(source);}});
  button(f.host,'New empty data source').click();await tick();const create=requests[1];if(create.op==='create')assert.equal(create.name,'New database 3');assert.deepEqual(sources,[{kind:'collection',id:'newnewnewnew'}]);chooser.destroy();f.dom.window.close();
});

test('choice-list arrows and Escape work without swallowing custom-name input keys',async()=>{
  const f=fixture();let closed=0;
  const chooser=mountSourceChooser(f.host,{service:{async request(){return reply();}},isCurrent:()=>true,choose:async()=>{},onCancel:()=>{closed++;}});
  const primary=button(f.host,'New empty data source');key(f,primary,'ArrowDown');assert.equal(f.doc.activeElement,button(f.host,'Tasks'));key(f,f.doc.activeElement!,'End');assert.ok(f.doc.activeElement?.textContent?.startsWith('Notes in your vault'));key(f,f.doc.activeElement!,'Home');assert.equal(f.doc.activeElement,primary);key(f,primary,'Escape');assert.equal(closed,1);
  button(f.host,'Link to existing data source').click();await tick();button(f.host,'Create a collection').click();const name=f.host.querySelector<HTMLInputElement>('[aria-label="Collection name"]')!;assert.equal(key(f,name,'ArrowDown').defaultPrevented,false);assert.equal(closed,1);chooser.destroy();f.dom.window.close();
});

test('unavailable collections leave browsing available; retired owners cannot create',async()=>{
  const f=fixture(),sources:unknown[]=[];
  const unavailable=mountSourceChooser(f.host,{isCurrent:()=>true,choose:async source=>{sources.push(source);}});assert.equal(button(f.host,'New empty data source').disabled,true);assert.equal(button(f.host,'Link to existing data source').disabled,true);assert.ok(f.doc.activeElement?.textContent?.startsWith('Notes in your vault'));assert.match(f.host.textContent??'',/Collections are unavailable/);unavailable.destroy();
  let current=true,release!:(response:DatabaseResponse)=>void;const requests:DatabaseRequest[]=[];
  const chooser=mountSourceChooser(f.host,{service:{request(command){requests.push(command);return new Promise(resolve=>{release=resolve;});}},isCurrent:()=>current,choose:async source=>{sources.push(source);}});button(f.host,'New empty data source').click();current=false;release(reply());await tick();assert.deepEqual(requests,[{op:'list'}]);assert.deepEqual(sources,[]);chooser.destroy();f.dom.window.close();
});

test('a definite create rejection permits fresh name planning without abandoning uncertainty',async()=>{
  const f=fixture(),requests:DatabaseRequest[]=[];let creates=0;
  const chooser=mountSourceChooser(f.host,{service:{async request(command){requests.push(command);if(command.op==='list')return reply(creates?[collection]:[]);if(++creates===1)throw Object.assign(new Error('Name taken'),{source:'host',commitUncertain:false});return reply([{...collection,name:'New database 2'}]);}},isCurrent:()=>true,choose:async()=>{}});
  button(f.host,'New empty data source').click();await tick();assert.equal(chooser.hasPendingChanges(),false);button(f.host,'Retry data source').click();await tick();const mutations=requests.filter(request=>request.op==='create');assert.equal(mutations.length,2);assert.notEqual(mutations[0].operationId,mutations[1].operationId);assert.equal(mutations[1].name,'New database 2');chooser.destroy();f.dom.window.close();
});

test('an owner retired during creation never attaches the committed source to another view',async()=>{
  const f=fixture();let current=true,release!:(response:DatabaseResponse)=>void,chosen=0;
  const chooser=mountSourceChooser(f.host,{service:{request(command){return command.op==='list'?Promise.resolve(reply()):new Promise(resolve=>{release=resolve;});}},isCurrent:()=>current,choose:async()=>{chosen++;}});
  button(f.host,'New empty data source').click();await tick();current=false;release(reply([collection]));await tick();assert.equal(chosen,0);chooser.destroy();f.dom.window.close();
});
