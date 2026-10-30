// Pure fixture/oracle validation only. No Native binary, CLI or app is executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {sceneName,memberInputs,expectedMemberSource,assertPublishedCollection,assertPublishedMember,validateScene,verifyPreparedSceneFiles,isSceneHelperInvocation} from './collection-scene.mjs';
import {recoverySources,fixtureFiles,collectionSceneFrame} from './campaign.mjs';
import {BaseDocument} from '../../src/bases/document.ts';
const collection={id:'abcdefghijkl',name:sceneName,revision:'schema-r1',deleted:false,properties:[{id:'mnopqrstuvwx',name:'score',datatype:'number',options:[]}]},field=collection.properties[0];
const member=spec=>({entryId:spec.entryId,collectionId:collection.id,revision:'member-'+spec.path,fileRevision:'file-'+spec.path,path:spec.path,values:{[field.id]:spec.score},deleted:false,pendingProjection:false});
const reply=entries=>({collections:[structuredClone(collection)],entries:structuredClone(entries),projection:{pending:0,issues:[]}});
function descriptor(){
  const operation=index=>`20000000-0000-4000-8000-${String(index).padStart(12,'0')}`;
  const command=(value,result)=>({command:value,reply:result,commandSha256:createHash('sha256').update(JSON.stringify({schemaVersion:1,command:value})).digest('hex')});
  return{version:1,kind:'native-collection-recovery-scene',collectionId:collection.id,scorePropertyId:field.id,collectionName:sceneName,
    members:memberInputs.map(spec=>({...member(spec),score:spec.score,source:expectedMemberSource(spec),readback:{entryId:spec.entryId,path:spec.path,revision:member(spec).fileRevision,bytes:Buffer.byteLength(expectedMemberSource(spec)),sha256:createHash('sha256').update(expectedMemberSource(spec)).digest('hex')}})),preparedFiles:memberInputs.map(spec=>[spec.path,expectedMemberSource(spec)]),
    commands:[command({op:'create',operationId:operation(1),name:sceneName,properties:[{name:'score',datatype:'number'}]},reply([])),...memberInputs.map((spec,index)=>command({op:'create_entry',operationId:operation(index+2),collectionId:collection.id,expectedCollectionRevision:collection.revision,entryId:spec.entryId,path:spec.path,body:spec.body,values:{[field.id]:spec.score}},reply([member(spec)]))),command({op:'get',collectionId:collection.id},reply(memberInputs.map(member)))],
    nativeProcess:{pid:12345,executable:'/illustrative/matched-host',args:['--vault','/illustrative/disposable/vault','--initialize-local'],closed:true,released:true,exitCode:0,signal:null}};
}

test('a verified scene retains returned schema identities, independent member bytes and no mutable authority',()=>{
  const input=descriptor(),scene=validateScene(input);assert.equal(scene.collectionId,collection.id);assert.equal(scene.scorePropertyId,field.id);assert.ok(Object.isFrozen(scene)&&Object.isFrozen(scene.members)&&Object.isFrozen(scene.commands[0].reply));assert.throws(()=>{scene.members[0].source='replacement';});
  assert.equal(expectedMemberSource(memberInputs[0]),'---\nkind: recovery\n"_id": "10000000-0000-4000-8000-000000000001"\n"_type": "Native recovery fixture"\n"score": 2\n---\nA body sentinel\n');
});

test('scene validation refuses pending publication, wrong membership/value, altered bytes and retained leases',()=>{
  for(const alter of [v=>v.members[0].pendingProjection=true,v=>v.members[0].collectionId='replacement1',v=>v.members[0].values[field.id]=99,v=>v.members[0].fileRevision=null,v=>v.members[0].source+='lost body',v=>v.preparedFiles[1]=v.preparedFiles[0],v=>v.preparedFiles[0][0]='../A.md',v=>v.lease={token:'forbidden'},v=>v.nativeProcess.exitCode=1,v=>v.nativeProcess.released=false,v=>v.commands[1].command.operationId='new-op',v=>v.commands[0].reply.projection.pending=1]){
    const value=descriptor();alter(value);assert.throws(()=>validateScene(value));
  }
});

test('public collection receipts must expose one numeric field and the exact published requested member',()=>{
  assert.deepEqual(assertPublishedCollection(reply([])),{collection,field});assert.deepEqual(assertPublishedMember(reply([member(memberInputs[0])]),collection,field,memberInputs[0]),member(memberInputs[0]));
  for(const alter of [v=>v.collections[0].properties[0].datatype='text',v=>v.collections[0].properties[0].id='chosen-by-fixture',v=>v.collections[0].deleted=true,v=>v.projection.issues.push({message:'not yet published'})]){const value=reply([]);alter(value);assert.throws(()=>assertPublishedCollection(value));}
});

