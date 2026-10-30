// Prelaunch fixture authority only. The real public Native collection API owns
// membership, schema IDs, projection and source revisions. No private DB writes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {readFixture,writeFixture,validateFixtureName} from '../bases-electron-integration/owned-fixtures.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const helper=fileURLToPath(import.meta.url),schemaId=value=>assert.match(value,/^[0-9a-z]{12}$/);
export const sceneName='Native recovery fixture';
export const memberInputs=Object.freeze([
  Object.freeze({path:'A.md',entryId:'10000000-0000-4000-8000-000000000001',score:2,body:'---\nkind: recovery\n---\nA body sentinel\n'}),
  Object.freeze({path:'B.md',entryId:'10000000-0000-4000-8000-000000000002',score:3,body:'---\nkind: recovery\n---\nB body sentinel\n'}),
]);
export function expectedMemberSource(member){
  assert.ok(memberInputs.includes(member),'Only the independently authored fixture members are admitted');
  return `---\nkind: recovery\n"_id": ${JSON.stringify(member.entryId)}\n"_type": ${JSON.stringify(sceneName)}\n"score": ${member.score}\n---\n${member.path==='A.md'?'A':'B'} body sentinel\n`;
}
export function assertPublishedCollection(reply){
  assert.deepEqual(reply.projection,{pending:0,issues:[]},'Fixture setup requires completed physical publication');
  assert.equal(reply.collections.length,1);const collection=reply.collections[0];schemaId(collection.id);assert.equal(collection.name,sceneName);assert.equal(collection.deleted,false);assert.equal(collection.properties.length,1);
  const field=collection.properties[0];schemaId(field.id);assert.equal(field.name,'score');assert.equal(field.datatype,'number');assert.deepEqual(field.options,[]);assert.equal(typeof collection.revision,'string');assert.ok(collection.revision);
  return{collection,field};
}
export function assertPublishedMember(reply,collection,field,member){
  const current=reply.entries.find(row=>row.entryId===member.entryId);assert.ok(current,'The exact requested member must be returned');
  assert.equal(current.collectionId,collection.id);assert.equal(current.path,member.path);assert.equal(current.deleted,false);assert.equal(current.pendingProjection,false);assert.deepEqual(current.values,{[field.id]:member.score});assert.equal(typeof current.revision,'string');assert.ok(current.revision);assert.equal(typeof current.fileRevision,'string');assert.ok(current.fileRevision);assert.ok(!current.problems||!Object.keys(current.problems).length);
  return current;
}
function freeze(value){if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
export function validateScene(input){
  assert.equal(input?.version,1);assert.equal(input.kind,'native-collection-recovery-scene');schemaId(input.collectionId);schemaId(input.scorePropertyId);assert.equal(input.collectionName,sceneName);assert.equal(input.members.length,2);assert.equal(input.preparedFiles.length,2);
  for(const member of memberInputs){const actual=input.members.find(row=>row.entryId===member.entryId);assert.ok(actual);assert.equal(actual.path,member.path);assert.equal(actual.score,member.score);assert.equal(actual.collectionId,input.collectionId);assert.equal(actual.deleted,false);assert.equal(actual.pendingProjection,false);assert.deepEqual(actual.values,{[input.scorePropertyId]:member.score});assert.ok(actual.revision&&actual.fileRevision);assert.equal(actual.source,expectedMemberSource(member));assert.deepEqual(actual.readback,{entryId:member.entryId,path:member.path,revision:actual.fileRevision,bytes:Buffer.byteLength(expectedMemberSource(member)),sha256:hash(expectedMemberSource(member))});assert.deepEqual(input.preparedFiles.find(([name])=>name===member.path),[member.path,expectedMemberSource(member)]);}
  assert.deepEqual(input.commands.map(row=>row.command.op),['create','create_entry','create_entry','get']);const created=assertPublishedCollection(input.commands[0].reply);assert.equal(created.collection.id,input.collectionId);assert.equal(created.field.id,input.scorePropertyId);assert.deepEqual(input.commands[0].command,{op:'create',operationId:input.commands[0].command.operationId,name:sceneName,properties:[{name:'score',datatype:'number'}]});assert.equal(new Set(input.commands.slice(0,3).map(row=>row.command.operationId)).size,3);
  for(let index=0;index<2;index++){const member=memberInputs[index],record=input.commands[index+1];assert.deepEqual(record.command,{op:'create_entry',operationId:record.command.operationId,collectionId:input.collectionId,expectedCollectionRevision:created.collection.revision,entryId:member.entryId,path:member.path,body:member.body,values:{[input.scorePropertyId]:member.score}});assertPublishedMember(record.reply,created.collection,created.field,member);}
  for(const record of input.commands){assert.equal(record.commandSha256,hash(JSON.stringify({schemaVersion:1,command:record.command})));if(record.command.operationId)assert.match(record.command.operationId,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);assertPublishedCollection(record.reply);}
  const final=input.commands[3];assert.deepEqual(final.command,{op:'get',collectionId:input.collectionId});assert.equal(final.reply.entries.length,2);for(const member of memberInputs){const saved=assertPublishedMember(final.reply,created.collection,created.field,member),selected=input.members.find(row=>row.entryId===member.entryId);assert.equal(saved.revision,selected.revision);assert.equal(saved.fileRevision,selected.fileRevision);}
  const noLease=value=>{if(value&&typeof value==='object')for(const[key,child]of Object.entries(value)){assert.ok(!['lease','token','clientId','client_id','reference'].includes(key),'Scene descriptors never retain lease authority');noLease(child);}};noLease(input);
  assert.ok(Number.isSafeInteger(input.nativeProcess.pid)&&input.nativeProcess.pid>0);assert.ok(path.isAbsolute(input.nativeProcess.executable));assert.equal(input.nativeProcess.exitCode,0);assert.equal(input.nativeProcess.signal,null);assert.equal(input.nativeProcess.closed,true);assert.equal(input.nativeProcess.released,true);
  return freeze(input);
}
/** Read-only admission of public notes already authored by the real Native
 * setup. The runner must omit these paths from its ordinary fixture writes. */
export async function verifyPreparedSceneFiles(vault,fixtures,prepared){
  assert.ok(Array.isArray(prepared)&&prepared.length<=16,'Bounded prepared Native fixture paths');const result=new Map();
  for(const pair of prepared){
    assert.ok(Array.isArray(pair)&&pair.length===2);const[file,expected]=pair;validateFixtureName(file);assert.ok(!file.startsWith('.zorid/'),'Prepared public notes cannot name private storage');assert.ok(!result.has(file),'Duplicate prepared Native fixture path');assert.ok(fixtures.has(file),'Unknown prepared Native fixture path');assert.equal(typeof expected,'string');assert.equal(fixtures.get(file),expected,'Prepared bytes must equal the independent fixture expectation');assert.equal(await readFixture(vault,file),expected,'Native-created fixture bytes changed before launch');result.set(file,expected);
  }
  return result;
}
async function ownedDirectories({vault,localData,outputDirectory}){
  const out=await fs.realpath(outputDirectory),canonical=await fs.realpath(vault),data=await fs.realpath(localData);
  assert.equal(canonical,path.join(out,'disposable','bases-native-recovery'));assert.equal(data,path.join(out,'disposable','app-data'));
  for(const directory of [out,path.join(out,'disposable'),canonical,data]){const stat=await fs.lstat(directory);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink());assert.equal(await fs.realpath(directory),directory);}
  return{out,vault:canonical,localData:data};
}
async function runPublicNative({native,root,vault,localData,outputDirectory,nativeSha256}){
  const owned=await ownedDirectories({vault,localData,outputDirectory});assert.equal(process.env.ZORID_LOCAL_DATA_DIR,owned.localData);assert.deepEqual(await fs.readdir(owned.vault),[],'A prelaunch collection may only be created in this fresh empty fixture vault');
  assert.equal(await fs.realpath(native),native);assert.equal(hash(await fs.readFile(native)),nativeSha256);
  const {RustVaultService}=createRequire(path.join(root,'package.json'))(path.join(root,'desktop/rust-vault-service.cjs'));
  let service,lease,cancelled=false,nativeProcess;const commands=[],members=[];let result,failure,released=false;const processProof='collection-scene-native-process.json';
  const stop=()=>{cancelled=true;service?.abort(Object.assign(new Error('Prelaunch fixture cancelled'),{code:'fixture_cancelled'}));};process.on('SIGTERM',stop);
  const check=()=>{if(cancelled)throw new Error('The owned prelaunch fixture was cancelled');};
  const deadline=setTimeout(stop,45000);
  try{
    service=await RustVaultService.open(owned.vault,{executable:native,initializeLocal:true,timeoutMs:5000});nativeProcess={pid:service.child.pid,executable:native,args:['--vault',owned.vault,'--initialize-local'],closed:false,released:false,exitCode:null,signal:null};await assert.rejects(fs.stat(path.join(owned.out,processProof)),error=>error.code==='ENOENT');await writeFixture(owned.out,processProof,JSON.stringify(nativeProcess));check();assert.ok(service.capabilities.includes('databases'));
    const clientId=randomUUID();lease=await service.claimClient(clientId);check();const api=service.withClientLease(lease,check);
    const request=async command=>{check();const envelope={schemaVersion:1,command};const reply=await api.databaseCommand(clientId,envelope);check();commands.push({command:structuredClone(command),commandSha256:hash(JSON.stringify(envelope)),reply:structuredClone(reply)});return reply;};
    const created=await request({op:'create',operationId:randomUUID(),name:sceneName,properties:[{name:'score',datatype:'number'}]}),{collection,field}=assertPublishedCollection(created);assert.deepEqual(created.entries,[]);
    for(const member of memberInputs){
      const reply=await request({op:'create_entry',operationId:randomUUID(),collectionId:collection.id,expectedCollectionRevision:collection.revision,entryId:member.entryId,path:member.path,body:member.body,values:{[field.id]:member.score}});
      const current=assertPublishedMember(reply,collection,field,member);assertPublishedCollection(reply);
      const read=await api.readPath(member.path),byId=await api.readEntryById(member.entryId),stat=await api.readMetadata(member.path);check();assert.ok(read?.entry);assert.deepEqual(byId.entry,read.entry);assert.deepEqual(stat?.entry,read.entry);assert.equal(stat.presentation.size_bytes,Buffer.byteLength(expectedMemberSource(member)));assert.equal(Buffer.from(byId.bytes).toString('utf8'),expectedMemberSource(member));assert.equal(read.entry.id,member.entryId);assert.equal(read.entry.path,member.path);assert.equal(read.entry.revision,current.fileRevision);assert.equal(read.entry.deleted,false);assert.equal(Buffer.from(read.bytes).toString('utf8'),expectedMemberSource(member));assert.equal(await readFixture(owned.vault,member.path),expectedMemberSource(member));
      members.push({...current,score:member.score,source:expectedMemberSource(member),readback:{entryId:read.entry.id,path:read.entry.path,revision:read.entry.revision,bytes:read.bytes.length,sha256:hash(Buffer.from(read.bytes))}});
    }
    const final=await request({op:'get',collectionId:collection.id});assertPublishedCollection(final);assert.equal(final.entries.length,2);for(const member of memberInputs)assertPublishedMember(final,collection,field,member);
    result={version:1,kind:'native-collection-recovery-scene',collectionId:collection.id,scorePropertyId:field.id,collectionName:sceneName,members,preparedFiles:memberInputs.map(member=>[member.path,expectedMemberSource(member)]),commands,nativeProcess};
  }catch(error){failure=error;}
  finally{
    try{if(service){try{if(lease&&!service.fatal&&!service.exited){await service.releaseClient(lease);released=true;}}catch(error){failure??=error;}finally{await service.close();}assert.equal(service.child.exitCode,0,'Prelaunch Native must exit normally');assert.equal(service.child.signalCode,null);Object.assign(nativeProcess,{closed:true,released,exitCode:service.child.exitCode,signal:service.child.signalCode});}}
    catch(error){failure??=error;}
    if(nativeProcess){Object.assign(nativeProcess,{closed:service.exited,released,exitCode:service.child.exitCode,signal:service.child.signalCode});await writeFixture(owned.out,processProof,JSON.stringify(nativeProcess));}
    clearTimeout(deadline);process.removeListener('SIGTERM',stop);
  }
  if(failure)throw failure;return validateScene(result);
}
function ownedGroup(pid,native,vault){
  const rows=execFileSync('/bin/ps',['-ww','-axo','pid=,pgid=,command='],{encoding:'utf8'}).split('\n').flatMap(line=>{const match=line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return match&&Number(match[2])===pid?[{pid:Number(match[1]),command:match[3]}]:[];});
  for(const row of rows)assert.ok(row.command===`${native} --vault ${vault} --initialize-local`||row.command.startsWith(`${process.execPath} ${helper} --public-native-scene `),'Unexpected process cannot be cleaned as a fixture child');return rows;
}
export async function prepareScene({native,root,vault,localData,outputDirectory,evidence,nativeSha256}){
  const owned=await ownedDirectories({vault,localData,outputDirectory});assert.match(nativeSha256,/^[a-f0-9]{64}$/);
  const env={...process.env,ZORID_LOCAL_DATA_DIR:owned.localData};for(const key of ['ELECTRON_RUN_AS_NODE','ZORID_DESKTOP_HOST_BIN','ZORID_DEV_URL','ZORID_DESKTOP_FAMILY_FIXTURE','ZORID_FIXTURE_VAULT','ZORID_FIXTURE_SYNC_CONFIG','ZORID_FIXTURE_CLIENT_ID'])delete env[key];
  const argv=[helper,'--public-native-scene',native,root,owned.vault,owned.localData,owned.out,nativeSha256],child=spawn(process.execPath,argv,{env,stdio:['ignore','pipe','pipe'],detached:true}),stdout=[],stderr=[];
  let size=0,timedOut=false,closeTimer;const timer=setTimeout(()=>{timedOut=true;process.kill(-child.pid,'SIGTERM');closeTimer=setTimeout(()=>{try{if(ownedGroup(child.pid,native,owned.vault).length)process.kill(-child.pid,'SIGKILL');}catch{}},6000);},60000);
  child.stdout.on('data',bytes=>{size+=bytes.length;if(size<=1024*1024)stdout.push(bytes);else{timedOut=true;process.kill(-child.pid,'SIGTERM');}});child.stderr.on('data',bytes=>{if(Buffer.concat(stderr).length<65536)stderr.push(bytes);});
  const closed=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));}).finally(()=>{clearTimeout(timer);clearTimeout(closeTimer);});
  const record={kind:'prelaunch-public-native-collection-fixture',helper:process.execPath,argv,pid:child.pid,exitCode:closed.code,signal:closed.signal,stdoutSha256:hash(Buffer.concat(stdout)),stderr:Buffer.concat(stderr).toString('utf8'),timedOut};(evidence.fixtureSetup??=[]).push(record);
  record.nativeProcess=await readFixture(owned.out,'collection-scene-native-process.json').then(JSON.parse,error=>({unavailable:error.code??String(error.message)}));
  const leftovers=ownedGroup(child.pid,native,owned.vault);if(leftovers.length){record.leaked=leftovers;process.kill(-child.pid,'SIGTERM');const wait=async()=>{for(let n=0;n<60;n++){if(!ownedGroup(child.pid,native,owned.vault).length)return;await new Promise(resolve=>setTimeout(resolve,50));}};await wait();if(ownedGroup(child.pid,native,owned.vault).length){process.kill(-child.pid,'SIGKILL');await wait();}record.remaining=ownedGroup(child.pid,native,owned.vault);assert.deepEqual(record.remaining,[],'Owned prelaunch Native cleanup must be observed');throw new Error('Prelaunch fixture left an owned Native process; cleaned, acceptance fails');}
  assert.equal(timedOut,false,'Prelaunch fixture exceeded its bounded process budget');assert.equal(closed.code,0,record.stderr);assert.equal(closed.signal,null);assert.equal(size<=1024*1024,true);const scene=validateScene(JSON.parse(Buffer.concat(stdout).toString('utf8')));assert.equal(scene.nativeProcess.executable,native);assert.deepEqual(scene.nativeProcess.args,['--vault',owned.vault,'--initialize-local']);assert.deepEqual(record.nativeProcess,scene.nativeProcess);record.scene=scene;return scene;
}
export function isSceneHelperInvocation(argv){return typeof argv[1]==='string'&&path.resolve(argv[1])===helper&&argv[2]==='--public-native-scene';}
if(isSceneHelperInvocation(process.argv)){
  const [native,root,vault,localData,outputDirectory,nativeSha256]=process.argv.slice(3);runPublicNative({native,root,vault,localData,outputDirectory,nativeSha256}).then(scene=>{process.stdout.write(JSON.stringify(scene)+'\n');},error=>{process.stderr.write(String(error.stack??error)+'\n');process.exitCode=1;});
}
