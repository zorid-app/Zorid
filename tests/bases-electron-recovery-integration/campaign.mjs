import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {delay,until} from '../tasks-electron-integration/cdp.mjs';
import {digest} from './protocol.mjs';
import {terminalLockCheckpointFailure} from './terminal-checkpoint-failure.mjs';
import {captureFocusedSummaryInput,continueFocusedSummaryInput,disposeFocusedSummaryInput,summaryEditor} from './focused-summary-input.mjs';
import {assertAutomaticLostCreateReplay} from './lost-create-auto.mjs';
import {captureLostCreateUi,lostCreateUiFrame,disposeLostCreateUi} from './lost-create-ui.mjs';
export {createNativeRelay} from './control.mjs';

export const vaultName='bases-native-recovery';
export const template='\uFEFF---\r\nstatus: Template\r\nliteral: "{{date}}"\r\n---\r\n# {{title}}\r\nExact copy 😀\r\n';
export {prepareScene} from './collection-scene.mjs';
import {sceneName,memberInputs,expectedMemberSource} from './collection-scene.mjs';
const failedPath='Failures/Live.base';
export function recoverySources(scene){
  assert.match(scene?.collectionId,/^[0-9a-z]{12}$/);assert.match(scene?.scorePropertyId,/^[0-9a-z]{12}$/);assert.equal(scene.collectionName,sceneName);
  const scoreProperty=`note.${scene.scorePropertyId}`;
  const summaryBase=`views:\n  - id: aaaaaaaaaaaa\n    type: table\n    name: Recovery\n    source: { kind: collection, id: ${scene.collectionId} }\n    order:\n      - file.name\n      - ${scoreProperty}\n    summaryDefinitions:\n      Total: values.sum()\n    summaries:\n      ${scoreProperty}: Total\n`;
  const failedBase='# Failed live-save fixture comment\nfixtureSentinel: preserve-failed-summary\n'+summaryBase.replace('name: Recovery','name: Failed summary').replace('      Total: values.sum()\n','      Total: values.sum()\n      Unrelated: values.length\n')+`  - id: bbbbbbbbbbbb\n    type: list\n    name: Unrelated view\n    source: { kind: collection, id: ${scene.collectionId} }\n    order: [ file.name ]\n    summaryDefinitions: { Unrelated: values.length }\n    summaries: { ${scoreProperty}: Unrelated }\n`;
  return Object.freeze({scoreProperty,summaryBase,sourceA:summaryBase.replace('Total: values.sum()','Total: values.length'),sourceB:summaryBase.replace('Total: values.sum()','Total: values.sum() + 7'),failedBase,failedA:failedBase.replace('Total: values.sum()','Total: values.length'),failedB:failedBase.replace('Total: values.sum()','Total: values.sum() + 7')});
}
export function fixtureFiles(scene){const sources=recoverySources(scene);return new Map([
  ['Recovery.base',sources.summaryBase],
  [failedPath,sources.failedBase],
  ...memberInputs.map(member=>[member.path,expectedMemberSource(member)]),
  ['Create.base','filters: \'file.ext == "md"\'\nnewItemFolder: Created\nnewItemTemplate: Templates/Literal.md\nviews: [{type: table, name: Create, order: [file.name]}]\n'],
  ['Created/.keep','Disposable output directory.\n'],
  ['Templates/Literal.md',template],
]);}
const active='.pane.is-active .bases-session',panel='[role="dialog"][aria-label="Edit summary"]';
const expression=`${panel} [aria-label="Summary expression"]`;
const close='.pane.is-active .tab.is-active .tab-close';
const plain=object=>JSON.parse(JSON.stringify(object));
async function event(c,kind,token,timeout=10000){return until(async()=>{const found=(await c.relay.events()).find(value=>value.kind===kind&&value.token===token);assert.ok(found,`Real relay event ${kind}`);return found;},timeout);}
async function noFaults(c){const events=await c.relay.events();assert.deepEqual(events.filter(value=>['watchdog-released','relay-failed'].includes(value.kind)),[],'Relay failures cannot satisfy a product acceptance gate');return events;}
async function stat(c,file){return c.cdp.evaluate(`(async()=>{const v=await window.zorid.getVault();return window.zorid.stat(v.path,${JSON.stringify(file)});})()`);}

