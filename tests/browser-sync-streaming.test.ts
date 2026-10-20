import { normalizedLimits } from '../src/core/browser-normalized-idb.ts';
import {createBrowserManagedSchema} from '../src/core/browser-managed-records.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserBinaryStageStore } from '../src/core/browser-binary-stage-store.ts';
import { browserStreamingSync, browserStreamingSyncKeyPaths, browserStreamingSyncStores } from '../src/core/browser-sync-streaming.ts';
import { createBrowserNormalizedSchema, browserNormalizedStores, normalizedTransact } from '../src/core/browser-normalized-idb.ts';
const authority='11111111-1111-4111-8111-111111111111';
// This fixture tests host transaction plumbing only; opaque WASM doubles below
// do not implement CRDT, namespace, cryptography or authenticated Rust planning.
const sourceStores=['sync_source_headers','sync_source_payloads','sync_source_wires'] as const;
const compare=(a:any,b:any):number=>Array.isArray(a)!==Array.isArray(b)?(Array.isArray(a)?1:-1):Array.isArray(a)&&Array.isArray(b)?a.reduce((n,v,i)=>n||compare(v,b[i]),0)||a.length-b.length:a===b?0:a<b?-1:1;
const keyOf=(row:any,path:string|string[])=>Array.isArray(path)?path.map(key=>row[key]):row[path];
/** Transaction fixture stages writes and delivers the result only on complete. It deliberately
 * has no getAll implementation. These are foundation unit checks, not actual-browser evidence. */
