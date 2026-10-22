import assert from 'node:assert/strict';

// Physical scan completion and a published metadata generation do not establish
// that all prelaunch files have entered the durable namespace. Observe the
// ordinary read-only inventory; never request a rescan, import or query here.
export function fixtureAdmission(entries,expectedPaths){
  assert.ok(Array.isArray(entries),'Normal inventory is an array');
  const seen=new Set(),files=new Set();
  for(const entry of entries){
    assert.equal(typeof entry?.path,'string','Inventory path');
    assert.ok(entry.type==='file'||entry.type==='folder','Inventory kind');
    assert.equal(seen.has(entry.path),false,'Inventory paths are unique');seen.add(entry.path);
    if(entry.type==='file')files.add(entry.path);
  }
  for(const file of files)assert.ok(expectedPaths.has(file),'Initial inventory contains only owned prelaunch fixtures');
  const missing=[...expectedPaths].filter(file=>!files.has(file));
  return {complete:missing.length===0,expectedFiles:expectedPaths.size,admittedFiles:files.size,missingFiles:missing.length,
    admittedRecords:[...files].filter(file=>file.startsWith('Records/')).length,
    admittedExports:[...files].filter(file=>file.startsWith('Export/')).length};
}
export async function awaitFixtureAdmission(c,paths,{timeoutMs=180000,intervalMs=1000,now=Date.now,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),progress=message=>console.info(message)}={}){
  assert.ok(timeoutMs>0&&intervalMs>0&&intervalMs<=1000,'Bounded admission polling');
  const expected=new Set(paths);assert.ok(expected.size>0,'Nonempty fixture inventory');assert.equal(expected.size,paths.length,'Unique expected fixture paths');
  const recordTarget=paths.filter(file=>file.startsWith('Records/')).length,exportTarget=paths.filter(file=>file.startsWith('Export/')).length;
  const start=now(),receipt={name:'initial-read-only-durable-fixture-admission',startedAt:start,timeoutMs,expectedFiles:expected.size,complete:false,samples:[]};
  (c.evidence.preconditions??=[]).push(receipt);
  receipt.initialUi=await c.ui.dom(`const root=document.querySelector('.pane.is-active .bases-session');return {rowcount:root?.querySelector('[role="grid"]')?.getAttribute('aria-rowcount')??null,busy:root?.querySelector('.bases-session-content')?.getAttribute('aria-busy')??null,status:root?.querySelector('.bases-session-status')?.textContent??null};`);
  await c.screenshot('00-initial-admission-state');
  let nextProgress=0;
  for(;;){
    const entries=await c.cdp.evaluate(`window.zorid.list(${JSON.stringify(c.vault)})`);
    const state=fixtureAdmission(entries,expected),elapsedMs=now()-start;
    receipt.samples.push({elapsedMs,...state});
    if(elapsedMs>=nextProgress||state.complete){progress(`Initial fixture admission: ${state.admittedFiles}/${state.expectedFiles} files; Records ${state.admittedRecords}/${recordTarget}; Export ${state.admittedExports}/${exportTarget}; ${elapsedMs}ms`);nextProgress=elapsedMs+10000;}
    assert.ok(elapsedMs<=timeoutMs&&(state.complete||elapsedMs<timeoutMs),`Initial durable admission incomplete at ${elapsedMs}ms: ${state.admittedFiles}/${state.expectedFiles} files, Records ${state.admittedRecords}/${recordTarget}, Export ${state.admittedExports}/${exportTarget}`);
    if(state.complete){receipt.complete=true;receipt.elapsedMs=elapsedMs;return receipt;}
    await pause(Math.min(intervalMs,timeoutMs-elapsedMs));
  }
}