// Legacy helpers remain exported for the separately owned, frozen safety campaign.
export function retainedConfigurationReviewFrame(document,scope){
  const roots=[...document.querySelectorAll(scope)];if(roots.length!==1)return false;
  const root=roots[0],review=root.querySelector('.bases-configuration-review');if(!review)return false;
  const read=label=>{const fields=[...review.querySelectorAll('textarea')].filter(field=>field.getAttribute('aria-label')===label);return fields.length===1?{text:fields[0].value,readOnly:fields[0].readOnly}:null;};
  const visible=node=>!!node.isConnected&&!!node.getClientRects().length&&!node.closest('[hidden],[inert]');
  return{saved:read('Original saved configuration'),accepted:read('Accepted configuration'),current:read('Current retained input'),retryControls:[...root.querySelectorAll('button')].filter(node=>visible(node)&&node.textContent==='Retry save').length,copyControls:[...review.querySelectorAll('button')].filter(node=>visible(node)&&!node.matches(':disabled')&&!node.closest('[aria-disabled="true"]')).map(node=>node.textContent),status:review.querySelector('[role="status"]')?.textContent??''};
}
export function assertRetainedConfigurationReview(frame,{saved,accepted,current,currentIncludes}){
  assert.ok(frame,'One retained configuration review exists');
  assert.deepEqual(frame.saved,{text:saved,readOnly:true});assert.deepEqual(frame.accepted,{text:accepted,readOnly:true});assert.equal(frame.retryControls,0);
  if(current!==undefined)assert.deepEqual(frame.current,{text:current,readOnly:true});
  if(currentIncludes!==undefined){assert.equal(frame.current?.readOnly,true);assert.ok(frame.current.text.includes(currentIncludes));}
  assert.ok(frame.copyControls.includes('Copy accepted configuration'));
}
export async function reviewRetainedConfiguration(c,scope,expected){
  const mutationFrames=events=>events.filter(event=>['native-write-request','native-prepared-write','native-mutation-response','native-checkpoint-response'].includes(event.kind));
  assert.ok(c.relay,'Read-only native review requires its request-observing relay');
  const beforeEvents=await c.relay.events();assert.ok(beforeEvents.some(event=>event.kind==='native-write-request'),'The relay must already record the original accepted write request');
  const before=mutationFrames(beforeEvents);
  await c.ui.button('Review retained changes',scope);
  const frame=await c.ui.wait(`return (${retainedConfigurationReviewFrame.toString()})(document,${JSON.stringify(scope)});`,'Read-only exact accepted configuration review');assertRetainedConfigurationReview(frame,expected);
  await c.ui.button('Copy accepted configuration',scope);
  await c.ui.wait(`const root=document.querySelector(${JSON.stringify(scope)}),review=root?.querySelector('.bases-configuration-review');return review?.querySelector('[role="status"]')?.textContent==='Copied.';`,'Copy accepts the exact retained configuration without a save');
  if(expected.file)await c.saved(expected.file,source=>assert.equal(source,expected.physical),'read-only-review-copy-normal-bridge-source-barrier');
  assert.deepEqual(mutationFrames(await c.relay.events()),before,'Review/Copy dispatches no native mutation/checkpoint request or replacement intent after its normal bridge read');
  c.evidence.checks.push({name:'read-only-retained-configuration-review-copy',scope,frame,copyAction:'Clipboard writeText ACK; independent OS clipboard readback is not measured',sourceMutationDispatches:0,observedNativeWriteResponses:0});return frame;
}
export function retainedSummaryFrame(document,scope){
  const roots=[...document.querySelectorAll(scope)];if(roots.length!==1)return false;
  const root=roots[0],one=selector=>{const fields=root.querySelectorAll(selector);return fields.length===1?fields[0]:null;};
  const name=one('input[aria-label="Summary name"]'),input=one('textarea[aria-label="Summary expression"]'),editor=one('.cm-content[role="textbox"][aria-label="Summary expression"]');if(!name||!input||!editor)return false;
  const blocked=node=>!!node.closest('[hidden],[inert],[aria-disabled="true"],fieldset:disabled');
  const shown=node=>!!node&&!!node.getClientRects().length&&!blocked(node)&&node.getAttribute('aria-hidden')!=='true'&&document.defaultView.getComputedStyle(node).visibility!=='hidden'&&document.defaultView.getComputedStyle(node).display!=='none';
  // The textarea mirrors raw input; the visible CodeMirror editor owns interaction.
  const alert=root.querySelector('[role="alert"]');
  const customLabels=new Set(['Review retained changes','Copy draft','Copy accepted configuration','Copy original configuration','Copy retained input','Retry save']);
  return{busy:root.getAttribute('aria-busy'),name:name.value,draft:input.value,visibleDraft:editor.textContent,disabled:input.matches(':disabled'),readonly:editor.getAttribute('aria-readonly'),error:alert?.textContent??'',errorVisible:shown(alert),editable:!name.matches(':disabled')&&!name.readOnly&&!input.matches(':disabled')&&!input.readOnly&&!blocked(root)&&!blocked(name)&&!blocked(editor)&&shown(editor)&&editor.getAttribute('contenteditable')==='true'&&editor.getAttribute('aria-readonly')==='false',customReview:!!root.querySelector('.bases-configuration-review'),customControls:[...root.querySelectorAll('button')].filter(node=>customLabels.has(node.textContent.trim())).map(node=>node.textContent.trim())};
}
export function assertEditableRetainedSummary(frame,{draft,name='Total'}){
  assert.ok(frame,'One original retained summary editor exists');assert.equal(frame.busy,'false');assert.equal(frame.name,name);assert.equal(frame.draft,draft);assert.equal(frame.visibleDraft,draft);assert.equal(frame.editable,true,'Retained Summary fields remain editable after terminal failure');assert.ok(frame.error.trim(),'The terminal save error remains present');assert.equal(frame.errorVisible,true,'The terminal save error remains visible');assert.equal(frame.customReview,false);assert.deepEqual(frame.customControls,[],'No custom Review, Copy or Retry controls remain');
}
export async function retainEditableSummaryWithoutMutation(c,scope,expected){
  const mutationFrames=events=>events.filter(event=>['native-write-request','native-prepared-write','native-mutation-response','native-checkpoint-response'].includes(event.kind));
  const before=mutationFrames(await c.relay.events());assert.ok(before.some(event=>event.kind==='native-write-request'),'Original accepted request must already be observed');
  const frame=await c.ui.wait(`return (${retainedSummaryFrame.toString()})(document,${JSON.stringify(scope)});`,'Terminal summary retains editable raw B');assertEditableRetainedSummary(frame,expected);
  await delay(350);
  await c.saved(expected.file,source=>assert.equal(source,expected.source),'terminal-editable-summary-original-source-barrier');
  assert.deepEqual(mutationFrames(await c.relay.events()),before,'Editable retained B cannot automatically dispatch a mutation/checkpoint or replacement intent');
  const after=await c.ui.wait(`return (${retainedSummaryFrame.toString()})(document,${JSON.stringify(scope)});`,'Terminal summary remains editable without automatic authoring');assertEditableRetainedSummary(after,expected);
  c.evidence.checks.push({name:'terminal-summary-editable-without-custom-recovery-or-automatic-mutation',frame:after,sourceMutationDispatches:0,observedNativeWriteResponses:0});return after;
}
async function summaryFrame(c){
  return c.ui.dom(`return (${retainedSummaryFrame.toString()})(document,${JSON.stringify(panel)});`);
}
async function summaryPanelIdentity(c,selector=panel){
  // CDP DOM identity is passive: no property, focus, event or semantic API is injected.
  const {root}=await c.cdp.call('DOM.getDocument',{depth:0});
  const {nodeId}=await c.cdp.call('DOM.querySelector',{nodeId:root.nodeId,selector});assert.ok(nodeId);
  return (await c.cdp.call('DOM.describeNode',{nodeId})).node.backendNodeId;
}
export function collectionSceneFrame(document,scope,scoreProperty,view){
  const roots=[...document.querySelectorAll(scope)];if(roots.length!==1)return false;
  const root=roots[0],grid=root.querySelector('[role="grid"]'),footerRow=grid?.querySelector('.zorid-bases-table-footer'),footer=footerRow?.querySelector(`[data-summary-property=${JSON.stringify(scoreProperty)}]`);
  const values=[...root.querySelectorAll(`[role="gridcell"][data-property=${JSON.stringify(scoreProperty)}]`)].map(cell=>({path:cell.dataset.path,value:cell.textContent.trim()})).sort((a,b)=>a.path.localeCompare(b.path));
  if(root.dataset.baseControllerError!=='false'||root.dataset.baseControllerUpdating!=='false'||root.querySelector('.bases-session-content')?.getAttribute('aria-busy')!=='false'||grid?.getAttribute('aria-label')!==view||grid.getAttribute('aria-rowcount')!=='5'||!grid.querySelector('.zorid-bases-table-new-row:not([hidden])')||!footerRow||footerRow.hidden||JSON.stringify(values)!==JSON.stringify([{path:'A.md',value:'2'},{path:'B.md',value:'3'}])||footer?.querySelector('.summary-function-name')?.textContent!=='Total'||footer.querySelector('.summary-function-value')?.textContent!=='5')return false;
  return{view:grid.getAttribute('aria-label'),values,summary:'5',property:scoreProperty,source:root.querySelector('.collection-source-bar')?.textContent};
}
async function requireCollectionScene(c,view){
  const {scoreProperty}=recoverySources(c.fixtureScene);
  const observed=await c.ui.wait(`return (${collectionSceneFrame.toString()})(document,${JSON.stringify(active)},${JSON.stringify(scoreProperty)},${JSON.stringify(view)});`,'Actual collection-backed score rows and Total5 exist before any fault is armed',45000);
  c.evidence.checks.push({name:'supported-native-collection-scene-ready-before-fault',collectionId:c.fixtureScene.collectionId,scorePropertyId:c.fixtureScene.scorePropertyId,observed});
}
export async function failedLiveWriteWithNewerDraft(c){
  const {failedBase,failedA,failedB,scoreProperty}=recoverySources(c.fixtureScene);
  await c.launch('native-failed-summary-newer-draft');await c.ui.openFile(failedPath);await c.ui.idle();
  const before=await stat(c,failedPath);assert.ok(before.entryId&&before.revision);
  const sources=fixtureFiles(c.fixtureScene);await c.saved(failedPath,source=>assert.equal(source,failedBase),'failed-summary-original-whole-source');
  await requireCollectionScene(c,'Failed summary');await c.ui.click(`${active} .zorid-bases-table-footer [data-summary-property=${JSON.stringify(scoreProperty)}]`);await c.ui.button('Edit Total','.zorid-bases-summary-picker');
  const panelId=await summaryPanelIdentity(c),offset=(await c.relay.events()).length;
  const focused=await captureFocusedSummaryInput(c,'Failures / Live');let token,held,pending;
  try{
    assert.equal(focused.panelBackendNodeId,panelId);
    token=await c.relay.arm({mode:'hold',phase:'prepared',path:failedPath,entryId:before.entryId,bodySha256:digest(Buffer.from(failedA))});
    await c.ui.type(expression,'values.length');held=await event(c,'held',token);
    assert.equal(held.phase,'prepared');assert.equal(held.nativeState,'prepared');assert.ok(held.nativeIntentToken&&held.operationId);assert.equal(held.sequence,undefined,'An inert prepared reply is not a durable save receipt');
    assert.equal(await c.read(failedPath),failedBase);
    await c.ui.wait(`return document.querySelector(${JSON.stringify(panel)})?.getAttribute('aria-busy')==='true';`,'Actual A save is pending its genuine prepared reply');
    await continueFocusedSummaryInput(c,focused,'values.sum() + 7','values.length');const typedAt=Date.now();await delay(300);
    pending=await summaryFrame(c);assert.equal(pending.busy,'true');assert.equal(pending.draft,'values.sum() + 7');assert.equal(pending.visibleDraft,pending.draft);assert.ok(Date.now()-typedAt>=300);
    assert.equal(await summaryPanelIdentity(c,`${panel} ${summaryEditor}`),focused.editorBackendNodeId,'Newer B remains in the original accepted editor');
  }finally{await disposeFocusedSummaryInput(c,focused);}
  assert.equal(await c.read(failedPath),failedBase,'Neither pending A nor newer debounce draft B has committed');

  const vault=await fs.realpath(c.vault),out=await fs.realpath(c.outputDirectory),privateDirectory=path.join(vault,'.zorid'),lock=path.join(privateDirectory,'vault.lock');
  assert.ok(vault.startsWith(out+path.sep),'Only the runner-owned disposable vault can lose lock access');
  assert.equal(await fs.realpath(privateDirectory),privateDirectory,'Private parent must not redirect outside the owned vault');
  const identity=await fs.lstat(lock),mode=identity.mode&0o7777;
  assert.ok(identity.isFile()&&!identity.isSymbolicLink());assert.equal(identity.uid,process.getuid());assert.equal(identity.nlink,1);assert.ok(mode&0o600);
  const sameLock=async()=>{const current=await fs.lstat(lock);assert.ok(current.isFile()&&!current.isSymbolicLink());assert.equal(current.dev,identity.dev);assert.equal(current.ino,identity.ino);return current;};
  let failed,negative;
  try{
    // The next post-prepare checkpoint CAS freshly opens this exact vault lock.
    // Deny that open, leaving the public sources and database files untouched.
    await fs.chmod(lock,0o000);assert.equal((await sameLock()).mode&0o7777,0);
    c.evidence.actions.push({action:'owned-negative-checkpoint-lock-access',lock,dev:identity.dev,ino:identity.ino,originalMode:mode,mode:'0000',phase:'after-inert-prepare-before-ref-checkpoint',at:Date.now()});
    await c.relay.release(token);await event(c,'released',token,3000);
    negative=await until(async()=>{const row=terminalLockCheckpointFailure((await c.relay.events()).slice(offset),'note/v1/'+before.entryId,held);assert.ok(row);return row;},10000);
    await c.ui.wait(`const p=document.querySelector(${JSON.stringify(panel)});return p?.getAttribute('aria-busy')==='false'&&!!p.querySelector('[role="alert"]')?.textContent?.trim();`,'A terminal checkpoint fault retains its save error',10000);
    failed=await summaryFrame(c);assertEditableRetainedSummary(failed,{draft:'values.sum() + 7'});assert.equal(await summaryPanelIdentity(c),panelId);assert.equal(await summaryPanelIdentity(c,`${panel} ${summaryEditor}`),focused.editorBackendNodeId);
    const events=(await c.relay.events()).slice(offset);assert.equal(events.filter(e=>e.kind==='native-mutation-response'&&e.ok&&e.state==='committed'&&e.preparedBodySha256===digest(Buffer.from(failedA))).length,0,'Failed checkpoint acknowledgement must precede any successful A commit');
    await c.screenshot('r00-genuine-checkpoint-error-retains-newer-summary-draft');
  }finally{
    await sameLock();await fs.chmod(lock,mode);assert.equal((await sameLock()).mode&0o7777,mode);
    c.evidence.actions.push({action:'restore-owned-checkpoint-lock-access',lock,dev:identity.dev,ino:identity.ino,mode,at:Date.now()});
  }
  // Access-denied filesystem_failed is terminal under the strict retry policy.
  // Restoring access alone cannot retry it. Ordinary Save settles
  // accepted A; newer raw B requires its own explicit commit in the same editor.
  await c.saved(failedPath,source=>assert.equal(source,failedBase),'failed-summary-restored-original-physical-and-logical-source');
  await retainEditableSummaryWithoutMutation(c,panel,{draft:'values.sum() + 7',file:failedPath,source:failedBase});
  assert.equal(await c.read(failedPath),failedBase,'Editable retained B does not publish A or newer B before ordinary Save');
  await c.ui.command('Save current changes');
  await c.saved(failedPath,source=>assert.equal(source,failedA),'failed-summary-ordinary-save-settles-only-original-A');
  await c.ui.wait(`const p=document.querySelector(${JSON.stringify(panel)}),input=p?.querySelector('textarea[aria-label="Summary expression"]');return p?.getAttribute('aria-busy')==='false'&&input?.value==='values.sum() + 7'&&!input.disabled;`,'Original A ACK retains editable raw B without authoring it');
  await delay(350);assert.equal(await c.read(failedPath),failedA,'A shared Save acknowledgement cannot automatically submit newer raw B');assert.equal(await summaryPanelIdentity(c),panelId,'The original panel retains B through ordinary A resolution');assert.equal(await summaryPanelIdentity(c,`${panel} ${summaryEditor}`),focused.editorBackendNodeId,'Original editor retains raw B after A ACK');
  await c.ui.click(`${panel} .cm-content[aria-label="Summary expression"]`);await c.ui.key('Tab');
  await c.saved(failedPath,source=>assert.equal(source,failedB),'failed-summary-explicit-raw-B-commit-after-original-A-resolution');
  // Opening the normal palette requested an outside close. Once explicit B
  // is acknowledged, honor that request without manufacturing a replacement.
  await c.ui.wait(`return !document.querySelector(${JSON.stringify(panel)});`,'Explicit B acknowledgement finishes the previously requested normal close');
  const events=(await noFaults(c)).slice(offset),commits=events.filter(e=>e.kind==='native-mutation-response'&&e.method==='commit_intent'&&e.ok&&e.state==='committed'&&[digest(Buffer.from(failedA)),digest(Buffer.from(failedB))].includes(e.preparedBodySha256));
  assert.deepEqual(commits.map(e=>e.preparedBodySha256),[digest(Buffer.from(failedA)),digest(Buffer.from(failedB))],'Ordinary Save commits original A before the explicit newer raw B commit');
  const checkpointReplay=events.find(e=>e.kind==='native-checkpoint-response'&&e.ok&&e.key===negative.key&&e.commandSha256===negative.commandSha256&&e.bodySha256===negative.bodySha256);
  assert.ok(checkpointReplay,'Ordinary Save first replays the identical failed checkpoint CAS command and opaque body');
  assert.ok(events.indexOf(checkpointReplay)>events.findIndex(e=>e.responseSha256===negative.responseSha256)&&events.indexOf(checkpointReplay)<events.indexOf(commits[0]),'Exact checkpoint replay succeeds before the original A commit');
  assert.equal(commits[0].referenceToken,held.nativeIntentToken,'A commits with the original held preparation token instead of replanning');
  const prepared=events.filter(e=>e.kind==='native-prepared-write'&&e.entryId===before.entryId);
  assert.equal(prepared.filter(e=>e.bodySha256===digest(Buffer.from(failedA))).length,1,'A is prepared only once; the original reference is retried');
  assert.equal(prepared.filter(e=>e.bodySha256===digest(Buffer.from(failedB))).length,1);
  for(const[file,source]of sources)await c.saved(file,current=>assert.equal(current,file===failedPath?failedB:source),'failed-summary-whole-source-and-unrelated-fixture-'+file);
  await c.ui.wait(`const e=document.querySelector('${active} .zorid-bases-table-footer [data-summary-property=${JSON.stringify(scoreProperty)}]');return e?.querySelector('.summary-function-name')?.textContent==='Total'&&e.querySelector('.summary-function-value')?.textContent==='12';`,'Saved B summary has independent two-note value12');
  await c.ui.click(close);await c.ui.wait(`return !document.querySelector(${JSON.stringify(active)});`,'Acknowledged failed-save continuation closes normally');
  c.evidence.checks.push({name:'genuine-native-summary-terminal-checkpoint-ordinary-save-and-explicit-raw-B',held:plain(held),failure:plain(negative),pending,failed,panelBackendNodeId:panelId,editorBackendNodeId:focused.editorBackendNodeId,prepared,checkpointReplay:plain(checkpointReplay),commits,manualRetryClicks:0,ordinarySaveCommands:1,explicitRawBCommits:1,scope:'Real failed checkpoint ACK from owned lock access denial; not postcommit publication, SQLite/device failure, power loss or synthetic reply'});
  await c.quit('failed-summary-normal-quit-after-B');
  await c.launch('failed-summary-restart-readback');await c.ui.openFile(failedPath);await c.ui.idle();
  for(const[file,source]of sources)await c.saved(file,current=>assert.equal(current,file===failedPath?failedB:source),'failed-summary-restart-exact-fixture-'+file);
  await c.ui.wait(`return document.querySelector('${active} .zorid-bases-table-footer [data-summary-property=${JSON.stringify(scoreProperty)}] .summary-function-value')?.textContent==='12';`,'Failed-save newer B survives normal restart');
  await c.quit('failed-summary-readback-normal-quit');
}

