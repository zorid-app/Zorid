import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { openNativeMobileVault, type NativeVaultPlugin, type MobileLifecycleReason } from '../src/platform/mobile-native.ts';

const clientId = 'a1b2c3d4-abcd-4abc-8abc-abcdef012345';
const token = 'b2c3d4e5-bcde-4bcd-9bcd-bcdef0123456';
const encoder = new TextEncoder(), decoder = new TextDecoder();
const body = (text: string) => btoa(String.fromCharCode(...encoder.encode(text)));
function scanStatus(overrides:Record<string,unknown>={}) { return {scanId:'scan_fixture',complete:true,scanComplete:true,finished:true,observed:1,imported:1,namespaceApplied:0,issueCount:0,issuesTruncated:false,issues:[],...overrides}; }
function fixture() {
  const requests: any[] = [], heads = new Map<string, any>(), intents = new Map<string, any>(), receipts = new Map<string, any>();
  let content = 'before', revision = 'rev1', path = 'Note.md', exists = true, closes = 0, sequence = 0, active = 0, maxActive = 0;
  let failCommand = false, failCheckpoint = false, failCommit = false, wrongId = false, failReleaseAck = false, failReleaseDispatch = false;
  let activeLease: {local_store_id:string;client_id:string;token:string} | undefined, claims=0;
  const releasedLeases=new Map<string,any>();
  let injectedError: {method:string;error:any;after:boolean} | undefined;
  const state = () => ({ id:'entry', path, kind:'file', revision, deleted:false });
  const presentation = () => ({id:'entry',ctime_ms:1,mtime_ms:2,size_bytes:encoder.encode(content).length});
  const acks: {id:string;ok:boolean}[] = [], lifecycleOrder: string[] = [], expired = new Set<string>();
  const lifecycleCallbacks=new Set<(event:{id:string;reason:MobileLifecycleReason})=>void>();let removals = 0;
  let contextEvent: MobileLifecycleReason | undefined, wrongAuthority = false;
  let ackHook: ((input:{id:string;ok:boolean})=>Promise<void>) | undefined;
  let initialReconciliation: any = undefined, refreshValue: any = {reconciliation:scanStatus()}, refreshCalls=0;
  let refreshHook: (()=>Promise<void>) | undefined;
  const plugin: NativeVaultPlugin & {close():Promise<void>} = {
    async addListener(event,handler) { assert.equal(event,'lifecycleRequest'); lifecycleOrder.push('listen'); lifecycleCallbacks.add(handler); return {remove:async()=>{removals++; lifecycleOrder.push('remove'); lifecycleCallbacks.delete(handler);}}; },
    async lifecycleAck(input) { acks.push(input); lifecycleOrder.push(input.ok?'ack:true':'ack:false'); if(ackHook)await ackHook(input); if(expired.has(input.id))throw Object.assign(new Error('deadline expired'),{code:'stale_lifecycle'}); },
    context: async () => { lifecycleOrder.push('context'); if(contextEvent)for(const callback of lifecycleCallbacks)callback({id:crypto.randomUUID(),reason:contextEvent}); return {name:'Native fixture',clientId,...(initialReconciliation===undefined?{}:{reconciliation:initialReconciliation})}; }, close: async () => { closes++; },
    async refresh() { active++;maxActive=Math.max(maxActive,active);refreshCalls++;try {if(refreshHook)await refreshHook();await new Promise<void>(r=>setImmediate(r));return refreshValue;}finally{active--;} },
    async request(input) {
      active++; maxActive = Math.max(maxActive,active);
      await new Promise(resolve => setImmediate(resolve));
      const header = JSON.parse(input.header), c = header.command; requests.push({ ...header,body:input.body });
      const errorReply=(error:any)=>({header:JSON.stringify({version:1,request_id:header.request_id,ok:false,error}),body:''});
      const reject=(code:string)=>errorReply({code,message:'Native host request rejected',commit_uncertain:false});
      let result: any = {}, output = '';
      try {
        if (header.lease && (!activeLease || JSON.stringify(header.lease)!==JSON.stringify(activeLease))) return reject('client_not_admitted');
        if (header.lease && ['claim_client','release_client'].includes(c.method)) return reject('client_operation_unsupported');
        if (!['claim_client','release_client'].includes(c.method)) assert.deepEqual(header.lease,activeLease);
        if(injectedError?.method===c.method&&!injectedError.after){const error=injectedError.error;injectedError=undefined;return errorReply(error);}
        switch (c.method) {
          case 'claim_client':
            if(activeLease)return reject('client_in_use');
            activeLease={local_store_id:'store',client_id:clientId,token:claims++===0?token:crypto.randomUUID()};
            result = {lease:activeLease}; break;
          case 'identity': result = {identity:{local_store_id:wrongAuthority?'wrong':'store'}}; break;
          case 'release_client': {
            if(failReleaseDispatch){failReleaseDispatch=false;throw new Error('release transport failed before dispatch');}
            if(activeLease && JSON.stringify(activeLease)===JSON.stringify(c.reference)){releasedLeases.set(activeLease.token,activeLease);activeLease=undefined;}
            else if(JSON.stringify(releasedLeases.get(c.reference.token))!==JSON.stringify(c.reference))return reject('client_not_admitted');
            result = {released:true,reference:c.reference};
            if(failReleaseAck){failReleaseAck=false;throw new Error('lost release ACK');}break;
          }
          case 'list_snapshot': result = {entries:exists?[{state:state(),presentation:presentation()}]:[]}; break;
          case 'read_path': case 'read_presented': result = {entry:exists?state():null,presentation:presentation(),has_content:exists}; output = exists?body(content):''; break;
          case 'checkpoint_load': { const head = heads.get(c.key); result = {checkpoint:head?.metadata??null}; output = head?.body??''; break; }
          case 'checkpoint_cas': {
            assert.equal(heads.get(c.key)?.metadata.revision??null,c.expected_revision);
            const metadata = {version:1,...c.scope,key:c.key,revision:c.next_revision,sequence:String(++sequence),deleted:!c.has_state,byteLength:atob(input.body).length};
            heads.set(c.key,{metadata,body:input.body}); result = {checkpoint:metadata}; output = input.body;
            if (failCheckpoint) { failCheckpoint = false; throw new Error('lost checkpoint ACK'); } break;
          }
          case 'checkpoint_list': case 'checkpoint_changes': result = {items:[...heads.values()].map(h=>h.metadata),cursor:null,highWater:String(sequence)}; break;
          case 'prepare_intent': {
            assert.equal(content,'before'); assert.equal(c.mutation.expected,'rev1');
            let row = intents.get(c.operation_id);
            if (!row) { row = {order:'1',client_id:clientId,token:'intent',operation_id:c.operation_id,entry_id:'entry',mutation_kind:'write',state:'prepared',acknowledged:false,body:input.body}; intents.set(c.operation_id,row); }
            result = {intent:row}; break;
          }
          case 'query_intent': result = {intent:[...intents.values()].find(i=>i.token===c.reference.token)??null}; break;
          case 'commit_intent': {
            const row = [...intents.values()][0]; content = decoder.decode(Uint8Array.from(atob(row.body),c=>c.charCodeAt(0))); revision = 'rev2'; row.state='committed';
            row.receipt = {operation_id:row.operation_id,sequence:'1',changes:[{after:state()}]}; result={intent:row}; if(failCommit){failCommit=false;throw new Error('lost commit ACK');} break;
          }
          case 'list_intents': result = {intents:[...intents.values()],has_more:false,next_cursor:'1'}; break;
          case 'acknowledge_intent': { const row = [...intents.values()][0]; row.acknowledged=true; result={intent:row}; break; }
          case 'file_command': {
            const request = c.family.request, m = request.mutation;
            let receipt = receipts.get(request.operation_id);
            if (!receipt) {
              const before = exists?state():null;
              if (m.type==='move') path=m.path;
              if (m.type==='write') { content=decoder.decode(Uint8Array.from(atob(input.body),c=>c.charCodeAt(0))); revision='changed'; }
              if (m.type==='create') { exists=true;path=m.path;revision='created'; }
              if (m.type==='delete') exists=false;
              receipt={operation_id:request.operation_id,sequence:String(++sequence),changes:[{before,after:{...state(),id:m.id,kind:m.kind??'file',deleted:!exists}}]}; receipts.set(request.operation_id,receipt);
            }
            result={commit:receipt,projection:{state:'projected'}};
            if (failCommand) { failCommand=false; throw new Error('lost file ACK'); } break;
          }
          default: throw new Error(`Unexpected method ${c.method}`);
        }
        if(injectedError?.method===c.method&&injectedError.after){const error=injectedError.error;injectedError=undefined;return errorReply(error);}
        return {header:JSON.stringify({version:1,request_id:wrongId?'999':header.request_id,ok:true,result}),body:output};
      } finally { active--; }
    },
  };
  return { plugin, requests, heads, receipts, acks, lifecycleOrder, initialStatus(value:any){initialReconciliation=value;}, refreshed(value:any){refreshValue=value;}, onRefresh(hook:()=>Promise<void>){refreshHook=hook;}, get refreshCalls(){return refreshCalls;}, loseReleaseAck(){failReleaseAck=true;}, loseReleaseDispatch(){failReleaseDispatch=true;}, get admitted(){return !!activeLease;}, hostError(method:string,error:any,after=false){injectedError={method,error,after};}, get removals(){return removals;}, emit(reason:MobileLifecycleReason,id:string=crypto.randomUUID()){for(const callback of lifecycleCallbacks)callback({id,reason});return id;}, expire(id:string){expired.add(id);}, onAck(hook:(input:{id:string;ok:boolean})=>Promise<void>){ackHook=hook;}, duringContext(reason:MobileLifecycleReason){contextEvent=reason;}, badAuthority(value=true){wrongAuthority=value;}, get content(){return content;}, get closes(){return closes;}, get maxActive(){return maxActive;}, loseFileAck(){failCommand=true;}, loseCheckpointAck(){failCheckpoint=true;}, wrongId(value=true){wrongId=value;}, loseCommitAck(){failCommit=true;}, absent(){exists=false;} };
}

