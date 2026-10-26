import assert from 'node:assert/strict';
import {until} from '../tasks-electron-integration/cdp.mjs';
import {auditSavedNote} from '../bases-electron-safety-integration/external-cli-conflict.mjs';
import {sourceDigest,assertPreparedInlineWrite,assertInlineCheckpointFailure,withDeniedOwnedVaultLock} from '../bases-electron-safety-integration/inline-checkpoint-fault.mjs';

/** Independent exact-byte oracle for this known fixture and one Board patch.
 * No product configuration writer or inferred first-write payload is used. */
export function columnOrderSource(source){
  assert.equal(typeof source,'string');assert.ok(Buffer.byteLength(source,'utf8')<=65536&&!source.includes('\r'),'Known Layouts fixture is bounded LF source');
  const names=[...source.matchAll(/^    name: Board$/gm)];assert.equal(names.length,1,'Exactly one independently named Board view');
  const name=names[0].index,start=source.lastIndexOf('\n  - ',name),next=source.indexOf('\n  - ',name);
  assert.ok(start>=0);const end=next<0?source.length:next,view=source.slice(start,end);
  assert.match(view,/^\n  - type: kanban\n    name: Board\n/);
  const orders=[...view.matchAll(/^    groupOrder:[^\n]*(?:\n      -[^\n]*)*/gm)];assert.equal(orders.length,1,'Exactly one known groupOrder field in Board');
  const old=orders[0][0];
  assert.ok(old==='    groupOrder:\n      - Done\n      - Todo\n      - Later'||/^    groupOrder: \[\s*Done,\s*Todo,\s*Later\s*\]$/.test(old),'Known prior Board order must be Done, Todo, Later');
  const offset=start+orders[0].index,desired='    groupOrder:\n      - Todo\n      - Done\n      - Later';
  return source.slice(0,offset)+desired+source.slice(offset+old.length);
}

/** Observe the ordinary title's value and its own fully mounted public mode. */
export function layoutNoteSurface(document,title){
  const panes=document.querySelectorAll('.pane.is-active');if(panes.length!==1)return false;
  const pane=panes[0],titles=pane.querySelectorAll('input.note-title'),tab=pane.querySelector('.tab.is-active');
  if(titles.length!==1||titles[0].value!==title||!titles[0].isConnected||!tab?.dataset.tabId)return false;
  const name=pane.querySelector('button[data-hotkey-command="toggle-reading"]')?.getAttribute('data-hotkey-name');
  const preview=pane.querySelector('.tab-view-content > .note-scroll > .markdown-preview'),editor=pane.querySelector('.tab-view-content > .note-scroll > .editor-host .cm-content[contenteditable="true"]');
  let mode;if(name==='Switch to Live Edit'&&preview?.isConnected&&!editor)mode='reading';else if(name==='Switch to reading view'&&editor?.isConnected&&!preview)mode='live';else return false;
  return {title,mode,tabId:tab.dataset.tabId,observedAt:Date.now()};
}

