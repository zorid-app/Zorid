import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
/** Passive renderer attachment is independent of main startup. Join both before
 * foregrounding or native instrumentation, and join failures before cleanup. */
export async function observeEarly(hooks){
  const results=await Promise.allSettled([(async()=>{const main=await hooks.connectMain();await hooks.installLifecycle?.(main);return main;})(),(async()=>{const renderer=await hooks.connectRenderer();await hooks.installObserver(renderer);return renderer;})()]);
  const failures=results.filter(value=>value.status==='rejected');if(failures.length===1)throw failures[0].reason;if(failures.length)throw new AggregateError(failures.map(value=>value.reason),'Early attachment failures: '+failures.map(value=>String(value.reason)).join('; '));
  const [main,renderer]=results.map(value=>value.value);if(hooks.measured!==false)await hooks.foreground();await hooks.installNativeObserver(main);return {main,renderer};
}
/** Lightweight actual-process proof before any native module instrumentation. */
export function authenticateMain(config){
  const builtin=name=>process.getBuiltinModule?process.getBuiltinModule(name):require(name),req=builtin('module').createRequire(process.resourcesPath+'/app.asar/package.json'),{app}=req('electron');
  if(process.pid!==config.pid||process.execPath!==config.executable||!app.isPackaged||app.getAppPath()!==config.appPath||app.getPath('userData')!==config.profile||process.env.ZORID_LOCAL_DATA_DIR!==config.localDataDirectory)throw Error('Early packaged main scope differs');
  globalThis.__zoridPackagedQuit=()=>app.quit();
  return {pid:process.pid,packaged:app.isPackaged,appPath:app.getAppPath(),userData:app.getPath('userData'),electron:process.versions.electron,authenticatedAt:performance.now()};
}
export function validateEmptyWarmEvidence(value){
  assert.ok(value?.scope&&['vaultId','clientId'].every(key=>typeof value.scope[key]==='string'&&value.scope[key].length>0&&value.scope[key].length<=256),'Missing actual warm native scope');
  for(const key of ['entries','unacknowledged','draftKeys'])assert.ok(Array.isArray(value[key])&&value[key].length===0,'Warm '+key+' is not empty');
  assert.ok(Array.isArray(value.checkpoints?.items)&&value.checkpoints.items.length===0&&value.checkpoints.cursor===null,'Warm checkpoints not completely empty');
  assert.ok(value.independent?.independentJournal===true&&value.independent.schemaVersion===1&&value.independent.ok===true&&Array.isArray(value.independent.value)&&value.independent.value.length===0,'Warm independent live inventory not empty/confirmed');
  return {scope:{...value.scope},entries:0,checkpoints:0,independentLive:0,unacknowledged:0,draftKeys:0};
}
export async function emptyWarmEvidence(vault){
  if((await window.zorid.getVault())?.path!==vault)throw Error('Warm selected vault differs');
  const context=await window.zorid.getDurableContext(vault),grant=context?.independentJournal;
  if(!context?.admissionId||!grant?.token||grant.scope?.vaultId!==context.scope?.vaultId||grant.scope?.clientId!==context.scope?.clientId)throw Error('Warm native/journal scope unavailable');
  const [entries,checkpoints,unacknowledged,independent]=await Promise.all([
    window.zorid.list(vault),window.zorid.durableInvoke(vault,context.admissionId,'checkpoints.list',[{limit:1}]),
    window.zorid.durableInvoke(vault,context.admissionId,'listUnacknowledged',[]),window.zorid.independentJournal({vault,token:grant.token,op:'list',args:[]}),
  ]);
  return {scope:context.scope,entries,checkpoints,unacknowledged,independent,draftKeys:Object.keys(localStorage).filter(key=>key.startsWith('zorid:draft:'))};
}
async function ownedDirectory(directory){const info=await fs.lstat(directory);assert.ok(info.isDirectory()&&!info.isSymbolicLink()&&info.uid===process.getuid(),'Unsafe owned directory');assert.equal(await fs.realpath(directory),directory,'Aliased preparation directory');}
async function inventory(directory){
  const rows=[];
  async function visit(place){for(const name of (await fs.readdir(place)).sort()){
    const file=path.join(place,name),info=await fs.lstat(file);assert.ok(!info.isSymbolicLink()&&info.uid===process.getuid()&&(info.isDirectory()||info.isFile()),'Unsafe native state member');
    rows.push({path:path.relative(directory,file),directory:info.isDirectory(),bytes:info.size,dev:info.dev,ino:info.ino,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs});assert.ok(rows.length<=4096,'Warm state inventory limit');if(info.isDirectory())await visit(file);
  }}
  await visit(directory);return rows;
}
/** Caller owns a fresh0700 campaign and already joined normal app/native exit.
 * Validate ALL surfaces before deleting anything. Keep the Chromium profile. */
