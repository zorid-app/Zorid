import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { openNativeMobileVault, type NativeVaultPlugin, type MobileLifecycleReason, type NativeEditorAction, type NativeEditorState, type NativePresentationSettled } from '../src/platform/mobile-native.ts';

const clientId = 'a1b2c3d4-abcd-4abc-8abc-abcdef012345';
const entryUuid='c3d4e5f6-cdef-4cde-acde-cdef01234567';
const token = 'b2c3d4e5-bcde-4bcd-9bcd-bcdef0123456';
const encoder = new TextEncoder(), decoder = new TextDecoder();
const body = (text: string) => btoa(String.fromCharCode(...encoder.encode(text)));
function scanStatus(overrides:Record<string,unknown>={}) { return {scanId:'scan_fixture',complete:true,scanComplete:true,finished:true,observed:1,imported:1,namespaceApplied:0,issueCount:0,issuesTruncated:false,issues:[],...overrides}; }
function fixture() {
  const navigationCallbacks=new Set<(event:any)=>void>(), navigationResults:any[]=[];
  let navigationCapability:any=undefined,navigationHook:((result:any)=>Promise<void>)|undefined;
  const requests: any[] = [], heads = new Map<string, any>(), intents = new Map<string, any>(), receipts = new Map<string, any>();
  let content = 'before', revision = 'rev1', path = 'Note.md', exists = true, closes = 0, sequence = 0, active = 0, maxActive = 0;
  let failCommand = false, failCheckpoint = false, failCommit = false, wrongId = false, failReleaseAck = false, failReleaseDispatch = false;
  let activeLease: {local_store_id:string;client_id:string;token:string} | undefined, claims=0;
  const releasedLeases=new Map<string,any>();
  let injectedError: {method:string;error:any;after:boolean} | undefined;
  let entryIdentity='entry';
  const state = () => ({ id:entryIdentity, path, kind:'file', revision, deleted:false });
  const presentation = () => ({id:entryIdentity,ctime_ms:1,mtime_ms:2,size_bytes:encoder.encode(content).length});
  const acks: {id:string;ok:boolean}[] = [], lifecycleOrder: string[] = [], expired = new Set<string>();
  const stateRequestCallbacks=new Set<(event:any)=>void>();let requestInstalls=0,requestRemovals=0,requestInstallHook:(()=>Promise<void>)|undefined;
  const actionCallbacks=new Set<(event:any)=>void>(),editorStates:NativeEditorState[]=[];
  let actionInstalls=0,actionRemovals=0,actionInstallHook:(()=>Promise<void>)|undefined,editorStateHook:((state:NativeEditorState)=>Promise<void>)|undefined;
  const lifecycleCallbacks=new Set<(event:{id:string;reason:MobileLifecycleReason})=>void>();let removals = 0;
  let contextEvent: MobileLifecycleReason | undefined, wrongAuthority = false;
  let ackHook: ((input:{id:string;ok:boolean})=>Promise<void>) | undefined;
  let initialReconciliation: any = undefined, refreshValue: any = {reconciliation:scanStatus()}, refreshCalls=0;
  let refreshHook: (()=>Promise<void>) | undefined, documentCapability:any=undefined;
  let docSnapshot={localStoreId:'store',generationEpoch:'doc-epoch',generation:'1',versions:{schema:1,extraction:'markdown-1',resolver:'resolver-1',query:'query-1'}};
  const docSource={localStoreId:'store',watermark:'9007199254740993'},docPins=new Map<string,any>(),docStages=new Map<string,any>(),docRequests:any[]=[];
  let docReady=false,lastPin=0n,docHook:((request:any)=>Promise<void>)|undefined,docTransform:((op:string,value:any)=>any)|undefined;

  let initialPath: any = undefined, initialEntryId: any = undefined, createNoteOnOpen: any = undefined, openedHook: ((path:string)=>Promise<void>) | undefined; const opened: string[] = [],openedRefs:{path:string;entryId:string}[]=[];
  const plugin: NativeVaultPlugin & {close():Promise<void>} = {
    async addListener(event:'lifecycleRequest'|'editorAction'|'editorStateRequest'|'documentOpenRequest',handler:(event:any)=>void) { if(event==='documentOpenRequest'){navigationCallbacks.add(handler);return{remove:async()=>{navigationCallbacks.delete(handler);}};} if(event==='editorStateRequest'){requestInstalls++;if(requestInstallHook)await requestInstallHook();stateRequestCallbacks.add(handler);return{remove:async()=>{requestRemovals++;stateRequestCallbacks.delete(handler);}};} if(event==='editorAction'){actionInstalls++;if(actionInstallHook)await actionInstallHook();actionCallbacks.add(handler);return{remove:async()=>{actionRemovals++;actionCallbacks.delete(handler);}};} assert.equal(event,'lifecycleRequest'); lifecycleOrder.push('listen'); lifecycleCallbacks.add(handler); return {remove:async()=>{removals++; lifecycleOrder.push('remove'); lifecycleCallbacks.delete(handler);}}; },
    async documentOpenResult(result){navigationResults.push(structuredClone(result));if(navigationHook)await navigationHook(result);},
    async editorState(state) {editorStates.push({...state});if(editorStateHook)await editorStateHook(state);},
    async lifecycleAck(input) { acks.push(input); lifecycleOrder.push(input.ok?'ack:true':'ack:false'); if(ackHook)await ackHook(input); if(expired.has(input.id))throw Object.assign(new Error('deadline expired'),{code:'stale_lifecycle'}); },
    context: async () => { lifecycleOrder.push('context'); if(contextEvent)for(const callback of lifecycleCallbacks)callback({id:crypto.randomUUID(),reason:contextEvent}); return {name:'Native fixture',clientId,...(navigationCapability===undefined?{}:{sameVaultNavigation:navigationCapability}),...(initialPath===undefined?{}:{initialPath}),...(initialEntryId===undefined?{}:{initialEntryId}),...(createNoteOnOpen===undefined?{}:{createNoteOnOpen}),...(documentCapability===undefined?{}:{documentSemantics:documentCapability}),...(initialReconciliation===undefined?{}:{reconciliation:initialReconciliation})}; }, close: async () => { closes++; },
    async noteOpened({path,entryId}) { openedRefs.push({path,entryId}); active++;maxActive=Math.max(maxActive,active);opened.push(path);try{if(openedHook)await openedHook(path);await new Promise<void>(r=>setImmediate(r));}finally{active--;} },
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
          case 'documents': {
            const request=c.request,command=request.command,op=command.op;docRequests.push(structuredClone(request));
            assert.equal(request.schemaVersion,1);assert.equal(input.body,'');assert.equal(c.client_id,clientId);
            if(docHook)await docHook(request);
            let value:any;
            const pin=docPins.get(command.pinId),report=(value:any)=>({snapshot:pin.snapshot,source:pin.source,coverageComplete:true,value});
            const file={...state(),id:command.id??entryIdentity};
            if(op==='status')value=docReady?{source:docSource,state:'ready',snapshot:docSnapshot,coveredWatermark:docSource.watermark,observedSourceHead:docSource.watermark,coverageComplete:true}:{source:docSource,state:'uninitialized'};
            else if(op==='initialize')value=true;
            else if(op==='rebuild'){docPins.clear();docReady=false;docSnapshot={...docSnapshot,generationEpoch:'rebuilt-epoch'};value=true;}
            else if(op==='begin'){const snapshot={...docSnapshot,generation:String(BigInt(docSnapshot.generation)+1n)};docStages.set(snapshot.generation,snapshot);value={snapshot};}
            else if(op==='pump')value={snapshot:command.snapshot,preparedDocuments:1,reusedDocuments:0,totalDocuments:1,ready:true};
            else if(op==='publish'){docSnapshot=command.snapshot;docStages.delete(docSnapshot.generation);docReady=true;value=docSnapshot;}
            else if(op==='discard'){docStages.delete(command.snapshot.generation);value=true;}
            else if(op==='open'){
              if(!pin){if(BigInt(command.pinId)<=lastPin)return reject('snapshot_expired');if(docPins.size>=4)return reject('pin_capacity');lastPin=BigInt(command.pinId);docPins.set(command.pinId,{snapshot:structuredClone(docSnapshot),source:{...docSource}});}
              value={pinId:command.pinId,...docPins.get(command.pinId),coverageComplete:true};
            }else if(op==='close'){docPins.delete(command.pinId);value=true;}
            else if(!pin)return reject('snapshot_expired');
            else if(op==='metadata')value=report({entry:file,metadata:{entryId:file.id,contentRevision:file.revision,properties:[{key:'nested',value:{Title:'first',title:'second'}}]},exclusion:null});
            else if(op==='search'||op==='backlinks')value={result:report({snapshot:pin.snapshot,...(op==='search'?{hits:[],sourceBytes:0,documents:0}:{edges:[]}),next:null,scanComplete:true,coverageComplete:true,complete:true}),cursor:null};
            else if(op==='base')value=report({definition:file,result:{snapshotId:pin.snapshot,rows:[]}});
            else throw new Error('Unexpected document op '+op);
            if(docTransform)value=docTransform(op,value);
            const bytes=encoder.encode(JSON.stringify({schemaVersion:1,op,value}));result={documents:true,schemaVersion:1,bytes:bytes.length};output=btoa(String.fromCharCode(...bytes));break;
          }
          case 'identity': result = {identity:{local_store_id:wrongAuthority?'wrong':'store'}}; break;
          case 'release_client': {
            if(failReleaseDispatch){failReleaseDispatch=false;throw new Error('release transport failed before dispatch');}
            if(activeLease && JSON.stringify(activeLease)===JSON.stringify(c.reference)){releasedLeases.set(activeLease.token,activeLease);activeLease=undefined;docPins.clear();}
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
  return { plugin, navigationResults, navigation(value:any=1){navigationCapability=value;}, navigate(input:any){for(const callback of navigationCallbacks)callback(input);}, onNavigationResult(hook:(result:any)=>Promise<void>){navigationHook=hook;}, requests, heads, receipts, docRequests,docPins,docStages, documents(value:any=true){documentCapability=value;},onDocument(hook:(request:any)=>Promise<void>){docHook=hook;},documentTransform(transform:(op:string,value:any)=>any){docTransform=transform;}, editorStates, get requestInstalls(){return requestInstalls;},get requestRemovals(){return requestRemovals;}, onRequestInstall(hook:()=>Promise<void>){requestInstallHook=hook;}, stateRequest(event:any={reason:'foreground'}){for(const callback of stateRequestCallbacks)callback(event);}, get actionInstalls(){return actionInstalls;},get actionRemovals(){return actionRemovals;}, onActionInstall(hook:()=>Promise<void>){actionInstallHook=hook;}, onEditorState(hook:(state:NativeEditorState)=>Promise<void>){editorStateHook=hook;}, action(event:any){for(const callback of actionCallbacks)callback(event);}, opened, openedRefs, newNote(value:any){createNoteOnOpen=value;}, selectPath(value:any){initialPath=value;initialEntryId=entryUuid;}, selection(path:any,entryId:any){initialPath=path;initialEntryId=entryId;}, replaceIdentity(id:string,text='replacement'){entryIdentity=id;content=text;revision='replacement-rev';}, present(value=true){exists=value;}, onOpened(hook:(path:string)=>Promise<void>){openedHook=hook;}, acks, lifecycleOrder, initialStatus(value:any){initialReconciliation=value;}, refreshed(value:any){refreshValue=value;}, onRefresh(hook:()=>Promise<void>){refreshHook=hook;}, get refreshCalls(){return refreshCalls;}, loseReleaseAck(){failReleaseAck=true;}, loseReleaseDispatch(){failReleaseDispatch=true;}, get admitted(){return !!activeLease;}, hostError(method:string,error:any,after=false){injectedError={method,error,after};}, get removals(){return removals;}, emit(reason:MobileLifecycleReason,id:string=crypto.randomUUID()){for(const callback of lifecycleCallbacks)callback({id,reason});return id;}, expire(id:string){expired.add(id);}, onAck(hook:(input:{id:string;ok:boolean})=>Promise<void>){ackHook=hook;}, duringContext(reason:MobileLifecycleReason){contextEvent=reason;}, badAuthority(value=true){wrongAuthority=value;}, get content(){return content;}, get closes(){return closes;}, get maxActive(){return maxActive;}, loseFileAck(){failCommand=true;}, loseCheckpointAck(){failCheckpoint=true;}, wrongId(value=true){wrongId=value;}, loseCommitAck(){failCommit=true;}, absent(){exists=false;} };
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

test('optional native selected path preserves Unicode spelling without auto-notifying Recents',async()=>{
  const f=fixture(),selected='資料/e\u0301/你好 📝.md';f.selectPath(selected);
  const v=await openNativeMobileVault(f.plugin);assert.equal(v.initialPath,selected);assert.deepEqual(f.opened,[]);
  await v.adapter.list();await v.adapter.read('Note.md');await v.adapter.write('Note.md','saved');assert.deepEqual(f.opened,[]);
  await v.noteOpened(selected,entryUuid);assert.deepEqual(f.opened,[selected]);assert.equal(v.initialPath,selected);await v.release!();
  const other=fixture(),plain=await openNativeMobileVault(other.plugin);assert.equal(Object.hasOwn(plain,'initialPath'),false);await plain.release!();
});

for(const selected of [null,42,'','/tmp/vault/Note.md','C:/Note.md','a\\b.md','a/../b.md','./Note.md','folder//Note.md','folder/','Note\0.md','.zorid/private','Note\u0085.md','bad\ud800.md']) test(`reject malformed native selected path ${JSON.stringify(selected)}`,async()=>{
  const f=fixture();f.selectPath(selected);await assert.rejects(openNativeMobileVault(f.plugin),{code:'invalid_native_context'});
  assert.equal(f.requests.length,0);assert.equal(f.removals,1);assert.deepEqual(f.opened,[]);assert.equal(f.closes,0);
});

test('noteOpened shares native request/refresh queue and release waits for accepted notification',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),entered=deferred(),gate=deferred();
  f.onOpened(async()=>{entered.resolve();await gate.promise;});
  const first=v.adapter.read('Note.md'),opened=v.noteOpened('nested/你好.md',entryUuid),refresh=v.reconciliation!.retry(),last=v.adapter.read('Note.md');
  await entered.promise;assert.equal(f.requests.filter(r=>r.command.method==='read_path').length,1);assert.equal(f.refreshCalls,0);
  const release=v.release!();await assert.rejects(v.noteOpened('later.md',entryUuid),{code:'storage_closed'});assert.equal(f.removals,0);
  gate.resolve();await Promise.all([first,opened,refresh,last,release]);assert.equal(f.maxActive,1);assert.deepEqual(f.opened,['nested/你好.md']);assert.equal(f.removals,1);
  await assert.rejects(v.noteOpened('closed.md',entryUuid),{code:'storage_closed'});assert.equal(f.closes,0);
});

test('native Recents failure is caller-visible and cannot poison a durable save or future notification',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin);f.onOpened(async()=>{throw Object.assign(new Error('Native identity no longer exists'),{code:'not_found'});});
  await assert.rejects(v.noteOpened('removed.md',entryUuid),{code:'not_found'});
  assert.equal((await v.adapter.durableWrites!.readText('Note.md')).content,'before');
  await v.adapter.write('Note.md','durable despite recents');assert.equal(f.content,'durable despite recents');
  f.onOpened(async()=>{});await v.noteOpened('Note.md',entryUuid);assert.deepEqual(f.opened,['removed.md','Note.md']);await v.release!();
});

