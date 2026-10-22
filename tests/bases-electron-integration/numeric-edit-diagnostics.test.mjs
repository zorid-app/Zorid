import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {numericEditFrame} from './numeric-edit-diagnostics.mjs';

const selector='[role="gridcell"][data-path="Book 001.md"][data-property="note.rating"]';
test('passive numeric receipts distinguish a current begin from an advanced controller without mutating the draft',()=>{
  const dom=new JSDOM(`<div class="pane is-active"><div class="bases-session" data-base-controller-version="10" data-base-controller-updating="false" data-base-controller-error="false"><div class="bases-session-content" aria-busy="false"><div class="zorid-bases-table" data-base-rendered-version="10" role="grid" aria-rowcount="74"><div role="gridcell" data-path="Book 001.md" data-property="note.rating" data-base-widget-version="10" data-base-editing="draft"><input aria-label="rating" value="5"></div></div></div></div></div>`);
  try{
    const d=dom.window.document,input=d.querySelector('input');input.focus();
    const before=d.documentElement.outerHTML,current=numericEditFrame(d,selector);
    assert.equal(current.controllerVersion,'10');assert.equal(current.renderedVersion,'10');assert.equal(current.widgetVersion,'10');assert.equal(current.editors[0].value,'5');assert.equal(current.focus.insideCell,true);assert.equal(current.cellCount,1);assert.equal(current.editorCount,1);assert.equal(current.gridRowCount,'74');assert.equal(current.draftCount,1);
    assert.equal(d.documentElement.outerHTML,before);assert.equal(d.activeElement,input);
    d.querySelector('.bases-session').dataset.baseControllerVersion='11';
    const advanced=numericEditFrame(d,selector);
    assert.equal(advanced.controllerVersion,'11');assert.equal(advanced.renderedVersion,'10');assert.equal(advanced.widgetVersion,'10');assert.equal(advanced.editors[0].value,'5');assert.equal(d.activeElement,input);
  }finally{dom.window.close();}
});
test('missing DOM or markers are recorded rather than admitted, polled or fabricated',()=>{
  const dom=new JSDOM('<main></main>');try{
    const frame=numericEditFrame(dom.window.document,selector);
    assert.equal(frame.controllerVersion,null);assert.equal(frame.renderedVersion,null);assert.equal(frame.widgetVersion,null);assert.equal(frame.cell,null);assert.equal(frame.cellCount,0);assert.equal(frame.editorCount,0);assert.deepEqual(frame.editors,[]);
  }finally{dom.window.close();}
});
