// Protocol mechanics only: this Node peer is deliberately simulated. Passing
// this test is never a genuine Rust receipt, native recovery or app result.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createNativeRelay} from './control.mjs';
import {Frames,digest} from './protocol.mjs';
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const encode=(header,body=Buffer.alloc(0))=>{const json=Buffer.from(JSON.stringify(header)),prefix=Buffer.alloc(8);prefix.writeUInt32BE(json.length);prefix.writeUInt32BE(body.length,4);return Buffer.concat([prefix,json,body]);};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(check){const end=Date.now()+5000;while(Date.now()<end){const value=await check();if(value)return value;await pause(10);}throw Error('Simulated relay unit timed out');}
test('simulated stdio peer verifies byte-exact forwarding and clean EOF after dropped success', {timeout:10000},async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'zorid-relay-unit-')),peer=path.join(directory,'SIMULATED-peer'),script=path.join(directory,'peer.mjs');
 let child,relay;const chunks=[],errors=[];
 try{
  const protocol=fileURLToPath(new URL('./protocol.mjs',import.meta.url));
  await fs.writeFile(script,`import {Frames} from ${JSON.stringify(protocol)};
const encode=${encode.toString()};
process.stdout.write(encode({version:1,request_id:'0',ok:true,result:{SIMULATED:true}}));
const parser=new Frames();for await(const chunk of process.stdin)for(const frame of parser.push(chunk)){
 const request=frame.header.command.family?.request;
 if(!request){process.stdout.write(encode({version:1,request_id:frame.header.request_id,ok:true,result:{echo:true}},frame.body));continue;}
 const mutation=request.mutation,receipt={operation_id:request.operation_id,sequence:'7',changes:[{before:null,after:{id:mutation.id,path:mutation.path,kind:'file',revision:'mock-r1',deleted:false}}]};
 process.stdout.write(encode({version:1,request_id:frame.header.request_id,ok:true,result:{commit:receipt}}));
}parser.end();
`);
  await fs.writeFile(peer,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,{mode:0o700});
  relay=await createNativeRelay({native:peer,directory:path.join(directory,'control')});
  child=spawn(relay.executable,['--vault',directory],{stdio:['pipe','pipe','pipe']});
  const closed=once(child,'close');child.stdout.on('data',chunk=>chunks.push(chunk));child.stderr.on('data',chunk=>errors.push(chunk));
  const initial=encode({version:1,request_id:'0',ok:true,result:{SIMULATED:true}});
  await wait(()=>Buffer.concat(chunks).length===initial.length);assert.deepEqual(Buffer.concat(chunks),initial);
  const body=Buffer.from([0,255,128,10]),ping=encode({version:1,request_id:'1',command:{method:'unit-echo'}},body);
  child.stdin.write(ping);
  const echo=encode({version:1,request_id:'1',ok:true,result:{echo:true}},body);
  await wait(()=>Buffer.concat(chunks).length===initial.length+echo.length);assert.deepEqual(Buffer.concat(chunks),Buffer.concat([initial,echo]));
  const payload=Buffer.from('simulated-unit-body'),token=await relay.arm({mode:'drop',path:'Created/Unit.md',bodySha256:digest(payload)});
  child.stdin.write(encode({version:1,request_id:'2',command:{method:'file_command',client_id:'mock-client',family:{version:1,request:{operation_id:'mock-operation',mutation:{type:'create',id:'mock-entry',path:'Created/Unit.md',kind:'file'}},create_mode:'text'}}},payload));
  const [code,signal]=await closed;assert.equal(code,0,Buffer.concat(errors).toString());assert.equal(signal,null);
  assert.deepEqual(Buffer.concat(chunks),Buffer.concat([initial,echo]),'The selected simulated success frame never reached main');
  const events=await relay.events();assert.equal(events.filter(value=>value.kind==='dropped'&&value.token===token).length,1);
  assert.ok(events.some(value=>value.kind==='drop-child-closed'&&value.exitCode===0&&value.signal===null));
  assert.ok(events.some(value=>value.kind==='closed'&&value.dropped===true&&value.failed===false));
  assert.deepEqual(events.filter(value=>value.kind==='relay-failed'),[]);
  assert.equal(await fs.stat(path.join(directory,'control','arm.json')).catch(error=>error.code),'ENOENT');
  new Frames().push(Buffer.concat(chunks));
 }finally{
  await relay?.dispose().catch(()=>{});
  if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'close');}
  await fs.rm(directory,{recursive:true,force:true});
 }
});
