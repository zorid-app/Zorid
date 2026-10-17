import type { Checkpoint, CheckpointChange, CheckpointMetadata, CheckpointPage, DurableCheckpoints, CheckpointListOptions, CheckpointChangesOptions } from './durable-checkpoints.ts';
import { BrowserVaultError } from './browser-vault.ts';
import { boundedUtf8, checkpointError as fail, checkpointKey, checkpointRevision, checkpointStateLimit, snapshotCheckpointChange } from './checkpoint-input.ts';

type Head = Checkpoint & {previousRevision:string|null};
type Revision = CheckpointMetadata & {order:string;creationOrder?:string};
type Cursor = {version:1;vaultId:string;clientId:string;kind:'list'|'changes';highWater:string;after:string;position:string|null};
const maximum=(1n<<64n)-1n;
const sequence=(value:unknown):bigint=>{
  if(typeof value!=='string' || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value)>maximum) throw fail('storage_corrupt','Invalid checkpoint sequence');
  return BigInt(value);
};
const order=(value:string)=>value.padStart(20,'0');
const storage=(error:unknown):BrowserVaultError=>error instanceof BrowserVaultError?error:fail(error instanceof Error && error.name==='QuotaExceededError'?'storage_quota_exceeded':'storage_failure',error instanceof Error?error.message:String(error));

