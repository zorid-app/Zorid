import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {JSDOM} from 'jsdom';
import {createCalendarView,formRange,localDateTime} from '../src/calendar/view.ts';
import {Workspace} from '../src/ui/workspace.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import type {WorkBlockService,WorkBlockRead} from '../src/core/workblocks.ts';

// Node exercises the real view/library DOM. CSS rendering is an Electron gate.
registerHooks({load(url,context,next){if(url.endsWith('.css'))return{format:'module',source:'export {};',shortCircuit:true};return next(url,context);}});
const tick=async()=>{await new Promise(resolve=>setTimeout(resolve,25));};
const sample=():WorkBlockRead=>({record:'record',generation:'generation',revision:[1],created:true,deleted:false,block:{ranges:[{operation:'r',range:{start_ms:String(new Date(2026,9,17,10).getTime()),end_ms:String(new Date(2026,9,17,11).getTime()),timezone:'America/Toronto'}}],titles:[{operation:'t',title:'Planning <img src=x onerror=alert(1)>'}],taskRefs:[]},unresolved:{}});
function fixture(overrides:Partial<WorkBlockService>={}){
  const calls:{kind:string;input:any}[]=[];let value:WorkBlockRead|undefined=sample();
  const commit=(input:any)=>({operation:input.operation,revision:[2],sequence:'2'});
  const service:WorkBlockService={
    async create(input){calls.push({kind:'create',input});value={record:input.record,generation:input.generation,created:true,deleted:false,revision:[2],block:{ranges:[{operation:input.operation,range:input.range}],titles:[{operation:input.operation,title:input.title??null}],taskRefs:[]},unresolved:{}};return commit(input);},
    async read(input){calls.push({kind:'read',input});return value!;},
    async windowPage(input){calls.push({kind:'window',input});return{blocks:value?[value]:[],cursor:null,incomplete:false,watermark:'1',scanned:1,bytes:100};},
    async title(input){calls.push({kind:'title',input});value={...value!,revision:[2],block:{...value!.block!,titles:[{operation:input.operation,title:input.title}]}};return commit(input);},
    async move(input){calls.push({kind:'move',input});value={...value!,revision:[2],block:{...value!.block!,ranges:[{operation:input.operation,range:input.range}]}};return commit(input);},
    async delete(input){calls.push({kind:'delete',input});value=undefined;return commit(input);},
    async addRef(){throw Error('unused');},async removeRef(){throw Error('unused');},async changes(){return{changes:[],next:'0'};},...overrides,
  };return{service,calls,setValue(next:WorkBlockRead){value=next;}};
}
function setup(t:TestContext){
  const dom=new JSDOM('<!doctype html><body><div id="app"></div>',{url:'https://zorid.test',pretendToBeVisual:true});
  const cleanups:(()=>unknown|Promise<unknown>)[]=[];const cleanup=(fn:()=>unknown|Promise<unknown>)=>cleanups.push(fn);
  const saved=new Map<string,PropertyDescriptor|undefined>();
  const matchMedia=(media:string)=>({matches:false,media,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Element:dom.window.Element,Node:dom.window.Node,Text:dom.window.Text,Window:dom.window.Window,MutationObserver:dom.window.MutationObserver,DOMParser:dom.window.DOMParser,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),matchMedia})){
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  dom.window.matchMedia=matchMedia as any;
  t.after(async()=>{for(const clean of cleanups.reverse())await clean();dom.window.close();for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
  const host=document.querySelector<HTMLElement>('#app')!;
  const click=(text:string)=>{const button=[...host.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent===text&&!button.hidden);assert.ok(button,'button '+text);button.click();};
  const field=(text:string)=>{const label=[...host.querySelectorAll('label')].find(label=>label.firstChild?.textContent===text);assert.ok(label);return label.querySelector<HTMLInputElement>('input')!;};
  return{host,dom,click,field,cleanup};
}

test('Temporal form rejects skipped/ambiguous DST times and preserves local date in positive offset zone',()=>{
  assert.throws(()=>formRange('2026-03-08T02:30','2026-03-08T04:00','America/Toronto'));
  assert.throws(()=>formRange('2026-11-01T01:30','2026-11-01T03:00','America/Toronto'));
  assert.throws(()=>formRange('2026-10-17T11:00','2026-10-17T10:00','UTC'));
  assert.equal(localDateTime(Date.parse('2026-09-30T15:00:00Z'),'Asia/Tokyo').slice(0,10),'2026-10-01');
});
test('unsupported platform displays useful message without fake calendar or service writes',async t=>{
  const{host}=setup(t);const view=createCalendarView(host,undefined);assert.match(host.textContent!,/not available/);assert.equal(host.querySelector('.calendar-grid'),null);await view.flush();view.destroy();
});
test('real FullCalendar month/week/day/list navigation and safe event content',async t=>{
  const{host,click,cleanup}=setup(t),{service,calls}=fixture();const view=createCalendarView(host,service,{date:'2026-10-17'});cleanup(()=>view.destroy());await tick();
  assert.match(host.textContent!,/Planning <img/);assert.equal(host.querySelector('img'),null);
  const select=host.querySelector<HTMLSelectElement>('select')!;
  for(const type of ['timeGridWeek','timeGridDay','listWeek','dayGridMonth']){select.value=type;select.dispatchEvent(new window.Event('change'));await tick();assert.equal(select.value,type);}
  const before=calls.filter(call=>call.kind==='window').length;click('Next');await tick();click('Previous');await tick();click('Today');await tick();assert.ok(calls.filter(call=>call.kind==='window').length>before);
});
test('add form cancel creates nothing; submit uses native generation operation identity and one timed range',async t=>{
  const{host,click,field,cleanup}=setup(t),{service,calls}=fixture();const view=createCalendarView(host,service,{date:'2026-10-17'});cleanup(()=>view.destroy());await tick();
  click('Add work block');await assert.rejects(view.flush(),/Save or cancel/);click('Cancel');assert.equal(calls.some(call=>call.kind==='create'),false);await view.flush();
  click('Add work block');field('Title').value='Focus';field('Start').value='2026-10-17T12:00';field('End').value='2026-10-17T13:00';field('Time zone').value='America/Toronto';click('Add block');await tick();
  const creates=calls.filter(call=>call.kind==='create');assert.equal(creates.length,1);assert.equal(creates[0].input.operation,creates[0].input.generation);assert.equal(creates[0].input.range.end_ms,'1792256400000');assert.equal(host.querySelector<HTMLElement>('.calendar-editor')!.hidden,true);await view.flush();
});
test('edit title/time use actual read revision; delete requires explicit confirmation',async t=>{
  const{host,click,field,cleanup}=setup(t),{service,calls}=fixture();const view=createCalendarView(host,service,{date:'2026-10-17'});cleanup(()=>view.destroy());await tick();
  const event=()=>{const event=[...host.querySelectorAll<HTMLElement>('.calendar-grid [tabindex]')].find(node=>node.textContent?.includes('Planning'));assert.ok(event);event.click();};
  event();await tick();field('Title').value='Review';click('Save title');await tick();assert.deepEqual(calls.find(call=>call.kind==='title')!.input.expectedRevision,[1]);
  const current=[...host.querySelectorAll<HTMLElement>('.calendar-grid [tabindex]')].find(node=>node.textContent?.includes('Review'));assert.ok(current);current.click();await tick();field('Start').value='2026-10-17T14:00';field('End').value='2026-10-17T15:30';click('Save time');await tick();assert.equal(calls.filter(call=>call.kind==='move').length,1);assert.deepEqual(calls.find(call=>call.kind==='move')!.input.expectedRevision,[2]);
  const updated=[...host.querySelectorAll<HTMLElement>('.calendar-grid [tabindex]')].find(node=>node.textContent?.includes('Review'));updated!.click();await tick();click('Delete block');assert.equal(calls.some(call=>call.kind==='delete'),false);click('Keep block');assert.equal(calls.some(call=>call.kind==='delete'),false);click('Delete block');click('Confirm delete');await tick();assert.equal(calls.filter(call=>call.kind==='delete').length,1);
});
test('uncertain form visibly retains exact request, blocks close, disables editing and explicit retry recovers',async t=>{
  const{host,click,field,cleanup}=setup(t);const requests:unknown[]=[];const{service}=fixture({async create(input){requests.push(input);if(requests.length===1)throw Error('transport lost');return{operation:input.operation,revision:[2],sequence:'2'};}});
  const view=createCalendarView(host,service,{date:'2026-10-17'});cleanup(()=>view.destroy());click('Add work block');field('Title').value='Pending';click('Add block');await tick();
  assert.match(host.textContent!,/unconfirmed/);assert.equal(field('Title').disabled,true);await assert.rejects(view.flush());click('Retry pending change');await tick();assert.equal(requests[0],requests[1]);await view.flush();
});
test('Workspace Calendar parks/restores through notes, keeps Live Edit default and closes cleanly',async t=>{
  const{host,cleanup}=setup(t),{service}=fixture();const workspace=new Workspace(host);cleanup(async()=>workspace.destroy());await workspace.start({adapter:new MemoryAdapter({'A.md':'Alpha'}),id:'test:calendar',label:'Test',workBlocks:service});
  await(workspace as any).openCalendar();await tick();const pane=workspace.activePane,calendar=pane.calendarView;assert.ok(calendar);assert.equal(pane.tabs.find(tab=>tab.id===pane.active)!.kind,'calendar');
  await workspace.openNote('A.md',true);assert.equal(pane.calendarView,undefined);const tab=pane.tabs.find(tab=>tab.kind==='calendar')!;await(workspace as any).selectTab(pane,tab);assert.equal(pane.calendarView,calendar);
  await(workspace as any).toggleReading();assert.equal(tab.mode,'reading');await workspace.openNote('A.md');assert.equal(pane.tabs.find(tab=>tab.id===pane.active)!.mode,'live');
});
