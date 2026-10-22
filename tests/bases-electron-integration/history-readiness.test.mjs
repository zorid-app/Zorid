import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {baseHistoryReadiness,waitForBaseHistoryReady} from './history-readiness.mjs';

function fixture() {
  const dom=new JSDOM('<div class="pane is-active"><div class="bases-session" data-base-controller-version="49" data-base-controller-updating="false" data-base-controller-error="false"><div class="bases-session-content" aria-busy="false"><div class="zorid-bases-table" data-base-rendered-version="49"><div tabindex="0" role="gridcell" data-path="Book 001.md" data-property="note.rating" data-base-widget-version="49" aria-disabled="false">4</div></div></div></div></div><input id="outside">',{runScripts:'outside-only'});
  const document=dom.window.document,cell=document.querySelector('[role=gridcell]');cell.focus();
  return {dom,document,cell,session:document.querySelector('.bases-session'),content:document.querySelector('.bases-session-content'),table:document.querySelector('.zorid-bases-table'),frame:()=>baseHistoryReadiness(document,'Book 001.md','note.rating')};
}

test('history readiness requires current idle public markers and exact focused cell without changing DOM',()=>{
  const f=fixture();try{
    const before=f.document.documentElement.outerHTML;
    assert.equal(f.frame().ready,true);assert.equal(f.document.documentElement.outerHTML,before);assert.equal(f.document.activeElement,f.cell);
    const cases=[[f.content,'aria-busy','true'],[f.session,'data-base-controller-updating','true'],[f.session,'data-base-controller-error','true'],[f.session,'data-base-controller-version','50'],[f.table,'data-base-rendered-version','50'],[f.cell,'data-base-widget-version','50'],[f.cell,'data-path','Book 002.md'],[f.cell,'data-property','note.status'],[f.cell,'aria-disabled','true'],[f.cell,'data-base-editing','draft'],[f.content,'inert','']];
    for(const [element,name,value] of cases){const old=element.getAttribute(name);element.setAttribute(name,value);assert.equal(f.frame().ready,false,name);if(old===null)element.removeAttribute(name);else element.setAttribute(name,old);assert.equal(f.frame().ready,true);}
    f.cell.removeAttribute('data-base-widget-version');assert.equal(f.frame().ready,false);f.cell.dataset.baseWidgetVersion='49';
    f.session.removeAttribute('data-base-controller-version');assert.equal(f.frame().ready,false);f.session.dataset.baseControllerVersion='49';
    f.document.querySelector('#outside').focus();assert.equal(f.frame().ready,false);assert.equal(f.document.activeElement.id,'outside');
    f.cell.focus();f.cell.remove();assert.equal(f.frame().ready,false);
  }finally{f.dom.window.close();}
});

test('history protocol waits only by public DOM observation and records readiness before one caller shortcut',async()=>{
  const f=fixture();try{
    f.content.setAttribute('aria-busy','true');let polls=0,keys=0;const actions=[];
    const c={evidence:{actions},ui:{async wait(body,label,timeout){assert.match(label,/undo paste/);assert.equal(timeout,45000);const evaluate=()=>f.dom.window.eval(`(()=>{${body}})()`);assert.equal(evaluate(),false);polls++;assert.equal(keys,0);f.content.setAttribute('aria-busy','false');return evaluate();},async key(){keys++;}}};
    await waitForBaseHistoryReady(c,'Book 001.md','note.rating','undo paste');
    assert.equal(polls,1);assert.equal(keys,0,'Readiness helper cannot dispatch or retry input');assert.equal(actions.length,1);assert.equal(actions[0].action,'base-history-ready');assert.equal(actions[0].ready,true);assert.equal(actions[0].controllerVersion,'49');assert.deepEqual(JSON.parse(JSON.stringify(actions[0].focus)),{role:'gridcell',path:'Book 001.md',property:'note.rating'});assert.equal(f.document.activeElement,f.cell);
    await c.ui.key('z');assert.equal(keys,1);
  }finally{f.dom.window.close();}
});