export async function resetEmptyWarmState({pair,evidence,cleanup,remaining,diskJournal}){
  const empty=validateEmptyWarmEvidence(evidence);
  assert.ok(cleanup?.normal===true&&cleanup.gone===true&&cleanup.forced===false&&cleanup.nativeNormal===true&&Array.isArray(cleanup.remaining)&&cleanup.remaining.length===0&&Array.isArray(remaining)&&remaining.length===0,'Warm owner not normally gone');
  assert.ok(diskJournal?.status==='not-observed'&&Array.isArray(diskJournal.rows)&&diskJournal.rows.length===0,'Warm disk draft heads not empty');
  assert.equal(path.dirname(pair.campaign),'/private/tmp');assert.ok(path.basename(pair.campaign).startsWith('zorid-packaged-startup-'));assert.equal(path.dirname(pair.directory),pair.campaign);assert.match(path.basename(pair.directory),/^(baseline|candidate)-[1-9][0-9]*$/);
  for(const [key,name]of [['vault','vault'],['profile','profile'],['data','app-data']])assert.equal(pair[key],path.join(pair.directory,name),'Foreign preparation surface');
  for(const directory of [pair.campaign,pair.directory,pair.vault,pair.profile,pair.data])await ownedDirectory(directory);
  const registry=JSON.parse(await fs.readFile(path.join(pair.profile,'client-slots.json'),'utf8'));assert.ok(registry?.version===1&&Array.isArray(registry.slots)&&registry.slots.length===1,'Unexpected warm client registry');const slot=registry.slots[0];assert.ok(slot.slotId==='primary'&&slot.clientId===evidence.scope.clientId&&slot.vaultPath===pair.vault&&slot.restore===true,'Warm primary profile owner differs');
  assert.deepEqual(await fs.readdir(pair.vault),['.zorid'],'Warm vault has unexpected source/private files');const privateDirectory=path.join(pair.vault,'.zorid');await ownedDirectory(privateDirectory);
  const journalDirectory=path.join(pair.profile,'draft-journal-v2');await ownedDirectory(journalDirectory);const journal=await inventory(journalDirectory);assert.ok(journal.every(row=>row.directory?['branches','retired-trash'].includes(row.path):row.path==='FORMAT'),'Warm journal contains retained/unknown work');
  const native=await inventory(privateDirectory),local=await inventory(pair.data);
  assert.ok(native.some(row=>row.path==='vault.sqlite'&&!row.directory),'Warm authority missing');
  // Re-read the manifest immediately before deletion; an unexpected change aborts.
  assert.deepEqual(await inventory(privateDirectory),native);assert.deepEqual(await inventory(pair.data),local);
  await fs.rm(privateDirectory,{recursive:true});for(const name of await fs.readdir(pair.data))await fs.rm(path.join(pair.data,name),{recursive:true});
  assert.deepEqual(await fs.readdir(pair.vault),[]);assert.deepEqual(await fs.readdir(pair.data),[]);
  return {empty,removed:[privateDirectory,...local.filter(row=>!row.path.includes(path.sep)).map(row=>path.join(pair.data,row.path))],nativeInventory:native,localInventory:local,journalInventory:journal,freshBeforeFixtures:true,profilePreserved:true};
}

export function assertFreshNativeScope(previous,current){assert.ok(current&&typeof current.vaultId==='string'&&current.vaultId&&current.vaultId!==previous.vaultId,'Measured Native authority was reused');assert.equal(current.clientId,previous.clientId,'Prepared profile client identity changed');}
