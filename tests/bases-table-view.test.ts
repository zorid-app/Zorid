import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBaseTableView } from '../src/bases/table-view.ts';
import type { BaseTableOptions, BaseTableEdit } from '../src/bases/table-view.ts';
import type { BaseQueryResult, BaseQueryRow } from '../src/bases/query.ts';

const tick = () => new Promise<void>(done => setTimeout(done, 0));
function result(count = 2): BaseQueryResult {
  const rows: BaseQueryRow[] = Array.from({length:count}, (_,i) => ({path:`Note ${i}.md`, values:{'file.name':{type:'string',value:`Note ${i}`},'note.score':{type:'number',value:i},'note.done':{type:'boolean',value:false},'formula.total':{type:'number',value:2*i}}}));
  return {version:1,view:{type:'table',name:'Table'},rows,groups:[{key:null,rows}],groupOptions:[],properties:['file.name','note.score','note.done','formula.total'],availableProperties:[],counts:{scanned:count,matched:count,afterGroupOrder:count,afterSearch:count,returned:count},diagnostics:[]};
}
function setup(next = result(), extra: Partial<BaseTableOptions> = {}) {
  const dom = new JSDOM('<body><main></main></body>',{pretendToBeVisual:true});
  const container = dom.window.document.querySelector('main')!;
  const opened: [string, MouseEvent|KeyboardEvent][] = [], writes: BaseTableEdit[] = [];
  const view = createBaseTableView(container,{result:next,openFile:(path,event)=>opened.push([path,event]),editProperty:async edit=>{writes.push(edit);},...extra});
  const cell = (property:string,path='Note 0.md') => Array.from(container.querySelectorAll<HTMLElement>('[role=gridcell]')).find(el=>el.dataset.path===path&&el.dataset.property===property)!;
  const key = (element:Element,key:string,extra:KeyboardEventInit={}) => element.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra}));
  return {dom,container,view,opened,writes,cell,key,close(){view.destroy();dom.window.close();}};
}

test('table uses immutable visible property order and host labels without interpreting markup', () => {
  const data = result(); Object.freeze(data.rows); Object.freeze(data.properties);
  const ui = setup(data,{getPropertyLabel:p=>p==='note.score'?'<b>Effort</b>':p});
  assert.deepEqual(Array.from(ui.container.querySelectorAll('[role=columnheader]'),x=>x.textContent),['file.name','<b>Effort</b>','note.done','formula.total']);
  assert.equal(ui.container.querySelector('b'),null);
  assert.equal(ui.cell('formula.total').getAttribute('aria-readonly'),'true');
  assert.equal(ui.cell('note.score').getAttribute('aria-readonly'),'false'); ui.close();
});

test('file opening preserves exact modifier and middle-click events', () => {
  const ui=setup(), link=ui.cell('file.name').querySelector('a')!;
  const event=new ui.dom.window.MouseEvent('click',{bubbles:true,cancelable:true,metaKey:true,shiftKey:true}); link.dispatchEvent(event);
  assert.equal(ui.opened[0][0],'Note 0.md'); assert.equal(ui.opened[0][1],event); assert.equal(event.defaultPrevented,true);
  link.dispatchEvent(new ui.dom.window.MouseEvent('auxclick',{button:1,bubbles:true,cancelable:true})); assert.equal(ui.opened.length,2); ui.close();
});

test('numeric invalid draft remains editable and composition Enter cannot write', async () => {
  const ui=setup(); ui.key(ui.cell('note.score'),'Enter'); const input=ui.cell('note.score').querySelector('input')!;
  input.value='not a number'; ui.key(input,'Enter'); await tick(); assert.equal(ui.writes.length,0); assert.equal(input.value,'not a number'); assert.equal(input.getAttribute('aria-invalid'),'true');
  input.value='23'; ui.key(input,'Enter',{isComposing:true}); assert.equal(ui.writes.length,0);
  ui.key(input,'Enter'); await tick(); assert.deepEqual(ui.writes,[{version:1,path:'Note 0.md',property:'note.score',value:{type:'number',value:23}}]);
  // A callback is a request, not authoritative query data. No fake optimistic result.
  assert.equal(ui.cell('note.score').textContent,'0'); ui.close();
});

