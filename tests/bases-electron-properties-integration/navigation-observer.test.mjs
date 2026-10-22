import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {installNavigationObserver,withNavigationObservation} from './navigation-observer.mjs';

const allowedPaths=['Items/Alpha.md','Items/Beta.md','Properties.yaml'],allowedProperties=['author','note.author'];
function fixture(){
  const dom=new JSDOM('<body><aside><div role="treeitem" class="is-active" data-path="Items/Alpha.md">Alpha</div><div id="beta" role="treeitem" data-path="Items/Beta.md">Beta</div></aside><section class="pane is-active"><div class="tab is-active"><span class="tab-title">Alpha</span></div><input class="note-title" value="Alpha"><div data-property-key="author"><div class="metadata-property-value"><span class="multi-select-pill is-unresolved">Private alias</span></div></div><input id="text" value="Secret body text"></section></body>',{runScripts:'outside-only'});
  return {dom,document:dom.window.document,close:()=>dom.window.close()};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('passive event route distinguishes actual tree targets and later navigation without changing input',async()=>{
  const f=fixture(),observer=installNavigationObserver(f.document,{allowedPaths,allowedProperties});
  try{
    const beta=f.document.querySelector('#beta');let calls=0;beta.addEventListener('click',()=>{calls++;f.document.querySelector('[role="treeitem"].is-active').classList.remove('is-active');beta.classList.add('is-active');});
    const click=new f.dom.window.MouseEvent('click',{bubbles:true,cancelable:true,clientX:193.5,clientY:124});beta.dispatchEvent(click);assert.equal(click.defaultPrevented,false);assert.equal(calls,1);
    await settle();
    const author=f.document.querySelector('.multi-select-pill');author.classList.remove('is-unresolved');author.setAttribute('role','link');
    await settle();const trace=observer.stop(),event=trace.events.find(row=>row.kind==='click');
    assert.equal(event.target.treePath,'Items/Beta.md');assert.deepEqual(event.navigation.activeTreePaths,['Items/Alpha.md']);assert.equal(event.trusted,false);
    assert.equal(event.x,193.5);assert.equal(event.y,124);assert.ok(Number.isFinite(event.at)&&Number.isFinite(event.monotonicMs));
    const navigations=trace.events.filter(row=>row.kind==='dom-navigation');assert.ok(navigations.some(row=>row.navigation.activeTreePaths[0]==='Items/Beta.md'));
    assert.deepEqual(trace.final.author,{present:true,linked:true,unresolved:false});assert.equal(f.document.activeElement,f.document.body,'Observer never changes focus');
    assert.equal(trace.stopped,true);const count=trace.events.length;beta.click();await settle();assert.equal(trace.events.length,count,'Stop releases listeners and MutationObserver');
  }finally{f.close();}
});

test('owned allowlist redacts foreign paths, link labels and typed characters',()=>{
  const f=fixture(),observer=installNavigationObserver(f.document,{allowedPaths,allowedProperties});
  try{
    const privateRole=f.document.createElement('private-secret-tag');privateRole.setAttribute('role','Private role text'.repeat(1000));f.document.body.append(privateRole);privateRole.click();
    const secret=f.document.createElement('a');secret.href='https://private.invalid/Secret';secret.textContent='Secret link label';secret.dataset.path='Foreign/Secret.md';secret.setAttribute('role','treeitem');f.document.body.append(secret);secret.click();
    const input=f.document.querySelector('#text');input.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{bubbles:true,key:'S'}));input.dispatchEvent(new f.dom.window.KeyboardEvent('keyup',{bubbles:true,key:'Enter',metaKey:true}));
    const trace=observer.stop(),json=JSON.stringify(trace);
    for(const value of ['Foreign/Secret','private.invalid','Secret link label','Secret body text','Private alias','Private role text','PRIVATE-SECRET-TAG'])assert.ok(!json.includes(value),'No captured private value '+value);
    assert.equal(trace.events.find(row=>row.kind==='click'&&row.target.treePath).target.treePath,'<redacted>');assert.equal(trace.events.find(row=>row.kind==='click'&&row.target.treePath).target.linkLabel,'<redacted>');
    assert.equal(trace.events.find(row=>row.kind==='keydown').key,'<character>');assert.equal(trace.events.find(row=>row.kind==='keyup').key,'Enter');assert.equal(trace.events.find(row=>row.kind==='keyup').modifiers.meta,true);
  }finally{f.close();}
});