function fixture(){
  const records=new Map<string,Map<string,any>>([['control',new Map([[JSON.stringify('local-store-id'),{key:'local-store-id',value:authority}]])]]);
  const paths=new Map<string,string|string[]>([['control','key']]);
  const indexes=new Map<string,Array<{name:string,path:string|string[],unique:boolean}>>();
  const requests:{store:string;operation:string;key?:any}[]=[];
  const transactions:any[]=[];
  let strict=true, hold=false, fail=false, denied=false;
  let payloadGate:any=null;
  const db:any={objectStoreNames:{contains(name:string){return records.has(name);}},
    createObjectStore(name:string,options:any){
      records.set(name,new Map());paths.set(name,options.keyPath);indexes.set(name,[]);
      return {createIndex(index:string,path:string|string[],options:any){indexes.get(name)!.push({name:index,path,unique:options.unique});}};
    },
    transaction(names:string[],mode:string,options?:any){
      assert.ok(names.includes('control'));assert.equal(new Set(names).size,names.length);
      if(mode==='readwrite')assert.deepEqual(options,{durability:'strict'});
      const local=new Map(names.map(name=>{if(!records.has(name))throw new Error('missing store');return[name,structuredClone(records.get(name)!)];}));
      const modified=new Set<string>();let pending=0,aborted=false,completed=false,scheduled=false;
      const listeners=new Map<string,Array<()=>void>>();
      const tx:any={durability:strict?'strict':'relaxed',names,mode,isTerminal(){return aborted||completed;},addEventListener(name:string,callback:()=>void){listeners.set(name,[...(listeners.get(name)??[]),callback]);},
        abort(){if(aborted||completed)return;aborted=true;queueMicrotask(()=>{for(const callback of listeners.get('abort')??[])callback();tx.onabort?.();});},
        finish(){if(aborted||completed||pending)return;if(hold){return;}if(fail&&mode==='readwrite'){fail=false;tx.abort();return;}
          completed=true;for(const name of modified)records.set(name,local.get(name)!);for(const callback of listeners.get('complete')??[])callback();tx.oncomplete?.();},
        objectStore(name:string){
          if(!local.has(name))throw new Error('store not in transaction');
          const request=(operation:string,key:any,operationFn:()=>any)=>{
            if(aborted||completed)throw new Error('inactive transaction');
            const result:any={};requests.push({store:name,operation,key:structuredClone(key)});pending++;
            const deliver=()=>{if(aborted)return;try{result.result=structuredClone(operationFn());result.onsuccess?.();}catch(error){tx.error=error;tx.abort();}finally{pending--;schedule();}};
            queueMicrotask(()=>{if(payloadGate&&name==='sync_source_payloads'&&operation==='get'&&mode===(payloadGate.mode??'readonly')){const gate=payloadGate;payloadGate=null;gate.release=()=>queueMicrotask(deliver);gate.entered();}else deliver();});return result;
          };
          const write=(row:any,add:boolean)=>{
            if(mode!=='readwrite')throw new Error('readonly write');
            const copy=structuredClone(row),key=keyOf(copy,paths.get(name)!);
            return request(add?'add':'put',key,()=>{
              const values=local.get(name)!;
              if(add&&values.has(JSON.stringify(key)))throw new Error('duplicate key');
              for(const index of indexes.get(name)??[])if(index.unique){
                const indexKey=keyOf(copy,index.path);if(indexKey.some?.((part:any)=>part===undefined))continue;
                for(const [existingKey,existing] of values)if(existingKey!==JSON.stringify(key)&&compare(keyOf(existing,index.path),indexKey)===0)throw new Error('unique index');
              }
              values.set(JSON.stringify(key),copy);modified.add(name);return key;
            });
          };
          const cursor=(range:any,direction:string,indexPath:any=paths.get(name))=>{
            const result:any={};requests.push({store:name,operation:indexPath===paths.get(name)?'cursor':'index-cursor'});pending++;
            const rows=[...local.get(name)!.values()].sort((a,b)=>compare(keyOf(a,indexPath),keyOf(b,indexPath)))
              .filter(row=>(!range||range.lower===undefined||compare(keyOf(row,indexPath),range.lower)>=(range.lowerOpen||range.open?1:0))&&(!range||range.upper===undefined||compare(keyOf(row,indexPath),range.upper)<=(range.upperOpen?-1:0)));
            if(direction==='prev')rows.reverse();let index=0;
            const step=()=>{if(aborted)return;let continued=false;const row=rows[index];
              result.result=row===undefined?null:{value:structuredClone(row),primaryKey:structuredClone(keyOf(row,paths.get(name)!)),continue(){if(continued)throw new Error('cursor already continued');continued=true;index++;pending++;queueMicrotask(step);}};
              try{result.onsuccess?.();}catch(error){tx.error=error;tx.abort();}pending--;schedule();};
            queueMicrotask(step);return result;
          };
          return {count(){return request('count',undefined,()=>local.get(name)!.size);},get(key:any){return request('get',key,()=>local.get(name)!.get(JSON.stringify(key)));},
            getKey(key:any){return request('getKey',key,()=>local.get(name)!.has(JSON.stringify(key))?key:undefined);},
            index(indexName:string){const definition=indexes.get(name)?.find(index=>index.name===indexName);assert.ok(definition,'missing index');return {get(key:any){return request('index-get',key,()=>[...local.get(name)!.values()].find(row=>compare(keyOf(row,definition.path),key)===0));},openCursor(range?:any,direction='next'){return cursor(range,direction,definition.path);}};},
            add(row:any){return write(row,true);},put(row:any){return write(row,false);},delete(key:any){return request('delete',key,()=>{local.get(name)!.delete(JSON.stringify(key));modified.add(name);});},
            getAll(){assert.fail('byte-bearing aggregate scan is forbidden');},
            openCursor(range?:any,direction='next'){return cursor(range,direction);},
          };
        },
      };
      function schedule(){if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;tx.finish();});}
      transactions.push(tx);schedule();return tx;
    },
  };
  records.get('control')!.set(JSON.stringify('binary-stream-usage:v1'),{key:'binary-stream-usage:v1',value:{version:1,stages:0,activeStages:0,sourcePayloadBytes:'0',chunkRecords:0,pageRecords:0}});
  records.get('control')!.set(JSON.stringify('sequence'),{key:'sequence',value:'0'});
  createBrowserNormalizedSchema(db);createBrowserManagedSchema(db);
  for(const [name,keyPath] of Object.entries({...browserStreamingSyncKeyPaths,metadata:'id',presentation:'id',content:'id',receipts:'key',journal:'sequence',intents:'key'}))if(!records.has(name))db.createObjectStore(name,{keyPath});
  indexes.set('sync_authored',[{name:'by_pending_order',path:['pending','order'],unique:false}]);
  indexes.set('metadata',[{name:'by_path',path:'path',unique:false}]);
  const run=<T>(stores:readonly string[],action:Parameters<typeof normalizedTransact<T>>[2],mode:IDBTransactionMode='readwrite',owner=authority)=>
    normalizedTransact<T>(db,{authorityId:owner,stores,mode,assertActive(){if(denied)throw Object.assign(new Error('retired'),{code:'owner_retired'});}},action);
  return {db,records,paths,indexes,requests,transactions,run,
    holdPayloadRead(mode='readonly'){let entered!:()=>void;const ready=new Promise<void>(resolve=>entered=resolve);const gate:any={entered,release:null,mode};payloadGate=gate;return {ready,release(){assert.equal(typeof gate.release,'function');gate.release();}};},
    deny(){denied=true;},relax(){strict=false;},hold(){hold=true;},finish(){hold=false;for(const tx of transactions)tx.finish();},failNextCommit(){fail=true;},
    row(store:string,key:any){return records.get(store)!.get(JSON.stringify(key));},
    seed(store:string,key:any,row:any){records.get(store)!.set(JSON.stringify(key),structuredClone(row));if(store==='control'&&key==='test-publication'){
      records.get('metadata')!.clear();records.get('presentation')!.clear();for(const entry of row.value.entries)records.get('metadata')!.set(JSON.stringify(entry.id),clone(entry));
      for(const value of row.value.presentation)records.get('presentation')!.set(JSON.stringify(value.id),clone(value));records.get('control')!.set(JSON.stringify('sequence'),{key:'sequence',value:row.value.sequence});
    }},
  };
}
const scope={realm_id:'realm',vault_id:'vault'};
const summary=Array(32).fill(3), digest=Array(32).fill(2);
const clone=<T>(value:T):T=>structuredClone(value);
const same=(a:Uint8Array,b:Uint8Array)=>assert.deepEqual(a,b);
const keyOfId=(id:string)=>['realm','vault',id];
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
function metadata(id:string,payload:Uint8Array,binding:any=null){return {key:{...scope,update_id:id},family:binding?'text':'files',format_version:2,payload_digest:digest,payload_bytes:payload.length,text_binding:binding};}
function emission(id:string,payload=new Uint8Array([1,2,3]),binding:any=null){
  const meta=metadata(id,payload,binding);
  return {metadata:meta,payload:payload.slice(),record:binding?null:{payload_bytes:payload.length,payload_digest:digest,body:{kind:'chunk',bytes:payload.length,digest}},activity:binding?{identity:{...scope,entry_id:binding.entry_id,bootstrap_id:binding.text_bootstrap_id},update_id:id,namespace:clone(binding.namespace),payload_digest:digest,payload_bytes:payload.length}:null};
}
function harness(recordsEnabled=false){
  const f=fixture(),updates=new Map<string,any>(),wires=new Map<string,any>(),provided:any[]=[],plans:any[]=[];
  let lease=true,rejectProof=false,sealHook:(()=>void)|undefined,receiveRows:any[]=[];
  let verifyRequests:any[]=[];
  let binaryScript:any=null;
  const recoveries=new Map<string,{metadata:any;bytes:Uint8Array}>();
  let materializationReads=0,recoveryByteReads=0,recoveryFrees=0,graphBuilds=0;
  const classificationRows=new Map<string,any[]>();
  const classification=(rows:any[])=>({length(){return rows.length;},entryJson(index:number){return JSON.stringify(rows[index]);},textBytes(){return new Uint8Array([116,101,120,116]);},free(){}});
  const wireKey=(wire:Uint8Array)=>JSON.stringify([...wire]);
  const register=(e:any)=>{updates.set(e.metadata.key.update_id,e);return e;};
  const session=()=>{let position=0;return {
    nextChunkJson(){return position<verifyRequests.length?JSON.stringify(verifyRequests[position]):undefined;},
    providePayload(index:number,sequence:number,payload:Uint8Array){
      const request=verifyRequests[position++];assert.equal(index,request.manifest_index);assert.equal(sequence,request.sequence);
      assert.equal(f.transactions.filter(tx=>tx.mode==='readwrite'&&!tx.isTerminal?.()).length,0,'verification must precede writer transaction');
      provided.push({id:request.update_id,payload:payload.slice()});same(payload,updates.get(request.update_id).payload);return new Uint8Array([9]);
    },finish(){if(rejectProof)throw new Error('opaque proof rejected');return {free(){}};},free(){},
  };};
  function state(version:string,records=new Map<string,any>(),activities=new Map<string,any>()):any {
    return {version,records,activities,free(){},metadataHeadJson(){return JSON.stringify({scope,version,record_count:records.size,activity_count:activities.size});},namespaceViewJson(){return JSON.stringify({namespace:{pending:[]}});},verificationSession:session,classify(){return classification(classificationRows.get(version)??[]);},
      prepareBinaryMutation(raw:string,batch:any,built:any){
        assert.ok(binaryScript,'binary output must be scripted');assert.equal(batch,binaryScript.batch);assert.equal(built,binaryScript.built);
        batch.consume();built.consume();if(binaryScript.invokeError)throw new Error('opaque binary invocation rejected');
        const input=JSON.parse(raw);assert.deepEqual(input.target,binaryScript.target);
        return candidate(this,input.next_graph_revision,[binaryScript.final],{allocated_update_ids:binaryScript.allocated,changes:binaryScript.changes},binaryScript.rows,[...binaryScript.staged,binaryScript.final]);
      },
      recoveryContent(_proof:any,_texts:string,id:string){const value=recoveries.get(id)??{metadata:{status:'pending'},bytes:new Uint8Array([9])};
        return {metadataJson(){return JSON.stringify(value.metadata);},textBytes(){recoveryByteReads++;return value.bytes.slice();},free(){recoveryFrees++;}};
      },
      openBinaryRead(_proof:any,raw:string){const reference=JSON.parse(raw),chunkId=reference.chunk_id;assert.ok(updates.has(chunkId));
        return {free(){},length(){return reference.manifest.bytes;},chunkCount(){return 1;},chunkJson(index:number){assert.equal(index,0);return JSON.stringify({scope,update_id:chunkId,expected:updates.get(chunkId).record});},
          verifyPayload(index:number,exact:Uint8Array){assert.equal(index,0);same(exact,updates.get(chunkId).payload);return new Uint8Array([41,42,43]);},
        };
      },
      mutationRequirements(){return JSON.stringify({update_count:2,text:'create'});},
      prepareMutation(raw:string){const input=JSON.parse(raw),a=input.allocation,identity={...scope,entry_id:input.command.request.mutation.id,bootstrap_id:a.text.new_text.bootstrap_id};
        const text={identity,version:a.metadata_revision,snapshot:[4,5],actors:{}};
        const binding={entry_id:identity.entry_id,text_bootstrap_id:identity.bootstrap_id,namespace:{bootstrap_id:a.update_ids[0],parents:[a.update_ids[0]]}};
        const e=[register(emission(a.update_ids[0],new Uint8Array([11,12]))),register(emission(a.update_ids[1],new Uint8Array([21,22,23]),binding))];
        const path=input.command.request.mutation.path??'note.md',after={id:identity.entry_id,path,kind:'file',revision:a.metadata_revision,deleted:false};
        const rows=[{identity:{entry_id:identity.entry_id},outcome:{status:'normal',path,kind:'file',content:{kind:'text',content:{byte_length:'4',witness:{kind:'text',identity,revision:text.version}}}}}];
        return candidate(this,a.graph_revision,e,{allocated_update_ids:[...a.update_ids,identity.bootstrap_id],changes:[{before:null,after}],next_text:text},rows);
      },
    };
  }
  function candidate(base:any,version:string,emissions:any[],output:any={},rows:any[]=[],descriptors=emissions,nextPresent=true):any {
    const records=new Map(base.records),activities=new Map(base.activities);
    for(const e of descriptors)(e.record?records:activities).set(e.metadata.key.update_id,e.record??e.activity);
    classificationRows.set(version,clone(rows));
    const next=()=>state(version,records,activities);
    const recordDeltas=descriptors.filter(e=>e.record).map(e=>({update_id:e.metadata.key.update_id,record:e.record,summary_digest:summary}));
    const activityDeltas=descriptors.filter(e=>e.activity).map(e=>({update_id:e.metadata.key.update_id,activity:e.activity,summary_digest:summary}));
    const result={record_delta_count:recordDeltas.length,activity_delta_count:activityDeltas.length,payload_count:emissions.length,allocated_update_ids:[],changes:[],...output};
    const plan:any={free(){},resultJson(){return JSON.stringify(result);},nextStateCalls:0,nextState(){this.nextStateCalls++;return nextPresent?next():undefined;},
      recordDeltaJson(i:number){return JSON.stringify(recordDeltas[i]);},activityDeltaJson(i:number){return JSON.stringify(activityDeltas[i]);},
      payloadMetadataJson(i:number){return JSON.stringify(emissions[i].metadata);},payloadBytes(i:number){return emissions[i].payload.slice();},textBytes(){return new Uint8Array([116,101,120,116]);},receivedWireBytes(){return output.wire?.slice()??new Uint8Array();},
      checkPreconditions(actual:any){assert.equal(actual.version,base.version,'opaque plan receives current graph for CAS');},
      classify(){return classification(rows);},
    };plans.push(plan);
    return {free(){},payloadCount(){return emissions.length;},payloadMetadataJson:plan.payloadMetadataJson,payloadBytes:plan.payloadBytes,verificationSession:session,finalize(){return plan;}};
  }
  const recordScope={realm:'realm',vault:'vault',owner:'app:tasks',collection:'tasks',record:'item',generation:'gen',restores:null};
  let recordStatus='waiting_dependencies',recordProvider:any;
  const recordPlan=(factsJson:string)=>({
    free(){},checkPreconditions(actual:string){assert.equal(actual,factsJson);},resultJson(){return JSON.stringify({status:recordStatus,revision:Array(32).fill(1),conflicting_updates:[]});},
    nextState(){return recordStatus==='accepted'?new TextEncoder().encode('{}'):undefined;},projection(){return recordStatus==='accepted'?new TextEncoder().encode('{}'):undefined;},
    operationBindings(){return new TextEncoder().encode('[]');},payload(){},payloadMetadataJson(){},localRequest(){},
  });
  const wasm:any={
    WasmAuthoredMetadataBatch:class {free(){} pushPayload(){throw new Error('unused fixture capability');}},
    encodeFilePayload(){throw new Error('unused fixture capability');},createEmptyTextState(raw:string){const value=JSON.parse(raw);return JSON.stringify({...value,snapshot:[],actors:{}});},
    WasmMetadataStateBuilder:class {records=new Map();activities=new Map();version:string;
      constructor(_scope:string,version:string){this.version=version;graphBuilds++;}
      restoreRecord(id:string,record:string){this.records.set(id,JSON.parse(record));}
      restoreActivity(id:string,activity:string){this.activities.set(id,JSON.parse(activity));}
      finish(){return state(this.version,this.records,this.activities);}free(){}
    },
    validateFamilyCommand(raw:string){return raw;},checkFamilyCommandReplay(a:string,b:string){assert.equal(a,b);},
    validateAuthoredSyncPayload(raw:string,payload:Uint8Array){const meta=JSON.parse(raw),e=updates.get(meta.key.update_id);assert.ok(e,'unknown opaque emission');assert.deepEqual(meta,e.metadata);same(payload,e.payload);},
    validateSyncWire(raw:string,wire:Uint8Array){assert.deepEqual(JSON.parse(raw),wires.get(wireKey(wire))?.metadata);},
    materializeTextState(){materializationReads++;return new Uint8Array([116,101,120,116]);},rebindTextState(raw:string,_expected:string,next:string){return JSON.stringify({...JSON.parse(raw),version:next});},
  };
  if(recordsEnabled)Object.assign(wasm,{
    validateRecordsRegistration(){},validateRecordsAccepted(){},validateRecordsStoredOperation(){},validateRecordsStoredReplay(){},validateRecordsStoredBinding(){},recordsStoredReadSet(){return JSON.stringify({scope:recordScope,operations:[]});},
    canonicalRecordsLocalRequest(){throw new Error('unused local record fixture');},finalizeRecordsLocalResult(){throw new Error('unused local record fixture');},prepareRecordsLocal(){throw new Error('unused local record fixture');},
    recordsSnapshot(){return {free(){},nextState(){return new TextEncoder().encode('{}');},projection(){return new TextEncoder().encode('{}');},resultJson(){return '{}';}};},
    recordsRetryEligible(status:string){return !['accepted','invalid_operation','integrity_conflict'].includes(status);},
  });
  const host:any={db:f.db,authorityId:authority,wasm,now:()=>123,assertActive(){if(!lease)throw Object.assign(new Error('retired'),{code:'owner_retired'});},
    readPublication(tx:any,done:any,abort:any){const r=tx.objectStore('control').get('test-publication');r.onsuccess=()=>{try{done(r.result?.value??{entries:[],presentation:[],sequence:'0'});}catch(error){abort(error);}};},
    publish(tx:any,rows:any[],_origin:any,_forced:any,current:any){
      const entries=rows.filter(row=>row.entry&&row.status==='normal').map(row=>row.entry),presentation=rows.filter(row=>row.presentation&&row.status==='normal').map(row=>row.presentation);
      const sequence=String(BigInt(current.sequence)+1n);tx.objectStore('control').put({key:'test-publication',value:{entries,presentation,sequence}});
      tx.objectStore('control').put({key:'sequence',value:sequence});
      for(const row of rows)if(row.status==='normal'){tx.objectStore('metadata').put(row.entry);tx.objectStore('presentation').put(row.presentation);}
      for(const entry of current.entries)if(!entries.some(row=>row.id===entry.id)){tx.objectStore('metadata').delete(entry.id);tx.objectStore('presentation').delete(entry.id);}
      for(const row of rows)if(row.status==='normal'&&row.content?.kind==='text')tx.objectStore('content').put({id:row.id,bytes:row.content.bytes});
      return {sequence};
    },
  };
  const engine=browserStreamingSync(host);
  const wire=(e:any,bytes=new Uint8Array([81,82,83]))=>{register(e);wires.set(wireKey(bytes),e);return bytes.slice();};
  const key:any={seal(raw:string,payload:Uint8Array){const id=JSON.parse(raw).update_id,e=updates.get(id);same(payload,e.payload);const result=wire(e,new Uint8Array([91,92,wires.size]));sealHook?.();return result;},
    openSyncUpdate(raw:string,bytes:Uint8Array){const context=JSON.parse(raw),e=wires.get(wireKey(bytes));assert.ok(e,'opaque authentication rejected wire');assert.equal(context.update_id,e.metadata.key.update_id);
      return {free(){},metadataJson(){return JSON.stringify(e.metadata);},exactWire(){return bytes.slice();},matchesPayload(payload:Uint8Array){return Buffer.from(payload).equals(Buffer.from(e.payload));},exactPlaintext(){return e.payload.slice();},authenticatedDescriptorJson(){return JSON.stringify({record:e.record,activity:e.activity,summary_digest:e.metadata.family==='records'?null:summary});},
        recordsReadSetJson(){return JSON.stringify({scope:recordScope,operations:[]});},prepareRecords(facts:string){return recordPlan(facts);},
        prepareMetadataFile(base:any,next:string,prior:Uint8Array){return prior.length?candidate(base,base.version,[],{wire:bytes},receiveRows,[],false):candidate(base,next,[e],{wire:bytes},receiveRows);},
        prepareMetadataText(base:any,raw:string,prior:Uint8Array){
          const input=JSON.parse(raw);
          return prior.length?candidate(base,base.version,[],{wire:bytes},receiveRows,[],false):
            candidate(base,input.next_namespace_version,[],{wire:bytes,next_text:{...input.state,version:input.request.next_version}},receiveRows,[e]);
        },
      };
    },
  };
  const commit=(token:any)=>f.run<any>([...browserStreamingSyncStores,'metadata','presentation','content','control','receipts','journal','intents'],(tx,done,abort)=>engine.readPublication(tx,(current:any)=>engine.commitLocal(tx,token,current,done,abort),abort));
  const charge=(e:any)=>{
    if(f.row('sync_source_payloads',keyOfId(e.metadata.key.update_id)))return;
    const usage=clone(f.row('control','binary-stream-usage:v1').value);usage.sourcePayloadBytes=String(BigInt(usage.sourcePayloadBytes)+BigInt(e.payload.length));
    if(e.record?.body?.kind==='chunk')usage.chunkRecords++;if(e.record?.body?.kind==='page')usage.pageRecords++;
    f.seed('control','binary-stream-usage:v1',{key:'binary-stream-usage:v1',value:usage});
  };
  const seedStage=(e:any)=>{
    charge(e);
    register(e);const identity={realmId:'realm',vaultId:'vault',updateId:e.metadata.key.update_id};
    f.seed('sync_source_headers',keyOfId(identity.updateId),{...identity,descriptor:{version:1,metadata:e.metadata,record:e.record,activity:e.activity,summary_digest:summary}});
    f.seed('sync_source_payloads',keyOfId(identity.updateId),{...identity,bytes:e.payload});
  };
  const seed=(e:any)=>{
    charge(e);register(e);const identity={realmId:'realm',vaultId:'vault',updateId:e.metadata.key.update_id};
    f.seed('sync_source_headers',keyOfId(identity.updateId),{...identity,descriptor:{version:1,metadata:e.metadata,record:e.record,activity:e.activity,summary_digest:summary}});
    f.seed('sync_source_payloads',keyOfId(identity.updateId),{...identity,bytes:e.payload});
    f.seed(e.record?'sync_graph_records':'sync_graph_activities',keyOfId(identity.updateId),{...identity,...(e.record?{record:e.record}:{activity:e.activity}),summary_digest:summary});
    const order=String(BigInt(f.row('sync_state','authored-sequence')?.value??'0')+1n);
    f.seed('sync_authored',keyOfId(identity.updateId),{key:keyOfId(identity.updateId),metadata:e.metadata,pending:1,order:order.padStart(20,'0'),sealed:false});
    f.seed('sync_state','authored-sequence',{key:'authored-sequence',value:order});
    const head=f.row('sync_state','metadata-head');head.value[e.record?'record_count':'activity_count']++;f.seed('sync_state','metadata-head',head);
  };
  const commitRead=(token:any,readId='read')=>f.run<void>([...browserStreamingSyncStores,'metadata','presentation','content','control','receipts','journal','intents'],(tx,done,abort)=>host.readPublication(tx,(current:any)=>engine.commitRead(tx,token,current,()=>{
    tx.objectStore('binary_reads').add({clientId:'client',readId,entryId:token.reference.entry.entry_id,revision:token.revision,reference:token.reference});done(undefined);
  },abort),abort));
  const commitRecoveryRead=(token:any,readId='recovery-read')=>f.run<void>([...browserStreamingSyncStores,'metadata','presentation','content','control','receipts','journal','intents'],(tx,done,abort)=>host.readPublication(tx,(current:any)=>engine.commitRecoveryRead(tx,token,current,()=>{
    tx.objectStore('binary_reads').add({clientId:'client',readId,entryId:token.witness.entry_id,witness:token.witness,reference:token.reference});done(undefined);
  },abort),abort));
  return {f,engine,key,updates,wire,provided,plans,commit,seed,seedStage,commitRead,commitRecoveryRead,
    graphBuildCount:()=>graphBuilds,
    setRecordStatus(value:string){recordStatus=value;},setRecordProvider(value:any){recordProvider=value;host.recordsSession=()=>recordProvider;},
    scriptBinary(script:any){binaryScript=script;register(script.final);},
    failBinaryInvoke(){binaryScript.invokeError=true;},
    scriptClassifications(version:string,rows:any[]){classificationRows.set(version,clone(rows));},
    scriptRecovery(id:string,metadata:any,bytes=new Uint8Array([9])){recoveries.set(id,{metadata:clone(metadata),bytes:bytes.slice()});},
    recoveryCounts(){return {materializationReads,recoveryByteReads,recoveryFrees};},
    retire(){lease=false;},rejectProof(){rejectProof=true;},setSealHook(fn:()=>void){sealHook=fn;},
    requestVerification(ids:string[]){verifyRequests=ids.map((id,sequence)=>({scope,update_id:id,expected:updates.get(id).record,manifest_index:0,sequence}));},
    publishReceivedFolder(){receiveRows=[{identity:{entry_id:'remote-folder'},outcome:{status:'normal',path:'remote',kind:'folder',content:null}}];},
    publishReceivedText(text:any){receiveRows=[{identity:{entry_id:text.identity.entry_id},outcome:{status:'normal',path:'remote.md',kind:'file',content:{kind:'text',content:{byte_length:'4',witness:{kind:'text',identity:text.identity,revision:text.version}}}}}];},
  };
}
async function enrolled(){const h=harness();await h.engine.api.enroll({...scope,key_epoch:1});return h;}
async function local(h:Awaited<ReturnType<typeof enrolled>>,id='note'){
  const request={operation_id:'operation',mutation:{type:'create',id,path:id+'.md',kind:'file',content:[116,101,120,116]}};
  return h.engine.prepareLocal({requestJson:JSON.stringify(request),familyCommandJson:JSON.stringify({version:1,request,create_mode:'text'}),nextRevision:id+'-revision'});
}
Object.defineProperty(globalThis,'IDBKeyRange',{configurable:true,value:{only(value:any){return {lower:value,upper:value};},bound(lower:any,upper:any,lowerOpen=false,upperOpen=false){return {lower,upper,lowerOpen,upperOpen};},lowerBound(lower:any,open=false){return {lower,open};}}});
test('admission and owned sequential mutations use one full storage capture',async()=>{
  const h=await enrolled();await h.engine.validate();
  for(let index=0;index<5;index++)await h.commit(await local(h,'incremental-'+index));
  assert.equal(h.f.requests.filter(row=>row.store==='sync_graph_records'&&row.operation==='cursor').length,1);
  for(const store of ['sync_authored','sync_envelopes'])assert.equal(h.f.requests.filter(row=>row.store===store&&row.operation==='cursor').length,1,'warm admission uses the exact ledger byte/count summaries');
});
test('warm overlapping and aborted commits preserve committed storage and invalidate stale work',async()=>{
  const h=await enrolled();await h.engine.validate();const first=await local(h,'first'),stale=await local(h,'stale');
  await h.commit(first);await assert.rejects(h.commit(stale),{code:'sync_snapshot_conflict'});stale.dispose();
  const before=clone(h.f.records),aborted=await local(h,'aborted');h.f.failNextCommit();await assert.rejects(h.commit(aborted),{code:'storage_failure'});aborted.dispose();
  assert.deepEqual(h.f.records,before);await h.commit(await local(h,'after-abort'));
  assert.equal(h.f.row('control','test-publication').value.entries[0].id,'after-abort');
});
test('warm destination absence is checked against the actual nonunique path index',async()=>{
  const h=await enrolled();await h.engine.validate();const prepared=await local(h,'destination');
  h.f.seed('metadata','unexpected',{id:'unexpected',path:'destination.md',kind:'file',revision:'other',deleted:false});
  await assert.rejects(h.commit(prepared),{code:'sync_snapshot_conflict'});prepared.dispose();
  assert.equal(h.f.row('content','destination'),undefined);
});
test('scope-only reads stay fresh without graph restoration or whole-vault scans',async()=>{
  const h=await enrolled(),start=h.f.requests.length,transactionStart=h.f.transactions.length,builds=h.graphBuildCount();
  const first=await h.engine.readScope();assert.deepEqual(first,{...scope,key_epoch:1});
  first!.realm_id='caller-mutated';assert.deepEqual(await h.engine.readScope(),{...scope,key_epoch:1});
  const configuration=h.f.row('sync_state','config'),head=h.f.row('sync_state','metadata-head'),next={realm_id:'changed',vault_id:'other-vault'};
  h.f.seed('sync_state','config',{...configuration,value:{...configuration.value,...next,key_epoch:2}});
  h.f.seed('sync_state','metadata-head',{...head,value:{...head.value,scope:next}});
  assert.deepEqual(await h.engine.readScope(),{...next,key_epoch:2});
  assert.equal(h.graphBuildCount(),builds);
  assert.equal(h.f.requests.slice(start).some(row=>!['control','sync_state'].includes(row.store)||row.operation==='cursor'),false);
  for(const tx of h.f.transactions.slice(transactionStart))assert.deepEqual(tx.names.sort(),['control','sync_state']);
});
test('scope-only reads preserve enrollment, configuration and ownership admission',async()=>{
  assert.equal(await harness().engine.readScope(),null);
  for(const corruption of ['missing-head','missing-config','scope','epoch']){
    const h=await enrolled(),configuration=h.f.row('sync_state','config'),head=h.f.row('sync_state','metadata-head');
    if(corruption==='missing-head')h.f.records.get('sync_state')!.delete(JSON.stringify('metadata-head'));
    if(corruption==='missing-config')h.f.records.get('sync_state')!.delete(JSON.stringify('config'));
    if(corruption==='scope')h.f.seed('sync_state','metadata-head',{...head,value:{...head.value,scope:{...scope,vault_id:'wrong'}}});
    if(corruption==='epoch')h.f.seed('sync_state','config',{...configuration,value:{...configuration.value,key_epoch:0}});
    await assert.rejects(h.engine.readScope(),{code:'storage_corrupt'});
  }
  for(const invalid of [{realm_id:''},{vault_id:'wrong/value'},{realm_id:'x'.repeat(129)},{realm_id:{invalid:true}}]){
    const h=await enrolled(),configuration=h.f.row('sync_state','config'),head=h.f.row('sync_state','metadata-head');
    h.f.seed('sync_state','config',{...configuration,value:{...configuration.value,...invalid}});
    h.f.seed('sync_state','metadata-head',{...head,value:{...head.value,scope:{...scope,...invalid}}});
    await assert.rejects(h.engine.readScope(),{code:'storage_corrupt'});
  }
  const retired=await enrolled();retired.retire();await assert.rejects(retired.engine.readScope(),{code:'owner_retired'});
  const pending=await enrolled();pending.f.hold();const reading=pending.engine.readScope();await flush();pending.retire();pending.f.finish();
  await assert.rejects(reading,{code:'owner_retired'});
  const replaced=await enrolled();replaced.f.seed('control','local-store-id',{key:'local-store-id',value:'replaced'});
  await assert.rejects(replaced.engine.readScope(),{code:'storage_authority_mismatch'});
});
test('Text namespace emissions persist exact immutable sources with header-only pending rows',async()=>{
  const h=await enrolled();assert.equal(h.engine.api.concurrentPreparation,true);
  const prepared=await local(h);assert.equal(h.f.records.get('sync_source_payloads')!.size,0);
  assert.equal(h.plans[0].nextStateCalls,1);
  await h.commit(prepared);prepared.dispose();
  assert.equal(h.plans[0].nextStateCalls,1,'commit reuses the head already obtained from the immutable owned plan');
  const pending=await h.engine.api.pending(10);assert.equal(pending.length,2);assert.deepEqual(pending.map(row=>row.metadata.family),['files','text']);
  for(const row of pending){const id=row.metadata.key.update_id,stored=h.f.row('sync_authored',keyOfId(id));
    assert.deepEqual(Object.keys(stored).sort(),['key','metadata','order','pending','sealed']);assert.equal(stored.pending,1);assert.equal(row.sealed,null);
    same(h.f.row('sync_source_payloads',keyOfId(id)).bytes,h.updates.get(id).payload);
    const header=h.f.row('sync_source_headers',keyOfId(id));assert.equal(header.descriptor.version,1);assert.deepEqual(header.descriptor.metadata,row.metadata);
    assert.equal(Boolean(header.descriptor.record),row.metadata.family==='files');assert.equal(Boolean(header.descriptor.activity),row.metadata.family==='text');
  }
  assert.equal(h.f.records.get('sync_graph_records')!.size,1);assert.equal(h.f.records.get('sync_graph_activities')!.size,1);
  same(h.f.row('content','note').bytes,new TextEncoder().encode('text'));
  assert.equal(h.f.row('control','test-publication').value.sequence,'1');
  assert.equal(h.f.requests.some(r=>sourceStores.includes(r.store as any)&&r.operation==='cursor'),false,'source bodies are fetched only by identity');
});
test('seal returns the persisted winner and ACK requires its exact bytes',async()=>{
  const h=await enrolled();await h.commit(await local(h));const meta=(await h.engine.api.pending(10))[0].metadata,id=meta.key.update_id;
  const winner=h.wire(h.updates.get(id),new Uint8Array([71,72,73]));
  h.setSealHook(()=>{
    h.f.seed('sync_source_wires',keyOfId(id),{realmId:'realm',vaultId:'vault',updateId:id,bytes:winner});
    h.f.seed('sync_authored',keyOfId(id),{...h.f.row('sync_authored',keyOfId(id)),sealed:true});
    h.f.seed('sync_envelopes',keyOfId(id),{key:keyOfId(id),metadata:meta,direction:'authored'});
  });
  same(await h.engine.api.seal(id,h.key),winner);same(await h.engine.api.seal(id,h.key),winner);
  await assert.rejects(h.engine.api.acknowledge(id,new Uint8Array([71,72,74])),{code:'sync_ack_mismatch'});
  assert.equal(h.f.row('sync_authored',keyOfId(id)).pending,1);
  await h.engine.api.acknowledge(id,winner);assert.equal(h.f.row('sync_authored',keyOfId(id)).pending,0);
  assert.equal((await h.engine.api.pending(10)).length,1);same(h.f.row('sync_source_wires',keyOfId(id)).bytes,winner);
});
const startCursor={...scope,server_epoch:'epoch',after:'0'};
async function receiving(){const h=await enrolled();await h.engine.api.setCursor(startCursor,null);return h;}
const delivery={expected:startCursor,next:{...startCursor,after:'1'}};
test('received exact plaintext overlay verifies outside writer and commits source cursor and publication atomically',async()=>{
  const h=await receiving(),e=emission('remote',new Uint8Array([4,5,6])),wire=h.wire(e);
  h.requestVerification(['remote']);h.publishReceivedFolder();
  const result=await h.engine.api.receive('remote',wire,h.key,delivery);
  assert.equal(result.duplicate,false);assert.equal(result.sequence,'1');
  assert.deepEqual(h.provided,[{id:'remote',payload:e.payload}]);
  assert.equal(h.f.requests.some(r=>r.store==='sync_source_payloads'&&r.operation==='get'&&r.key?.[2]==='remote'),true,'immutable insertion rechecks its source in final transaction');
  same(h.f.row('sync_source_payloads',keyOfId('remote')).bytes,e.payload);same(h.f.row('sync_source_wires',keyOfId('remote')).bytes,wire);
  assert.deepEqual(h.f.row('sync_cursors',['realm','vault']).value,delivery.next);
  assert.equal(h.f.row('control','test-publication').value.entries[0].id,'remote-folder');
  assert.equal(h.f.records.get('sync_authored')!.size,0,'receive never authors echo');
});
test('Text received before namespace publishes its already fenced witness when dependencies arrive',async()=>{
  const h=await receiving();
  const binding={entry_id:'remote-note',text_bootstrap_id:'remote-bootstrap',namespace:{bootstrap_id:'remote-create',parents:['remote-create']}};
  const textUpdate=emission('remote-text',new Uint8Array([4,5,6]),binding),textWire=h.wire(textUpdate);
  // Opaque Rust classifications remain empty until the namespace dependency
  // arrives. This fixture verifies the host's revision fencing, not CRDT rules.
  await h.engine.api.receive('remote-text',textWire,h.key,delivery);
  const text=clone([...h.f.records.get('sync_text')!.values()][0].state);
  assert.ok(h.f.row('sync_revisions',text.version));
  assert.deepEqual(h.f.row('control','test-publication').value.entries,[]);
  const fences=h.f.records.get('sync_revisions')!.size;
  h.publishReceivedText(text);
  const create=emission('remote-create'),createWire=h.wire(create,new Uint8Array([84,85,86]));
  await h.engine.api.receive('remote-create',createWire,h.key);
  assert.equal(h.f.row('control','test-publication').value.entries[0].revision,text.version);
  assert.deepEqual([...h.f.records.get('sync_text')!.values()][0].state,text);
  assert.equal(h.f.records.get('sync_revisions')!.size,fences+1,'only the new graph revision is allocated');
  const replay=await h.engine.api.receive('remote-create',createWire,h.key);
  assert.equal(replay.duplicate,true);
  const textReplay=await h.engine.api.receive('remote-text',textWire,h.key);
  assert.equal(textReplay.duplicate,true);
  assert.equal(h.f.records.get('sync_revisions')!.size,fences+1,'exact replay reserves no revisions');
  await h.engine.api.receive('unrelated-chunk',h.wire(emission('unrelated-chunk'),new Uint8Array([87,88,89])),h.key);
  assert.equal(h.f.records.get('sync_revisions')!.size,fences+2,'unchanged Text witnesses reserve no new revision');
  await h.engine.validate();
});
test('new graph and forced Text or ancestor revisions still reject retained revision collisions',async()=>{
  const text=await enrolled();await text.commit(await local(text));
  await assert.rejects(text.commit(await local(text)),{code:'sync_revision_collision'});
  assert.equal(text.f.row('control','test-publication').value.sequence,'1');
  assert.equal(text.f.records.get('sync_authored')!.size,2);
  for(const revision of ['binary-graph','binary-revision']){
    const h=await binaryStage();h.f.seed('sync_revisions',revision,{revision});
    await assert.rejects(h.commit(await h.engine.prepareBinary(h.input)),{code:'sync_revision_collision'});
    assert.equal(h.f.row('sync_source_headers',keyOfId('binary-final')),undefined);
    assert.equal(h.f.records.get('sync_graph_records')!.size,0);
    assert.equal(h.f.row('control','test-publication').value.sequence,'1');
  }
});
test('exact authored echo advances only cursor without all-history proof or publication',async()=>{
  const h=await receiving();await h.commit(await local(h));
  const pending=await h.engine.api.pending(10),id=pending[0].metadata.key.update_id,wire=await h.engine.api.seal(id,h.key);
  const publication=clone(h.f.row('control','test-publication')),usage=clone(h.f.row('control','binary-stream-usage:v1'));
  const fences=h.f.records.get('sync_revisions')!.size,baseline=h.f.requests.length;
  h.rejectProof();
  assert.deepEqual(await h.engine.api.receive(id,wire,h.key,delivery),{duplicate:true,sequence:'1'});
  assert.deepEqual(h.f.row('sync_cursors',['realm','vault']).value,delivery.next);
  assert.deepEqual(h.f.row('control','test-publication'),publication);
  assert.deepEqual(h.f.row('control','binary-stream-usage:v1'),usage);
  assert.equal(h.f.records.get('sync_revisions')!.size,fences);
  assert.equal(h.f.row('sync_authored',keyOfId(id)).pending,1,'receive is not an upload ACK');
  const writes=h.f.requests.slice(baseline).filter(r=>['add','put'].includes(r.operation));
  assert.deepEqual(writes.map(r=>r.store),['sync_cursors']);
});
test('exact received Text replay preserves pending dependencies and only advances cursor',async()=>{
  const h=await receiving(),binding={entry_id:'pending-note',text_bootstrap_id:'pending-bootstrap',namespace:{bootstrap_id:'missing-create',parents:['missing-create']}};
  const e=emission('pending-text',new Uint8Array([4,5,6]),binding),wire=h.wire(e);
  await h.engine.api.receive('pending-text',wire,h.key,delivery);
  const publication=clone(h.f.row('control','test-publication')),text=clone([...h.f.records.get('sync_text')!.values()]),usage=clone(h.f.row('control','binary-stream-usage:v1'));
  h.rejectProof();
  const next={expected:delivery.next,next:{...startCursor,after:'2'}};
  assert.deepEqual(await h.engine.api.receive('pending-text',wire,h.key,next),{duplicate:true,sequence:'1'});
  assert.deepEqual(h.f.row('control','test-publication'),publication);
  assert.deepEqual([...h.f.records.get('sync_text')!.values()],text);
  assert.deepEqual(h.f.row('control','binary-stream-usage:v1'),usage);
  assert.deepEqual(h.f.row('sync_cursors',['realm','vault']).value,next.next);
});
test('exact receipt cursor commit rejects changed bytes and rolls back safely on abort',async()=>{
  for(const failure of ['payload','wire','abort']){
    const h=await receiving();await h.commit(await local(h));
    const id=(await h.engine.api.pending(10))[0].metadata.key.update_id,wire=await h.engine.api.seal(id,h.key);
    const publication=clone(h.f.row('control','test-publication'));
    if(failure==='abort')h.f.failNextCommit();
    else h.f.seed(failure==='payload'?'sync_source_payloads':'sync_source_wires',keyOfId(id),{realmId:'realm',vaultId:'vault',updateId:id,bytes:new Uint8Array([99])});
    await assert.rejects(h.engine.api.receive(id,wire,h.key,delivery),{code:failure==='abort'?'storage_failure':failure==='payload'?'immutable_source_conflict':'sync_update_collision'});
    assert.deepEqual(h.f.row('sync_cursors',['realm','vault']).value,startCursor);
    assert.deepEqual(h.f.row('control','test-publication'),publication);
    if(failure==='abort')assert.deepEqual(await h.engine.api.receive(id,wire,h.key,delivery),{duplicate:true,sequence:'1'});
  }
});
test('duplicate cursor commit rechecks configuration cursor and active lease after authentication',async()=>{
  for(const changed of ['config','cursor','lease']){
    const h=await receiving();await h.commit(await local(h));
    const id=(await h.engine.api.pending(10))[0].metadata.key.update_id,wire=await h.engine.api.seal(id,h.key),open=h.key.openSyncUpdate;
    h.key.openSyncUpdate=(raw:string,bytes:Uint8Array)=>{const result=open(raw,bytes);
      if(changed==='lease')h.retire();
      else if(changed==='cursor')h.f.seed('sync_cursors',['realm','vault'],{key:['realm','vault'],value:delivery.next});
      else {const row=clone(h.f.row('sync_state','config'));row.value.key_epoch++;h.f.seed('sync_state','config',row);}
      return result;
    };
    await assert.rejects(h.engine.api.receive(id,wire,h.key,delivery),{code:changed==='lease'?'owner_retired':changed==='cursor'?'sync_cursor_conflict':'sync_snapshot_conflict'});
    assert.equal(h.f.row('control','test-publication').value.sequence,'1');
    assert.deepEqual(h.f.row('sync_cursors',['realm','vault']).value,changed==='cursor'?delivery.next:startCursor);
  }
});
test('failed proof and final transaction abort retain cursor publication and source absence',async()=>{
  for(const failure of ['proof','commit']){
    const h=await receiving(),e=emission('remote'),wire=h.wire(e);h.requestVerification(['remote']);h.publishReceivedFolder();
    if(failure==='proof')h.rejectProof();else h.f.failNextCommit();
    await assert.rejects(h.engine.api.receive('remote',wire,h.key,delivery),{code:failure==='proof'?'sync_plan_rejected':'storage_failure'});
    assert.deepEqual(h.f.row('sync_cursors',['realm','vault']).value,startCursor);
    assert.equal(h.f.row('control','test-publication'),undefined);assert.equal(h.f.row('sync_source_headers',keyOfId('remote')),undefined);
    assert.equal(h.f.row('sync_source_payloads',keyOfId('remote')),undefined);assert.equal(h.f.row('sync_source_wires',keyOfId('remote')),undefined);
  }
});
test('tampered retained source rejects before receive publication or cursor advance',async()=>{
  const h=await receiving(),old=emission('retained'),incoming=emission('remote');h.seed(old);h.wire(incoming);h.requestVerification(['retained','remote']);
  h.f.seed('sync_source_payloads',keyOfId('retained'),{realmId:'realm',vaultId:'vault',updateId:'retained',bytes:new Uint8Array([8,8,8])});
  await assert.rejects(h.engine.api.receive('remote',h.wire(incoming),h.key,delivery),{code:'sync_plan_rejected'});
  assert.deepEqual(h.f.row('sync_cursors',['realm','vault']).value,startCursor);assert.equal(h.f.row('sync_source_headers',keyOfId('remote')),undefined);
  same(h.f.row('sync_source_payloads',keyOfId('retained')).bytes,new Uint8Array([8,8,8]));
});
test('stale publication CAS cannot admit a prepared local plan',async()=>{
  const h=await enrolled(),prepared=await local(h);
  h.f.seed('control','test-publication',{key:'test-publication',value:{entries:[],presentation:[],sequence:'7'}});
  await assert.rejects(h.commit(prepared),{code:'sync_snapshot_conflict'});prepared.dispose();
  assert.equal(h.f.records.get('sync_source_payloads')!.size,0);assert.equal(h.f.records.get('sync_authored')!.size,0);
  assert.equal(h.f.row('control','test-publication').value.sequence,'7');
});
test('session revocation during async source read fences receive while independent local callbacks continue',async()=>{
  const h=await receiving(),old=emission('retained'),incoming=emission('remote');h.seed(old);h.requestVerification(['retained']);
  let sessionActive=true;const bound=h.engine.api.bindSession(()=>{if(!sessionActive)throw Object.assign(new Error('revoked'),{code:'session_revoked'});});
  const gate=h.f.holdPayloadRead(),receive=bound.receive('remote',h.wire(incoming),h.key,delivery);const rejected=assert.rejects(receive,{code:'session_revoked'});
  await gate.ready;sessionActive=false;
  await h.f.run(['control'],(tx,done)=>{tx.objectStore('control').put({key:'local-callback',value:'saved'});done(undefined);});
  gate.release();await rejected;
  assert.equal(h.f.row('control','local-callback').value,'saved');assert.deepEqual(h.f.row('sync_cursors',['realm','vault']).value,startCursor);
  assert.equal(h.f.row('sync_source_headers',keyOfId('remote')),undefined);assert.equal(h.provided.length,0);
  await h.engine.api.inspect();await assert.rejects(bound.inspect(),{code:'session_revoked'});
});
test('concurrent cursor CAS change during verification is retained without admitting received sources',async()=>{
  const h=await receiving(),old=emission('retained'),incoming=emission('remote');h.seed(old);h.requestVerification(['retained']);
  const gate=h.f.holdPayloadRead(),receive=h.engine.api.receive('remote',h.wire(incoming),h.key,delivery);
  const rejected=assert.rejects(receive,{code:'sync_cursor_conflict'});await gate.ready;
  const current={...startCursor,after:'7'};
  h.f.seed('sync_cursors',['realm','vault'],{key:['realm','vault'],value:current});
  gate.release();await rejected;
  assert.deepEqual(h.f.row('sync_cursors',['realm','vault']).value,current);
  assert.equal(h.f.row('control','test-publication'),undefined);
  assert.equal(h.f.row('sync_source_headers',keyOfId('remote')),undefined);
  assert.equal(h.f.row('sync_source_payloads',keyOfId('remote')),undefined);
});
async function binaryStage(){
  const h=await enrolled(),chunk=emission('staged-chunk',new Uint8Array([31,32,33])),page=emission('staged-page',new Uint8Array([34,35]));
  page.record!.body={kind:'page',page:{chunks:[{id:'staged-chunk',bytes:3,digest}]}} as any;
  h.seedStage(chunk);h.seedStage(page);
  const parent={id:'parent',path:'assets',kind:'folder',revision:'parent-before',deleted:false};
  h.f.seed('control','test-publication',{key:'test-publication',value:{entries:[parent],presentation:[],sequence:'1'}});
  const final=emission('binary-final',new Uint8Array([61,62]));
  final.record!.body={kind:'events',events:[]} as any;
  const reference={scope:clone(scope),entry:{entry_id:'binary',bootstrap_id:'binary-final'},selected_event:'binary-final',manifest:{bytes:'3',digest,pages:[]},chunk_id:'staged-chunk'};
  const changes=[{before:null,after:{id:'binary',path:'assets/data.bin',kind:'file',revision:'binary-revision',deleted:false}},
    {before:parent,after:{...parent,revision:'binary-revision'}}];
  const rows=[{identity:{entry_id:'binary'},outcome:{status:'normal',path:'assets/data.bin',kind:'file',content:{kind:'binary',content:reference}}},
    {identity:{entry_id:'parent'},outcome:{status:'normal',path:'assets',kind:'folder',content:null}}];
  const owned=()=>({counts:{consumed:0,freed:0},freeThrows:false,consume(){this.counts.consumed++;},free(){this.counts.freed++;if(this.freeThrows)throw new Error('cleanup must not mask original failure');}});
  const batch={...owned(),pushPayload(){throw new Error('scripted opaque stage already built');}},built={...owned(),manifestJson(){return JSON.stringify(reference.manifest);}},target={kind:'create',id:'binary',path:'assets/data.bin'};
  h.scriptBinary({batch,built,target,final,staged:[chunk,page],changes,rows,allocated:['staged-chunk','staged-page','binary-final']});
  h.requestVerification(['staged-chunk']);
  const input={target,batch,built,finalEventId:'binary-final',metadataRevision:'binary-revision',graphRevision:'binary-graph',sourceKeys:[chunk,page].map(e=>({realmId:'realm',vaultId:'vault',updateId:e.metadata.key.update_id}))};
  return {...h,input,chunk,page,reference};
}
test('staged Binary admission reuses source bodies and orders chunk page final event with file and ancestor changes',async()=>{
  const h=await binaryStage();assert.equal(h.f.records.get('sync_graph_records')!.size,0,'stage sources have no graph admission yet');
  const baseline=h.f.requests.length,prepared=await h.engine.prepareBinary(h.input);
  assert.deepEqual(prepared.changes.map((change:any)=>change.after.id),['binary','parent']);
  await h.commit(prepared);
  const pending=await h.engine.api.pending(10);assert.deepEqual(pending.map(row=>row.metadata.key.update_id),['staged-chunk','staged-page','binary-final']);
  assert.equal(h.f.records.get('sync_graph_records')!.size,3);
  same(h.f.row('sync_source_payloads',keyOfId('staged-chunk')).bytes,h.chunk.payload);same(h.f.row('sync_source_payloads',keyOfId('staged-page')).bytes,h.page.payload);
  const bodyWrites=h.f.requests.slice(baseline).filter(r=>r.store==='sync_source_payloads'&&['add','put'].includes(r.operation));
  assert.deepEqual(bodyWrites.map(r=>r.key[2]),['binary-final'],'bounded stage sources must not be duplicated');
  assert.equal(h.f.records.get('content')!.size,0,'Binary publication contains a reference, never a full-file body');
  for(const row of h.f.row('control','test-publication').value.entries)assert.equal(row.revision,'binary-revision');
  for(const store of ['sync_authored','sync_envelopes']){
    const conflict=await binaryStage(),token=await conflict.engine.prepareBinary(conflict.input);
    conflict.f.seed(store,keyOfId('staged-chunk'),{key:keyOfId('staged-chunk'),metadata:conflict.chunk.metadata});
    await assert.rejects(conflict.commit(token),{code:'storage_corrupt'});token.dispose();
    assert.equal(conflict.f.records.get('sync_graph_records')!.size,0);assert.equal(conflict.f.row('sync_source_headers',keyOfId('binary-final')),undefined);
  }
});
test('bounded Binary read retains only private read handle after commit and rechecks each later payload',async()=>{
  const h=await binaryStage();await h.commit(await h.engine.prepareBinary(h.input));
  const captures=h.f.requests.filter(row=>row.store==='sync_graph_records'&&row.operation==='cursor').length;
  const prepared=await h.engine.prepareRead({entryId:'binary',expectedRevision:'binary-revision',expectedContentEvent:'binary-final'});
  assert.equal(prepared.length(),'3');assert.equal(prepared.chunkCount(),1);
  assert.equal(JSON.parse(prepared.chunkJson(0)).update_id,'staged-chunk');
  await h.commitRead(prepared);
  assert.equal(h.f.requests.filter(row=>row.store==='sync_graph_records'&&row.operation==='cursor').length,captures,'warm binary preparation and pin commit do not capture the vault again');
  assert.deepEqual(Object.keys(prepared).sort(),['chunkCount','chunkJson','dispose','length','reference','revision','verifyPayload']);
  const pin=h.f.row('binary_reads',['client','read']);assert.deepEqual(Object.keys(pin).sort(),['clientId','entryId','readId','reference','revision']);
  same(prepared.verifyPayload(0,h.f.row('sync_source_payloads',keyOfId('staged-chunk')).bytes),new Uint8Array([41,42,43]));
  h.f.seed('sync_source_payloads',keyOfId('staged-chunk'),{realmId:'realm',vaultId:'vault',updateId:'staged-chunk',bytes:new Uint8Array([0,0,0])});
  assert.throws(()=>prepared.verifyPayload(0,h.f.row('sync_source_payloads',keyOfId('staged-chunk')).bytes),{code:'sync_plan_rejected'});
  await assert.rejects(h.commitRead(prepared,'second'),{code:'invalid_prepared_binary_read'});
  assert.equal(h.f.row('binary_reads',['client','second']),undefined);prepared.dispose();
  const stale=await binaryStage();await stale.commit(await stale.engine.prepareBinary(stale.input));
  const token=await stale.engine.prepareRead({entryId:'binary',expectedRevision:'binary-revision'});
  const head=clone(stale.f.row('sync_state','metadata-head'));head.value.version='newer-graph';stale.f.seed('sync_state','metadata-head',head);
  await assert.rejects(stale.commitRead(token,'stale'),{code:'sync_snapshot_conflict'});
  assert.equal(stale.f.row('binary_reads',['client','stale']),undefined,'parent pin callback must not run after stale read CAS');
  assert.throws(()=>token.chunkCount(),{code:'binary_read_closed'});
});
test('missing retained Text state under accepted Text activity fails closed instead of recreating an empty state',async()=>{
  const h=await enrolled();await h.commit(await local(h));
  const text=(await h.engine.api.pending(10)).find(row=>row.metadata.family==='text')!;
  const sealed=await h.engine.api.seal(text.metadata.key.update_id,h.key);await h.engine.api.acknowledge(text.metadata.key.update_id,sealed);
  h.f.records.get('sync_text')!.clear();
  await assert.rejects(h.engine.validate(),{code:'storage_corrupt'});
  await assert.rejects(local(h),{code:'storage_corrupt'});
  assert.equal(h.f.records.get('sync_text')!.size,0);
  same(h.f.row('content','note').bytes,new TextEncoder().encode('text'));
  assert.equal(h.f.row('sync_authored',keyOfId(text.metadata.key.update_id)).pending,0);
});
test('graph source headers cannot replace missing authored or envelope metadata authority',async()=>{
  for(const ledger of ['sync_authored','sync_envelopes']){
    const h=await enrolled();await h.commit(await local(h));
    const file=(await h.engine.api.pending(10)).find(row=>row.metadata.family==='files')!,id=file.metadata.key.update_id;
    if(ledger==='sync_envelopes')await h.engine.api.seal(id,h.key);
    h.f.records.get(ledger)!.delete(JSON.stringify(keyOfId(id)));
    await assert.rejects(h.engine.validate(),{code:'storage_corrupt'});
    await assert.rejects(local(h),{code:'storage_corrupt'});
    assert.ok(h.f.row('sync_source_headers',keyOfId(id)));assert.ok(h.f.row('sync_source_payloads',keyOfId(id)));
    assert.equal(h.f.row(ledger,keyOfId(id)),undefined,'validation must not recreate authority metadata');
  }
});
test('historical Binary references require an explicit revision and its matching immutable publication',async()=>{
  const h=await binaryStage();await h.commit(await h.engine.prepareBinary(h.input));
  const prepared=await h.engine.prepareRead({entryId:'binary',expectedRevision:'binary-revision',reference:h.reference});prepared.dispose();
  await assert.rejects(h.engine.prepareRead({entryId:'binary',reference:h.reference}),{code:'binary_read_revision_conflict'});
  await assert.rejects(h.engine.prepareRead({entryId:'binary',expectedRevision:'missing-revision',reference:h.reference}),{code:'binary_read_revision_conflict'});
  await assert.rejects(h.engine.prepareRead({entryId:'binary',expectedRevision:'binary-revision',reference:{...h.reference,selected_event:'different-event'}}),{code:'binary_read_revision_conflict'});
});
test('startup validates intact Text and Binary derived publications but rejects missing current history or revision fences',async()=>{
  for(const kind of ['text','binary'])for(const missing of ['publication','revision']){
    const h=kind==='text'?await enrolled():await binaryStage();
    if('input' in h)await h.commit(await h.engine.prepareBinary(h.input));else await h.commit(await local(h));
    await h.engine.validate();
    const id=kind==='text'?'note':'binary',revision=kind==='text'?'note-revision':'binary-revision';
    if(missing==='publication')h.f.records.get('sync_publication_refs')!.delete(JSON.stringify([id,revision]));
    else h.f.records.get('sync_revisions')!.delete(JSON.stringify(revision));
    await assert.rejects(h.engine.validate(),{code:'storage_corrupt'});
    assert.equal(h.f.row('control','test-publication').value.entries.some((entry:any)=>entry.id===id),true,'failed validation preserves the existing publication');
  }
});
test('historical Binary publication changes after preparation abort before the parent read pin callback',async()=>{
  const h=await binaryStage();await h.commit(await h.engine.prepareBinary(h.input));
  const token=await h.engine.prepareRead({entryId:'binary',expectedRevision:'binary-revision',reference:h.reference});
  const previous=clone(h.f.row('sync_publication_refs',['binary','binary-revision']));
  previous.row.content.reference.selected_event='changed-after-prepare';
  h.f.seed('sync_publication_refs',['binary','binary-revision'],previous);
  await assert.rejects(h.commitRead(token,'changed-history'),{code:'binary_read_revision_conflict'});
  assert.equal(h.f.row('binary_reads',['client','changed-history']),undefined);
  assert.throws(()=>token.length(),{code:'binary_read_closed'});
});
test('hidden Binary retained metadata still requires its prior normal immutable publication baseline',async()=>{
  const h=await binaryStage();await h.commit(await h.engine.prepareBinary(h.input));
  // Supply a scripted opaque classification, without implementing namespace
  // conflict/dependency rules in this host-only fixture.
  const pending={identity:{entry_id:'binary'},outcome:{status:'pending',reason:{kind:'missing-dependency'}}};
  const parent={identity:{entry_id:'parent'},outcome:{status:'normal',path:'assets',kind:'folder',content:null}};
  const retained=clone(h.f.row('sync_materialization_refs','binary'));
  h.f.seed('sync_materialization_refs','binary',{...retained,status:'pending',fingerprint:JSON.stringify(pending),reason:pending.outcome});
  const current=clone(h.f.row('control','test-publication'));current.value.entries=current.value.entries.filter((entry:any)=>entry.id!=='binary');current.value.presentation=current.value.presentation.filter((row:any)=>row.id!=='binary');
  h.f.seed('control','test-publication',current);
  const head=clone(h.f.row('sync_state','metadata-head'));head.value.version='hidden-graph';h.f.seed('sync_state','metadata-head',head);
  h.f.seed('sync_revisions','hidden-graph',{revision:'hidden-graph'});h.scriptClassifications('hidden-graph',[pending,parent]);
  await h.engine.validate();
  h.f.records.get('sync_publication_refs')!.delete(JSON.stringify(['binary','binary-revision']));
  await assert.rejects(h.engine.validate(),{code:'storage_corrupt'});
  assert.deepEqual(h.f.row('sync_materialization_refs','binary').content,retained.content);
});
test('hidden Binary recovery uses the current opaque Rust reference rather than previous physical publication',async()=>{
  const h=await binaryStage();await h.commit(await h.engine.prepareBinary(h.input));
  const stored=clone(h.f.row('sync_materialization_refs','binary'));
  h.f.seed('sync_materialization_refs','binary',{...stored,status:'recovery',reason:{status:'recovery'}});
  const current=clone(h.f.row('control','test-publication'));current.value.entries=current.value.entries.filter((entry:any)=>entry.id!=='binary');current.value.presentation=current.value.presentation.filter((row:any)=>row.id!=='binary');h.f.seed('control','test-publication',current);
  const currentReference={...clone(h.reference),selected_event:'current-rust-event'};
  h.scriptRecovery('binary',{status:'complete',content:{kind:'binary',content:currentReference}});
  const recovered=await h.engine.api.readRetained('binary');
  assert.equal(recovered!.bytes,null);assert.deepEqual(recovered!.recovery_content,{kind:'binary_reference',reference:currentReference});
  assert.deepEqual(recovered!.witness,{kind:'binary',event_id:'current-rust-event'});
  assert.equal((recovered as any).content.reference.selected_event,'binary-final','previous physical witness remains distinct');
  assert.equal(h.recoveryCounts().recoveryByteReads,0);assert.equal(h.recoveryCounts().recoveryFrees,1);
});
test('pending Text recovery exposes no bytes despite the materializer having a nonempty partial view',async()=>{
  const h=await enrolled();await h.commit(await local(h));
  const stored=clone(h.f.row('sync_materialization_refs','note'));
  h.f.seed('sync_materialization_refs','note',{...stored,status:'pending',content:null,reason:{status:'pending'}});
  const current=clone(h.f.row('control','test-publication'));current.value.entries=[];current.value.presentation=[];h.f.seed('control','test-publication',current);
  h.scriptRecovery('note',{status:'pending'},new Uint8Array([112,97,114,116,105,97,108]));
  const before=h.recoveryCounts(),pending=await h.engine.api.readRetained('note');
  assert.equal(pending!.bytes,null);assert.equal(pending!.recovery_content,null);assert.equal(pending!.witness,null);
  assert.equal(h.recoveryCounts().materializationReads,before.materializationReads,'an incomplete materialized view is not recovery authority');
  assert.equal(h.recoveryCounts().recoveryByteReads,0,'pending recovery never requests partial text bytes');
  assert.equal(h.recoveryCounts().recoveryFrees,1);
  assert.ok(h.f.records.get('sync_text')!.size,'pending causal Text state stays retained');
});
test('complete Text recovery requires the opaque witness identity and retained revision',async()=>{
  const h=await enrolled();await h.commit(await local(h));
  const metadata=clone(h.f.row('sync_materialization_refs','note').content.metadata),bytes=new TextEncoder().encode('text');
  h.scriptRecovery('note',{status:'complete',content:{kind:'text',content:metadata}},bytes);
  const recovered=await h.engine.api.readRetained('note');same(recovered!.bytes!,bytes);
  assert.equal((recovered!.recovery_content as any).witness.revision,'note-revision');
  assert.equal(recovered!.witness!.kind,'text');assert.equal((recovered!.witness as any).state.identity.entry_id,'note');
  metadata.witness.revision='unretained-revision';h.scriptRecovery('note',{status:'complete',content:{kind:'text',content:metadata}},bytes);
  await assert.rejects(h.engine.api.readRetained('note'),{code:'invalid_wasm_result'});
  same(h.f.row('content','note').bytes,bytes);
});
test('unpublished hidden Binary recovery uses a distinct current-retained read witness and private commit mode',async()=>{
  const h=await binaryStage();await h.commit(await h.engine.prepareBinary(h.input));
  const retained=clone(h.f.row('sync_materialization_refs','binary'));
  h.f.seed('sync_materialization_refs','binary',{...retained,status:'recovery',reason:{status:'recovery'}});
  const publication=clone(h.f.row('control','test-publication'));publication.value.entries=publication.value.entries.filter((entry:any)=>entry.id!=='binary');publication.value.presentation=publication.value.presentation.filter((row:any)=>row.id!=='binary');h.f.seed('control','test-publication',publication);
  const currentReference={...clone(h.reference),selected_event:'unpublished-content-event'};
  h.scriptRecovery('binary',{status:'complete',content:{kind:'binary',content:currentReference}});
  await assert.rejects(h.engine.prepareRead({entryId:'binary',reference:currentReference,expectedRevision:'unpublished-revision'}),{code:'binary_read_revision_conflict'});
  const input={entryId:'binary',expectedContentEvent:'unpublished-content-event',reference:currentReference};
  const token=await h.engine.prepareRecoveryRead(input);
  assert.deepEqual(token.witness,{kind:'current_retained',metadata_revision:'binary-graph',entry_id:'binary',selected_content_event:'unpublished-content-event'});
  assert.equal(Object.hasOwn(token,'revision'),false);assert.equal(Object.hasOwn(token,'snapshot'),false);
  await assert.rejects(h.commitRead(token,'cross-mode'),{code:'invalid_prepared_binary_read'});
  assert.equal(h.f.row('binary_reads',['client','cross-mode']),undefined);
  await h.commitRecoveryRead(token);
  const pin=h.f.row('binary_reads',['client','recovery-read']);assert.deepEqual(pin.witness,token.witness);assert.deepEqual(pin.reference,currentReference);
  assert.equal(Object.hasOwn(pin,'revision'),false);assert.equal(Object.hasOwn(pin,'snapshot'),false);
  assert.equal(token.length(),'3');assert.equal(token.chunkCount(),1);assert.equal(JSON.parse(token.chunkJson(0)).update_id,'staged-chunk');
  same(token.verifyPayload(0,h.f.row('sync_source_payloads',keyOfId('staged-chunk')).bytes),new Uint8Array([41,42,43]));token.dispose();
  const stale=await h.engine.prepareRecoveryRead(input),head=clone(h.f.row('sync_state','metadata-head'));head.value.version='newer-recovery-graph';h.f.seed('sync_state','metadata-head',head);
  await assert.rejects(h.commitRecoveryRead(stale,'stale-recovery'),{code:'sync_snapshot_conflict'});
  assert.equal(h.f.row('binary_reads',['client','stale-recovery']),undefined);assert.throws(()=>stale.length(),{code:'binary_read_closed'});
});
const usageKey='binary-stream-usage:v1';
const usageOf=(h:any)=>clone(h.f.row('control',usageKey).value);
const setUsage=(h:any,patch:any)=>h.f.seed('control',usageKey,{key:usageKey,value:{...usageOf(h),...patch}});
test('received exact payloads charge shared bytes and chunk page counts once across exact replay',async()=>{
  const h=await receiving(),chunk=emission('quota-chunk'),wire=h.wire(chunk);
  await h.engine.api.receive('quota-chunk',wire,h.key,delivery);
  assert.deepEqual(usageOf(h),{version:1,stages:0,activeStages:0,sourcePayloadBytes:'3',chunkRecords:1,pageRecords:0});
  const replay=await h.engine.api.receive('quota-chunk',wire,h.key);assert.equal(replay.duplicate,true);
  assert.equal(usageOf(h).sourcePayloadBytes,'3');assert.equal(usageOf(h).chunkRecords,1);
  const page=emission('quota-page',new Uint8Array([4,5,6,7]));page.record!.body={kind:'page',page:{chunks:[{id:'quota-chunk',bytes:3,digest}]}} as any;
  await h.engine.api.receive('quota-page',h.wire(page),h.key);
  assert.equal(usageOf(h).sourcePayloadBytes,'7');assert.equal(usageOf(h).pageRecords,1);
  const stage=await binaryStage(),before=usageOf(stage);assert.equal(before.sourcePayloadBytes,'5');
  await stage.commit(await stage.engine.prepareBinary(stage.input));
  const promoted=usageOf(stage);assert.equal(promoted.sourcePayloadBytes,'7');assert.equal(promoted.chunkRecords,before.chunkRecords);assert.equal(promoted.pageRecords,before.pageRecords);
});
test('receive quota and missing usage fail closed while aborted commits roll back accounting and insertion',async()=>{
  for(const mode of ['bytes','chunks','pages','missing','abort']){
    const h=await receiving(),e=emission('quota-rejected');
    if(mode==='bytes')setUsage(h,{sourcePayloadBytes:'536870910'});
    if(mode==='chunks')setUsage(h,{chunkRecords:4096});
    if(mode==='pages'){setUsage(h,{pageRecords:256});e.record!.body={kind:'page',page:{chunks:[]}} as any;}
    const before=usageOf(h);if(mode==='missing')h.f.records.get('control')!.delete(JSON.stringify(usageKey));
    if(mode==='abort')h.f.failNextCommit();
    await assert.rejects(h.engine.api.receive('quota-rejected',h.wire(e),h.key,delivery),{code:mode==='missing'?'binary_usage_unavailable':mode==='abort'?'storage_failure':'binary_quota_exceeded'});
    assert.equal(h.f.row('sync_source_headers',keyOfId('quota-rejected')),undefined);assert.equal(h.f.row('sync_source_payloads',keyOfId('quota-rejected')),undefined);
    assert.equal(h.f.row('control','test-publication'),undefined);assert.deepEqual(h.f.row('sync_cursors',['realm','vault']).value,startCursor);
    if(mode==='missing')assert.equal(h.f.row('control',usageKey),undefined);else assert.deepEqual(usageOf(h),before);
  }
  // First local emission fits, the second exceeds capacity: the first immutable
  // insert and the quota row must still roll back in the same transaction.
  const h=await enrolled();setUsage(h,{sourcePayloadBytes:'536870910'});const before=usageOf(h);
  await assert.rejects(h.commit(await local(h)),{code:'binary_quota_exceeded'});
  assert.ok(h.f.requests.some(r=>r.store==='sync_source_payloads'&&r.operation==='add'));
  assert.equal(h.f.records.get('sync_source_payloads')!.size,0);assert.equal(h.f.records.get('sync_authored')!.size,0);assert.deepEqual(usageOf(h),before);
});
test('actual stage admission sees received shared usage and cannot exceed its injected source-byte budget',async()=>{
  const h=await receiving();await h.engine.api.receive('received-before-stage',h.wire(emission('received-before-stage')),h.key,delivery);
  class Builder {
    length=0;
    statusJson(){return JSON.stringify({accepted_length:String(this.length),pending_chunks:this.length?1:0});}
    pushChunk(id:string,bytes:Uint8Array){this.length+=bytes.length;const e=emission(id,bytes);return {descriptorJson(){return JSON.stringify({scope,update_id:id,record:e.record,summary_digest:summary});},payloadBytes(){return bytes.slice();},chunkBytes(){return bytes.slice();},free(){}};}
    restoreChunkPayload(){throw new Error('unused empty-stage restore');}restorePagePayload(){throw new Error('unused empty-stage restore');}
    flushPage(){throw new Error('no page needed');}finish(){throw new Error('quota failure precedes seal');}free(){}
  }
  class Batch {pushRecord(){return '{}';}pushPayload(){throw new Error('quota rejection must precede source insertion validation');}free(){}}
  let allocation=0;
  const receivedCost=3,stagePayloadCost=4,sharedBudget=receivedCost+stagePayloadCost-1;
  assert.ok(stagePayloadCost<=sharedBudget,'this same stage payload fits before receive consumes the shared budget');
  const stages=createBrowserBinaryStageStore({db:h.f.db,authorityId:authority,scope:{realmId:'realm',vaultId:'vault'},clientId:'client',assertActive(){},allocateId:()=>`quota-stage-${++allocation}`,
    limits:{maxFileBytes:'67108864',maxChunkBytes:131072,maxPayloadBytes:1048576,maxStages:4096,maxActiveStages:8,maxSourceBytes:String(sharedBudget),maxChunkRecords:4096,maxPageRecords:256},wasm:{WasmBinaryBuilder:Builder,WasmAuthoredMetadataBatch:Batch} as any});
  try{
    const ref=await stages.begin({operationId:'received-then-stage',target:{kind:'create',entryId:'staged',path:'staged.bin'},expectedLength:'4'}),before=usageOf(h);
    await assert.rejects(stages.append(ref,{sequence:0,offset:'0',bytes:new Uint8Array([4,5,6,7])}),{code:'binary_quota_exceeded'});
    assert.deepEqual(usageOf(h),before);assert.equal(before.sourcePayloadBytes,'3');
    assert.equal(h.f.records.get('sync_source_payloads')!.size,1);assert.equal(h.f.records.get('binary_stage_chunks')!.size,0);assert.equal((await stages.query(ref)).acceptedLength,'0');
  }finally{stages.dispose();}
});
test('Binary preparation transfers owned handles to Rust exactly once on success invocation failure and later proof failure',async()=>{
  for(const mode of ['success','invoke','proof']){
    const h=await binaryStage();if(mode==='invoke')h.failBinaryInvoke();if(mode==='proof')h.rejectProof();
    if(mode==='success')(await h.engine.prepareBinary(h.input)).dispose();
    else await assert.rejects(h.engine.prepareBinary(h.input),{code:'sync_plan_rejected'});
    for(const handle of [h.input.batch,h.input.built])assert.deepEqual(handle.counts,{consumed:1,freed:0},'engine must not free moved-by-value handles');
  }
});
test('Binary preparation early guard copy snapshot and scope errors attempt both frees once without masking',async()=>{
  for(const mode of ['guard','copy','snapshot','scope']){
    const h=await binaryStage();h.input.batch.freeThrows=true;
    if(mode==='guard')h.retire();if(mode==='copy')(h.input.target as any).uncloneable=()=>{};
    if(mode==='snapshot')h.f.records.get('sync_state')!.delete(JSON.stringify('config'));
    if(mode==='scope')h.input.sourceKeys[0].realmId='different';
    await assert.rejects(h.engine.prepareBinary(h.input),mode==='copy'?{name:'DataCloneError'}:{code:mode==='guard'?'owner_retired':mode==='snapshot'?'storage_corrupt':'binary_stage_source_mismatch'});
    for(const handle of [h.input.batch,h.input.built])assert.deepEqual(handle.counts,{consumed:0,freed:1},'both cleanup attempts preserve the original failure');
  }
});

