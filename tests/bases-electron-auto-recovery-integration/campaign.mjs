import assert from 'node:assert/strict';
import {BaseDocument} from '../../src/bases/document.ts';
import {delay,until} from '../tasks-electron-integration/cdp.mjs';
import {recoverySources,collectionSceneFrame} from '../bases-electron-recovery-integration/campaign.mjs';
import {memberInputs,expectedMemberSource} from '../bases-electron-recovery-integration/collection-scene.mjs';
import {captureFocusedSummaryInput,continueFocusedSummaryInput,disposeFocusedSummaryInput,summaryEditor} from '../bases-electron-recovery-integration/focused-summary-input.mjs';
import {acquireSqliteWriter} from './sqlite-writer-fault.mjs';
import {startQuietRecovery,finishQuietRecovery} from './quiet-observer.mjs';
import {sha256,sanitized,assertOriginalPreparation,assertBusyCheckpoint,assertAutomaticCompletion,assertFreshAdmission,assertNoNewAuthoring,assertActualLeasedRequests,assertRealHeldChildLoss} from './oracles.mjs';
export {prepareScene} from '../bases-electron-recovery-integration/collection-scene.mjs';
export {createNativeRelay} from '../bases-electron-recovery-integration/control.mjs';
export {sanitized as sanitizeRelayEvents} from './oracles.mjs';
export const vaultName='bases-native-recovery';
const active='.pane.is-active .bases-session',panel='[role="dialog"][aria-label="Edit summary"]',expression=`${panel} [aria-label="Summary expression"]`;
const phases=Object.freeze([{kind:'busy',file:'AutoBusy.base',view:'AutoBusy'},{kind:'host',file:'AutoHost.base',view:'AutoHost'}]);
export function autoSources(scene,view){
  assert.ok(phases.some(phase=>phase.view===view));const original=recoverySources(scene).failedBase.replace('name: Failed summary','name: '+view);
  return Object.freeze({original,accepted:original.replace('Total: values.sum()','Total: values.length'),newer:original.replace('Total: values.sum()','Total: values.sum() + 7'),scoreProperty:'note.'+scene.scorePropertyId});
}
export function fixtureFiles(scene){return new Map([...phases.map(phase=>[phase.file,autoSources(scene,phase.view).original]),...memberInputs.map(member=>[member.path,expectedMemberSource(member)]),['Unrelated.md','Unrelated whole-file sentinel 😀\n']]);}
async function registry(c){const observed=await c.observeNativeGenerations();assert.ok(Array.isArray(observed.generations));return observed;}
async function realEvent(c,kind,token){return until(async()=>{await registry(c);const event=(await c.relay.events()).find(event=>event.kind===kind&&event.token===token);assert.ok(event);return event;},10000);}
async function identity(c,selector){const {root}=await c.cdp.call('DOM.getDocument',{depth:0});const {nodeId}=await c.cdp.call('DOM.querySelector',{nodeId:root.nodeId,selector});assert.ok(nodeId);return(await c.cdp.call('DOM.describeNode',{nodeId})).node.backendNodeId;}
async function frame(c){const {frameTree}=await c.cdp.call('Page.getFrameTree');return{id:frameTree.frame.id,loaderId:frameTree.frame.loaderId,url:frameTree.frame.url};}
async function bridge(c,file){return c.cdp.evaluate(`(async()=>{const v=await window.zorid.getVault();return{source:await window.zorid.read(v.path,${JSON.stringify(file)}),stat:await window.zorid.stat(v.path,${JSON.stringify(file)})};})()`);}
async function exact(c,file,expected,entryId,label){
  await until(async()=>{assert.equal(await c.read(file),expected);return true;},45000);const normal=await bridge(c,file);assert.equal(normal.source,expected);if(entryId)assert.equal(normal.stat.entryId,entryId);
  c.evidence.checks.push({name:label,file,entryId:normal.stat.entryId,revision:normal.stat.revision,sha256:sha256(expected),bytes:Buffer.byteLength(expected)});return normal.stat;
}
async function summary(c){return c.ui.dom(`const roots=[...document.querySelectorAll(${JSON.stringify(panel)})];if(roots.length!==1)return null;const p=roots[0],input=p.querySelector('textarea[aria-label="Summary expression"]'),visible=p.querySelector(${JSON.stringify(summaryEditor)}),base=document.querySelector(${JSON.stringify(active)}),selection=document.getSelection();const position=(node,offset)=>{if(!visible?.contains(node))return null;const range=document.createRange();range.selectNodeContents(visible);range.setEnd(node,offset);return range.toString().length;};return{focused:document.activeElement===visible,selection:selection?{anchor:position(selection.anchorNode,selection.anchorOffset),head:position(selection.focusNode,selection.focusOffset)}:null,busy:p.getAttribute('aria-busy'),raw:input?.value,displayed:visible?.textContent,disabled:input?.disabled,readonly:visible?.getAttribute('aria-readonly'),selectedView:base?.querySelector('.bases-toolbar-tab[aria-selected="true"]')?.getAttribute('aria-label'),error:!!p.querySelector('[role="alert"]')?.textContent?.trim(),footer:base?.querySelector('.summary-function-value')?.textContent};`);}
async function onePhase(c,phase,fixtures){
  const sources=autoSources(c.fixtureScene,phase.view);
  await c.launch('automatic-'+phase.kind);await c.ui.openFile(phase.file);await c.ui.idle();
  await c.ui.wait(`return (${collectionSceneFrame.toString()})(document,${JSON.stringify(active)},${JSON.stringify(sources.scoreProperty)},${JSON.stringify(phase.view)});`,'Real collection-backed A/B scores and Total5 before automatic fault',45000);
  const before=await exact(c,phase.file,sources.original,undefined,'automatic-'+phase.kind+'-independent-original-source');assert.ok(before.entryId&&before.revision);
  const initialRegistry=await registry(c),generation=initialRegistry.current;assert.ok(generation?.authenticatedAtLaunch);const documentFrame=await frame(c),originalCdp=c.cdp,appPid=generation.appPid;
  await c.ui.click(`${active} .zorid-bases-table-footer [data-summary-property=${JSON.stringify(sources.scoreProperty)}]`);await c.ui.button('Edit Total','.zorid-bases-summary-picker');
  const baseline=await c.relay.events(),offset=baseline.length;let quiet,focused,writer,held,checkpoint,fault,closedWriter,quietResult,token;
  try{
    const originalClaim=baseline.filter(event=>event.kind==='native-admission-response'&&event.ok&&event.generation===generation.generation).at(-1);assert.ok(originalClaim);quiet=await startQuietRecovery(c,{kind:phase.kind,path:phase.file,entryId:before.entryId,claim:originalClaim});focused=await captureFocusedSummaryInput(c,phase.view);
    token=await c.relay.arm({mode:'hold',phase:'prepared',path:phase.file,entryId:before.entryId,bodySha256:sha256(sources.accepted)});
    await c.ui.type(expression,'values.length');held=await realEvent(c,'held',token);assert.equal(held.generation,generation.generation);assert.equal(held.nativePid,generation.nativePid);assert.equal(held.relayPid,generation.relayPid);assert.equal(held.phase,'prepared');assert.equal(held.nativeState,'prepared');
    assert.equal(await c.read(phase.file),sources.original,'An inert A prepare is not a source commit');
    await c.ui.wait(`return document.querySelector(${JSON.stringify(panel)})?.getAttribute('aria-busy')==='true';`,'Original accepted A remains pending');
    await continueFocusedSummaryInput(c,focused,'values.sum() + 7','values.length');await delay(300);
    const pending=await summary(c);assert.equal(pending.raw,'values.sum() + 7');assert.equal(pending.displayed,pending.raw);assert.equal(pending.busy,'true');assert.equal(pending.focused,true);assert.ok(pending.selection?.anchor!==null&&pending.selection?.head!==null);assert.equal(await identity(c,`${panel} ${summaryEditor}`),focused.editorBackendNodeId);assert.equal(await identity(c,panel),focused.panelBackendNodeId);assert.equal(await c.read(phase.file),sources.original);
    assertOriginalPreparation(await c.relay.events(),{held,path:phase.file,entryId:before.entryId,revision:before.revision,source:sources.original,accepted:sources.accepted});
    // No further editing, pointer input, Save, blur, reload or recovery API is
    // permitted until the automatic-recovery interval is independently sealed.
    focused.disposed=true;await disposeFocusedSummaryInput(c,focused);
    if(phase.kind==='busy'){
      writer=await acquireSqliteWriter({vault:c.vault,outputDirectory:c.outputDirectory,evidence:c.evidence});const acquiredAt=Date.now();c.evidence.actions.push({action:'owned-existing-sqlite-BEGIN-IMMEDIATE-acquired',at:acquiredAt,pid:writer.evidence.pid,database:writer.evidence.database});
      try{await c.relay.release(token);await realEvent(c,'released',token);checkpoint=await until(async()=>{await registry(c);const result=assertBusyCheckpoint((await c.relay.events()).slice(offset),{held,key:'note/v1/'+before.entryId});assert.ok(result);assert.ok(result.request.at>=acquiredAt);return result;},10000);}
      finally{closedWriter=await writer.release();writer=undefined;c.evidence.actions.push({action:'owned-sqlite-ROLLBACK-and-normal-close',at:Date.now(),pid:closedWriter.pid,exitCode:closedWriter.exitCode,signal:closedWriter.signal});}
    }else{
      const current=(await registry(c)).current;assert.ok(current);assert.equal(current.generation,held.generation);assert.equal(current.appPid,appPid);assert.equal(current.nativePid,held.nativePid);assert.equal(current.relayPid,held.relayPid);
      fault=await c.killNativeGeneration(current.generation);assert.equal(fault.generation,current.generation);assert.equal(fault.appPid,appPid);assert.equal(fault.nativePid,current.nativePid);assert.equal(fault.relayPid,current.relayPid);assert.equal(fault.signal,'SIGKILL');
    }
    await until(async()=>{await registry(c);assert.equal(c.cdp,originalCdp);assert.equal(await c.read(phase.file),sources.accepted);const state=await summary(c);assert.ok(state&&state.busy==='false'&&!state.disabled&&state.readonly==='false'&&state.raw==='values.sum() + 7'&&state.displayed===state.raw&&!state.error&&state.selectedView===phase.view+' view');return true;},45000);
    await delay(350);const state=await summary(c);assert.equal(state.raw,'values.sum() + 7');assert.equal(state.displayed,state.raw);assert.equal(state.busy,'false');assert.equal(state.focused,pending.focused);assert.deepEqual(state.selection,pending.selection,'Automatic restoration preserves the original raw B selection');assert.equal(state.selectedView,phase.view+' view');assert.equal(state.footer,'2');
    await exact(c,phase.file,sources.accepted,before.entryId,'automatic-'+phase.kind+'-original-A-ACK-and-passive-raw-B');assert.deepEqual(await frame(c),documentFrame,'Same app/CDP document must recover without reload or navigation');
    const finalRegistry=await registry(c),current=finalRegistry.current;assert.ok(current?.authenticatedAtLaunch);assert.equal(current.appPid,appPid);
    const full=await c.relay.events(),during=full.slice(offset);assert.deepEqual(during.filter(event=>['watchdog-released','relay-failed'].includes(event.kind)),[]);
    assertActualLeasedRequests(full,{held,key:'note/v1/'+before.entryId,requests:during});const prepare=assertOriginalPreparation(full,{held,path:phase.file,entryId:before.entryId,revision:before.revision,source:sources.original,accepted:sources.accepted});
    if(checkpoint)assertBusyCheckpoint(during,{held,key:'note/v1/'+before.entryId});const commit=assertAutomaticCompletion(during,{held,entryId:before.entryId,accepted:sources.accepted,newer:sources.newer,checkpoint});assert.equal(commit.nativePid,current.nativePid);assert.equal(commit.relayPid,current.relayPid);assertNoNewAuthoring(during,{held,prepare,newer:sources.newer,baseline});
    let admission;if(phase.kind==='host'){admission=assertFreshAdmission(full,generation.generation,{prepare,held,commit,killedAt:fault.at});assert.equal(current.generation,admission.after.generation);assertRealHeldChildLoss(full,{held,fault,admission});}else{assert.equal(current.generation,generation.generation);assert.equal(await identity(c,panel),focused.panelBackendNodeId);assert.equal(await identity(c,`${panel} ${summaryEditor}`),focused.editorBackendNodeId);}
    for(const[file,source]of fixtures)assert.equal(await c.read(file),file===phase.file?sources.accepted:source,'Whole unrelated fixture/sibling source remains exact');
    const document=BaseDocument.parse(sources.accepted);assert.equal(document.views[0].id,'aaaaaaaaaaaa');assert.deepEqual(document.views[1],BaseDocument.parse(sources.original).views[1]);
    const presentation={originalPanelBackendNodeId:focused.panelBackendNodeId,originalEditorBackendNodeId:focused.editorBackendNodeId,panelBackendNodeId:await identity(c,panel),editorBackendNodeId:await identity(c,`${panel} ${summaryEditor}`)};presentation.rebuilt=presentation.originalPanelBackendNodeId!==presentation.panelBackendNodeId||presentation.originalEditorBackendNodeId!==presentation.editorBackendNodeId;
    const finishing=quiet;quiet=undefined;quietResult=await finishQuietRecovery(c,finishing);
    c.evidence.checks.push({name:'sealed-automatic-'+phase.kind+'-original-A-newer-unsubmitted-B',entryId:before.entryId,sourceSha256:sha256(sources.original),acceptedSha256:sha256(sources.accepted),newerRawSha256:sha256('values.sum() + 7'),held:sanitized([held])[0],events:sanitized(during),admission:admission?sanitized([admission.before,admission.after]):undefined,fault,checkpoint:checkpoint?sanitized([checkpoint.failure,checkpoint.request]):undefined,closedWriter,presentation,quiet:quietResult,saveCommands:0,blurRecoveryActions:0,reloads:0,navigationActions:0,newerBPrepareOrCommit:0});
  }finally{
    try{if(writer)await writer.release();}finally{try{if(focused&&!focused.disposed){focused.disposed=true;await disposeFocusedSummaryInput(c,focused);}}finally{if(quiet){const finishing=quiet;quiet=undefined;await finishQuietRecovery(c,finishing);}}}
  }
  // Recovery is sealed above with B still RAM-only. This separate real user
  // action authors B only after A ACK, allowing a normal app/native shutdown.
  await c.ui.click(`${panel} ${summaryEditor}`);await c.ui.key('Tab');await exact(c,phase.file,sources.newer,before.entryId,'post-seal-explicit-new-B-authoring-for-normal-cleanup');
  await c.ui.wait(`const p=document.querySelector(${JSON.stringify(panel)});return !p||p.getAttribute('aria-busy')==='false';`,'Post-seal ordinary B commit acknowledged');
  const after=await c.relay.events(),bWrites=after.filter(event=>event.kind==='native-prepared-write'&&event.entryId===before.entryId&&event.bodySha256===sha256(sources.newer));assert.equal(bWrites.length,1);assert.notEqual(bWrites[0].operationId,held.operationId);
  const bCommit=after.filter(event=>event.kind==='native-mutation-response'&&event.method==='commit_intent'&&event.ok&&event.state==='committed'&&event.operationId===bWrites[0].operationId);assert.equal(bCommit.length,1);assert.equal(bCommit[0].referenceTokenSha256,bWrites[0].nativeIntentTokenSha256);
  c.evidence.checks.push({name:'post-seal-explicit-B-is-a-new-ordinary-operation',events:sanitized([...bWrites,...bCommit]),scope:'Not part of automatic recovery; B was independently proven unsubmitted before this input'});
  fixtures.set(phase.file,sources.newer);
  await c.quit('automatic-'+phase.kind+'-normal-quit-after-separate-B-authoring');
}
export async function journey(c){
  assert.ok(c.relay&&c.observeNativeGenerations&&c.killNativeGeneration,'Exact reviewed relay and generation ownership APIs required');
  c.evidence.limitations.push('Two authored actual-fault scenarios: real SQLite writer contention and genuine authenticated Native SIGKILL/EOF with automatic same-scope admission. Passing pure helpers is not packaged Native acceptance. A newer raw B is RAM custody, not claimed crash-durable. Post-seal explicit Tab B authoring is a separate user action, never recovery authorization.');
  const fixtures=fixtureFiles(c.fixtureScene);for(const phase of phases)await onePhase(c,phase,fixtures);
}