/** Same DB authority, independent local recovery records; no domain journal/outbox. */
export function browserCheckpoints(db:IDBDatabase,vaultId:string,clientId:string):DurableCheckpoints {
  if(typeof clientId!=='string' || !clientId || boundedUtf8(clientId,256)===0 || clientId.includes('\0')) throw fail('invalid_checkpoint','Invalid checkpoint client scope');
  const scope=Object.freeze({vaultId,clientId});
  function metadata(row:any):CheckpointMetadata {
    try {
      if(!row || row.version!==1 || row.vaultId!==vaultId || row.clientId!==clientId || typeof row.deleted!=='boolean' || !Number.isSafeInteger(row.byteLength) || row.byteLength<0 || row.byteLength>checkpointStateLimit || (row.deleted && row.byteLength!==0)) throw new Error('invalid metadata');
      checkpointKey(row.key); checkpointRevision(row.revision);
      if(sequence(row.sequence)===0n) throw new Error('zero sequence');
      return Object.freeze({version:1,vaultId,clientId,key:row.key,revision:row.revision,sequence:row.sequence,deleted:row.deleted,byteLength:row.byteLength});
    } catch { throw fail('storage_corrupt','Invalid checkpoint metadata'); }
  }
  function head(row:any):Head {
    const meta=metadata(row);
    try {
      if(row.previousRevision!==null) checkpointRevision(row.previousRevision);
      if(row.encodedState===null ? !meta.deleted : meta.deleted || boundedUtf8(row.encodedState,checkpointStateLimit)!==meta.byteLength) throw new Error('body mismatch');
    } catch { throw fail('storage_corrupt','Invalid current checkpoint body'); }
    return {...meta,encodedState:row.encodedState,previousRevision:row.previousRevision};
  }
  function publicHead(row:Head):Checkpoint { const {previousRevision,...value}=row; return Object.freeze(value); }
  function revision(row:any):CheckpointMetadata {
    const meta=metadata(row);
    if(row.order!==order(meta.sequence) || (row.creationOrder!==undefined && row.creationOrder!==row.order)) throw fail('storage_corrupt','Invalid checkpoint revision ordering');
    return meta;
  }
  function transaction<T>(mode:IDBTransactionMode,start:(tx:IDBTransaction,highWater:string,done:(value:T)=>void,on:<V>(request:IDBRequest<V>,callback:(value:V)=>void)=>void)=>void):Promise<T> {
    return new Promise((resolve,reject)=>{
      let tx:IDBTransaction;
      try { tx=db.transaction(['control','checkpoint_heads','checkpoint_revisions'],mode,mode==='readwrite'?{durability:'strict'}:undefined); }
      catch(error){reject(storage(error));return;}
      let value:T,complete=false,failure:BrowserVaultError|undefined;
      const abort=(error:unknown)=>{failure??=storage(error);try{tx.abort();}catch{}};
      const on=<V>(request:IDBRequest<V>,callback:(value:V)=>void)=>{request.onsuccess=()=>{try{callback(request.result);}catch(error){abort(error);}};};
      tx.onabort=()=>reject(failure??storage(tx.error??new Error('Checkpoint transaction aborted')));
      tx.onerror=()=>{};
      tx.oncomplete=()=>complete?resolve(value):reject(fail('storage_protocol_error','Checkpoint transaction has no result'));
      if(mode==='readwrite' && tx.durability!=='strict'){abort(fail('strict_durability_unavailable','Browser did not honor strict checkpoint durability'));return;}
      const authority=tx.objectStore('control').get('local-store-id'), counter=tx.objectStore('control').get('checkpoint-sequence');
      const count=tx.objectStore('checkpoint_revisions').count(),latest=tx.objectStore('checkpoint_revisions').index('by_global_sequence').openCursor(null,'prev');
      let remaining=4;
      const loaded=()=>{
        if(--remaining)return;
        if(authority.result?.value!==vaultId) throw fail('intent_identity_mismatch','Checkpoint store authority changed');
        const highWater=counter.result?.value,number=sequence(highWater);
        if(!Number.isSafeInteger(count.result) || BigInt(count.result)!==number || (number===0n?latest.result!==null:latest.result?.value.sequence!==highWater || latest.result?.value.order!==order(highWater)))throw fail('storage_corrupt','Checkpoint revision fences are missing or inconsistent');
        start(tx,highWater,result=>{value=result;complete=true;},on);
      };
      on(authority,loaded);on(counter,loaded);on(count,loaded);on(latest,loaded);
    });
  }
  function options(input:CheckpointListOptions,kind:'list'|'changes',after='0'):{limit:number;cursor?:Cursor} {
    if(!input || !Number.isInteger(input.limit) || input.limit<1 || input.limit>1000) throw fail('invalid_checkpoint','Page limit must be 1–1000');
    if(kind==='changes')try{sequence(after);}catch{throw fail('invalid_checkpoint','Invalid checkpoint change boundary');}
    if(input.cursor===undefined)return {limit:input.limit};
    boundedUtf8(input.cursor,8192,'invalid_checkpoint_cursor');
    let cursor:Cursor;
    try{cursor=JSON.parse(input.cursor);}catch{throw fail('invalid_checkpoint_cursor','Invalid checkpoint cursor');}
    if(!cursor || cursor.version!==1 || cursor.vaultId!==vaultId || cursor.clientId!==clientId || cursor.kind!==kind || cursor.after!==after || typeof cursor.position!=='string') throw fail('invalid_checkpoint_cursor','Cursor does not match this authority/client/pass');
    try {
      sequence(cursor.highWater);
      if(sequence(cursor.position)<sequence(after) || sequence(cursor.position)>sequence(cursor.highWater))throw new Error('Invalid page position');
    }catch{throw fail('invalid_checkpoint_cursor','Invalid checkpoint cursor sequence');}
    return {limit:input.limit,cursor};
  }
  function page(kind:'list'|'changes',input:CheckpointListOptions,after='0'):Promise<CheckpointPage> {
    const request=options(input,kind,after);
    return transaction('readonly',(tx,current,done,on)=>{
      const highWater=request.cursor?.highWater??current;
      if(sequence(highWater)>sequence(current) || sequence(after)>sequence(highWater)) throw fail('checkpoint_conflict','Checkpoint high-water boundary is unavailable');
      const items:CheckpointMetadata[]=[];
      let scanned=0;
      const finish=(position:string|null)=>done(Object.freeze({items:Object.freeze(items),highWater,cursor:position===null?null:JSON.stringify({version:1,vaultId,clientId,kind,highWater,after,position} satisfies Cursor)}));
      if(kind==='changes') {
        const lower=request.cursor?.position??after;
        if(sequence(lower)===sequence(highWater)){finish(null);return;}
        const read=tx.objectStore('checkpoint_revisions').index('by_sequence').openCursor(IDBKeyRange.bound([clientId,order(lower)],[clientId,order(highWater)],true,false));
        on(read,cursor=>{
          if(!cursor){finish(null);return;}
          const meta=revision(cursor.value);items.push(meta);
          if(++scanned===request.limit)finish(meta.sequence);else cursor.continue();
        });
      } else {
        const last=request.cursor?.position??'0';
        if(sequence(last)===sequence(highWater)){finish(null);return;}
        // Immutable first-created records bound membership as well as metadata
        // to highWater. New keys cannot extend this recovery pass indefinitely.
        const read=tx.objectStore('checkpoint_revisions').index('by_creation').openCursor(IDBKeyRange.bound([clientId,order(last)],[clientId,order(highWater)],true,false));
        on(read,cursor=>{
          if(!cursor){finish(null);return;}
          const first=revision(cursor.value),key=first.key;
          if(cursor.value.creationOrder!==order(first.sequence))throw fail('storage_corrupt','Invalid checkpoint creation membership');
          // Both indexes contain metadata only, never historical draft bodies.
          const historical=tx.objectStore('checkpoint_revisions').index('by_key').openCursor(IDBKeyRange.bound([clientId,key,order('0')],[clientId,key,order(highWater)]),'prev');
          on(historical,record=>{
            if(record)items.push(revision(record.value));
            if(++scanned===request.limit)finish(first.sequence);else cursor.continue();
          });
        });
      }
    });
  }
  return Object.freeze({scope,
    load(key:string):Promise<Checkpoint|null> {
      checkpointKey(key);
      return transaction('readonly',(tx,highWater,done,on)=>on(tx.objectStore('checkpoint_heads').get([clientId,key]),row=>{
        if(row===undefined){
          on(tx.objectStore('checkpoint_revisions').index('by_key').openKeyCursor(IDBKeyRange.bound([clientId,key],[clientId,key,[]])),prior=>{
            if(prior)throw fail('storage_corrupt','Checkpoint head is missing but revision fences remain');done(null);
          });return;
        }
        const current=head(row);
        if(sequence(current.sequence)>sequence(highWater))throw fail('storage_corrupt','Checkpoint head exceeds sequence');
        on(tx.objectStore('checkpoint_revisions').get([clientId,current.revision]),fence=>{
          if(!fence || JSON.stringify(revision(fence))!==JSON.stringify(metadata(current)))throw fail('storage_corrupt','Checkpoint head lost its revision fence');
          done(publicHead(current));
        });
      }));
    },
    compareAndSwap(input:CheckpointChange):Promise<Checkpoint> {
      const {change,byteLength}=snapshotCheckpointChange(input);
      return transaction('readwrite',(tx,highWater,done,on)=>{
        const heads=tx.objectStore('checkpoint_heads'), revisions=tx.objectStore('checkpoint_revisions');
        const lookup=heads.get([clientId,change.key]),used=revisions.get([clientId,change.nextRevision]);
        let remaining=2;
        const apply=()=>{
          if(--remaining)return;
          const current=lookup.result===undefined?undefined:head(lookup.result);
          if(current && sequence(current.sequence)>sequence(highWater))throw fail('storage_corrupt','Checkpoint head exceeds sequence');
          if(used.result!==undefined) {
            const prior=revision(used.result);
            if(prior.key!==change.key)throw fail('checkpoint_revision_reused','Revision belongs to another checkpoint key');
            if(current?.revision===change.nextRevision) {
              if(JSON.stringify(prior)!==JSON.stringify(metadata(current)))throw fail('storage_corrupt','Current checkpoint disagrees with its revision fence');
              if(current.previousRevision===change.expectedRevision && current.encodedState===change.encodedState){done(publicHead(current));return;}
              throw fail('checkpoint_revision_reused','Revision was already used with different request bytes');
            }
            throw fail('checkpoint_conflict','Retried checkpoint revision is no longer current');
          }
          if((current?.revision??null)!==change.expectedRevision)throw fail('checkpoint_conflict','Checkpoint head changed');
          if(current?.revision===change.nextRevision)throw fail('storage_corrupt','Current checkpoint revision lost its fence');
          const prior=sequence(highWater);if(prior===maximum)throw fail('sequence_exhausted','Checkpoint sequence exhausted');
          const next=String(prior+1n);
          const meta:CheckpointMetadata={version:1,vaultId,clientId,key:change.key,revision:change.nextRevision,sequence:next,deleted:change.encodedState===null,byteLength};
          const written:Head={...meta,encodedState:change.encodedState,previousRevision:change.expectedRevision};
          const persist=()=>{
            heads.put(written);revisions.add({...meta,order:order(next),...(current?{}:{creationOrder:order(next)})} satisfies Revision);
            tx.objectStore('control').put({key:'checkpoint-sequence',value:next});done(publicHead(written));
          };
          if(current)on(revisions.get([clientId,current.revision]),fence=>{
            if(!fence || JSON.stringify(revision(fence))!==JSON.stringify(metadata(current)))throw fail('storage_corrupt','Checkpoint head lost its revision fence');
            persist();
          });else on(revisions.index('by_key').openKeyCursor(IDBKeyRange.bound([clientId,change.key],[clientId,change.key,[]])),prior=>{
            if(prior)throw fail('storage_corrupt','Cannot recreate a checkpoint with retained revision fences');persist();
          });
        };
        on(lookup,apply);on(used,apply);
      });
    },
    list(input:CheckpointListOptions){return page('list',input);},
    changes(input:CheckpointChangesOptions){return page('changes',input,input.after);},
  });
}
