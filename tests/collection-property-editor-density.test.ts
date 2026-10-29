import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {mountCollectionEditor} from '../src/databases/collection-ui.ts';
import type {DatabaseCollection,DatabaseRequest} from '../src/core/databases.ts';
const collection:DatabaseCollection={id:'abcdefghijkl',name:'Tasks',revision:'schema-r1',deleted:false,properties:[
  {id:'titlefieldid',name:'Title',datatype:'text',options:[],default:'Untitled'},
  {id:'statusfieldx',name:'Status',datatype:'status',options:[{id:'notstartedxx',name:'Not started',category:'not_started',color:'gray'},{id:'inprogressxx',name:'In progress',category:'working',color:'blue'},{id:'doneoptionxx',name:'Done',category:'done',color:'green'}],default:'inprogressxx'},
]};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture(propertyId?:string){const dom=new JSDOM('<!doctype html><main></main>'),doc=dom.window.document,host=doc.querySelector('main')!,requests:DatabaseRequest[]=[];const style=doc.createElement('style');style.textContent=readFileSync(new URL('../src/databases/collections.css',import.meta.url),'utf8');doc.head.append(style);
 const editor=mountCollectionEditor(host,{collection,propertyId,entries:[],service:{async request(command){requests.push(command);return{collections:[collection],entries:[],projection:{pending:0,issues:[]}};}},isCurrent:()=>true,onSaved:async()=>{},onClose:()=>{}});return{dom,doc,host,requests,editor,close(){editor.destroy();dom.window.close();}};
}
function button(host:Element,label:string){const control=[...host.querySelectorAll<HTMLButtonElement>('button')].find(control=>control.textContent===label);assert.ok(control);return control;}

test('single-property action icons retain accessible labels, tooltip hints and native keyboard targets',()=>{
 const f=fixture('statusfieldx'),controls=[...f.host.querySelectorAll<HTMLButtonElement>('.collection-property-icon-button')];assert.equal(controls.length,12);
 for(const control of controls){const label=control.textContent!;assert.match(label,/^(Move (property|option) (up|down)|Remove (property|option))$/);assert.equal(control.getAttribute('aria-label'),label);assert.equal(control.title,label);assert.equal(control.querySelector('svg')?.getAttribute('aria-hidden'),'true');assert.equal(control.querySelector('.collection-property-action-label')?.getAttribute('aria-hidden'),'true');const css=f.dom.window.getComputedStyle(control);assert.equal(css.width,'26px');assert.equal(css.height,'26px');assert.equal(control.hidden,false);assert.equal(control.disabled,false);control.focus();assert.equal(f.doc.activeElement,control);}
 assert.equal(f.host.querySelectorAll('.collection-property-controls > button').length,4);assert.equal(f.host.querySelectorAll('.collection-property-footer > button').length,2);assert.equal(button(f.host,'Cancel').parentElement,button(f.host,'Apply').parentElement);f.close();
});

test('each Status option keeps full-row name then native category/color and three actions in order',async()=>{
 const f=fixture('statusfieldx'),rows=[...f.host.querySelectorAll<HTMLElement>('.collection-option-list > div')];assert.equal(rows.length,3);
 for(const [index,row]of rows.entries()){const name=row.querySelector<HTMLInputElement>(':scope > .collection-option-name')!,controls=row.querySelector<HTMLElement>(':scope > .collection-option-controls')!;assert.equal(name.value,collection.properties[1].options[index].name);assert.equal(controls.children.length,5);assert.deepEqual([...controls.children].map(control=>control.tagName),['SELECT','SELECT','BUTTON','BUTTON','BUTTON']);assert.equal(f.dom.window.getComputedStyle(row).display,'grid');assert.equal(f.dom.window.getComputedStyle(name).width,'100%');assert.equal(row.dataset.optionColor,collection.properties[1].options[index].color);}
 const first=rows[0],category=first.querySelector<HTMLSelectElement>('.collection-option-category')!,color=first.querySelector<HTMLSelectElement>('.collection-option-color')!;
 category.value='working';category.dispatchEvent(new f.dom.window.Event('change'));color.value='red';color.dispatchEvent(new f.dom.window.Event('change'));assert.equal(first.dataset.optionColor,'red');assert.equal(f.requests.length,0);assert.equal(f.editor.hasPendingChanges(),true);
 button(f.host,'Apply').click();await tick();const command=f.requests[0];assert.equal(command.op,'update');if(command.op==='update'){assert.deepEqual(command.properties[0],collection.properties[0]);assert.equal(command.properties[1].id,'statusfieldx');assert.equal(command.properties[1].default,'inprogressxx');assert.deepEqual(command.properties[1].options?.map(option=>option.id),collection.properties[1].options.map(option=>option.id));assert.equal(command.properties[1].options?.[0].category,'working');assert.equal(command.properties[1].options?.[0].color,'red');}f.close();
});

test('compact removal still opens the existing explicit confirmation instead of removing immediately',()=>{
 const f=fixture('statusfieldx');button(f.host,'Remove option').click();const confirmation=f.host.querySelector('.collection-delete-confirmation')!;assert.ok(confirmation);assert.equal(f.host.querySelectorAll('.collection-option-list > div').length,3);button(confirmation,'Cancel').click();assert.equal(f.host.querySelector('.collection-delete-confirmation'),null);assert.equal(f.editor.hasPendingChanges(),false);f.close();
});

test('full-manager controls, option flow and footer keep their original presentation path',()=>{
 const f=fixture();assert.equal(f.host.querySelector('.collection-property-icon-button'),null);assert.equal(f.host.querySelector('.collection-property-controls'),null);assert.equal(f.host.querySelector('.collection-property-footer'),null);
 const status=f.host.querySelector('[data-property-id="statusfieldx"]')!,option=status.querySelector('.collection-option-list > div')!;assert.equal(option.querySelectorAll(':scope > select').length,2);assert.equal(option.querySelectorAll(':scope > button').length,3);assert.equal(button(f.host,'Apply').parentElement,f.editor.element);assert.equal(f.host.querySelectorAll('.collection-property-row').length,2);f.close();
});
