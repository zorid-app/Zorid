import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { icon } from '../src/ui/icons.ts';
import { icon as publicIcon, button } from '../src/ui/dom.ts';

test('shared icon facade preserves aliases, dimensions and decorative accessibility',()=>{
  const dom=new JSDOM('<body></body>'),doc=dom.window.document;
  try {
    assert.equal(publicIcon,icon);
    const file=icon('file',18,doc),unknown=icon('missing',18,doc),prototype=icon('__proto__',18,doc);
    assert.equal(unknown.outerHTML,file.outerHTML);assert.equal(prototype.outerHTML,file.outerHTML);
    assert.equal(file.getAttribute('width'),'18');assert.equal(file.getAttribute('height'),'18');
    assert.equal(file.getAttribute('aria-hidden'),'true');assert.equal(file.getAttribute('focusable'),'false');
    assert.equal(file.getAttribute('stroke-width'),'1.75');assert.equal(icon('file',16,doc).getAttribute('stroke-width'),'2');
    assert.equal(icon('edit',18,doc).outerHTML,icon('square-pen',18,doc).outerHTML);
    assert.equal(icon('sort',18,doc).outerHTML,icon('arrow-up-narrow-wide',18,doc).outerHTML);
    assert.equal(icon('collapse',18,doc).outerHTML,icon('chevrons-down-up',18,doc).outerHTML);
    for(const name of ['folder-plus','gallery-vertical','file-search','home','chevrons-up-down','sticky-note','minus','rotate-cw','maximize','undo-2','redo-2'])assert.notEqual(icon(name,18,doc).innerHTML,file.innerHTML,name);
  } finally {dom.window.close();}
});

test('icons retain native Lucide SVG shapes and belong to the supplied document',()=>{
  const first=new JSDOM('<body></body>'),second=new JSDOM('<body></body>');
  try {
    const sidebar=icon('sidebar',16,second.window.document);
    assert.equal(sidebar.ownerDocument,second.window.document);
    assert.equal(sidebar.querySelector('rect')?.getAttribute('rx'),'2');
    assert.equal(icon('graph',16,first.window.document).querySelectorAll('circle').length,3);
    const other=icon('sidebar',16,second.window.document);sidebar.firstElementChild?.remove();
    assert.notEqual(sidebar.childElementCount,other.childElementCount);
  } finally {first.window.close();second.window.close();}
});

test('existing icon buttons keep their accessible label and click action',()=>{
  const dom=new JSDOM('<body></body>'),previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:dom.window.document});
  try {
    let calls=0;const control=button('folder-plus','New folder',()=>{calls++;});
    assert.equal(control.getAttribute('aria-label'),'New folder');assert.equal(control.title,'New folder');
    assert.equal(control.querySelector('svg')?.getAttribute('aria-hidden'),'true');
    control.click();assert.equal(calls,1);
  } finally {if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');dom.window.close();}
});