test('durable text planning validates expected identity/content and prepare remains inert',async()=>{
  const f=fixture(), vault=await openNativeMobileVault(f.plugin), writes=vault.adapter.durableWrites!;
  assert.deepEqual(writes.checkpoints.scope,{vaultId:'store',clientId});
  const baseline=await writes.readText('Note.md'); assert.equal(baseline.content,'before');
  const input={operationId:'operation',path:'Note.md',expectedEntryId:'entry',expectedRevision:'rev1',expectedContent:'before',content:'after 你好'};
  await assert.rejects(writes.planWrite({...input,expectedContent:'wrong'}),{code:'revision_conflict'});
  await assert.rejects(writes.planWrite({...input,expectedEntryId:'other'}),{code:'revision_conflict'});
  const plan=await writes.planWrite(input), prepared=await writes.prepare(plan);
  assert.equal(prepared.state,'prepared'); assert.equal(f.content,'before');
  assert.equal(f.requests.filter(r=>r.command.method==='commit_intent').length,0);
  await assert.rejects(writes.commit({...prepared.ref,clientId:'foreign'}),{code:'intent_identity_mismatch'});
  const result=await writes.commit(prepared.ref); assert.equal(result.state,'committed'); assert.equal(f.content,'after 你好');
  await assert.rejects(writes.acknowledge(result.ref,{status:'committed',operationId:'operation',sequence:'999'}),{code:'intent_outcome_mismatch'});
  await writes.acknowledge(result.ref,{status:'committed',operationId:'operation',sequence:'1'});
  assert.equal((await writes.listUnacknowledged()).length,0);
  await vault.release!(); assert.equal(f.closes,0);
});

