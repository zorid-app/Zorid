import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {UI} from './ui.mjs';

// A native/custom menu is never opened by these rejected-admission cases. The
// retained receipt distinguishes the actual public model from an inferred kind.
test('missing requested operator retains its exact selected property/catalog and fails before input',async()=>{
  const dom=new JSDOM('<div class="pane is-active"><div class="bases-session" data-base-controller-version="11" data-base-controller-updating="false" data-base-controller-error="false"><div class="bases-session-content" aria-busy="false"><div class="zorid-bases-table" data-base-rendered-version="11"></div></div></div></div><div class="bases-filter-condition"><select aria-label="Filter property"><option value="note.text" selected>text</option></select><select aria-label="Condition" hidden><option value="eq">is</option><option value="neq">is not</option><option value="isEmpty">is empty</option></select><button role="combobox" aria-label="Condition">is</button></div>',{runScripts:'outside-only'});
  const actions=[],inputs=[],reads=[],cdp={evaluate(source){reads.push(source);return structuredClone(dom.window.eval(source));},async call(...args){inputs.push(args);}};
  const before=dom.window.document.documentElement.outerHTML,focus=dom.window.document.activeElement;
  try{
    await assert.rejects(new UI(cdp,actions).select('select[aria-label="Condition"]','notEndsWith'),/Selectable notEndsWith/);
    assert.deepEqual(inputs,[],'Diagnostics cannot open a menu, dispatch keys or retry the rejected command');
    assert.equal(reads.length,1,'The original first model admission still decides this failure');
    assert.equal(actions.length,1);const receipt=actions[0];
    assert.equal(receipt.action,'select-value-model');assert.equal(receipt.requestedValue,'notEndsWith');
    assert.deepEqual(receipt.model,{matches:1,connected:true,label:'Condition',custom:true,value:'eq',selectedIndex:0,nativeDisabled:false,ariaDisabled:false,inert:false,values:[{value:'eq',label:'is',disabled:false},{value:'neq',label:'is not',disabled:false},{value:'isEmpty',label:'is empty',disabled:false}],filterProperty:'note.text',activeBase:{controllerVersion:'11',controllerUpdating:'false',controllerError:'false',busy:'false',renderedVersion:'11'}});
    assert.equal(dom.window.document.documentElement.outerHTML,before);assert.equal(dom.window.document.activeElement,focus);
    assert.ok(reads.every(source=>!source.includes('dispatchEvent')&&!/\.value\s*=(?!=)/.test(source)));
  }finally{dom.window.close();}
});

test('disabled and repeated matching controls remain honestly visible in rejected model receipts',async()=>{
  const dom=new JSDOM('<section aria-disabled="true" inert><select aria-label="Condition" disabled><option value="notEndsWith" disabled>does not end with</option></select></section><select aria-label="Condition"><option value="eq">is</option></select>',{runScripts:'outside-only'}),actions=[],inputs=[];
  try{
    const ui=new UI({evaluate:source=>structuredClone(dom.window.eval(source)),async call(...args){inputs.push(args);}},actions);
    await assert.rejects(ui.select('select[aria-label="Condition"]','notEndsWith'),/Selectable notEndsWith/);
    assert.deepEqual(inputs,[]);assert.equal(actions.length,1);
    assert.equal(actions[0].model.matches,2,'Diagnostics report ambiguity without changing the existing first-match route');
    assert.equal(actions[0].model.nativeDisabled,true);assert.equal(actions[0].model.ariaDisabled,true);assert.equal(actions[0].model.inert,true);
    assert.equal(actions[0].model.values[0].disabled,true);assert.equal(actions[0].model.filterProperty,null);assert.equal(actions[0].model.activeBase,null);
  }finally{dom.window.close();}
});
