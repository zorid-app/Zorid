import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountCollectionEditor} from '../src/databases/collection-ui.ts';
import type {DatabaseCollection,DatabaseRequest} from '../src/core/databases.ts';

const schema:DatabaseCollection={id:'abcdefghijkl',name:'Books',revision:'schema-r1',deleted:false,properties:[
  {id:'titlefieldid',name:'Title',datatype:'text',options:[],default:'Untitled'},
  {id:'statusfieldx',name:'Status',datatype:'select',options:[{id:'firstoptionx',name:'Same',color:'red'},{id:'secondoption',name:'Same',color:'blue'}],default:'secondoption'},
  {id:'amountfieldx',name:'Amount',datatype:'number',options:[],default:4},
]};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture(propertyId?:string){const dom=new JSDOM('<!doctype html><button id="outside">Outside</button><main></main>');const host=dom.window.document.querySelector('main')!;let current=true;const requests:DatabaseRequest[]=[];
  const editor=mountCollectionEditor(host,{collection:schema,propertyId,entries:[],service:{async request(command){requests.push(command);return{collections:[schema],entries:[],projection:{pending:0,issues:[]}};}},isCurrent:()=>current,onSaved:async()=>{},onClose:()=>{}});
  return{dom,doc:dom.window.document,host,editor,requests,retire(){current=false;},close(){editor.destroy();dom.window.close();}};
}
function button(host:Element,label:string){const node=[...host.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent===label);assert.ok(node,`missing ${label}`);return node;}
function rows(f:ReturnType<typeof fixture>){return [...f.host.querySelectorAll<HTMLElement>('.collection-property-row')];}
function row(f:ReturnType<typeof fixture>,name:string){const found=rows(f).find(row=>row.querySelector<HTMLInputElement>(':scope > input')?.value===name);assert.ok(found);return found;}
function optionRows(property:Element){return [...property.querySelectorAll<HTMLElement>('.collection-option-list > div')];}
function edit(f:ReturnType<typeof fixture>,input:HTMLInputElement,value:string){input.value=value;input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));}
// JSDOM does not synthesize native button default actions. Dispatch real keyboard
// events plus the keyboard-generated (detail0) activation click a browser emits.
function activate(f:ReturnType<typeof fixture>,control:HTMLButtonElement,key='Enter'){
  control.focus();const down=new f.dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true});control.dispatchEvent(down);
  if(key==='Enter'&&!down.defaultPrevented)control.dispatchEvent(new f.dom.window.MouseEvent('click',{bubbles:true,cancelable:true,detail:0}));
  const up=new f.dom.window.KeyboardEvent('keyup',{key,bubbles:true,cancelable:true});control.dispatchEvent(up);
  if(key===' '&&!down.defaultPrevented&&!up.defaultPrevented)control.dispatchEvent(new f.dom.window.MouseEvent('click',{bubbles:true,cancelable:true,detail:0}));
}
function activeProperty(f:ReturnType<typeof fixture>){return f.doc.activeElement?.closest('.collection-property-row')?.querySelector<HTMLInputElement>(':scope > input')?.value;}

test('keyboard property moves retain the same direction control and logical field at boundaries',async()=>{
  const f=fixture();const first=button(row(f,'Title'),'Move property up');activate(f,first);assert.equal(f.doc.activeElement,first);assert.equal(f.editor.hasPendingChanges(),false);
  activate(f,button(row(f,'Status'),'Move property down'));assert.equal(activeProperty(f),'Status');assert.equal(f.doc.activeElement?.textContent,'Move property down');assert.deepEqual(rows(f).map(row=>row.querySelector<HTMLInputElement>('input')!.value),['Title','Amount','Status']);
  const boundary=f.doc.activeElement;activate(f,boundary as HTMLButtonElement,' ');assert.equal(f.doc.activeElement,boundary);
  activate(f,button(row(f,'Status'),'Move property up'),' ');assert.equal(activeProperty(f),'Status');assert.equal(f.doc.activeElement?.textContent,'Move property up');
  button(f.host,'Apply').click();await tick();const saved=f.requests[0];assert.equal(saved.op,'update');if(saved.op==='update'){assert.deepEqual(saved.properties,schema.properties);assert.equal(saved.expectedRevision,schema.revision);}
  f.close();
});

test('keyboard option moves distinguish equal labels by logical option and retain defaults',async()=>{
  const f=fixture();activate(f,button(optionRows(row(f,'Status'))[1],'Move option up'));
  let active=f.doc.activeElement as HTMLButtonElement;assert.equal(active.textContent,'Move option up');assert.equal(active.parentElement?.querySelector<HTMLSelectElement>('select')?.value,'blue');assert.equal(active.parentElement,optionRows(row(f,'Status'))[0]);
  activate(f,active);assert.equal(f.doc.activeElement,active);
  activate(f,button(optionRows(row(f,'Status'))[0],'Move option down'),' ');active=f.doc.activeElement as HTMLButtonElement;assert.equal(active.textContent,'Move option down');assert.equal(active.parentElement?.querySelector<HTMLSelectElement>('select')?.value,'blue');
  button(f.host,'Apply').click();await tick();const saved=f.requests[0];assert.equal(saved.op,'update');if(saved.op==='update')assert.deepEqual(saved.properties,schema.properties);
  f.close();
});

