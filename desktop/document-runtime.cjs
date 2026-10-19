'use strict';
// Delivery/execution only. Rust selects every maintenance effect and retry.
const {captureDocumentRuntimeRequest,captureDocumentRuntimeReply}=require('./document-semantics.cjs');
const {decodeWorkReply,sameTicket}=require('./document-drafts.cjs');
const MAX_RUNTIME_BYTES=64*1024,MAX_U64=18446744073709551615n;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const keys=(v,names)=>object(v)&&Object.keys(v).length===names.length&&names.every(k=>Object.hasOwn(v,k));
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const decimal=v=>typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v)&&BigInt(v)<=MAX_U64;
const positive=v=>decimal(v)&&v!=='0';
const integer=v=>Number.isSafeInteger(v)&&v>=0&&v<=0xffffffff;
const execution=v=>['dispatch','yield','waitForWake','quiesced'].includes(v);
const fail=code=>Object.assign(new Error('Document maintenance is unavailable.'),{code,commitUncertain:false});
const PUBLIC={runtime_observe:'documentRuntimeObserve',runtime_control:'documentRuntimeControl',runtime_ack:'documentRuntimeAckControl',runtime_outcome_ack:'documentRuntimeAckOutcome'};
const RUNTIME_OPS=new Set([...Object.keys(PUBLIC),'runtime_snapshot','runtime_step','runtime_owner','runtime_owner_ack']);
function copy(value){
  let nodes=0,units=0;const visit=(v,depth)=>{if(++nodes>4096||depth>16)throw fail('request_limit');
    if(v===null||typeof v==='boolean')return;if(typeof v==='number'){if(!Number.isFinite(v))throw fail('invalid_document_runtime');return;}
    if(typeof v==='string'){units+=v.length;if(units>MAX_RUNTIME_BYTES)throw fail('request_limit');return;}
    if(!object(v)&&!Array.isArray(v))throw fail('invalid_document_runtime');
    if(!Array.isArray(v)&&![Object.prototype,null].includes(Object.getPrototypeOf(v)))throw fail('invalid_document_runtime');
    const names=Object.keys(v);if(names.length>4096)throw fail('request_limit');for(const name of names){const d=Object.getOwnPropertyDescriptor(v,name);if(!d||!Object.hasOwn(d,'value'))throw fail('invalid_document_runtime');units+=name.length;if(units>MAX_RUNTIME_BYTES)throw fail('request_limit');visit(d.value,depth+1);}
  };visit(value,0);const raw=JSON.stringify(value);if(Buffer.byteLength(raw,'utf8')>MAX_RUNTIME_BYTES)throw fail('request_limit');return JSON.parse(raw);
}
const freeze=v=>{if(v&&typeof v==='object'){for(const item of Object.values(v))freeze(item);Object.freeze(v);}return v;};
function source(v){return keys(v,['localStoreId','watermark'])&&id(v.localStoreId)&&decimal(v.watermark);}
function snapshotId(v){return keys(v,['localStoreId','generationEpoch','generation','versions'])&&id(v.localStoreId)&&id(v.generationEpoch)&&positive(v.generation)&&keys(v.versions,['schema','extraction','resolver','query'])&&integer(v.versions.schema)&&v.versions.schema>0&&['extraction','resolver','query'].every(k=>typeof v.versions[k]==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(v.versions[k]));}
function progress(v){return v===null||keys(v,['prepared','total','ready'])&&integer(v.prepared)&&integer(v.total)&&v.prepared<=v.total&&typeof v.ready==='boolean'&&(!v.ready||v.prepared===v.total);}
const failures=['staleSource','staleIndex','snapshotExpired','rebuildRequired','uncertain','unavailable','invalidData','fatal'];
function update(v){return keys(v,['lifetime','revision','source','published','freshness','phase','progress','coverageComplete','hasForegroundDemand','error'])&&id(v.lifetime)&&decimal(v.revision)&&(v.source===null||source(v.source))&&(v.published===null||snapshotId(v.published))&&['unknown','current','lagging','unavailable'].includes(v.freshness)&&['idle','observing','initializing','recovering','indexing','publishing','rebuilding','releasing'].includes(v.phase)&&progress(v.progress)&&(v.coverageComplete===null||typeof v.coverageComplete==='boolean')&&typeof v.hasForegroundDemand==='boolean'&&(v.error===null||failures.includes(v.error))&&(v.freshness!=='current'||v.source!==null&&v.published!==null&&v.coverageComplete!==null)&&(v.source===null||v.published===null||v.source.localStoreId===v.published.localStoreId);}
function observation(v){return keys(v,['source','published','current','rebuildRequired','coverageComplete'])&&source(v.source)&&(v.published===null||snapshotId(v.published)&&v.published.localStoreId===v.source.localStoreId)&&typeof v.current==='boolean'&&typeof v.rebuildRequired==='boolean'&&(v.coverageComplete===null||typeof v.coverageComplete==='boolean')&&(!v.current||v.published!==null&&!v.rebuildRequired&&v.coverageComplete!==null);}
function outcome(v){if(!object(v)||!positive(v.id))return false;switch(v.kind){case'finished':return keys(v,['kind','id','observation'])&&observation(v.observation);case'failed':return keys(v,['kind','id','failure'])&&failures.includes(v.failure);case'cancelled':case'retired':return keys(v,['kind','id']);default:return false;}}
function issued(v){if(!keys(v,['lifetime','effectId','priority','targetSource','effect'])||!id(v.lifetime)||!positive(v.effectId)||!['foreground','background'].includes(v.priority)||(v.targetSource!==null&&!source(v.targetSource))||!object(v.effect))return false;
  const e=v.effect;if(['observe','recoverStage','initialize','begin','rebuild'].includes(e.kind))return keys(e,['kind']);return ['pump','publish','discard'].includes(e.kind)&&keys(e,['kind','snapshot'])&&snapshotId(e.snapshot)&&(v.targetSource===null||v.targetSource.localStoreId===e.snapshot.localStoreId);
}
function reduction(v){return keys(v,['effect','update','requestOutcomes','execution'])&&(v.effect===null||issued(v.effect))&&update(v.update)&&Array.isArray(v.requestOutcomes)&&v.requestOutcomes.length<=32&&v.requestOutcomes.every(outcome)&&new Set(v.requestOutcomes.map(o=>o.id)).size===v.requestOutcomes.length&&execution(v.execution)&&(v.effect===null||v.effect.lifetime===v.update.lifetime)&&(v.execution==='dispatch')===(v.effect!==null);}
function privateSnapshot(v){return v===null||keys(v,['update','inFlight','lastStep','execution'])&&update(v.update)&&(v.inFlight===null||issued(v.inFlight)&&v.inFlight.lifetime===v.update.lifetime)&&execution(v.execution)&&(v.execution!=='dispatch'||v.inFlight!==null)&&(v.execution!=='quiesced'||v.inFlight===null)&&(v.lastStep===null||keys(v.lastStep,['lifetime','effectId','reduction'])&&v.lastStep.lifetime===v.update.lifetime&&positive(v.lastStep.effectId)&&reduction(v.lastStep.reduction)&&v.lastStep.reduction.update.lifetime===v.lastStep.lifetime);}
function captureRuntimeRequest(op,input={}){
  if(!RUNTIME_OPS.has(op))throw fail('invalid_document_runtime');
  if(PUBLIC[op]){const args=captureDocumentRuntimeRequest(PUBLIC[op],op==='runtime_observe'?[]:[input]);return args[0]??{};}
  const v=copy(input);let valid=false;
  if(op==='runtime_snapshot')valid=keys(v,[]);
  else if(op==='runtime_step')valid=keys(v,['lifetime','effectId'])&&id(v.lifetime)&&positive(v.effectId);
  else if(op==='runtime_owner_ack')valid=keys(v,['sequence'])&&positive(v.sequence);
  else if(op==='runtime_owner'&&keys(v,['sequence','command'])&&positive(v.sequence)&&object(v.command)){
    valid=v.command.kind==='wake'?keys(v.command,['kind','monotonicMs'])&&decimal(v.command.monotonicMs):keys(v.command,['kind'])&&['continue','sourceHint','retire'].includes(v.command.kind);
  }
  if(!valid)throw fail('invalid_document_runtime');return freeze(v);
}
function rawRuntimeValue(op,args,value){
  if(PUBLIC[op]){
    if(op==='runtime_control'){
      if(!keys(value,['sequence','command','frame','snapshot'])||!privateSnapshot(value.snapshot))throw fail('invalid_document_response');
      captureDocumentRuntimeReply(PUBLIC[op],[args],{sequence:value.sequence,command:value.command,frame:value.frame},value.frame?.scope);
    }else if(op==='runtime_observe')captureDocumentRuntimeReply(PUBLIC[op],[],value,value?.scope);
    else if(value!==true)throw fail('invalid_document_response');
  }else if(op==='runtime_owner'){
    if(!keys(value,['sequence','command','snapshot'])||value.sequence!==args.sequence||JSON.stringify(value.command)!==JSON.stringify(args.command)||!privateSnapshot(value.snapshot))throw fail('invalid_document_response');
  }else if(op==='runtime_owner_ack'){if(value!==true)throw fail('invalid_document_response');}
  else if(!keys(value,['snapshot'])||!privateSnapshot(value.snapshot))throw fail('invalid_document_response');
  return freeze(value);
}
function decodeRuntimeReply(request,marker,bytes){
  const op=request?.command?.op;if(!RUNTIME_OPS.has(op)||!keys(marker,['documents','schemaVersion','bytes'])||marker.documents!==true||marker.schemaVersion!==1||!(bytes instanceof Uint8Array)||bytes.length===0||bytes.length>MAX_RUNTIME_BYTES||marker.bytes!==bytes.length)throw fail('invalid_document_response');
  let decoded;try{decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw fail('invalid_document_response');}
  if(!keys(decoded,['schemaVersion','op','value'])||decoded.schemaVersion!==1||decoded.op!==op)throw fail('invalid_document_response');
  const {op:_,...args}=request.command;return rawRuntimeValue(op,args,copy(decoded.value));
}
function validRuntimeReply(command,marker,bytes){try{decodeRuntimeReply(command.request,marker,bytes);return true;}catch{return false;}}
/** Exactly one native-selected effect per event-loop turn. The existing host
 * FIFO remains the only RPC queue. No stage/retry/priority planner lives here. */
