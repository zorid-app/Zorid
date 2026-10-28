import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountCollectionPropertyPicker,mountCollectionEditor} from '../src/databases/collection-ui.ts';
import type {DatabaseCollection,DatabaseRequest,DatabaseResponse} from '../src/core/databases.ts';

const collection:DatabaseCollection={id:'abcdefghijkl',name:'Tasks',revision:'r1',deleted:false,properties:[
  {id:'texttexttext',name:'Notes',datatype:'text',options:[]},
  {id:'selectselect',name:'Status',datatype:'status',options:[{id:'optionoption',name:'Started',category:'working'}],default:'optionoption'},
]};
const reply=(next=collection):DatabaseResponse=>({collections:[next],entries:[],projection:{pending:0,issues:[]}});
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture(){const dom=new JSDOM('<!doctype html><button id="anchor">Add property</button><main></main><button id="outside">Outside</button>');const doc=dom.window.document;return{dom,doc,host:doc.querySelector('main')!,anchor:doc.querySelector<HTMLButtonElement>('#anchor')!};}
const button=(host:Element,label:string)=>{const result=[...host.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.textContent===label);assert.ok(result,`missing ${label}`);return result;};
function typeButton(host:Element,datatype:string){const node=host.querySelector<HTMLButtonElement>(`[data-datatype="${datatype}"]`);assert.ok(node);return node;}

test('creation focuses name and Enter creates one Text field without changing existing identities',async()=>{
  const f=fixture(),requests:DatabaseRequest[]=[];let saved:DatabaseCollection|undefined,closed=0;
  const editor=mountCollectionPropertyPicker(f.host,{anchor:f.anchor,service:{async request(command){requests.push(command);return reply();}},collection,isCurrent:()=>true,onSaved:async next=>{saved=next;},onClose:()=>{closed++;}});
  const name=f.host.querySelector<HTMLInputElement>('input')!;assert.equal(f.doc.activeElement,name);assert.equal(editor.element.classList.contains('is-anchored'),true);
  name.value='Description';name.dispatchEvent(new f.dom.window.Event('input'));name.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  await tick();assert.equal(requests.length,1);const request=requests[0];assert.equal(request.op,'update');if(request.op==='update'){assert.equal(request.expectedRevision,'r1');assert.deepEqual(request.properties.slice(0,2),collection.properties);assert.deepEqual(request.properties.at(-1),{name:'Description',datatype:'text',options:[]});}
  assert.equal(saved,collection);assert.equal(closed,1);assert.equal(editor.hasPendingChanges(),false);editor.destroy();f.dom.window.close();
});

test('type choice creates supported Status defaults and guards duplicate pending clicks',async()=>{
  const f=fixture(),requests:DatabaseRequest[]=[];let release!:(response:DatabaseResponse)=>void;
  const editor=mountCollectionPropertyPicker(f.host,{service:{request(command){requests.push(command);return new Promise(resolve=>{release=resolve;});}},collection,isCurrent:()=>true,onSaved:async()=>{},onClose:()=>{}});
  typeButton(f.host,'status').click();typeButton(f.host,'number').click();assert.equal(requests.length,1);assert.equal(editor.element.getAttribute('aria-busy'),'true');
  const command=requests[0];assert.equal(command.op,'update');if(command.op==='update')assert.deepEqual(command.properties.at(-1),{name:'Status 2',datatype:'status',options:[{name:'Not started',category:'not_started'},{name:'In progress',category:'working'},{name:'Done',category:'done'}]});
  release(reply());await tick();editor.destroy();f.dom.window.close();
});

test('failed creation retains immutable operation and draft through Escape/outside and retries exactly',async()=>{
  const f=fixture(),requests:DatabaseRequest[]=[];let fail=true,closed=0;
  const editor=mountCollectionPropertyPicker(f.host,{service:{async request(command){requests.push(command);if(fail){fail=false;throw new Error('Reply lost');}return reply();}},collection,isCurrent:()=>true,onSaved:async()=>{},onClose:()=>{closed++;}});
  const name=f.host.querySelector<HTMLInputElement>('input')!;name.value='Due';name.dispatchEvent(new f.dom.window.Event('input'));typeButton(f.host,'date').click();await tick();
  assert.equal(editor.hasPendingChanges(),true);assert.equal(name.value,'Due');assert.equal(name.readOnly,true);assert.equal(f.host.querySelector('[role="alert"]')?.textContent,'Reply lost');
  editor.element.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));f.doc.querySelector('#outside')!.dispatchEvent(new f.dom.window.MouseEvent('pointerdown',{bubbles:true}));assert.equal(closed,0);
  button(f.host,'Retry creation').click();await tick();assert.deepEqual(requests[0],requests[1]);assert.equal(closed,1);editor.destroy();f.dom.window.close();
});

test('pending publication remains retryable and never reports the new schema as saved',async()=>{
  const f=fixture(),requests:DatabaseRequest[]=[];let saved=0;
  const editor=mountCollectionPropertyPicker(f.host,{service:{async request(command){requests.push(command);return{...reply(),projection:{pending:1,issues:[]}};}},collection,isCurrent:()=>true,onSaved:async()=>{saved++;},onClose:()=>{throw new Error('must retain');}});
  typeButton(f.host,'number').click();await tick();assert.equal(saved,0);assert.equal(editor.hasPendingChanges(),true);button(f.host,'Retry creation').click();await tick();assert.deepEqual(requests[0],requests[1]);assert.equal(saved,0);editor.destroy();f.dom.window.close();
});

