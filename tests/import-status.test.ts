import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountImportStatus } from '../src/ui/import-status.ts';
import type { DesktopReconciliation } from '../src/platform/bridge';

function report(overrides:Partial<DesktopReconciliation>={}):DesktopReconciliation{return{
  scanId:'scan-one',complete:false,scanComplete:false,finished:false,observed:3,imported:1,namespaceApplied:1,
  issueCount:1,issuesTruncated:false,issues:[{path:'Unfinished.md',code:'changed_during_scan'}],...overrides,
};}
const completed=()=>report({complete:true,scanComplete:true,finished:true,issueCount:0,issues:[]});
function setup(){const dom=new JSDOM('<main></main>');const previous=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{configurable:true,value:dom.window.document});return{dom,host:document.querySelector('main')!,close(){dom.window.close();if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');}};}
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
const delays=[1_000,3_000,10_000,30_000];

test('routine checks are quiet for available notes and never imply an unchecked vault is empty',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=setup();try{
    const view=mountImportStatus(f.host,{status:null,entryCount:0,retry:async()=>{}});
    assert.equal(view.element.hidden,false);assert.equal(view.element.dataset.state,'checking');
    assert.match(view.element.textContent!,/notes will appear/i);assert.doesNotMatch(view.element.textContent!,/empty|complete|safe/i);
    assert.equal(view.element.querySelector('button')!.hidden,true);
    view.update(report(),2);assert.equal(view.element.hidden,true);
    view.update(completed(),0);assert.equal(view.element.hidden,true);
    view.destroy();assert.equal(f.host.childElementCount,0);
  }finally{f.close();}
});

test('automatic retries back off, ignore duplicate notifications and stop at a bounded actionable state',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=setup();try{
    let calls=0;
    const view=mountImportStatus(f.host,{status:report(),entryCount:1,retry:async()=>{calls++;view.update(report(),1);}});
    for(const [index,delay] of delays.entries()){
      // Frequent status notifications do not postpone retry or reset its budget.
      view.update(report(),1);view.update(report(),1);
      t.mock.timers.tick(delay-1);assert.equal(calls,index);
      t.mock.timers.tick(1);assert.equal(calls,index+1);await settle();
      assert.equal(view.element.hidden,index!==delays.length-1);
    }
    assert.equal(view.element.dataset.state,'incomplete');
    assert.match(view.element.textContent!,/Check that the folder is available/);
    assert.equal(view.element.querySelector('button')!.hidden,false);
    view.update(report(),1);t.mock.timers.tick(1_000_000);await settle();assert.equal(calls,4);
    view.element.querySelector('button')!.click();assert.equal(calls,5);await settle();
    assert.equal(view.element.hidden,true);
    view.destroy();
  }finally{f.close();}
});

test('a transient interruption settles automatically without showing a warning',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=setup();try{
    let calls=0;
    const view=mountImportStatus(f.host,{status:report(),entryCount:2,retry:async()=>{calls++;view.update(completed(),3);}});
    assert.equal(view.element.hidden,true);
    t.mock.timers.tick(1_000);await settle();
    assert.equal(calls,1);assert.equal(view.element.hidden,true);assert.equal(view.element.getAttribute('aria-busy'),'false');
    t.mock.timers.tick(1_000_000);assert.equal(calls,1);view.destroy();
  }finally{f.close();}
});

test('only one recovery runs at a time and completion cancels all future work',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=setup();try{
    let release!:()=>void,calls=0;const wait=new Promise<void>(resolve=>{release=resolve;});
    const view=mountImportStatus(f.host,{status:report(),entryCount:0,retry:async()=>{calls++;await wait;}});
    t.mock.timers.tick(1_000);assert.equal(calls,1);
    const button=view.element.querySelector('button')!;assert.equal(button.disabled,true);button.click();button.click();
    view.update(report(),0);t.mock.timers.tick(1_000_000);assert.equal(calls,1);
    view.update(completed(),0);assert.equal(view.element.hidden,true);
    release();await settle();t.mock.timers.tick(1_000_000);assert.equal(calls,1);
    // A genuinely new incomplete episode can recover again.
    view.update(report(),1);t.mock.timers.tick(1_000);await settle();assert.equal(calls,2);
    view.destroy();
  }finally{f.close();}
});

test('completion before retry and destruction before or during retry cancel scheduled work',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=setup();try{
    let calls=0;
    const completedView=mountImportStatus(f.host,{status:report(),entryCount:1,retry:async()=>{calls++;}});
    completedView.update(completed(),1);t.mock.timers.tick(1_000_000);assert.equal(calls,0);completedView.destroy();
    const removed=mountImportStatus(f.host,{status:report(),entryCount:1,retry:async()=>{calls++;}});
    removed.destroy();t.mock.timers.tick(1_000_000);assert.equal(calls,0);
    let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});
    const running=mountImportStatus(f.host,{status:report(),entryCount:1,retry:async()=>{calls++;await wait;}});
    t.mock.timers.tick(1_000);assert.equal(calls,1);running.destroy();running.update(report(),9);
    release();await settle();t.mock.timers.tick(1_000_000);assert.equal(calls,1);assert.equal(f.host.childElementCount,0);
  }finally{f.close();}
});