test('queued noteOpened is never dispatched after successful switch ACK',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),gate=deferred(),entered=deferred(),done=deferred();
  const original=f.plugin.request.bind(f.plugin);
  f.plugin.request=async input=>{if(JSON.parse(input.header).command.method==='read_path'){entered.resolve();await gate.promise;}return original(input);};
  const read=v.adapter.read('Note.md');await entered.promise;
  const queued=assert.rejects(v.noteOpened('Note.md',entryUuid),{code:'storage_closed'});
  v.mobileLifecycle.subscribe(async(_reason,ack)=>{await ack();done.resolve();});f.emit('switchVault');await done.promise;
  await assert.rejects(v.noteOpened('later.md',entryUuid),{code:'storage_closed'});gate.resolve();await read;await queued;
  assert.deepEqual(f.opened,[]);await v.release!();assert.equal(f.closes,0);
});

test('invalid activation notification paths are rejected before native dispatch',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin);
  for(const path of ['../Note.md','/Note.md','folder//Note.md','.ZORID/private','folder\\Note.md','bad\ud800.md'])await assert.rejects(v.noteOpened(path,entryUuid),{code:'invalid_path'});
  assert.deepEqual(f.opened,[]);await v.noteOpened('folder/My note.canvas',entryUuid);assert.deepEqual(f.opened,['folder/My note.canvas']);await v.release!();
});

for(const [path,entryId] of [['Note.md',undefined],[undefined,entryUuid],['Note.md',null],['Note.md','entry bad'],['Note.md','x'.repeat(129)]] as const) test(`native initial path/identity pair rejects ${JSON.stringify([path,entryId])}`,async()=>{
  const f=fixture();f.selection(path,entryId);await assert.rejects(openNativeMobileVault(f.plugin),{code:'invalid_native_context'});
  assert.equal(f.requests.length,0);assert.equal(f.removals,1);assert.equal(f.closes,0);
});

test('paired native selection and successful-open notification preserve exact stable identity',async()=>{
  const f=fixture();f.selection('資料/你好.md',entryUuid);const v=await openNativeMobileVault(f.plugin);
  assert.equal(v.initialPath,'資料/你好.md');assert.equal(v.initialEntryId,entryUuid);assert.deepEqual(f.openedRefs,[]);
  await v.noteOpened('資料/你好.md',entryUuid);assert.deepEqual(f.openedRefs,[{path:'資料/你好.md',entryId:entryUuid}]);
  for(const id of [undefined,null,'entry bad','x'.repeat(129)] as any[])await assert.rejects(v.noteOpened('Note.md',id),{code:'invalid_entry_id'});
  assert.equal(f.openedRefs.length,1);await v.release!();
});

test('initial durable activation rejects path reuse once, then permits a later intentional replacement open',async()=>{
  const f=fixture();f.selection('Note.md',entryUuid);const v=await openNativeMobileVault(f.plugin),w=v.adapter.durableWrites!;
  // Fixture already represents a replacement at the native-selected path.
  await assert.rejects(w.readText('Note.md'),{code:'revision_conflict'});
  assert.equal((await w.readText('Note.md')).entryId,'entry');assert.equal(v.initialEntryId,entryUuid);
  assert.deepEqual(f.openedRefs,[]);await v.release!();
});

test('matching initial activation consumes its guard and does not pin later reads forever',async()=>{
  const f=fixture();f.selection('Note.md',entryUuid);f.replaceIdentity(entryUuid,'selected bytes');
  const v=await openNativeMobileVault(f.plugin),w=v.adapter.durableWrites!;
  assert.equal((await w.readText('Note.md')).content,'selected bytes');
  f.replaceIdentity('replacement','new file');assert.equal((await w.readText('Note.md')).content,'new file');await v.release!();
});

