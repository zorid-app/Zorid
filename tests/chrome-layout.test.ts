import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

test('hidden-sidebar traffic-light clearance selects only the first leaf through nested split groups',()=>{
  const dom=new JSDOM('<head></head><body><div class="workspace is-macos-desktop left-hidden"><main class="panes"></main></div></body>');
  try {
    const doc=dom.window.document,style=doc.createElement('style');
    style.textContent=readFileSync(new URL('../src/ui/chrome.css',import.meta.url),'utf8');doc.head.append(style);
    const rules=Array.from((style.sheet!.cssRules[0] as CSSMediaRule).cssRules);
    const selector=(rules.find(rule=>'selectorText' in rule&&String(rule.selectorText).includes('.pane:not(')) as CSSStyleRule).selectorText;
    const leaf=(id:string)=>`<section class="pane split-layout-leaf"><div class="tab-bar" id="${id}"></div></section>`;
    const group=(first:string,second:string)=>`<div class="split-layout-group">${first}<div class="split-layout-separator"></div>${second}</div>`;
    const panes=doc.querySelector('.panes')!;
    for(const markup of [leaf('first'),group(leaf('first'),leaf('right')),group(group(leaf('first'),leaf('below')),group(leaf('upper-right'),leaf('lower-right'))),group(leaf('first'),group(group(leaf('second'),leaf('third')),leaf('fourth')))]){
      panes.innerHTML=markup;assert.deepEqual([...doc.querySelectorAll(selector)].map(node=>node.id),['first']);
    }
    doc.querySelector('.workspace')!.classList.remove('left-hidden');assert.equal(doc.querySelectorAll(selector).length,0);
  } finally {dom.window.close();}
});
