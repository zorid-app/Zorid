#!/usr/bin/env node
// Test executable only. The production application knows only its usual native
// host executable option; neither host nor renderer receives a new fault API.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {Frames, Selection, digest, waitForRelease} from './protocol.mjs';

const arg = name => process.argv[process.argv.indexOf(name) + 1];
const native = arg('--relay-native'), directory = arg('--relay-directory');
const split = process.argv.indexOf('--'); assert.ok(split > 0 && path.isAbsolute(native) && path.isAbsolute(directory));
const args = process.argv.slice(split + 1), child = spawn(native, args, {stdio:['pipe','pipe','pipe'],shell:false});
const requests = new Frames(), responses = new Frames(), selection = new Selection();
let dropped = false, failed = false, eventBytes = 0, requestCount = 0, responseCount = 0;
let requestChain = '', responseChain = '', eventTail = Promise.resolve();
const preparedBodies=new Map();
const eventsFile = path.join(directory, 'events.jsonl');
function event(value) {
  const line = JSON.stringify({at:Date.now(), relayPid:process.pid, nativePid:child.pid, ...value}) + '\n';
  eventBytes += Buffer.byteLength(line); assert.ok(eventBytes < 8 * 1024 * 1024, 'Bounded relay evidence');
  const result = eventTail.then(() => fs.appendFile(eventsFile, line, {mode:0o600})); eventTail = result.catch(() => {}); return result;
}
async function readControl(name) { try { const file=await fs.open(path.join(directory,name),'r');try{assert.ok((await file.stat()).size<=4096);return JSON.parse(await file.readFile('utf8'));}finally{await file.close();}} catch(error) { if(error.code==='ENOENT')return null;throw error; } }
async function write(stream, bytes) { if (!stream.write(bytes)) await once(stream,'drain'); }
async function childStopped() { await exit; }
async function stopChild() { child.stdin.end(); const timeout=setTimeout(()=>child.kill('SIGKILL'),3000);try{await childStopped();}finally{clearTimeout(timeout);} }
const exit = once(child,'close'); exit.catch(()=>{}); child.stderr.resume();
child.stdin.on('error',()=>{});
process.stdout.on('error',()=>child.kill('SIGKILL'));
await event({kind:'started',native,args});
const input = (async()=>{
  for await (const chunk of process.stdin) for (const frame of requests.push(chunk)) {
    if(dropped)break;
    selection.request(frame, await readControl('arm.json'));
    requestCount++; requestChain=digest(Buffer.from(requestChain+digest(frame.raw)));
    await write(child.stdin,frame.raw);
  }
  if(!dropped){requests.end();child.stdin.end();}
})().catch(error=>{if(!dropped)throw error;});
// Observe an input failure immediately while the output iterator is waiting.
// A malformed test frame must not terminate the relay and orphan its native child.
input.catch(()=>{child.stdin.destroy();child.kill('SIGKILL');});
const output = (async()=>{
  for await (const chunk of child.stdout) for (const frame of responses.push(chunk)) {
    const original=selection.pending, selected=selection.response(frame);
    if(original?.command.method==='prepare_intent'&&frame.header.ok&&frame.header.result?.intent){
      const intent=frame.header.result.intent,bodySha256=digest(original.frame.body);
      assert.ok(preparedBodies.size<1024,'Bounded prepared write evidence');
      preparedBodies.set(intent.token,{bodySha256,operationId:intent.operation_id});
      await event({kind:'native-prepared-write',entryId:intent.entry_id,operationId:intent.operation_id,bodySha256,token:intent.token});
    }
    if(original&&['file_command','commit_intent'].includes(original.command.method)) {
      const result=frame.header.result, receipt=result?.commit??result?.intent?.receipt;
      const prepared=preparedBodies.get(original.command.reference?.token);
      await event({kind:'native-mutation-response',method:original.command.method,requestId:frame.header.request_id,
        commandSha256:digest(Buffer.from(JSON.stringify(original.command))),bodySha256:digest(original.frame.body),
        ...(prepared?{preparedBodySha256:prepared.bodySha256}:{}),
        operationId:receipt?.operation_id,sequence:receipt?.sequence,ok:frame.header.ok,
        state:result?.intent?.state??(receipt?'committed':undefined),
        requestSha256:digest(original.frame.raw),responseSha256:digest(frame.raw)});
    }
    if(selected){
      // Consume the fault durably before an app restart can replay the command.
      await fs.unlink(path.join(directory,'arm.json'));
      const details={...selected}; delete details.arm;
      await event({kind:selected.arm.mode==='hold'?'held':'dropped',token:selected.arm.token,path:selected.arm.path,...details});
      if(selected.arm.mode==='drop'){
        // The output iterator is paused in this callback; drain EOF explicitly
        // so ChildProcess.close cannot wait on this same iterator advancing.
        dropped=true;child.stdout.resume();await stopChild();
        assert.equal(child.exitCode,0,'Dropped reply follows clean real-host shutdown');
        assert.equal(child.signalCode,null,'A killed native child is not clean reply-loss evidence');
        await event({kind:'drop-child-closed',exitCode:child.exitCode,signal:child.signalCode});
        // No native reply bytes have reached main. EOF is an actual transport
        // loss, never a manufactured negative acknowledgement.
        process.stdout.end();return;
      }
      const watchdog=!await waitForRelease({token:selected.arm.token,read:()=>readControl('release.json')});
      if(watchdog)failed=true;
      await event({kind:watchdog?'watchdog-released':'released',token:selected.arm.token,responseSha256:digest(frame.raw)});
    }
    responseCount++;responseChain=digest(Buffer.from(responseChain+digest(frame.raw)));
    await write(process.stdout,frame.raw);
  }
  if(!dropped)responses.end();
})();
try {
  await output;
  if(dropped)process.stdin.destroy();
  await input;await childStopped();
  await event({kind:'closed',dropped,failed,requestCount,responseCount,requestChain,responseChain,exitCode:child.exitCode,signal:child.signalCode});
  await eventTail;process.exitCode=failed?1:child.exitCode??1;
}catch(error){
  failed=true;await event({kind:'relay-failed',message:String(error.message)}).catch(()=>{});
  child.kill('SIGKILL');process.stdin.destroy();await childStopped().catch(()=>{});process.exitCode=1;
}
