import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderStartupError } from '../src/ui/startup-error.ts';

test('startup failure presents plain guidance and collapsed selectable diagnostics with safe actions',async()=>{
  const dom=new JSDOM('<div id="app"></div>');
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:dom.window.document});
  try{
    const root=document.querySelector<HTMLElement>('#app')!;root.className='workspace right-hidden';let retried=0,opened=0;
    renderStartupError(root,new Error('secret-free low-level diagnostic'),{retry:()=>{retried++;}});
    assert.equal(root.className,'startup-failed');
    assert.equal(root.querySelector('h1')?.textContent,'Unable to open the workspace');
    assert.doesNotMatch(root.querySelector('p')!.textContent!,/low-level diagnostic/);
    const details=root.querySelector('details')!;assert.equal(details.open,false);
    assert.match(details.querySelector('pre')!.textContent!,/low-level diagnostic/);
    const buttons=()=>[...root.querySelectorAll('button')];
    assert.equal(buttons().some(button=>button.textContent==='Open another vault'),false);
    buttons().find(button=>button.textContent==='Try again')!.click();assert.equal(retried,1);
    renderStartupError(root,'admission failure',{retry:()=>{},openAnotherVault:()=>{opened++;}});
    buttons().find(button=>button.textContent==='Open another vault')!.click();assert.equal(opened,1);
    let exported=0;renderStartupError(root,'Rust assets unavailable',{retry:()=>{},legacyExport:()=>{exported++;}});
    buttons().find(button=>button.textContent==='Export previous browser vault')!.click();assert.equal(exported,1);
    assert.equal(buttons().some(button=>button.textContent==='Open another vault'),false);
  }finally{dom.window.close();if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');}
});