test('async rejected write retains draft for retry and repeated Enter cannot duplicate pending write', async () => {
  let reject!: (e:Error)=>void; const pending=new Promise<void>((_,fail)=>reject=fail); let calls=0;
  const ui=setup(result(),{editProperty:async()=>{calls++;await pending;}});
  ui.key(ui.cell('note.score'),'Enter'); const input=ui.cell('note.score').querySelector('input')!; input.value='2';
  ui.key(input,'Enter'); ui.key(input,'Enter'); assert.equal(calls,1); reject(new Error('Version changed')); await tick();
  assert.equal(input.disabled,false); assert.equal(input.value,'2'); assert.match(ui.container.textContent!,/Version changed/); ui.close();
});

test('result replacement invalidates drafts and late errors cannot overwrite new result state', async () => {
  let reject!: (e:Error)=>void; const pending=new Promise<void>((_,fail)=>reject=fail);
  const ui=setup(result(),{editProperty:async()=>pending}); ui.key(ui.cell('note.score'),'Enter'); const input=ui.cell('note.score').querySelector('input')!; input.value='4';ui.key(input,'Enter');
  ui.view.update({...result(),version:2}); reject(new Error('old failure'));await tick();
  assert.doesNotMatch(ui.container.textContent!,/old failure/); assert.equal(ui.cell('note.score').querySelector('input'),null); ui.close();
});

test('checkbox writes once on first click; absent capabilities and non-Markdown files stay read-only', async () => {
  const ui=setup();ui.cell('note.done').querySelector('input')!.click();await tick();assert.deepEqual(ui.writes[0].value,{type:'boolean',value:true});ui.close();
  const readOnly=setup(result(),{editProperty:undefined}); assert.equal(readOnly.cell('note.done').querySelector('input')!.disabled,true);readOnly.key(readOnly.cell('note.score'),'Enter');assert.equal(readOnly.cell('note.score').querySelector('input'),null);readOnly.close();
  const data=result(1), row={...data.rows[0],path:'Image.png'};const binary=setup({...data,rows:[row],groups:[{key:null,rows:[row]}]});assert.equal(binary.cell('note.score','Image.png').getAttribute('aria-readonly'),'true');binary.close();
});

test('large results mount bounded rows and use source-defined fixed height multipliers', async () => {
  const ui=setup({...result(10000),view:{type:'table',name:'Tall',rowHeight:'tall'}});
  const grid=ui.container.querySelector<HTMLElement>('[role=grid]')!;
  assert.equal(grid.style.getPropertyValue('--zorid-base-row-height'),'120px');
  assert.ok(ui.container.querySelectorAll('[role=gridcell]').length<=60);
  grid.scrollTop=600000;grid.dispatchEvent(new ui.dom.window.Event('scroll'));await new Promise(done=>setTimeout(done,30));
  assert.ok(ui.cell('file.name','Note 5000.md'));assert.ok(ui.container.querySelectorAll('[role=gridcell]').length<=60);ui.close();
});

test('groups collapse and keyboard movement skips group headings', () => {
  const data=result(),ui=setup({...data,groups:[{key:{type:'string',value:'Open'},rows:[data.rows[0]]},{key:{type:'null'},rows:[data.rows[1]]}]});
  assert.match(ui.container.textContent!,/Open \(1\)/);assert.match(ui.container.textContent!,/Empty \(1\)/);
  ui.cell('note.score').focus();ui.key(ui.cell('note.score'),'ArrowDown');assert.equal((ui.dom.window.document.activeElement as HTMLElement).dataset.path,'Note 1.md');
  ui.container.querySelector<HTMLButtonElement>('.zorid-bases-table-group button')!.click();assert.equal(ui.cell('file.name'),undefined);assert.ok(ui.cell('file.name','Note 1.md'));ui.close();
});