const managedCollection={realmId:'realm',vaultId:'vault',owner:'app:tasks',collection:'tasks'};
const managedRegistration=new TextEncoder().encode(JSON.stringify({realm:'realm',vault:'vault',owner:'app:tasks',schema:{collection:'tasks',version:1,policy:'synced',fields:{}}}));
const managedEmission=(id:string)=>{const e=emission(id);return {...e,metadata:{...e.metadata,family:'records',format_version:1},record:null,activity:null};};

test('records facade excludes raw authenticated receive/plan/commit/key mutation hooks',()=>{
  const h=harness(true),api=h.engine.managedRecords!;
  assert.deepEqual(Object.keys(api).sort(),['apply','applyWorkBlock','changes','exportOne','register','retryPage','snapshot','watermark']);
  for(const name of ['receive','prepareReceive','commitReceive','bindSyncKey'])assert.equal((api as any)[name],undefined);
});

test('records receive and file text share one cursor without adding graph counts or file journal changes',async()=>{
  const h=harness(true);await h.engine.api.enroll({...scope,key_epoch:1});
  const cursor={...scope,server_epoch:'epoch',after:'0'};await h.engine.api.setCursor(cursor,null);
  const record=managedEmission('record_1'),wire=h.wire(record);
  const result=await h.engine.api.receive('record_1',wire,h.key,{expected:cursor,next:{...cursor,after:'1'}});
  assert.equal(result.duplicate,false);assert.equal(h.f.row('sync_cursors',['realm','vault']).value.after,'1');
  assert.equal(h.f.row('sync_state','metadata-head').value.record_count,0);assert.equal(h.f.row('sync_state','metadata-head').value.activity_count,0);
  assert.equal(h.f.records.get('journal')!.size,0);assert.equal(h.f.records.get('managed_receipts')!.size,1);
  const next={...cursor,after:'2'};const duplicate=await h.engine.api.receive('record_1',wire,h.key,{expected:{...cursor,after:'1'},next});
  assert.equal(duplicate.duplicate,true);assert.equal(h.f.records.get('managed_changes')!.size,1);assert.equal(h.f.row('sync_cursors',['realm','vault']).value.after,'2');
});

