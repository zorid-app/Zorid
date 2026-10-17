import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBaseTableView } from '../src/bases/table-view.ts';
import type { BaseQueryResult, BaseQueryRow } from '../src/bases/query.ts';
function result(count=4): BaseQueryResult {
  const rows:BaseQueryRow[]=Array.from({length:count},(_,i)=>({path:`${i}.md`,values:{'file.name':{type:'string',value:`Note ${i}`},'note.text':{type:'string',value:`Text ${i}`},'note.score':{type:'number',value:i}}}));
  return {version:1,view:{type:'table',name:'Table'},rows,groups:[{key:null,rows}],groupOptions:[],properties:['file.name','note.text','note.score'],availableProperties:[],counts:{scanned:count,matched:count,afterGroupOrder:count,afterSearch:count,returned:count},diagnostics:[]};
}
function setup(data=result()) {
  const dom=new JSDOM('<body><main></main></body>',{pretendToBeVisual:true}),container=dom.window.document.querySelector('main')!;
  const writes:unknown[]=[],opens:unknown[]=[];
  const view=createBaseTableView(container,{result:data,openFile:(...args)=>opens.push(args),editProperty:async edit=>{writes.push(edit);}});
  const cell=(row:number,column:number,group=0)=>container.querySelector<HTMLElement>(`[role=gridcell][data-row="${row}"][data-column="${column}"][data-group="${group}"]`)!;
  const key=(el:Element,key:string,extra:KeyboardEventInit={})=>el.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra}));
  const pointer=(el:Element,type:string,extra:MouseEventInit&{pointerId?:number;pointerType?:string}={})=>{
    const event=new dom.window.MouseEvent(type,{bubbles:true,cancelable:true,button:0,...extra});Object.defineProperties(event,{pointerId:{value:extra.pointerId??1},pointerType:{value:extra.pointerType??'mouse'}});el.dispatchEvent(event);return event;
  };
  const copy=(target:Element)=>{const values=new Map<string,string>();const event=new dom.window.Event('copy',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{setData:(type:string,value:string)=>values.set(type,value)}});target.dispatchEvent(event);return {event,values};};
  const selected=()=>Array.from(container.querySelectorAll<HTMLElement>('[aria-selected=true]'),el=>[Number(el.dataset.group),Number(el.dataset.row),Number(el.dataset.column)]);
  return {dom,container,view,cell,key,pointer,copy,selected,writes,opens,close(){view.destroy();dom.window.close();}};
}

test('Shift arrows expand and shrink a rectangle; Escape keeps cell navigation without editing',()=>{
  const ui=setup();ui.cell(0,1).focus();ui.key(ui.cell(0,1),'ArrowDown',{shiftKey:true});ui.key(ui.cell(1,1),'ArrowRight',{shiftKey:true});
  assert.deepEqual(ui.selected(),[[0,0,1],[0,0,2],[0,1,1],[0,1,2]]);
  ui.key(ui.cell(1,2),'Enter');assert.equal(ui.container.querySelector('input'),null);assert.equal(ui.writes.length,0);
  ui.key(ui.cell(1,2),'ArrowLeft',{shiftKey:true});assert.deepEqual(ui.selected(),[[0,0,1],[0,1,1]]);
  ui.key(ui.cell(1,1),'Escape');assert.deepEqual(ui.selected(),[]);ui.key(ui.cell(1,1),'Enter');assert.ok(ui.cell(1,1).querySelector('input'));ui.close();
});

test('Shift-click extends from active cell and plain click clears range',()=>{
  const ui=setup();ui.cell(0,0).focus();ui.cell(2,2).dispatchEvent(new ui.dom.window.MouseEvent('click',{bubbles:true,cancelable:true,shiftKey:true}));assert.equal(ui.selected().length,9);
  ui.cell(1,1).click();assert.equal(ui.selected().length,0);ui.close();
});

test('group-bounded ranges stop at boundary but ordinary movement crosses groups',()=>{
  const data=result(),ui=setup({...data,groups:[{key:{type:'string',value:'A'},rows:data.rows.slice(0,2)},{key:{type:'string',value:'B'},rows:data.rows.slice(2)}]});
  ui.cell(0,1).focus();ui.key(ui.cell(0,1),'ArrowDown',{shiftKey:true});ui.key(ui.cell(1,1),'ArrowDown',{shiftKey:true});assert.deepEqual(ui.selected(),[[0,0,1],[0,1,1]]);
  ui.key(ui.cell(1,1),'ArrowDown');assert.equal((ui.dom.window.document.activeElement as HTMLElement).dataset.group,'1');assert.equal(ui.selected().length,0);ui.close();
});