test('metadata/index reads and ID recovery cannot consume initial activation identity fence',async()=>{
  const f=fixture();f.selection('Note.md',entryUuid);f.replaceIdentity(entryUuid,'selected bytes');
  const v=await openNativeMobileVault(f.plugin),w=v.adapter.durableWrites!;
  await v.adapter.list();await v.adapter.stat!('Note.md');await v.adapter.read('Note.md');
  assert.equal((await w.readTextById(entryUuid))!.entryId,entryUuid);
  await w.planWrite({operationId:'background-plan',path:'Note.md',expectedEntryId:entryUuid,expectedRevision:'replacement-rev',expectedContent:'selected bytes',content:'planned'});
  f.replaceIdentity('replacement','replacement bytes');
  assert.equal(await v.adapter.read('Note.md'),'replacement bytes'); // An index rebuild is not activation.
  await assert.rejects(w.readText('Note.md'),{code:'revision_conflict'});await v.release!();
});

test('failed initial transport or missing file read cannot silently consume the selection guard',async()=>{
  const f=fixture();f.selection('Note.md',entryUuid);const v=await openNativeMobileVault(f.plugin),w=v.adapter.durableWrites!;
  f.hostError('read_path',{code:'storage_io',message:'Retry later',commit_uncertain:true});
  await assert.rejects(w.readText('Note.md'),{code:'storage_io'});f.present(false);
  await assert.rejects(w.readText('Note.md'),{code:'not_found'});f.present();
  await assert.rejects(w.readText('Note.md'),{code:'revision_conflict'});await v.release!();
});

test('all concurrently started initial activation reads remain fenced after first mismatch consumes selection',async()=>{
  const f=fixture();f.selection('Note.md',entryUuid);const v=await openNativeMobileVault(f.plugin),w=v.adapter.durableWrites!;
  await Promise.all([assert.rejects(w.readText('Note.md'),{code:'revision_conflict'}),assert.rejects(w.readText('Note.md'),{code:'revision_conflict'})]);
  assert.equal((await w.readText('Note.md')).entryId,'entry');await v.release!();
});

test('opaque mixed-case entry IDs are preserved exactly and compared case-sensitively',async()=>{
  const selected='Native_Aa-01',f=fixture();f.selection('Note.md',selected);f.replaceIdentity(selected,'selected');
  const v=await openNativeMobileVault(f.plugin);assert.equal(v.initialEntryId,selected);
  await v.noteOpened('Note.md',selected);assert.deepEqual(f.openedRefs,[{path:'Note.md',entryId:selected}]);
  f.replaceIdentity(selected.toLowerCase(),'different identity');
  await assert.rejects(v.adapter.durableWrites!.readText('Note.md'),{code:'revision_conflict'});
  assert.equal((await v.adapter.durableWrites!.readText('Note.md')).entryId,selected.toLowerCase());await v.release!();
});

test('binary activation identity fence rejects replacement bytes then allows intentional later open',async()=>{
  const f=fixture();f.selection('Note.md','Selected_Binary');const v=await openNativeMobileVault(f.plugin);
  await assert.rejects(v.adapter.readBinary!('Note.md'),{code:'revision_conflict'});
  assert.equal(decoder.decode(await v.adapter.readBinary!('Note.md')),'before');await v.release!();
});

test('matching binary activation accepts arbitrary bytes and consumes initial identity fence',async()=>{
  const f=fixture();f.selection('Note.md','Selected_Binary');f.replaceIdentity('Selected_Binary');
  const original=f.plugin.request.bind(f.plugin);
  f.plugin.request=async input=>{
    const reply=await original(input);if(JSON.parse(input.header).command.method!=='read_path')return reply;
    const header=JSON.parse(reply.header);header.result.presentation.size_bytes=2;
    return {header:JSON.stringify(header),body:btoa(String.fromCharCode(0,255))};
  };
  const v=await openNativeMobileVault(f.plugin);assert.deepEqual(await v.adapter.readBinary!('Note.md'),new Uint8Array([0,255]));
  f.replaceIdentity('new-binary');assert.deepEqual(await v.adapter.readBinary!('Note.md'),new Uint8Array([0,255]));await v.release!();
});

test('invalid coherent binary presentation does not consume initial selection',async()=>{
  const f=fixture();f.selection('Note.md','selected');const v=await openNativeMobileVault(f.plugin),original=f.plugin.request.bind(f.plugin);
  f.plugin.request=async input=>{const reply=await original(input);if(JSON.parse(input.header).command.method==='read_path'){const header=JSON.parse(reply.header);header.result.presentation.size_bytes++;reply.header=JSON.stringify(header);}return reply;};
  await assert.rejects(v.adapter.readBinary!('Note.md'),{code:'invalid_presentation'});f.plugin.request=original;
  await assert.rejects(v.adapter.readBinary!('Note.md'),{code:'revision_conflict'});await v.release!();
});

test('concurrent text and binary activation both keep the captured initial identity fence',async()=>{
  const f=fixture();f.selection('Note.md','selected');const v=await openNativeMobileVault(f.plugin);
  await Promise.all([assert.rejects(v.adapter.durableWrites!.readText('Note.md'),{code:'revision_conflict'}),assert.rejects(v.adapter.readBinary!('Note.md'),{code:'revision_conflict'})]);
  assert.equal((await v.adapter.durableWrites!.readText('Note.md')).entryId,'entry');await v.release!();
});

test('native editor-only New note capability forwards intent without creating or opening a note',async()=>{
  const f=fixture();f.newNote(true);const v=await openNativeMobileVault(f.plugin);
  assert.equal(v.editorOnly,true);assert.equal(v.createNoteOnOpen,true);
  assert.equal(Object.hasOwn(v,'initialPath'),false);assert.equal(Object.hasOwn(v,'initialEntryId'),false);
  assert.deepEqual(f.requests.map(r=>r.command.method),['claim_client','identity']);assert.equal(f.heads.size,0);assert.deepEqual(f.openedRefs,[]);
  assert.ok(v.adapter.durableWrites);assert.equal(v.adapter.durableNamespace,true);assert.ok(v.mobileLifecycle);assert.ok(v.recoverCommands);
  await v.release!();assert.equal(f.closes,0);
});

test('existing selected note permits explicit false creation intent and keeps its identity guard',async()=>{
  const f=fixture();f.selection('Note.md','native-selected');f.newNote(false);const v=await openNativeMobileVault(f.plugin);
  assert.equal(v.editorOnly,true);assert.equal(v.createNoteOnOpen,false);assert.equal(v.initialEntryId,'native-selected');
  await assert.rejects(v.adapter.durableWrites!.readText('Note.md'),{code:'revision_conflict'});assert.deepEqual(f.openedRefs,[]);await v.release!();
});

test('absent New note context flag remains absent while native editor-only capability is present',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin);assert.equal(v.editorOnly,true);assert.equal(Object.hasOwn(v,'createNoteOnOpen'),false);await v.release!();
});

for(const value of [null,0,'true',{},[]]) test(`nonboolean New note context ${JSON.stringify(value)} fails admission`,async()=>{
  const f=fixture();f.newNote(value);await assert.rejects(openNativeMobileVault(f.plugin),{code:'invalid_native_context'});
  assert.equal(f.requests.length,0);assert.equal(f.removals,1);assert.equal(f.closes,0);
});

for(const [path,entryId] of [['Note.md','Selected'],['Note.md',undefined],[undefined,'Selected']] as const) test(`New note intent cannot coexist with selection ${JSON.stringify([path,entryId])}`,async()=>{
  const f=fixture();f.newNote(true);f.selection(path,entryId);await assert.rejects(openNativeMobileVault(f.plugin),{code:'invalid_native_context'});
  assert.equal(f.requests.length,0);assert.equal(f.removals,1);assert.deepEqual(f.openedRefs,[]);
});

const enabledEditor:NativeEditorState={focused:true,editable:true,canUndo:true,canRedo:true};
const disabledEditor:NativeEditorState={focused:false,editable:false,canUndo:false,canRedo:false};
const toolbarActions:NativeEditorAction[]=['insertLink','insertTable','insertCodeBlock','insertHorizontalRule','bold','italic','strikethrough','inlineCode','undo','redo','dismissKeyboard'];

test('toolbar enabling awaits subscriber listener readiness without blocking durable saves',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),gate=deferred(),actions:string[]=[];
  f.onActionInstall(async()=>{await gate.promise;});const stop=v.nativeEditor.subscribe(action=>{actions.push(action);});
  const state=v.nativeEditor.setState(enabledEditor);await until(()=>f.actionInstalls===1);
  assert.deepEqual(f.editorStates,[]);f.action({action:'bold'});assert.deepEqual(actions,[]);
  await v.adapter.write('Note.md','save while toolbar installs');assert.equal(f.content,'save while toolbar installs');
  gate.resolve();await state;assert.deepEqual(f.editorStates,[enabledEditor]);
  for(const action of toolbarActions){f.action({action});await until(()=>actions.length===toolbarActions.indexOf(action)+1);}
  assert.deepEqual(actions,toolbarActions);stop();await until(()=>f.actionRemovals===1);assert.deepEqual(f.editorStates.at(-1),disabledEditor);await v.release!();
});

test('no subscriber can enable native toolbar or replay an old state into a new listener',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin);await v.nativeEditor.setState(enabledEditor);assert.deepEqual(f.editorStates,[]);
  let calls=0;const stop=v.nativeEditor.subscribe(()=>{calls++;});await until(()=>f.actionInstalls===1);f.action({action:'bold'});await new Promise<void>(r=>setImmediate(r));assert.equal(calls,0);assert.deepEqual(f.editorStates,[]);
  await v.nativeEditor.setState(enabledEditor);stop();await until(()=>f.actionRemovals===1);await v.nativeEditor.setState(enabledEditor);assert.deepEqual(f.editorStates.at(-1),disabledEditor);await v.release!();
});

test('toolbar states coalesce in order and snapshot caller booleans',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),gate=deferred();const stop=v.nativeEditor.subscribe(()=>{});
  f.onEditorState(async()=>{await gate.promise;});const first=v.nativeEditor.setState(enabledEditor);await until(()=>f.editorStates.length===1);
  const skipped=v.nativeEditor.setState({...enabledEditor,canUndo:false});const input={...disabledEditor};const latest=v.nativeEditor.setState(input);input.focused=true;input.editable=true;
  gate.resolve();await Promise.all([first,skipped,latest]);assert.deepEqual(f.editorStates,[enabledEditor,disabledEditor]);stop();await v.release!();
});

