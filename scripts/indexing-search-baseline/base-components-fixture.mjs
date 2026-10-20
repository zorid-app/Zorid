import {BrowserCoreRuntime} from '/src/platform/browser-core-runtime.ts';
import {admitBrowserClient} from '/src/platform/browser-client-admission.ts';
import {defaultBrowserAdapter} from '/src/platform/browser-default.ts';
import {Vault} from '/src/core/vault.ts';
import {NoteBuffer} from '/src/ui/note-buffer.ts';
import {createBaseSession} from '/src/bases/session.ts';
import {sharedBasePreview} from '/src/bases/shared-query.ts';
const check=(value,message)=>{if(!value)throw Error(message);};
const equal=(a,b,message)=>check(JSON.stringify(a)===JSON.stringify(b),message);
const definition='000-work.base',selected='Notes/Note-0000.md';
const base='formulas:\n  clock: now().format("YYYY-MM-DD HH:mm:ss")\n  day: today().format("YYYY-MM-DD")\nviews:\n  - type: table\n    name: Notes\n    filters: rank >= 0\n    order: [file.name, status]\n  - type: table\n    name: Clock\n    filters: file.path == "Notes/Note-0000.md"\n    order: [file.name, formula.clock, formula.day]\n';
const note=(i,status='ready')=>{const prefix=`---\nrank: ${i}\nstatus: ${status}\n---\n# Note ${i}\n`;return prefix+'ordinary filler\n'.repeat(Math.floor((1024-prefix.length)/16))+'\n';};
const filename=i=>`Notes/Note-${String(i).padStart(4,'0')}.md`;
const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
const utf8=new TextEncoder(),text=new TextDecoder('utf-8',{fatal:true});
const delay=()=>new Promise(resolve=>setTimeout(resolve,25));
function clockHost(){
 let now=1710046799999;const zone='America/Toronto',timers=new Set(),wakes=new Set(),captures=[];
 const host={capture(configured){const value={clockMs:now,timezone:configured?.trim()||zone};captures.push(value);return value;},isVisible:()=>true,
  scheduleAt(at,run){const timer={at,run};timers.add(timer);return()=>timers.delete(timer);},subscribeWake(run){wakes.add(run);return()=>wakes.delete(run);}};
 return {host,captures,timers,wakes,tick(value){now=value;for(const timer of [...timers])if(timer.at<=now){timers.delete(timer);timer.run();}},get now(){return now;}};
}
window.baseRun=async config=>{
 const result={mode:config.mode,status:'running',clockScope:'injected existing BaseClockHost seam; actual Rust evaluation and DOM; no OS clock change',observations:[],source:[],release:[]};window.__baseProgress={mode:config.mode,phase:'open'};window.__baseResult=null;
 let runtime,consumer,vault,session;const buffers=new Map(),started=performance.now();let closed=false;
 const until=async(condition,message)=>{while(performance.now()-started<config.timeoutMs-5000){if(condition())return;await delay();}throw Error(message);};
 try{
  runtime=await BrowserCoreRuntime.open({database:config.database,clientId:config.clientId,wasmModuleUrl:location.origin+'/__base/zorid_wasm.js',allowNewVault:true,initializeLocal:true,...(config.mode==='component'?{documentMaintenance:true}:{}),timeoutMs:120000});
  consumer=admitBrowserClient(runtime,{assertOwner:()=>runtime.assertActive()});const adapter=defaultBrowserAdapter(runtime,consumer),service=adapter.documentSemantics;check(service,'Actual document service missing');result.scope=consumer.scope;
  async function sourceRow(path,expected){const row=await runtime.readEntry(path);check(row?.bytes instanceof Uint8Array&&text.decode(row.bytes)===expected,'Exact retained source mismatch '+path);return {path,id:row.entry.id,revision:row.entry.revision,bytes:row.bytes.length,sha256:await hash(row.bytes)};}
  if(config.mode==='seed'){
   check(!service.maintenance,'Seed must not enable indexing policy');await adapter.mkdir('Notes');await adapter.createText(definition,base);result.source.push(await sourceRow(definition,base));
   for(let i=0;i<config.notes;i++){await adapter.createText(filename(i),note(i));result.source.push(await sourceRow(filename(i),note(i)));window.__baseProgress={mode:config.mode,phase:'seed',files:i+1,total:config.notes};}
   result.index=await service.status();check(result.index.snapshot===null,'D-off seed unexpectedly created a derived index');
  }else{
   check(service.maintenance&&service.basePreviewAvailable===true,'Positive real maintenance/preview unavailable');
   vault=new Vault(adapter);await vault.initialize();const injected=clockHost(),host=document.querySelector('#base');let partial,prior,observerFailure;
   const observationsHealthy=()=>{if(observerFailure)throw observerFailure;};
   const observe=state=>{try{
    const projected=state.result,preview=projected&&sharedBasePreview(projected),content=host.querySelector('.bases-session-content'),table=host.querySelector('.zorid-bases-table');
    const row={elapsedMs:performance.now()-started,updating:state.updating,error:state.error?.message??null,status:host.querySelector('.bases-session-status')?.textContent??null,busy:content?.getAttribute('aria-busy')??null,rows:projected?.rows.length??null,preview:preview?{complete:preview.complete,aggregatesComplete:preview.aggregatesComplete,countsScope:preview.countsScope,progress:preview.progress}:null,snapshot:projected?.shared?.snapshotId??null};
    if(result.observations.length<1000)result.observations.push(row);window.__baseProgress={mode:config.mode,phase:'component',last:row};
    if(preview){check(preview.complete===false&&preview.aggregatesComplete===false&&preview.countsScope==='preparedSubset','Partial result claims complete counts');check(!('snapshotId' in projected.shared),'Partial result exposes a published snapshot');check(/Read-only preview/.test(row.status)&&/Counts and aggregates cover indexed notes only/.test(row.status),'Partial DOM wording missing');check(!content.querySelector('input:not([type="checkbox"]),textarea,[contenteditable="true"],[draggable="true"]'),'Partial DOM exposes editing');check([...content.querySelectorAll('input[type="checkbox"]')].every(x=>x.disabled),'Partial checkbox is writable');check(!host.querySelector('button[aria-label="View options"]'),'Partial configuration edits exposed');if(projected.rows.length===0){check(/No matches in indexed notes yet/.test(content.textContent),'Empty preview makes a global absence claim');}else{check(content&&table&&content.getClientRects().length>0&&table.getClientRects().length>0,'Nonempty partial table is not rendered');if(preview.progress.pendingFiles>0&&!partial)partial=row;}}
    if(prior&&state.updating&&projected===prior.result){check(table===prior.table,'Prior coherent table replaced during refresh');check(content.textContent===prior.text,'Prior coherent rows changed during refresh');result.priorRowsRetained=row;}
   }catch(error){observerFailure??=error;result.observerFailure={message:String(error?.message??error),stack:error?.stack};}};
   session=createBaseSession(host,{vault,basePath:definition,query:{timezone:'America/Toronto'},clock:injected.host,validate(){check(!closed,'Retired component');},openFile(){},onState:observe,onError:error=>{result.componentError=String(error);},buffers:{validate(){check(!closed,'Retired buffer');},async getBuffer(path){let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path,{debounceMs:60000});buffers.set(path,buffer);}return buffer;}}});
   await session.ready;observationsHealthy();check(!session.state.error,'First-build Base failed');check(partial,'Inconclusive: core finished before an actual partial read-only DOM witness');result.partial=partial;
   check(!sharedBasePreview(session.state.result)&&session.state.result.rows.length===config.notes,'Complete publication omitted rows');check(host.querySelector('button[aria-label="View options"]')?.disabled===false,'Published configuration actions did not return');
   const cell=host.querySelector(`[role="gridcell"][data-path="${selected}"][data-property="note.status"]`);check(cell,'Published status cell missing');cell.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));check(cell.querySelector('input'),'Published edit affordance unavailable');cell.querySelector('input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));result.publishedSnapshot=session.state.result.shared.snapshotId;
   prior={result:session.state.result,table:host.querySelector('.zorid-bases-table'),text:host.querySelector('.bases-session-content').textContent};
   await vault.modify(selected,note(0,'changed'),{expectedContent:note(0)});const changed=await sourceRow(selected,note(0,'changed'));result.changed=changed;await session.refresh();await until(()=>!session.state.updating&&session.state.result!==prior.result,'Refreshed Base did not settle');observationsHealthy();
   check(result.priorRowsRetained,'No coherent prior rows were observed during the actual source refresh');check(!session.state.error,'Real source refresh failed');check(host.querySelector(`[data-path="${selected}"][data-property="note.status"]`)?.textContent.includes('changed'),'Changed source value not visible');check(JSON.stringify(session.state.result.shared.snapshotId)!==JSON.stringify(result.publishedSnapshot),'Changed source did not advance generation');result.refreshedSnapshot=session.state.result.shared.snapshotId;
   prior=null;await session.selectView(1);observationsHealthy();const stableSnapshot=session.state.result.shared.snapshotId;
   const values=()=>({clock:host.querySelector('[data-property="formula.clock"][role="gridcell"]')?.textContent,day:host.querySelector('[data-property="formula.day"][role="gridcell"]')?.textContent});
   const before=values();check(before.clock==='2024-03-09 23:59:59'&&before.day==='2024-03-09','Selected Toronto before-midnight DOM differs');check(injected.timers.size===1,'Time-dependent view did not schedule its real core hint');result.clock={before,snapshot:stableSnapshot,samples:[]};
   for(const [at,clock,day]of [[1710046800000,'2024-03-10 00:00:00','2024-03-10'],[1710046801000,'2024-03-10 00:00:01','2024-03-10']]){injected.tick(at);await until(()=>!session.state.updating&&values().clock===clock&&values().day===day,'Actual rendered clock did not refresh from its scheduled callback');observationsHealthy();equal(session.state.result.shared.snapshotId,stableSnapshot,'Time refresh changed source generation');result.clock.samples.push({at,...values(),hint:session.state.result.shared.refreshHint});}
   check(injected.captures.every(c=>c.timezone==='America/Toronto'),'Configured timezone was dropped');result.clock.captures=injected.captures;
   for(let i=0;i<config.notes;i++)result.source.push(await sourceRow(filename(i),note(i,i===0?'changed':'ready')));result.source.push(await sourceRow(definition,base));
   await session.close();session=null;check(injected.timers.size===0&&injected.wakes.size===0,'Closed component left clock ownership');result.clock.closedWithoutTimers=true;observationsHealthy();check(!result.componentError,'Component reported an error: '+result.componentError);
  }
  result.status='passed';
 }catch(error){result.status='failed';result.error={message:String(error?.message??error),stack:error?.stack};}
 finally{
  for(const [resource,release]of [['session',async()=>{await session?.close();session=null;}],['buffers',async()=>{for(const buffer of buffers.values())await buffer.dispose();}],['metadata',()=>vault?.closeMetadataProjection()],['client',()=>consumer?.release(()=>{})]])try{await release();result.release.push({resource,acknowledged:true});}catch(error){result.status='failed';result.release.push({resource,acknowledged:false,error:String(error)});}
  closed=true;runtime?.close();result.elapsedMs=performance.now()-started;result.finished=true;document.querySelector('#result').textContent=JSON.stringify({status:result.status,error:result.error},null,2);window.__baseResult=result;
 }
};
