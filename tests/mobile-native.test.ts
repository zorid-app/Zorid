import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { openNativeMobileVault, type NativeVaultPlugin } from '../src/platform/mobile-native.ts';

const clientId = '11111111-1111-4111-8111-111111111111';
const token = '22222222-2222-4222-8222-222222222222';
const encoder = new TextEncoder(), decoder = new TextDecoder();
const body = (text: string) => btoa(String.fromCharCode(...encoder.encode(text)));
function fixture() {
  const requests: any[] = [], heads = new Map<string, any>(), intents = new Map<string, any>(), receipts = new Map<string, any>();
  let content = 'before', revision = 'rev1', path = 'Note.md', exists = true, closes = 0, sequence = 0, active = 0, maxActive = 0;
  let failCommand = false, failCheckpoint = false, failCommit = false, wrongId = false;
  const state = () => ({ id:'entry', path, kind:'file', revision, deleted:false });
  const presentation = () => ({id:'entry',ctime_ms:1,mtime_ms:2,size_bytes:encoder.encode(content).length});
  const plugin: NativeVaultPlugin = {
    context: async () => ({ name:'Native fixture',clientId }), close: async () => { closes++; },
    async request(input) {
      active++; maxActive = Math.max(maxActive,active);
      await new Promise(resolve => setImmediate(resolve));
      const header = JSON.parse(input.header), c = header.command; requests.push({ ...header,body:input.body });
      if (c.method !== 'claim_client') assert.deepEqual(header.lease,{local_store_id:'store',client_id:clientId,token});
      let result: any = {}, output = '';
      try {
        switch (c.method) {
          case 'claim_client': result = {lease:{local_store_id:'store',client_id:clientId,token}}; break;
          case 'identity': result = {identity:{local_store_id:'store'}}; break;
          case 'release_client': result = {released:true,reference:c.reference}; break;
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
        return {header:JSON.stringify({version:1,request_id:wrongId?'999':header.request_id,ok:true,result}),body:output};
      } finally { active--; }
    },
  };
  return { plugin, requests, heads, receipts, get content(){return content;}, get closes(){return closes;}, get maxActive(){return maxActive;}, loseFileAck(){failCommand=true;}, loseCheckpointAck(){failCheckpoint=true;}, wrongId(value=true){wrongId=value;}, loseCommitAck(){failCommit=true;}, absent(){exists=false;} };
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
  await vault.release!(); assert.equal(f.closes,1);
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
  await Promise.all([saving,releasing]); assert.equal(f.content,'drained'); assert.equal(f.closes,1);
  const methods=f.requests.map(r=>r.command.method); assert.ok(methods.indexOf('file_command')<methods.indexOf('release_client'));
  await assert.rejects(v.adapter.read('Note.md'),{code:'storage_closed'});
  await v.release!(); assert.equal(f.closes,1);
});