test('toolbar rejects malformed state and action payloads without touching storage',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),calls:string[]=[];const stop=v.nativeEditor.subscribe(action=>{calls.push(action);});
  for(const state of [null,[],{...enabledEditor,extra:true},{...enabledEditor,canRedo:'true'},{focused:true,editable:true,canUndo:true}])await assert.rejects(v.nativeEditor.setState(state as any),{code:'invalid_editor_state'});
  await v.nativeEditor.setState(enabledEditor);
  for(const event of [null,[],{},{action:'unknown'},{action:'bold',extra:true},{action:1}])f.action(event);
  await new Promise<void>(r=>setImmediate(r));assert.deepEqual(calls,[]);
  const event={action:'bold'};f.action(event);event.action='unknown';await until(()=>calls.length===1);assert.deepEqual(calls,['bold']);
  const before=f.requests.length;stop();await until(()=>f.actionRemovals===1);assert.equal(f.requests.length,before);await v.release!();
});

test('toolbar actions honor current edit/history state and pending read-mode transition',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),calls:string[]=[];v.nativeEditor.subscribe(action=>{calls.push(action);});
  await v.nativeEditor.setState({...enabledEditor,canUndo:false,canRedo:false});f.action({action:'undo'});f.action({action:'redo'});f.action({action:'bold'});await until(()=>calls.length===1);
  f.action({action:'italic'});await v.nativeEditor.setState(disabledEditor);await new Promise<void>(r=>setImmediate(r));assert.deepEqual(calls,['bold']);
  await v.nativeEditor.setState({...enabledEditor,editable:false});f.action({action:'bold'});await new Promise<void>(r=>setImmediate(r));assert.equal(calls.length,1);await v.release!();
});

test('unsubscribe during listener installation cannot publish a stale enabling state',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),gate=deferred();f.onActionInstall(async()=>{await gate.promise;});
  const stop=v.nativeEditor.subscribe(()=>assert.fail('retired action callback'));const state=v.nativeEditor.setState(enabledEditor);await until(()=>f.actionInstalls===1);stop();gate.resolve();await state;await until(()=>f.actionRemovals===1);
  assert.deepEqual(f.editorStates,[disabledEditor]);await v.release!();
});

test('failed optional listener or state publication cannot fail a save or poison later subscription',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin);f.onActionInstall(async()=>{throw new Error('listener unavailable');});
  const first=v.nativeEditor.subscribe(()=>{});await v.nativeEditor.setState(enabledEditor);assert.deepEqual(f.editorStates,[]);await v.adapter.write('Note.md','listener failure survived');first();
  f.onActionInstall(async()=>{});const second=v.nativeEditor.subscribe(()=>{});f.onEditorState(async()=>{throw new Error('native state unavailable');});await v.nativeEditor.setState(enabledEditor);
  await v.adapter.write('Note.md','state failure survived');assert.equal(f.content,'state failure survived');second();await v.release!();assert.equal(f.closes,0);
});

test('in-flight optional state publication cannot block authoritative vault requests',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),gate=deferred();v.nativeEditor.subscribe(()=>{});f.onEditorState(async()=>{await gate.promise;});
  const state=v.nativeEditor.setState(enabledEditor);await until(()=>f.editorStates.length===1);await v.adapter.write('Note.md','saved independently');assert.equal(f.content,'saved independently');gate.resolve();await state;await v.release!();
});

test('release disables toolbar then drains an admitted action save before releasing lease',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),gate=deferred(),entered=deferred();
  v.nativeEditor.subscribe(async()=>{entered.resolve();await gate.promise;const w=v.adapter.durableWrites!;const plan=await w.planWrite({operationId:'toolbar-action-save',path:'Note.md',expectedEntryId:'entry',expectedRevision:'rev1',expectedContent:'before',content:'action saved'});const prepared=await w.prepare(plan);await w.commit(prepared.ref);});
  await v.nativeEditor.setState(enabledEditor);f.action({action:'bold'});await entered.promise;
  const release=v.release!();await until(()=>f.editorStates.at(-1)?.focused===false);assert.equal(f.actionRemovals,0);assert.equal(f.admitted,true);assert.equal(f.requests.some(r=>r.command.method==='release_client'),false);
  gate.resolve();await release;assert.equal(f.content,'action saved');assert.equal(f.actionRemovals,1);assert.equal(f.admitted,false);
  const before=f.editorStates.length;await v.nativeEditor.setState(enabledEditor);assert.equal(f.editorStates.length,before);assert.throws(()=>v.nativeEditor.subscribe(()=>{}),{code:'storage_closed'});
});

test('toolbar callback failures are contained and unsubscribe/resubscribe cannot relay stale actions',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin);let calls=0;
  const first=v.nativeEditor.subscribe(()=>{calls++;throw new Error('editor command rejected');});await v.nativeEditor.setState(enabledEditor);f.action({action:'bold'});await until(()=>calls===1);first();
  const second=v.nativeEditor.subscribe(async()=>{calls++;throw new Error('async editor failure');});await v.nativeEditor.setState(enabledEditor);f.action({action:'italic'});await until(()=>calls===2);await until(()=>f.actionRemovals===1);
  await v.adapter.write('Note.md','save unaffected');second();await v.release!();assert.equal(f.actionRemovals,2);
});

test('background ACK waits admitted editor action and leaves listener reusable after valid state refresh',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),gate=deferred(),entered=deferred(),done=deferred();let calls=0;
  v.nativeEditor.subscribe(async()=>{calls++;entered.resolve();await gate.promise;});await v.nativeEditor.setState(enabledEditor);f.action({action:'bold'});await entered.promise;
  v.mobileLifecycle.subscribe(async(_reason,ack)=>{await ack();done.resolve();});f.emit('background');await new Promise<void>(r=>setImmediate(r));assert.equal(f.acks.length,0);f.action({action:'italic'});assert.equal(calls,1);
  gate.resolve();await done.promise;await until(()=>f.editorStates.at(-1)?.focused===false);assert.equal(f.actionRemovals,0);await new Promise<void>(r=>setImmediate(r));await v.nativeEditor.setState(enabledEditor);f.action({action:'italic'});await until(()=>calls===2);await v.release!();
});

test('unsubscribe disables promptly but removes old listener only after callback settles',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),gate=deferred(),entered=deferred();
  const old=v.nativeEditor.subscribe(async()=>{entered.resolve();await gate.promise;});await v.nativeEditor.setState(enabledEditor);f.action({action:'bold'});await entered.promise;old();await until(()=>f.editorStates.at(-1)?.focused===false);assert.equal(f.actionRemovals,0);
  let calls=0;const next=v.nativeEditor.subscribe(()=>{calls++;});await v.nativeEditor.setState(enabledEditor);gate.resolve();await until(()=>f.actionRemovals===1);assert.deepEqual(f.editorStates.at(-1),enabledEditor);f.action({action:'italic'});await until(()=>calls===1);next();await v.release!();
});

test('successful switch cannot replay pending toolbar enable or accept later actions',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),gate=deferred(),done=deferred();let calls=0;
  v.nativeEditor.subscribe(()=>{calls++;});f.onEditorState(async()=>{await gate.promise;});const state=v.nativeEditor.setState(enabledEditor);await until(()=>f.editorStates.length===1);
  v.mobileLifecycle.subscribe(async(_reason,ack)=>{await ack();done.resolve();});f.emit('switchVault');await done.promise;
  f.action({action:'bold'});gate.resolve();await state;await until(()=>f.actionRemovals===1);assert.equal(calls,0);assert.deepEqual(f.editorStates.at(-1),disabledEditor);
  const before=f.editorStates.length;await v.nativeEditor.setState(enabledEditor);assert.equal(f.editorStates.length,before);await v.release!();assert.equal(f.closes,0);
});

test('negative lifecycle ACK replays latest workspace-restored toolbar state without another edit',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),negativeGate=deferred(),restored=deferred();let pending=false,applied={...disabledEditor},calls=0;
  f.onEditorState(async state=>{if(pending&&state.focused)throw new Error('native lifecycle still pending');applied={...state};});
  f.onAck(async input=>{if(!input.ok){await negativeGate.promise;pending=false;}});
  v.nativeEditor.subscribe(()=>{calls++;});await v.nativeEditor.setState(enabledEditor);const before=f.editorStates.length;
  const actual={...enabledEditor,canUndo:false};
  v.mobileLifecycle.subscribe(async()=>{try{throw new Error('workspace flush rejected');}finally{await v.nativeEditor.setState(actual);restored.resolve();}});
  pending=true;f.emit('switchVault');await restored.promise;await until(()=>f.acks.some(a=>!a.ok));await until(()=>applied.focused===false);
  assert.equal(f.editorStates.slice(before).some(s=>s.focused),false); // Restoration cannot race the pending native ACK.
  negativeGate.resolve();await until(()=>applied.focused===true);assert.deepEqual(applied,actual);
  f.action({action:'bold'});await until(()=>calls===1);await v.release!();
});

test('negative lifecycle restoration cannot enable toolbar after release starts',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),gate=deferred(),restored=deferred();
  v.nativeEditor.subscribe(()=>{});await v.nativeEditor.setState(enabledEditor);const before=f.editorStates.length;
  f.onAck(async input=>{if(!input.ok)await gate.promise;});
  v.mobileLifecycle.subscribe(async()=>{await v.nativeEditor.setState(enabledEditor);restored.resolve();throw new Error('flush failed');});
  f.emit('switchVault');await restored.promise;await until(()=>f.acks.some(a=>!a.ok));const release=v.release!();gate.resolve();await release;
  assert.equal(f.editorStates.slice(before).some(s=>s.focused),false);assert.equal(f.actionRemovals,1);
});

