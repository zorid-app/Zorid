import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {boundedMeasurement,isMeasurementInterference,requireForeground,visibleFramesSource} from './measurement.mjs';
const window={visible:true,minimized:false,focused:true},document={visibilityState:'visible',hidden:false,hasFocus:true};
test('asynchronous native focus confirmation waits passively within the original budget',async()=>{
  let now=25,focused=false,requests=0;const origin=0;
  const result=await boundedMeasurement(()=>{requests++;assert.ok(focused);return 'focused';},{timeoutMs:100-now,now:()=>now,pause:async ms=>{now+=ms;if(now>=45)focused=true;}});
  assert.equal(result,'focused');assert.equal(requests,3);assert.equal(origin,0);assert.equal(now,45);
});
test('visibility interference is fatal rather than retried until the readiness timeout and never changes source',async()=>{
  const source='# Exact source';let now=0,attempts=0;
  await assert.rejects(boundedMeasurement(()=>{attempts++;return source;},{timeoutMs:45000,now:()=>now,pause:async ms=>{now+=ms;},guard:()=>requireForeground(window,{visibilityState:'hidden',hidden:true})}),isMeasurementInterference);
  assert.equal(attempts,0);assert.equal(now,0);assert.equal(source,'# Exact source');
  for(const value of [{...window,focused:false},{...window,visible:false},{...window,minimized:true}])assert.throws(()=>requireForeground(value,document),isMeasurementInterference);
});
test('loading assertions still retry but a typed interference from inside the action stops immediately',async()=>{
  let now=0,attempts=0;await assert.rejects(boundedMeasurement(()=>{if(++attempts===1)throw Error('loading');requireForeground({...window,focused:false},document);},{timeoutMs:45000,now:()=>now,pause:async ms=>{now+=ms;}}),isMeasurementInterference);
  assert.equal(attempts,2);assert.equal(now,10);
});
test('two-frame waits reject visibility loss and remove the listener without waiting for hidden RAF',async()=>{
  const frames=[],listeners=new Map(),doc={hidden:false,visibilityState:'visible',addEventListener:(key,fn)=>listeners.set(key,fn),removeEventListener:key=>listeners.delete(key)};
  const promise=vm.runInNewContext(visibleFramesSource,{document:doc,requestAnimationFrame:fn=>frames.push(fn)});
  doc.hidden=true;doc.visibilityState='hidden';listeners.get('visibilitychange')();await assert.rejects(promise,isMeasurementInterference);assert.equal(listeners.size,0);assert.equal(frames.length,1);
});
test('a visible two-frame wait completes normally and removes its passive listener',async()=>{
  const frames=[],listeners=new Map(),doc={hidden:false,visibilityState:'visible',addEventListener:(key,fn)=>listeners.set(key,fn),removeEventListener:key=>listeners.delete(key)};
  const promise=vm.runInNewContext(visibleFramesSource,{document:doc,requestAnimationFrame:fn=>frames.push(fn)});frames.shift()();assert.equal(frames.length,1);frames.shift()();await promise;assert.equal(listeners.size,0);
});