test('event cap preserves overflow counts and final navigation then disconnects',()=>{
  const f=fixture(),observer=installNavigationObserver(f.document,{allowedPaths,limit:3});
  try{
    for(let i=0;i<8;i++)f.document.querySelector('#beta').click();
    f.document.querySelector('.note-title').value='Beta';const trace=observer.stop();
    assert.equal(trace.events.length,3);assert.equal(trace.observed,9);assert.equal(trace.dropped,6);assert.equal(trace.stoppedAtCap,true);assert.equal(trace.final.noteTitle,'Beta');assert.equal(trace.stopped,true);
  }finally{f.close();}
});

function contextFixture(){
  const pages=[],calls=[],evidence={actions:[]};let page;
  const context={evidence,get ui(){return {dom:async body=>structuredClone(page.dom.window.eval(`(()=>{${body}})()`))};},async launch(name){calls.push('launch:'+name);page=fixture();pages.push(page);},async quit(name){calls.push('quit:'+name);assert.equal(page.dom.window.__zoridPropertiesNavigationObserver,undefined,'Observer removed before normal quit');page.close();}};
  return {context,pages,calls,get page(){return page;},close(){for(const page of pages)page.close();}};
}

test('campaign wrapper retains original failure, drains before catch and removes observer',async()=>{
  const f=contextFixture(),failure=new Error('Original strict relation oracle');
  try{
    await assert.rejects(withNavigationObservation(f.context,async c=>{await c.launch('first');f.page.document.querySelector('#beta').click();throw failure;},{allowedPaths}),error=>error===failure);
    const trace=f.context.evidence.navigationTrace[0];assert.equal(trace.reason,'campaign-failure');assert.equal(trace.stopped,true);assert.ok(trace.events.some(row=>row.kind==='click'));assert.equal(f.page.dom.window.__zoridPropertiesNavigationObserver,undefined);
    assert.deepEqual(f.calls,['launch:first']);
  }finally{f.close();}
});

test('restart shares one global event cap and observers stop before both original quits',async()=>{
  const f=contextFixture();
  try{
    const result=await withNavigationObservation(f.context,async c=>{for(const name of ['first','restart']){await c.launch(name);for(let i=0;i<5;i++)f.page.document.querySelector('#beta').click();await c.quit(name);}return 'original-result';},{allowedPaths,limit:4});
    assert.equal(result,'original-result');const traces=f.context.evidence.navigationTrace;assert.equal(traces.length,2);assert.equal(traces.reduce((n,trace)=>n+trace.events.length,0),4);assert.equal(traces[1].limit,0);assert.ok(traces[1].dropped>0);assert.ok(traces.every(trace=>trace.stopped&&trace.reason==='before-normal-quit'));
    assert.deepEqual(f.calls,['launch:first','quit:first','launch:restart','quit:restart']);assert.equal(f.context.evidence.actions.length,0,'Observer adds no product actions');
  }finally{f.close();}
});


test('cap stops target and DOM traversal until one bounded final frame',()=>{
  const f=fixture(),observer=installNavigationObserver(f.document,{allowedPaths,limit:1});
  try{
    const original=f.document.querySelector.bind(f.document),all=f.document.querySelectorAll.bind(f.document);let reads=0;
    f.document.querySelector=(...args)=>{reads++;return original(...args);};f.document.querySelectorAll=(...args)=>{reads++;return all(...args);};
    const beta=original('#beta');for(let i=0;i<20;i++)beta.click();assert.equal(reads,0,'Capped input listeners only increment counters');
    for(let i=0;i<20;i++){const node=f.document.createElement('div');node.setAttribute('role','treeitem');node.dataset.path='Foreign/'+i;node.classList.add('is-active');f.document.body.append(node);}
    const trace=observer.stop();assert.equal(trace.events.length,1);assert.equal(trace.dropped,20);assert.equal(trace.final.activeTreePaths.length,8);assert.equal(trace.final.moreActivePaths,true);assert.ok(reads>0);
  }finally{f.close();}
});

