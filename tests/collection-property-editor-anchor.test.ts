import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {mountCollectionEditor} from '../src/databases/collection-ui.ts';
import type {DatabaseCollection,DatabaseRequest} from '../src/core/databases.ts';
const collection:DatabaseCollection={id:'abcdefghijkl',name:'Tasks',revision:'schema-r1',deleted:false,properties:[{id:'texttexttext',name:'Notes',datatype:'text',options:[]},{id:'selectselect',name:'Status',datatype:'select',options:[{id:'optionoption',name:'Started',color:'blue'}],default:'optionoption'}]};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture(){
  const dom=new JSDOM('<!doctype html><button id="anchor">Header</button><main></main><button id="outside">Outside</button>'),doc=dom.window.document;
  const style=doc.createElement('style');style.textContent=readFileSync(new URL('../src/databases/collections.css',import.meta.url),'utf8');doc.head.append(style);
  const anchor=doc.querySelector<HTMLButtonElement>('#anchor')!,host=doc.querySelector('main')!;
  let left=280,bottom=200,width=200,height=120,current=true;const observed:{callback:()=>void;disconnected:boolean}[]=[];
  anchor.getBoundingClientRect=()=>({left,top:bottom-20,right:left+60,bottom,width:60,height:20,x:left,y:bottom-20,toJSON(){return{};}});
  Object.defineProperties(dom.window,{innerWidth:{value:320,writable:true},innerHeight:{value:240,writable:true}});
  Object.defineProperties(dom.window.HTMLElement.prototype,{offsetWidth:{get(){return(this as HTMLElement).classList.contains('collection-property-editor')?width:0;}},offsetHeight:{get(){return(this as HTMLElement).classList.contains('collection-property-editor')?height:0;}}});
  Object.defineProperty(dom.window,'ResizeObserver',{value:class{state:{callback:()=>void;disconnected:boolean};constructor(callback:()=>void){this.state={callback,disconnected:false};observed.push(this.state);}observe(){}disconnect(){this.state.disconnected=true;}}});
  return{dom,doc,anchor,host,observed,isCurrent:()=>current,retire(){current=false;},rect(next:{left?:number;bottom?:number;width?:number;height?:number}){left=next.left??left;bottom=next.bottom??bottom;width=next.width??width;height=next.height??height;}};
}
function button(host:Element,label:string){const node=[...host.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent===label);assert.ok(node);return node;}

test('single-property editor is anchored, viewport-clamped and remains owned by its original container',()=>{
  const f=fixture();const editor=mountCollectionEditor(f.host,{anchor:f.anchor,collection,propertyId:'selectselect',entries:[],service:{async request(){throw new Error('must not save');}},isCurrent:f.isCurrent,onSaved:async()=>{},onClose:()=>{}});
  assert.equal(editor.element.parentElement,f.host);assert.equal(editor.element.classList.contains('is-anchored'),true);assert.equal(f.dom.window.getComputedStyle(editor.element).position,'fixed');assert.equal(editor.element.style.left,'112px');assert.equal(editor.element.style.top,'112px');
  assert.equal(f.host.querySelector('[data-property-id="texttexttext"]'),null);assert.equal(f.doc.activeElement,f.host.querySelector('[aria-label="Status name"]'));
  editor.destroy();f.dom.window.close();
});

test('scroll, viewport resize and content resize reposition without replacing the active draft',()=>{
  const f=fixture(),editor=mountCollectionEditor(f.host,{anchor:f.anchor,collection,propertyId:'selectselect',entries:[],service:{async request(){throw new Error('must not save');}},isCurrent:f.isCurrent,onSaved:async()=>{},onClose:()=>{}});
  const name=f.host.querySelector<HTMLInputElement>('[aria-label="Status name"]')!;name.value='Progress';name.dispatchEvent(new f.dom.window.Event('input'));assert.equal(editor.hasPendingChanges(),true);
  f.dom.window.innerWidth=260;f.dom.window.innerHeight=180;f.dom.window.dispatchEvent(new f.dom.window.Event('resize'));assert.equal(editor.element.style.left,'52px');assert.equal(editor.element.style.top,'52px');
  f.rect({height:150});assert.equal(f.observed.length,1);f.observed[0].callback();assert.equal(editor.element.style.top,'22px');
  f.rect({left:-30,bottom:10});f.doc.dispatchEvent(new f.dom.window.Event('scroll'));assert.equal(editor.element.style.left,'8px');assert.equal(editor.element.style.top,'14px');assert.equal(f.doc.activeElement,name);assert.equal(name.value,'Progress');assert.equal(name.isConnected,true);
  editor.destroy();assert.equal(f.observed[0].disconnected,true);f.rect({left:100,bottom:100});f.dom.window.dispatchEvent(new f.dom.window.Event('resize'));f.observed[0].callback();assert.equal(editor.element.style.left,'8px');f.dom.window.close();
});