test('new properties without schema IDs retain their own move focus after an earlier field is removed',async()=>{
  const f=fixture();button(f.host,'Add property').click();let draft=rows(f).at(-1)!;edit(f,draft.querySelector<HTMLInputElement>('input')!,'Draft A');
  button(f.host,'Add property').click();draft=rows(f).at(-1)!;edit(f,draft.querySelector<HTMLInputElement>('input')!,'Draft B');
  button(row(f,'Title'),'Remove property').click();button(row(f,'Title').querySelector('.collection-delete-confirmation')!,'Remove').click();
  activate(f,button(row(f,'Draft B'),'Move property up'));assert.equal(activeProperty(f),'Draft B');assert.equal(f.doc.activeElement?.textContent,'Move property up');assert.equal(rows(f).indexOf(row(f,'Draft B')),2);
  button(f.host,'Apply').click();await tick();const saved=f.requests[0];assert.equal(saved.op,'update');if(saved.op==='update'){
    assert.deepEqual(saved.properties.slice(0,2),schema.properties.slice(1));assert.deepEqual(saved.properties.slice(2).map(property=>[property.id,property.name]),[[undefined,'Draft B'],[undefined,'Draft A']]);assert.equal(saved.confirmDestructive,true);
  }
  f.close();
});

test('new options without IDs preserve focused identity after removal and property reorder',async()=>{
  const f=fixture();button(row(f,'Status'),'Add option').click();button(row(f,'Status'),'Add option').click();
  let options=optionRows(row(f,'Status'));const color=options[3].querySelector<HTMLSelectElement>('select')!;color.value='green';color.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));
  button(options[0],'Remove option').click();button(options[0].querySelector('.collection-delete-confirmation')!,'Remove').click();
  activate(f,button(row(f,'Status'),'Move property up'));assert.equal(activeProperty(f),'Status');
  options=optionRows(row(f,'Status'));activate(f,button(options[2],'Move option up'),' ');const active=f.doc.activeElement as HTMLButtonElement;
  assert.equal(active.textContent,'Move option up');assert.equal(active.parentElement,optionRows(row(f,'Status'))[1]);assert.equal(active.parentElement?.querySelector<HTMLSelectElement>('select')?.value,'green');
  button(f.host,'Apply').click();await tick();const saved=f.requests[0];assert.equal(saved.op,'update');if(saved.op==='update'){
    assert.deepEqual(saved.properties.slice(1),[schema.properties[0],schema.properties[2]]);assert.equal(saved.properties[0].id,'statusfieldx');assert.equal(saved.properties[0].default,'secondoption');
    assert.deepEqual(saved.properties[0].options?.map(option=>[option.id,option.color]),[['secondoption','blue'],[undefined,'green'],[undefined,undefined]]);
  }
  f.close();
});

test('compact property moves retain the visible logical control without submitting Enter',async()=>{
  const f=fixture('statusfieldx');assert.equal(rows(f).length,1);
  activate(f,button(row(f,'Status'),'Move property down'));assert.equal(activeProperty(f),'Status');assert.equal(f.doc.activeElement?.textContent,'Move property down');assert.equal(f.requests.length,0);
  activate(f,button(optionRows(row(f,'Status'))[1],'Move option up'),' ');assert.equal(f.doc.activeElement?.textContent,'Move option up');assert.equal(f.doc.activeElement?.parentElement?.querySelector<HTMLSelectElement>('select')?.value,'blue');assert.equal(f.requests.length,0);
  button(f.host,'Apply').click();await tick();const saved=f.requests[0];assert.equal(saved.op,'update');if(saved.op==='update'){
    assert.deepEqual(saved.properties.slice(0,2),[schema.properties[0],schema.properties[2]]);assert.equal(saved.properties[2].id,'statusfieldx');assert.equal(saved.properties[2].default,'secondoption');assert.deepEqual(saved.properties[2].options?.map(option=>option.id),['secondoption','firstoptionx']);
  }
  f.close();
});

test('unfocused or retired reorder controls do not take focus from the current owner',()=>{
  const f=fixture(),outside=f.doc.querySelector<HTMLButtonElement>('#outside')!;outside.focus();button(row(f,'Status'),'Move property down').click();assert.equal(f.doc.activeElement,outside);
  const control=button(row(f,'Status'),'Move property up');control.focus();f.retire();control.click();assert.equal(f.doc.activeElement,f.doc.body);
  f.close();
});