test('observer-only install failure preserves original actions, quit and result',async()=>{
  const f=contextFixture(),originalUi=Object.getOwnPropertyDescriptor(f.context,'ui').get;
  Object.defineProperty(f.context,'ui',{get(){const ui=originalUi.call(f.context);return {dom:body=>{if(body.includes('installNavigationObserver'))throw new Error('Foreign/private/Secret-install-details'.repeat(1000));return ui.dom(body);}};}});
  try{
    const result=await withNavigationObservation(f.context,async c=>{await c.launch('first');f.context.evidence.actions.push({action:'original'});await c.quit('first');return 'original-result';},{allowedPaths});
    assert.equal(result,'original-result');assert.deepEqual(f.calls,['launch:first','quit:first']);assert.equal(f.context.evidence.actions.length,1);assert.equal(f.context.evidence.navigationTraceIncomplete,true);assert.ok(f.context.evidence.navigationObserverErrors.some(row=>row.stage==='install'));assert.ok(!JSON.stringify(f.context.evidence.navigationObserverErrors).includes('Secret-install-details'));
  }finally{f.close();}
});

test('drain diagnostic failure cannot replace an original success or exception',async()=>{
  for(const failure of [null,new Error('Original strict oracle')]){
    const f=contextFixture(),originalUi=Object.getOwnPropertyDescriptor(f.context,'ui').get;
    Object.defineProperty(f.context,'ui',{get(){const ui=originalUi.call(f.context);return {dom:body=>{if(body.includes('owner.handle.stop()')){ui.dom(body);throw new Error('Diagnostic transport failed after cleanup');}return ui.dom(body);}};}});
    try{
      const pending=withNavigationObservation(f.context,async c=>{await c.launch('first');if(failure)throw failure;await c.quit('first');return 'original-result';},{allowedPaths});
      if(failure)await assert.rejects(pending,error=>error===failure);else assert.equal(await pending,'original-result');
      assert.equal(f.context.evidence.navigationTraceIncomplete,true);assert.ok(f.context.evidence.navigationObserverErrors.some(row=>row.stage==='drain'));assert.equal(f.page.dom.window.__zoridPropertiesNavigationObserver,undefined);
    }finally{f.close();}
  }
});


test('fresh launch nonce never stops a foreign owner with the former same-prefix token',async()=>{
  const f=contextFixture(),launch=f.context.launch.bind(f.context);let foreignStops=0,foreign;
  f.context.launch=async name=>{await launch(name);foreign={token:'properties-navigation-1',handle:{stop(){foreignStops++;}}};f.page.dom.window.__zoridPropertiesNavigationObserver=foreign;};
  f.context.quit=async name=>{f.calls.push('quit:'+name);assert.equal(f.page.dom.window.__zoridPropertiesNavigationObserver,foreign);f.page.close();};
  try{
    const result=await withNavigationObservation(f.context,async c=>{await c.launch('first');await c.quit('first');return 'original-result';},{allowedPaths});
    assert.equal(result,'original-result');assert.equal(foreignStops,0);assert.equal(f.context.evidence.navigationTraceIncomplete,true);assert.equal(f.context.evidence.navigationObserverCleanupUnconfirmed,true);
  }finally{f.close();}
});

test('drain failure before remote stop is explicitly unconfirmed and original teardown remains available',async()=>{
  for(const failure of [null,new Error('Original strict oracle')]){
    const f=contextFixture(),originalUi=Object.getOwnPropertyDescriptor(f.context,'ui').get;let teardownSawLiveObserver=false;
    Object.defineProperty(f.context,'ui',{get(){const ui=originalUi.call(f.context);return {dom:body=>{if(body.includes('owner.handle.stop()'))throw new Error('Diagnostic transport failed before remote stop');return ui.dom(body);}};}});
    f.context.quit=async name=>{f.calls.push('quit:'+name);teardownSawLiveObserver=!!f.page.dom.window.__zoridPropertiesNavigationObserver;f.page.close();};
    try{
      const pending=withNavigationObservation(f.context,async c=>{await c.launch('first');if(failure)throw failure;await c.quit('first');return 'original-result';},{allowedPaths});
      if(failure){await assert.rejects(pending,error=>error===failure);assert.ok(f.page.dom.window.__zoridPropertiesNavigationObserver,'Runner-owned window cleanup is still needed after failed drain');}
      else{assert.equal(await pending,'original-result');assert.equal(teardownSawLiveObserver,true);}
      assert.equal(f.context.evidence.navigationObserverCleanupUnconfirmed,true);assert.equal(f.context.evidence.navigationTraceIncomplete,true);
    }finally{f.close();}
  }
});
