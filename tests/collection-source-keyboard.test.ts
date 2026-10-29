import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountSourceChooser} from '../src/databases/collection-ui.ts';
import type {DatabaseCollection,DatabaseRequest,DatabaseResponse} from '../src/core/databases.ts';

const first:DatabaseCollection={id:'abcdefghijkl',name:'Books',revision:'r1',deleted:false,properties:[]};
const second:DatabaseCollection={...first,id:'mnopqrstuvwx',name:'Tasks'};
const reply=(collections:readonly DatabaseCollection[]=[]):DatabaseResponse=>({collections,entries:[],projection:{pending:0,issues:[]}});
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture(){const dom=new JSDOM('<!doctype html><button id="outside">Outside</button><main></main>');return{dom,doc:dom.window.document,host:dom.window.document.querySelector('main')!};}
function button(host:Element,label:string){const node=[...host.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent===label);assert.ok(node,`missing ${label}`);return node;}
function key(f:ReturnType<typeof fixture>,target:Element,value:string,extra:KeyboardEventInit={}){const event=new f.dom.window.KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true,...extra});target.dispatchEvent(event);return event;}

test('existing-source list receives focus and complete keyboard navigation after initial choices hide',async()=>{
  const f=fixture();let cancelled=0;
  const chooser=mountSourceChooser(f.host,{service:{async request(){return reply([first,{...second,id:'deletedentry',deleted:true},second]);}},isCurrent:()=>true,choose:async()=>{},onCancel:()=>{cancelled++;}});
  key(f,button(f.host,'New empty data source'),'ArrowDown');key(f,f.doc.activeElement!,'ArrowDown');key(f,f.doc.activeElement!,'ArrowDown');key(f,f.doc.activeElement!,'Enter');await tick();
  const create=button(f.host,'Create a collection'),back=button(f.host,'Back');
  assert.equal(f.doc.activeElement,create);
  key(f,create,'ArrowDown');assert.equal(f.doc.activeElement,button(f.host,'Books'));
  key(f,f.doc.activeElement!,'ArrowDown');assert.equal(f.doc.activeElement,button(f.host.querySelector('.collection-source-existing')!,'Tasks'));
  key(f,f.doc.activeElement!,'End');assert.equal(f.doc.activeElement,back);
  key(f,back,'Home');assert.equal(f.doc.activeElement,create);
  key(f,create,'ArrowUp');assert.equal(f.doc.activeElement,back);
  key(f,back,'Escape');assert.equal(f.doc.activeElement,button(f.host,'Link to existing data source'));
  assert.equal(chooser.hasPendingChanges(),false);assert.equal(cancelled,0);
  key(f,f.doc.activeElement!,'Escape');assert.equal(cancelled,1);
  chooser.destroy();f.dom.window.close();
});

test('keyboard source selection keeps its focus and error after choose fails',async()=>{
  const f=fixture();const chosen:unknown[]=[];
  const chooser=mountSourceChooser(f.host,{service:{async request(){return reply([first]);}},isCurrent:()=>true,choose:async source=>{chosen.push(source);throw new Error('Base save failed');}});
  button(f.host,'Link to existing data source').click();await tick();
  key(f,f.doc.activeElement!,'ArrowDown');const books=button(f.host,'Books');key(f,books,'Enter');await tick();
  assert.deepEqual(chosen,[{kind:'collection',id:first.id}]);assert.equal(f.doc.activeElement,books);
  key(f,books,'Escape');assert.equal(f.host.querySelector('.collection-source-choices')?.hasAttribute('hidden'),true);
  assert.equal(f.host.querySelector('[role="alert"]')?.textContent,'Base save failed');assert.equal(chooser.hasPendingChanges(),true);
  chooser.destroy();f.dom.window.close();
});

test('async source loading does not take focus back from an outside interaction or retired owner',async()=>{
  const f=fixture();let resolve!:(value:DatabaseResponse)=>void,current=true;
  const chooser=mountSourceChooser(f.host,{service:{request(){return new Promise(done=>{resolve=done;});}},isCurrent:()=>current,choose:async()=>{}});
  button(f.host,'Link to existing data source').click();const outside=f.doc.querySelector<HTMLButtonElement>('#outside')!;outside.focus();resolve(reply([first]));await tick();
  assert.equal(f.doc.activeElement,outside);
  button(f.host,'Back').click();button(f.host,'Link to existing data source').click();current=false;outside.focus();resolve(reply([first]));await tick();
  assert.equal(f.doc.activeElement,outside);assert.equal(key(f,button(f.host,'Create a collection'),'ArrowDown').defaultPrevented,false);
  chooser.destroy();f.dom.window.close();
});

