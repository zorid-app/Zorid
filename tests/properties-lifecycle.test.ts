import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {renderProperties} from '../src/ui/properties.ts';
import type {Vault} from '../src/core/vault.ts';

function setup(t:TestContext,definitions?:string){
  const dom=new JSDOM('<!doctype html><body><div id="host"></div>',{url:'https://zorid.test/'}),saved=new Map<string,PropertyDescriptor|undefined>();
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,navigator:dom.window.navigator})){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
  let source='---\n# Keep comment\nstatus: Todo\nitems: [one, two]\n---\nBody\n',fail=false,gate:Promise<void>|undefined,writes=0;
  const vault=definitions?{entries:new Map([['Properties.yaml',{path:'Properties.yaml',type:'file'}]]),read:async()=>definitions,on:()=>()=>{}} as unknown as Vault:undefined;
  const host=document.querySelector<HTMLElement>('#host')!,view=renderProperties(host,{vault,getSource:()=>source,onChange:async next=>{writes++;await gate;if(fail)throw new Error('Property save unavailable');source=next;}});
  t.after(()=>{view.destroy();dom.window.close();for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
  return{host,view,get source(){return source;},get writes(){return writes;},fail(value:boolean){fail=value;},wait(value:Promise<void>|undefined){gate=value;}};
}
function event(node:HTMLElement,type:string){node.dispatchEvent(new window.Event(type,{bubbles:true}));}
function key(node:HTMLElement,key:string){node.dispatchEvent(new window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));}
test('plain scalar and list drafts are pending without schema widget DOM markers and flush preserves them',async t=>{
  const f=setup(t),input=f.host.querySelector<HTMLInputElement>('[data-property-key="status"] .metadata-property-value input')!;
  input.value='Unsubmitted';event(input,'input');assert.equal(f.host.querySelector('[data-base-editing]'),null);assert.equal(f.view.hasPendingChanges(),true);await assert.rejects(f.view.flush(),/Finish editing/);assert.equal(input.value,'Unsubmitted');assert.equal(f.writes,0);
  key(input,'Escape');assert.equal(f.view.hasPendingChanges(),false);
  const list=f.host.querySelector<HTMLTextAreaElement>('[data-property-key="items"] textarea')!;list.value='Changed';event(list,'input');await assert.rejects(f.view.flush(),/Finish editing/);assert.equal(list.value,'Changed');assert.equal(f.writes,0);
  event(list,'change');await f.view.flush();assert.equal(f.view.hasPendingChanges(),false);assert.match(f.source,/Changed/);assert.match(f.source,/# Keep comment/);assert.match(f.source,/Body/);
});
test('accepted property queue is visible immediately and flush waits for its original save',async t=>{
  const f=setup(t);let release!:()=>void;f.wait(new Promise<void>(resolve=>{release=resolve;}));const input=f.host.querySelector<HTMLInputElement>('[data-property-key="status"] .metadata-property-value input')!;input.value='Done';event(input,'input');key(input,'Enter');assert.equal(f.view.hasPendingChanges(),true);
  let finished=false;const saving=f.view.flush().then(()=>{finished=true;});await Promise.resolve();assert.equal(finished,false);release();await saving;assert.equal(f.view.hasPendingChanges(),false);assert.match(f.source,/status: Done/);
});
test('failed property save retains draft and failure for retry, while explicit scalar cancellation stays closable',async t=>{
  const f=setup(t),input=f.host.querySelector<HTMLInputElement>('[data-property-key="status"] .metadata-property-value input')!;input.value='Retained';event(input,'input');f.fail(true);key(input,'Enter');await assert.rejects(f.view.flush(),/Property save unavailable/);assert.equal(input.isConnected,true);assert.equal(input.value,'Retained');assert.equal(f.view.hasPendingChanges(),true);assert.match(f.source,/status: Todo/);
  f.fail(false);key(input,'Enter');await f.view.flush();assert.equal(f.view.hasPendingChanges(),false);assert.match(f.source,/status: Retained/);
  const again=f.host.querySelector<HTMLInputElement>('[data-property-key="status"] .metadata-property-value input')!;again.value='Canceled';event(again,'input');f.fail(true);key(again,'Enter');await assert.rejects(f.view.flush(),/Property save unavailable/);key(again,'Escape');await f.view.flush();assert.equal(f.view.hasPendingChanges(),false);assert.match(f.source,/status: Retained/);
});
test('an unsubmitted Add property form remains pending until explicitly added or canceled',async t=>{
  const f=setup(t);f.host.querySelector<HTMLButtonElement>('.metadata-add-button')!.click();const input=f.host.querySelector<HTMLInputElement>('[aria-label="New property name"]')!;input.value='draftProperty';event(input,'input');assert.equal(f.view.hasPendingChanges(),true);await assert.rejects(f.view.flush(),/Finish editing/);assert.equal(input.value,'draftProperty');assert.equal(f.writes,0);
  [...f.host.querySelectorAll<HTMLButtonElement>('.metadata-add-form button')].find(node=>node.textContent==='Cancel')!.click();await f.view.flush();assert.equal(f.view.hasPendingChanges(),false);
});
test('schema widget acknowledgement settles before flush and a canceled failed rich draft can close',async t=>{
  const f=setup(t,'properties:\n  status:\n    type: text\n');await new Promise(resolve=>setTimeout(resolve,0));const field=f.host.querySelector<HTMLElement>('[data-property-key="status"] .metadata-property-value')!;field.click();let input=f.host.querySelector<HTMLInputElement>('input[aria-label="status"]')!;assert.ok(input);input.value='Done';event(input,'input');key(input,'Enter');await f.view.flush();assert.equal(f.view.hasPendingChanges(),false);assert.match(f.source,/status: Done/);
  field.click();input=f.host.querySelector<HTMLInputElement>('input[aria-label="status"]')!;input.value='Canceled rich draft';event(input,'input');f.fail(true);key(input,'Enter');await assert.rejects(f.view.flush(),/Property save unavailable/);assert.equal(f.view.hasPendingChanges(),true);assert.equal(input.value,'Canceled rich draft');key(input,'Escape');await Promise.resolve();await f.view.flush();assert.equal(f.view.hasPendingChanges(),false);assert.match(f.source,/status: Done/);
});