test('row, column and select-all shortcuts select only the current group',()=>{
  const data=result(),ui=setup({...data,groups:[{key:{type:'string',value:'A'},rows:data.rows.slice(0,2)},{key:{type:'string',value:'B'},rows:data.rows.slice(2)}]});
  ui.cell(1,1).focus();ui.key(ui.cell(1,1),' ',{shiftKey:true});assert.equal(ui.selected().length,3);ui.key(ui.cell(1,1),' ',{ctrlKey:true});assert.equal(ui.selected().length,6);
  ui.key(ui.cell(1,1),'Escape');ui.key(ui.cell(1,1),'a',{metaKey:true});assert.equal(ui.selected().length,6);assert.ok(ui.selected().every(point=>point[0]===0));ui.close();
});

test('copy uses quoted TSV without headers and compatible table envelope with headers',()=>{
  const data=result(2),rows=data.rows.map((row,i)=>({...row,values:{...row.values,'note.text':{type:'string' as const,value:i?'last\r\nline':'a\tb"c'}}}));
  const ui=setup({...data,rows,groups:[{key:null,rows}]});ui.cell(0,1).focus();ui.key(ui.cell(0,1),'ArrowDown',{shiftKey:true});ui.key(ui.cell(1,1),'ArrowRight',{shiftKey:true});
  const copied=ui.copy(ui.cell(1,2));assert.equal(copied.event.defaultPrevented,true);assert.equal(copied.values.get('text/plain'),'"a\tb""c"\t0\n"last\r\nline"\t1');
  assert.deepEqual(JSON.parse(copied.values.get('obsidian/table')!),{header:['text','score'],rows:[['a\tb"c','0'],['last\r\nline','1']],alignment:[null,null]});
  assert.ok(copied.values.get('text/markdown')!.includes('text'));assert.equal(copied.values.has('obsidian/bases-cells'),false);ui.close();
});

test('native text copy and composition shortcuts are left to active editor',()=>{
  const ui=setup();ui.cell(0,1).focus();ui.key(ui.cell(0,1),'a',{metaKey:true,isComposing:true});assert.equal(ui.selected().length,0);
  ui.key(ui.cell(0,1),'Enter');const input=ui.cell(0,1).querySelector('input')!;ui.key(input,'a',{metaKey:true});const copied=ui.copy(input);assert.equal(copied.event.defaultPrevented,false);assert.equal(copied.values.size,0);ui.close();
});

test('pointer drag paints a rectangle, blocks following activation and ignores touch',()=>{
  const ui=setup();ui.pointer(ui.cell(0,1),'pointerdown');ui.pointer(ui.cell(2,2),'pointermove');ui.pointer(ui.cell(2,2),'pointerup');assert.equal(ui.selected().length,6);ui.cell(2,2).click();assert.equal(ui.selected().length,6);
  ui.pointer(ui.cell(0,1),'pointerdown',{pointerType:'touch'});ui.pointer(ui.cell(3,2),'pointermove',{pointerType:'touch'});assert.equal(ui.selected().length,6);ui.close();
});

test('range survives virtual row rerender and copying includes offscreen rows',async()=>{
  const ui=setup(result(1000));ui.cell(0,1).focus();ui.key(ui.cell(0,1),' ',{ctrlKey:true});assert.equal(ui.copy(ui.cell(0,1)).values.get('text/plain')!.split('\n').length,1000);
  const grid=ui.container.querySelector<HTMLElement>('[role=grid]')!;grid.scrollTop=15000;grid.dispatchEvent(new ui.dom.window.Event('scroll'));await new Promise(done=>setTimeout(done,30));
  assert.ok(ui.selected().length>0);assert.ok(ui.selected().length<40);assert.ok(ui.selected().every(point=>point[2]===1));ui.close();
});

test('update and destroy remove drag listeners and invalidate old ranges/copy',()=>{
  const ui=setup();const old=ui.cell(0,1);ui.pointer(old,'pointerdown');ui.view.update({...result(),version:2});ui.pointer(ui.cell(2,2),'pointermove');assert.equal(ui.selected().length,0);assert.equal(ui.copy(old).event.defaultPrevented,false);
  ui.pointer(ui.cell(0,1),'pointerdown');ui.view.destroy();ui.pointer(ui.container,'pointermove');assert.equal(ui.container.children.length,0);ui.dom.window.close();
});

