'use strict';
// Actual CLI + Rust child + admitted CJS consumer. Explicit target: absence of
// built binaries is a failure, never a passing skip. No renderer parser is used.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {tmpdir}=require('node:os');
const {spawn}=require('node:child_process');
const {RustVaultService}=require('../desktop/rust-vault-service.cjs');
const {admitDesktopFixtureClient}=require('../desktop/client-admission.cjs');
const request=(op,fields={})=>({schemaVersion:1,command:{op,...fields}});
function cli(root,args,input=''){
  const executable=process.env.ZORID_CLI_BIN;
  assert.ok(executable&&path.isAbsolute(executable),'ZORID_CLI_BIN must identify the real built CLI');
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,['--vault',root,...args],{stdio:['pipe','pipe','pipe']}),out=[],err=[];
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('CLI fixture timeout'));},15000);
    child.stdout.on('data',data=>out.push(data));child.stderr.on('data',data=>err.push(data));
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{clearTimeout(timer);try{const result=JSON.parse(Buffer.concat(code===0?out:err).toString('utf8'));assert.equal(code,0,JSON.stringify(result));resolve(result);}catch(error){reject(error);}});
    child.stdin.on('error',()=>{});child.stdin.end(input);
  });
}
async function build(call){
  const stage=await call('begin');
  for(let pump=0;pump<20;pump++){
    const progress=await call('pump',{snapshot:stage.snapshot});
    if(progress.ready)return call('publish',{snapshot:stage.snapshot});
  }
  throw new Error('bounded fixture build made no completion');
}