test('successful background does not replay handler restoration until a fresh foreground state',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),done=deferred();let appActive=true,applied={...disabledEditor};
  f.onEditorState(async state=>{if(state.focused&&!appActive)throw new Error('native app inactive');applied={...state};});
  v.nativeEditor.subscribe(()=>{});await v.nativeEditor.setState(enabledEditor);const before=f.editorStates.length;
  v.mobileLifecycle.subscribe(async(_reason,ack)=>{try{await ack();}finally{await v.nativeEditor.setState(enabledEditor);done.resolve();}});
  appActive=false;f.emit('background');await done.promise;await until(()=>applied.focused===false);await new Promise<void>(r=>setImmediate(r));
  assert.equal(f.editorStates.slice(before).some(s=>s.focused),false);appActive=true;await v.nativeEditor.setState(enabledEditor);assert.deepEqual(applied,enabledEditor);await v.release!();
});

test('strict foreground state requests coalesce and query current state without editing',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin);let queries=0;
  const actual={focused:false,editable:false,canUndo:true,canRedo:false};
  v.nativeEditor.subscribe(()=>assert.fail('state query is not an editor action'),async()=>{queries++;await v.nativeEditor.setState(actual);});
  await until(()=>f.requestInstalls===1);for(const event of [null,[],{},{reason:'background'},{reason:'foreground',extra:true}])f.stateRequest(event);
  await new Promise<void>(r=>setImmediate(r));assert.equal(queries,0);
  f.stateRequest();f.stateRequest();await until(()=>f.editorStates.length===1);assert.equal(queries,1);assert.deepEqual(f.editorStates.at(-1),actual);
  assert.equal(f.requests.some(r=>['file_command','prepare_intent','checkpoint_cas'].includes(r.command.method)),false);await v.release!();assert.equal(f.requestRemovals,1);
});

test('foreground query received during background lifecycle waits for ACK and workspace restoration',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),gate=deferred(),restored=deferred();let queries=0,workspaceClosing=true;
  v.nativeEditor.subscribe(()=>{},async()=>{assert.equal(workspaceClosing,false);queries++;await v.nativeEditor.setState(enabledEditor);});await v.nativeEditor.setState(enabledEditor);await until(()=>f.requestInstalls===1);
  f.onAck(async input=>{if(input.ok)throw Object.assign(new Error('background canceled by foreground'),{code:'stale_lifecycle'});});
  v.mobileLifecycle.subscribe(async(_reason,ack)=>{try{await gate.promise;await ack();}finally{await v.nativeEditor.setState(disabledEditor);workspaceClosing=false;restored.resolve();}});
  f.emit('background');f.stateRequest();f.stateRequest();await new Promise<void>(r=>setImmediate(r));assert.equal(queries,0);
  gate.resolve();await restored.promise;await until(()=>queries===1&&f.editorStates.at(-1)?.focused===true);assert.deepEqual(f.acks.map(a=>a.ok),[true,false]);await v.release!();
});

test('foreground request after successful background refreshes current state through existing setter',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),done=deferred();let queries=0;
  v.nativeEditor.subscribe(()=>{},async()=>{queries++;await v.nativeEditor.setState(enabledEditor);});await v.nativeEditor.setState(enabledEditor);await until(()=>f.requestInstalls===1);
  v.mobileLifecycle.subscribe(async(_reason,ack)=>{await ack();done.resolve();});f.emit('background');await done.promise;await new Promise<void>(r=>setImmediate(r));await until(()=>f.editorStates.at(-1)?.focused===false);
  f.stateRequest();await until(()=>queries===1&&f.editorStates.at(-1)?.focused===true);await v.release!();
});

for(const mode of ['release','switch','unsubscribe','new-generation'] as const)test(`pending foreground query drops on ${mode}`,async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),gate=deferred(),done=deferred();let oldQueries=0,newQueries=0;
  const stop=v.nativeEditor.subscribe(()=>{},()=>{oldQueries++;});await v.nativeEditor.setState(enabledEditor);await until(()=>f.requestInstalls===1);
  v.mobileLifecycle.subscribe(async(_reason,ack)=>{await gate.promise;if(mode==='switch')await ack();done.resolve();});
  f.emit(mode==='switch'?'switchVault':'background');f.stateRequest();let release:Promise<void>|undefined;
  if(mode==='release')release=v.release!();else if(mode!=='switch'){stop();if(mode==='new-generation')v.nativeEditor.subscribe(()=>{},()=>{newQueries++;});}
  gate.resolve();await done.promise;await new Promise<void>(r=>setImmediate(r));if(release)await release;
  assert.equal(oldQueries,0);assert.equal(newQueries,0);
  if(mode==='new-generation'){await until(()=>f.requestInstalls===2);f.stateRequest();await until(()=>newQueries===1);}
  await v.release!();assert.equal(f.requestRemovals,f.requestInstalls);assert.equal(f.closes,0);
});

test('missing optional foreground listener leaves working actions and durable saves available',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin);let actions=0,queries=0;f.onRequestInstall(async()=>{throw new Error('unsupported optional event');});
  v.nativeEditor.subscribe(()=>{actions++;},()=>{queries++;});await v.nativeEditor.setState(enabledEditor);await until(()=>f.requestInstalls===1);
  f.action({action:'bold'});await until(()=>actions===1);f.stateRequest();await v.adapter.write('Note.md','optional event absent');assert.equal(f.content,'optional event absent');assert.equal(queries,0);await v.release!();assert.equal(f.actionRemovals,1);
});

test('state-query callback failures do not poison later queries, actions, or saves',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin);let queries=0,actions=0;
  v.nativeEditor.subscribe(()=>{actions++;},async()=>{queries++;if(queries===1)throw new Error('workspace query rejected');await v.nativeEditor.setState(enabledEditor);});await until(()=>f.requestInstalls===1);
  f.stateRequest();await until(()=>queries===1);await new Promise<void>(r=>setImmediate(r));f.stateRequest();await until(()=>queries===2&&f.editorStates.at(-1)?.focused===true);
  f.action({action:'bold'});await until(()=>actions===1);await v.adapter.write('Note.md','query rejection survived');await v.release!();
});

test('unsubscribe drains an in-flight state-query callback before removing both native listeners',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),gate=deferred(),entered=deferred();
  const stop=v.nativeEditor.subscribe(()=>{},async()=>{entered.resolve();await gate.promise;await v.nativeEditor.setState(enabledEditor);});await until(()=>f.requestInstalls===1);f.stateRequest();await entered.promise;stop();
  await new Promise<void>(r=>setImmediate(r));assert.equal(f.requestRemovals,0);assert.equal(f.actionRemovals,0);gate.resolve();await until(()=>f.requestRemovals===1&&f.actionRemovals===1);assert.equal(f.editorStates.some(s=>s.focused),false);await v.release!();
});

const readyPresentation:NativePresentationSettled={path:'資料/你好.md',entryId:'Opaque_Case-1',state:'ready'};

test('presentation settlement forwards exact bounded metadata and never records activation history',async()=>{
  const f=fixture(),received:NativePresentationSettled[]=[];f.plugin.presentationSettled=async input=>{received.push({...input});};
  const v=await openNativeMobileVault(f.plugin),before=f.requests.length;
  for(const state of ['ready','password','error'] as const)await v.presentationSettled({...readyPresentation,state});
  assert.deepEqual(received,['ready','password','error'].map(state=>({...readyPresentation,state})));
  assert.deepEqual(f.openedRefs,[]);assert.equal(f.requests.length,before);assert.equal(f.heads.size,0);await v.release!();
});

test('presentation settlement rejects malformed DTO and secret/error-body fields before dispatch',async()=>{
  const f=fixture();let calls=0;f.plugin.presentationSettled=async()=>{calls++;};const v=await openNativeMobileVault(f.plugin);
  for(const input of [null,[],{}, {...readyPresentation,state:'loading'},{...readyPresentation,path:'../Note.md'},{...readyPresentation,entryId:'bad id'}, {...readyPresentation,password:'secret'}, {...readyPresentation,errorBody:'content'}])await assert.rejects(v.presentationSettled(input as any),{code:'invalid_presentation_settled'});
  assert.equal(calls,0);await v.release!();
});

test('missing or rejected optional presentation method cannot fail editing or saves',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin);await v.presentationSettled(readyPresentation);
  f.plugin.presentationSettled=async()=>{throw new Error('old native plugin has no presentation method');};await v.presentationSettled({...readyPresentation,state:'error'});
  await v.adapter.write('Note.md','saved despite optional presentation');assert.equal(f.content,'saved despite optional presentation');assert.deepEqual(f.openedRefs,[]);await v.release!();
});

test('presentation snapshots caller data and coalesces stale queued settlements',async()=>{
  const f=fixture(),gate=deferred(),received:NativePresentationSettled[]=[];f.plugin.presentationSettled=async input=>{received.push({...input});if(received.length===1)await gate.promise;};const v=await openNativeMobileVault(f.plugin);
  const first=v.presentationSettled(readyPresentation);await until(()=>received.length===1);
  const stale=v.presentationSettled({...readyPresentation,state:'error'}),input={...readyPresentation,path:'latest.md'};const latest=v.presentationSettled(input);input.path='mutated.md';
  gate.resolve();await Promise.all([first,stale,latest]);assert.deepEqual(received,[readyPresentation,{...readyPresentation,path:'latest.md'}]);await v.release!();
});

