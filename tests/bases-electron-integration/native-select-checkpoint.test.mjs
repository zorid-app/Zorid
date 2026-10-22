import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import {writeFileSync,symlinkSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';
import {UI} from './ui.mjs';
import {waitForNativeSelectCua,assertSingleCuaProcess} from './native-select-checkpoint.mjs';

test('CUA process identity rejects a second bare executable and ignores Helper executables',()=>{
  const executable='/Applications/Electron.app/Contents/MacOS/Electron',owned={pid:12,command:executable+' main.cjs --user-data-dir=/owned'};
  assert.equal(assertSingleCuaProcess([owned,{pid:13,command:'/Applications/Electron.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper --type=renderer'}],executable,12),owned);
  for(const command of [executable,executable+' other.cjs'])assert.throws(()=>assertSingleCuaProcess([owned,{pid:14,command}],executable,12),/only the owned/);
  assert.throws(()=>assertSingleCuaProcess([{pid:99,command:executable}],executable,12),/only the owned/);
});

async function fixture(t){
  const parent=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'zorid-cua-checkpoint-')));t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  return{directory:path.join(parent,'checkpoint'),identity:{pid:process.pid,executable:process.execPath,profile:path.join(parent,'profile'),windowIds:[123]},request:{tag:'SELECT',matches:1,connected:true,open:true,focus:{isSelect:true},nativeDisabled:false,ariaDisabled:false,inert:false,selector:'select',expectedValue:'purple'},evidence:{actions:[]},isAlive:()=>true,timeoutMs:100,pollMs:1};
}
test('fresh nonce only resumes control flow and records immutable ready/continuation evidence',async t=>{
  const f=await fixture(t);let ready;
  await waitForNativeSelectCua({...f,onReady(value){ready=value;writeFileSync(value.continueFile,JSON.stringify({token:value.token,action:'continue'}));}});
  assert.equal(f.evidence.actions.length,2);assert.equal(f.evidence.actions[0].request.expectedValue,'purple');assert.equal(f.evidence.actions[0].identity.pid,process.pid);assert.match(f.evidence.actions[0].readySHA256,/^[a-f0-9]{64}$/);assert.equal(f.evidence.actions[1].action,'native-select-cua-continued');
  assert.equal(JSON.parse(await fs.readFile(ready.readyFile,'utf8')).token,ready.token);
  assert.equal((await fs.stat(f.directory)).mode&0o777,0o700);
});
for(const kind of ['stale nonce','product field','symlink','changed ready'])test(`checkpoint rejects ${kind} without accepting product data`,async t=>{
  const f=await fixture(t);
  await assert.rejects(waitForNativeSelectCua({...f,onReady(value){
    const signal={token:kind==='stale nonce'?'old':value.token,action:'continue'};
    if(kind==='product field')signal.selectedValue='purple';
    if(kind==='symlink'){const other=path.join(path.dirname(f.directory),'outside.json');writeFileSync(other,JSON.stringify(signal));symlinkSync(other,value.continueFile);}
    else writeFileSync(value.continueFile,JSON.stringify(signal));
    if(kind==='changed ready')writeFileSync(value.readyFile,'{}');
  }}));assert.equal(f.evidence.actions.length,1);
});
test('deadline and exited owner fail instead of issuing or accepting input',async t=>{
  const f=await fixture(t);await assert.rejects(waitForNativeSelectCua({...f,timeoutMs:10}),/deadline expired/);assert.equal(f.evidence.actions.length,1);
  const other=await fixture(t);let live=true;await assert.rejects(waitForNativeSelectCua({...other,isAlive:()=>live,onReady(){live=false;}}),/Electron exited/);assert.equal(other.evidence.actions.length,1);
});
test('closed, unfocused or disabled SELECT cannot advertise a takeover checkpoint',async t=>{
  for(const patch of [{open:false},{focus:{isSelect:false}},{nativeDisabled:true},{ariaDisabled:true},{inert:true}]){const f=await fixture(t);await assert.rejects(waitForNativeSelectCua({...f,request:{...f.request,...patch}}));assert.deepEqual(f.evidence.actions,[]);}
});
test('CLI refuses takeover for hidden mode or the default heavy journey before launch',()=>{
  const root=fileURLToPath(new URL('../..',import.meta.url)),runner=fileURLToPath(new URL('./run.mjs',import.meta.url));
  const args=[runner,'--ready','bases-native-and-frontend-frozen','--cua-native-select-checkpoint','--root',root,'--expected-head','0'.repeat(40),'--native',process.execPath,'--electron',process.execPath,'--out',path.join(os.tmpdir(),'unused-cua-checkpoint-evidence')];
  for(const [extra,message]of [[[],/requires the shown owned window/],[['--show-window'],/restricted to the minimal native SELECT probe/]]){const result=spawnSync(process.execPath,[...args,...extra],{encoding:'utf8'});assert.notEqual(result.status,0);assert.match(result.stderr,message);}
});
test('optional input callback cannot satisfy the unchanged purple readback by continuing alone',async()=>{
  const dom=new JSDOM('<body><select><option value="">Default</option><option value="purple">purple</option></select></body>',{runScripts:'outside-only'}),{document,HTMLElement}=dom.window,select=document.querySelector('select');
  const rect={x:0,y:0,width:100,height:20};HTMLElement.prototype.getClientRects=()=>[rect];HTMLElement.prototype.getBoundingClientRect=()=>rect;HTMLElement.prototype.scrollIntoView=()=>{};document.elementFromPoint=()=>select;
  const actions=[],calls=[];let callbacks=0;
  const ui=new UI({evaluate:source=>structuredClone(dom.window.eval(source)),async call(method,params){calls.push({method,params});}},actions,{nativeSelectInput:async frame=>{callbacks++;assert.equal(frame.value,'');}}),wait=ui.wait.bind(ui);ui.wait=(body,label,timeout)=>wait(body,label,Math.min(timeout??20000,10));
  try{await assert.rejects(ui.select('select','purple'),/Native select accepted keyboard input/);assert.equal(callbacks,1);assert.equal(calls.filter(x=>x.method==='Input.dispatchKeyEvent').length,0);assert.equal(select.value,'');assert.equal(actions.filter(x=>x.action==='native-select-frame').at(-1).phase,'readback-failed');}finally{dom.window.close();}
});