test('destroy removes owned elements and stale links cannot reopen files', () => {
  const ui=setup(),link=ui.cell('file.name').querySelector('a')!;ui.view.destroy();link.dispatchEvent(new ui.dom.window.MouseEvent('click',{bubbles:true,cancelable:true}));assert.equal(ui.opened.length,0);assert.equal(ui.container.childElementCount,0);ui.view.update(result());assert.equal(ui.container.childElementCount,0);ui.dom.window.close();
});

test('namespace file values and unsupported typed values cannot crash the complete table', () => {
  const data=result(1),row:BaseQueryRow={path:'Note.md',values:{'file.file':{type:'namespace',name:'Note.md',get:()=>{throw new Error('must not call host getter');}},'formula.duration':{type:'duration',years:0,months:0,days:1,hours:0,minutes:0,seconds:0,milliseconds:0}}};
  const ui=setup({...data,rows:[row],groups:[{key:null,rows:[row]}],properties:['file.file','formula.duration']});
  assert.equal(ui.cell('file.file','Note.md').textContent,'Note.md');assert.match(ui.cell('formula.duration','Note.md').textContent!,/Error:.*duration/);ui.close();
});

test('scroll keeps the active draft mounted and cancel does not write', async () => {
  const ui=setup(result(1000));ui.key(ui.cell('note.score'),'Enter');const input=ui.cell('note.score').querySelector('input')!;input.value='draft';
  const grid=ui.container.querySelector<HTMLElement>('[role=grid]')!;grid.scrollTop=9000;grid.dispatchEvent(new ui.dom.window.Event('scroll'));await new Promise(done=>setTimeout(done,30));
  assert.equal(input.isConnected,true);assert.equal(input.value,'draft');ui.key(input,'Escape');await tick();assert.equal(ui.writes.length,0);assert.equal(input.isConnected,false);ui.close();
});

test('null and empty text cells do not write on unchanged Enter or blur', async () => {
  for (const value of [{type:'null'} as const,{type:'string',value:''} as const,{type:'number',value:0} as const]) {
    const data=result(1),row={...data.rows[0],values:{...data.rows[0].values,'note.score':value}};
    const ui=setup({...data,rows:[row],groups:[{key:null,rows:[row]}]});
    if (value.type === 'null') assert.equal(ui.cell('note.score').textContent,'');
    ui.key(ui.cell('note.score'),'Enter');
    const input=ui.cell('note.score').querySelector('input')!;assert.equal(input.value,value.type==='number'?'0':'');ui.key(input,'Enter');await tick();assert.equal(ui.writes.length,0);
    ui.key(ui.cell('note.score'),'Enter');ui.cell('note.score').querySelector('input')!.dispatchEvent(new ui.dom.window.FocusEvent('blur'));await tick();assert.equal(ui.writes.length,0);ui.close();
  }
});

test('identical snapshot refresh preserves draft; replacing a snapshot announces cancellation', () => {
  const data=result(),ui=setup(data);ui.key(ui.cell('note.score'),'Enter');const input=ui.cell('note.score').querySelector('input')!;input.value='77';
  ui.view.update(data);assert.equal(input.isConnected,true);assert.equal(input.value,'77');
  ui.view.update({...data,version:2});assert.equal(input.isConnected,false);assert.match(ui.container.querySelector('[role=status]')!.textContent!,/edit was cancelled/);ui.close();
});

