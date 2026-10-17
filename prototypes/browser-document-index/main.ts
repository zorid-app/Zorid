import {BrowserCoreRuntime} from '../../src/platform/browser-core-runtime.ts';
import {admitBrowserClient} from '../../src/platform/browser-client-admission.ts';
import type {BrowserClientContext} from '../../src/platform/browser-client-admission.ts';
import {defaultBrowserAdapter} from '../../src/platform/browser-default.ts';
import type {BrowserDocumentIndex,BrowserIndexPin,BrowserIndexSnapshot} from '../../src/core/browser-document-index.ts';
import type {VaultAdapter} from '../../src/core/types.ts';
declare const __DOCUMENT_INDEX_SOURCE__:string;
declare const __DOCUMENT_INDEX_MODULE_PATH__:string;
type Index=Omit<BrowserDocumentIndex,'close'>;
interface Session {runtime:BrowserCoreRuntime;consumer:BrowserClientContext;adapter:VaultAdapter;index:Index}
const output=document.getElementById('result')!,identity=document.getElementById('identity')!;
const sessions=new Set<Session>();let active=false,phase='ready';
const binary=new TextEncoder().encode('# Binary-authored\nneedle\n[[Target]]\n');
const original='\ufeff---\r\ntitle: Original\r\n---\r\n# Unicode α\r\n[[Target]]\r\n'+Array.from({length:24},(_,i)=>`needle ${i}\r\n`).join('');
const definition='filters: file.hasLink("Target")\nviews:\n  - type: table\n    name: Links\n    order:\n      - file.path\n      - title\n';
const invalid='---\nlabels: [\n---\n# Broken\n';
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function assert(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
const show=(value:unknown)=>{output.textContent=JSON.stringify(value,null,2);};
function parameters(){const url=new URL(location.href);return {url,database:url.searchParams.get('database'),client:url.searchParams.get('client')};}
function stage(name:string){phase=name;show({status:'running',phase,source:__DOCUMENT_INDEX_SOURCE__});}
async function open(database:string,clientId:string):Promise<Session>{
  const runtime=await BrowserCoreRuntime.open({database,clientId,wasmModuleUrl:new URL(__DOCUMENT_INDEX_MODULE_PATH__,document.baseURI).href,allowNewVault:true,initializeLocal:true,timeoutMs:60000});
  try{const consumer=admitBrowserClient(runtime,{assertOwner:()=>runtime.assertActive()});assert(consumer.documentIndex,'Production worker did not expose shared document index');
    await consumer.documentIndex.initialize();const value={runtime,consumer,adapter:defaultBrowserAdapter(runtime,consumer),index:consumer.documentIndex};sessions.add(value);return value;
  }catch(error){runtime.close();throw error;}
}
async function release(session:Session){try{await session.consumer.release(()=>{});}finally{session.runtime.close();sessions.delete(session);}}
async function releaseAll(){const results=await Promise.allSettled([...sessions].map(release));const failed=results.find(r=>r.status==='rejected');if(failed?.status==='rejected')throw failed.reason;}
async function build(index:Index){let progress=await index.begin();do{progress=await index.pump(progress.stageId);}while(!progress.ready);return index.publish(progress.stageId);}
async function expectedError(action:()=>Promise<unknown>,code:string){try{await action();throw new Error('Expected '+code);}catch(error){assert((error as {code?:string}).code===code,'Expected '+code+', received '+String((error as {code?:string}).code));}}
async function row(session:Session,path:string){const result=await session.runtime.readMetadata(path);assert(result?.entry.kind==='file','Missing fixture file '+path);return result;}
async function sourceBytes(session:Session,path:string){const result=await session.runtime.readEntry(path);assert(result?.bytes instanceof Uint8Array,'Missing committed bytes '+path);return result.bytes;}
async function exact(session:Session,path:string,expected:string|Uint8Array){const actual=await sourceBytes(session,path),bytes=typeof expected==='string'?new TextEncoder().encode(expected):expected;assert(actual.length===bytes.length&&actual.every((v,i)=>v===bytes[i]),'Raw bytes changed for '+path);}
async function search(index:Index,pin:BrowserIndexPin,query:string,limit=1){
  const hits:any[]=[];let cursor:string|undefined;let pages=0;
  do{const page=await index.search({pinId:pin.pinId,query,cursor,limit}) as any;
    assert(same(page.result.snapshot,pin.snapshot),'Search mixed snapshot identity');assert(same(page.result.source,pin.source),'Search mixed source identity');
    assert(page.result.value.next===null,'Private Rust continuation leaked');hits.push(...page.result.value.hits);cursor=page.cursor??undefined;assert(++pages<=100,'Search failed to advance');
    if(!cursor)assert(page.result.value.scanComplete,'Last page did not finish scan');
  }while(cursor);return {hits,pages};
}
async function fingerprint(session:Session){const entries=await session.runtime.inventory();const rows=[];for(const value of entries){let digest:string|null=null;if(value.entry.kind==='file'){
  const bytes=await sourceBytes(session,value.entry.path);digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as Uint8Array<ArrayBuffer>))).map(n=>n.toString(16).padStart(2,'0')).join('');}
  rows.push({entry:value.entry,presentation:value.presentation,digest});}return rows;}