test('checkpoint lost ACK is recovered with stable scope/body across reopen',async()=>{
  const f=fixture(), first=await openNativeMobileVault(f.plugin), cp=first.adapter.durableWrites!.checkpoints;
  const revision=crypto.randomUUID(), encodedState='draft 你好\ufeff'; f.loseCheckpointAck();
  await assert.rejects(cp.compareAndSwap({key:'editor/draft',expectedRevision:null,nextRevision:revision,encodedState}),{commitUncertain:true});
  await first.release!();
  const second=await openNativeMobileVault(f.plugin), loaded=await second.adapter.durableWrites!.checkpoints.load('editor/draft');
  assert.equal(loaded!.encodedState,encodedState); assert.equal(loaded!.revision,revision); assert.equal(first.id,second.id);
  await second.release!();
});

test('namespace lost ACK replays original CAS operation without replanning after reopen',async()=>{
  const f=fixture(), first=await openNativeMobileVault(f.plugin); f.loseFileAck();
  await assert.rejects(first.adapter.rename('Note.md','Moved.md'),{commitUncertain:true});
  const original=f.requests.find(r=>r.command.method==='file_command');
  await first.release!(); const second=await openNativeMobileVault(f.plugin);
  await second.recoverCommands!();
  const replay=f.requests.filter(r=>r.command.method==='file_command');
  assert.equal(replay.length,2); assert.deepEqual(replay[1].command,original.command); assert.equal(f.receipts.size,1);
  assert.equal((await second.adapter.list())[0].path,'Moved.md'); assert.equal(second.adapter.durableNamespace,true);
  await second.release!();
});

test('checkpoint failure forbids file dispatch; exact checkpoint retry recovers',async()=>{
  const f=fixture(), v=await openNativeMobileVault(f.plugin); f.loseCheckpointAck();
  await assert.rejects(v.adapter.write('Note.md','saved'),{commitUncertain:true});
  assert.equal(f.requests.filter(r=>r.command.method==='file_command').length,0);
  await v.adapter.write('Note.md','saved'); assert.equal(f.content,'saved'); assert.equal(f.receipts.size,1);
  await v.release!();
});

test('request queue serializes reads and rejects bad envelopes, invalid paths, oversized binary',async()=>{
  const f=fixture(), v=await openNativeMobileVault(f.plugin);
  await Promise.all([v.adapter.read('Note.md'),v.adapter.list(),v.adapter.stat!('Note.md')]); assert.equal(f.maxActive,1);
  await assert.rejects(v.adapter.read('../escape'),/escape/);
  assert.throws(()=>v.adapter.writeBinary!('big.bin',new Uint8Array(16*1024*1024+1)),{code:'request_limit'});
  assert.throws(()=>v.adapter.write('Note.md','\ud800'),{code:'invalid_text'});
  f.wrongId(); await assert.rejects(v.adapter.read('Note.md'),{code:'invalid_response',commitUncertain:true}); f.wrongId(false); await v.release!();
});

test('binary create never overwrites and remove forwards force without trash substitution',async()=>{
  const f=fixture(), v=await openNativeMobileVault(f.plugin);
  await assert.rejects(v.adapter.createBinary!('Note.md',new Uint8Array([0,255])),{code:'revision_conflict'});
  await v.adapter.remove!('Note.md',false);
  const commands=f.requests.filter(r=>r.command.method==='file_command'); assert.equal(commands.length,1);
  assert.equal(commands[0].command.family.request.mutation.type,'delete'); assert.equal(commands[0].command.family.request.mutation.recursive,false);
  await v.release!();
});