async function heldWriteAndClose(c){
  const {summaryBase,sourceA,sourceB,scoreProperty}=recoverySources(c.fixtureScene);
  await c.launch('native-held-write');await c.ui.openFile('Recovery.base');await c.ui.idle();
  const before=await stat(c,'Recovery.base');assert.ok(before.entryId&&before.revision);
  await c.saved('Recovery.base',source=>assert.equal(source,summaryBase),'held-write-original-exact-source');
  await requireCollectionScene(c,'Recovery');await c.ui.click(`${active} .zorid-bases-table-footer [data-summary-property=${JSON.stringify(scoreProperty)}]`);
  await c.ui.button('Edit Total','.zorid-bases-summary-picker');
  const focused=await captureFocusedSummaryInput(c,'Recovery');let token,held;
  try{
    token=await c.relay.arm({mode:'hold',path:'Recovery.base',entryId:before.entryId,bodySha256:digest(Buffer.from(sourceA))});
    await c.ui.type(expression,'values.length');held=await event(c,'held',token);
    assert.equal(await c.read('Recovery.base'),sourceA,'Native has really committed A before holding its acknowledgement');
    await c.ui.wait(`return document.querySelector(${JSON.stringify(panel)})?.getAttribute('aria-busy')==='true';`,'Mounted summary is waiting for the real acknowledgement',3000);
    await continueFocusedSummaryInput(c,focused,'values.sum() + 7','values.length');await delay(300);
    assert.equal(await summaryPanelIdentity(c),focused.panelBackendNodeId);assert.equal(await summaryPanelIdentity(c,`${panel} ${summaryEditor}`),focused.editorBackendNodeId);
  }finally{await disposeFocusedSummaryInput(c,focused);}
  await c.ui.click(close);await delay(100);
  assert.equal(await c.ui.dom(`return document.querySelector(${JSON.stringify(expression)})?.value;`),'values.sum() + 7','Close cannot discard newer B while accepted A is awaiting acknowledgement');
  assert.equal(await c.read('Recovery.base'),sourceA,'B has not been manufactured before real A reply');
  await c.screenshot('r01-held-native-ack-newer-draft-close-retained');
  await c.relay.release(token);await event(c,'released',token,3000);
  const disposition=await until(async()=>{
    if(await c.read('Recovery.base')===sourceB)return'automatic';
    const state=await c.ui.dom(`const p=document.querySelector(${JSON.stringify(panel)});return p&&p.getAttribute('aria-busy')==='false'?{value:document.querySelector(${JSON.stringify(expression)})?.value,error:p.querySelector('[role="alert"]')?.textContent}:null;`);
    assert.ok(state&&state.value==='values.sum() + 7'&&/closing/i.test(state.error),'Either B is saved or the conservative close guard retains the exact B draft');
    return'close-guard-retry';
  },10000);
  if(disposition==='close-guard-retry'){
    // Closing fences new configuration commands. If B's continuation reaches
    // that fence, its visible exact draft must survive; explicitly submit it
    // again after the close request is rejected, rather than pretending an
    // automatic acknowledgement happened.
    await delay(50);await c.ui.click(expression);await c.ui.key('Tab');
  }
  await c.saved('Recovery.base',source=>assert.equal(source,sourceB),'held-write-continuation-saves-exact-newer-B');
  await c.ui.wait(`return !document.querySelector(${JSON.stringify(panel)});`,'Summary close settles after the newer draft is safe',10000);
  const retained=await c.ui.dom(`return !!document.querySelector(${JSON.stringify(active)});`);
  // A close request may conservatively report the still-active continuation.
  // Retrying close only after B is durably acknowledged is an explicit UI action.
  if(retained){await c.ui.click(close);await c.ui.wait(`return !document.querySelector(${JSON.stringify(active)});`,'Clean acknowledged Base closes on retry');}
  const events=await noFaults(c),writes=events.filter(value=>value.kind==='native-mutation-response'&&value.method==='commit_intent'&&value.ok&&value.state==='committed'&&[digest(Buffer.from(sourceA)),digest(Buffer.from(sourceB))].includes(value.preparedBodySha256));
  // commit_intent has no body. Prepared-body hashes are attached by the relay's
  // successful token correlation, independently from the selected held frame.
  const continuations=events.filter(value=>value.kind==='native-prepared-write'&&value.entryId===before.entryId);
  assert.equal(continuations.filter(value=>value.bodySha256===digest(Buffer.from(sourceA))).length,1);
  assert.equal(continuations.filter(value=>value.bodySha256===digest(Buffer.from(sourceB))).length,1);
  assert.equal(writes.length,2,'Each exact prepared A/B write has one genuine successful commit response');
  c.evidence.checks.push({name:'accepted-native-A-newer-B-close-retention',held:plain(held),panelBackendNodeId:focused.panelBackendNodeId,editorBackendNodeId:focused.editorBackendNodeId,continuation:disposition,closeRetryNeeded:retained,prepared:continuations,commits:writes});
  await c.quit('held-write-normal-quit-after-B');
  await c.launch('held-write-restart-readback');await c.ui.openFile('Recovery.base');await c.ui.idle();
  await c.saved('Recovery.base',source=>assert.equal(source,sourceB),'newer-B-survives-normal-native-app-restart');
  await c.quit('held-write-readback-normal-quit');
}

