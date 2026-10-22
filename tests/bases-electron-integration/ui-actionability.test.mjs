import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {UI} from './ui.mjs';
import {delay} from '../tasks-electron-integration/cdp.mjs';

function fixture(markup,{deadline=1000}={}) {
  const dom=new JSDOM(`<body>${markup}</body>`,{runScripts:'outside-only'}),{document,HTMLElement}=dom.window;
  const rect={x:10,y:20,width:100,height:30};
  HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[rect];};
  HTMLElement.prototype.getBoundingClientRect=()=>rect;
  HTMLElement.prototype.scrollIntoView=()=>{};
  document.elementFromPoint=()=>document.querySelector('#hit');
  const calls=[],actions=[];
  const cdp={evaluate:source=>structuredClone(dom.window.eval(source)),async call(method,params){
    calls.push({method,params});
    if(method==='Input.dispatchMouseEvent'){
      assert.deepEqual(Object.keys(params).filter(key=>!['type','x','y','button','clickCount','modifiers','buttons'].includes(key)),[],'Passive metadata must never be CDP input');
      if(params.type==='mouseReleased')document.querySelector('#hit').click();
    }
  }};
  const ui=new UI(cdp,actions),wait=ui.wait.bind(ui);
  ui.wait=(body,label,timeout)=>wait(body,label,Math.min(timeout??20000,deadline));
  return {dom,document,ui,calls,actions,close:()=>dom.window.close()};
}

for(const mode of ['click','button'])for(const kind of ['native','fieldset','aria','inert']) {
  test(`${mode} waits for ${kind} enablement before dispatching input`,async()=>{
    const wrapper=kind==='fieldset'?'<fieldset disabled>':kind==='aria'?'<section aria-disabled="true">':kind==='inert'?'<section inert>':'<section>';
    const f=fixture(`${wrapper}<button id="hit"${kind==='native'?' disabled':''}>Go</button>${kind==='fieldset'?'</fieldset>':'</section>'}`);
    try{
      const hit=f.document.querySelector('#hit'),parent=hit.parentElement;
      if(kind==='fieldset'){assert.equal(hit.disabled,false);assert.equal(hit.matches(':disabled'),true);}
      let completed=false;
      const pending=(mode==='button'?f.ui.button('Go'):f.ui.click('#hit')).then(()=>{completed=true;});
      await delay(20);assert.equal(completed,false);assert.equal(f.calls.length,0,'No pointer dispatch while disabled or inert');
      if(kind==='native')hit.disabled=false;else parent.removeAttribute({fieldset:'disabled',aria:'aria-disabled',inert:'inert'}[kind]);
      await pending;
      assert.equal(f.calls.filter(x=>x.params.type==='mousePressed').length,1);
      assert.deepEqual(f.actions[0].actionability.disabledReasons,[]);
      assert.equal(f.actions[0].actionability.inert,false);
      assert.equal(f.actions[0].actionability.allowDisabled,false);
    }finally{f.close();}
  });
}

test('disabled deadline rejects without dispatch; explicit negative click preserves disabled receipt',async()=>{
  const f=fixture('<button id="hit" disabled>Go</button>',{deadline:30});
  try{
    let activated=0;f.document.querySelector('#hit').addEventListener('click',()=>activated++);
    await assert.rejects(f.ui.click('#hit'),/Enabled|Actionable/);assert.equal(f.calls.length,0);
    await f.ui.click('#hit',{allowDisabled:true});
    assert.equal(activated,0,'Native disabled control still rejects activation');
    assert.equal(f.actions[0].actionability.allowDisabled,true);
    assert.equal(f.actions[0].actionability.nativeDisabled,true);
    assert.deepEqual(f.actions[0].actionability.disabledReasons,['native-disabled']);
  }finally{f.close();}
});

