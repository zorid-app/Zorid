export const FLOOR_LABEL='Production createEditor rendering/input floor; fixture journal only; no vault/core authority or import acceptance';
export function fixtureText(bytes){
 if(!Number.isSafeInteger(bytes)||bytes<1024||bytes>50*1024*1024)throw Error('Unsupported owned fixture size');
 const prefix='# Startup editor floor\n\nVisible first paragraph. Controlled fixture content.\n\n';
 const paragraph='Ordinary Markdown text in a paragraph. The later document must remain intact.\n\n';
 const rest=bytes-prefix.length;return prefix+paragraph.repeat(Math.floor(rest/paragraph.length))+paragraph.slice(0,rest%paragraph.length);
}
export function assessFloor(value){
 const errors=[...(value.errors??[])],finite=v=>typeof v==='number'&&Number.isFinite(v);
 const require=(condition,message)=>{if(!condition)errors.push(message);};
 require(value.floorOnly===true,'Missing explicit floor-only label');
 require(value.deadlineMs===800,'The fixed 800 ms target changed');
 const origin=value.mode==='normal-reopen'?value.spawnEpoch:value.mode==='first-folder-selection'?value.selectionEpoch:null;
 require(finite(origin)&&finite(value.spawnEpoch),'Missing explicit launch/selection clock');
 require(value.clockVerified===true,'Renderer/main epoch handshake failed');
 require(value.packaged===true,'Renderer did not run from the packaged fixture app');
 require(value.electronVersion==='44.9.1'&&value.electronVersion===value.expectedElectronVersion,'Electron version differs from pin');
 require(value.initialDocumentLength===value.expectedBytes&&value.initialPrefixMatches===true,'Wrong initial document');
 require(value.viewportMatches===true,'First viewport content was not verified');
 require(value.readyIdentity===value.fixtureId&&value.editableAtReady===true,'Wrong fixture or disabled interaction guard');
 const probes=value.probes??[],ready=probes.find(p=>p.name==='ready'),deadline=probes.find(p=>p.name==='deadline');
 require(probes.length===2&&!!ready&&!!deadline,'Need exactly one readiness and one deadline probe; no retries');
 for(const probe of probes){
  require(probe.trusted===true&&probe.identity===value.fixtureId&&probe.guard===true,`${probe.name}: untrusted or unowned input`);
  require(finite(probe.appliedEpoch)&&probe.caret===probe.expectedCaret,`${probe.name}: unapplied input or changed caret`);
  require(probe.caretAfterPaint===probe.expectedCaretAfterPaint&&Number.isSafeInteger(probe.caretAfterPaint),`${probe.name}: caret changed after paint`);
  require(probe.journal?.ack===true&&probe.journal?.fsynced===true&&probe.journal?.readback===true,`${probe.name}: fixture journal acknowledgment missing`);
  require(finite(probe.journal?.ackEpoch)&&probe.journal.ackEpoch>=probe.appliedEpoch-5,`${probe.name}: invalid journal acknowledgment clock`);
 }
 require(value.body?.sourceMatches===true&&value.body?.editedMatches===true,'Later complete-body verification failed');
 require(value.normalExit===true&&value.exitCode===0&&value.signal===null&&!value.forced&&value.ownedProcessesGone===true,'Owned app did not exit normally and cleanly');
 const readyInputMs=ready&&finite(origin)?ready.appliedEpoch-origin:null,deadlineInputMs=deadline&&finite(origin)?deadline.appliedEpoch-origin:null;
 const valid=errors.length===0;
 return{label:FLOOR_LABEL,valid,usableByDeadline:valid&&finite(readyInputMs)&&readyInputMs>=0&&readyInputMs<=value.deadlineMs&&finite(value.firstViewportEpoch)&&value.firstViewportEpoch>=origin&&value.firstViewportEpoch<=ready.appliedEpoch&&value.firstViewportEpoch-origin<=value.deadlineMs,readyInputMs,deadlineInputMs,spawnToReadyInputMs:ready&&finite(value.spawnEpoch)?ready.appliedEpoch-value.spawnEpoch:null,productionAuthorityProven:false,errors};
}
