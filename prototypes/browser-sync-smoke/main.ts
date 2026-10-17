import { BrowserCoreRuntime } from '../../src/platform/browser-core-runtime.ts';
const el=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const output=el<HTMLPreElement>('result');
const show=(value:unknown)=>{output.textContent=JSON.stringify(value,null,2);};
const url=new URL(location.href);
if(!url.searchParams.has('database'))url.searchParams.set('database',`zorid-core-vault:smoke-${crypto.randomUUID()}`);
if(!url.searchParams.has('client'))url.searchParams.set('client',crypto.randomUUID());
history.replaceState(null,'',url);
const database=url.searchParams.get('database')!,clientId=url.searchParams.get('client')!;
el('identity').textContent=`Database: ${database}; client: ${clientId}`;
const peer=new URL(url);peer.searchParams.set('database',`zorid-core-vault:smoke-${crypto.randomUUID()}`);peer.searchParams.set('client',crypto.randomUUID());
el<HTMLAnchorElement>('peer').href=peer.href;
let runtime:BrowserCoreRuntime|undefined;
let active=false;
let diagnosticPhase='open';
const failure=(error:any)=>({status:'failed',code:typeof error?.code==='string'?error.code:'operation_failed',phase:diagnosticPhase,invariant:typeof error?.details?.invariant==='string'?error.details.invariant:undefined,message:error?.code==='storage_corrupt'?error.message:undefined});
function action(id:string,run:()=>Promise<unknown>){el<HTMLButtonElement>(id).onclick=async()=>{
  if(active)return;active=true;diagnosticPhase=id;
  try{if(!runtime)throw new Error('not_open');show(await run());}
  catch(error){show(failure(error));}
  finally{active=false;}
};}
const rows=async()=> (await runtime!.inventory()).map(({entry,presentation})=>({...entry,size:presentation.size_bytes}));
async function submit(mutation:unknown,create_mode:'text'|'binary'|null=null){
  const intentId=crypto.randomUUID();
  diagnosticPhase='prepare_family';
  await runtime!.prepareFamily(intentId,JSON.stringify({version:1,request:{operation_id:intentId,mutation},create_mode}));
  diagnosticPhase='commit_family';
  const receipt=await runtime!.commit(intentId);
  diagnosticPhase='ack_family';
  await runtime!.acknowledge(intentId,{status:'committed',receipt});
  diagnosticPhase='post_ack_inventory';
  return {status:'committed',files:await rows()};
}
const selected=async()=>{const row=await runtime!.readEntry(el<HTMLInputElement>('path').value);if(!row)throw new Error('missing_path');return row;};
async function save(bytes:Uint8Array,mode:'text'|'binary'){
  const path=el<HTMLInputElement>('path').value;
  diagnosticPhase='save_read_existing';
  const prior=await runtime!.readEntry(path);
  const mutation=prior?{type:'write',id:prior.entry.id,expected:prior.entry.revision,content:Array.from(bytes)}:
    {type:'create',id:crypto.randomUUID(),path,kind:'file',content:Array.from(bytes)};
  return submit(mutation,prior?null:mode);
}
action('configure',async()=>{
  const input=el<HTMLInputElement>('credentials'),file=input.files?.[0];
  if(!file||file.size>16384)throw new Error('invalid_credentials_file');
  let raw:any;let key:Uint8Array|undefined;
  try{
    raw=JSON.parse(await file.text());
    const rpc=raw.version===2&&raw.transport==='grpc',legacy=raw.version===1&&raw.transport===undefined;
    if((!rpc&&!legacy)||typeof raw.key_base64!=='string')throw new Error('invalid_credentials');
    key=Uint8Array.from(atob(raw.key_base64),c=>c.charCodeAt(0));
    await runtime!.configureSyncFixture({...(rpc?{version:2,transport:'grpc'}:{}),endpoint:raw.endpoint,realmId:raw.realm_id,vaultId:raw.vault_id,serverEpoch:raw.server_epoch,keyEpoch:raw.key_epoch,bearerToken:raw.bearer_token,keyBytes:key,allowLoopbackHttp:true,enrollEmpty:true});
    return {status:'configured',files:await rows()};
  }finally{key?.fill(0);if(raw){raw.bearer_token='';raw.key_base64='';}input.value='';}
});
action('sync',async()=>({sweep:await runtime!.syncOnce(),files:await rows()}));
action('list',rows);
action('save',()=>save(new TextEncoder().encode(el<HTMLTextAreaElement>('text').value),'text'));
action('save-binary',async()=>{const file=el<HTMLInputElement>('binary').files?.[0];if(!file||file.size>512*1024)throw new Error('binary_fixture_limit');return save(new Uint8Array(await file.arrayBuffer()),'binary');});
action('folder',()=>submit({type:'create',id:crypto.randomUUID(),path:el<HTMLInputElement>('path').value,kind:'folder',content:null}));
action('move',async()=>{const row=await selected();return submit({type:'move',id:row.entry.id,expected:row.entry.revision,path:el<HTMLInputElement>('destination').value});});
action('delete',async()=>{const row=await selected();return submit({type:'delete',id:row.entry.id,expected:row.entry.revision,recursive:el<HTMLInputElement>('recursive').checked});});
action('read',async()=>{const row=await runtime!.readEntry(el<HTMLInputElement>('path').value);if(!row)return {missing:true};const bytes=row.bytes??new Uint8Array();let text:string|undefined;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);el<HTMLTextAreaElement>('text').value=text;}catch{}const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(bytes)))).map(b=>b.toString(16).padStart(2,'0')).join('');return {entry:row.entry,byteLength:bytes.length,sha256:digest,text,firstBytes:Array.from(bytes.slice(0,64))};});
action('recover',async()=>{let settled=0;for(const intent of await runtime!.intents()){if(intent.acknowledged)continue;if(intent.status==='committed'&&intent.receipt){await runtime!.acknowledge(intent.intent_id,{status:'committed',receipt:intent.receipt});settled++;}else if(intent.status==='rejected'&&intent.error){await runtime!.acknowledge(intent.intent_id,{status:'rejected',error:intent.error});settled++;}}return {settled,files:await rows()};});
el('reload').onclick=()=>location.reload();
window.addEventListener('pagehide',()=>runtime?.close());
void BrowserCoreRuntime.open({database,clientId,allowNewVault:true,wasmModuleUrl:new URL('lib/core/zorid_wasm.js',location.href).href,timeoutMs:60000})
.then(value=>{runtime=value;show({status:'open',database,clientId});})
.catch(error=>show({...failure(error),status:'open_failed'}));