test('shared mixed-family envelope cap also fences seal and leaves immutable wire absent',async()=>{
  const h=harness();await h.engine.api.enroll({...scope,key_epoch:1});
  const authored=emission('to_seal');h.seed(authored);
  for(let i=0;i<4096;i++){const metadata=managedEmission(`received_${i}`).metadata;h.f.seed('sync_envelopes',keyOfId(metadata.key.update_id),{key:keyOfId(metadata.key.update_id),metadata,direction:'received'});}
  const before=clone(h.f.records);await assert.rejects(h.engine.api.seal('to_seal',h.key),{code:'storage_metadata_too_large'});
  assert.deepEqual(h.f.records,before);assert.equal(h.f.row('sync_authored',keyOfId('to_seal')).sealed,false);assert.equal(h.f.row('sync_source_wires',keyOfId('to_seal')),undefined);
});

test('original managed adapter reuses bindSession authenticated key and aborts retry on guard loss after open',async()=>{
  const h=harness(true);await h.engine.api.enroll({...scope,key_epoch:1});
  const token=await h.engine.managedRecords!.register(managedCollection,managedRegistration);
  let live=true;const session=h.engine.api.bindSession(()=>{if(!live)throw Object.assign(new Error('revoked'),{code:'sync_revoked'});});
  const record=managedEmission('waiting_record');await session.receive('waiting_record',h.wire(record),h.key);
  h.setRecordStatus('accepted');const before=clone(h.f.records),gate=h.f.holdPayloadRead('readwrite');
  const pending=h.engine.managedRecords!.retryPage(token);await gate.ready;live=false;gate.release();
  await assert.rejects(pending,{code:'sync_revoked'});assert.deepEqual(h.f.records,before);
  const replacement=h.engine.api.bindSession(()=>{});await replacement.receive('waiting_record',h.wire(record),h.key);
  const retried=await h.engine.managedRecords!.retryPage(token);assert.equal(retried.examined,1);assert.equal(retried.changed,true);
});

