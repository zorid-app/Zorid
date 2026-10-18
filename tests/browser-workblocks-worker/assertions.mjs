/** Evidence checks only: no domain command, state merge, receipt or registration construction. */
export const assert=(value,message)=>{if(!value)throw new Error(message);};
export function canonical(value){
  if(value instanceof ArrayBuffer)return [...new Uint8Array(value)];
  if(ArrayBuffer.isView(value))return [...new Uint8Array(value.buffer,value.byteOffset,value.byteLength)];
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
export const equal=(left,right,message)=>assert(JSON.stringify(canonical(left))===JSON.stringify(canonical(right)),message);
export async function rejects(action,code){try{await action();}catch(error){assert(error.code===code,`Expected ${code}; got ${error.code}: ${error.message}`);return {code:error.code,source:error.source,commitUncertain:error.commitUncertain};}throw new Error('Expected rejection: '+code);}
export function pageEvidence(page,query){
  assert(Number.isInteger(page.scanned)&&page.scanned>=0&&page.scanned<=query.limit,'Page scanned budget');
  assert(Number.isInteger(page.bytes)&&page.bytes>=0&&page.bytes<=query.byteLimit,'Page byte budget');
  assert(page.blocks.length<=page.scanned,'Blocks exceed scanned rows');
  assert(page.incomplete===(page.cursor!==null),'Cursor/incomplete disagreement');
  if(page.incomplete)assert(page.scanned>0&&page.cursor!==query.cursor,'Continuation did not advance');
  assert(/^(0|[1-9][0-9]*)$/.test(page.watermark),'Noncanonical watermark');return page;
}
export function changesEvidence(page,after,limit){
  assert(page.changes.length<=limit,'Changes limit exceeded');let previous=BigInt(after);
  for(const row of page.changes){assert(/^[1-9][0-9]*$/.test(row.sequence)&&BigInt(row.sequence)>previous,'Changes did not advance');previous=BigInt(row.sequence);const target=JSON.parse(row.record_key);assert(Array.isArray(target)&&target.length===2&&target.every(x=>typeof x==='string'),'Native record key lost');assert(typeof row.update_id==='string'&&typeof row.status==='string','Native change identity/status lost');}
  equal(page.next,page.changes.at(-1)?.sequence??after,'Changes next mismatch');return page;
}
export function assertStrict(witnesses){assert(witnesses.length>0,'No real write transactions observed');assert(witnesses.every(row=>row.requested==='strict'&&row.actual==='strict'),'Non-strict real transaction observed');assert(witnesses.every(row=>['complete','abort'].includes(row.outcome)),'Unsettled transaction witness');}
/** Exact replay must not read current state, histories, source or quota facts. */
export function replayPreflightEvidence(witness){
  assert(witness?.mode==='readwrite'&&witness.outcome==='complete','No completed real replay transaction');
  assert(witness.writes.length===0,'Replay wrote durable rows');
  assert(witness.reads.some(read=>read.store==='managed_local_operations'),'No journal read witnessed');
  for(const read of witness.reads){
    assert(['control','managed_collections','managed_local_operations'].includes(read.store),'Replay accessed current facts: '+read.store);
    if(read.store==='control')assert(read.method==='get'&&read.key==='local-store-id','Replay accessed quota/control facts');
  }
  return witness;
}
/** Local causal claim only: one genuine terminal event and its exact RPC reply. */
export function transactionBeforeRpcEvidence(terminal,reply){
  assert(terminal?.event==='transaction'&&terminal.witness?.mode==='readwrite'&&['complete','abort'].includes(terminal.witness.outcome),'Missing real write transaction terminal event');
  assert(Number.isSafeInteger(terminal.witness.id)&&terminal.witness.id>0,'Missing terminal transaction identity');
  assert(reply?.event==='rpc-reply'&&['workblock-command','sync-once'].includes(reply.rpc),'Missing exact observed RPC reply');
  assert(typeof reply.id==='string'&&reply.id.length>0,'Missing exact RPC identity');
  assert(typeof terminal.workerId==='string'&&terminal.workerId===reply.workerId,'Terminal and reply came from different Worker lifetimes');
  assert(Number.isSafeInteger(terminal.ordinal)&&Number.isSafeInteger(reply.ordinal)&&terminal.ordinal>0&&terminal.ordinal<reply.ordinal,'RPC reply preceded transaction terminal event');
  if(reply.rpc==='workblock-command')assert(typeof reply.operation==='string'&&terminal.witness.operation===reply.operation,'Terminal transaction belongs to another mutation');
  return {workerId:terminal.workerId,transaction:terminal.witness.id,operation:terminal.witness.operation,outcome:terminal.witness.outcome,terminalOrdinal:terminal.ordinal,replyOrdinal:reply.ordinal,rpc:reply.rpc,id:reply.id};
}

/** Keyed full-row differences; absence remains distinguishable from any value. */
export function rowDiffs(before,after){
  const diffs=[];
  for(const store of [...new Set([...Object.keys(before),...Object.keys(after)])].sort()){
    const index=rows=>new Map((rows??[]).map(row=>[JSON.stringify(canonical(row.key)),row]));
    const left=index(before[store]),right=index(after[store]);
    for(const key of [...new Set([...left.keys(),...right.keys()])].sort()){
      const a=left.get(key),b=right.get(key);
      if(JSON.stringify(canonical(a))!==JSON.stringify(canonical(b)))diffs.push({store,key:JSON.parse(key),before:a??null,after:b??null});
    }
  }
  return diffs;
}
/** Sole exception: absent -> EXACT empty document-index catalog from source close.
 * Never filters control or any source/managed row. Requires native write content
 * plus same-Worker release RPC causality; a changed existing catalog is rejected. */
export function abortedAtomicityEvidence({before,after,events,operation,database}){
  equal(Object.keys(before).sort(),Object.keys(after).sort(),'Atomicity store inventory changed');
  for(const snapshot of [before,after])for(const rows of Object.values(snapshot)){
    assert(Array.isArray(rows),'Invalid atomicity store rows');
    assert(new Set(rows.map(row=>JSON.stringify(canonical(row.key)))).size===rows.length,'Duplicate atomicity row key');
  }
  const terminals=events.filter(e=>e.event==='transaction'&&e.witness.operation===operation&&e.witness.mode==='readwrite');
  assert(terminals.length===1,'Missing unique aborted mutation transaction');
  const terminal=terminals[0];
  const reply=events.find(e=>e.event==='rpc-reply'&&e.rpc==='workblock-command'&&e.operation===operation);
  transactionBeforeRpcEvidence(terminal,reply);
  assertStrict([terminal.witness]);
  assert(terminal.witness.outcome==='abort'&&reply.ok===false&&reply.error?.commitUncertain===false,'Missing definite actual abort');
  const diffs=rowDiffs(before,after);
  assert(diffs.length<=1,'Abort changed multiple durable rows');
  const diff=diffs[0],key='document-index:v1/catalog';
  if(diff)assert(diff.store==='control'&&diff.key===key&&diff.before===null,'Abort changed a noncatalog row or existing catalog');
  const authority=before.control.find(row=>row.key==='local-store-id')?.value?.value;
  assert(typeof authority==='string'&&authority.length>0,'Missing persisted local authority');
  const expected={key,value:{version:1,localStoreId:authority,head:null,generations:[],pins:[]}};
  if(diff)equal(diff.after,{key,value:expected},'Catalog is not the exact empty close schema/content');
  const worker=terminal.workerId;
  assert(typeof database==='string'&&database.length>0&&events.every(e=>e.workerId===worker&&e.database===database),'Mixed lifetime/database atomicity evidence');
  let previous=0;
  for(const event of events){assert(Number.isSafeInteger(event.ordinal)&&event.ordinal>previous,'Unordered atomicity evidence');previous=event.ordinal;}
  const transactions=events.filter(e=>e.event==='transaction');
  assert(new Set(transactions.map(e=>e.witness.id)).size===transactions.length,'Duplicate terminal transaction identity');
  for(const {witness} of transactions){
    assert(Number.isSafeInteger(witness.id)&&witness.id>0&&Array.isArray(witness.writes),'Invalid transaction witness');
    assert(['complete','abort'].includes(witness.outcome),'Unsettled transaction witness');
    assert(['readwrite','readonly'].includes(witness.mode),'Invalid transaction mode');
    if(witness.mode==='readwrite')assertStrict([witness]);
    else assert(witness.writes.length===0,'Readonly transaction reported writes');
  }
  const release=events.find(e=>e.event==='rpc-in'&&e.rpc==='release-client'&&e.ordinal<terminal.ordinal);
  const released=events.find(e=>e.event==='rpc-reply'&&e.rpc==='release-client'&&e.id===release?.id&&e.ok===true);
  assert(release&&released,'Missing correlated successful release lifecycle');
  assert(reply.ordinal<released.ordinal,'Release ACK preceded aborted mutation reply');
  const intervening=transactions.filter(e=>e!==terminal);
  const candidates=intervening.filter(e=>e.witness.writes.length>0);
  if(!diffs.length){
    assert(candidates.length===0,'Unchanged abort snapshot has another write transaction');
    return {diffs,catalogException:null};
  }
  assert(candidates.length===1,'Missing unique separate close write transaction');
  const close=candidates[0];assertStrict([close.witness]);
  assert(close.witness.mode==='readwrite'&&close.witness.outcome==='complete'&&close.ordinal>reply.ordinal&&close.ordinal<released.ordinal,'Close write outside completed release lifecycle');
  assert(close.witness.id!==terminal.witness.id,'Catalog write is not separate from abort');
  equal(close.witness.stores,['control'],'Close transaction accessed other stores');
  equal(close.witness.reads,[{store:'control',method:'get',key:'local-store-id'},{store:'control',method:'get',key}],'Unexpected close transaction reads');
  equal(close.witness.writes,[{store:'control',method:'put',key,value:expected}],'Close transaction did not write exact catalog');
  return {diffs,catalogException:{release,terminal,reply,close,released}};
}
