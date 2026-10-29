import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createLayoutSettings} from '../src/bases/toolbar-panels.ts';
import {BaseDocument} from '../src/bases/document.ts';
import type {BaseViewConfig} from '../src/bases/document.ts';
import {executeBaseQuery} from '../src/bases/query.ts';
import {createBaseListView} from '../src/bases/list-view.ts';

function fixture(extra:Record<string,unknown>={}){
 const dom=new JSDOM('<section></section><main></main>',{pretendToBeVisual:true}),doc=dom.window.document,parent=doc.querySelector('section')!,host=doc.querySelector('main')!;
 const source=BaseDocument.parse(JSON.stringify({views:[{type:'list',name:'Entries',order:['file.name','note.status'],futureLayout:{keep:true},...extra}]}));
 let changes=0;
 const read=createLayoutSettings(doc,parent,source.views[0],[],()=>{changes++;});
 const get=<T extends HTMLElement>(label:string)=>{const element=parent.querySelector<T>(`[aria-label="${label}"]`);assert.ok(element,`control ${label}`);return element;};
 const change=(label:string,value:string|boolean)=>{const input=get<HTMLInputElement|HTMLSelectElement>(label);if(typeof value==='boolean')(input as HTMLInputElement).checked=value;else input.value=value;input.dispatchEvent(new dom.window.Event(label==='Property separator'?'input':'change',{bubbles:true}));};
 const hidden=(label:string)=>!!get(label).closest('[hidden]');
 const render=(view:BaseViewConfig)=>{const result=executeBaseQuery(BaseDocument.parse(JSON.stringify({views:[view]})),{version:1,files:[{path:'One.md',properties:{status:'Ready'}}]});return createBaseListView(host,{result,openFile(){}});};
 return{dom,doc,parent,host,source,read,get,change,hidden,render,changes:()=>changes,close(){dom.window.close();}};
}

test('List settings describe the rendered default as page rows without authoring a patch',()=>{
 const f=fixture();try{
  const rendered=f.render(f.source.views[0]);try{assert.ok(f.host.querySelector('.is-page-row'));}finally{rendered.destroy();}
  assert.equal(f.get<HTMLSelectElement>('Rows').selectedOptions[0].textContent,'Page rows (default)');
  for(const label of ['Markers','Indent properties','Property separator']){assert.equal(f.hidden(label),true);assert.equal(f.get<HTMLInputElement>(label).disabled,true);}
  assert.deepEqual(f.read(),{});assert.equal(f.changes(),0);
 }finally{f.close();}
});

for(const extra of [{markers:'bullet'},{markers:'number',separator:' / '},{markers:'none',separator:''},{indentProperties:true}])test(`explicit List configuration stays custom and untouched: ${JSON.stringify(extra)}`,()=>{
 const f=fixture(extra);try{
  assert.equal(f.get<HTMLSelectElement>('Rows').selectedOptions[0].textContent,'Custom list rows');
  assert.equal(f.hidden('Markers'),false);assert.equal(f.get<HTMLInputElement>('Markers').disabled,false);
  assert.equal(f.get<HTMLSelectElement>('Markers').value,extra.markers??'bullet');
  assert.equal(f.get<HTMLInputElement>('Indent properties').checked,!!extra.indentProperties);
  assert.equal(f.get<HTMLInputElement>('Property separator').value,extra.separator??', ');
  assert.deepEqual(f.read(),{});assert.equal(f.changes(),0);
 }finally{f.close();}
});

test('Page rows reset deletes only the three legacy presentation keys and restores actual page rows',()=>{
 const f=fixture({markers:'number',separator:' / ',indentProperties:true});try{
  f.change('Rows','page');
  assert.deepEqual(f.read(),{markers:undefined,indentProperties:undefined,separator:undefined});
  f.source.updateView(0,f.read());const saved=f.source.views[0];
  for(const key of ['markers','separator','indentProperties'])assert.equal(Object.hasOwn(saved,key),false);
  assert.deepEqual(saved.futureLayout,{keep:true});assert.deepEqual(saved.order,['file.name','note.status']);
  assert.equal(f.get<HTMLSelectElement>('Rows').value,'page');assert.equal(f.hidden('Markers'),true);assert.equal(f.hidden('Property separator'),true);
  const rendered=f.render(saved);try{assert.ok(f.host.querySelector('.is-page-row'));assert.ok(f.host.querySelector('.bases-list-page-icon'));assert.ok(f.host.querySelector('.bases-list-item-details'));}finally{rendered.destroy();}
 }finally{f.close();}
});

test('changing default to custom creates real bullet rows and retains edited custom choices across reset',()=>{
 const f=fixture();try{
  f.change('Rows','custom');assert.equal(f.hidden('Markers'),false);assert.equal(f.hidden('Property separator'),false);
  assert.equal(f.read().markers,'bullet');
  const doc=BaseDocument.parse(f.source.toString());doc.updateView(0,f.read());const rendered=f.render(doc.views[0]);try{assert.equal(f.host.querySelector('.is-page-row'),null);assert.equal(f.host.querySelector('.list-bullet')?.textContent,'•');}finally{rendered.destroy();}
  f.change('Markers','number');f.change('Property separator',' / ');f.change('Indent properties',true);
  f.change('Rows','page');assert.equal(f.hidden('Indent properties'),true);assert.deepEqual(f.read(),{markers:undefined,indentProperties:undefined,separator:undefined});
  f.change('Rows','custom');assert.equal(f.get<HTMLSelectElement>('Markers').value,'number');assert.equal(f.get<HTMLInputElement>('Property separator').value,' / ');assert.equal(f.get<HTMLInputElement>('Indent properties').checked,true);assert.equal(f.hidden('Property separator'),true);
  assert.deepEqual(f.read(),{markers:'number',indentProperties:true,separator:' / '});
 }finally{f.close();}
});
