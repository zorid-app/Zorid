import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {constants,createReadStream} from 'node:fs';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {fixturePath,readFixture} from '../bases-electron-integration/owned-fixtures.mjs';
import {until} from '../tasks-electron-integration/cdp.mjs';
const exec=promisify(execFile);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const boundedSource=value=>{assert.equal(typeof value,'string');assert.ok(Buffer.byteLength(value)<=256*1024,'Bounded fixture source');};
const identity=async file=>{const s=await fs.stat(file,{bigint:true});return[s.dev,s.ino,s.size,s.mtimeNs].map(String);};
export async function artifactHash(file){const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);return h.digest('hex');}
export async function admitExternalCli({argv,campaignPath,safetyCampaignPath}){
  const option=name=>{const at=argv.flatMap((x,i)=>x===name?[i]:[]);assert.ok(at.length<=1,'Duplicate '+name);if(!at.length)return undefined;const value=argv[at[0]+1];assert.ok(value&&!value.startsWith('--'),'Explicit '+name+' value required');return value;};
  const requested=option('--external-cli'),expected=option('--expected-external-cli-sha256');
  assert.equal(!!requested,!!expected,'External CLI artifact and SHA256 must be supplied together');
  if(campaignPath!==safetyCampaignPath){assert.ok(!requested,'External CLI is only admitted for the safety campaign');return undefined;}
  assert.ok(requested&&expected,'Safety campaign requires explicit external CLI and SHA256');assert.match(expected,/^[0-9a-f]{64}$/);
  const file=await fs.realpath(requested),s=await fs.lstat(file);assert.ok(s.isFile()&&!s.isSymbolicLink(),'External CLI must be a regular executable');await fs.access(file,constants.X_OK);
  const stat=await identity(file);assert.equal(await artifactHash(file),expected,'External CLI does not match its expected artifact hash');assert.deepEqual(await identity(file),stat,'External CLI changed during admission');
  return Object.freeze({file,sha256:expected,stat:Object.freeze(stat)});
}
export async function assertExternalCli(artifact){assert.deepEqual(await identity(artifact.file),artifact.stat,'External CLI file identity changed');assert.equal(await artifactHash(artifact.file),artifact.sha256,'External CLI artifact changed');}

// One coherent SQLite read transaction. mode=ro is intentional: immutable=1
// would ignore a live WAL. No write connection, schema edit or checkpoint API.
const AUDIT=String.raw`import sqlite3,pathlib,json,sys
p=pathlib.Path(sys.argv[1]);c=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True,timeout=2)
c.execute('BEGIN')
r=c.execute('SELECT id,state,content FROM entries WHERE path=? AND deleted=0 AND visible=1',(sys.argv[2],)).fetchall()
if len(r)!=1: raise RuntimeError('Expected one live fixture entry')
id,state,content=r[0]
heads=[{'clientId':client,'state':json.loads(raw)} for client,raw in c.execute('SELECT client_id,encoded_state FROM checkpoint_heads WHERE checkpoint_key=?',('note/v1/'+id,)) if raw is not None]
intents=[{'order':n,'operationId':op,'state':s,'acknowledged':bool(a)} for n,op,s,a in c.execute('SELECT intent_order,operation_id,state,acknowledged FROM host_intents WHERE entry_id=? ORDER BY intent_order',(id,))]
print(json.dumps({'entry':json.loads(state),'source':bytes(content).decode('utf-8'),'checkpoints':heads,'intents':intents}))
c.rollback();c.close()
`;
export async function auditSavedNote(vault,file){const db=await fixturePath(vault,'.zorid/vault.sqlite');await fixturePath(vault,file);const {stdout}=await exec('python3',['-c',AUDIT,db,file],{timeout:8000,maxBuffer:2*1024*1024});return JSON.parse(stdout);}
function checkpoint(observation){assert.equal(observation.checkpoints.length,1,'Exactly one desktop note checkpoint');return observation.checkpoints[0].state;}
export function assertUnsavedBeforeCli(observation,{before,draft,entry,intents}){
  assert.deepEqual(observation.entry,entry,'Logical entry advanced before independent CLI write');assert.equal(observation.source,before,'Logical source advanced before independent CLI write');assert.deepEqual(observation.intents,intents,'A desktop intent exists before independent CLI write');
  const state=checkpoint(observation);assert.equal(state.base.entryId,entry.id);assert.equal(state.base.revision,entry.revision);assert.equal(state.base.path,entry.path);assert.equal(state.base.content,before);assert.equal(state.draft,draft,'Exact UI draft must already be durably checkpointed');assert.equal(state.conflict,false);assert.equal(state.operation,undefined,'No retained plan or intent may precede the CLI fixture');
}
export function assertCliAdvancedBeforeDesktopIntent(observation,{before,draft,entry,intents,external,receipt}){
  assert.equal(receipt.durable_local_commit,true);assert.equal(receipt.synced,false);assert.ok(receipt.commit&&typeof receipt.commit.sequence==='string');
  assert.equal(receipt.commit.changes.length,1,'CLI Write affects exactly one entry');const change=receipt.commit.changes[0];assert.deepEqual(change.before,entry);assert.equal(change.after.id,entry.id);assert.equal(change.after.path,entry.path);assert.equal(change.after.deleted,false);assert.notEqual(change.after.revision,entry.revision);
  assert.deepEqual(observation.entry,change.after,'Current core state must equal the independent CLI receipt');assert.equal(observation.source,external);assert.deepEqual(observation.intents,intents,'Desktop prepared an intent before the CLI ordering witness');
  const state=checkpoint(observation);assert.equal(state.base.entryId,entry.id);assert.equal(state.base.revision,entry.revision);assert.equal(state.base.content,before);assert.equal(state.draft,draft);assert.equal(state.operation,undefined,'Desktop already retained a plan before CLI ordering was proven');
}
// This proves retained external authority plus the exact local draft. The app
// may detect the revision change on reload or during planning; database records
// do not reveal an unretained planWrite invocation or identify its result.
export function assertRetainedExternalConflict(observation,expected){assertCliAdvancedBeforeDesktopIntent(observation,expected);const state=checkpoint(observation);assert.equal(state.conflict,true,'A real external-revision conflict must be retained');}

