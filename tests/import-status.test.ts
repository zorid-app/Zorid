import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountImportStatus } from '../src/ui/import-status.ts';
import type { DesktopReconciliation } from '../src/platform/bridge';

function report(overrides:Partial<DesktopReconciliation>={}):DesktopReconciliation{return{
  scanId:'scan-one',complete:false,scanComplete:false,finished:false,observed:3,imported:1,namespaceApplied:1,
  issueCount:1,issuesTruncated:false,issues:[{path:'Unfinished.md',code:'changed_during_scan'}],...overrides,
};}
function setup(){const dom=new JSDOM('<main></main>');const previous=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{configurable:true,value:dom.window.document});return{dom,host:document.querySelector('main')!,close(){dom.window.close();if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');}};}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

test('incomplete import stays visible for empty and populated usable vaults without claiming an empty vault',()=>{
  const f=setup();try{
    const view=mountImportStatus(f.host,{status:report(),entryCount:0,retry:async()=>{}});
    assert.equal(view.element.hidden,false);assert.match(view.element.querySelector('[role=status]')!.textContent!,/may contain notes that are not shown/);
    const details=view.element.querySelector('details')!;assert.equal(details.open,false);details.open=true;
    view.update(report(),2);assert.equal(view.element.hidden,false);assert.match(view.element.querySelector('[role=status]')!.textContent!,/imported notes are available/);assert.equal(details.open,true);
    assert.match(details.textContent!,/Unfinished.md/);assert.match(details.textContent!,/3 items checked/);
    view.destroy();assert.equal(f.host.childElementCount,0);
  }finally{f.close();}
});

test('pending status stays visible and a completed report clears the persistent warning',()=>{
  const f=setup();try{
    const view=mountImportStatus(f.host,{status:null,entryCount:0,retry:async()=>{}});assert.equal(view.element.hidden,false);assert.equal(view.element.dataset.state,'checking');
    view.update(report({complete:true,scanComplete:true,finished:true,issueCount:0,issues:[]}),0);assert.equal(view.element.hidden,true);
    view.update(report({failure:'scan_failed',complete:true}),0);assert.equal(view.element.hidden,false);view.destroy();
  }finally{f.close();}
});

test('retry coalesces clicks, accepts subscribed status updates and hides only after completion',async()=>{
  const f=setup();try{
    let release!:()=>void,calls=0;const wait=new Promise<void>(resolve=>{release=resolve;});
    const view=mountImportStatus(f.host,{status:report(),entryCount:1,retry:async()=>{calls++;await wait;}});
    const button=view.element.querySelector('button')!;button.click();button.click();assert.equal(calls,1);assert.equal(button.disabled,true);
    view.update(report({complete:true,scanComplete:true,finished:true,issueCount:0,issues:[]}),3);assert.equal(view.element.hidden,false);
    release();await tick();assert.equal(button.disabled,false);assert.equal(view.element.hidden,true);view.destroy();
  }finally{f.close();}
});

test('retry failure remains actionable and diagnostic paths are rendered as text',async()=>{
  const f=setup();try{
    const view=mountImportStatus(f.host,{status:report({issues:[{path:'<img src=x onerror=bad()>',code:'reconciliation_blocked'}],issuesTruncated:true}),entryCount:0,retry:async()=>{throw new Error('Folder cannot be read');}});
    assert.equal(view.element.querySelector('img'),null);view.element.querySelector('button')!.click();await tick();
    assert.equal(view.element.hidden,false);assert.match(view.element.textContent!,/Folder cannot be read/);assert.equal(view.element.querySelector('button')!.disabled,false);
    view.destroy();view.update(report(),9);assert.equal(f.host.childElementCount,0);
  }finally{f.close();}
});