test('lost commit reply retains the original intent for query and acknowledgement',async()=>{
  const f=fixture(), v=await openNativeMobileVault(f.plugin), w=v.adapter.durableWrites!;
  const plan=await w.planWrite({operationId:'lost-commit',path:'Note.md',expectedEntryId:'entry',expectedRevision:'rev1',expectedContent:'before',content:'retained'});
  const prepared=await w.prepare(plan); f.loseCommitAck();
  await assert.rejects(w.commit(prepared.ref),{commitUncertain:true});
  const reconciled=await w.query(prepared.ref); assert.equal(reconciled!.state,'committed'); assert.equal(f.content,'retained');
  assert.equal(f.requests.filter(r=>r.command.method==='prepare_intent').length,1);
  await v.release!();
});

test('same-session uncertain namespace retries reuse exact operation and reject changed payload',async()=>{
  const f=fixture(), v=await openNativeMobileVault(f.plugin); f.loseFileAck();
  await assert.rejects(v.adapter.rename('Note.md','Moved.md'),{commitUncertain:true});
  await assert.rejects(v.adapter.rename('Note.md','Different.md'),{code:'file_operation_pending'});
  await v.adapter.rename('Note.md','Moved.md');
  const commands=f.requests.filter(r=>r.command.method==='file_command');
  assert.deepEqual(commands[0].command,commands[1].command); assert.equal(f.receipts.size,1);
  await v.release!();
});

test('absent native plugin fails closed without any Filesystem fallback',async()=>{
  const hook=registerHooks({resolve(specifier,context,next){
    if(specifier==='@capacitor/core')return{url:'data:text/javascript,'+encodeURIComponent("export const Capacitor={isNativePlatform:()=>true,isPluginAvailable:()=>false}; export function registerPlugin(){throw new Error('must not register absent plugin')};"),shortCircuit:true};
    return next(specifier,context);
  }});
  try { await assert.rejects(openNativeMobileVault(),{code:'native_plugin_unavailable'}); } finally { hook.deregister(); }
});

test('release drains an admitted namespace consumer and retires the lease once',async()=>{
  const f=fixture(), v=await openNativeMobileVault(f.plugin);
  const saving=v.adapter.write('Note.md','drained'), releasing=v.release!();
  await Promise.all([saving,releasing]); assert.equal(f.content,'drained'); assert.equal(f.closes,0);
  const methods=f.requests.map(r=>r.command.method); assert.ok(methods.indexOf('file_command')<methods.indexOf('release_client'));
  await assert.rejects(v.adapter.read('Note.md'),{code:'storage_closed'});
  await v.release!(); assert.equal(f.closes,0);
});

function deferred() { let resolve!:()=>void; const promise=new Promise<void>(r=>{resolve=r;}); return {promise,resolve}; }
async function until(predicate:()=>boolean) { for(let i=0;i<100;i++){if(predicate())return;await new Promise<void>(r=>setImmediate(r));} assert.fail('Lifecycle did not settle'); }

test('listener precedes context and startup requests without a workspace are rejected',async()=>{
  const f=fixture(); f.duringContext('switchVault'); const v=await openNativeMobileVault(f.plugin);
  assert.deepEqual(f.lifecycleOrder.slice(0,2),['listen','context']);
  await until(()=>f.acks.length===1); assert.equal(f.acks[0].ok,false);
  assert.equal(await v.adapter.read('Note.md'),'before'); await v.release!();
  assert.equal(f.closes,0); assert.equal(f.removals,1);
});

test('background flush and session checkpoint precede ACK and leave storage active',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),done=deferred();
  const stop=v.mobileLifecycle.subscribe(async(reason,ack)=>{
    assert.equal(reason,'background');
    await v.adapter.write('Note.md','flushed');
    await v.adapter.durableWrites!.checkpoints.compareAndSwap({key:'session',expectedRevision:null,nextRevision:crypto.randomUUID(),encodedState:'saved-session'});
    assert.equal(f.acks.length,0); await ack(); await ack(); done.resolve();
  });
  f.emit('background'); await done.promise; await until(()=>f.acks.length===1);
  assert.equal(f.acks[0].ok,true); assert.equal(f.closes,0); assert.equal(f.removals,0);
  assert.equal(await v.adapter.read('Note.md'),'flushed');
  assert.equal((await v.adapter.durableWrites!.checkpoints.load('session'))!.encodedState,'saved-session');
  stop(); await v.release!(); assert.equal(f.requests.filter(r=>r.command.method==='release_client').length,1); assert.equal(f.removals,1);
});

test('switch ACK must succeed before retirement; release waits for callback settlement',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),ackGate=deferred(),callbackGate=deferred(),entered=deferred();
  f.onAck(async input=>{if(input.ok)await ackGate.promise;});
  v.mobileLifecycle.subscribe(async(reason,ack)=>{assert.equal(reason,'switchVault'); await ack(); entered.resolve(); await callbackGate.promise;});
  f.emit('switchVault'); await until(()=>f.acks.length===1);
  assert.equal(await v.adapter.read('Note.md'),'before'); // Native ACK has not resolved yet.
  const release=v.release!(); await new Promise<void>(r=>setImmediate(r));
  assert.equal(f.removals,0); assert.equal(f.requests.filter(r=>r.command.method==='release_client').length,0);
  ackGate.resolve(); await entered.promise;
  await assert.rejects(v.adapter.read('Note.md'),{code:'storage_closed'}); assert.equal(f.removals,0);
  callbackGate.resolve(); await release;
  assert.equal(f.removals,1); assert.equal(f.closes,0);
  assert.equal(f.requests.filter(r=>r.command.method==='release_client').length,0); // Successful switch transfers cleanup to native.
});

