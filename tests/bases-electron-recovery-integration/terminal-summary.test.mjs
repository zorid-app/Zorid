import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {retainedSummaryFrame,assertEditableRetainedSummary,retainEditableSummaryWithoutMutation} from './campaign.mjs';

const scope='[aria-label="Edit summary"]',expected={draft:'values.sum() + 7',file:'Failures/Live.base',source:'Exact original source 😀\n'};
function fixture(){
  const dom=new JSDOM('<section aria-label="Edit summary" aria-busy="false"><input aria-label="Summary name" value="Total"><textarea aria-label="Summary expression"></textarea><div class="cm-content" role="textbox" aria-label="Summary expression" contenteditable="true" aria-readonly="false"></div><div role="alert">Original save failed.</div><button>Cancel changes</button></section>');
  dom.window.HTMLElement.prototype.getClientRects=()=>[{width:100,height:20}];
  const doc=dom.window.document;doc.querySelector('textarea').value=expected.draft;doc.querySelector('.cm-content').textContent=expected.draft;
  return{dom,doc,frame:()=>retainedSummaryFrame(doc,scope)};
}

test('terminal summary oracle passively preserves editable exact raw B and honest error',()=>{
  const f=fixture();try{const before=f.doc.body.innerHTML;assertEditableRetainedSummary(f.frame(),expected);assert.equal(f.doc.body.innerHTML,before);}finally{f.dom.window.close();}
});

test('terminal summary oracle rejects replaced targets, frozen fields, altered B and hidden errors',()=>{
  for(const alter of [
    doc=>doc.body.append(doc.querySelector(scope).cloneNode(true)),
    doc=>doc.querySelector(scope).append(doc.querySelector('textarea').cloneNode(true)),
    doc=>{doc.querySelector('input').disabled=true;},
    doc=>{doc.querySelector('textarea').readOnly=true;},
    doc=>doc.querySelector('.cm-content').setAttribute('aria-readonly','true'),
    doc=>doc.querySelector('.cm-content').setAttribute('contenteditable','false'),
    doc=>doc.querySelector(scope).setAttribute('inert',''),
    doc=>{doc.querySelector('textarea').value+='wrong';},
    doc=>{doc.querySelector('.cm-content').textContent+='wrong';},
    doc=>{doc.querySelector('[role="alert"]').textContent='';},
    doc=>{doc.querySelector('[role="alert"]').hidden=true;},
    doc=>{doc.querySelector('[role="alert"]').style.display='none';},
  ]){const f=fixture();try{alter(f.doc);assert.throws(()=>assertEditableRetainedSummary(f.frame(),expected));}finally{f.dom.window.close();}}
});

test('terminal summary oracle requires removal of custom Review/Copy/Retry even when hidden',()=>{
  for(const label of ['Review retained changes','Copy draft','Copy accepted configuration','Copy original configuration','Copy retained input','Retry save']){
    const f=fixture();try{const button=f.doc.createElement('button');button.textContent=label;button.hidden=true;f.doc.querySelector(scope).append(button);assert.throws(()=>assertEditableRetainedSummary(f.frame(),expected));}finally{f.dom.window.close();}
  }
  const f=fixture();try{const review=f.doc.createElement('div');review.className='bases-configuration-review';f.doc.querySelector(scope).append(review);assert.throws(()=>assertEditableRetainedSummary(f.frame(),expected));}finally{f.dom.window.close();}
});

for(const unintended of [undefined,{kind:'native-write-request',method:'checkpoint_cas',key:'note/v1/entry'},{kind:'native-prepared-write',operationId:'unexpected'},{kind:'native-mutation-response',method:'commit_intent',ok:false,errorCode:'filesystem_failed'},{kind:'native-checkpoint-response',ok:false,errorCode:'filesystem_failed'}])test(`terminal retained summary ${unintended?'rejects automatic '+unintended.kind:'needs no recovery action or automatic mutation'}`,async()=>{
  const f=fixture(),events=[{kind:'native-write-request',method:'prepare_intent',operationId:'original-accepted'}],checks=[],actions=[];
  const c={relay:{events:async()=>structuredClone(events)},evidence:{checks},ui:{wait:async()=>f.frame(),button:async label=>actions.push(label)},saved:async(file,check)=>{assert.equal(file,expected.file);check(expected.source);if(unintended)events.push(unintended);}};
  try{if(unintended)await assert.rejects(retainEditableSummaryWithoutMutation(c,scope,expected),/cannot automatically dispatch/);else{await retainEditableSummaryWithoutMutation(c,scope,expected);assert.equal(checks.length,1);assert.equal(checks[0].sourceMutationDispatches,0);}assert.deepEqual(actions,[]);}finally{f.dom.window.close();}
});
