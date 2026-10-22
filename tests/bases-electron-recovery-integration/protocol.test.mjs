import test from 'node:test';
import assert from 'node:assert/strict';
import {Frames,Selection,digest,MAX_HEADER,validateArm,waitForRelease} from './protocol.mjs';

function encoded(header,body=Buffer.alloc(0)) {const json=Buffer.from(JSON.stringify(header)),prefix=Buffer.alloc(8);prefix.writeUInt32BE(json.length);prefix.writeUInt32BE(body.length,4);return Buffer.concat([prefix,json,body]);}
const frame=(header,body)=>new Frames().push(encoded(header,body))[0];
const request=(id,command,body)=>frame({version:1,request_id:id,command},body);
const response=(id,result,more={})=>frame({version:1,request_id:id,ok:true,result,...more});
const arm=(mode='drop')=>({mode,token:'a'.repeat(32),path:'Created/Untitled.md',entryId:'entry',bodySha256:digest(Buffer.from('literal 😀\r\n'))});
const create={method:'file_command',client_id:'client',family:{version:1,request:{operation_id:'operation',mutation:{type:'create',id:'entry',path:'Created/Untitled.md',kind:'file'}},create_mode:'text'}};
const receipt={operation_id:'operation',sequence:'7',changes:[{before:null,after:{id:'entry',path:'Created/Untitled.md',kind:'file',revision:'revision',deleted:false}}]};

test('framing preserves every original byte across arbitrary split/coalesced binary frames',()=>{
 const originals=[encoded({version:1,request_id:'0',ok:true,result:{transport:'native'}}),encoded({version:1,request_id:'1',command:{method:'read_path',path:'A 😀.md'}},Buffer.from([0,255,128,13,10]))];
 const all=Buffer.concat(originals);
 for(const length of [1,2,7,8,9,17,all.length]){const decoder=new Frames(),actual=[];for(let i=0;i<all.length;i+=length)actual.push(...decoder.push(all.subarray(i,i+length)).map(value=>value.raw));decoder.end();assert.deepEqual(actual,originals);}
});
test('framing fails closed on oversized, malformed or truncated native frames',()=>{
 const prefix=Buffer.alloc(8);prefix.writeUInt32BE(MAX_HEADER+1);assert.throws(()=>new Frames().push(prefix),/Bounded native frame/);
 const decoder=new Frames();decoder.push(encoded({x:1}).subarray(0,10));assert.throws(()=>decoder.end(),/Truncated/);
 const malformed=Buffer.from([0,0,0,1,0,0,0,0,255]);assert.throws(()=>new Frames().push(malformed));
});
test('drop gate only selects exact path/body and a genuine successful original create receipt once',()=>{
 const bytes=Buffer.from('literal 😀\r\n');
 for(const replacement of [{...arm(),path:'Other.md'},{...arm(),bodySha256:digest(Buffer.from('other'))}]){const observer=new Selection();observer.request(request('1',create,bytes),replacement);assert.equal(observer.response(response('1',{commit:receipt})),null);}
 const observer=new Selection();observer.request(request('1',create,bytes),arm());const original=response('1',{commit:receipt}),before=Buffer.from(original.raw);
 const selected=observer.response(original);assert.equal(selected.operationId,'operation');assert.equal(selected.entryId,'entry');assert.equal(selected.sequence,'7');assert.equal(selected.responseSha256,digest(before));assert.deepEqual(original.raw,before);
 observer.request(request('2',create,bytes),arm());assert.equal(observer.response(response('2',{commit:receipt})),null,'A fault cannot repeat on exact receipt replay');
});
test('negative native replies and foreign receipt identities never become a selected success',()=>{
 const observer=new Selection();observer.request(request('1',create,Buffer.from('literal 😀\r\n')),arm());
 assert.equal(observer.response(frame({version:1,request_id:'1',ok:false,error:{code:'revision_conflict',commit_uncertain:false}})),null);
 observer.request(request('2',create,Buffer.from('literal 😀\r\n')),arm());assert.equal(observer.response(response('2',{commit:{...receipt,operation_id:'foreign'}})),null);
});
test('held write gate binds actual observed path, exact prepared body and original token before committed receipt',()=>{
 const observer=new Selection(),hold=arm('hold'),bytes=Buffer.from('literal 😀\r\n');
 const stat={id:'entry',path:hold.path,kind:'file',revision:'before',deleted:false};
 observer.request(request('1',{method:'stat_path',path:hold.path}),hold);assert.equal(observer.response(response('1',{entry:stat})),null);
 const prepare={method:'prepare_intent',client_id:'client',operation_id:'operation',mutation:{type:'write',id:'entry',expected:'before'}};
 observer.request(request('2',prepare,bytes),hold);assert.equal(observer.response(response('2',{intent:{token:'token',client_id:'client',operation_id:'operation',entry_id:'entry',state:'prepared'}})),null);
 observer.request(request('3',{method:'commit_intent',reference:{client_id:'client',token:'foreign'}}),hold);assert.equal(observer.response(response('3',{intent:{token:'foreign',operation_id:'operation',state:'committed',receipt}})),null);
 observer.request(request('4',{method:'commit_intent',reference:{client_id:'client',token:'token'}}),hold);const selected=observer.response(response('4',{intent:{token:'token',operation_id:'operation',state:'committed',receipt}}));assert.equal(selected.arm.mode,'hold');assert.equal(selected.revision,'revision');
});
test('unknown path, wrong prepared bytes, uncommitted native outcomes and malformed arming cannot hold traffic',()=>{
 for(const knownPath of [false,true]){const observer=new Selection(),hold=arm('hold');if(knownPath){observer.request(request('8',{method:'stat_path',path:hold.path}),hold);observer.response(response('8',{entry:{id:'entry',path:hold.path}}));}const body=Buffer.from(knownPath?'other':'literal 😀\r\n');observer.request(request('1',{method:'prepare_intent',client_id:'client',operation_id:'operation',mutation:{type:'write',id:'entry'}},body),hold);observer.response(response('1',{intent:{token:'token',client_id:'client',operation_id:'operation',entry_id:'entry',state:'prepared'}}));observer.request(request('2',{method:'commit_intent',reference:{client_id:'client',token:'token'}}),hold);assert.equal(observer.response(response('2',{intent:{token:'token',operation_id:'operation',state:'committed',receipt}})),null);}
 assert.throws(()=>validateArm({...arm(),path:'../other'}));assert.throws(()=>validateArm({...arm(),bodySha256:'not-a-hash'}));
});
test('hold watchdog has a fixed deadline and wrong release tokens cannot release the native reply',async()=>{
 let clock=0,reads=0;const options={token:'original',now:()=>clock,pause:async ms=>{clock+=ms;},timeoutMs:15000};
 assert.equal(await waitForRelease({...options,read:async()=>{reads++;return{token:'other'};}}),false);assert.equal(clock,15000);assert.ok(reads<=1001);
 clock=0;assert.equal(await waitForRelease({...options,read:async()=>({token:clock>=30?'original':'other'})}),true);assert.equal(clock,30);
});


