import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {navigateFileTree} from './file-navigation.mjs';
function treeFixture({count=100,virtual=true,late=false}={}){
  const names=Array.from({length:count},(_,index)=>`Note ${String(index).padStart(4,'0')}.md`);if(!late)names.push('Profile.base');
  let top=0,time=0,pauses=0,selected=null;const calls=[];
  const scroll={get scrollTop(){return top;},get clientHeight(){return 280;},get scrollHeight(){return names.length*28;},getBoundingClientRect:()=>({left:0,top:0,width:240,height:280,bottom:280})};
  const clamp=value=>Math.max(0,Math.min(value,scroll.scrollHeight-scroll.clientHeight));
  const rows=()=>names.map((path,index)=>({dataset:{path},scrollIntoView(){top=clamp(index*28-126);},getBoundingClientRect(){return{left:0,top:index*28-top,bottom:(index+1)*28-top,width:240,height:28};}})).slice(virtual?Math.floor(top/28):0,virtual?Math.floor(top/28)+25:undefined);
  const tree={closest:()=>scroll,querySelectorAll:()=>rows()},context=vm.createContext({document:{querySelector:()=>tree}});
  const renderer={async evaluate(source){if(source.includes('requestAnimationFrame')){time+=32;return;}return vm.runInContext(source,context);},async call(method,input){assert.equal(method,'Input.dispatchMouseEvent');calls.push(input);time+=1;if(input.type==='mouseWheel')top=clamp(top+input.deltaY);else if(input.type==='mouseReleased')selected=names[Math.floor((top+input.y)/28)];}};
  return {renderer,calls,now:()=>time,pause:async ms=>{time+=ms;if(late&&++pauses===2)names.push('Profile.base');},get selected(){return selected;}};
}
test('normal filetree scrolling mounts an absent target before the one trusted row click',async()=>{
  const f=treeFixture(),receipt=await navigateFileTree(f.renderer,'Profile.base',{now:f.now,timeoutMs:3000,pause:f.pause});
  assert.equal(f.selected,'Profile.base');assert.ok(receipt.scrollSteps>0);
  assert.equal(f.calls.filter(call=>call.type==='mousePressed').length,1);
  assert.ok(receipt.clickedAtMs>receipt.startedAtMs,'navigation cost stays in the original clock');
});
test('late namespace rows are waited for rather than treated as a virtualization fact or opened through a backend',async()=>{
  const f=treeFixture({count:10,late:true}),receipt=await navigateFileTree(f.renderer,'Profile.base',{now:f.now,timeoutMs:3000,pause:f.pause});
  assert.equal(f.selected,'Profile.base');assert.ok(receipt.rowUnavailableWaitMs>0);assert.ok(receipt.totalMs>=receipt.rowUnavailableWaitMs);
});
test('nonvirtualized offscreen rows use normal scrollIntoView and the same row click',async()=>{
  const f=treeFixture({virtual:false});await navigateFileTree(f.renderer,'Profile.base',{now:f.now,timeoutMs:3000,pause:f.pause});
  assert.equal(f.selected,'Profile.base');assert.equal(f.calls.filter(call=>call.type==='mouseWheel').length,0);
});
test('a missing file times out without a click or a direct-open fallback',async()=>{
  const f=treeFixture({count:10}),receipt={};await assert.rejects(navigateFileTree(f.renderer,'Missing.md',{now:f.now,timeoutMs:100,pause:f.pause,receipt}));
  assert.equal(f.calls.filter(call=>call.type==='mousePressed').length,0);assert.ok(receipt.rowUnavailableWaitMs>0);
});

test('a foreground interference guard aborts navigation before a row click',async()=>{
  const f=treeFixture(),error=Object.assign(Error('visibility lost'),{code:'PACKAGED_MEASUREMENT_INTERFERENCE'});
  await assert.rejects(navigateFileTree(f.renderer,'Profile.base',{now:f.now,pause:f.pause,guard:async()=>{throw error;}}),value=>value===error);assert.equal(f.calls.length,0);assert.equal(f.selected,null);
});
