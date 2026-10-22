import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {artifactHash,admitExternalCli,assertExternalCli,auditSavedNote,assertUnsavedBeforeCli,assertCliAdvancedBeforeDesktopIntent,assertRetainedExternalConflict,createExternalCliConflicts} from './external-cli-conflict.mjs';
import {conflictNote} from './campaign.mjs';
const exec=promisify(execFile),safety='/owned/tests/bases-electron-safety-integration/campaign.mjs';
const before='---\nscore: 2\n---\n# Body sentinel\n',draft=before+'\nLocal marker\n',external=before+'\nIndependent peer marker\n';
const entry={id:'entry-b',path:'B.md',kind:'file',revision:'original',deleted:false};
const saved={base:{entryId:entry.id,path:entry.path,revision:entry.revision,content:before},draft:before,conflict:false};
async function sql(db,script,args=[]){return exec('python3',['-c',script,db,...args],{timeout:5000,maxBuffer:1024*1024});}
async function setup(t){
  const out=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'zorid-cli-conflict-protocol-'))),vault=path.join(out,'disposable','bases-safety'),db=path.join(vault,'.zorid','vault.sqlite');
  await fs.mkdir(path.dirname(db),{recursive:true});await fs.writeFile(path.join(vault,'B.md'),before);
  await sql(db,`import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1]);c.executescript('CREATE TABLE entries(id TEXT,path TEXT,deleted INTEGER,visible INTEGER,state TEXT,content BLOB);CREATE TABLE checkpoint_heads(client_id TEXT,checkpoint_key TEXT,encoded_state TEXT);CREATE TABLE host_intents(intent_order INTEGER,operation_id TEXT,entry_id TEXT,state TEXT,acknowledged INTEGER)')
s=json.loads(sys.argv[2]);c.execute('INSERT INTO entries VALUES(?,?,0,1,?,?)',(s['id'],s['path'],json.dumps(s),sys.argv[3].encode()));c.execute('INSERT INTO checkpoint_heads VALUES(?,?,?)',('desktop','note/v1/'+s['id'],sys.argv[4]));c.commit();c.close()`,[JSON.stringify(entry),before,JSON.stringify(saved)]);
  const cli=path.join(out,'protocol-cli');
  // This executable is a UNIT protocol peer only. It proves process ownership,
  // stdin gating and evidence assertions, never actual Rust/native semantics.
  await fs.writeFile(cli,`#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
const a=process.argv.slice(2),get=k=>a[a.indexOf(k)+1],vault=get('--vault'),id=get('--id'),revision=get('--expected-revision'),op=get('--operation-id'),db=path.join(vault,'.zorid','vault.sqlite');
const fd=fs.openSync(db,'r');let body='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>body+=chunk);process.stdin.on('end',()=>{
 const py=\`import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1]);row=c.execute('SELECT state FROM entries WHERE id=?',(sys.argv[2],)).fetchone();before=json.loads(row[0]);assert before['revision']==sys.argv[3];after={**before,'revision':'peer-revision'};c.execute('UPDATE entries SET state=?,content=? WHERE id=?',(json.dumps(after),sys.argv[5].encode(),sys.argv[2]));c.commit();print(json.dumps({'durable_local_commit':True,'synced':False,'commit':{'operation_id':sys.argv[4],'sequence':'2','changes':[{'before':before,'after':after}]}}));c.close()\`;
 const result=spawnSync('python3',['-c',py,db,id,revision,op,body],{encoding:'utf8'});if(result.status!==0){process.stderr.write(result.stderr);process.exit(3);}fs.writeFileSync(path.join(vault,'B.md'),body);fs.closeSync(fd);process.stdout.write(result.stdout);
});
`,{mode:0o700});
  // ESM semantics are explicit for this extensionless shebang executable.
  await fs.writeFile(path.join(out,'package.json'),'{"type":"module"}');
  const artifact=await admitExternalCli({argv:['--external-cli',cli,'--expected-external-cli-sha256',await artifactHash(cli)],campaignPath:safety,safetyCampaignPath:safety});
  const evidence={},helper=await createExternalCliConflicts({artifact,vault,outputDirectory:out,evidence,env:process.env});
  t.after(async()=>{await helper.dispose();await fs.rm(out,{recursive:true,force:true});});
  async function state(value){await sql(db,`import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.execute('UPDATE checkpoint_heads SET encoded_state=?',(sys.argv[2],));c.commit();c.close()`,[JSON.stringify(value)]);}
  return{out,vault,db,cli,artifact,evidence,helper,state};
}

