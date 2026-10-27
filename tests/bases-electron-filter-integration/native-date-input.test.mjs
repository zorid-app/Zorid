import test from 'node:test';
import assert from 'node:assert/strict';
import {enterNativeDate,nativeSegments,nativeLiteralParts} from './native-date-input.mjs';

const labels={year:'Year',month:'Month',day:'Day',hour:'Hour',minute:'Minute',second:'Second',period:'AM/PM'};
function fixture({order=['month','day','year'],focused=0,auto=true,type='date',value='2026-10-22',expected={month:'10',day:'22',year:'2026'},wrongValue,blurValue,stayFocused=false,skip=false,replace=false}={}){
 const calls=[],keys=[],buffer=Object.fromEntries(order.map(kind=>[kind,''])),actions=[],checks=[];let index=focused,blurred=false,characters=0,clicks=0;
 const complete=()=>order.every(kind=>buffer[kind]===expected[kind]);
 const current=()=>({type,value:complete()?(blurred&&blurValue?blurValue:wrongValue??value):'',valid:characters===0||complete(),focused:!blurred,step:'',min:'',max:''});
 const nodes=()=>[{nodeId:'native',backendDOMNodeId:replace&&characters?18:17,role:{value:'Date'},childIds:order.map(kind=>kind)},...order.map((kind,i)=>({nodeId:kind,role:{value:'spinbutton'},name:{value:labels[kind]},properties:[{name:'focused',value:{value:!blurred&&index===i}}]}))];
 const c={evidence:{actions,checks},ui:{
  async wait(body){assert.doesNotMatch(body,/(?:\.value\s*=|\.focus\s*\(|dispatchEvent|zorid|workspace)/);return current();},
  async click(){clicks++;},
  async key(key){keys.push(key);if(key==='ArrowLeft')index--;else if(key==='Tab'){if(index<order.length-1)index++;else if(!stayFocused)blurred=true;}else throw Error('Unexpected navigation '+key);}
 },cdp:{async call(method,input){calls.push({method,input});
  if(method==='DOM.getDocument')return{root:{nodeId:1}};
  if(method==='DOM.querySelector')return{nodeId:2};
  if(method==='DOM.describeNode')return{node:{backendNodeId:replace&&characters?18:17}};
  if(method==='Accessibility.getFullAXTree')return{nodes:nodes()};
  assert.equal(method,'Input.dispatchKeyEvent','Only public AX/DOM reads and actual keyboard events are allowed');
  if(input.type==='char'){characters++;const kind=order[index];buffer[kind]+=input.text;if(auto&&buffer[kind].length===expected[kind].length&&index<order.length-1)index+=skip?2:1;}
  return{};
 }}};
 return{c,calls,keys,buffer,actions,checks,clicks:()=>clicks};
}

test('observed date orders and nonfirst click focus drive trusted segment keys, without whole-value insertion',async()=>{
 for(const [order,focused,auto]of [[['month','day','year'],0,true],[['day','month','year'],2,false],[['year','month','day'],1,true]]){
  const f=fixture({order,focused,auto});await enterNativeDate(f.c,'input[aria-label="Filter value"]','2026-10-22');
  assert.deepEqual(f.buffer,{month:'10',day:'22',year:'2026'});assert.equal(f.clicks(),1);assert.equal(f.checks[0].entered.value,'2026-10-22');assert.equal(f.checks[0].blurred.focused,false);
  const input=f.calls.filter(call=>call.method==='Input.dispatchKeyEvent');assert.equal(input.length,24);
  for(let index=0;index<input.length;index+=3){assert.deepEqual(input.slice(index,index+3).map(call=>call.input.type),['rawKeyDown','char','keyUp']);assert.equal(input[index+1].input.text,input[index].input.key);assert.equal(input[index+1].input.unmodifiedText,input[index].input.key);}
  assert.ok(f.actions.some(action=>action.action==='native-filter-date-AX'&&action.record.admission.step===''));
 }
});

test('actual 12-hour period and 24-hour native segments receive the independently expected digits',async()=>{
 for(const options of [
  {type:'datetime-local',order:['month','day','year','hour','minute','period'],value:'2026-10-22T00:30',expected:{month:'10',day:'22',year:'2026',hour:'12',minute:'30',period:'a'}},
  {type:'datetime-local',order:['day','month','year','hour','minute'],value:'2026-10-22T12:30',expected:{month:'10',day:'22',year:'2026',hour:'12',minute:'30'},auto:false},
 ]){const f=fixture(options);await enterNativeDate(f.c,'#native',options.value);assert.deepEqual(f.buffer,options.expected);assert.equal(f.checks[0].blurred.value,options.value);}
});

test('ambiguous, incomplete or unknown AX segments fail instead of guessing a locale order',()=>{
 const record={admission:{type:'date'},nodes:[{role:{value:'spinbutton'},name:{value:'Month'},properties:[{name:'focused',value:{value:true}}]},{role:{value:'spinbutton'},name:{value:'Day'}},{role:{value:'spinbutton'},name:{value:'Year'}}]};
 assert.deepEqual(nativeSegments(record).map(segment=>segment.kind),['month','day','year']);
 for(const change of [r=>r.nodes.pop(),r=>r.nodes[2].name.value='Month',r=>r.nodes[2].name.value='Unrecognized',r=>r.nodes[0].properties=[],r=>r.nodes[1].properties=[{name:'focused',value:{value:true}}]]){const next=structuredClone(record);change(next);assert.throws(()=>nativeSegments(next));}
});

test('unsupported seconds, timezone and malformed literal shapes fail before any native input',async()=>{
 for(const value of ['2026-10-22T12:30:01','2026-10-22T12:30Z','2026-10-22T12:30+05:30','22/10/2026','2026-13-22','2026-10-22T24:30']){assert.throws(()=>nativeLiteralParts(value));const f=fixture();await assert.rejects(enterNativeDate(f.c,'#native',value));assert.equal(f.calls.length,0);assert.equal(f.clicks(),0);}
});

test('unexpected segment advancement or operand replacement fails immediately without input retry',async()=>{
 for(const options of [{skip:true},{replace:true}]){const f=fixture(options);await assert.rejects(enterNativeDate(f.c,'#native','2026-10-22'));assert.equal(f.calls.filter(call=>call.method==='Input.dispatchKeyEvent'&&call.input.type==='char').length,2,'Only the initial Month was typed once');}
});

test('wrong complete value, missing actual blur and post-blur value loss remain strict failures',async()=>{
 for(const options of [{wrongValue:'2026-10-23'},{stayFocused:true},{blurValue:'2026-10-23'}]){const f=fixture(options);await assert.rejects(enterNativeDate(f.c,'#native','2026-10-22'));assert.deepEqual(f.buffer,{month:'10',day:'22',year:'2026'});assert.deepEqual(f.checks,[]);}
});
