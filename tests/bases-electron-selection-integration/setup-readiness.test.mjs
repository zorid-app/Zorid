import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {UI} from '../bases-electron-integration/ui.mjs';
import {selectionSplitReady,selectionNoteMode,waitSelectionNoteLive} from './setup-readiness.mjs';

const base=(id,rowCount=2)=>`<section class="pane"><div class="tab is-active" data-tab-id="${id}"></div><section class="bases-session" data-base-controller-version="1" data-base-controller-updating="false" data-base-controller-error="false"><div class="bases-session-content" aria-busy="false"><div class="zorid-bases-table" role="grid" aria-rowcount="${rowCount}" data-base-rendered-version="1"></div></div></section></section>`;
function fixture(markup='',title='Selection note'){
  const dom=new JSDOM('<body>'+markup+'</body>',{runScripts:'outside-only'}),document=dom.window.document,evidence={actions:[]},clicks=[];
  const ui=new UI({evaluate:source=>structuredClone(dom.window.eval(source)),async call(){throw Error('A setup wait cannot inject input');}},[]),wait=ui.wait.bind(ui);
  ui.wait=(body,label,timeout)=>wait(body,label,Math.min(timeout??20000,1000));
  ui.click=async selector=>{clicks.push(selector);assert.equal(selectionNoteMode(document,title)?.mode,'reading','Only mounted Reading can receive a switch');const pane=document.querySelector(selector).closest('.pane');setTimeout(()=>{pane.querySelector('.markdown-preview').remove();pane.querySelector('button').dataset.hotkeyName='Switch to reading view';pane.insertAdjacentHTML('beforeend','<div class="cm-content" contenteditable="true"></div>');},10);};
  return{dom,document,ui,evidence,clicks};
}
test('split admission requires exactly two current mounted Base grids and a new active tab',()=>{
  const f=fixture(base('original'));try{
    f.document.querySelector('.pane').classList.add('is-active');assert.equal(selectionSplitReady(f.document,'original'),false);
    f.document.body.insertAdjacentHTML('beforeend',base('new'));assert.equal(selectionSplitReady(f.document,'original'),false,'Original active is not the new split');
    const panes=f.document.querySelectorAll('.pane');panes[0].classList.remove('is-active');panes[1].classList.add('is-active');
    assert.equal(selectionSplitReady(f.document,'original').newActiveTabId,'new');
    panes[1].querySelector('[role="grid"]').removeAttribute('data-base-rendered-version');assert.equal(selectionSplitReady(f.document,'original'),false);
    panes[1].querySelector('[role="grid"]').setAttribute('data-base-rendered-version','1');panes[1].querySelector('.bases-session-content').setAttribute('aria-busy','true');assert.equal(selectionSplitReady(f.document,'original'),false);
    panes[1].querySelector('.bases-session-content').setAttribute('aria-busy','false');assert.equal(selectionSplitReady(f.document,'missing'),false);
    f.document.body.insertAdjacentHTML('beforeend',base('extra'));assert.equal(selectionSplitReady(f.document,'original'),false);
  }finally{f.dom.window.close();}
});
test('asynchronous split wait sends no input before the second mounted grid becomes current',async()=>{
  const f=fixture(base('original'));try{
    const waiting=f.ui.wait(`return (${selectionSplitReady.toString()})(document,'original');`,'split mount');
    setTimeout(()=>{f.document.body.insertAdjacentHTML('beforeend',base('new'));f.document.querySelectorAll('.pane')[1].classList.add('is-active');},10);
    const state=await waiting;assert.equal(state.paneCount,2);assert.equal(state.newActiveTabId,'new');assert.deepEqual(f.clicks,[]);
  }finally{f.dom.window.close();}
});
test('delayed note/title/Reading surface is awaited before exactly one switch to delayed Live Edit',async()=>{
  const f=fixture('<section class="pane is-active"><div class="tab is-active" data-tab-id="note"></div></section>');try{
    const waiting=waitSelectionNoteLive(f);
    setTimeout(()=>{f.document.querySelector('.pane').insertAdjacentHTML('beforeend','<input class="note-title" value="Selection note"><button data-hotkey-command="toggle-reading" data-hotkey-name="Switch to Live Edit"></button>');assert.equal(selectionNoteMode(f.document,'Selection note'),false);},10);
    setTimeout(()=>f.document.querySelector('.pane').insertAdjacentHTML('beforeend','<div class="markdown-preview"></div>'),20);
    const final=await waiting;assert.equal(final.mode,'live');assert.equal(f.clicks.length,1);assert.equal(f.evidence.actions[0].initial.mode,'reading');
  }finally{f.dom.window.close();}
});
test('delayed Live Edit surface causes no mode toggle and wrong title/mode times out without input',async()=>{
  const f=fixture('<section class="pane is-active"><input class="note-title" value="Selection note"><button data-hotkey-command="toggle-reading" data-hotkey-name="Switch to reading view"></button></section>');try{
    assert.equal(selectionNoteMode(f.document,'Selection note'),false);
    setTimeout(()=>f.document.querySelector('.pane').insertAdjacentHTML('beforeend','<div class="cm-content" contenteditable="true"></div>'),10);
    assert.equal((await waitSelectionNoteLive(f)).mode,'live');assert.deepEqual(f.clicks,[]);
    f.document.querySelector('input').value='Other note';const original=f.ui.wait;f.ui.wait=(body,label)=>original(body,label,10);
    await assert.rejects(waitSelectionNoteLive(f),/Expected note title/);assert.deepEqual(f.clicks,[]);
    f.document.querySelector('input').value='Selection note';f.document.querySelector('button').dataset.hotkeyName='Switch to Live Edit';assert.equal(selectionNoteMode(f.document,'Selection note'),false,'Reading toggle plus stale Live content is not a mounted mode');
  }finally{f.dom.window.close();}
});
test('two-record Safety setup requires four rendered grid rows including header and summary and an exact original tab identity',()=>{
  const f=fixture(base('original',4)+base('new',4));try{
    const panes=f.document.querySelectorAll('.pane');panes[1].classList.add('is-active');
    assert.equal(selectionSplitReady(f.document,'original'),false,'The Selection default must not silently accept Safety row counts');
    const ready=selectionSplitReady(f.document,'original',4);assert.equal(ready.newActiveTabId,'new');assert.deepEqual(ready.states.map(state=>state.rowCount),[4,4]);
    for(const count of [0,-1,1.5,NaN,Infinity,'3',null])assert.equal(selectionSplitReady(f.document,'original',count),false,'Invalid expected count cannot admit a split');
    for(const id of ['',null,1,{}])assert.equal(selectionSplitReady(f.document,id,4),false,'Missing or non-string original tab identity cannot admit a split');
    panes[1].querySelector('[role="grid"]').setAttribute('aria-rowcount','3');assert.equal(selectionSplitReady(f.document,'original',4),false,'A record-only count omitting the summary cannot admit the split');
    panes[1].querySelector('[role="grid"]').setAttribute('aria-rowcount','4');panes[1].querySelector('.bases-session').setAttribute('data-base-controller-updating','true');assert.equal(selectionSplitReady(f.document,'original',4),false,'A matching but still updating split must not admit the next click');
  }finally{f.dom.window.close();}
});
test('Safety custom note title waits for its actual mounted mode before one ordinary Live Edit switch',async()=>{
  const f=fixture('<section class="pane is-active"><div class="tab is-active" data-tab-id="A"></div></section>','A');try{
    const waiting=waitSelectionNoteLive(f,'A');
    setTimeout(()=>f.document.querySelector('.pane').insertAdjacentHTML('beforeend','<input class="note-title" value="A"><button data-hotkey-command="toggle-reading" data-hotkey-name="Switch to Live Edit"></button>'),10);
    setTimeout(()=>f.document.querySelector('.pane').insertAdjacentHTML('beforeend','<div class="markdown-preview"></div>'),20);
    const ready=await waiting;assert.equal(ready.title,'A');assert.equal(ready.mode,'live');assert.equal(f.clicks.length,1);assert.equal(f.evidence.actions[0].initial.title,'A');
  }finally{f.dom.window.close();}
});
test('custom note readiness rejects wrong titles and invalid expected titles without sending input',async()=>{
  const f=fixture('<section class="pane is-active"><input class="note-title" value="Wrong"><button data-hotkey-command="toggle-reading" data-hotkey-name="Switch to reading view"></button><div class="cm-content" contenteditable="true"></div></section>','A');try{
    const original=f.ui.wait;f.ui.wait=(body,label)=>original(body,label,10);
    await assert.rejects(waitSelectionNoteLive(f,'A'),/Expected note title/);assert.deepEqual(f.clicks,[]);
    for(const title of ['',null,7,{}])await assert.rejects(waitSelectionNoteLive(f,title),/exact expected note title/);
    assert.deepEqual(f.clicks,[]);assert.deepEqual(f.evidence.actions,[]);
    f.document.querySelector('input').value='A';assert.equal((await waitSelectionNoteLive(f,'A')).mode,'live');assert.deepEqual(f.clicks,[]);
  }finally{f.dom.window.close();}
});
