'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');

const generic = 'Durable editor request failed; retain pending recovery state.';
const changed = 'The file changed or was replaced. Your draft was kept; refresh before saving.';
const request = {entryId:'private-entry',revision:'private-revision',path:'private/Replace.md'};
function preload(invoke) {
  let bridge;
  vm.runInNewContext(fs.readFileSync(require.resolve('../desktop/preload.cjs'),'utf8'),{
    require(name) {
      assert.equal(name,'electron');
      return {contextBridge:{exposeInMainWorld(_name,value){bridge=value;}},ipcRenderer:{invoke},webUtils:{}};
    },
  });
  // Electron's bridge copies an Error's message, not its custom code/uncertainty
  // fields. Exercise the actual preload source before modelling that boundary.
  return async (...args) => {
    try { return await bridge.durableInvoke('/private-vault','private-admission',...args); }
    catch(error) { throw new Error(error.message); }
  };
}

test('a definitive saved-source change remains actionable across a message-only bridge',async()=>{
  for(const method of ['captureSavedSource','releaseSavedSource']) {
    const calls=[];
    const invoke=preload(async(...args)=>{calls.push(args);return {ok:false,error:{code:'conditional_source_changed',commitUncertain:false}};});
    await assert.rejects(invoke(method,[method==='captureSavedSource'?request:'private-capture']),error=>{
      assert.equal(error.message,changed);
      for(const privateValue of ['private-vault','private-admission','private-entry','private-revision','private/Replace.md','private-capture'])assert.ok(!error.message.includes(privateValue));
      assert.deepEqual(Object.keys(error),[],'No custom error fields are assumed to survive contextBridge');
      return true;
    });
    assert.equal(calls.length,1,'Presentation must not retry or recapture');
    assert.equal(calls[0][0],'zorid:durableInvoke');
    assert.equal(calls[0][3],method);
  }
});

test('unknown, malformed and uncertain saved-source failures keep the conservative message',async()=>{
  const failures=[
    {code:'conditional_source_changed',commitUncertain:true},
    {code:'conditional_source_changed'},
    {code:'conditional_source_changed',commitUncertain:'false'},
    {code:'conditional_source_changed',commitUncertain:0},
    {code:'conditional_source_changed ',commitUncertain:false},
    {code:'source_capture_limit',commitUncertain:false},
    {code:'filesystem_io',commitUncertain:true},
    {code:'conditional_source_changed',commitUncertain:false,details:{path:'private/Replace.md'}},
    null,
    Object.assign([],{code:'conditional_source_changed',commitUncertain:false}),
  ];
  for(const error of failures) {
    const invoke=preload(async()=>({ok:false,error}));
    await assert.rejects(invoke('captureSavedSource',[request]),{message:generic});
  }
});

test('the changed-source message is restricted to the two guarded-source methods',async()=>{
  const invoke=preload(async()=>({ok:false,error:{code:'conditional_source_changed',commitUncertain:false}}));
  for(const method of ['checkpointLoad','createText','open'])await assert.rejects(invoke(method,[request]),{message:generic});
});

test('missing or malformed reply envelopes never imply a definitive source change',async()=>{
  for(const reply of [undefined,null,{}, {ok:false}, {error:{code:'conditional_source_changed',commitUncertain:false}}]) {
    const invoke=preload(async()=>reply);
    await assert.rejects(invoke('captureSavedSource',[request]),{message:generic});
  }
});

test('successful source capture and release preserve their actual results without extra calls',async()=>{
  const capture={captureId:'capture',logicalWitness:request,source:'original saved source'};
  let calls=0;
  const invoke=preload(async(_channel,_vault,_admission,method)=>{calls++;return {ok:true,result:method==='captureSavedSource'?capture:undefined};});
  assert.equal(await invoke('captureSavedSource',[request]),capture);
  assert.equal(await invoke('releaseSavedSource',['capture']),undefined);
  assert.equal(calls,2);
});

test('transport rejection never becomes a definitive changed-source diagnosis',async()=>{
  let calls=0;
  const invoke=preload(async()=>{calls++;throw new Error('Transport unavailable');});
  for(const method of ['captureSavedSource','releaseSavedSource'])await assert.rejects(invoke(method,[request]),{message:'Transport unavailable'});
  assert.equal(calls,2);
});

test('the real property widget retains its exact draft and presents the bridged guard message',async()=>{
  const {JSDOM}=require('jsdom');
  const {mountBasePropertyWidget}=await import('../src/bases/property-widgets.ts');
  const dom=new JSDOM('<main tabindex="0"></main>',{pretendToBeVisual:true});
  const element=dom.window.document.querySelector('main');
  const value={type:'number',value:3},errors=[],edits=[];
  const invoke=preload(async()=>({ok:false,error:{code:'conditional_source_changed',commitUncertain:false}}));
  let authored=0;
  const dispose=mountBasePropertyWidget(element,{row:{path:'Replace.md',values:{'note.score':value}},property:'note.score',value,version:1},{
    getDefinition:()=>({type:'number'}),
    async commit(edit){edits.push(edit);await invoke('captureSavedSource',[request]);authored++;},
    onError:error=>errors.push(error),
  });
  try {
    element.dispatchEvent(new dom.window.MouseEvent('dblclick',{bubbles:true}));
    const input=element.querySelector('input');assert.ok(input);
    input.value='8';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    const deadline=Date.now()+1000;
    while(!errors.length&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(errors.length,1);assert.equal(errors[0].message,changed);
    assert.equal(element.title,changed);assert.equal(element.dataset.baseEditing,'draft');
    assert.equal(element.querySelector('input'),input,'Failure keeps the existing editor rather than replacing it');
    assert.equal(input.value,'8');assert.equal(input.disabled,false);assert.equal(input.getAttribute('aria-invalid'),'true');
    assert.equal(edits.length,1);assert.deepEqual(edits[0].value,{type:'number',value:8});
    assert.equal(authored,0,'A rejected physical-source capture never authorizes new save work');
    assert.equal(value.value,3,'The original presentation remains the saved value');
  } finally {dispose();dom.window.close();}
});