test('pending lifecycle settlement and queued previous epoch cannot dismiss successor presentation',async()=>{
  const f=fixture(),gate=deferred(),negative=deferred(),received:NativePresentationSettled[]=[];f.plugin.presentationSettled=async input=>{received.push({...input});if(received.length===1)await gate.promise;};
  const v=await openNativeMobileVault(f.plugin),first=v.presentationSettled(readyPresentation);await until(()=>received.length===1);const stale=v.presentationSettled({...readyPresentation,path:'stale.md'});
  v.mobileLifecycle.subscribe(async()=>{await negative.promise;throw new Error('switch canceled');});f.emit('switchVault');await v.presentationSettled({...readyPresentation,path:'during-lifecycle.md'});
  negative.resolve();await until(()=>f.acks.some(a=>!a.ok));await new Promise<void>(r=>setImmediate(r));const fresh=v.presentationSettled({...readyPresentation,path:'current.md'});
  gate.resolve();await Promise.all([first,stale,fresh]);assert.deepEqual(received,[readyPresentation,{...readyPresentation,path:'current.md'}]);await v.release!();
});

test('stalled presentation callback does not block save/release and queued old-platform notifications drop',async()=>{
  const f=fixture(),gate=deferred(),received:NativePresentationSettled[]=[];f.plugin.presentationSettled=async input=>{received.push({...input});if(received.length===1)await gate.promise;};
  const first=await openNativeMobileVault(f.plugin),pending=first.presentationSettled(readyPresentation);await until(()=>received.length===1);const stale=first.presentationSettled({...readyPresentation,path:'queued-old.md'});
  await first.adapter.write('Note.md','save while skeleton callback waits');await first.release!();
  const successor=await openNativeMobileVault(f.plugin);await first.presentationSettled({...readyPresentation,path:'released.md'});gate.resolve();await Promise.all([pending,stale]);
  assert.deepEqual(received,[readyPresentation]);await successor.presentationSettled({...readyPresentation,path:'successor.md'});assert.equal(received.at(-1)!.path,'successor.md');await successor.release!();
});

test('successful switch drops pending presentation notifications and later calls',async()=>{
  const f=fixture(),gate=deferred(),done=deferred(),received:NativePresentationSettled[]=[];f.plugin.presentationSettled=async input=>{received.push({...input});await gate.promise;};
  const v=await openNativeMobileVault(f.plugin),first=v.presentationSettled(readyPresentation);await until(()=>received.length===1);const queued=v.presentationSettled({...readyPresentation,state:'password'});
  v.mobileLifecycle.subscribe(async(_reason,ack)=>{await ack();done.resolve();});f.emit('switchVault');await done.promise;await v.presentationSettled({...readyPresentation,state:'error'});gate.resolve();await Promise.all([first,queued]);assert.equal(received.length,1);await v.release!();
});

test('document capability is absent on old context without probing native commands',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin);assert.equal(Object.hasOwn(v,'documentSemantics'),false);assert.equal(Object.hasOwn(v.adapter,'documentSemantics'),false);await v.adapter.list();assert.equal(f.docRequests.length,0);await v.release!();
});
for(const value of [false,1,'true',null,{}])test(`document capability rejects non-true handshake ${JSON.stringify(value)}`,async()=>{
  const f=fixture();f.documents(value);await assert.rejects(openNativeMobileVault(f.plugin),{code:'invalid_native_context'});assert.equal(f.requests.length,0);assert.equal(f.removals,1);
});

test('admitted mobile exposes same shared Rust document service and typed body operations',async()=>{
  const f=fixture();f.documents();const v=await openNativeMobileVault(f.plugin),service=v.documentSemantics!;assert.equal(service,v.adapter.documentSemantics);assert.equal(f.docRequests.length,0);
  const initial=await service.status();assert.equal(initial.current,false);assert.equal(initial.snapshot,null);assert.equal(initial.source.watermark,'9007199254740993');
  await service.initialize();const stage=await service.begin();assert.equal((await service.pump(stage.stageId)).progress!.ready,true);await service.publish(stage.stageId);assert.equal((await service.status()).current,true);
  const pin=await service.open(),metadata=await pin.metadata('entry');assert.equal(metadata.value.entry.id,'entry');assert.deepEqual(Object.keys(metadata.value.metadata!.properties[0].value as object),['Title','title']);
  assert.equal((await pin.search({query:'你好'})).result.value.complete,true);assert.equal((await pin.backlinks({targetId:'entry'})).result.value.edges.length,0);assert.equal((await pin.base({id:'entry'})).value.definition.id,'entry');
  const native=f.requests.filter(r=>r.command.method==='documents');assert.equal(native.every(r=>r.command.client_id===clientId&&r.lease.client_id===clientId&&r.body===''),true);
  await service.rebuild();await assert.rejects(pin.metadata('entry'),{code:'snapshot_expired'});await service.open();await service.begin();await v.release!();
  assert.equal(f.docPins.size,0);assert.equal(f.docStages.size,0);assert.equal(f.closes,0);await assert.rejects(service.status(),{code:'client_not_admitted'});
});

test('mobile document requests share authoritative queue and reject UTF8/whole-request limits before dispatch',async()=>{
  const f=fixture();f.documents();const v=await openNativeMobileVault(f.plugin),service=v.documentSemantics!,gate=deferred(),entered=deferred();
  f.onDocument(async request=>{if(request.command.op==='status'){entered.resolve();await gate.promise;}});const status=service.status();await entered.promise;const read=v.adapter.read('Note.md');gate.resolve();await Promise.all([status,read]);assert.equal(f.maxActive,1);
  const pin=await service.open(),before=f.docRequests.length;
  await assert.rejects(pin.search({query:'😀'.repeat(1025)}),{code:'invalid_query'});
  await assert.rejects(pin.base({id:'entry',options:{searchTerms:Array(17).fill('a'.repeat(4096))}}),{code:'request_too_large'});assert.equal(f.docRequests.length,before);await v.release!();
});

for(const mode of ['marker','op','utf8','raw-limit','foreign-store'] as const)test(`mobile document transport rejects ${mode} response and preserves saves`,async()=>{
  const f=fixture();f.documents();const v=await openNativeMobileVault(f.plugin),original=f.plugin.request.bind(f.plugin);
  f.plugin.request=async input=>{const reply=await original(input);if(JSON.parse(input.header).command.method!=='documents')return reply;const header=JSON.parse(reply.header);
    if(mode==='marker')header.result.bytes++;
    if(mode==='utf8'){reply.body='/w==';header.result.bytes=1;}
    if(mode==='raw-limit')reply.body='A'.repeat(4*Math.ceil(16*1024*1024/3)+4);
    if(mode==='op'||mode==='foreign-store'){const body=JSON.parse(decoder.decode(Uint8Array.from(atob(reply.body),c=>c.charCodeAt(0))));if(mode==='op')body.op='open';else body.value.source.localStoreId='foreign';const bytes=encoder.encode(JSON.stringify(body));reply.body=btoa(String.fromCharCode(...bytes));header.result.bytes=bytes.length;}
    reply.header=JSON.stringify(header);return reply;};
  await assert.rejects(v.documentSemantics!.status(),{code:mode==='raw-limit'?'response_limit':'invalid_document_response'});f.plugin.request=original;await v.adapter.write('Note.md','save after bad document response');await v.release!();
});

test('shared codec pin owner rejects changed generation and wrong metadata identity',async()=>{
  const f=fixture();f.documents();const v=await openNativeMobileVault(f.plugin),pin=await v.documentSemantics!.open();
  f.documentTransform((op,value)=>op==='metadata'?{...value,snapshot:{...value.snapshot,generation:'2'}}:value);await assert.rejects(pin.metadata('entry'),{code:'invalid_document_response'});
  f.documentTransform((op,value)=>op==='metadata'?{...value,value:{...value.value,entry:{...value.value.entry,id:'wrong'}}}:value);await assert.rejects(pin.metadata('entry'),{code:'invalid_document_response'});f.documentTransform((_op,value)=>value);await v.release!();
});

test('release drains pending document open then closes pins and discards stages before lease release',async()=>{
  const f=fixture();f.documents();const v=await openNativeMobileVault(f.plugin),service=v.documentSemantics!,gate=deferred(),entered=deferred();await service.begin();
  f.onDocument(async request=>{if(request.command.op==='open'){entered.resolve();await gate.promise;}});const opened=service.open();await entered.promise;const release=v.release!();await assert.rejects(service.status(),{code:'client_not_admitted'});assert.equal(f.admitted,true);gate.resolve();await opened;await release;
  const ops=f.requests.map(r=>r.command.method==='documents'?r.command.request.command.op:r.command.method);assert.ok(ops.indexOf('close')<ops.indexOf('release_client'));assert.ok(ops.indexOf('discard')<ops.indexOf('release_client'));assert.equal(f.docPins.size,0);assert.equal(f.docStages.size,0);
});

test('uncertain mobile document cleanup retries exact pin and stage before releasing admission',async()=>{
  const f=fixture();f.documents();const v=await openNativeMobileVault(f.plugin),service=v.documentSemantics!;await service.open();await service.begin();f.hostError('documents',{code:'storage_io',message:'close uncertain',commit_uncertain:true});
  await assert.rejects(v.release!(),{code:'storage_io',commitUncertain:true});assert.equal(f.admitted,true);assert.equal(f.requests.some(r=>r.command.method==='release_client'),false);await assert.rejects(service.status(),{code:'client_not_admitted'});await v.release!();
  const closes=f.requests.filter(r=>r.command.method==='documents'&&r.command.request.command.op==='close');assert.equal(closes.length,2);assert.deepEqual(closes[0].command,closes[1].command);assert.equal(f.docStages.size,0);assert.equal(f.admitted,false);
});