test('actual desktop semantic transport retains one snapshot through independent CLI changes', {timeout:90000},async t=>{
  const executable=process.env.ZORID_DESKTOP_HOST_BIN;
  assert.ok(executable&&path.isAbsolute(executable),'ZORID_DESKTOP_HOST_BIN must identify the real built host');
  const root=await fs.mkdtemp(path.join(tmpdir(),'zorid-document-transport-'));
  let host;const admissions=[];
  t.after(async()=>{for(const admission of admissions)await admission.retire().catch(()=>{});if(host)await host.close();await fs.rm(root,{recursive:true,force:true});});
  await cli(root,['init']);
  const original='\ufeff---\r\nconfig: {Title: first, title: second}\r\n---\r\n# 😀 Heading\r\n[[Target]] ![[Target]] [[Target]]\r\nneedle 😀\r\nneedle second\r\n';
  for(const [id,file,body] of [
    ['source','Source.md',original],['target','Target.md','# Target\n'],
    ['base','All.base','views:\n  - type: table\n    name: Linked\n    filters: \'file.hasLink("Target")\'\n    order: [file.path, config.TITLE]\n'],
  ])await cli(root,['create',file,'--id',id,'--operation-id',`create-${id}`,'--input','-'],body);
  host=await RustVaultService.open(root,{executable});
  assert.ok(host.capabilities.includes('documents'));
  await assert.rejects(host.documentCommand('10000000-0000-4000-8000-000000000001',request('status')),{code:'client_not_admitted'});
  const service={host,root,closed:false};
  async function admit(clientId){const value=await admitDesktopFixtureClient(service,{fixture:true,clientId,assertOwner:()=>{}});admissions.push(value);return value;}
  const first=await admit('10000000-0000-4000-8000-000000000001');
  const second=await admit('10000000-0000-4000-8000-000000000002');
  const call=(op,fields)=>first.documentCommand(request(op,fields)),other=(op,fields)=>second.documentCommand(request(op,fields));
  await call('initialize');
  const snapshot=await build(call);
  const pinId='1',opened=await call('open',{pinId});
  assert.deepEqual(opened.snapshot,snapshot);
  assert.deepEqual(await call('open',{pinId}),opened,'exact open retry must retain its original generation');
  // Independent view lifetimes: keep four pins without implicitly closing or
  // substituting the older view, and respect the shared Store's global quota.
  for(const pinId of ['2','3','4'])assert.deepEqual((await call('open',{pinId})).snapshot,snapshot);
  await assert.rejects(call('open',{pinId:'5'}),{code:'pin_capacity'});
  await assert.rejects(other('open',{pinId:'1'}),{code:'generation_limit'});
  assert.deepEqual(await call('open',{pinId}),opened,'a live ID retries even below the monotonic floor');
  await call('close',{pinId:'2'});await call('close',{pinId:'2'});
  await assert.rejects(call('open',{pinId:'2'}),{code:'snapshot_expired'});
  assert.deepEqual((await call('metadata',{pinId:'3',id:'source'})).snapshot,snapshot,'closing another view cannot evict this pin');
  await call('open',{pinId:'5'}); // Failed quota attempts did not consume its sequence.
  for(const pinId of ['3','4','5'])await call('close',{pinId});

  const metadata=await call('metadata',{pinId,id:'source'});
  assert.deepEqual(metadata.snapshot,snapshot);
  assert.equal(metadata.value.metadata.sourceLength.bytes,Buffer.byteLength(original));
  assert.equal(metadata.value.metadata.sourceLength.utf16,original.length);
  assert.deepEqual(Object.keys(metadata.value.metadata.properties[0].value),['Title','title']);
  const heading=metadata.value.metadata.headings[0];
  assert.equal(heading.text,'😀 Heading');
  const headingByte=Buffer.byteLength(original.slice(0,original.indexOf('# 😀')));
  assert.equal(heading.range.bytes[0],headingByte);
  assert.equal(heading.range.utf16[0],original.indexOf('# 😀'));
  const oldRevision=metadata.value.entry.revision;
  const search=await call('search',{pinId,query:'needle',limit:1});
  assert.equal(search.result.value.hits.length,1);assert.ok(search.cursor);
  assert.deepEqual(search.result.snapshot,snapshot);
  const replay=await call('search',{pinId,query:'needle',limit:1});
  assert.equal(replay.cursor,search.cursor,'exact page retry reuses its native continuation');
  await assert.rejects(call('search',{pinId,query:'other',cursor:search.cursor,limit:1}),{code:'query_mismatch'});
  let cursor=null,edges=[];
  do{const page=await call('backlinks',{pinId,id:'target',cursor,limit:1});assert.deepEqual(page.result.snapshot,snapshot);assert.ok(page.result.value.edges.length<=1);edges.push(...page.result.value.edges);cursor=page.cursor;if(!cursor)assert.equal(page.result.value.complete,true);}while(cursor);
  assert.deepEqual(edges.map(edge=>edge.link.embed),[false,true,false]);
  assert.ok(edges.every(edge=>edge.source.id==='source'&&edge.source.revision===oldRevision));
  const base=await call('base',{pinId,id:'base',viewName:'Linked',options:{clockMs:0}});
  assert.deepEqual(base.snapshot,snapshot);assert.deepEqual(base.value.result.snapshotId,snapshot);
  assert.deepEqual(base.value.result.rows.map(row=>row.entryId),['source']);
  assert.equal(base.value.result.rows[0].values['config.TITLE'].value,'first');
  const staleStage=await other('begin');
  await cli(root,['write','--id','source','--expected-revision',oldRevision,'--operation-id','independent-write','--input','-'],'# Changed\nNo old links or literal text.\n');
  await assert.rejects(other('pump',{snapshot:staleStage.snapshot}),{code:'stale_source'});
  assert.equal(await other('discard',{snapshot:staleStage.snapshot}),true,'discard bypasses stale source/index publication fences');
  assert.equal(await other('discard',{snapshot:staleStage.snapshot}),true,'exact discarded-stage retry is idempotent');
  assert.deepEqual(await call('metadata',{pinId,id:'source'}),metadata,'current bodies cannot replace retained metadata');
  const next=await call('search',{pinId,query:'needle',cursor:search.cursor,limit:1});
  assert.equal(next.result.value.hits[0].entry.revision,oldRevision);
  assert.equal(next.result.value.hits[0].line,6);
  const nextSnapshot=await build(other);
  assert.notDeepEqual(nextSnapshot,snapshot);
  await assert.rejects(other('discard',{snapshot:nextSnapshot}),{code:'stale_index'});
  const newPin='1';await other('open',{pinId:newPin});
  const updated=await other('metadata',{pinId:newPin,id:'source'});
  assert.notEqual(updated.value.entry.revision,oldRevision);
  assert.deepEqual((await other('search',{pinId:newPin,query:'needle',limit:10})).result.value.hits,[]);
  await assert.rejects(other('search',{pinId:newPin,query:'needle',cursor:search.cursor,limit:1}),{code:'cursor_expired'});
  assert.deepEqual((await other('metadata',{pinId:newPin,id:'source'})).snapshot,nextSnapshot,'foreign cursor must not evict a valid pin');
  await other('close',{pinId:newPin});await other('close',{pinId:newPin});
  await call('close',{pinId});
  await assert.rejects(call('open',{pinId}),{code:'snapshot_expired'});
  // More than the former64-open cap: long sessions retain progress with a
  // constant-size monotonic replay floor and no leaked native pin quota.
  for(let sequence=6n;sequence<=75n;sequence++){
    const pinId=String(sequence);await call('open',{pinId});await call('close',{pinId});
  }
  await assert.rejects(call('open',{pinId:'2'}),{code:'snapshot_expired'});
  await call('open',{pinId:'76'});
  await first.release(()=>{});
  await assert.rejects(call('status'),{code:'client_not_admitted'});
  const reacquired=await admit('10000000-0000-4000-8000-000000000001');
  const again=(op,fields)=>reacquired.documentCommand(request(op,fields));
  await again('open',{pinId});
  await other('rebuild');
  await assert.rejects(again('metadata',{pinId,id:'source'}),{code:'snapshot_expired'});
  assert.equal(await again('close',{pinId}),true);
  await assert.rejects(again('open',{pinId}),{code:'snapshot_expired'});
});
