/** Authorized TEST-ONLY normal Worker prepend. Native IDB and postMessage calls
 * still execute; no consumer, state, schema, WASM binding or receipt is supplied.
 * Deliberate faults: hold native request callback / hold after final writes,
 * drop one exact normal reply, suppress native BroadcastChannel hints. */
export function installWorkBlockObserver(channelName){
  const control=new BroadcastChannel(channelName),workerId=crypto.randomUUID();
  const transactions=[],requests=new Map(),witnessByTx=new WeakMap();
  let database,clientId,ordinal=0,txOrdinal=0,arm,held,dropOperation,dropId,suppressHints=false;
  const rawBroadcast=BroadcastChannel.prototype.postMessage;
  const emit=value=>rawBroadcast.call(control,{workerId,database,clientId,ordinal:++ordinal,...value});
  const nativeGet=IDBObjectStore.prototype.get;
  function hold(tx,witness,point,continuation){
    if(held)throw new Error('Proof attempted overlapping transaction holds');
    let release=false,finished=false;
    const finish=()=>{if(finished)return;finished=true;clearTimeout(timer);held=undefined;};
    const timer=setTimeout(()=>{release=true;emit({event:'hold-deadline',transaction:witness.id});},10000);
    held={transaction:witness.id,release(){release=true;}};
    for(const outcome of ['abort','complete'])tx.addEventListener(outcome,finish,{once:true});
    const pump=()=>{
      if(finished)return;
      try{
        const r=nativeGet.call(tx.objectStore('control'),'__owned_workblock_proof_hold__');
        r.onsuccess=()=>{
          if(release){finish();emit({event:'hold-released',transaction:witness.id});continuation?.();}
          else pump();
        };
        r.onerror=finish;
      }catch(error){finish();emit({event:'observer-error',message:String(error)});}
    };
    pump();emit({event:'held-transaction',transaction:witness.id,point,operation:witness.operation,stores:witness.stores});
  }
  control.onmessage=({data})=>{
    if(data?.database!==database||data.clientId!==clientId)return;
    if(data.action==='arm-hold'){
      if(arm||held){emit({event:'observer-error',message:'Overlapping arm/hold'});return;}
      arm={operation:data.operation,point:data.point,store:data.store??'managed_local_operations',key:data.key};
    }
    if(data.action==='release-hold')held?.release();
    if(data.action==='drop-operation-reply')dropOperation=data.operation;
    if(data.action==='suppress-hints')suppressHints=data.enabled===true;
    if(data.action==='inspect')emit({event:'transactions',transactions:structuredClone(transactions)});
    emit({event:'control-ack',request:data.request,action:data.action});
  };
  self.addEventListener('message',({data})=>{
    if(data?.operation==='open'){database=data.payload?.database;clientId=data.payload?.clientId;}
    if(!data?.id)return;
    const operation=data.payload?.command?.operation;
    requests.set(data.id,{rpc:data.operation,operation});
    if(dropOperation!==undefined&&data.operation==='workblock-command'&&operation===dropOperation)dropId=data.id;
    emit({event:'rpc-in',id:data.id,rpc:data.operation,operation});
  });
  const post=self.postMessage.bind(self);
  self.postMessage=(data,...rest)=>{
    const request=requests.get(data?.id);
    if(data?.event)emit({event:'product-event',kind:data.event});
    if(request){emit({event:'rpc-reply',id:data.id,...request,ok:data.ok,error:data.error,held:!!held});requests.delete(data.id);}
    if(dropId!==undefined&&data?.id===dropId){dropId=undefined;dropOperation=undefined;emit({event:'dropped-reply',...request,ok:data.ok});return;}
    return post(data,...rest);
  };
  BroadcastChannel.prototype.postMessage=function(...args){
    if(suppressHints&&this.name.startsWith('zorid-core:')){emit({event:'dropped-hint',name:this.name});return;}
    return rawBroadcast.apply(this,args);
  };
  const transaction=IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction=function(...args){
    const tx=transaction.apply(this,args);
    const witness={id:++txOrdinal,database:this.name,mode:tx.mode,stores:[...tx.objectStoreNames],requested:args[2]?.durability??'default',actual:tx.durability,outcome:'pending',reads:[],writes:[]};
    if(transactions.length<4096)transactions.push(witness);else emit({event:'observer-error',message:'Transaction witness capacity exceeded'});witnessByTx.set(tx,witness);
    emit({event:'transaction-start',id:witness.id,mode:tx.mode,requested:witness.requested,actual:witness.actual});
    for(const outcome of ['complete','abort'])tx.addEventListener(outcome,()=>{witness.outcome=outcome;emit({event:'transaction',witness:structuredClone(witness)});},{once:true});
    return tx;
  };
  // Observe exact native read calls, including index cursors. Keepalive requests
  // deliberately use the captured native get and do not appear as product reads.
  for(const prototype of [IDBObjectStore.prototype,IDBIndex.prototype])for(const method of ['get','getKey','getAll','getAllKeys','count','openCursor','openKeyCursor']){
    if(typeof prototype[method]!=='function')continue;
    const native=prototype[method];prototype[method]=function(...args){
      const store=this instanceof IDBObjectStore?this:this.objectStore,tx=store.transaction,witness=witnessByTx.get(tx);
      if(witness){
        if(witness.reads.length>=2048)emit({event:'observer-error',message:'Read witness capacity exceeded'});
        const value=args[0];
        const key=method==='get'||method==='getKey'?(value instanceof IDBKeyRange?{lower:value.lower,upper:value.upper}:structuredClone(value)):undefined;
        if(witness.reads.length<2048)witness.reads.push({store:store.name,method,...(key===undefined?{}:{key})});
        if(store.name==='managed_local_operations'&&method==='get'&&Array.isArray(key))witness.operation=key.at(-1);
      }
      const request=native.apply(this,args);
      if(arm&&tx.mode==='readwrite'&&store.name===arm.store&&method==='get'&&((Array.isArray(args[0])&&args[0].at(-1)===arm.operation)||(arm.key!==undefined&&args[0]===arm.key&&witness.operation===arm.operation))){
        witness.operation=arm.operation;
        if(['before-prepare','common-authored'].includes(arm.point)){
          const point=arm.point;arm=undefined;
          request.addEventListener('success',event=>{
            // Delay only delivery of this genuine native success to the original
            // product callback. Resume inside a live native keepalive callback.
            const callback=request.onsuccess;
            if(typeof callback!=='function')throw new Error('Expected native product success handler');
            event.stopImmediatePropagation();
            hold(tx,witness,point,()=>callback.call(request,event));
          },{once:true});
        }
      }
      return request;
    };
  }
  for(const method of ['add','put','delete','clear']){
    const native=IDBObjectStore.prototype[method];IDBObjectStore.prototype[method]=function(...args){
      const tx=this.transaction,witness=witnessByTx.get(tx);
      if(witness){if(witness.writes.length>=2048)emit({event:'observer-error',message:'Write witness capacity exceeded'});else witness.writes.push({store:this.name,method,...(this.name==='control'?{key:structuredClone(method==='delete'?args[0]:args[1]??args[0]?.key),...(method==='put'||method==='add'?{value:structuredClone(args[0])}:{})}:{})});}
      if(this.name==='managed_local_operations'&&method==='add'&&witness)witness.journalAdded=args[0]?.operationId;
      const request=native.apply(this,args);
      if(arm&&arm.point==='after-final-write'&&tx.mode==='readwrite'&&this.name==='control'&&method==='put'&&witness?.journalAdded===arm.operation){
        arm=undefined;request.addEventListener('success',()=>hold(tx,witness,'after-final-write'),{once:true});
      }
      return request;
    };
  }
}