/** Read-only native checkpoint evidence replaces the retired localStorage path. */
export function assertLayoutCheckpointDraft(observation,{file,original,desired,before,held}){
  assert.deepEqual(observation.entry,before.entry,'The logical entry cannot advance during the failed checkpoint acknowledgement');assert.equal(observation.source,original);
  assert.equal(observation.checkpoints.length,1,'One running desktop note checkpoint');const head=observation.checkpoints[0],state=head.state;
  assert.equal(typeof held.clientId,'string');assert.ok(held.clientId);assert.equal(head.clientId,held.clientId,'The recovery checkpoint belongs to the actually prepared native client');
  assert.equal(state.version,1);
  assert.equal(state.base.entryId,before.entry.id);assert.equal(state.base.revision,before.entry.revision);assert.equal(state.base.path,file);assert.equal(state.base.content,original);assert.equal(state.draft,desired);assert.equal(state.conflict,false);
  const operation=state.operation;assert.ok(operation,'The ordinary native recovery checkpoint retains the original write');assert.equal(operation.content,desired);assert.equal(operation.plan.version,1);assert.equal(operation.plan.clientId,held.clientId);assert.equal(operation.plan.operationId,held.operationId);assert.equal(operation.plan.entryId,before.entry.id);assert.equal(operation.ref,undefined,'The failed first post-prepare CAS has not checkpointed its native reference');assert.equal(operation.pendingAck,undefined);
  const input=operation.input;assert.ok(input);assert.equal(input.operationId,held.operationId);assert.equal(input.path,file);assert.equal(input.expectedEntryId,before.entry.id);assert.equal(input.expectedRevision,before.entry.revision);assert.equal(input.expectedContent,original);assert.equal(input.content,desired);
  assert.ok(input.conditionalSavedSource?.captureId,'The original ordinary/configuration write retains its physical saved-source proof');assert.deepEqual(input.conditionalSavedSource.logicalWitness,{entryId:before.entry.id,revision:before.entry.revision,path:file});
  const plan=JSON.parse(operation.plan.encodedPlan);assert.equal(plan.source_capture,input.conditionalSavedSource.captureId);assert.equal(plan.operation_id,held.operationId);assert.deepEqual(plan.mutation,{type:'write',id:before.entry.id,expected:before.entry.revision});assert.equal(Buffer.from(plan.content_base64,'base64').toString('utf8'),desired);
  const matching=observation.intents.filter(intent=>intent.operationId===held.operationId);assert.equal(matching.length,1);assert.equal(matching[0].state,'prepared','The failed checkpoint cannot authorize its native intent');assert.equal(matching[0].acknowledged,false);
  return {key:'note/v1/'+before.entry.id,clientId:head.clientId,draft:{base:state.base.content,content:state.draft},checkpoint:state,intent:matching[0]};
}

/** Hold a genuine exact preparation, then deny only the owned checkpoint lock.
 * The caller retains its normal UI and source/preview/recovery assertions. */
export async function withLayoutCheckpointFailure(c,{file,original,desired,label,submit,verifyFailure}){
  assert.ok(c.relay,'Layouts fault cases require the approved real native relay');
  await c.saved(file,source=>assert.equal(source,original),label+'-original-physical-and-logical-source');
  const before=await auditSavedNote(c.vault,file);assert.equal(before.source,original);assert.equal(before.entry.path,file);assert.ok(before.entry.id&&before.entry.revision);
  const offset=(await c.relay.events()).length,token=await c.relay.arm({mode:'hold',phase:'prepared',path:file,entryId:before.entry.id,bodySha256:sourceDigest(desired)});
  let released=false,held,negative,recovery;
  try{
    await submit();
    held=await until(async()=>{const row=(await c.relay.events()).slice(offset).find(event=>event.kind==='held'&&event.token===token);assert.ok(row,'The exact intended layout mutation must reach inert native preparation');return row;},10000);
    assertPreparedInlineWrite(held,{file,entryId:before.entry.id,desired});assert.equal(await c.read(file),original);
    await withDeniedOwnedVaultLock({vault:c.vault,outputDirectory:c.outputDirectory,evidence:c.evidence,label},async()=>{
      await c.relay.release(token);released=true;
      await until(async()=>assert.ok((await c.relay.events()).some(event=>event.kind==='released'&&event.token===token)),3000);
      negative=await until(async()=>assertInlineCheckpointFailure((await c.relay.events()).slice(offset),held),10000);
      await verifyFailure();assert.equal(await c.read(file),original);
      recovery=assertLayoutCheckpointDraft(await auditSavedNote(c.vault,file),{file,original,desired,before,held});
    });
  }finally{if(!released)await c.relay.release(token);}
  await c.saved(file,source=>assert.equal(source,original),label+'-restored-original-physical-and-logical-source');
  assertLayoutCheckpointDraft(await auditSavedNote(c.vault,file),{file,original,desired,before,held});
  return {held,negative,recovery,offset};
}