test('external CLI admission is explicit, paired, safety-only and hashes the executable',async t=>{
  const f=await setup(t);assert.equal(f.artifact.file,await fs.realpath(f.cli));
  await assert.rejects(admitExternalCli({argv:[],campaignPath:safety,safetyCampaignPath:safety}),/requires explicit/);
  await assert.rejects(admitExternalCli({argv:['--external-cli',f.cli],campaignPath:safety,safetyCampaignPath:safety}),/supplied together/);
  await assert.rejects(admitExternalCli({argv:['--external-cli',f.cli,'--expected-external-cli-sha256','0'.repeat(64)],campaignPath:safety,safetyCampaignPath:safety}),/does not match/);
  await assert.rejects(admitExternalCli({argv:['--external-cli',f.cli,'--expected-external-cli-sha256',f.artifact.sha256],campaignPath:'/other/campaign.mjs',safetyCampaignPath:safety}),/only admitted/);
  assert.equal(await admitExternalCli({argv:[],campaignPath:'/other/campaign.mjs',safetyCampaignPath:safety}),undefined);
  await fs.appendFile(f.cli,'\n// Changed fixture executable\n');await assert.rejects(assertExternalCli(f.artifact),/identity changed/);
});

test('readonly auditor reads an exact note checkpoint without altering original SQLite bytes',async t=>{
  const f=await setup(t),original=await fs.readFile(f.db),seen=await auditSavedNote(f.vault,'B.md');
  assert.deepEqual(seen.entry,entry);assert.equal(seen.source,before);assert.deepEqual(seen.checkpoints,[{clientId:'desktop',state:saved}]);assert.deepEqual(seen.intents,[]);assert.deepEqual(await fs.readFile(f.db),original);
  await assert.rejects(auditSavedNote(f.vault,'../B.md'),/traverse/);
  await fs.symlink(path.join(f.vault,'B.md'),path.join(f.vault,'Alias.md'));await assert.rejects(auditSavedNote(f.vault,'Alias.md'),/symlinks/);
});

test('read-only evidence sees a committed live WAL rather than ignoring it as immutable',async t=>{
  const f=await setup(t);const script=`import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.execute('PRAGMA journal_mode=WAL');c.execute('UPDATE entries SET content=?',(b'Committed live WAL source',));c.commit();print('READY',flush=True);sys.stdin.read();c.close()`;
  const child=spawn('python3',['-c',script,f.db],{stdio:['pipe','pipe','pipe']});let errors='';child.stderr.on('data',b=>errors+=b);const terminal=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  try{await new Promise((resolve,reject)=>{child.stdout.once('data',b=>b.toString().includes('READY')?resolve():reject(Error('Missing WAL readiness')));child.once('error',reject);});
    const main=await fs.readFile(f.db),wal=await fs.readFile(f.db+'-wal');const seen=await auditSavedNote(f.vault,'B.md');assert.equal(seen.source,'Committed live WAL source');assert.deepEqual(await fs.readFile(f.db),main);assert.deepEqual(await fs.readFile(f.db+'-wal'),wal);
  }finally{child.stdin.end();const result=await terminal;assert.deepEqual(result,{code:0,signal:null},errors);}
});

test('ordering oracles reject early desktop intent, changed logical source and uncheckpointed or recomputed drafts',()=>{
  const expected={before,draft,entry,intents:[],external},observation={entry,source:before,intents:[],checkpoints:[{clientId:'desktop',state:{...saved,draft}}]};
  assertUnsavedBeforeCli(observation,expected);
  for(const mutate of [x=>{x.intents.push({operationId:'desktop-early'});},x=>{x.source='already saved';},x=>{x.checkpoints[0].state.draft='missing draft';},x=>{x.checkpoints[0].state.operation={plan:{operationId:'desktop-plan'}};}]){const bad=structuredClone(observation);mutate(bad);assert.throws(()=>assertUnsavedBeforeCli(bad,expected));}
  const receipt={durable_local_commit:true,synced:false,commit:{sequence:'2',changes:[{before:entry,after:{...entry,revision:'peer'}}]}},after={...observation,entry:receipt.commit.changes[0].after,source:external};
  assertCliAdvancedBeforeDesktopIntent(after,{...expected,receipt});assert.throws(()=>assertRetainedExternalConflict(after,{...expected,receipt}),/external-revision conflict/);
  after.checkpoints[0].state.conflict=true;assertRetainedExternalConflict(after,{...expected,receipt});
  for(const mutate of [x=>{x.entry.revision='later';},x=>{x.source='merged';},x=>{x.intents.push({operationId:'desktop-late'});},x=>{x.checkpoints[0].state.operation={ref:{token:'desktop-intent'}};},x=>{x.checkpoints[0].state.base.content='adopted peer';}]){const bad=structuredClone(after);mutate(bad);assert.throws(()=>assertRetainedExternalConflict(bad,{...expected,receipt}));}
});