test('collection source programs preserve independent complete A/B patches and sibling bytes',()=>{
  const scene=validateScene(descriptor()),sources=recoverySources(scene),files=fixtureFiles(scene);assert.equal(files.get('A.md'),expectedMemberSource(memberInputs[0]));assert.throws(()=>fixtureFiles(),/match|collectionId|undefined/);
  for(const [before,after,expression]of [[sources.summaryBase,sources.sourceA,'values.length'],[sources.summaryBase,sources.sourceB,'values.sum() + 7'],[sources.failedBase,sources.failedA,'values.length'],[sources.failedBase,sources.failedB,'values.sum() + 7']]){
    const doc=BaseDocument.parse(before);assert.equal(doc.views[0].source.id,collection.id);assert.deepEqual(doc.views[0].order,['file.name','note.'+field.id]);const sibling=doc.views[1]&&structuredClone(doc.views[1]);doc.editViewSummary(0,'Total','Total',expression);assert.equal(doc.toString(),after,'The independently authored whole-source oracle matches the real accepted transform');if(sibling)assert.deepEqual(doc.views[1],sibling);
  }
});

function frameDocument(){const dom=new JSDOM('<main class="bases-session" data-base-controller-error="false" data-base-controller-updating="false"><div class="collection-source-bar">Native recovery fixture</div><div class="bases-session-content" aria-busy="false"><div role="grid" aria-label="Failed summary" aria-rowcount="5"><div role="gridcell" data-path="A.md" data-property="note.mnopqrstuvwx">2</div><div role="gridcell" data-path="B.md" data-property="note.mnopqrstuvwx">3</div><div class="zorid-bases-table-new-row" role="row"><button>New page</button></div><div class="zorid-bases-table-footer" role="row"><span data-summary-property="note.mnopqrstuvwx"><span class="summary-function-name">Total</span><span class="summary-function-value">5</span></span></div></div></div></main>');return dom;}

test('pre-fault scene oracle refuses the observed Name-only vault scene and incomplete collection rows',()=>{
  const dom=frameDocument(),doc=dom.window.document,read=()=>collectionSceneFrame(doc,'.bases-session','note.'+field.id,'Failed summary');try{assert.equal(read().summary,'5');doc.querySelector('.zorid-bases-table-footer').remove();assert.equal(read(),false,'The actual fault010 missing footer must fail before arming');}finally{dom.window.close();}
  for(const alter of [doc=>doc.querySelector('[data-path="A.md"]').textContent='99',doc=>doc.querySelector('[role="grid"]').setAttribute('aria-rowcount','3'),doc=>doc.querySelector('.zorid-bases-table-new-row').hidden=true,doc=>doc.querySelector('.zorid-bases-table-footer').hidden=true,doc=>doc.querySelector('.bases-session').dataset.baseControllerError='true',doc=>doc.querySelector('.bases-session-content').setAttribute('aria-busy','true')]){const dom=frameDocument();try{alter(dom.window.document);assert.equal(collectionSceneFrame(dom.window.document,'.bases-session','note.'+field.id,'Failed summary'),false);}finally{dom.window.close();}}
});

test('prepared Native public files are verified without rewrite and reject unsafe, unknown or changed paths',async t=>{
  const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'zorid-prepared-native-scene-')));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const source=expectedMemberSource(memberInputs[0]);await fs.writeFile(path.join(directory,'A.md'),source);await fs.mkdir(path.join(directory,'Folder'));await fs.symlink(path.join(directory,'A.md'),path.join(directory,'Alias.md'));
  const fixtures=new Map([['A.md',source],['Ordinary.md','Ordinary'],['Alias.md',source],['Folder',source],['.zorid/private',source]]),before=await fs.stat(path.join(directory,'A.md'),{bigint:true});
  const accepted=await verifyPreparedSceneFiles(directory,fixtures,[['A.md',source]]);assert.equal(accepted.get('A.md'),source);const after=await fs.stat(path.join(directory,'A.md'),{bigint:true});assert.equal(after.ino,before.ino);assert.equal(after.mtimeNs,before.mtimeNs);assert.equal(after.size,BigInt(Buffer.byteLength(source)));
  for(const prepared of [[['A.md',source],['A.md',source]],[['Missing.md',source]],[['../A.md',source]],[[path.join(directory,'A.md'),source]],[['Alias.md',source]],[['Folder',source]],[['.zorid/private',source]],[['A.md',source+'changed']]])await assert.rejects(verifyPreparedSceneFiles(directory,fixtures,prepared));
  await fs.writeFile(path.join(directory,'A.md'),source+'external');await assert.rejects(verifyPreparedSceneFiles(directory,fixtures,[['A.md',source]]));
});

test('common-runner imports cannot enter the Native helper executable mode',()=>{
  const helper=new URL('./collection-scene.mjs',import.meta.url).pathname,runner=new URL('../bases-electron-integration/run.mjs',import.meta.url).pathname;
  assert.equal(isSceneHelperInvocation([process.execPath,helper,'--public-native-scene']),true);
  assert.equal(isSceneHelperInvocation([process.execPath,runner,'--public-native-scene']),false);assert.equal(isSceneHelperInvocation([process.execPath,helper,'--root']),false);assert.equal(isSceneHelperInvocation([process.execPath]),false);
});