test('native deadline expiry rejects late ACK and workspace can resume editing',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),flush=deferred(),done=deferred(); let restored=false;
  v.mobileLifecycle.subscribe(async(_reason,ack)=>{
    await flush.promise;
    try { await ack(); assert.fail('expired request approved'); }
    catch(error){assert.equal((error as any).code,'stale_lifecycle');restored=true;}
    done.resolve();
  });
  const id=f.emit('switchVault');
  await new Promise<void>(resolve=>setTimeout(()=>{f.expire(id);resolve();},5));
  assert.equal(f.acks.length,0); flush.resolve(); await done.promise;
  await until(()=>f.acks.length===2); assert.deepEqual(f.acks.map(a=>a.ok),[true,false]);
  assert.equal(restored,true); assert.equal(f.removals,0); assert.equal(f.closes,0);
  await v.adapter.write('Note.md','editing resumed'); assert.equal(f.content,'editing resumed'); await v.release!();
});

for(const mode of ['no handler','failure','missing ACK'] as const) test(`lifecycle ${mode} sends negative ACK only`,async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin);
  if(mode!=='no handler')v.mobileLifecycle.subscribe(async()=>{if(mode==='failure')throw new Error('flush failed');});
  f.emit('switchVault'); await until(()=>f.acks.length===1); assert.equal(f.acks[0].ok,false);
  assert.equal(await v.adapter.read('Note.md'),'before'); await v.release!(); assert.equal(f.closes,0);
});

test('concurrent lifecycle requests cannot run a second workspace callback',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),gate=deferred();let calls=0;
  v.mobileLifecycle.subscribe(async(_reason,ack)=>{calls++;await gate.promise;await ack();});
  const first=f.emit('background'); await until(()=>calls===1);
  f.emit('background',first); const second=f.emit('switchVault');
  await until(()=>f.acks.length===1); assert.deepEqual(f.acks[0],{id:second,ok:false}); assert.equal(calls,1);
  gate.resolve(); await until(()=>f.acks.length===2); assert.deepEqual(f.acks[1],{id:first,ok:true});
  await v.release!(); assert.equal(f.closes,0);
});

test('ACK retained beyond handler completion cannot authorize a later switch',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin);let lateAck!:()=>Promise<void>;
  v.mobileLifecycle.subscribe(async(_reason,ack)=>{lateAck=ack;});
  f.emit('switchVault');await until(()=>f.acks.length===1);
  await assert.rejects(lateAck(),{code:'stale_lifecycle'}); assert.equal(f.acks.length,1); assert.equal(f.acks[0].ok,false);
  await v.release!();
});

test('startup identity failure releases the valid claimed lease without closing native host',async()=>{
  const f=fixture();f.badAuthority();
  await assert.rejects(openNativeMobileVault(f.plugin),{code:'invalid_authority'});
  assert.deepEqual(f.requests.map(r=>r.command.method),['claim_client','identity','release_client']);
  assert.equal(f.removals,1);assert.equal(f.closes,0);assert.equal(f.admitted,false);
  assert.equal(Object.hasOwn(f.requests.at(-1),'lease'),false);
  f.badAuthority(false);const reopened=await openNativeMobileVault(f.plugin);await reopened.release!();
});

test('context failure removes preinstalled listener without attempting host close',async()=>{
  const f=fixture();f.plugin.context=async()=>{throw new Error('context failed');};
  await assert.rejects(openNativeMobileVault(f.plugin),/context failed/);
  assert.equal(f.requests.length,0);assert.equal(f.removals,1);assert.equal(f.closes,0);
});

test('throwing callback cannot detach listener while its ACK is still in flight',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),gate=deferred();
  f.onAck(async input=>{if(input.ok)await gate.promise;});
  v.mobileLifecycle.subscribe(async(_reason,ack)=>{void ack();throw new Error('callback failed after authorizing');});
  f.emit('switchVault');await until(()=>f.acks.length===1);
  const release=v.release!();await new Promise<void>(r=>setImmediate(r));assert.equal(f.removals,0);
  gate.resolve();await release;
  assert.deepEqual(f.acks.map(a=>a.ok),[true]);assert.equal(f.removals,1);assert.equal(f.closes,0);
  assert.equal(f.requests.filter(r=>r.command.method==='release_client').length,0);
});

test('background ACK transport rejection preserves adapter for workspace recovery',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),done=deferred();
  f.onAck(async input=>{if(input.ok)throw new Error('ACK transport unavailable');});
  v.mobileLifecycle.subscribe(async(_reason,ack)=>{await assert.rejects(ack(),/transport unavailable/);done.resolve();});
  f.emit('background');await done.promise;await until(()=>f.acks.length===2);
  assert.deepEqual(f.acks.map(a=>a.ok),[true,false]);assert.equal(f.removals,0);
  assert.equal(await v.adapter.read('Note.md'),'before');await v.release!();assert.equal(f.closes,0);
});