test('same-object same-key provider token rotation after AEAD open rejects retry CAS and continuation',async()=>{
  const h=harness(true);await h.engine.api.enroll({...scope,key_epoch:1});
  const token=await h.engine.managedRecords!.register(managedCollection,managedRegistration);
  const record=managedEmission('waiting_record');await h.engine.api.receive('waiting_record',h.wire(record),h.key);
  const provider={key:h.key,sessionToken:{},assertActive(){}};h.setRecordProvider(provider);h.setRecordStatus('accepted');
  const before=clone(h.f.records),gate=h.f.holdPayloadRead('readwrite');
  const pending=h.engine.managedRecords!.retryPage(token);await gate.ready;provider.sessionToken={};gate.release();
  await assert.rejects(pending,{code:'sync_session_revoked'});assert.deepEqual(h.f.records,before);
  const retried=await h.engine.managedRecords!.retryPage(token);assert.equal(retried.changed,true);assert.equal(retried.examined,1);
});

test('configured absent session provider fails despite a cached bindSession authenticated key',async()=>{
  const h=harness(true);await h.engine.api.enroll({...scope,key_epoch:1});const token=await h.engine.managedRecords!.register(managedCollection,managedRegistration);
  const session=h.engine.api.bindSession(()=>{}),record=managedEmission('waiting_record');await session.receive('waiting_record',h.wire(record),h.key);
  h.setRecordProvider(undefined);const before=clone(h.f.records);await assert.rejects(h.engine.managedRecords!.retryPage(token),{code:'records_retry_key_unavailable'});assert.deepEqual(h.f.records,before);
});

