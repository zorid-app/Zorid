import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {selectionTableReady} from './table-readiness.mjs';
import {UI} from '../bases-electron-integration/ui.mjs';

function fixture(){
  const dom=new JSDOM('<section class="bases-session" data-base-controller-version="1" data-base-controller-updating="false" data-base-controller-error="false"><div class="bases-session-content" aria-busy="false"><div class="zorid-bases-table" role="grid" aria-rowcount="2" data-base-rendered-version="1"><div id="cell" role="gridcell" data-base-widget-version="1" aria-disabled="false"></div></div></div></section>',{runScripts:'outside-only'}),document=dom.window.document;
  return{dom,document,cell:document.querySelector('#cell'),session:document.querySelector('.bases-session'),content:document.querySelector('.bases-session-content'),table:document.querySelector('[role="grid"]')};
}
test('published current table is required; stale rendered/widget versions cannot authorize input',()=>{
  const f=fixture();try{
    assert.equal(selectionTableReady(f.document,'#cell').controllerVersion,'1');
    f.session.dataset.baseControllerVersion='2';assert.equal(selectionTableReady(f.document,'#cell'),false);
    f.table.dataset.baseRenderedVersion='2';assert.equal(selectionTableReady(f.document,'#cell'),false);
    f.cell.dataset.baseWidgetVersion='2';const ready=selectionTableReady(f.document,'#cell');assert.equal(ready.controllerVersion,'2');assert.equal(ready.widgetVersion,'2');
  }finally{f.dom.window.close();}
});
test('actual001 busy/pending state and every missing or invalid readiness witness are rejected',()=>{
  const mutations=[
    f=>{f.session.dataset.baseControllerUpdating='true';f.content.setAttribute('aria-busy','true');f.cell.dataset.baseEditing='pending';},
    f=>{f.session.dataset.baseControllerUpdating='true';},f=>{f.session.removeAttribute('data-base-controller-updating');},
    f=>{f.session.dataset.baseControllerError='true';},f=>{f.session.removeAttribute('data-base-controller-error');},
    f=>{f.content.setAttribute('aria-busy','true');},f=>{f.content.removeAttribute('aria-busy');},
    f=>{f.cell.dataset.baseEditing='draft';},f=>{f.cell.dataset.baseEditing='pending';},
    f=>{f.cell.innerHTML='<span data-base-editing="draft"></span>';},f=>{f.cell.innerHTML='<input class="zorid-bases-table-input">';},
    f=>{f.cell.setAttribute('aria-disabled','true');},f=>{f.session.setAttribute('inert','');},
    f=>{f.table.removeAttribute('role');},f=>{f.cell.removeAttribute('data-base-widget-version');},
    f=>{f.session.dataset.baseControllerVersion='01';f.table.dataset.baseRenderedVersion='01';f.cell.dataset.baseWidgetVersion='01';},
    f=>{f.cell.after(f.cell.cloneNode(true));},
  ];
  for(const mutate of mutations){const f=fixture();try{mutate(f);assert.equal(selectionTableReady(f.document,'#cell'),false);}finally{f.dom.window.close();}}
});
test('bounded UI wait reads only until real DOM witnesses publish current/settled state',async()=>{
  const f=fixture();try{
    f.session.dataset.baseControllerUpdating='true';f.content.setAttribute('aria-busy','true');f.cell.dataset.baseEditing='pending';
    let inputs=0,reads=0;
    const ui=new UI({async evaluate(source){reads++;return structuredClone(f.dom.window.eval(source));},async call(){inputs++;throw Error('Readiness cannot send input');}},[]);
    const waiting=ui.wait(`return (${selectionTableReady.toString()})(document,'#cell');`,'settled current fixture',1000);
    setTimeout(()=>{f.session.dataset.baseControllerUpdating='false';f.content.setAttribute('aria-busy','false');f.cell.removeAttribute('data-base-editing');f.session.dataset.baseControllerVersion='2';f.table.dataset.baseRenderedVersion='2';f.cell.dataset.baseWidgetVersion='2';},10);
    const ready=await waiting;assert.ok(reads>=2);assert.equal(inputs,0);assert.equal(ready.controllerVersion,'2');
    f.content.setAttribute('aria-busy','true');await assert.rejects(ui.wait(`return (${selectionTableReady.toString()})(document,'#cell');`,'blocked fixture',10));assert.equal(inputs,0);
  }finally{f.dom.window.close();}
});
