import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {probeViewportSource} from './passive-observer.mjs';
function fixture(markers=''){
  const original='Fixture heading\nsecond line';let body=markers+original,head=markers.length,now=10;
  const ready={at:1,visible:true,editable:true},probe={identity:'case',ready,probes:[...markers].map(marker=>({marker,accepted:true,trusted:true}))},frames=[],listeners=new Map();
  const view={state:{doc:{get length(){return body.length;},sliceString:(a,b)=>body.slice(a,b),toString:()=>assert.fail('No whole-document copy')},selection:{main:{get head(){return head;}}}}};
  const bounds=()=>({width:100,height:100,top:0,bottom:100}),node={cmTile:{root:{view}},getBoundingClientRect:bounds,getAttribute:()=> 'true',closest:()=>null};view.contentDOM=node;
  const line={textContent:markers+'Fixture heading',getBoundingClientRect:bounds},pane={querySelector:selector=>selector==='.cm-content'?node:{value:'Note'},querySelectorAll:()=>[line]};
  const document={hidden:false,visibilityState:'visible',querySelector:()=>pane,addEventListener:(key,fn)=>listeners.set(key,fn),removeEventListener:key=>listeners.delete(key)};
  const config={identity:'case',path:'Note.md',characters:original.length,prefix:original.slice(0,160),visibleText:'Fixture heading'};
  return {probe,ready,document,frames,run:()=>vm.runInNewContext(probeViewportSource(config),{window:{__zoridPackagedProbe:probe},document,innerHeight:800,performance:{now:()=>now++},requestAnimationFrame:fn=>frames.push(fn)}),flush(){while(frames.length)frames.shift()();},changeSource:()=>body='wrong'+body,changeCaret:()=>head++};
}
test('fresh two-frame proof preserves historical firstReady and accounts for accepted markers without copying the whole document',async()=>{
  for(const markers of ['', 'x', 'xy']){const f=fixture(markers),promise=f.run();assert.equal(f.frames.length,1);f.flush();const proof=await promise;assert.equal(proof.acceptedMarkers,markers);assert.ok(proof.at>f.ready.at);assert.equal(f.probe.ready,f.ready);assert.equal(f.probe.ready.at,1);}
});
test('fresh guard rejects changed source/caret and hidden documents before any input',async()=>{
  for(const change of [f=>f.changeSource(),f=>f.changeCaret(),f=>{f.document.hidden=true;f.document.visibilityState='hidden';}]){const f=fixture('x');change(f);await assert.rejects(f.run());assert.equal(f.frames.length,0);assert.equal(f.probe.probes.length,1);}
});
test('source changed after the first frame cannot use an earlier ready latch',async()=>{
  const f=fixture(),promise=f.run();f.frames.shift()();f.changeSource();f.flush();await assert.rejects(promise,/source changed/);assert.equal(f.probe.ready.at,1);
});
