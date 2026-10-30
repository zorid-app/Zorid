import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {retainedConfigurationReviewFrame,assertRetainedConfigurationReview,reviewRetainedConfiguration} from './campaign.mjs';

const scope='[aria-label="Edit summary"]',expected={saved:'Original saved source 😀\n',accepted:'Exact accepted A\n',current:'Summary name: Total\nSummary expression: newer raw B +'};
function fixture(){
  const dom=new JSDOM('<section aria-label="Edit summary"><div class="bases-configuration-review"><textarea aria-label="Original saved configuration" readonly></textarea><textarea aria-label="Accepted configuration" readonly></textarea><textarea aria-label="Current retained input" readonly></textarea><button>Copy accepted configuration</button><div role="status"></div></div></section>');
  dom.window.HTMLElement.prototype.getClientRects=()=>[{width:100,height:20}];
  const doc=dom.window.document;
  for(const [label,value]of [['Original saved configuration',expected.saved],['Accepted configuration',expected.accepted],['Current retained input',expected.current]])doc.querySelector(`[aria-label="${label}"]`).value=value;
  return{dom,doc,frame:()=>retainedConfigurationReviewFrame(doc,scope)};
}

test('read-only native review oracle preserves exact saved, accepted and newer raw strings',()=>{
  const f=fixture();try{const before=f.doc.body.innerHTML;assertRetainedConfigurationReview(f.frame(),expected);assert.equal(f.doc.body.innerHTML,before,'The observer performs no DOM or source mutation');}finally{f.dom.window.close();}
});

test('native review oracle rejects writable fields, changed sources and remaining manual retry controls',()=>{
  for(const label of ['Original saved configuration','Accepted configuration','Current retained input']){
    const f=fixture();try{const field=f.doc.querySelector(`[aria-label="${label}"]`);field.readOnly=false;assert.throws(()=>assertRetainedConfigurationReview(f.frame(),expected));field.readOnly=true;field.value+='unexpected';assert.throws(()=>assertRetainedConfigurationReview(f.frame(),expected));}finally{f.dom.window.close();}
  }
  const f=fixture();try{const retry=f.doc.createElement('button');retry.textContent='Retry save';f.doc.querySelector(scope).append(retry);assert.throws(()=>assertRetainedConfigurationReview(f.frame(),expected));retry.hidden=true;assertRetainedConfigurationReview(f.frame(),expected);}finally{f.dom.window.close();}
});

test('native review oracle rejects duplicate targets and disabled or inert copy actions',()=>{
  for(const alter of [doc=>doc.body.append(doc.querySelector(scope).cloneNode(true)),doc=>doc.querySelector('.bases-configuration-review').append(doc.querySelector('[aria-label="Accepted configuration"]').cloneNode(true)),doc=>{doc.querySelector('button').disabled=true;},doc=>doc.querySelector('.bases-configuration-review').setAttribute('inert','')]){
    const f=fixture();try{alter(f.doc);assert.throws(()=>assertRetainedConfigurationReview(f.frame(),expected));}finally{f.dom.window.close();}
  }
});

for(const unintended of [undefined,{kind:'native-write-request',method:'checkpoint_cas',key:'note/v1/entry'},{kind:'native-prepared-write',operationId:'unexpected'},{kind:'native-mutation-response',method:'commit_intent',ok:false,errorCode:'checkpoint_storage'},{kind:'native-checkpoint-response',ok:false,errorCode:'checkpoint_storage'}])test(`Review/Copy workflow ${unintended?'rejects '+unintended.kind:'requires both normal actions without an observed write'}`,async()=>{
  const f=fixture(),actions=[],events=[{kind:'native-write-request',method:'prepare_intent',operationId:'original-accepted'}],checks=[];
  const c={relay:{events:async()=>structuredClone(events)},evidence:{checks},ui:{button:async label=>{actions.push(label);if(unintended&&label==='Copy accepted configuration')events.push(unintended);},wait:async(_body,label)=>label.startsWith('Read-only')?f.frame():true}};
  try{if(unintended)await assert.rejects(reviewRetainedConfiguration(c,scope,expected),/no native mutation\/checkpoint request/);else{await reviewRetainedConfiguration(c,scope,expected);assert.equal(checks.length,1);assert.equal(checks[0].sourceMutationDispatches,0);assert.equal(checks[0].observedNativeWriteResponses,0);}assert.deepEqual(actions,['Review retained changes','Copy accepted configuration']);assert.deepEqual(checks.flatMap(check=>check.frame?.accepted?.text??[]),unintended?[]:[expected.accepted]);}finally{f.dom.window.close();}
});