test('startup rejects orphan records receipt after common received ledger removal',async()=>{
  const h=harness(true);await h.engine.api.enroll({...scope,key_epoch:1});await h.engine.managedRecords!.register(managedCollection,managedRegistration);
  const record=managedEmission('waiting_record');await h.engine.api.receive('waiting_record',h.wire(record),h.key);await h.engine.validate();
  h.f.records.get('sync_envelopes')!.delete(JSON.stringify(keyOfId('waiting_record')));
  await assert.rejects(h.engine.validate(),{code:'storage_corrupt'});
});

test('new records receive respects mixed common envelope capacity and cannot brick the existing snapshot',async()=>{
  const h=harness(true);await h.engine.api.enroll({...scope,key_epoch:1});await h.engine.managedRecords!.register(managedCollection,managedRegistration);
  for(let i=0;i<4096;i++){
    const file=emission(`file_${i}`);h.seed(file);
    const row=h.f.row('sync_authored',keyOfId(file.metadata.key.update_id));h.f.seed('sync_authored',row.key,{...row,sealed:true});
    h.f.seed('sync_envelopes',row.key,{key:row.key,metadata:file.metadata,direction:'authored'});
    h.f.seed('sync_source_wires',row.key,{realmId:'realm',vaultId:'vault',updateId:file.metadata.key.update_id,bytes:new Uint8Array([1])});
  }
  const cursor={...scope,server_epoch:'epoch',after:'0'};await h.engine.api.setCursor(cursor,null);
  const before=clone(h.f.records),record=managedEmission('one_more_record');
  await assert.rejects(h.engine.api.receive('one_more_record',h.wire(record),h.key,{expected:cursor,next:{...cursor,after:'1'}}),{code:'storage_metadata_too_large'});
  assert.deepEqual(h.f.records,before);assert.equal(h.f.records.get('managed_receipts')!.size,0);assert.equal(h.f.row('sync_source_payloads',keyOfId('one_more_record')),undefined);
  // The prior integrated snapshot remains usable after rejected insertion.
  await h.engine.validate();
});

