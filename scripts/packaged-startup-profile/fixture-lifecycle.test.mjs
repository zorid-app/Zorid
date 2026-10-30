import test from 'node:test';
import assert from 'node:assert/strict';
import {autosaveFixtures,pressFixtureKey,restoreAutosavedFixture} from './fixture-lifecycle.mjs';
function fixture(markers='xy',options={}){
  const original='Heading\noriginal body';let body=markers+original,head=markers.length,deletions=[],backspaces=[];const keys=[];
  return{original,markers,keys,get body(){return body;},read:async()=>({body,head,anchor:head,ranges:1,deletions,backspaces}),guard:async()=>{},key:async key=>{keys.push(key);if(key==='Home')head=0;else if(key==='ArrowRight')head++;else if(key==='Backspace'){if(!options.noChange){body=body.slice(0,head-1)+body.slice(head);head--;}const event={trusted:!options.synthetic,key:'Backspace',code:'Backspace',modifiers:0,defaultPrevented:true};backspaces.push(event);if(options.duplicate)backspaces.push(event);if(options.beforeinput)deletions.push({trusted:!options.untrustedBeforeinput,inputType:'deleteContentBackward'});}},change:()=>body='foreign',badCaret:()=>head++,untrusted:()=>{backspaces=[{trusted:false,key:'Backspace',code:'Backspace',modifiers:0}];}};
}
test('autosave fixture mode is explicit and default behavior stays disabled',()=>{assert.equal(autosaveFixtures([]),false);assert.equal(autosaveFixtures(['--prewarm-empty-profile']),false);assert.equal(autosaveFixtures(['--autosave-fixtures']),true);});
test('restoration sends only ordinary Home, right arrows and one Backspace per confirmed marker',async()=>{
  for(const markers of ['x','xy','yx']){const f=fixture(markers),result=await restoreAutosavedFixture(f);assert.equal(f.body,f.original);assert.deepEqual(f.keys,['Home',...Array(markers.length).fill('ArrowRight'),...Array(markers.length).fill('Backspace')]);assert.equal(result.mode,'autosave-trusted-backspace');assert.equal(result.receipts.length,markers.length);}
});
test('changed body, wrong caret, untrusted deletion and foreground loss stop without retries',async()=>{
  for(const mutation of ['change','badCaret']){const f=fixture();f[mutation]();await assert.rejects(restoreAutosavedFixture(f));assert.deepEqual(f.keys,[]);}
  const f=fixture();let guards=0;f.guard=async()=>{if(++guards===2)throw Error('focus lost');};await assert.rejects(restoreAutosavedFixture(f),/focus lost/);assert.deepEqual(f.keys,['Home']);
  const untrusted=fixture('xy',{synthetic:true});await assert.rejects(restoreAutosavedFixture(untrusted),/acknowledged|Untrusted/);assert.equal(untrusted.keys.filter(key=>key==='Backspace').length,1);
});
test('plain restoration events carry explicit native identity, no Meta modifier or synthesized commands',async()=>{
  for(const code of ['Home','ArrowRight','Backspace']){const events=[];await pressFixtureKey({call:async(method,event)=>{assert.equal(method,'Input.dispatchKeyEvent');events.push(event);}},code);assert.deepEqual(events.map(event=>event.type),['keyDown','keyUp']);assert.ok(events.every(event=>event.modifiers===0&&event.code===code&&Number.isInteger(event.nativeVirtualKeyCode)&&!Object.hasOwn(event,'commands')));}
  for(const key of ['KeyS','KeyZ'])await assert.rejects(pressFixtureKey({call:()=>assert.fail('must not dispatch')},key));
});

test('renderer observer authenticates the real selected editor and records only trusted deletion observations',async()=>{
  const {default:vm}=await import('node:vm'),{fixtureEditorSource}=await import('./fixture-lifecycle.mjs');
  let body='xyHeading',head=2,hidden=false,title='Note',identity='case',editable='true';const listeners=new Map();
  const node={getAttribute:()=>editable,closest:()=>null,contains:target=>target===node},view={contentDOM:node,state:{doc:{toString:()=>body},selection:{main:{get head(){return head;},get anchor(){return head;}},ranges:[{}]}}};node.cmTile={root:{view}};
  const document={activeElement:node,get hidden(){return hidden;},visibilityState:'visible',hasFocus:()=>true,querySelector:()=>({querySelector:selector=>selector==='.cm-content'?node:{value:title}}),addEventListener:(event,callback)=>listeners.set(event,callback),removeEventListener:event=>listeners.delete(event)};
  const window={get __zoridPackagedProbe(){return{identity};}},context={window,document},config={identity:'case',path:'Note.md'};
  const run=action=>vm.runInNewContext(fixtureEditorSource(config,action),context);
  assert.equal(run('observe').body,body);assert.equal(listeners.size,2);
  const handled={target:node,key:'Backspace',code:'Backspace',isTrusted:true,defaultPrevented:false};listeners.get('keydown')(handled);handled.defaultPrevented=true;assert.equal(run().backspaces[0].defaultPrevented,true,'retain final preventDefault outcome');
  listeners.get('beforeinput')({target:node,inputType:'insertText',isTrusted:true});assert.equal(run().deletions.length,0);
  listeners.get('beforeinput')({target:node,inputType:'deleteContentBackward',isTrusted:true});assert.equal(run().deletions[0].trusted,true);
  for(const alter of [()=>{hidden=true;},()=>{title='Other';},()=>{identity='foreign';},()=>{editable='false';}]){
    hidden=false;title='Note';identity='case';editable='true';alter();assert.throws(()=>run(),/scope or focus changed/);
  }
  // Cleanup remains observational and possible after focus/scope changes.
  assert.equal(run('dispose'),true);assert.equal(listeners.size,0);assert.equal(window.__zoridFixtureDeletion,undefined);assert.equal(body,'xyHeading');assert.equal(head,2);
});


test('CodeMirror-handled trusted Backspace needs exact mutation, not a browser beforeinput event',async()=>{
  const f=fixture('xy'),receipt=await restoreAutosavedFixture(f);assert.equal(f.body,f.original);assert.equal(receipt.receipts.length,2);
  assert.ok(receipt.receipts.every(event=>event.defaultPrevented===true&&event.beforeInputObserved===false));
  const native=fixture('x',{beforeinput:true}),nativeReceipt=await restoreAutosavedFixture(native);assert.equal(nativeReceipt.receipts[0].beforeInputObserved,true);
});
test('synthetic or duplicate keydown, missing mutation and synthetic optional beforeinput remain failures',async()=>{
  for(const options of [{synthetic:true},{duplicate:true},{noChange:true},{beforeinput:true,untrustedBeforeinput:true}]){
    const f=fixture('x',options);await assert.rejects(restoreAutosavedFixture(f));assert.equal(f.keys.filter(key=>key==='Backspace').length,1);
  }
});