async function persisted(){
  const {database,client}=parameters();assert(database?.startsWith('zorid-core-vault:document-index-')&&client,'Run the fresh suite first');
  const session=await open(database,client);try{const status=await session.index.status();assert(status.snapshot&&status.current&&!status.rebuildRequired,'Persisted generation is not current');
    const pin=await session.index.open(),result=await search(session.index,pin,'Target',10);assert(result.hits.length===1,'Persisted projection query differs');
    await exact(session,'Target.md','Target changed\n');await exact(session,'binary.md',binary);await exact(session,'Links.base','views: [');await session.index.closePin(pin.pinId);
    return {status:'passed',snapshot:status.snapshot,source:status.source,projectionHits:result.hits.length,rawBytesPreserved:true};
  }finally{await release(session);}
}
async function run(){
  await releaseAll();const database='zorid-core-vault:document-index-'+crypto.randomUUID(),client=crypto.randomUUID(),url=new URL(location.href);url.searchParams.set('database',database);url.searchParams.set('client',client);history.replaceState(null,'',url);identity.textContent=database;
  const checks:Record<string,unknown>={},started=performance.now();let currentSnapshot:BrowserIndexSnapshot|undefined;
  stage('open normal workers');const a=await open(database,client),b=await open(database,crypto.randomUUID());
  try{
    stage('committed source commands');await a.adapter.mkdir('Notes');await a.adapter.createText!('Target.md','# Target\n');await a.adapter.createText!('Notes/Source.MD',original);await a.adapter.createText!('Invalid.md',invalid);await a.adapter.createText!('Links.base',definition);await a.adapter.createBinary!('binary.md',binary);
    await exact(a,'Notes/Source.MD',original);await exact(a,'binary.md',binary);const source=await row(a,'Notes/Source.MD'),target=await row(a,'Target.md'),base=await row(a,'Links.base'),bad=await row(a,'Invalid.md');
    const rawBefore=await fingerprint(a);stage('Rust generation publication');currentSnapshot=await build(a.index);assert(same(rawBefore,await fingerprint(a)),'Index build changed raw source');const old=await a.index.open();
    stage('shared metadata, graph, Base and 24-page literal traversal');const initial=await search(a.index,old,'needle');assert(initial.hits.length===24&&initial.pages>=24,'Literal pagination lost hits');assert(initial.hits.every(hit=>hit.entry.id===source.entry.id),'Authored binary was indexed as text');
    const metadata=await a.index.metadata({pinId:old.pinId,id:source.entry.id}) as any;assert(metadata.value.metadata.headings[0].text==='Unicode α','Shared metadata extraction differs');assert(metadata.value.metadata.properties.find((p:any)=>p.key==='title').value==='Original','Metadata properties differ');
    const invalidMetadata=await a.index.metadata({pinId:old.pinId,id:bad.entry.id}) as any;assert(invalidMetadata.value.metadata.diagnostics.length>0,'Invalid frontmatter lost its diagnostics');await exact(a,'Invalid.md',invalid);
    const binaryMetadata=await a.index.metadata({pinId:old.pinId,id:(await row(a,'binary.md')).entry.id}) as any;assert(binaryMetadata.value.exclusion==='binary'&&binaryMetadata.value.metadata===null,'Binary mode acquired Markdown facts');
    const links=await a.index.backlinks({pinId:old.pinId,targetId:target.entry.id,limit:100}) as any;assert(links.result.value.edges.length===1&&links.result.value.edges[0].source.id===source.entry.id,'Rust backlinks differ');
    const resolved=await a.index.resolve({pinId:old.pinId,sourceId:source.entry.id,destination:'Target'}) as any[];assert(resolved[0].id===target.entry.id,'Rust resolver differs');
    const baseResult=await a.index.base({pinId:old.pinId,id:base.entry.id,viewName:'Links',options:{clockMs:0,timezone:'UTC'}}) as any;assert(baseResult.value.result.rows.length===1&&baseResult.value.result.rows[0].entryId===source.entry.id,'Generation-bound Base graph query differs');
    checks.initial={snapshot:old.snapshot,source:old.source,coverageComplete:old.coverageComplete,hits:initial.hits.length,pages:initial.pages,metadata:true,backlinks:true,base:true};
    stage('edit and retained definition projection');const edited=original.replace('Original','Edited')+'changed needle\n';await a.adapter.write('Notes/Source.MD',edited);await a.adapter.write('Links.base','filters: false\nviews:\n  - type: table\n    name: Links\n    order: [file.path]\n');assert(!(await a.index.status()).current,'Stale source reported current');await build(a.index);const fresh=await a.index.open();
    assert((await search(a.index,old,'needle')).hits.length===24,'Old generation read current source');assert((await search(a.index,fresh,'needle')).hits.length===25,'Edited generation missed new source');
    assert((await a.index.base({pinId:old.pinId,id:base.entry.id,viewName:'Links'}) as any).value.result.rows.length===1,'Old Base definition read current bytes');assert((await a.index.base({pinId:fresh.pinId,id:base.entry.id,viewName:'Links'}) as any).value.result.rows.length===0,'New Base definition was not indexed');
    stage('lost publication acknowledgement cleanup');const publishedBefore=await a.index.status();await a.index.discard(old.snapshot.generationEpoch);await expectedError(()=>b.index.discard(old.snapshot.generationEpoch),'index_stage_expired');assert(same(publishedBefore,await a.index.status()),'Published-stage discard changed current status');assert((await search(a.index,old,'needle')).hits.length===24,'Published-stage discard expired retained pin');checks.publishedDiscardNoop=true;
    stage('stable identity move and deletion');await a.adapter.rename('Notes/Source.MD','Notes/Renamed.MD');assert((await row(a,'Notes/Renamed.MD')).entry.id===source.entry.id,'Move changed identity');await build(a.index);const moved=await a.index.open();assert((await search(a.index,moved,'needle')).hits.every(h=>h.entry.path==='Notes/Renamed.MD'),'Moved generation retained old path');
    await a.adapter.remove!('Notes/Renamed.MD',true);await build(a.index);const deleted=await a.index.open();assert((await search(a.index,deleted,'needle')).hits.length===0,'Deleted source remained current');assert((await search(a.index,old,'needle')).hits.length===24,'Delete destroyed pinned text projection');
    await a.index.closePin(fresh.pinId);await a.index.closePin(moved.pinId);await a.index.closePin(deleted.pinId);checks.retainedEditMoveDelete=true;
    stage('source publication CAS and explicit rebuild');const stale=await a.index.begin();await a.index.pump(stale.stageId);await a.adapter.write('Target.md','Target changed\n');await expectedError(()=>a.index.publish(stale.stageId),'index_source_changed');await a.index.discard(stale.stageId);const before=await fingerprint(a);await a.index.rebuild();await expectedError(()=>a.index.metadata({pinId:old.pinId,id:source.entry.id}),'index_snapshot_expired');assert(same(before,await fingerprint(a)),'Rebuild changed raw source');await build(a.index);checks.sourceCasRebuildExpiry=true;
    stage('concurrent index publication');const sa=await a.index.begin(),sb=await b.index.begin();await a.index.pump(sa.stageId);await b.index.pump(sb.stageId);await a.index.publish(sa.stageId);await expectedError(()=>b.index.publish(sb.stageId),'index_head_changed');await b.index.discard(sb.stageId);checks.concurrentPublication=true;
    stage('invalid Base source remains durable');await a.adapter.write('Links.base','views: [');await build(a.index);const malformed=await a.index.open();await expectedError(()=>a.index.base({pinId:malformed.pinId,id:base.entry.id}),'index_base_compile');await exact(a,'Links.base','views: [');await a.index.closePin(malformed.pinId);
    currentSnapshot=(await a.index.status()).snapshot!;checks.invalidBasePreserved=true;
  }finally{await releaseAll();}
  stage('fresh worker cache restore');checks.restart=await persisted();const manifest=await fetch(new URL('manifest.json',new URL(__DOCUMENT_INDEX_MODULE_PATH__,document.baseURI))).then(r=>r.json());
  return {status:'passed',fixtureSource:__DOCUMENT_INDEX_SOURCE__,wasm:manifest,browser:navigator.userAgent,database,elapsedMs:Math.round(performance.now()-started),snapshot:currentSnapshot,checks};
}
function action(id:string,task:()=>Promise<unknown>){document.getElementById(id)!.addEventListener('click',async()=>{if(active)return;active=true;document.querySelectorAll('button').forEach(button=>button.disabled=true);
  try{show(await task());}catch(error){show({status:'failed',phase,fixtureSource:__DOCUMENT_INDEX_SOURCE__,code:(error as {code?:string}).code??'assertion',message:String((error as Error).message),details:(error as {details?:unknown}).details});try{await releaseAll();}catch{/* Preserve first failure evidence. */}}
  finally{active=false;document.querySelectorAll('button').forEach(button=>button.disabled=false);}
});}
action('run',run);action('persisted',persisted);action('release',async()=>{await releaseAll();return {status:'released'};});
window.addEventListener('pagehide',()=>{for(const session of sessions)session.runtime.close();sessions.clear();},{once:true});
identity.textContent=parameters().database??'Fresh disposable vault is selected when the suite starts.';