test('explicit prepared hold selects only exact genuine inert preparation and forwards no invented outcome',()=>{
 const bytes=Buffer.from('literal 😀\r\n'),hold={...arm('hold'),phase:'prepared'};
 const prepare={method:'prepare_intent',client_id:'client',operation_id:'operation',mutation:{type:'write',id:'entry',expected:'before'},source_capture:'capture'};
 const intent={token:'token',client_id:'client',operation_id:'operation',entry_id:'entry',state:'prepared'};
 for(const patch of [{bodySha256:digest(Buffer.from('wrong'))},{path:'Other.md'},{entryId:'foreign'}]){
  const observer=new Selection();observer.request(request('1',{method:'stat_path',path:hold.path}),hold);observer.response(response('1',{entry:{id:'entry',path:hold.path}}));
  observer.request(request('2',prepare,bytes),{...hold,...patch});assert.equal(observer.response(response('2',{intent})),null);
 }
 for(const state of ['commit_requested','committed','rejected']){
  const observer=new Selection();observer.request(request('1',{method:'stat_path',path:hold.path}),hold);observer.response(response('1',{entry:{id:'entry',path:hold.path}}));
  observer.request(request('2',prepare,bytes),hold);assert.equal(observer.response(response('2',{intent:{...intent,state}})),null,'Prepared phase cannot select '+state);
  observer.request(request('3',{method:'commit_intent',reference:{client_id:'client',token:'token'}}),hold);assert.equal(observer.response(response('3',{intent:{...intent,state:'committed',receipt}})),null,'A prepared-only arm cannot fall through to a later committed reply');
 }
 const observer=new Selection();observer.request(request('1',{method:'stat_path',path:hold.path}),hold);observer.response(response('1',{entry:{id:'entry',path:hold.path}}));
 observer.request(request('2',prepare,bytes),hold);const reply=response('2',{intent}),original=Buffer.from(reply.raw),selected=observer.response(reply);
 assert.equal(selected.phase,'prepared');assert.equal(selected.nativeState,'prepared');assert.equal(selected.nativeIntentToken,'token');assert.equal(selected.sequence,undefined);assert.equal(selected.revision,undefined);assert.deepEqual(reply.raw,original);
 observer.request(request('3',prepare,bytes),hold);assert.equal(observer.response(response('3',{intent})),null,'Prepared hold is consumed exactly once');
 assert.throws(()=>validateArm({...hold,phase:'failure'}));assert.throws(()=>validateArm({...arm('drop'),phase:'prepared'}));
});

test('prepared phase cannot select a genuine negative native reply or an unobserved path',()=>{
 const bytes=Buffer.from('literal 😀\r\n'),hold={...arm('hold'),phase:'prepared'},command={method:'prepare_intent',client_id:'client',operation_id:'operation',mutation:{type:'write',id:'entry'}};
 const observer=new Selection();observer.request(request('1',command,bytes),hold);
 assert.equal(observer.response(frame({version:1,request_id:'1',ok:false,error:{code:'filesystem_io',commit_uncertain:false}})),null);
 observer.request(request('2',command,bytes),hold);assert.equal(observer.response(response('2',{intent:{token:'token',client_id:'client',operation_id:'operation',entry_id:'entry',state:'prepared'}})),null);
});