test('an outside pointer intent keeps body focus after a disabled control loses focus during loading',async()=>{
  const f=fixture();let resolve!:(value:DatabaseResponse)=>void;
  const chooser=mountSourceChooser(f.host,{service:{request(){return new Promise(done=>{resolve=done;});}},isCurrent:()=>true,choose:async()=>{}});
  button(f.host,'Link to existing data source').click();
  f.doc.querySelector('#outside')!.dispatchEvent(new f.dom.window.Event('pointerdown',{bubbles:true}));
  f.doc.body.tabIndex=-1;f.doc.body.focus();resolve(reply([first]));await tick();
  assert.equal(f.doc.activeElement,f.doc.body);
  chooser.destroy();f.dom.window.close();
});

test('custom name Enter ignores active composition, composing key events, IME229 and modifiers',async()=>{
  const f=fixture(),requests:DatabaseRequest[]=[],chosen:unknown[]=[];
  const chooser=mountSourceChooser(f.host,{service:{async request(command){requests.push(command);return command.op==='list'?reply():reply([{...first,name:'日本語'}]);}},isCurrent:()=>true,choose:async source=>{chosen.push(source);}});
  button(f.host,'Link to existing data source').click();await tick();button(f.host,'Create a collection').click();
  const name=f.host.querySelector<HTMLInputElement>('[aria-label="Collection name"]')!;name.value='日本語';
  name.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart',{bubbles:true}));assert.equal(key(f,name,'Enter').defaultPrevented,false);
  name.dispatchEvent(new f.dom.window.CompositionEvent('compositionend',{bubbles:true}));
  for(const extra of [{isComposing:true},{keyCode:229},{ctrlKey:true},{metaKey:true},{altKey:true},{shiftKey:true}])assert.equal(key(f,name,'Enter',extra).defaultPrevented,false);
  for(const value of ['Home','End','ArrowDown','ArrowUp'])assert.equal(key(f,name,value).defaultPrevented,false);
  assert.equal(requests.filter(command=>command.op==='create').length,0);
  const preset=f.host.querySelector<HTMLSelectElement>('[aria-label="Collection preset"]')!;preset.focus();
  assert.equal(key(f,preset,'Escape').defaultPrevented,false);assert.equal(preset.isConnected,true);name.focus();
  key(f,name,'Enter');await tick();assert.equal(requests.filter(command=>command.op==='create').length,1);assert.deepEqual(chosen,[{kind:'collection',id:first.id}]);
  chooser.destroy();f.dom.window.close();
});

test('clean create Escape returns focus to source list while raw input and failed create remain retained',async()=>{
  const f=fixture();const chooser=mountSourceChooser(f.host,{service:{async request(command){if(command.op==='create')throw new Error('Reply lost');return reply();}},isCurrent:()=>true,choose:async()=>{}});
  button(f.host,'Link to existing data source').click();await tick();button(f.host,'Create a collection').click();
  let name=f.host.querySelector<HTMLInputElement>('[aria-label="Collection name"]')!;key(f,name,'Escape');await tick();assert.equal(f.doc.activeElement,button(f.host,'Create a collection'));
  button(f.host,'Create a collection').click();name=f.host.querySelector<HTMLInputElement>('[aria-label="Collection name"]')!;name.value='Unsaved name';
  key(f,name,'Escape');assert.equal(f.doc.activeElement,name);assert.equal(name.value,'Unsaved name');
  key(f,name,'Enter');await tick();key(f,name,'Escape');assert.equal(name.isConnected,true);assert.equal(name.value,'Unsaved name');assert.equal(f.host.querySelector('[role="alert"]')?.textContent,'Reply lost');
  chooser.destroy();f.dom.window.close();
});

test('source roving ignores composition and modified keys and wraps only enabled initial choices',()=>{
  const f=fixture();let closed=0;const chooser=mountSourceChooser(f.host,{isCurrent:()=>true,choose:async()=>{},onCancel:()=>{closed++;}});
  const notes=f.doc.activeElement!;assert.ok(notes.textContent?.startsWith('Notes in your vault'));
  for(const extra of [{isComposing:true},{keyCode:229},{ctrlKey:true},{metaKey:true},{altKey:true},{shiftKey:true}])assert.equal(key(f,notes,'ArrowUp',extra).defaultPrevented,false);
  key(f,notes,'ArrowUp');assert.equal(f.doc.activeElement,notes);key(f,notes,'Escape');assert.equal(closed,1);
  chooser.destroy();f.dom.window.close();
});