test('background lifecycle drains admitted semantic read and retains binding and pin sequence',async()=>{
  const f=fixture();f.documents();const v=await openNativeMobileVault(f.plugin),service=v.documentSemantics!,pin=await service.open(),gate=deferred(),entered=deferred(),done=deferred();
  f.onDocument(async request=>{if(request.command.op==='metadata'){entered.resolve();await gate.promise;}});const read=pin.metadata('entry');await entered.promise;v.mobileLifecycle.subscribe(async(_reason,ack)=>{await ack();done.resolve();});f.emit('background');await assert.rejects(service.open(),{code:'client_not_admitted'});assert.equal(f.acks.length,0);gate.resolve();await read;await done.promise;await new Promise<void>(r=>setImmediate(r));
  assert.equal(v.documentSemantics,service);assert.equal((await service.open()).pinId,'2');assert.equal((await pin.metadata('entry')).value.entry.id,'entry');assert.equal(f.docRequests.some(r=>r.command.op==='close'),false);await v.release!();
});

test('stale switch ACK resumes SAME document service/pins and monotonic open sequence',async()=>{
  const f=fixture();f.documents();const v=await openNativeMobileVault(f.plugin),service=v.documentSemantics!,pin=await service.open();f.onAck(async input=>{if(input.ok)throw Object.assign(new Error('expired'),{code:'stale_lifecycle'});});
  v.mobileLifecycle.subscribe(async(_reason,ack)=>{await ack();});f.emit('switchVault');await until(()=>f.acks.length===2);await new Promise<void>(r=>setImmediate(r));
  assert.equal(v.documentSemantics,service);assert.equal((await pin.metadata('entry')).value.entry.id,'entry');assert.equal((await service.open()).pinId,'2');assert.equal(f.docRequests.some(r=>r.command.op==='close'),false);await v.release!();
});

test('successful switch drains documents then forbids queries and skips dead-host cleanup RPCs',async()=>{
  const f=fixture();f.documents();const v=await openNativeMobileVault(f.plugin),service=v.documentSemantics!,pin=await service.open(),gate=deferred(),entered=deferred(),done=deferred();await service.begin();
  f.onDocument(async request=>{if(request.command.op==='metadata'){entered.resolve();await gate.promise;}});const read=pin.metadata('entry');await entered.promise;v.mobileLifecycle.subscribe(async(_reason,ack)=>{await ack();done.resolve();});f.emit('switchVault');await new Promise<void>(r=>setImmediate(r));assert.equal(f.acks.length,0);gate.resolve();await read;await done.promise;
  const before=f.requests.length;await assert.rejects(service.status(),{code:'client_not_admitted'});await v.release!();assert.equal(f.requests.length,before);assert.equal(f.docRequests.some(r=>r.command.op==='close'||r.command.op==='discard'),false);assert.equal(f.closes,0);
});

test('namespace recovery reports false for empty and settled checkpoints and true only for recovered commits',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin);assert.equal(await v.recoverCommands!(),false);
  await v.adapter.rename('Note.md','Moved.md');assert.equal(await v.recoverCommands!(),false);
  f.hostError('checkpoint_cas',{code:'checkpoint_storage',message:'persisted before dispatch',commit_uncertain:true},true);
  await assert.rejects(v.adapter.rename('Moved.md','Recovered.md'),{commitUncertain:true});assert.equal(f.receipts.size,1);
  assert.equal(await v.recoverCommands!(),true);assert.equal((await v.adapter.list())[0].path,'Recovered.md');assert.equal(await v.recoverCommands!(),false);await v.release!();
});

test('recovery terminal rejection before any commit reports no inventory change',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin);
  f.hostError('checkpoint_cas',{code:'checkpoint_storage',message:'persisted before dispatch',commit_uncertain:true},true);
  await assert.rejects(v.adapter.rename('Note.md','Moved.md'),{commitUncertain:true});f.hostError('file_command',{code:'revision_conflict',message:'stale revision',commit_uncertain:false});
  assert.equal(await v.recoverCommands!(),false);assert.equal(f.receipts.size,0);assert.equal(await v.recoverCommands!(),false);await v.release!();
});

async function settleWatch(){for(let i=0;i<4;i++)await new Promise<void>(r=>setImmediate(r));}
function watchClock(t:any){const polls:(()=>void)[]=[];t.mock.method(globalThis,'setInterval',(callback:()=>void)=>{polls.push(callback);return polls.length as any;});t.mock.method(globalThis,'clearInterval',()=>{});return polls;}

test('watch uses listed baseline without initial duplicate notification and catches changes between list and subscribe',async t=>{
  const polls=watchClock(t),f=fixture(),v=await openNativeMobileVault(f.plugin);await v.adapter.list();let notices=0;
  const off=v.adapter.subscribe!(()=>{notices++;});await settleWatch();assert.equal(notices,0);polls[0]();await settleWatch();assert.equal(notices,0);off();
  f.replaceIdentity('updated','new content');await v.adapter.stat('Note.md');const off2=v.adapter.subscribe!(()=>{notices++;});await settleWatch();assert.equal(notices,1);
  polls[1]();await settleWatch();assert.equal(notices,1);off2();await v.release!();
});

test('watch before first list establishes baseline silently then reports later removal',async t=>{
  const polls=watchClock(t),f=fixture(),v=await openNativeMobileVault(f.plugin);let notices=0;const off=v.adapter.subscribe!(()=>{notices++;});await settleWatch();assert.equal(notices,0);
  await v.adapter.list();f.absent();polls[0]();await settleWatch();assert.equal(notices,1);polls[0]();await settleWatch();assert.equal(notices,1);off();await v.release!();
});

test('watch catches real update between a pending initial inventory and its first baseline poll',async t=>{
  watchClock(t);const f=fixture(),v=await openNativeMobileVault(f.plugin),original=f.plugin.request.bind(f.plugin),entered=deferred(),gate=deferred();let snapshots=0;
  f.plugin.request=async input=>{const reply=await original(input);if(JSON.parse(input.header).command.method==='list_snapshot'&&++snapshots===1){entered.resolve();await gate.promise;}return reply;};
  const inventory=v.adapter.list();await entered.promise;let notices=0;const off=v.adapter.subscribe!(()=>{notices++;});f.absent();gate.resolve();assert.equal((await inventory).length,1);await settleWatch();assert.equal(notices,1);off();await v.release!();
});

test('retired watch generation cannot notify successor or swallow its real update',async t=>{
  const polls=watchClock(t),f=fixture(),v=await openNativeMobileVault(f.plugin);await v.adapter.list();let oldNotices=0,newNotices=0;const off=v.adapter.subscribe!(()=>{oldNotices++;});await settleWatch();
  const original=f.plugin.request.bind(f.plugin),entered=deferred(),gate=deferred();let blocked=false;
  f.plugin.request=async input=>{const reply=await original(input);if(JSON.parse(input.header).command.method==='list_snapshot'&&!blocked){blocked=true;entered.resolve();await gate.promise;}return reply;};
  polls[0]();await entered.promise;off();f.absent();const off2=v.adapter.subscribe!(()=>{newNotices++;});gate.resolve();await settleWatch();assert.equal(oldNotices,0);assert.equal(newNotices,1);
  polls[0]();polls[1]();await settleWatch();assert.equal(newNotices,1);off2();await v.release!();
});

test('recovery reports partial committed work even when a later namespace step is rejected',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin);f.hostError('checkpoint_cas',{code:'checkpoint_storage',message:'requested persisted',commit_uncertain:true},true);
  await assert.rejects(v.adapter.rename('Note.md','Final.md'),{commitUncertain:true});const head=[...f.heads.values()][0],saved=JSON.parse(decoder.decode(Uint8Array.from(atob(head.body),c=>c.charCodeAt(0))));
  const prefix=structuredClone(saved.commands[0]);prefix.family.request.operation_id='prefix-operation';prefix.family.request.mutation.path='Intermediate.md';saved.commands.unshift(prefix);head.body=body(JSON.stringify(saved));head.metadata.byteLength=encoder.encode(JSON.stringify(saved)).length;
  const original=f.plugin.request.bind(f.plugin);f.plugin.request=async input=>{const reply=await original(input);const c=JSON.parse(input.header).command;if(c.method==='file_command'&&c.family.request.operation_id==='prefix-operation')f.hostError('file_command',{code:'revision_conflict',message:'later step rejected',commit_uncertain:false});return reply;};
  assert.equal(await v.recoverCommands!(),true);assert.equal((await v.adapter.list())[0].path,'Intermediate.md');assert.equal(await v.recoverCommands!(),false);await v.release!();
});

test('release suppresses a pending watch result instead of emitting a late inventory notification',async t=>{
  const polls=watchClock(t),f=fixture(),v=await openNativeMobileVault(f.plugin);await v.adapter.list();let notices=0;v.adapter.subscribe!(()=>{notices++;});await settleWatch();f.absent();
  const original=f.plugin.request.bind(f.plugin),entered=deferred(),gate=deferred();f.plugin.request=async input=>{const reply=await original(input);if(JSON.parse(input.header).command.method==='list_snapshot'){entered.resolve();await gate.promise;}return reply;};
  polls[0]();await entered.promise;const released=v.release!();gate.resolve();await released;await settleWatch();assert.equal(notices,0);
});

async function pauseNamespaceQueue(f:ReturnType<typeof fixture>,v:Awaited<ReturnType<typeof openNativeMobileVault>>) {
  const original=f.plugin.request.bind(f.plugin),entered=deferred(),gate=deferred();let held=false;
  f.plugin.request=async input=>{const reply=await original(input);if(JSON.parse(input.header).command.method==='checkpoint_list'&&!held){held=true;entered.resolve();await gate.promise;}return reply;};
  const recovery=v.recoverCommands!();await entered.promise;
  return async()=>{gate.resolve();await recovery;};
}

for(const change of ['missing','replaced','revised'] as const)test(`witnessed rename rejects ${change} source after caller check while namespace queue is occupied`,async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),observed=(await v.adapter.stat('Note.md'))!,resume=await pauseNamespaceQueue(f,v);
  const move=v.adapter.rename('Note.md','Moved.md',{entryId:observed.entryId!,revision:observed.revision!});
  if(change==='missing')f.absent();else f.replaceIdentity(change==='replaced'?'replacement':observed.entryId!,'changed after caller check');
  await resume();await assert.rejects(move,{code:'revision_conflict'});assert.equal(f.requests.some(r=>['checkpoint_cas','file_command'].includes(r.command.method)),false);assert.equal(f.heads.size,0);await v.release!();
});