class DocumentRuntimeScheduler{
  constructor({defer=setImmediate,cancel=clearImmediate,now=()=>Math.floor(performance.now()),onError=()=>{},workHost}={}){
    this.defer=defer;this.cancel=cancel;this.now=now;this.onError=onError;this.owners=new Set();this.current=null;this.scheduled=null;this.running=null;this.wakePending=false;this.hintPending=false;this.needsSnapshot=false;this.blocked=false;this.closed=false;this.sequence=1n;this.ownerCommand=null;this.retiring=false;this.retirementLifetime=null;
    if(workHost&&typeof workHost.documentWork!=='function')throw fail('unsupported_host_capability');
    this.workHost=workHost;this.composite=false;this.work=null;this.workWanted=false;this.workNeedsSnapshot=false;this.workWake=0;this.draftOwners=new Set();this.progress=0;this.progressTicket=null;this.progressWaiters=new Set();this.closePromise=null;
  }
  addDraftOwner({clientId,localStoreId,assertActive}){
    if(this.closed||!this.workHost||!id(clientId)||!id(localStoreId)||typeof assertActive!=='function')throw fail('unsupported_host_capability');
    const owner={clientId,localStoreId,assertActive,listeners:new Set(),released:false};this.draftOwners.add(owner);
    const remove=()=>{if(owner.released)return;owner.released=true;this.draftOwners.delete(owner);for(const slot of owner.listeners)try{slot.onRetire();}catch{}owner.listeners.clear();};
    return Object.freeze({
      notify:(request,reply)=>{if(owner.released||this.closed)throw fail('client_not_admitted');assertActive();if(reply?.result&&(reply.result.state!==null)&&(Object.hasOwn(reply.result,'state')||Object.hasOwn(reply.result,'job')))this.composite=true;if(!['snapshot','progress','facts_read'].includes(request.op)){if(this.composite)this.wakeWork();this.nudge();}},
      subscribe:(listener,onRetire=()=>{})=>{if(owner.released||this.closed||typeof listener!=='function'||typeof onRetire!=='function')throw fail('client_not_admitted');assertActive();const slot={listener,onRetire};owner.listeners.add(slot);return()=>owner.listeners.delete(slot);},
      release:remove,revoke:remove,
    });
  }
  wakeWork(){if(this.closed||!this.workHost)return;this.workWake++;this.workWanted=true;this.blocked=false;this.schedule();}
  progressAfter(sequence){if(this.progress!==sequence)return Promise.resolve();if(this.closed||this.blocked)return Promise.reject(fail('document_runtime_unavailable'));return new Promise((resolve,reject)=>this.progressWaiters.add({resolve,reject}));}
  settleProgress(){this.progress++;for(const waiter of this.progressWaiters)waiter.resolve();this.progressWaiters.clear();}
  rejectProgress(error){for(const waiter of this.progressWaiters)waiter.reject(error);this.progressWaiters.clear();}
  adoptWork(value,settled=null){
    const wasReady=this.work?.close_ready;this.work=value;if(value!==null)this.composite=true;
    if(settled&&!sameTicket(this.progressTicket,settled)){this.progressTicket=structuredClone(settled);this.settleProgress();}
    if(value?.close_ready&&!wasReady)this.settleProgress();
    this.nudge();
  }
  async workCall(request){if(this.closed||!this.workHost)throw fail('document_runtime_unavailable');return decodeWorkReply(request,await this.workHost.documentWork(request),new Uint8Array());}
  async workTurn(){
    // A fresh committed Wake can clear a fully retired native F owner. Only
    // its actual private snapshot may restore the legacy committed delivery.
    if(this.workNeedsSnapshot){
      const actual=await this.workCall({op:'snapshot'});this.workNeedsSnapshot=false;
      if(actual.work===null){this.work=null;this.composite=false;this.workWanted=false;this.progressTicket=null;return;}
      this.adoptWork(actual.work);this.workWanted=!actual.work.close_ready;return;
    }
    const wake=this.workWake;
    if(this.work?.selected){
      const ticket=this.work.selected,pending=this.work;let reply;
      try{reply=await this.workCall({op:'step',ticket});}
      catch(error){
        const actual=await this.workCall({op:'snapshot'});
        if(!sameTicket(actual.work?.last_settled,ticket)&&!(pending.closing&&actual.work?.closing&&actual.work.close_ready)){this.work=pending;throw error;}
        reply=actual;
      }
      this.adoptWork(reply.work,ticket);this.workWanted=reply.work!==null&&!reply.work.close_ready;
      if(this.select())this.needsSnapshot=true;
    }else{
      const reply=await this.workCall({op:'next_turn'});this.adoptWork(reply.work);this.workWanted=reply.turn?.state==='ready'||this.workWake!==wake;
      // Native adopted any real Continue outcomes into its existing client
      // mapping; feature observations remain hints, never global request IDs.
      if(this.select())this.needsSnapshot=true;
    }
  }
  async releaseDraftClient(reference){
    if(!this.workHost)throw fail('unsupported_host_capability');
    for(;;){
      const before=this.progress;
      try{return await this.workHost.releaseClient(reference);}
      catch(error){if(error?.code!=='document_drafts_draining')throw error;}
      // Revoked clients/listener absence cannot stop actual core Drop. Retry
      // only following an actual settled effect or actual close-ready proof.
      this.composite=true;this.wakeWork();await this.progressAfter(before);
    }
  }
  addOwner({host,clientId,localStoreId,assertActive}){
    if(this.closed||!host||typeof host.documentRuntime!=='function'||!id(clientId)||!id(localStoreId)||typeof assertActive!=='function')throw fail('invalid_admission');
    const owner={host,clientId,localStoreId,assertActive,paused:false,released:false,listeners:new Set(),prepared:false,releasing:false};this.owners.add(owner);this.wake();
    const call=async(op,args={})=>{if(owner.paused||owner.released||this.closed)throw fail('client_not_admitted');return this.call(owner,op,args);};
    const handle={
      observe:()=>call('runtime_observe'),
      control:async input=>{const captured=captureRuntimeRequest('runtime_control',input),raw=await call('runtime_control',captured);this.adopt(raw.snapshot,owner);this.nudge();this.schedule();return captureDocumentRuntimeReply('documentRuntimeControl',[captured],{sequence:raw.sequence,command:raw.command,frame:raw.frame},{localStoreId,clientId});},
      ackControl:async input=>{await call('runtime_ack',captureRuntimeRequest('runtime_ack',input));},
      ackOutcome:async input=>{await call('runtime_outcome_ack',captureRuntimeRequest('runtime_outcome_ack',input));},
      subscribe:(listener,onRetire=()=>{})=>{if(typeof listener!=='function'||typeof onRetire!=='function'||owner.released||this.closed)throw fail('client_not_admitted');const slot={listener,onRetire};owner.listeners.add(slot);return()=>owner.listeners.delete(slot);},
      pause:async()=>{owner.paused=true;if(!this.select())this.unschedule();await this.running?.catch(()=>{});},
      resume:()=>{if(owner.released||this.closed)throw fail('client_not_admitted');owner.paused=false;owner.prepared=false;owner.releasing=false;this.wake();},
      prepareRelease:()=>this.prepareRelease(owner),
      release:()=>this.remove(owner),
      revoke:async()=>{owner.paused=true;this.remove(owner);await this.running?.catch(()=>{});},
    };return Object.freeze(handle);
  }
  async prepareRelease(owner){
    owner.paused=true;owner.releasing=true;this.unschedule();
    while(this.running)await this.running.catch(()=>{});
    if(owner.prepared)return;
    if(this.composite){owner.prepared=true;this.schedule();return;}
    // Marking releasing is synchronous; concurrent last-window flushes cannot
    // both rely on the other's delayed native release ACK to do final cleanup.
    if([...this.owners].every(other=>other===owner||other.releasing)){
      const run=this.retireOwner(owner);this.running=run;
      try{await run;owner.prepared=true;}
      catch(error){this.blocked=true;throw error;}
      finally{if(this.running===run)this.running=null;this.schedule();}
    }else{owner.prepared=true;this.schedule();}
  }
  async retireOwner(owner){
    if(!this.retiring&&!this.ownerCommand&&this.current?.update.phase==='releasing'&&this.current.execution==='quiesced'&&!this.current.inFlight)return;
    if(this.ownerCommand)await this.controlOwner(owner,this.ownerCommand.command);
    if(!this.retiring){this.retirementLifetime=this.current?.update.lifetime??null;this.retiring=true;await this.controlOwner(owner,{kind:'retire'});if(this.retirementLifetime===null&&this.current)this.retirementLifetime=this.current.update.lifetime;}
    if(this.current?.inFlight)await this.step(owner);
    if(!this.retirementDone())throw fail('document_runtime_busy');
    this.retiring=false;this.retirementLifetime=null;
  }
  retirementDone(){return this.current===null?this.retirementLifetime===null:this.current.update.lifetime===this.retirementLifetime&&this.current.update.phase==='releasing'&&this.current.execution==='quiesced'&&this.current.inFlight===null;}
  select(){for(const owner of this.owners)if(!owner.paused&&!owner.released)return owner;return null;}
  assertOwner(owner){try{owner.assertActive();}catch(error){this.remove(owner);throw error;}}
  async call(owner,op,args={}){if(owner.released||this.closed)throw fail('client_not_admitted');this.assertOwner(owner);const captured=captureRuntimeRequest(op,args);const value=await owner.host.documentRuntime(owner.clientId,op,captured);if(owner.released||this.closed)throw fail('client_not_admitted');this.assertOwner(owner);const decoded=rawRuntimeValue(op,captured,copy(value));if(op==='runtime_control')captureDocumentRuntimeReply('documentRuntimeControl',[captured],{sequence:decoded.sequence,command:decoded.command,frame:decoded.frame},{localStoreId:owner.localStoreId,clientId:owner.clientId});if(op==='runtime_observe')return captureDocumentRuntimeReply('documentRuntimeObserve',[],decoded,{localStoreId:owner.localStoreId,clientId:owner.clientId});return decoded;}
  adopt(value,owner){if(!privateSnapshot(value))throw fail('invalid_document_response');if(value){const visit=v=>{if(!v||typeof v!=='object')return;if(Object.hasOwn(v,'localStoreId')&&v.localStoreId!==owner.localStoreId)throw fail('client_scope_mismatch');for(const child of Object.values(v))visit(child);};visit(value);}this.current=value;this.needsSnapshot=false;if(this.composite&&this.work?.close_ready&&value&&value.update.phase!=='releasing'){this.workNeedsSnapshot=true;this.workWanted=true;}else if(this.composite&&(value?.inFlight||value?.execution==='yield'))this.workWanted=true;}
  nudge(){for(const owner of [...this.owners,...this.draftOwners])if(!owner.released)for(const slot of owner.listeners)try{slot.listener();}catch{/* Observation delivery never undoes work. */}}
  remove(owner){if(owner.released)return;owner.released=true;this.owners.delete(owner);for(const slot of owner.listeners)try{slot.onRetire();}catch{}owner.listeners.clear();if(!this.owners.size){if(!this.composite||!this.workWanted)this.unschedule();else this.schedule();}else{this.needsSnapshot=true;this.schedule();}}
  wake(){if(this.closed)return;this.wakePending=true;if(this.composite)this.workWanted=true;this.blocked=false;this.schedule();}
  sourceHint(){if(this.closed)return;this.hintPending=true;if(this.composite)this.workWanted=true;this.schedule();}
  unschedule(){if(this.scheduled!==null){this.cancel(this.scheduled);this.scheduled=null;}}
  hasWork(){return this.select()&&(this.retiring||this.ownerCommand!==null||this.wakePending||this.hintPending||this.needsSnapshot)|| (this.composite?this.workWanted:this.current?.inFlight!==null&&!!this.current||this.current?.execution==='yield');}
  schedule(){if(this.closed||this.blocked||this.running||this.scheduled!==null||(!this.select()&&!this.composite)||!this.hasWork())return;this.scheduled=this.defer(()=>{this.scheduled=null;if(this.closed||this.blocked||this.running)return;const owner=this.select();if(!owner&&!this.composite)return;const run=this.turn(owner);this.running=run;void run.catch(error=>{if(owner?.released&&this.select()||this.composite&&owner&&(owner.released||owner.paused)&&['client_not_admitted','client_ownership_lost','grant_retired','durable_scope_changed'].includes(error?.code)){this.needsSnapshot=!!this.select();this.blocked=false;}else{this.blocked=true;this.rejectProgress(error);}try{this.onError(error);}catch{}}).finally(()=>{if(this.running===run)this.running=null;this.schedule();});});}
  async controlOwner(owner,command){
    if(!this.ownerCommand){if(this.sequence>MAX_U64)throw fail('document_runtime_capacity');this.ownerCommand={sequence:String(this.sequence++),command:freeze(copy(command)),accepted:false};}
    const pending=this.ownerCommand;if(!pending.accepted){const reply=await this.call(owner,'runtime_owner',{sequence:pending.sequence,command:pending.command});this.adopt(reply.snapshot,owner);if(pending.command.kind==='retire'&&this.retirementLifetime===null&&this.current)this.retirementLifetime=this.current.update.lifetime;pending.accepted=true;this.nudge();}
    await this.call(owner,'runtime_owner_ack',{sequence:pending.sequence});this.ownerCommand=null;
  }
  async step(owner){
    const token=this.current.inFlight;
    try{this.adopt((await this.call(owner,'runtime_step',{lifetime:token.lifetime,effectId:token.effectId})).snapshot,owner);this.nudge();}
    catch(error){
      const pending=this.current;
      this.adopt((await this.call(owner,'runtime_snapshot')).snapshot,owner);
      // Native intentionally retains no last-step ACK after final retirement.
      // Only this already-issued lifetime's actual terminal drain proves it is
      // safe to release; generic NoEffect or another lifetime proves nothing.
      const retired=this.retiring&&this.current?.update.lifetime===token.lifetime&&this.current.update.phase==='releasing'&&this.current.execution==='quiesced'&&this.current.inFlight===null;
      if(!retired&&(this.current?.lastStep?.lifetime!==token.lifetime||this.current?.lastStep?.effectId!==token.effectId)){if(this.retiring)this.current=pending;throw error;}
      this.nudge();
    }
  }
  async turn(owner){
    if(!owner){if(this.composite&&this.workWanted)await this.workTurn();return;}
    if(this.ownerCommand){await this.controlOwner(owner,this.ownerCommand.command);return;}
    // A possibly accepted Retire is irreversible. Deliver only its retained
    // command ACK/issued token before a newly admitted owner's fresh Wake.
    if(this.retiring){
      if(this.current?.inFlight)await this.step(owner);
      if(!this.retirementDone())throw fail('document_runtime_busy');
      this.retiring=false;this.retirementLifetime=null;return;
    }
    if(this.wakePending){const now=this.now();if(!Number.isSafeInteger(now)||now<0)throw fail('invalid_document_runtime');this.wakePending=false;this.hintPending=false;await this.controlOwner(owner,{kind:'wake',monotonicMs:String(now)});return;}
    if(this.hintPending){this.hintPending=false;await this.controlOwner(owner,{kind:'sourceHint'});return;}
    if(this.needsSnapshot){this.adopt((await this.call(owner,'runtime_snapshot')).snapshot,owner);this.nudge();return;}
    if(this.composite){if(this.workWanted)await this.workTurn();return;}
    if(this.current?.inFlight){await this.step(owner);return;}
    if(this.current?.execution==='yield')await this.controlOwner(owner,{kind:'continue'});
  }
  close(){
    if(this.closed)return Promise.resolve();if(this.closePromise)return this.closePromise;
    this.closePromise=(async()=>{
      if(this.workHost){
        this.unschedule();for(const owner of this.owners)owner.paused=true;
        while(this.running)await this.running.catch(()=>{});
        this.workNeedsSnapshot=false;this.ownerCommand=null;this.retiring=false;this.retirementLifetime=null;this.wakePending=false;this.hintPending=false;this.needsSnapshot=false;
        // Closing a failed owner is driven by actual trusted snapshots/tickets,
        // never by a revoked client's public callback or a fabricated ACK.
        if(!this.workHost.fatal&&!this.workHost.exited)this.blocked=false;
      }
      if(this.workHost&&!this.composite&&!this.workHost.fatal&&!this.workHost.exited)this.adoptWork((await this.workCall({op:'snapshot'})).work);
      if(this.composite&&!this.workHost.fatal&&!this.workHost.exited){
        while(this.running)await this.running;
        this.adoptWork((await this.workCall({op:'close'})).work);this.workWanted=!this.work?.close_ready;this.schedule();
        while(!this.work?.close_ready){const before=this.progress;this.schedule();await this.progressAfter(before);}
      }
      this.closed=true;this.unschedule();for(const owner of [...this.owners])this.remove(owner);
      for(const owner of [...this.draftOwners]){owner.released=true;for(const slot of owner.listeners)try{slot.onRetire();}catch{}owner.listeners.clear();}this.draftOwners.clear();
      this.rejectProgress(fail('client_not_admitted'));await this.running?.catch(()=>{});
    })();return this.closePromise;
  }
}
module.exports={MAX_RUNTIME_BYTES,DocumentRuntimeScheduler,captureRuntimeRequest,decodeRuntimeReply,validRuntimeReply,isRuntimeOp:op=>RUNTIME_OPS.has(op)};