test('prewarmed real child opens the owned vault before input, receives one exact request and closes normally',async t=>{
  const f=await setup(t),writer=await f.helper.prime('B.md',before);assert.equal(f.evidence.externalCli.length,1);const record=f.evidence.externalCli[0];assert.equal(record.stdinSent,false);assert.ok(record.ready.at>=record.started);assert.ok(record.ready.process.includes(f.cli));assert.equal(record.ready.database,f.db);
  await f.state({...saved,draft});const ordered=await writer.commit(draft,external);assert.equal(record.exitCode,0);assert.equal(record.signal,null);assert.equal(record.cleanupVerified,true);assert.equal(record.inputBytes,Buffer.byteLength(external));assert.equal(record.receipt.commit.operation_id,record.operationId);assert.equal((await auditSavedNote(f.vault,'B.md')).source,external);
  await assert.rejects(ordered.assertConflict(),/external-revision conflict/);await f.state({...saved,draft,conflict:true});await ordered.assertConflict();await writer.close();assert.equal(f.evidence.externalCli.length,1);
});

test('strict missed precondition closes the owned child without sending input or changing the original',async t=>{
  const f=await setup(t),writer=await f.helper.prime('B.md',before);await assert.rejects(writer.commit(draft,external),/Exact UI draft/);
  const record=f.evidence.externalCli[0];assert.equal(record.stdinSent,false);assert.equal(record.cleanupVerified,true);assert.equal(record.signal,'SIGTERM');assert.equal(await fs.readFile(path.join(f.vault,'B.md'),'utf8'),before);assert.equal((await auditSavedNote(f.vault,'B.md')).source,before);
});

test('abandoning a primed writer terminates only that owned child while preserving the source',async t=>{
  const f=await setup(t),writer=await f.helper.prime('B.md',before);await writer.close();const record=f.evidence.externalCli[0];assert.equal(record.stdinSent,false);assert.equal(record.cleanupVerified,true);assert.equal(record.signal,'SIGTERM');assert.equal(await fs.readFile(path.join(f.vault,'B.md'),'utf8'),before);
});

test('external writer cannot target another vault even below the same evidence root',async t=>{
  const f=await setup(t),other=path.join(f.out,'disposable','other');await fs.mkdir(other);
  await assert.rejects(createExternalCliConflicts({artifact:f.artifact,vault:other,outputDirectory:f.out,evidence:{},env:process.env}),/only access this campaign disposable vault/);
});


test('campaign conflict protocol primes before UI input and appends only the body through real keyboard actions',async()=>{
  const calls=[];let source=before;const marker='Local marker',expectedDraft=before+'\n'+marker+'\n',expectedExternal=before+'\nExternal authority '+marker+'\n';
  const writer={async commit(actualDraft,actualExternal){calls.push('commit');assert.equal(actualDraft,expectedDraft);assert.equal(actualExternal,expectedExternal);assert.equal(actualDraft.split('score: 2').length,2,'Only one original frontmatter prefix');source=expectedExternal;return{async assertConflict(){calls.push('assertConflict');}};},async close(){calls.push('close');}};
  const c={evidence:{actions:[]},read:async()=>source,externalCliConflicts:{async prime(file,original){calls.push('prime');assert.equal(file,'B.md');assert.equal(original,before);return writer;}},ui:{async openFile(){calls.push('open');},async wait(){calls.push('wait');},async click(){calls.push('click');},async key(key){calls.push(key);},async dom(){return{collapsed:true,lastText:'',atLast:true};}},cdp:{async call(method,input){calls.push(method);assert.equal(method,'Input.insertText');assert.equal(input.text,marker+'\n');}}};
  const result=await conflictNote(c,'B.md',marker);assert.deepEqual(result,{before,draft:expectedDraft,external:expectedExternal});assert.ok(calls.indexOf('prime')<calls.indexOf('click'));assert.ok(calls.indexOf('ArrowDown')<calls.indexOf('Enter'));assert.ok(calls.indexOf('Input.insertText')<calls.indexOf('commit'));assert.equal(calls.at(-1),'close');assert.deepEqual(c.evidence.actions[0].text,marker+'\n');
});

test('campaign conflict protocol closes the primed child when its exact precondition fails',async()=>{
  let closed=0;const c={evidence:{actions:[]},read:async()=>before,externalCliConflicts:{async prime(){return{async commit(){throw Error('Strict missed precondition');},async close(){closed++;}};}},ui:{async openFile(){},async wait(){},async click(){},async key(){},async dom(){return{collapsed:true,lastText:'',atLast:true};}},cdp:{async call(){}}};
  await assert.rejects(conflictNote(c,'B.md','marker'),/Strict missed precondition/);assert.equal(closed,1);
});
