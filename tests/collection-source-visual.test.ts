import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {mountSourceChooser} from '../src/databases/collection-ui.ts';
import type {DatabaseRequest} from '../src/core/databases.ts';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture(){const dom=new JSDOM('<!doctype html><main></main>');const doc=dom.window.document,style=doc.createElement('style');style.textContent=readFileSync(new URL('../src/databases/collections.css',import.meta.url),'utf8');doc.head.append(style);return{dom,doc,host:doc.querySelector('main')!};}

test('compact supported chooser preserves accessible text and action order with decorative icon slots',()=>{
  const f=fixture(),chooser=mountSourceChooser(f.host,{service:{async request(){throw new Error('must not create');}},isCurrent:()=>true,choose:async()=>{}});
  const buttons=[...chooser.element.querySelectorAll<HTMLButtonElement>('.collection-source-choices > button')];
  assert.deepEqual(buttons.map(button=>button.textContent),['New empty data source','Tasks','New data source with options','Link to existing data source','Notes in your vaultBrowse note titles, previews and file information.']);assert.equal(f.doc.activeElement,buttons[0]);
  assert.equal(f.dom.window.getComputedStyle(chooser.element).width,'290px');assert.equal(f.dom.window.getComputedStyle(chooser.element).boxSizing,'border-box');assert.equal(f.dom.window.getComputedStyle(chooser.element.querySelector('h2')!).fontSize,'14px');
  const suggested=chooser.element.querySelector<HTMLElement>('.collection-source-section-label')!;assert.equal(suggested.textContent,'Suggested');assert.equal(suggested.nextElementSibling,buttons[1]);assert.equal(suggested.tabIndex,-1);assert.equal(f.dom.window.getComputedStyle(suggested).fontSize,'12px');
  for(const [index,button]of buttons.entries()){const slot=button.querySelector<HTMLElement>('.collection-source-icon')!,svg=slot.querySelector('svg')!;assert.equal(slot.getAttribute('aria-hidden'),'true');assert.equal(svg.getAttribute('aria-hidden'),'true');assert.equal(svg.getAttribute('focusable'),'false');assert.equal(svg.getAttribute('width'),index===1?'20':'16');}
  assert.equal(f.dom.window.getComputedStyle(buttons[1].querySelector('.collection-source-icon')!).width,'32px');assert.equal(f.dom.window.getComputedStyle(buttons[4].querySelector('small')!).whiteSpace,'normal');
  chooser.destroy();f.dom.window.close();
});

test('uncertain quick-create retry updates its label without losing the original decorative icon or operation',async()=>{
  const f=fixture(),requests:DatabaseRequest[]=[];let attempts=0;
  const chooser=mountSourceChooser(f.host,{service:{async request(command){requests.push(command);if(command.op==='list')return{collections:[],entries:[],projection:{pending:0,issues:[]}};if(++attempts===1)throw new Error('Reply lost');return{collections:[{id:'abcdefghijkl',name:'New database',revision:'r1',deleted:false,properties:[]}],entries:[],projection:{pending:0,issues:[]}};}},isCurrent:()=>true,choose:async()=>{}});
  const primary=chooser.element.querySelector<HTMLButtonElement>('.collection-source-primary')!,svg=primary.querySelector('svg')!,label=primary.querySelector('.collection-source-label')!;
  primary.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await tick();assert.equal(primary.textContent,'Retry data source');assert.equal(label.textContent,'Retry data source');assert.equal(primary.querySelector('svg'),svg);assert.equal(svg.isConnected,true);assert.equal(f.doc.activeElement,primary);
  primary.click();await tick();const creates=requests.filter(command=>command.op==='create');assert.deepEqual(creates[0],creates[1]);assert.equal(primary.querySelector('svg'),svg);chooser.destroy();f.dom.window.close();
});