async function processFrame(pid){const {stdout}=await exec('/bin/ps',['-p',String(pid),'-o','lstart=','-o','command='],{timeout:2000,maxBuffer:16384});const line=stdout.trim();assert.ok(line,'Owned CLI process disappeared');return line;}
export async function createExternalCliConflicts({artifact,vault,outputDirectory,evidence,env}){
  assert.ok(artifact,'Explicit external CLI capability required');const out=await fs.realpath(outputDirectory),owned=path.join(out,'disposable','bases-safety');assert.equal(await fs.realpath(vault),owned,'CLI may only access this campaign disposable vault');
  // Fail before spawning a writer when this process lacks OS inspection rights.
  await processFrame(process.pid);await exec('/usr/sbin/lsof',['-a','-p',String(process.pid),'-Fn'],{timeout:2000,maxBuffer:131072});
  const active=new Set();let count=0;
  async function prime(file,before){
    boundedSource(before);assert.ok(++count<=4,'Bounded independent CLI conflict fixture count');await assertExternalCli(artifact);const physical=await readFixture(vault,file);assert.equal(physical,before);
    const initial=await auditSavedNote(vault,file);assert.equal(initial.source,before);const entry=initial.entry;assert.equal(entry.path,file);assert.equal(entry.kind,'file');assert.equal(entry.deleted,false);
    const operationId='bases-safety-external-'+randomUUID(),argv=['--vault',owned,'write','--id',entry.id,'--expected-revision',entry.revision,'--operation-id',operationId,'--input','-'];
    const command=[artifact.file,...argv].join(' '),started=Date.now(),child=spawn(artifact.file,argv,{env,stdio:['pipe','pipe','pipe']});let failure,frame,closed=false,resolveClose,closing;const stdout=[],stderr=[];let bytes=0;
    const terminal=new Promise(resolve=>{resolveClose=resolve;});
    const record={kind:'actual-independent-cli-write',file,operationId,artifact:{file:artifact.file,sha256:artifact.sha256,stat:artifact.stat},argv,pid:child.pid,started,stdinSent:false};(evidence.externalCli??=[]).push(record);
    child.once('error',error=>{failure=error;});child.once('close',(code,signal)=>{closed=true;Object.assign(record,{exitCode:code,signal,closed:Date.now()});resolveClose();});child.stdin.on('error',error=>{failure??=error;});
    const collect=target=>chunk=>{bytes+=chunk.length;if(bytes>2*1024*1024){failure??=new Error('Bounded external CLI output exceeded');void close().catch(error=>{failure??=error;});}else target.push(chunk);};child.stdout.on('data',collect(stdout));child.stderr.on('data',collect(stderr));
    const timer=setTimeout(()=>{failure??=new Error('Owned external CLI exceeded 25 seconds');void close().catch(error=>{failure??=error;});},25000);
    async function waitClosed(ms){let timeout;try{await Promise.race([terminal,new Promise(resolve=>{timeout=setTimeout(resolve,ms);})]);}finally{clearTimeout(timeout);}}
    async function observeOwned(){
      let seen;try{seen=await processFrame(child.pid);}catch(error){await waitClosed(100);if(closed)return;throw error;}
      assert.ok(seen.endsWith(command),'Exact owned CLI command required for cleanup');if(frame)assert.equal(seen,frame,'Owned CLI PID/start identity changed');else frame=seen;
    }
    function close(){
      if(closing)return closing;
      closing=(async()=>{
        if(!closed){await observeOwned();if(!closed)child.kill('SIGTERM');await waitClosed(3000);if(!closed){await observeOwned();if(!closed)child.kill('SIGKILL');await waitClosed(3000);}assert.ok(closed,'Owned CLI close must be observed');}
        clearTimeout(timer);active.delete(close);record.stdout=Buffer.concat(stdout).toString('utf8');record.stderr=Buffer.concat(stderr).toString('utf8');record.stdoutSha256=sha(record.stdout);record.stderrSha256=sha(record.stderr);record.cleanupVerified=closed;
      })().catch(error=>{closing=undefined;throw error;});
      return closing;
    }
    active.add(close);
    try{
      await until(async()=>{if(failure)throw failure;assert.ok(!closed,'CLI exited before UI draft');const seen=await processFrame(child.pid);assert.ok(seen.endsWith(command),'Exact independent CLI command required');const {stdout:open}=await exec('/usr/sbin/lsof',['-a','-p',String(child.pid),'-Fn'],{timeout:2000,maxBuffer:65536});const db=path.join(owned,'.zorid','vault.sqlite');assert.ok(open.split('\n').includes('n'+db),'CLI must have opened the exact owned vault before UI input');frame=seen;record.ready={at:Date.now(),process:frame,database:db};return true;},8000);
      return{async commit(draft,external){
        try{
          boundedSource(draft);boundedSource(external);
          assert.deepEqual(await identity(artifact.file),artifact.stat,'External CLI changed before input');assert.equal(await readFixture(vault,file),before,'Actual saved bytes changed before CLI input');const pre=await auditSavedNote(vault,file),expected={before,draft,entry,intents:initial.intents,external};assertUnsavedBeforeCli(pre,expected);record.beforeCli=pre;
          assert.ok(!closed&&!record.stdinSent);record.stdinSent=true;record.inputBytes=Buffer.byteLength(external);record.inputSha256=sha(external);record.inputSentAt=Date.now();child.stdin.end(external);
          await waitClosed(15000);assert.ok(closed,'Independent CLI result must be observed');await close();if(failure)throw failure;assert.equal(record.exitCode,0,record.stderr);assert.equal(record.signal,null);const receipt=JSON.parse(record.stdout);assert.equal(receipt.commit?.operation_id,operationId);record.receipt=receipt;
          const post=await auditSavedNote(vault,file);record.afterCli=post;assertCliAdvancedBeforeDesktopIntent(post,{...expected,receipt});await assertExternalCli(artifact);
          return{...expected,receipt,async assertConflict(){const observed=await auditSavedNote(vault,file);assertRetainedExternalConflict(observed,{...expected,receipt});record.retainedConflict=observed;assert.equal(await readFixture(vault,file),external);}};
        }finally{await close();}
      },close};
    }catch(error){record.failure=error.message;try{await close();}catch(cleanup){throw new Error(error.message+'; CLI cleanup: '+cleanup.message,{cause:error});}throw error;}
  }
  return Object.freeze({prime,async dispose(){for(const close of [...active])await close();}});
}
