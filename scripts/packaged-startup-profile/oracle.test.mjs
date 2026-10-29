import test from 'node:test';
import assert from 'node:assert/strict';
import {assessNote,clockInterval,fixtureText,planCampaign} from './oracle.mjs';
function receipt(){return {deadlineMs:800,packaged:true,packagedUrlVerified:true,identity:'owned-note',originMs:0,expectedCharacters:8192,
  clockSamples:[{timeOrigin:10000,remoteNow:100,before:119,after:121},{timeOrigin:10000,remoteNow:900,before:919,after:921}],
  observed:{identity:'owned-note',installedAt:10,initial:{length:8192,prefixMatches:true},ready:{at:200,visible:true,editable:true},
    probes:[{name:'ready',identity:'owned-note',trusted:true,accepted:true,appliedAt:210,caretAfterPaint:1,expectedCaretAfterPaint:1},
      {name:'deadline',identity:'owned-note',trusted:true,accepted:true,appliedAt:810,caretAfterPaint:2,expectedCaretAfterPaint:2}]},
  dispatches:[{name:'ready',status:'sent'},{name:'deadline',status:'sent',observation:{at:800,ready:{at:200}}}],
  body:{exact:true,sha256:'edited'},expectedEditedSha256:'edited',cleanup:{normal:true,gone:true},artifactsUnchanged:true};}
test('monotonic handshake is an interval independent of wall timeOrigin arithmetic',()=>{
  assert.deepEqual(clockInterval(210,receipt().clockSamples),{lower:229,upper:231});
  const samples=receipt().clockSamples;samples[1].timeOrigin=10001;assert.throws(()=>clockInterval(210,samples),/replaced/);
  assert.throws(()=>clockInterval(1,[{remoteNow:0,before:0,after:1}]),/clock/);
});
test('trusted exact packaged input by800ms establishes the target',()=>{const value=assessNote(receipt());assert.equal(value.valid,true);assert.equal(value.outcome,'target-met');assert.deepEqual(value.inputMs,{lower:229,upper:231});});
test('continuously observed not-ready deadline plus later trusted input proves a target miss',()=>{
  const r=receipt();r.observed.ready.at=1000;r.observed.probes=[{...r.observed.probes[0],appliedAt:1010}];r.dispatches[1]={name:'deadline',status:'observed-not-ready',observation:{at:800,ready:null}};
  assert.equal(assessNote(r).outcome,'target-missed');
});
test('late debugger attachment cannot manufacture a valid miss or a valid success',()=>{
  const r=receipt();r.observed.installedAt=900;r.observed.ready.at=1000;r.observed.probes=[{...r.observed.probes[0],appliedAt:1010}];r.dispatches[1].status='unobservable';
  assert.equal(assessNote(r).outcome,'indeterminate');assert.equal(assessNote(r).valid,false);
});
test('uncertainty straddling800ms and delayed automation remain indeterminate',()=>{
  const r=receipt();r.observed.ready.at=770;r.observed.probes[0].appliedAt=780;
  assert.equal(assessNote(r).outcome,'indeterminate');
  r.observed.probes[0].appliedAt=1000;assert.equal(assessNote(r).outcome,'indeterminate');
});
test('synthetic/wrong-editor input, truncation, altered assets and forced cleanup cannot pass',()=>{
  for(const mutate of [r=>r.observed.probes[0].trusted=false,r=>r.observed.probes[0].accepted=false,r=>r.observed.identity='other',
    r=>r.observed.initial.length=10,r=>r.body.exact=false,r=>r.body.sha256='wrong',r=>r.cleanup.normal=false,
    r=>r.cleanup.gone=false,r=>r.artifactsUnchanged=false,r=>r.packaged=false]){
    const r=receipt();mutate(r);assert.equal(assessNote(r).outcome,'invalid-receipt');
  }
});
test('fixed probe retries or missing fixed attempts invalidate the receipt',()=>{
  const r=receipt();r.dispatches.push({...r.dispatches[1]});assert.equal(assessNote(r).valid,false);
  r.dispatches=[];assert.equal(assessNote(r).valid,false);
});
test('fixture bytes and paired first-import/reopen order stay exact and deterministic',()=>{
  for(const size of [8192,432000])assert.equal(Buffer.byteLength(fixtureText(size)),size);
  const cases=planCampaign(3,42);assert.deepEqual(cases,planCampaign(3,42));assert.equal(cases.length,12);
  for(let i=0;i<cases.length;i+=2){assert.equal(cases[i].mode,'first-import');assert.equal(cases[i+1].mode,'reopen');assert.equal(cases[i].pairId,cases[i+1].pairId);}
});