async function droppedCreateAndRestart(c){
  await c.launch('native-lost-create-reply');await c.ui.openFile('Create.base');await c.ui.idle();
  assert.equal(typeof c.observeNativeGenerations,'function','Automatic creation requires every real native generation to be authenticated');
  const namesBefore=(await fs.readdir(path.join(c.vault,'Created'))).sort();assert.deepEqual(namesBefore,['.keep']);
  const sources=new Map();for(const file of fixtureFiles(c.fixtureScene).keys())sources.set(file,await c.read(file));
  const expectedCreate=fixtureFiles(c.fixtureScene).get('Create.base');assert.equal(sources.get('Create.base'),expectedCreate);
  await c.saved('Create.base',source=>assert.equal(source,expectedCreate),'lost-create-original-base-source-before-fault');
  const sourceIdentity=await stat(c,'Create.base'),originalCdp=c.cdp,observation=await captureLostCreateUi(c);let accepted;
  const documentIdentity=async()=>{assert.equal(c.cdp,originalCdp,'The same mounted CDP target owns recovery');const {frameTree}=await c.cdp.call('Page.getFrameTree');return{frameId:frameTree.frame.id,loaderId:frameTree.frame.loaderId,url:frameTree.frame.url};};
  const binding=async(current,frame)=>{const identity=await stat(c,'Create.base');return{appPid:current.appPid,...await documentIdentity(),paneBackendNodeId:observation.paneBackendNodeId,tabId:frame.tabId,basePath:'Create.base',viewLabel:frame.viewLabel,viewIndex:frame.viewIndex,sourceEntryId:identity.entryId,sourceRevision:identity.revision,sourceSha256:digest(Buffer.from(await c.read('Create.base')))};};
  try{
    const initial=await c.observeNativeGenerations();assert.ok(initial.current?.authenticatedAtLaunch);
    const firstFrame=await lostCreateUiFrame(c,observation);assert.equal(firstFrame.settled,true);assert.deepEqual(firstFrame.failures,[]);
    const before=await binding(initial.current,firstFrame);assert.equal(before.sourceEntryId,sourceIdentity.entryId);assert.equal(before.sourceRevision,sourceIdentity.revision);
    const actionOffset=c.evidence.actions.length,bodySha256=digest(Buffer.from(template)),token=await c.relay.arm({mode:'drop',path:'Created/Untitled.md',bodySha256});
    const actionStartedAt=Date.now();await c.ui.button('New',active);
    const dropped=await event(c,'dropped',token);
    accepted=await until(async()=>{
      const registry=await c.observeNativeGenerations();assert.ok(registry.current?.authenticatedAtLaunch,'A fresh positively authenticated native generation must be live');
      const frame=await lostCreateUiFrame(c,observation);assert.equal(frame.settled,true,'Original Base is ready without manual recovery');assert.deepEqual(frame.failures,[]);
      const after=await binding(registry.current,frame),events=await noFaults(c),current=await stat(c,'Created/Untitled.md'),names=(await fs.readdir(path.join(c.vault,'Created'))).sort();
      const receipt=assertAutomaticLostCreateReplay({events,dropped,before,after,generations:registry.generations,current,names,bodySha256,actions:c.evidence.actions.slice(actionOffset),actionStartedAt,ui:frame});
      assert.deepEqual(await fs.readFile(path.join(c.vault,'Created','Untitled.md')),Buffer.from(template),'Physical original file contains every independently authored template byte');
      return{receipt,before,after,ui:frame};
    },15000);
    await c.saved('Created/Untitled.md',source=>assert.equal(source,template),'lost-create-automatic-same-mounted-original-template');
    for(const[file,source]of sources)await c.saved(file,actual=>assert.equal(actual,source),'lost-create-unchanged-whole-fixture-'+file);
    // A read barrier and a further quiet interval may expose delayed duplicate
    // authoring; neither may be used to request a retry or a second creation.
    await delay(350);
    await c.screenshot('r02-native-create-automatically-recovered-same-mounted-document');
    const registry=await c.observeNativeGenerations(),frame=await lostCreateUiFrame(c,observation);assert.ok(registry.current?.authenticatedAtLaunch);assert.equal(frame.settled,true);
    accepted.receipt=assertAutomaticLostCreateReplay({events:await noFaults(c),dropped,before,after:await binding(registry.current,frame),generations:registry.generations,current:await stat(c,'Created/Untitled.md'),names:(await fs.readdir(path.join(c.vault,'Created'))).sort(),bodySha256,actions:c.evidence.actions.slice(actionOffset),actionStartedAt,ui:frame});accepted.ui=frame;
    c.evidence.checks.push({name:'genuine-lost-create-reply-automatic-same-mounted-original-receipt',...accepted,userNewClicks:1,manualRecoveryActions:0,scope:'Actual EOF and automatic host replacement; one original operation and byte-exact receipt replay before any normal quit/restart. Visible DOM mutation and animation frames observed, not an OS screen-recording or power-loss claim.'});
  }finally{await disposeLostCreateUi(c,observation);}
  await c.quit('lost-create-automatic-recovery-normal-quit');
  await c.launch('lost-create-normal-restart-readback');await c.ui.openFile('Create.base');await c.ui.idle();
  assert.deepEqual((await fs.readdir(path.join(c.vault,'Created'))).sort(),['.keep','Untitled.md']);
  const current=await stat(c,'Created/Untitled.md');assert.equal(current.entryId,accepted.receipt.entryId);assert.equal(current.revision,accepted.receipt.revision);
  await c.saved('Created/Untitled.md',source=>assert.equal(source,template),'lost-create-normal-restart-retains-original-template');
  for(const[file,source]of sources)await c.saved(file,actual=>assert.equal(actual,source),'lost-create-normal-restart-unchanged-whole-fixture-'+file);
  await c.screenshot('r03-native-create-normal-restart-readback');await c.quit('lost-create-readback-normal-quit');
}

export async function journey(c){
  assert.ok(c.relay&&c.observeNativeGenerations,'Common runner must provide its reviewed relay and every-generation process ownership seam');
  c.evidence.limitations.push('The failed-summary phase denies only the owned vault.lock open before the prepared-ref checkpoint and requires genuine uncertain filesystem_failed. The access denial is terminal under the strict retry policy: read-only Review/Copy and ordinary Save resolve accepted A, and raw B requires explicit commit. This is not routine host/admission recovery, postcommit publication, SQLite/device failure or power-loss coverage.', 'Other held/dropped responses follow real core success; those transport cases are not failed saves. A newer draft blocked behind a native call is not claimed crash-durable before its checkpoint can run.');
  await failedLiveWriteWithNewerDraft(c);await heldWriteAndClose(c);await droppedCreateAndRestart(c);await noFaults(c);
}
