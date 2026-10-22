import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {UI} from '../bases-electron-integration/ui.mjs';
import {openPicker} from './campaign.mjs';

const selector='.pane.is-active .bases-list-item[data-path="Items/Alpha.md"] .bases-metadata-value[data-property="note.reference"]';
// Authored helper tests only: synthetic DOM geometry/input admission is not an
// Electron/native result. The production campaign still sends genuine CDP input.
function fixture({firstRead,timeout=500,noPadding=false}={}){
  const dom=new JSDOM('<section class="pane is-active"><div class="bases-session" data-base-controller-version="8" data-base-controller-updating="false" data-base-controller-error="false"><div class="bases-session-content" aria-busy="false"><div class="bases-list-item" data-path="Items/Alpha.md"><span class="bases-metadata-value" data-property="note.reference" data-base-widget-version="8" data-base-property-editable="true" aria-disabled="false" tabindex="0"><span role="link">Original alias</span></span></div></div></div></section>',{runScripts:'outside-only'});
  const document=dom.window.document,actions=[],inputs=[],navigation=[],polls=[];
  const property=()=>document.querySelector(selector),session=document.querySelector('.bases-session'),content=document.querySelector('.bases-session-content');
  const rect={x:100,y:200,width:200,height:30,right:300,bottom:230,left:100,top:200};
  dom.window.HTMLElement.prototype.getClientRects=function(){return this.isConnected&&!this.closest('[hidden]')?[rect]:[];};
  dom.window.HTMLElement.prototype.getBoundingClientRect=function(){return rect;};
  dom.window.HTMLElement.prototype.scrollIntoView=function(){};
  document.elementFromPoint=()=>noPadding?property().firstElementChild:property();
  const showPicker=()=>{const popup=document.createElement('div');popup.className='bases-property-popover';popup.innerHTML='<input role="combobox">';document.body.append(popup);popup.firstChild.focus();};
  const cdp={async evaluate(source){const value=dom.window.eval(source);if(source.includes('getClientRects')){polls.push(value);if(polls.length===1)firstRead?.({value,property,session,content,document});}return structuredClone(value);},async call(method,input){
    assert.equal(method,'Input.dispatchMouseEvent');assert.equal(property().getAttribute('aria-disabled'),'false');assert.equal(session.dataset.baseControllerUpdating,'false');assert.equal(content.getAttribute('aria-busy'),'false');assert.equal(property().dataset.baseWidgetVersion,session.dataset.baseControllerVersion);
    inputs.push(input);if(input.type==='mouseReleased')showPicker();
  }};
  const ui=new UI(cdp,actions),wait=ui.wait.bind(ui);ui.wait=(body,label)=>wait(body,label,timeout);
  ui.button=async(label,scope)=>{navigation.push({kind:'button',label,scope});};
  ui.key=async key=>{navigation.push({kind:'key',key});if(key==='Tab')property().focus();if(key==='Enter')showPicker();};
  return {dom,document,property,session,content,inputs,navigation,polls,context:{ui,cdp,evidence:{actions}},actions,close(){dom.window.close();}};
}

test('padding input waits through disabled/updating state and reads the fresh replacement property once enabled',async()=>{
  let previous;
  const f=fixture({firstRead({value,property,session,content}){
    assert.equal(value,false);previous=property();const next=previous.cloneNode(true);next.setAttribute('aria-disabled','false');next.dataset.baseWidgetVersion='8';previous.replaceWith(next);session.dataset.baseControllerUpdating='false';content.setAttribute('aria-busy','false');
  }});
  try{
    f.property().setAttribute('aria-disabled','true');f.property().dataset.baseWidgetVersion='7';f.session.dataset.baseControllerUpdating='true';f.content.setAttribute('aria-busy','true');
    await openPicker(f.context,selector);
    assert.equal(previous.isConnected,false);assert.equal(f.polls.length,2);assert.deepEqual(f.inputs,[{type:'mousePressed',button:'left',clickCount:1,x:297,y:215},{type:'mouseReleased',button:'left',clickCount:1,x:297,y:215}]);
    assert.deepEqual(f.navigation,[]);assert.equal(f.actions.length,1);assert.equal(f.actions[0].action,'pointer-property-padding');assert.deepEqual(f.actions[0].point,{x:297,y:215});
    const witness=f.actions[0].observation.target;assert.equal(witness.ariaDisabled,false);assert.equal(witness.controllerUpdating,false);assert.equal(witness.busy,false);assert.equal(witness.widgetVersion,'8');assert.equal(witness.controllerVersion,'8');assert.equal(witness.path,'Items/Alpha.md');
  }finally{f.close();}
});

test('an already enabled current property keeps the original neutral point and exactly one pointer pair',async()=>{
  const f=fixture();try{await openPicker(f.context,selector);assert.equal(f.polls.length,1);assert.equal(f.inputs.length,2);assert.deepEqual(f.inputs.map(value=>({x:value.x,y:value.y,clickCount:value.clickCount})),[{x:297,y:215,clickCount:1},{x:297,y:215,clickCount:1}]);assert.deepEqual(f.navigation,[]);}finally{f.close();}
});

test('a property that never becomes actionable rejects without pointer input, fallback keys or an action receipt',async()=>{
  for(const state of ['disabled','updating','busy','error','old-widget','no-widget','hidden','inert','draft']){
    const f=fixture({timeout:5});try{
      if(state==='disabled')f.property().setAttribute('aria-disabled','true');
      if(state==='updating')f.session.dataset.baseControllerUpdating='true';
      if(state==='busy')f.content.setAttribute('aria-busy','true');
      if(state==='error')f.session.dataset.baseControllerError='true';
      if(state==='old-widget')f.property().dataset.baseWidgetVersion='7';
      if(state==='no-widget')delete f.property().dataset.baseWidgetVersion;
      if(state==='hidden')f.property().hidden=true;
      if(state==='inert')f.property().setAttribute('inert','');
      if(state==='draft')f.property().dataset.baseEditing='draft';
      await assert.rejects(openPicker(f.context,selector),/Enabled current property before picker input/,state);assert.deepEqual(f.inputs,[],state);assert.deepEqual(f.navigation,[],state);assert.deepEqual(f.actions,[],state);
    }finally{f.close();}
  }
});

test('enabled values with no neutral padding preserve the existing Views/Escape/Tab/Enter fallback',async()=>{
  const f=fixture({noPadding:true});try{
    await openPicker(f.context,selector);assert.equal(f.polls.length,1);assert.deepEqual(f.inputs,[]);assert.deepEqual(f.navigation,[{kind:'button',label:'Views',scope:'.pane.is-active'},{kind:'key',key:'Escape'},{kind:'key',key:'Tab'},{kind:'key',key:'Enter'}]);assert.ok(f.document.querySelector('.bases-property-popover input'));assert.deepEqual(f.actions,[]);
  }finally{f.close();}
});