test('button negative opt-in is explicit and does not bypass inert or obstruction',async()=>{
  const f=fixture('<section aria-disabled="true"><button id="hit">Go</button></section>',{deadline:30});
  try{
    await f.ui.button('Go','body',{allowDisabled:true});
    assert.equal(f.actions[0].actionability.ariaDisabled,true);
    const count=f.calls.length;f.document.querySelector('section').setAttribute('inert','');
    await assert.rejects(f.ui.button('Go','body',{allowDisabled:true}));assert.equal(f.calls.length,count);
    f.document.querySelector('section').removeAttribute('inert');f.document.elementFromPoint=()=>f.document.body;
    await assert.rejects(f.ui.click('#hit',{allowDisabled:true}));assert.equal(f.calls.length,count);
  }finally{f.close();}
});

test('successful point records only passive generic and existing Base DOM attributes',async()=>{
  const f=fixture('<section class="bases-session" data-base-controller-version="35" data-base-controller-updating="false"><div class="bases-session-content" aria-busy="false"><div class="zorid-bases-table" data-base-rendered-version="35"><div id="hit" role="gridcell" data-path="Book.md" data-property="note.topics" data-base-widget-version="35" aria-disabled="false">Design</div></div></div></section>');
  try{
    await f.ui.click('#hit');const a=f.actions[0].actionability;
    assert.equal(a.base.controllerVersion,'35');assert.equal(a.base.renderedVersion,'35');assert.equal(a.base.widgetVersion,'35');assert.equal(a.base.busy,'false');
    assert.equal(a.target.path,'Book.md');assert.equal(a.target.property,'note.topics');assert.deepEqual(a.disabledReasons,[]);
  }finally{f.close();}
});

test('geometry-only drag point remains available for a disabled drop surface',async()=>{
  const f=fixture('<div id="hit" aria-disabled="true">Drop</div>');
  try{
    const point=await f.ui.point('#hit',0,{requireEnabled:false,receipt:true});
    assert.equal(point.actionability.ariaDisabled,true);assert.equal(point.actionability.requireEnabled,false);assert.equal(f.calls.length,0);
  }finally{f.close();}
});


test('public point keeps its coordinate-only shape for existing drag and hover consumers',async()=>{
  const f=fixture('<button id="hit">Go</button>');
  try{assert.deepEqual(await f.ui.point('#hit'),{x:60,y:35});}finally{f.close();}
});

test('click rechecks generic enablement when pointer movement disables the control',async()=>{
  const f=fixture('<button id="hit">Go</button>'),call=f.ui.cdp.call.bind(f.ui.cdp);
  let released=false;
  f.ui.cdp.call=async(method,params)=>{
    await call(method,params);
    if(params.type==='mouseMoved'){
      f.document.querySelector('#hit').setAttribute('aria-disabled','true');
      setTimeout(()=>{released=true;f.document.querySelector('#hit').removeAttribute('aria-disabled');},25);
    }else if(params.type==='mousePressed')assert.equal(released,true,'No click dispatched while disabled after hover');
  };
  try{await f.ui.click('#hit');assert.equal(f.calls.filter(x=>x.params.type==='mousePressed').length,1);}finally{f.close();}
});

test('Results button rechecks enablement after its passive before-state read',async()=>{
  const f=fixture('<button id="hit" aria-label="Results">3 results</button>'),evaluate=f.ui.cdp.evaluate.bind(f.ui.cdp),call=f.ui.cdp.call.bind(f.ui.cdp),hit=f.document.querySelector('#hit');
  let released=false,observed=false;
  f.ui.cdp.evaluate=source=>{
    const value=evaluate(source);
    if(!observed&&source.includes('expanded:')&&source.includes('summary:')){
      observed=true;hit.setAttribute('aria-disabled','true');
      setTimeout(()=>{released=true;hit.removeAttribute('aria-disabled');},25);
    }
    return value;
  };
  f.ui.cdp.call=async(method,params)=>{
    if(params.type==='mousePressed')assert.equal(released,true,'Do not dispatch using the stale point captured before the diagnostic');
    return call(method,params);
  };
  try{await f.ui.button('Results');assert.equal(observed,true);assert.equal(f.actions[0].actionability.ariaDisabled,false);}finally{f.close();}
});
