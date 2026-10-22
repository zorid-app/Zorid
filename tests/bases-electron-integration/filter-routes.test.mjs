import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {UI} from './ui.mjs';
import {heavyFilterRoutes} from './journey.mjs';
import {section,group,match} from '../bases-electron-config-integration/controls.mjs';

const row=id=>`<div class="bases-filter-condition" id="${id}"><button aria-label="Edit expression">Code</button><button aria-label="Remove filter">Remove</button></div>`;
function fixture({saved=false}={}){
  const dom=new JSDOM(`<body><section role="dialog" aria-label="Filter"><section class="bases-filter-section"><div class="bases-filter-tree"><div class="bases-filter-group"><select aria-label="Match"><option value="and">All</option></select>${row('all')}</div></div><button>Add filter</button></section><section class="bases-filter-section"><div class="bases-filter-tree"><div class="bases-filter-group"><select aria-label="Match"><option value="and">All</option><option value="or">Any</option></select>${row(saved?'saved':'blank')}</div></div><button>Add filter</button></section></section></body>`,{runScripts:'outside-only'});
  const {document,HTMLElement}=dom.window,clicked=[];
  const rect=e=>({x:10,y:10+30*[...document.querySelectorAll('button')].indexOf(e),width:90,height:20});
  HTMLElement.prototype.getClientRects=function(){return [rect(this)];};HTMLElement.prototype.getBoundingClientRect=function(){return rect(this);};HTMLElement.prototype.scrollIntoView=()=>{};
  document.elementFromPoint=(x,y)=>[...document.querySelectorAll('button')].find(e=>{const r=rect(e);return x>=r.x&&x<=r.x+r.width&&y>=r.y&&y<=r.y+r.height;});
  document.addEventListener('click',event=>{const button=event.target.closest('button');if(!button)return;clicked.push({label:button.getAttribute('aria-label')??button.textContent,row:button.closest('.bases-filter-condition')?.id});});
  const local=document.querySelector(heavyFilterRoutes.section);
  local.querySelector(':scope > button').addEventListener('click',()=>local.querySelector('.bases-filter-group').insertAdjacentHTML('beforeend',row('added')));
  const ui=new UI({evaluate:code=>structuredClone(dom.window.eval(code)),async call(method,params){if(method==='Input.dispatchMouseEvent'&&params.type==='mouseReleased')document.elementFromPoint(params.x,params.y).click();}},[]);
  return {dom,document,clicked,ui};
}
test('heavy Add filter route edits the added second row while the initial blank and all-view row remain distinct',async()=>{
  const f=fixture();try{
    await f.ui.button('Add filter',heavyFilterRoutes.section);
    assert.equal(f.document.querySelectorAll(`${heavyFilterRoutes.section} .bases-filter-condition`).length,2);
    assert.equal(f.document.querySelector(heavyFilterRoutes.added).id,'added');
    await f.ui.button('Edit expression',heavyFilterRoutes.added);
    assert.deepEqual(f.clicked,[{label:'Add filter',row:undefined},{label:'Edit expression',row:'added'}]);
    assert.equal(f.document.querySelectorAll('[aria-label="Edit expression"]').length,3,'Unscoped control would be ambiguous');
  }finally{f.dom.window.close();}
});
test('heavy reopened saved filter removal targets its one persisted local row',async()=>{
  const f=fixture({saved:true});try{
    assert.equal(f.document.querySelector(heavyFilterRoutes.saved).id,'saved');
    await f.ui.button('Remove filter',heavyFilterRoutes.saved);assert.deepEqual(f.clicked,[{label:'Remove filter',row:'saved'}]);
  }finally{f.dom.window.close();}
});
test('configuration initial Match follows the actual local root group instead of the obsolete direct tree child',async()=>{
  const f=fixture();try{
    let call;await match({ui:{async select(selector,value){const nodes=f.document.querySelectorAll(selector);assert.equal(nodes.length,1);call={node:nodes[0],value};}}},group(section('This view')),'or');
    assert.equal(call.node,f.document.querySelector(heavyFilterRoutes.section+' .bases-filter-group > select'));assert.equal(call.value,'or');
    assert.equal(f.document.querySelector(heavyFilterRoutes.section+' .bases-filter-tree > select'),null);
  }finally{f.dom.window.close();}
});