test('successful switch ACK stops polling and rejects further adapter work',async t=>{
  let poll!:()=>void,stops=0;
  t.mock.method(globalThis,'setInterval',(callback:()=>void)=>{poll=callback;return 42 as any;});
  t.mock.method(globalThis,'clearInterval',()=>{stops++;});
  const f=fixture(),v=await openNativeMobileVault(f.plugin),done=deferred();
  v.adapter.subscribe!(()=>{});poll();await until(()=>f.requests.some(r=>r.command.method==='list_snapshot'));
  v.mobileLifecycle.subscribe(async(_reason,ack)=>{await ack();done.resolve();});
  f.emit('switchVault');await done.promise;await until(()=>f.removals===1);
  const before=f.requests.length;poll();await new Promise<void>(r=>setImmediate(r));
  assert.equal(stops,1);assert.equal(f.requests.length,before);
  await assert.rejects(v.adapter.list(),{code:'storage_closed'});await v.release!();assert.equal(f.closes,0);
});

test('incomplete context remains visible even when snapshot has no files',async()=>{
  const f=fixture(),pending=scanStatus({complete:false,scanComplete:false,finished:false,imported:0,issueCount:1,issues:[{path:null,code:'scan_limit'}]});
  f.initialStatus(pending);f.absent();const v=await openNativeMobileVault(f.plugin);
  assert.deepEqual(await v.adapter.list(),[]);assert.deepEqual(v.reconciliation!.getStatus(),pending);
  pending.complete=true;pending.issues.push({path:null,code:'recovery_retained'} as never);
  assert.equal(v.reconciliation!.getStatus()!.complete,false);assert.equal(v.reconciliation!.getStatus()!.issues.length,1);
  assert.ok(Object.isFrozen(v.reconciliation!.getStatus()!.issues[0]));await v.release!();
});

test('optional missing status stays unknown until explicit native refresh publishes a valid status',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),statuses:any[]=[],changes:any[]=[];
  assert.equal(v.reconciliation!.getStatus(),null);
  const stop=v.reconciliation!.subscribe(status=>statuses.push(status));const unwatch=v.adapter.subscribe!(()=>changes.push('changed'));
  const status=scanStatus({scanId:'refreshed'});f.refreshed({reconciliation:status});
  await v.reconciliation!.retry();assert.deepEqual(v.reconciliation!.getStatus(),status);assert.equal(statuses.length,1);assert.equal(changes.length,1);
  stop();await v.reconciliation!.retry();assert.equal(statuses.length,1);unwatch();
  assert.equal(f.requests.some(r=>['rescan','recover','apply','fixture_family_apply'].includes(r.command.method)),false);
  await v.release!();
});

test('refresh is serialized with host requests and other refreshes; release drains it',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),gate=deferred(),entered=deferred();
  f.onRefresh(async()=>{entered.resolve();await gate.promise;});
  const firstRead=v.adapter.read('Note.md'),refresh=v.reconciliation!.retry(),secondRefresh=v.reconciliation!.retry(),lastRead=v.adapter.read('Note.md');
  await entered.promise;assert.equal(f.refreshCalls,1);assert.equal(f.requests.filter(r=>r.command.method==='read_path').length,1);
  const release=v.release!();await new Promise<void>(r=>setImmediate(r));assert.equal(f.removals,0);
  gate.resolve();await Promise.all([firstRead,refresh,secondRefresh,lastRead,release]);
  assert.equal(f.maxActive,1);assert.equal(f.refreshCalls,2);assert.equal(f.removals,1);assert.equal(f.closes,0);
  await assert.rejects(v.reconciliation!.retry(),{code:'storage_closed'});
});

for(const [label,changes] of [
  ['contradictory complete',{complete:true,scanComplete:false}],
  ['unsafe count',{observed:Number.MAX_SAFE_INTEGER+1}],
  ['negative count',{imported:-1}],
  ['truncated mismatch',{issuesTruncated:true}],
  ['unknown status field',{ready:true}],
  ['invalid failure',{complete:false,failure:'ignored'}],
  ['complete with failure',{failure:'scan_failed'}],
  ['unknown issue',{complete:false,issueCount:1,issues:[{path:'Note.md',code:'unknown'}]}],
  ['escaping issue path',{complete:false,issueCount:1,issues:[{path:'../Note.md',code:'scan_limit'}]}],
  ['private issue path',{complete:false,issueCount:1,issues:[{path:'.zorid/private',code:'scan_limit'}]}],
] as const) test(`context rejects ${label} reconciliation before client admission`,async()=>{
  const f=fixture();f.initialStatus(scanStatus(changes));
  await assert.rejects(openNativeMobileVault(f.plugin),{code:'invalid_reconciliation'});
  assert.equal(f.requests.length,0);assert.equal(f.removals,1);assert.equal(f.closes,0);
});