test('rename captures witness before queueing so caller mutation cannot retarget replacement',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),observed=(await v.adapter.stat('Note.md'))!,resume=await pauseNamespaceQueue(f,v),witness={entryId:observed.entryId!,revision:observed.revision!};
  const move=v.adapter.rename('Note.md','Moved.md',witness);f.replaceIdentity('replacement','replacement file');witness.entryId='replacement';witness.revision='replacement-rev';
  await resume();await assert.rejects(move,{code:'revision_conflict'});assert.equal(f.requests.some(r=>['checkpoint_cas','file_command'].includes(r.command.method)),false);assert.equal((await v.adapter.stat('Note.md'))!.entryId,'replacement');await v.release!();
});

test('captured rename witness remains valid when caller mutates it after invocation',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),resume=await pauseNamespaceQueue(f,v),witness={entryId:'entry',revision:'rev1'};
  const move=v.adapter.rename('Note.md','Moved.md',witness);witness.entryId='other';witness.revision='other-revision';await resume();await move;
  const command=f.requests.find(r=>r.command.method==='file_command').command.family.request.mutation;assert.deepEqual(command,{type:'move',id:'entry',expected:'rev1',path:'Moved.md'});await v.release!();
});

test('witness mismatch cannot replace uncertain pending rename and matching retry preserves original operation',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),witness={entryId:'entry',revision:'rev1'};f.loseFileAck();await assert.rejects(v.adapter.rename('Note.md','Moved.md',witness),{commitUncertain:true});
  const original=f.requests.find(r=>r.command.method==='file_command'),before=f.requests.length;
  await assert.rejects(v.adapter.rename('Note.md','Moved.md',{entryId:'replacement',revision:'replacement-rev'}),{code:'file_operation_pending'});
  await assert.rejects(v.adapter.rename('Note.md','Moved.md',{entryId:'entry',revision:'new-revision'}),{code:'file_operation_pending'});
  await assert.rejects(v.adapter.rename('Note.md','Moved.md'),{code:'file_operation_pending'});assert.equal(f.requests.length,before);
  f.replaceIdentity('replacement','replacement must not be moved');await v.adapter.rename('Note.md','Moved.md',{...witness});const replay=f.requests.filter(r=>r.command.method==='file_command');assert.equal(replay.length,2);assert.deepEqual(replay[1].command,original.command);assert.equal(replay[1].body,original.body);assert.equal(f.receipts.size,1);await v.release!();
});

for(const witness of [null,{}, {entryId:'entry'}, {revision:'rev1'}, {entryId:'',revision:'rev1'}, {entryId:'entry',revision:'bad revision'}, {entryId:1,revision:'rev1'}])test(`rename rejects malformed identity before queue/dispatch ${JSON.stringify(witness)}`,async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),before=f.requests.length;await assert.rejects(v.adapter.rename('Note.md','Moved.md',witness as any),{code:'invalid_file_request'});assert.equal(f.requests.length,before);await v.adapter.rename('Note.md','Moved.md');await v.release!();
});

test('legacy rename without witness still follows current source metadata',async()=>{
  const f=fixture(),v=await openNativeMobileVault(f.plugin),resume=await pauseNamespaceQueue(f,v);const move=v.adapter.rename('Note.md','Moved.md');f.replaceIdentity('replacement','legacy replacement');await resume();await move;
  const command=f.requests.find(r=>r.command.method==='file_command').command.family.request.mutation;assert.equal(command.id,'replacement');assert.equal(command.expected,'replacement-rev');await v.release!();
});


const navigationRequest=()=>({id:crypto.randomUUID(),sourceOwnerId:crypto.randomUUID(),nativeTabId:crypto.randomUUID(),localStoreId:'store',entryId:'entry'});
test('same-vault capability is exact, optional, and never probes old native',async()=>{
  const old=fixture(),v=await openNativeMobileVault(old.plugin);assert.equal(v.nativeDocumentNavigation,undefined);await v.release!();
  for(const value of [true,0,2,'1',null]){
    const f=fixture();f.navigation(value);await assert.rejects(openNativeMobileVault(f.plugin),{code:'invalid_native_context'});
    assert.equal(f.requests.some(r=>r.command.method==='claim_client'),false);
  }
});
test('finite navigation can read storage then await native ACK without queue deadlock or duplicate ready',async()=>{
  const f=fixture();f.navigation();const v=await openNativeMobileVault(f.plugin),gate=deferred(),request=navigationRequest();let returned=false,calls=0;
  f.onNavigationResult(async result=>{if(result.status==='ready')await gate.promise;});
  v.nativeDocumentNavigation!.subscribe(async(input,control)=>{calls++;assert.ok(Object.isFrozen(input));await v.adapter.read('Note.md');await control.ready({path:'Note.md',entryId:input.entryId,revision:'rev1',recovery:'none'});returned=true;});
  f.navigate(request);await until(()=>f.navigationResults.length===1);assert.equal(returned,false);assert.equal(f.navigationResults[0].status,'ready');
  f.navigate(request);gate.resolve();await until(()=>returned);assert.equal(calls,1);await v.release!();assert.equal(f.navigationResults.length,1);
});
test('malformed/foreign navigation is rejected before handler and body metadata is strictly validated',async()=>{
  const f=fixture();f.navigation();const v=await openNativeMobileVault(f.plugin);let calls=0;
  v.nativeDocumentNavigation!.subscribe(async(req,control)=>{calls++;await control.ready({path:'.trash/note.md',entryId:req.entryId,revision:'rev1',recovery:'none'});});
  f.navigate({...navigationRequest(),localStoreId:'foreign'});await until(()=>f.navigationResults.length===1);assert.equal(calls,0);
  f.navigate({...navigationRequest(),extra:'path'});await until(()=>f.navigationResults.length===2);assert.equal(calls,0);
  f.navigate(navigationRequest());await until(()=>f.navigationResults.length===3);assert.equal(calls,1);assert.equal(f.navigationResults[2].status,'failed');
  await v.release!();
});
test('spontaneous note activation supersedes a command, without sending ready after the newer link',async()=>{
  const f=fixture();f.navigation();const v=await openNativeMobileVault(f.plugin),gate=deferred();let current=true;
  v.nativeDocumentNavigation!.subscribe(async(req,control)=>{await gate.promise;current=control.isCurrent();await control.ready({path:'Note.md',entryId:req.entryId,revision:'rev1',recovery:'none'});});
  f.navigate(navigationRequest());await new Promise<void>(r=>setImmediate(r));await v.noteOpened('Note.md','entry');gate.resolve();
  await until(()=>f.navigationResults.length===1);assert.equal(current,false);assert.equal(f.navigationResults[0].status,'stale');await v.release!();
});
test('positive native ACK remains committed when background invalidates during promise delivery',async()=>{
  const f=fixture();f.navigation();const v=await openNativeMobileVault(f.plugin),gate=deferred();let committed=false;
  f.onNavigationResult(async result=>{if(result.status==='ready')await gate.promise;});
  v.nativeDocumentNavigation!.subscribe(async(req,control)=>{await control.ready({path:'Note.md',entryId:req.entryId,revision:'rev1',recovery:'none'});committed=true;});
  f.navigate(navigationRequest());await until(()=>f.navigationResults.length===1);f.emit('background');gate.resolve();await until(()=>committed);
  assert.deepEqual(f.navigationResults.map(r=>r.status),['ready']);await v.release!();
});
test('newer request waits for rollback while invalidating the older independent navigation transaction',async()=>{
  const f=fixture();f.navigation();const v=await openNativeMobileVault(f.plugin),pending=deferred(),entered=deferred();
  const first=navigationRequest(),second=navigationRequest(),calls:string[]=[];
  v.nativeDocumentNavigation!.subscribe(async(req,control)=>{
    calls.push(req.id);if(req.id===first.id){entered.resolve();await pending.promise;assert.equal(control.isCurrent(),false);}
    await control.ready({path:'Note.md',entryId:req.entryId,revision:'rev1',recovery:'none'});
  });
  f.navigate(first);await entered.promise;f.navigate(second);await v.adapter.read('Note.md');assert.deepEqual(calls,[first.id]);
  pending.resolve();await until(()=>f.navigationResults.length===2);
  assert.deepEqual(f.navigationResults.map(result=>[result.id,result.status]),[[first.id,'stale'],[second.id,'ready']]);await v.release!();
});
test('navigation routing UUIDs require lowercase canonical spelling and entry tokens preserve case',async()=>{
  const f=fixture();f.navigation();const v=await openNativeMobileVault(f.plugin);let calls=0;
  v.nativeDocumentNavigation!.subscribe(async(req,control)=>{calls++;assert.equal(req.entryId,'Entry_Mixed-Case');await control.ready({path:'Note.md',entryId:req.entryId,revision:'Revision_Mixed-Case',recovery:'retainedDraft'});});
  const upper='ABCDEF01-abcd-4abc-8abc-abcdef012345';
  for(const field of ['sourceOwnerId','nativeTabId'])f.navigate({...navigationRequest(),[field]:upper});
  await until(()=>f.navigationResults.length===2);assert.equal(calls,0);assert.ok(f.navigationResults.every(result=>result.status==='failed'));
  f.navigate({...navigationRequest(),id:upper});await new Promise<void>(done=>setImmediate(done));assert.equal(f.navigationResults.length,2);
  f.navigate({...navigationRequest(),entryId:'Entry_Mixed-Case'});await until(()=>f.navigationResults.length===3);
  assert.equal(f.navigationResults[2].entryId,'Entry_Mixed-Case');assert.equal(f.navigationResults[2].revision,'Revision_Mixed-Case');await v.release!();
});
