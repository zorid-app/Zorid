import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountBaseTooltips} from '../src/bases/tooltips.ts';

const tick=(ms=0)=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(){
  const dom=new JSDOM('<main><button id="filter" data-base-tooltip="Filter" aria-describedby="existing"><span>Icon</span></button><button id="search" data-base-tooltip="Search" data-base-tooltip-shortcut="⌘F">Search</button><button id="other">Other</button></main>',{pretendToBeVisual:true});
  const doc=dom.window.document,host=doc.querySelector('main')!,filter=doc.querySelector<HTMLButtonElement>('#filter')!,search=doc.querySelector<HTMLButtonElement>('#search')!,other=doc.querySelector<HTMLButtonElement>('#other')!;
  const tooltips=mountBaseTooltips(host,{hoverDelayMs:15});
  const pointer=(node:Element,type:'pointerover'|'pointerout'|'pointerdown',relatedTarget:Element|null=null)=>node.dispatchEvent(new dom.window.MouseEvent(type,{bubbles:true,relatedTarget}));
  return{dom,doc,host,filter,search,other,pointer,tooltips,tip:()=>doc.querySelector<HTMLElement>('[role="tooltip"]'),close(){tooltips.destroy();dom.window.close();}};
}

test('hover waits, nested icon transitions retain one hint, and pointer departure cancels pending work',async()=>{
  const f=fixture();try{
    f.pointer(f.filter,'pointerover');assert.equal(f.tip(),null);await tick(25);
    const tip=f.tip()!;assert.ok(tip);assert.equal(tip.textContent,'Filter');assert.ok(f.filter.getAttribute('aria-describedby')!.split(' ').includes(tip.id));
    f.pointer(f.filter.querySelector('span')!,'pointerover',f.filter);await tick();assert.equal(f.tip(),tip);
    f.pointer(f.filter,'pointerout',f.other);assert.equal(f.tip(),null);assert.equal(f.filter.getAttribute('aria-describedby'),'existing');
    f.pointer(f.search,'pointerover');f.pointer(f.search,'pointerout',f.other);await tick(25);assert.equal(f.tip(),null);
  }finally{f.close();}
});

test('keyboard focus exposes the label and supported shortcut immediately without moving focus',()=>{
  const f=fixture();try{
    f.search.focus();const tip=f.tip()!;assert.ok(tip);assert.equal(f.doc.activeElement,f.search);assert.equal(tip.querySelector('.bases-tooltip-label')!.textContent,'Search');assert.equal(tip.querySelector('.bases-tooltip-shortcut')!.textContent?.trim(),'⌘F');
    assert.equal(f.search.getAttribute('aria-describedby'),tip.id);f.other.focus();assert.equal(f.tip(),null);assert.equal(f.search.hasAttribute('aria-describedby'),false);
    f.filter.focus();const id=f.tip()!.id;f.filter.setAttribute('aria-describedby',`existing ${id} later-owner`);f.other.focus();assert.equal(f.filter.getAttribute('aria-describedby'),'existing later-owner');
  }finally{f.close();}
});

test('Escape dismisses pending or visible hints without consuming the key or rearming the same interaction',async()=>{
  const f=fixture();try{
    let escapes=0;f.host.addEventListener('keydown',()=>escapes++);
    f.filter.focus();const event=new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});f.filter.dispatchEvent(event);
    assert.equal(event.defaultPrevented,false);assert.equal(escapes,1);assert.equal(f.tip(),null);assert.equal(f.doc.activeElement,f.filter);
    f.filter.dispatchEvent(new f.dom.window.FocusEvent('focusin',{bubbles:true}));assert.equal(f.tip(),null);
    f.other.focus();f.filter.focus();assert.ok(f.tip());
    const activate=new f.dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});f.filter.dispatchEvent(activate);assert.equal(activate.defaultPrevented,false);assert.equal(f.tip(),null);f.other.focus();
    f.pointer(f.search,'pointerover');f.search.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await tick(25);assert.equal(f.tip(),null);
  }finally{f.close();}
});

test('scroll, resize and pointer activation dismiss hints until the next interaction',()=>{
  const f=fixture();try{
    for(const action of [()=>f.host.dispatchEvent(new f.dom.window.Event('scroll')),()=>f.dom.window.dispatchEvent(new f.dom.window.Event('resize')),()=>f.pointer(f.filter,'pointerdown')]){
      f.other.focus();f.filter.focus();assert.ok(f.tip());action();assert.equal(f.tip(),null);assert.equal(f.filter.getAttribute('aria-describedby'),'existing');assert.equal(f.doc.activeElement,f.filter);
    }
  }finally{f.close();}
});

test('anchor or entire host removal cleans description and delayed hints; destroy releases listeners',async()=>{
  const f=fixture();try{
    f.filter.focus();f.filter.remove();await tick();assert.equal(f.tip(),null);assert.equal(f.filter.getAttribute('aria-describedby'),'existing');
    f.pointer(f.search,'pointerover');f.host.remove();await tick(25);assert.equal(f.tip(),null);
    f.doc.body.append(f.host);f.search.focus();assert.ok(f.tip());f.tooltips.destroy();assert.equal(f.tip(),null);assert.equal(f.search.hasAttribute('aria-describedby'),false);
    f.other.focus();f.search.focus();f.pointer(f.search,'pointerover');await tick(25);assert.equal(f.tip(),null);
  }finally{f.close();}
});

test('only one host owns the document hint and hidden or unmarked controls never open one',()=>{
  const f=fixture(),second=f.doc.createElement('aside');second.innerHTML='<button data-base-tooltip="New">New</button>';f.doc.body.append(second);const another=mountBaseTooltips(second);
  try{
    f.filter.focus();const previous=f.tip()!;second.querySelector<HTMLButtonElement>('button')!.focus();assert.equal(previous.isConnected,false);assert.equal(f.doc.querySelectorAll('[role="tooltip"]').length,1);assert.equal(f.tip()!.textContent,'New');assert.equal(f.filter.getAttribute('aria-describedby'),'existing');
    f.other.focus();assert.equal(f.tip(),null);f.search.hidden=true;f.search.focus();assert.equal(f.tip(),null);
  }finally{another.destroy();f.close();}
});
