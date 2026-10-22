import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {delay,until} from '../tasks-electron-integration/cdp.mjs';
import {digest} from './protocol.mjs';
export {createNativeRelay} from './control.mjs';

export const vaultName='bases-native-recovery';
export const template='\uFEFF---\r\nstatus: Template\r\nliteral: "{{date}}"\r\n---\r\n# {{title}}\r\nExact copy 😀\r\n';
const summaryBase='filters: \'note.kind == "recovery"\'\nsummaries:\n  Total: values.sum()\nviews:\n  - type: table\n    name: Recovery\n    order: [ file.name, note.score ]\n    summaries:\n      note.score: Total\n';
const sourceA=summaryBase.replace('Total: values.sum()','Total: values.length');
const sourceB=summaryBase.replace('Total: values.sum()','Total: values.sum() + 7');
export function fixtureFiles(){return new Map([
  ['Recovery.base',summaryBase],
  ['A.md','---\nkind: recovery\nscore: 2\n---\nA body sentinel\n'],
  ['B.md','---\nkind: recovery\nscore: 3\n---\nB body sentinel\n'],
  ['Create.base','filters: \'note.kind == "recovery"\'\nnewItemFolder: Created\nnewItemTemplate: Templates/Literal.md\nviews: [{type: table, name: Create, order: [file.name]}]\n'],
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

async function heldWriteAndClose(c){
  await c.launch('native-held-write');await c.ui.openFile('Recovery.base');await c.ui.idle();
  const before=await stat(c,'Recovery.base');assert.ok(before.entryId&&before.revision);
  await c.saved('Recovery.base',source=>assert.equal(source,summaryBase),'held-write-original-exact-source');
  await c.ui.click(`${active} .zorid-bases-table-footer [data-summary-property="note.score"]`);
  await c.ui.button('Edit Total','.zorid-bases-summary-picker');
  const token=await c.relay.arm({mode:'hold',path:'Recovery.base',entryId:before.entryId,bodySha256:digest(Buffer.from(sourceA))});
  await c.ui.type(expression,'values.length');const held=await event(c,'held',token);
  assert.equal(await c.read('Recovery.base'),sourceA,'Native has really committed A before holding its acknowledgement');
  await c.ui.wait(`return document.querySelector(${JSON.stringify(panel)})?.getAttribute('aria-busy')==='true';`,'Mounted summary is waiting for the real acknowledgement',3000);
  await c.ui.type(expression,'values.sum() + 7');await delay(300);
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
  const events=await noFaults(c),writes=events.filter(value=>value.kind==='native-mutation-response'&&value.method==='commit_intent'&&value.ok&&[digest(Buffer.from(sourceA)),digest(Buffer.from(sourceB))].includes(value.preparedBodySha256));
  // commit_intent has no body. Prepared-body hashes are attached by the relay's
  // successful token correlation, independently from the selected held frame.
  const continuations=events.filter(value=>value.kind==='native-prepared-write'&&value.entryId===before.entryId);
  assert.equal(continuations.filter(value=>value.bodySha256===digest(Buffer.from(sourceA))).length,1);
  assert.equal(continuations.filter(value=>value.bodySha256===digest(Buffer.from(sourceB))).length,1);
  assert.equal(writes.length,2,'Each exact prepared A/B write has one genuine successful commit response');
  c.evidence.checks.push({name:'accepted-native-A-newer-B-close-retention',held:plain(held),continuation:disposition,closeRetryNeeded:retained,prepared:continuations,commits:writes});
  await c.quit('held-write-normal-quit-after-B');
  await c.launch('held-write-restart-readback');await c.ui.openFile('Recovery.base');await c.ui.idle();
  await c.saved('Recovery.base',source=>assert.equal(source,sourceB),'newer-B-survives-normal-native-app-restart');
  await c.quit('held-write-readback-normal-quit');
}

async function droppedCreateAndRestart(c){
  await c.launch('native-lost-create-reply');await c.ui.openFile('Create.base');await c.ui.idle();
  const namesBefore=(await fs.readdir(path.join(c.vault,'Created'))).sort();assert.deepEqual(namesBefore,['.keep']);
  const token=await c.relay.arm({mode:'drop',path:'Created/Untitled.md',bodySha256:digest(Buffer.from(template))});
  await c.ui.button('New',active);const dropped=await event(c,'dropped',token);
  await until(async()=>{assert.ok((await c.relay.events()).some(value=>value.kind==='drop-child-closed'));},5000);
  assert.equal(await c.read('Created/Untitled.md'),template,'The real core created the complete literal template before transport loss');
  await c.ui.wait(`return [...document.querySelectorAll('[role="status"],[role="alert"]')].some(e=>e.getClientRects().length&&/failed|unavailable|uncertain|recovery/i.test(e.textContent));`,'Mounted New reports the actual lost acknowledgement');
  await c.ui.button('New',active);await delay(150);
  await c.ui.click(close);await delay(150);
  await c.ui.wait(`return !!document.querySelector(${JSON.stringify(active)})&&[...document.querySelectorAll('[role="status"],[role="alert"]')].some(e=>e.getClientRects().length&&/uncertain|unconfirmed|reconcile|failed/i.test(e.textContent));`,'Uncertain New retains the Base when close is requested');
  assert.deepEqual((await fs.readdir(path.join(c.vault,'Created'))).sort(),['.keep','Untitled.md']);
  await c.screenshot('r02-real-lost-create-ack-uncertain-mounted-base');
  const beforeRestart=await noFaults(c),original=beforeRestart.filter(value=>value.kind==='native-mutation-response'&&value.operationId===dropped.operationId);
  assert.equal(original.length,1,'Repeated mounted New cannot send a new or replayed create through the fenced transport');
  await c.forceShutdown('explicit-lost-transport-app-interruption');
  await c.launch('lost-create-startup-receipt-recovery');await c.ui.openFile('Create.base');await c.ui.idle();
  const events=await noFaults(c),replies=events.filter(value=>value.kind==='native-mutation-response'&&value.operationId===dropped.operationId);
  assert.equal(replies.length,2,'Startup replays precisely the retained unacknowledged create step');
  assert.equal(replies[0].commandSha256,replies[1].commandSha256,'Same original mutation and operation identity across restart');
  assert.equal(replies[0].bodySha256,replies[1].bodySha256);assert.equal(replies[0].sequence,replies[1].sequence,'Native receipt replay cannot create another mutation');
  const current=await stat(c,'Created/Untitled.md');assert.equal(current.entryId,dropped.entryId);assert.equal(current.revision,dropped.revision);
  assert.deepEqual((await fs.readdir(path.join(c.vault,'Created'))).sort(),['.keep','Untitled.md']);
  await c.saved('Created/Untitled.md',source=>assert.equal(source,template),'lost-create-restart-retains-one-original-file-exact-template');
  c.evidence.checks.push({name:'genuine-lost-create-reply-startup-original-receipt-replay',dropped:plain(dropped),replies,current,scope:'No same-mounted transport reconnect or power-loss guarantee'});
  await c.screenshot('r03-native-create-receipt-recovered-after-restart');await c.quit('lost-create-recovery-normal-quit');
}

export async function journey(c){
  assert.ok(c.relay&&c.forceShutdown,'Common runner must provide its reviewed test-only relay/process ownership seam');
  c.evidence.limitations.push('Holds/drops genuine stdio native responses after real core success; this is a controlled transport test, not native disk failure, arbitrary crash, power loss or same-mounted reconnect.', 'A held accepted write is not a failed-save retry. Newer input is proved through orderly acknowledgement and close; its durability before a blocked checkpoint is not claimed.');
  await heldWriteAndClose(c);await droppedCreateAndRestart(c);await noFaults(c);
}