test('bad or failed refresh preserves last valid incomplete status and retry remains available',async()=>{
  const f=fixture(),pending=scanStatus({complete:false,finished:false,scanComplete:false});f.initialStatus(pending);
  const v=await openNativeMobileVault(f.plugin),statuses:any[]=[];v.reconciliation!.subscribe(status=>statuses.push(status));
  f.refreshed({reconciliation:scanStatus({complete:true,issueCount:1,issues:[]})});
  await assert.rejects(v.reconciliation!.retry(),{code:'invalid_reconciliation'});assert.deepEqual(v.reconciliation!.getStatus(),pending);assert.equal(statuses.length,0);
  f.onRefresh(async()=>{throw new Error('native scan unavailable');});
  await assert.rejects(v.reconciliation!.retry(),/native scan unavailable/);assert.deepEqual(v.reconciliation!.getStatus(),pending);
  f.onRefresh(async()=>{});const failed=scanStatus({complete:false,failure:'scan_failed'});f.refreshed({reconciliation:failed});
  await v.reconciliation!.retry();assert.deepEqual(v.reconciliation!.getStatus(),failed);
  f.refreshed({reconciliation:scanStatus()});await v.reconciliation!.retry();assert.equal(v.reconciliation!.getStatus()!.complete,true);assert.equal(statuses.length,2);
  await v.release!();
});

test('queued refresh cannot reach native after successful switch ACK',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),gate=deferred(),entered=deferred(),done=deferred();
  const original=f.plugin.request.bind(f.plugin);
  f.plugin.request=async input=>{if(JSON.parse(input.header).command.method==='read_path'){entered.resolve();await gate.promise;}return original(input);};
  const read=v.adapter.read('Note.md');await entered.promise;
  const refresh=assert.rejects(v.reconciliation!.retry(),{code:'storage_closed'});
  v.mobileLifecycle.subscribe(async(_reason,ack)=>{await ack();done.resolve();});f.emit('switchVault');await done.promise;
  gate.resolve();await read;await refresh;assert.equal(f.refreshCalls,0);await v.release!();
});

test('client UUID must be canonical lowercase, including alphabetic digits',async()=>{
  const f=fixture();f.plugin.context=async()=>({name:'fixture',clientId:clientId.toUpperCase()});
  await assert.rejects(openNativeMobileVault(f.plugin),{code:'invalid_native_context'});assert.equal(f.requests.length,0);assert.equal(f.removals,1);
});

test('noncanonical lifecycle UUID cannot invoke workspace or approve a native switch',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin);let calls=0;
  v.mobileLifecycle.subscribe(async(_reason,ack)=>{calls++;await ack();});f.emit('switchVault',clientId.toUpperCase());
  await new Promise<void>(r=>setImmediate(r));assert.equal(calls,0);assert.equal(f.acks.length,0);assert.equal(await v.adapter.read('Note.md'),'before');await v.release!();
});

test('strict host rejects an outer lease on release_client, matching Rust authorization',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),claimed=f.requests.find(r=>r.command.method==='identity').lease;
  const reply=await f.plugin.request({header:JSON.stringify({version:1,request_id:'999',command:{method:'release_client',reference:claimed},lease:claimed}),body:''});
  assert.equal(JSON.parse(reply.header).error.code,'client_operation_unsupported');assert.equal(f.admitted,true);
  await v.release!();assert.equal(f.admitted,false);
});

test('successful release omits the outer lease and permits fresh-token reacquisition',async()=>{
  const f=fixture(),first=await openNativeMobileVault(f.plugin),old=f.requests.find(r=>r.command.method==='identity').lease;
  await first.release!();assert.equal(f.admitted,false);
  const release=f.requests.find(r=>r.command.method==='release_client');
  assert.equal(Object.hasOwn(release,'lease'),false);assert.deepEqual(release.command.reference,old);
  const second=await openNativeMobileVault(f.plugin);assert.equal(await second.adapter.read('Note.md'),'before');
  const identities=f.requests.filter(r=>r.command.method==='identity');assert.notEqual(identities[1].lease.token,old.token);assert.equal(identities[1].lease.client_id,clientId);
  await second.release!();assert.equal(f.admitted,false);assert.equal(f.closes,0);
});

test('uncertain release retries original reference after reacquisition without retiring new lease',async()=>{
  const f=fixture(),first=await openNativeMobileVault(f.plugin);f.loseReleaseAck();
  await assert.rejects(first.release!(),{code:'outcome_unknown',commitUncertain:true});
  assert.equal(f.admitted,false);assert.equal(f.removals,0);
  await assert.rejects(first.adapter.read('Note.md'),{code:'storage_closed'});
  const oldRelease=f.requests.find(r=>r.command.method==='release_client');
  const second=await openNativeMobileVault(f.plugin);assert.equal(f.admitted,true);
  await first.release!();assert.equal(f.admitted,true);assert.equal(f.removals,1);
  const releases=f.requests.filter(r=>r.command.method==='release_client');
  assert.deepEqual(releases[0].command,releases[1].command);assert.equal(Object.hasOwn(releases[1],'lease'),false);
  assert.equal(releases[1].command.reference.token,oldRelease.command.reference.token);
  assert.equal(await second.adapter.read('Note.md'),'before');await second.release!();
  assert.equal(f.admitted,false);assert.equal(f.removals,2);assert.equal(f.closes,0);
});