test('verified rejection allows correcting a name while uncertain failures remain immutable',async()=>{
  const f=fixture(),requests:DatabaseRequest[]=[];
  const editor=mountCollectionPropertyPicker(f.host,{service:{async request(command){requests.push(command);if(requests.length===1)throw Object.assign(new Error('Choose another name'),{source:'host',commitUncertain:false});return reply();}},collection,isCurrent:()=>true,onSaved:async()=>{},onClose:()=>{}});
  const name=f.host.querySelector<HTMLInputElement>('input')!;name.value='Notes';name.dispatchEvent(new f.dom.window.Event('input'));typeButton(f.host,'date').click();await tick();assert.equal(name.readOnly,false);assert.equal(typeButton(f.host,'date').disabled,false);
  name.value='Due';name.dispatchEvent(new f.dom.window.Event('input'));button(f.host,'Retry creation').click();await tick();assert.equal(requests.length,2);assert.notDeepEqual(requests[0],requests[1]);const command=requests[1];if(command.op==='update'){assert.equal(command.properties.at(-1)?.name,'Due');assert.equal(command.properties.at(-1)?.datatype,'date');}
  editor.destroy();f.dom.window.close();
});

test('accepted schema retries presentation callback without submitting another mutation',async()=>{
  const f=fixture();let requests=0,saves=0,closed=0;
  const editor=mountCollectionPropertyPicker(f.host,{service:{async request(){requests++;return reply();}},collection,isCurrent:()=>true,onSaved:async()=>{if(++saves===1)throw new Error('View save failed');},onClose:()=>{closed++;}});
  typeButton(f.host,'checkbox').click();await tick();button(f.host,'Retry creation').click();await tick();assert.equal(requests,1);assert.equal(saves,2);assert.equal(closed,1);editor.destroy();f.dom.window.close();
});

test('arrow keys navigate type choices while Escape only dismisses an unsent draft',()=>{
  const f=fixture();let closed=0;
  const editor=mountCollectionPropertyPicker(f.host,{service:{async request(){throw new Error('must not write');}},collection,isCurrent:()=>true,onSaved:async()=>{},onClose:()=>{closed++;}});
  const name=f.host.querySelector<HTMLInputElement>('input')!;name.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));assert.equal(f.doc.activeElement,typeButton(f.host,'text'));
  typeButton(f.host,'text').dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));assert.equal(f.doc.activeElement,typeButton(f.host,'number'));
  typeButton(f.host,'number').dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));assert.equal(f.doc.activeElement,typeButton(f.host,'multi-select'));
  name.value='Draft';name.dispatchEvent(new f.dom.window.Event('input'));editor.element.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));assert.equal(closed,1);assert.equal(editor.hasPendingChanges(),false);editor.destroy();f.dom.window.close();
});

test('stale or disposed creation never publishes a returned schema',async()=>{
  const f=fixture();let current=true,saved=0,release!:(reply:DatabaseResponse)=>void;
  const editor=mountCollectionPropertyPicker(f.host,{service:{request(){return new Promise(resolve=>{release=resolve;});}},collection,isCurrent:()=>current,onSaved:async()=>{saved++;},onClose:()=>{}});
  typeButton(f.host,'text').click();current=false;editor.destroy();release(reply());await tick();assert.equal(saved,0);assert.equal(editor.element.isConnected,false);f.dom.window.close();
});

test('focused property editing exposes only the requested field and preserves unrelated schema',async()=>{
  const f=fixture();let command:DatabaseRequest|undefined;
  const editor=mountCollectionEditor(f.host,{collection,propertyId:'selectselect',entries:[],service:{async request(request){command=request;return reply();}},isCurrent:()=>true,onSaved:async()=>{},onClose:()=>{}});
  assert.equal(editor.element.classList.contains('is-single-property'),true);assert.equal(f.host.querySelector('[data-property-id="texttexttext"]'),null);assert.equal(f.host.querySelector<HTMLInputElement>('[aria-label="Collection name"]')?.hidden,true);assert.equal(button(f.host,'Add property').hidden,true);
  const name=f.host.querySelector<HTMLInputElement>('[aria-label="Status name"]')!;assert.equal(f.doc.activeElement,name);name.value='Progress';name.dispatchEvent(new f.dom.window.Event('input'));button(f.host,'Apply').click();await tick();
  assert.equal(command?.op,'update');if(command?.op==='update'){assert.deepEqual(command.properties[0],collection.properties[0]);assert.equal(command.properties[1].id,'selectselect');assert.equal(command.properties[1].name,'Progress');assert.deepEqual(command.properties[1].options,collection.properties[1].options);assert.equal(command.properties[1].default,'optionoption');}
  editor.destroy();f.dom.window.close();
});

test('compact type conversion keeps original property identity and supports keyboard menu dismissal',async()=>{
  const f=fixture();let command:DatabaseRequest|undefined;
  const editor=mountCollectionEditor(f.host,{collection,propertyId:'texttexttext',entries:[],service:{async request(request){command=request;return reply();}},isCurrent:()=>true,onSaved:async()=>{},onClose:()=>{}});
  const toggle=f.host.querySelector<HTMLButtonElement>('.collection-property-current-type')!;toggle.click();const checkbox=typeButton(f.host,'checkbox');checkbox.focus();checkbox.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));assert.equal(f.doc.activeElement,toggle);assert.equal(toggle.getAttribute('aria-expanded'),'false');
  toggle.click();typeButton(f.host,'number').click();button(f.host,'Apply').click();await tick();assert.equal(command?.op,'update');if(command?.op==='update'){assert.equal(command.properties[0].id,'texttexttext');assert.equal(command.properties[0].datatype,'number');assert.deepEqual(command.properties[1],collection.properties[1]);}
  editor.destroy();f.dom.window.close();
});