test('anchoring does not add outside dismissal and failed Apply retains its exact schema request',async()=>{
  const f=fixture(),requests:DatabaseRequest[]=[];let failed=true,closed=0;
  const editor=mountCollectionEditor(f.host,{anchor:f.anchor,collection,propertyId:'selectselect',entries:[],service:{async request(command){requests.push(command);if(failed){failed=false;throw new Error('Reply lost');}return{collections:[collection],entries:[],projection:{pending:0,issues:[]}};}},isCurrent:f.isCurrent,onSaved:async()=>{},onClose:()=>{closed++;}});
  f.doc.querySelector('#outside')!.dispatchEvent(new f.dom.window.MouseEvent('pointerdown',{bubbles:true}));assert.equal(closed,0);
  const name=f.host.querySelector<HTMLInputElement>('[aria-label="Status name"]')!;name.value='Progress';name.dispatchEvent(new f.dom.window.Event('input'));button(f.host,'Apply').click();await tick();
  assert.equal(name.value,'Progress');assert.equal(f.host.querySelector('[role="alert"]')?.textContent,'Reply lost');assert.equal(editor.hasPendingChanges(),true);
  name.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(closed,0);button(f.host,'Apply').click();await tick();assert.equal(closed,1);assert.deepEqual(requests[0],requests[1]);
  if(requests[0].op==='update'){assert.deepEqual(requests[0].properties[0],collection.properties[0]);assert.equal(requests[0].properties[1].id,'selectselect');assert.equal(requests[0].properties[1].default,'optionoption');assert.deepEqual(requests[0].properties[1].options,collection.properties[1].options);}
  editor.destroy();f.dom.window.close();
});

test('missing anchors and the full manager retain their existing layout and create no positioning observer',()=>{
  const f=fixture();const options={collection,entries:[],service:{async request(){return{collections:[collection],entries:[],projection:{pending:0,issues:[]}};}},isCurrent:f.isCurrent,onSaved:async()=>{},onClose:()=>{}};
  const single=mountCollectionEditor(f.host,{...options,propertyId:'selectselect'});assert.equal(single.element.classList.contains('is-single-property'),true);assert.equal(single.element.classList.contains('is-anchored'),false);assert.equal(single.element.style.left,'');single.destroy();
  const full=mountCollectionEditor(f.host,{...options,anchor:f.anchor});assert.equal(full.element.classList.contains('is-single-property'),false);assert.equal(full.element.classList.contains('is-anchored'),false);assert.equal(full.element.style.left,'');assert.equal(f.host.querySelectorAll('.collection-property-row').length,2);assert.equal(f.observed.length,0);full.destroy();f.dom.window.close();
});

test('detached anchors and retired owners never retarget or reposition another property header',()=>{
  const f=fixture(),editor=mountCollectionEditor(f.host,{anchor:f.anchor,collection,propertyId:'selectselect',entries:[],service:{async request(){throw new Error('must not save');}},isCurrent:f.isCurrent,onSaved:async()=>{},onClose:()=>{}});
  f.anchor.remove();f.rect({left:100,bottom:10});f.doc.dispatchEvent(new f.dom.window.Event('scroll'));assert.equal(editor.element.style.left,'112px');
  f.doc.body.prepend(f.anchor);f.retire();f.dom.window.dispatchEvent(new f.dom.window.Event('resize'));assert.equal(editor.element.style.left,'112px');editor.destroy();f.dom.window.close();
});
