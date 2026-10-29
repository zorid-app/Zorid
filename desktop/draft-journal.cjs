'use strict';
const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');

const TEXT_BYTES = 64 * 1024 * 1024, HEAD_BYTES = 64 * 1024;
const QUEUED_BYTES = 128 * 1024 * 1024, MAX_PENDING = 8, MAX_BRANCHES = 4096;
const maximum = (1n << 64n) - 1n;
const fail = (code, uncertain=false) => Object.assign(new Error('Independent draft protection is unavailable.'), {code, commitUncertain:uncertain});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function id(value) {
  if(typeof value !== 'string' || !value || value.length > 256 || value.includes('\0'))throw fail('invalid_draft_identity');
  return value;
}
function revision(value, nullable=false) {
  if(nullable && value === null)return null;
  if(typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value)>maximum)throw fail('invalid_draft_revision');
  return value;
}
function generation(value) {
  if(!Number.isSafeInteger(value) || value<0 || Object.is(value,-0))throw fail('invalid_draft_generation');
  return value;
}
function source(value) {
  if(typeof value !== 'string' || value.length*2 > TEXT_BYTES)throw fail('draft_size_limit');
  return value;
}
const identity = (scope, value) => ({vaultId:id(scope.vaultId),clientId:id(scope.clientId),
  incarnationId:id(value.incarnationId??scope.incarnationId),entryId:id(value.entryId),writer:id(value.writer)});
const scopePrefix = value => hash(JSON.stringify([value.vaultId,value.clientId]))+'-';
const entryPrefix = value => scopePrefix(value)+hash(JSON.stringify([value.vaultId,value.clientId,value.entryId]))+'-';
const branchKey = value => entryPrefix(value)+hash(JSON.stringify([value.vaultId,value.clientId,value.incarnationId,value.entryId,value.writer]));
const branchName = value => typeof value==='string'&&/^[a-f0-9]{64}-[a-f0-9]{64}-[a-f0-9]{64}$/.test(value);
const receipt = head => Object.freeze({...head.identity,revision:head.revision,generation:head.generation,deleted:head.deleted});

/** Independent, inert desktop draft storage. Never plans, commits or replays a
 * domain write; pendingOperation is an exact opaque recovery capsule.
 *
 * CALLER CONTRACT: main holds the profile singleton lock for this entire owner
 * lifetime. directory is a private direct child of an existing trusted profile
 * directory. Only main may bind a scope previously established by trusted core
 * admission. This API is NOT renderer authentication or a scope grant.
 *
 * Bind a NEW incarnation for each renderer/document lifetime, retain its lease
 * through Rust-host retirement, revoke on frame/window/vault replacement. The
 * synchronous owner callback must throw or return false for a revoked lifetime,
 * without contacting Rust. Revocation
 * prevents future publication authorizations; a rename already authorized and in
 * flight may finish. An uncertain failure must retain/retry the EXACT request.
 *
 * One owner serializes all branches. Revisions are positive decimal counters:
 * null -> 1 -> 2, including retirement tombstones. A retry is accepted only at
 * the same next revision with the exact captured request. No ID reuse ledger or
 * cross-writer last-writer-wins rule is needed. Raw UTF-16LE blobs preserve lone
 * surrogates too; oversized recovery fails explicitly, never truncates.
 *
 * Unshipped layout v2 embeds hashed scope and entry prefixes in branch names.
 * list({entryId}) filters names BEFORE reading heads; prefixes never authorize a
 * candidate. Every selected head must recompute to its entire directory name.
 * The flat v1 prototype is explicitly unsupported, never silently migrated.
 *
 * fileSystem is a private filesystem-boundary fault-injection seam for tests.
 */