test('backend exceptions, paths, identifiers and technical counters never enter the DOM',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=setup();try{
    let calls=0;
    const view=mountImportStatus(f.host,{
      status:report({failure:'scan_failed',scanId:'secret-uuid',issues:[{path:'<img src=x onerror=bad()>',code:'reconciliation_blocked'}],issuesTruncated:true}),
      entryCount:0,retry:async()=>{calls++;throw new Error('IPC schema mismatch secret-uuid /private/vault.sqlite');},
    });
    for(const delay of delays){t.mock.timers.tick(delay);await settle();assert.doesNotMatch(view.element.outerHTML,/IPC|schema|secret-uuid|private|sqlite|scan|imported|items checked|reconciliation|<img/i);}
    assert.equal(calls,4);assert.equal(view.element.hidden,false);assert.equal(view.element.querySelector('button')!.disabled,false);
    assert.match(view.element.textContent!,/Some notes aren’t available yet/);
    view.update(completed(),2);assert.equal(view.element.hidden,true);view.destroy();
  }finally{f.close();}
});


test('large vault progress continues beyond four pages with at least a one-second yield',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=setup();try{
    let calls=0;
    const view=mountImportStatus(f.host,{status:report({observed:0}),entryCount:1,retry:async()=>{
      calls++;
      view.update(report({observed:calls*10_000,...(calls===12?{complete:true,scanComplete:true,finished:true}: {})}),1);
    }});
    for(let page=1;page<=12;page++){
      t.mock.timers.tick(999);assert.equal(calls,page-1);
      t.mock.timers.tick(1);await settle();assert.equal(calls,page);
      assert.equal(view.element.hidden,true);assert.equal(view.element.querySelector('button')!.hidden,true);
    }
    t.mock.timers.tick(1_000_000);await settle();assert.equal(calls,12);view.destroy();
  }finally{f.close();}
});

test('completed physical scan keeps importing durable pages beyond four retries, then bounds a real stall',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=setup();try{
    let calls=0,count=163;
    const status=()=>report({observed:1025,scanComplete:true,finished:true,imported:151});
    const view=mountImportStatus(f.host,{status:status(),entryCount:count,retry:async()=>{
      calls++;
      // The scan counters stay fixed, and the per-call import counter repeats.
      // Workspace publishes status before reloading its durable inventory.
      view.update(status(),count);
      if(calls<=7)count+=100;
      view.update(status(),count);
    }});
    for(let page=1;page<=7;page++){
      t.mock.timers.tick(999);assert.equal(calls,page-1);
      t.mock.timers.tick(1);await settle();assert.equal(calls,page);
      assert.equal(view.element.hidden,true);
    }
    // Counts falling and returning to their high water mark are not new work.
    view.update(status(),count-1);view.update(status(),count);
    for(const delay of delays){t.mock.timers.tick(delay);await settle();}
    assert.equal(calls,11);assert.equal(view.element.dataset.state,'incomplete');
    t.mock.timers.tick(1_000_000);await settle();assert.equal(calls,11);
    view.element.querySelector('button')!.click();await settle();assert.equal(calls,12);
    view.update(completed(),count);t.mock.timers.tick(1_000_000);assert.equal(calls,12);view.destroy();
  }finally{f.close();}
});

test('new scan identities, first reports and per-call counters do not replenish stalled retries',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=setup();try{
    let calls=0;
    const view=mountImportStatus(f.host,{status:null,entryCount:1,retry:async()=>{
      calls++;
      view.update(report({scanId:`new-scan-${calls}`,observed:calls*10_000,imported:calls,namespaceApplied:calls}),calls);
      view.update(report({scanId:`new-scan-${calls}`,observed:calls*10_000,imported:calls+1,namespaceApplied:calls+1}),calls);
    }});
    for(const delay of delays){t.mock.timers.tick(delay);await settle();}
    assert.equal(calls,4);assert.equal(view.element.hidden,false);
    t.mock.timers.tick(1_000_000);await settle();assert.equal(calls,4);view.destroy();
  }finally{f.close();}
});

test('scan completion is progress once; regressing observations and repeated transitions still stall',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=setup();try{
    let calls=0;
    const view=mountImportStatus(f.host,{status:report({observed:100}),entryCount:1,retry:async()=>{
      calls++;
      view.update(report({observed:50,scanComplete:false}),1);
      view.update(report({observed:100,scanComplete:true}),1);
    }});
    t.mock.timers.tick(1_000);await settle();assert.equal(calls,1);assert.equal(view.element.hidden,true);
    // The first false -> true transition earns another recovery budget. Later
    // duplicate transitions and regressions do not reset those four attempts.
    for(const delay of delays){t.mock.timers.tick(delay);await settle();}
    assert.equal(calls,5);assert.equal(view.element.hidden,false);
    t.mock.timers.tick(1_000_000);await settle();assert.equal(calls,5);view.destroy();
  }finally{f.close();}
});
