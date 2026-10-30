import test from 'node:test';
import assert from 'node:assert/strict';
import {configurePassiveObserver} from './passive-observer.mjs';
const config={identity:'fixture-observer',path:'Note.md',characters:12,prefix:'Fixture',visibleText:'Fixture',markers:{ready:'x',deadline:'y'}};
const replaced=()=>Error('{"code":-32000,"message":"Execution context was destroyed."}');
function fixture(clock){let now=0,registrations=0,evaluations=0;const renderer={call:async(method,args)=>{assert.equal(method,'Page.addScriptToEvaluateOnNewDocument');assert.ok(args.source.includes('fixture-observer'));registrations++;return {identifier:'one-script'};},evaluate:async source=>{assert.ok(source.includes('fixture-observer'));evaluations++;return {identity:config.identity,timeOrigin:evaluations===1?1000:2000};}};return {options:{renderer,config,newDocument:true,now:()=>now,timeoutMs:50,pause:async ms=>now+=ms,sampleClock:()=>clock(evaluations)},registrations:()=>registrations,evaluations:()=>evaluations};}
test('ordinary context destruction between observer install and clock retries only the passive current document',async()=>{
  const f=fixture(attempt=>{if(attempt===1)throw replaced();return {timeOrigin:2000,remoteNow:10,before:11,after:12};});
  const result=await configurePassiveObserver(f.options);assert.equal(f.registrations(),1);assert.equal(f.evaluations(),2);assert.equal(result.sample.timeOrigin,2000);assert.equal(result.setup.attempts.length,2);assert.ok(result.setup.attempts[0].error);assert.equal(result.script.identifier,'one-script');
});
test('a clock from a replaced document is discarded rather than paired with the wrong observer origin',async()=>{
  const f=fixture(()=>({timeOrigin:2000,remoteNow:10,before:11,after:12})),result=await configurePassiveObserver(f.options);
  assert.equal(f.evaluations(),2);assert.equal(result.setup.discardedClockSamples.length,1);assert.equal(result.setup.discardedClockSamples[0].timeOrigin,2000);
});
test('arbitrary source/protocol/interference failure is never retried as navigation',async()=>{
  for(const error of [Error('source differs'),Error('{"code":-32000,"message":"Invalid protocol"}'),Object.assign(Error('hidden'),{code:'PACKAGED_MEASUREMENT_INTERFERENCE'})]){
    const f=fixture(()=>{throw error;});await assert.rejects(configurePassiveObserver(f.options),value=>value===error);assert.equal(f.evaluations(),1);assert.equal(f.registrations(),1);
  }
});
test('passive context retries exhaust the original budget without registering again or sending input',async()=>{
  const f=fixture(()=>{throw replaced();});f.options.timeoutMs=15;await assert.rejects(configurePassiveObserver(f.options));assert.equal(f.registrations(),1);assert.ok(f.evaluations()<=2);
});