test('leaving an unchanged or saved cell does not steal focus from another control', async () => {
  const ui=setup(),button=ui.dom.window.document.createElement('button');ui.dom.window.document.body.append(button);
  ui.key(ui.cell('note.score'),'Enter');button.focus();await tick();assert.equal(ui.dom.window.document.activeElement,button);assert.equal(ui.writes.length,0);
  ui.key(ui.cell('note.score'),'Enter');ui.cell('note.score').querySelector('input')!.value='4';button.focus();await tick();assert.equal(ui.dom.window.document.activeElement,button);assert.equal(ui.writes.length,1);ui.close();
});

test('collapsing a focused group keeps keyboard focus and moves the grid tab stop to a visible row', () => {
  const data=result(),ui=setup({...data,groups:[{key:{type:'string',value:'A'},rows:[data.rows[0]]},{key:{type:'string',value:'B'},rows:[data.rows[1]]}]});
  const button=ui.container.querySelector<HTMLButtonElement>('[data-group-button="0"]')!;button.focus();button.click();
  const active=ui.dom.window.document.activeElement!;assert.equal(active.getAttribute('data-group-button'),'0');assert.equal(active.getAttribute('aria-expanded'),'false');
  assert.equal(ui.cell('file.name','Note 1.md').tabIndex,0);ui.close();
});

test('untouched multiline text retains LF, CRLF and CR values without writes', async () => {
  for (const text of ['first\nsecond','first\r\nsecond','first\rsecond']) {
    const data=result(1),row={...data.rows[0],values:{...data.rows[0].values,'note.score':{type:'string' as const,value:text}}};
    const ui=setup({...data,rows:[row],groups:[{key:null,rows:[row]}]});ui.key(ui.cell('note.score'),'Enter');
    const input=ui.cell('note.score').querySelector('textarea')!;assert.ok(input);ui.key(input,'Enter');await tick();assert.equal(ui.writes.length,0);
    ui.key(ui.cell('note.score'),'Enter');const edited=ui.cell('note.score').querySelector('textarea')!;edited.value='changed\nlines';ui.key(edited,'Enter');await tick();assert.deepEqual(ui.writes[0].value,{type:'string',value:'changed\nlines'});ui.close();
  }
});

test('pinned draft follows changed row geometry during resize', async () => {
  const dom=new JSDOM('<body><main></main></body>',{pretendToBeVisual:true});let resize!:()=>void;
  Object.defineProperty(dom.window,'ResizeObserver',{value:class {constructor(callback:()=>void){resize=callback;} observe(){} disconnect(){}}});
  const container=dom.window.document.querySelector('main')!,view=createBaseTableView(container,{result:result(100),openFile:()=>{},editProperty:async()=>{}});
  const cell=Array.from(container.querySelectorAll<HTMLElement>('[role=gridcell]')).find(el=>el.dataset.path==='Note 10.md'&&el.dataset.property==='note.score')!;
  cell.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));const input=cell.querySelector('input')!;input.value='draft';const row=cell.parentElement!;
  assert.equal(row.style.top,'300px');container.querySelector<HTMLElement>('[role=grid]')!.style.setProperty('--bases-table-row-height','60px');resize();await new Promise(done=>setTimeout(done,30));
  assert.equal(input.isConnected,true);assert.equal(row.style.top,'600px');assert.equal(row.style.height,'60px');assert.equal(input.value,'draft');view.destroy();dom.window.close();
});

test('empty replacement preserves cancellation notice and old group buttons stay inert', () => {
  const data=result(),ui=setup({...data,groups:[{key:{type:'string',value:'A'},rows:data.rows}]});const old=ui.container.querySelector<HTMLButtonElement>('[data-group-button]')!;
  ui.view.update({...data,version:2,groups:[{key:{type:'string',value:'B'},rows:data.rows}]});old.click();assert.equal(ui.container.querySelector('[data-group-button]')!.getAttribute('aria-expanded'),'true');
  ui.key(ui.cell('note.score'),'Enter');ui.view.update({...result(0),version:3});assert.match(ui.container.querySelector('[role=status]')!.textContent!,/edit was cancelled.*No results/);ui.close();
});