test('duplicate paths in distinct groups keep a single tab stop and correct copy identity',()=>{
  const data=result(1),ui=setup({...data,groups:[{key:{type:'string',value:'A'},rows:data.rows},{key:{type:'string',value:'B'},rows:data.rows}]});
  assert.equal(ui.container.querySelectorAll('[role=gridcell][tabindex="0"]').length,1);ui.cell(0,1,1).focus();ui.key(ui.cell(0,1,1),' ',{shiftKey:true});assert.ok(ui.selected().every(point=>point[0]===1));ui.close();
});

test('shift movement extends existing row or column ranges without discarding their other axis',()=>{
  const ui=setup();ui.cell(1,1).focus();ui.key(ui.cell(1,1),' ',{ctrlKey:true});ui.key(ui.cell(1,1),'ArrowRight',{shiftKey:true});
  assert.equal(ui.selected().length,8);assert.ok(ui.selected().every(point=>point[2]>=1));
  ui.key(ui.cell(1,2),'Escape');ui.key(ui.cell(1,2),' ',{shiftKey:true});ui.key(ui.cell(1,2),'ArrowDown',{shiftKey:true});assert.equal(ui.selected().length,6);ui.close();
});

test('modifier shift arrows select to group boundaries and plain modified arrows remain unhandled',()=>{
  const ui=setup();ui.cell(1,1).focus();ui.key(ui.cell(1,1),'ArrowDown',{metaKey:true,shiftKey:true});assert.deepEqual(ui.selected(),[[0,1,1],[0,2,1],[0,3,1]]);
  ui.key(ui.cell(1,1),'ArrowRight',{metaKey:true,shiftKey:true});assert.equal(ui.selected().length,6);
  const event=new ui.dom.window.KeyboardEvent('keydown',{key:'ArrowLeft',metaKey:true,bubbles:true,cancelable:true});ui.cell(1,1).dispatchEvent(event);assert.equal(event.defaultPrevented,false);ui.close();
});

test('repeated pointer Shift-click keeps original active anchor and can shrink the range',()=>{
  const ui=setup();ui.cell(0,1).focus();
  for (const row of [2,1]) {ui.pointer(ui.cell(row,1),'pointerdown',{shiftKey:true});ui.pointer(ui.cell(row,1),'pointerup',{shiftKey:true});ui.cell(row,1).dispatchEvent(new ui.dom.window.MouseEvent('click',{bubbles:true,cancelable:true,shiftKey:true}));}
  assert.deepEqual(ui.selected(),[[0,0,1],[0,1,1]]);assert.equal((ui.dom.window.document.activeElement as HTMLElement).dataset.row,'0');ui.close();
});

test('copy preserves a noncollapsed native text selection inside rendered cells',()=>{
  const ui=setup();ui.cell(0,1).focus();const range=ui.dom.window.document.createRange();range.selectNodeContents(ui.cell(0,1));const selection=ui.dom.window.getSelection()!;selection.removeAllRanges();selection.addRange(range);
  const copied=ui.copy(ui.cell(0,1));assert.equal(copied.event.defaultPrevented,false);assert.equal(copied.values.size,0);ui.close();
});

test('a direct rendered-checkbox click clears the old range and toggles once',async()=>{
  const data=result(2),rows=data.rows.map(row=>({...row,values:{...row.values,'note.score':{type:'boolean' as const,value:false}}}));const ui=setup({...data,rows,groups:[{key:null,rows}]});
  ui.cell(0,1).focus();ui.key(ui.cell(0,1),'ArrowDown',{shiftKey:true});assert.equal(ui.selected().length,2);
  const checkbox=ui.cell(1,2).querySelector('input')!;ui.pointer(checkbox,'pointerdown');ui.pointer(checkbox,'pointerup');checkbox.click();await new Promise(done=>setTimeout(done,0));
  assert.equal(ui.selected().length,0);assert.equal(ui.writes.length,1);ui.close();
});

test('window-target pointer moves are harmless and window blur ends an active drag',()=>{
  const ui=setup();ui.pointer(ui.cell(0,1),'pointerdown');
  const event=new ui.dom.window.MouseEvent('pointermove',{bubbles:true,cancelable:true});Object.defineProperty(event,'pointerId',{value:1});assert.doesNotThrow(()=>ui.dom.window.dispatchEvent(event));
  ui.dom.window.dispatchEvent(new ui.dom.window.Event('blur'));ui.pointer(ui.cell(2,2),'pointermove');assert.equal(ui.selected().length,0);ui.close();
});