test('records exact AEAD-open capability pins enrolled epoch through the final common transaction',async()=>{
  const h=harness(true);await h.engine.api.enroll({...scope,key_epoch:1});await h.engine.managedRecords!.register(managedCollection,managedRegistration);
  const record=managedEmission('record_epoch_race'),wire=h.wire(record);
  const wrapped={...h.key,openSyncUpdate(context:string,bytes:Uint8Array){
    const opened=h.key.openSyncUpdate(context,bytes),config=h.f.row('sync_state','config');
    h.f.seed('sync_state','config',{...config,value:{...config.value,key_epoch:2}});return opened;
  }};
  const original=clone(h.f.records);
  await assert.rejects(h.engine.api.receive('record_epoch_race',wire,wrapped),{code:'sync_snapshot_conflict'});
  original.get('sync_state')!.set(JSON.stringify('config'),h.f.row('sync_state','config'));
  assert.deepEqual(h.f.records,original);assert.equal(h.f.records.get('managed_receipts')!.size,0);
});

test('pending outbox can return one maximum-sized accepted wire',async()=>{
  const h=await enrolled();await h.commit(await local(h));
  const meta=(await h.engine.api.pending(10))[0].metadata,id=meta.key.update_id;
  const wire=new Uint8Array(normalizedLimits.wire);
  h.f.seed('sync_source_wires',keyOfId(id),{realmId:'realm',vaultId:'vault',updateId:id,bytes:wire});
  h.f.seed('sync_authored',keyOfId(id),{...h.f.row('sync_authored',keyOfId(id)),sealed:true});
  const pending=await h.engine.api.pending(1);
  assert.equal(pending.length,1);assert.equal(pending[0].sealed!.byteLength,normalizedLimits.wire);
});