test('release transport failure before dispatch retains ownership until exact retry',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin);f.loseReleaseDispatch();
  await assert.rejects(v.release!(),{commitUncertain:true});assert.equal(f.admitted,true);assert.equal(f.removals,0);
  await assert.rejects(openNativeMobileVault(f.plugin),{code:'client_in_use'});assert.equal(f.admitted,true);
  await v.release!();assert.equal(f.admitted,false);
  const releases=f.requests.filter(r=>r.command.method==='release_client');assert.equal(releases.length,2);
  assert.deepEqual(releases[0].command,releases[1].command);assert.equal(releases.every(r=>!Object.hasOwn(r,'lease')),true);
  const reopened=await openNativeMobileVault(f.plugin);await reopened.release!();assert.equal(f.closes,0);
});

for(const [code,uncertain] of [['storage_io',true],['checkpoint_storage',true],['revision_conflict',false],['outcome_unknown',false]] as const) test(`host ${code} preserves explicit commit_uncertain=${uncertain}`,async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),checkpoint=code==='checkpoint_storage';
  f.hostError(checkpoint?'checkpoint_load':'read_path',{code,message:'Host storage response',commit_uncertain:uncertain});
  await assert.rejects(checkpoint?v.adapter.durableWrites!.checkpoints.load('draft'):v.adapter.read('Note.md'),{code,commitUncertain:uncertain,source:'host'});
  await v.release!();
});

for(const [label,error] of [
  ['missing uncertainty',{code:'storage_io',message:'Host failure'}],
  ['string uncertainty',{code:'storage_io',message:'Host failure',commit_uncertain:'true'}],
  ['missing message',{code:'storage_io',commit_uncertain:true}],
  ['non-string message',{code:'storage_io',message:42,commit_uncertain:false}],
  ['invalid code',{code:'StorageIO',message:'Host failure',commit_uncertain:false}],
  ['oversized code',{code:'x'.repeat(65),message:'Host failure',commit_uncertain:true}],
  ['absent error',undefined],
] as const) test(`malformed host error (${label}) fails uncertain`,async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin);f.hostError('read_path',error);
  await assert.rejects(v.adapter.read('Note.md'),{code:'invalid_response',commitUncertain:true});
  assert.equal(await v.adapter.read('Note.md'),'before');await v.release!();
});

for(const malformed of [false,true]) test(`${malformed?'malformed':'uncertain storage_io'} namespace ACK retains exact operation for replay`,async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin);
  f.hostError('file_command',malformed?{code:'revision_conflict',message:'Broken host ACK'}:{code:'storage_io',message:'Projection ACK uncertain',commit_uncertain:true},true);
  await assert.rejects(v.adapter.rename('Note.md','Moved.md'),{code:malformed?'invalid_response':'storage_io',commitUncertain:true});
  const first=f.requests.find(r=>r.command.method==='file_command');assert.equal(f.receipts.size,1);
  await assert.rejects(v.adapter.rename('Note.md','Different.md'),{code:'file_operation_pending'});
  await v.adapter.rename('Note.md','Moved.md');const calls=f.requests.filter(r=>r.command.method==='file_command');
  assert.equal(calls.length,2);assert.deepEqual(calls[1].command,first.command);assert.equal(f.receipts.size,1);await v.release!();
});

test('checkpoint_storage uncertain ACK forbids namespace dispatch until original durable command is loaded',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin);
  f.hostError('checkpoint_cas',{code:'checkpoint_storage',message:'Checkpoint ACK uncertain',commit_uncertain:true},true);
  await assert.rejects(v.adapter.write('Note.md','checkpoint retained'),{code:'checkpoint_storage',commitUncertain:true});
  assert.equal(f.requests.filter(r=>r.command.method==='file_command').length,0);
  const checkpoint=f.requests.find(r=>r.command.method==='checkpoint_cas'),saved=JSON.parse(decoder.decode(Uint8Array.from(atob(checkpoint.body),c=>c.charCodeAt(0))));
  const loaded=await v.adapter.durableWrites!.checkpoints.load(checkpoint.command.key);
  assert.equal(loaded!.revision,checkpoint.command.next_revision);assert.equal(JSON.parse(loaded!.encodedState!).operationId,saved.operationId);
  await v.adapter.write('Note.md','checkpoint retained');
  const dispatched=f.requests.find(r=>r.command.method==='file_command');assert.deepEqual(dispatched.command.family,saved.commands[0].family);
  assert.equal(dispatched.body,saved.commands[0].body);assert.equal(f.content,'checkpoint retained');await v.release!();
});

test('explicit terminal namespace rejection is retained and does not execute on recovery',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin);
  f.hostError('file_command',{code:'revision_conflict',message:'Expected revision is stale',commit_uncertain:false});
  await assert.rejects(v.adapter.rename('Note.md','Moved.md'),{code:'revision_conflict',commitUncertain:false});
  await v.recoverCommands!();assert.equal(f.requests.filter(r=>r.command.method==='file_command').length,1);assert.equal(f.receipts.size,0);
  assert.equal((await v.adapter.list())[0].path,'Note.md');await v.release!();
});