async function openDraftJournal(directory, {fileSystem=fs}={}) {
  const io=fileSystem;
  if(typeof directory!=='string'||!path.isAbsolute(directory)||directory.includes('\0'))throw fail('invalid_draft_directory');
  let tail=Promise.resolve(), closed=false, queuedBytes=0, pending=0;
  const incarnations=new Set(), leases=new Set();
  async function syncDirectory(name) {
    if(process.platform==='win32')return;
    const handle=await io.open(name,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    try {if(!(await handle.stat()).isDirectory())throw fail('draft_storage_corrupt');await handle.sync();}finally{await handle.close();}
  }
  async function ensureDirectory(name) {
    let created=false;
    try {await io.mkdir(name,{mode:0o700});created=true;}catch(error){if(error.code!=='EEXIST')throw error;}
    const info=await io.lstat(name);
    if(!info.isDirectory()||info.isSymbolicLink())throw fail('draft_storage_corrupt');
    if(created)await syncDirectory(path.dirname(name));
  }
  await ensureDirectory(directory);
  const branches=path.join(directory,'branches');await ensureDirectory(branches);
  async function* names() {
    const entries=await io.opendir(branches);let count=0;
    for await(const entry of entries){
      if(++count>MAX_BRANCHES)throw fail('draft_inventory_limit');
      if(digest(entry.name))throw fail('draft_layout_unsupported');
      if(!branchName(entry.name))throw fail('draft_storage_corrupt');
      yield entry.name;
    }
  }
  // No head reads or in-memory catalogue: opening rejects an old/invalid layout,
  // and every later inventory enumerates and validates current names afresh.
  for await(const name of names())void name;
  const locations=key=>({branch:path.join(branches,key),blobs:path.join(branches,key,'blobs'),head:path.join(branches,key,'head.json')});
  async function existingDirectory(name, missing=false) {
    try {const info=await io.lstat(name);if(!info.isDirectory()||info.isSymbolicLink())throw fail('draft_storage_corrupt');return true;}
    catch(error){if(missing&&error.code==='ENOENT')return false;throw error;}
  }
  async function readFile(file, limit, missing=false) {
    let handle;
    try {
      handle=await io.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
      const info=await handle.stat();
      if(!info.isFile()||info.size>limit)throw fail('draft_storage_corrupt');
      const bytes=await handle.readFile();
      if(bytes.length!==info.size||bytes.length>limit)throw fail('draft_storage_corrupt');
      return bytes;
    }catch(error){if(missing&&error.code==='ENOENT')return null;throw error;}finally{await handle?.close();}
  }
  async function readHead(key) {
    if(!await existingDirectory(locations(key).branch,true))return null;
    const bytes=await readFile(locations(key).head,HEAD_BYTES,true);if(bytes===null)return null;
    let head;
    try {
      head=JSON.parse(bytes.toString('utf8'));
      if(head?.version===1)throw fail('draft_layout_unsupported');
      if(!head||head.version!==2||!head.identity||branchKey(identity(head.identity,head.identity))!==key||
        revision(head.revision)!==head.revision||generation(head.generation)!==head.generation||
        typeof head.deleted!=='boolean'||!digest(head.fingerprint))throw Error();
      revision(head.previousRevision,true);
      if(BigInt(head.revision)!==(head.previousRevision===null?1n:BigInt(head.previousRevision)+1n))throw Error();
      const {fingerprint,...unsigned}=head;
      if(hash(JSON.stringify(unsigned))!==fingerprint)throw Error();
      if(!head.deleted){
        if(!head.baseline||head.baseline.entryId!==head.identity.entryId||typeof head.baseline.path!=='string'||
          typeof head.baseline.revision!=='string'||!digest(head.baseline.content)||!digest(head.draft)||
          head.pendingOperation!==null&&!digest(head.pendingOperation))throw Error();
        if(head.checkpointRevision!==null)id(head.checkpointRevision);
      }
    }catch(error){if(error.code==='draft_layout_unsupported')throw error;throw fail('draft_storage_corrupt');}
    return head;
  }
  async function readBlobBytes(key, name) {
    await existingDirectory(locations(key).blobs);
    const bytes=await readFile(path.join(locations(key).blobs,name),TEXT_BYTES);
    if(bytes.length%2!==0||hash(bytes)!==name)throw fail('draft_storage_corrupt');
    return bytes;
  }
  const readBlob=async(key,name)=>(await readBlobBytes(key,name)).toString('utf16le');
  const references=head=>head.deleted?[]:[...new Set([head.baseline.content,head.draft,head.pendingOperation].filter(value=>value!==null))];
  async function syncHead(key, head) {
    const place=locations(key);
    for(const name of [...references(head).map(name=>path.join(place.blobs,name)),place.head]){
      const handle=await io.open(name,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
      try{await handle.sync();}finally{await handle.close();}
    }
    await syncDirectory(place.blobs);await syncDirectory(place.branch);await syncDirectory(branches);await syncDirectory(directory);
  }
  async function atomicFile(file, bytes, authorize=()=>{}) {
    const temporary=path.join(path.dirname(file),`.draft-${randomUUID()}.tmp`);let handle;
    try {
      handle=await io.open(temporary,'wx',0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=undefined;
      authorize();await io.rename(temporary,file);await syncDirectory(path.dirname(file));
    }finally{await handle?.close().catch(()=>{});await io.unlink(temporary).catch(()=>{});}
  }
  async function writeBlob(key, name, bytes) {
    const file=path.join(locations(key).blobs,name);
    const old=await readFile(file,TEXT_BYTES,true);
    if(old!==null){if(!old.equals(bytes))throw fail('draft_storage_corrupt');}
    else await atomicFile(file,bytes);
    return name;
  }
  // Once the replacement head is durable, old blobs in THIS branch are no longer
  // reachable. Other writers/incarnations have separate directories. Cleanup is
  // best effort and may leave orphans after a crash; it never invalidates a head.
  async function prune(key, head) {
    const keep=new Set(references(head)), place=locations(key);
    const entries=await io.opendir(place.blobs);
    for await(const entry of entries)if(digest(entry.name)&&!keep.has(entry.name))await io.unlink(path.join(place.blobs,entry.name));
  }
  function enqueue(check, bytes, action) {
    try {check();if(pending>=MAX_PENDING||queuedBytes+bytes>QUEUED_BYTES)throw fail('draft_journal_busy');}catch(error){return Promise.reject(error);}
    pending++;queuedBytes+=bytes;
    const result=tail.then(async()=>{check();return action();}).catch(error=>{
      if(error.code?.startsWith('draft_')||error.code?.startsWith('invalid_draft_'))throw error;
      const failure=fail('draft_storage_failure');failure.cause=error;throw failure;
    });
    const done=result.finally(()=>{pending--;queuedBytes-=bytes;});tail=done.catch(()=>{});return done;
  }
  return Object.freeze({
    bind(scope, assertOwner=()=>{}) {
      const bound={vaultId:id(scope.vaultId),clientId:id(scope.clientId),incarnationId:id(scope.incarnationId)};
      const leaseKey=JSON.stringify(bound);let revoked=false;
      const check=()=>{
        if(closed||revoked)throw fail('draft_lease_revoked');
        const result=assertOwner();
        if(result&&typeof result.then==='function'){
          // An accidentally async validator cannot authorize storage. Observe a
          // rejected Promise to avoid leaving an unhandled rejection behind.
          Promise.resolve(result).catch(()=>{});throw fail('invalid_draft_owner_check');
        }
        if(result===false)throw fail('draft_lease_revoked');
      };check();
      if(incarnations.has(leaseKey))throw fail('draft_incarnation_reused');incarnations.add(leaseKey);
      const revoke=()=>{revoked=true;leases.delete(revoke);};leases.add(revoke);
      function capture(value, retiring) {
        const own=identity(bound,value);
        if(!retiring&&own.incarnationId!==bound.incarnationId)throw fail('invalid_draft_identity');
        const expected=revision(value.expectedRevision,true), next=revision(value.nextRevision);
        if(BigInt(next)!==(expected===null?1n:BigInt(expected)+1n))throw fail('invalid_draft_revision');
        const captured={identity:own,revision:next,generation:generation(value.generation),deleted:retiring};
        if(!retiring){
          const base=value.baseline;
          if(!base||base.entryId!==own.entryId||typeof base.path!=='string'||typeof base.revision!=='string')throw fail('invalid_draft_baseline');
          if(base.path.length*2>HEAD_BYTES||base.revision.length*2>HEAD_BYTES)throw fail('draft_size_limit');
          captured.baseline={entryId:base.entryId,path:base.path,revision:base.revision,content:source(base.content)};
          captured.draft=source(value.draft);
          captured.checkpointRevision=value.checkpointRevision===null?null:id(value.checkpointRevision);
          captured.pendingOperation=value.pendingOperation===null?null:source(value.pendingOperation);
        }
        return {captured,expected};
      }
      function publish(value, retiring) {
        let captured, expected;
        try {({captured,expected}=capture(value,retiring));}catch(error){return Promise.reject(error);}
        const bytes=retiring?0:(captured.baseline.content.length+captured.draft.length+(captured.pendingOperation?.length??0))*2;
        return enqueue(check,bytes,async()=>{
          let mutation=false;
          try {
            const key=branchKey(captured.identity),place=locations(key);
            const head={version:2,...captured,previousRevision:expected};
            // Hashing/encoding occurs on the async storage lane, never in offer's
            // synchronous capture. Whole bodies are not nested in head JSON.
            const bodies=new Map();
            const body=text=>{const bytes=Buffer.from(text,'utf16le'),name=hash(bytes);bodies.set(name,bytes);return name;};
            if(!retiring){
              head.baseline={...captured.baseline,content:body(captured.baseline.content)};
              head.draft=body(captured.draft);
              head.pendingOperation=captured.pendingOperation===null?null:body(captured.pendingOperation);
            }
            head.fingerprint=hash(JSON.stringify(head));
            if(Buffer.byteLength(JSON.stringify(head),'utf8')>HEAD_BYTES)throw fail('draft_size_limit');
            const previous=await readHead(key);check();
            if(previous?.revision===head.revision){
              if(previous.fingerprint!==head.fingerprint)throw fail('draft_revision_conflict');
              // A prior rename/ACK may have been interrupted. Recheck payload and
              // complete durability barriers before acknowledging the exact retry.
              for(const name of references(previous))await readBlobBytes(key,name);
              mutation=true;await syncHead(key,previous);check();return receipt(previous);
            }
            if((previous?.revision??null)!==expected||previous&&head.generation<previous.generation||
              retiring&&(!previous||previous.deleted||previous.generation!==head.generation))throw fail('draft_revision_conflict');
            if(previous)for(const name of references(previous))await readBlobBytes(key,name);
            mutation=true;await ensureDirectory(place.branch);await ensureDirectory(place.blobs);
            for(const [name,bytes] of bodies)await writeBlob(key,name,bytes);
            await atomicFile(place.head,Buffer.from(JSON.stringify(head)),check);
            await syncHead(key,head);
            await prune(key,head).catch(()=>{});
            check();return receipt(head);
          }catch(error){
            if(error.code?.startsWith('draft_')||error.code?.startsWith('invalid_draft_')){if(mutation)error.commitUncertain=true;throw error;}
            const failure=fail('draft_storage_failure',mutation);failure.cause=error;throw failure;
          }
        });
      }
      return Object.freeze({
        scope:Object.freeze({...bound}),revoke,
        compareAndSwap:value=>publish(value,false),retire:value=>publish(value,true),
        read(value) {
          let own;try{own=identity(bound,value);}catch(error){return Promise.reject(error);}
          return enqueue(check,0,async()=>{
            const key=branchKey(own),head=await readHead(key);if(!head){check();return null;}
            if(head.deleted){check();return receipt(head);}
            const baseline={...head.baseline,content:await readBlob(key,head.baseline.content)};
            const draft=await readBlob(key,head.draft),pendingOperation=head.pendingOperation===null?null:await readBlob(key,head.pendingOperation);
            check();return {...receipt(head),baseline,draft,checkpointRevision:head.checkpointRevision,pendingOperation};
          });
        },
        list(options={}) {
          let selected;
          try {
            if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>key!=='entryId'))throw fail('invalid_draft_identity');
            selected=Object.hasOwn(options,'entryId')?id(options.entryId):undefined;
          }catch(error){return Promise.reject(error);}
          return enqueue(check,0,async()=>{
          const found=[],prefix=selected===undefined?scopePrefix(bound):entryPrefix({...bound,entryId:selected});
          for await(const name of names()){
            if(!name.startsWith(prefix))continue;
            const head=await readHead(name);
            if(head&&(head.identity.vaultId!==bound.vaultId||head.identity.clientId!==bound.clientId||selected!==undefined&&head.identity.entryId!==selected))throw fail('draft_storage_corrupt');
            if(head&&!head.deleted)found.push(receipt(head));
          }
          check();return found.sort((a,b)=>branchKey(a).localeCompare(branchKey(b)));
        });},
      });
    },
    async close(){closed=true;for(const revoke of leases)revoke();await tail;},
  });
}
module.exports={openDraftJournal};
