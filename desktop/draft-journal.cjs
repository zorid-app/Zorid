'use strict';
const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');

const TEXT_BYTES = 64 * 1024 * 1024, HEAD_BYTES = 64 * 1024;
const QUEUED_BYTES = 128 * 1024 * 1024, MAX_PENDING = 8, MAX_BRANCHES = 4096;
const maximum = (1n << 64n) - 1n;
const FORMAT='zorid-independent-drafts\n2\n';
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
const incarnationKey = value => JSON.stringify([value.vaultId,value.clientId,value.incarnationId]);
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
 * A bounded FORMAT marker identifies this unshipped layout. Unmarked nonempty
 * prototypes are explicitly unsupported, never silently migrated.
 *
 * maintain({maxUnits:1}) is MAIN-ONLY idle work, not a renderer capability or a
 * foreground operation. Each call examines at most one entry/head or unlinks one
 * unreachable trash file. An inactive validated tombstone is atomically moved
 * out of inventory before incremental trash cleanup. No live candidate is
 * deleted and source bodies are never read. Active incarnations and retirement targets
 * claimed by ANY live issuing lease remain protected until that lease revokes.
 * After main exits, old tokens cannot retry; a new renderer has a fresh
 * incarnation and inventory already omits deleted heads. This is why old dead
 * incarnation tombstones may be reclaimed, not an operation replay authority.
 *
 * fileSystem and testHeadLimit are private bounded-test seams, never IPC input.
 */
async function openDraftJournal(directory, {fileSystem=fs,testHeadLimit=MAX_BRANCHES}={}) {
  const io=fileSystem;
  if(typeof directory!=='string'||!path.isAbsolute(directory)||directory.includes('\0'))throw fail('invalid_draft_directory');
  if(!Number.isSafeInteger(testHeadLimit)||testHeadLimit<1||testHeadLimit>MAX_BRANCHES)throw fail('invalid_draft_limit');
  let tail=Promise.resolve(), closed=false, queuedBytes=0, pending=0;
  const incarnations=new Set(), activeIncarnations=new Set(), retirementTargets=new Map(), leases=new Set();
  let maintenanceCursor,maintenancePhase='branches',maintenanceTarget;
  const maintenanceSkipped=new Set();
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
  const marker=path.join(directory,'FORMAT');
  let format;
  try{format=await readFile(marker,64,true);}catch{throw fail('draft_storage_corrupt');}
  if(format===null){
    const entries=await io.opendir(branches);
    try{if(await entries.read())throw fail('draft_layout_unsupported');}finally{await entries.close();}
    await atomicFile(marker,Buffer.from(FORMAT));
  }else if(format.toString('utf8')!==FORMAT)throw fail('draft_layout_unsupported');
  const trash=path.join(directory,'retired-trash');await ensureDirectory(trash);
  async function* names() {
    const entries=await io.opendir(branches);
    for await(const entry of entries){
      if(digest(entry.name))throw fail('draft_layout_unsupported');
      if(!branchName(entry.name))throw fail('draft_storage_corrupt');
      yield entry.name;
    }
  }
  // No startup name/head scan or catalogue; inventory streams current names.
  const locations=(key,retired=false)=>{const branch=path.join(retired?trash:branches,key);return{branch,blobs:path.join(branch,'blobs'),head:path.join(branch,'head.json')};};
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
  async function readHead(key,retired=false) {
    if(!await existingDirectory(locations(key,retired).branch,true))return null;
    const bytes=await readFile(locations(key,retired).head,HEAD_BYTES,true);if(bytes===null)return null;
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
  const ownerCheck=()=>{if(closed)throw fail('draft_lease_revoked');};
  const protectedHead=head=>activeIncarnations.has(incarnationKey(head.identity))||retirementTargets.has(branchKey(head.identity));
  async function closeMaintenanceCursor(){
    const cursor=maintenanceCursor;maintenanceCursor=undefined;
    if(cursor)try{await cursor.close();}catch(error){if(error.code!=='ERR_DIR_CLOSED')throw error;}
  }
  const diagnostic=error=>error?.code==='draft_layout_unsupported'?'draft_layout_unsupported':error?.code==='draft_storage_corrupt'?'draft_storage_corrupt':'draft_storage_failure';
  function skipMaintenanceTarget(result){
    if(maintenanceTarget){
      if(maintenanceSkipped.size<MAX_BRANCHES)maintenanceSkipped.add(maintenanceTarget.key);
      else{maintenancePhase='branches';maintenanceSkipped.clear();result.done=true;result.errors.push('draft_inventory_limit');}
    }
    maintenanceTarget=undefined;
  }
  async function maintenanceUnit(){
    const result={examined:0,removed:0,done:false,errors:[]};
    const error=value=>result.errors.push(diagnostic(value));
    try{
      if(maintenanceTarget){
        const target=maintenanceTarget,place=locations(target.key,true);
        if(!maintenanceCursor){
          const folder=target.phase==='blobs'?place.blobs:place.branch;
          if(!await existingDirectory(folder,true)){
            if(target.phase==='blobs'){target.phase='branch';return result;}
            maintenanceTarget=undefined;return result;
          }
          maintenanceCursor=await io.opendir(folder);
        }
        const entry=await maintenanceCursor.read();
        if(entry){
          result.examined=1;
          const temporary=/^\.draft-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.tmp$/.test(entry.name);
          if(target.phase==='branch'&&entry.name==='head.json')return result;
          if(!entry.isFile()||!(temporary||target.phase==='blobs'&&digest(entry.name))){target.unknown=true;error(fail('draft_storage_corrupt'));return result;}
          ownerCheck();await io.unlink(path.join(target.phase==='blobs'?place.blobs:place.branch,entry.name));
          await syncDirectory(target.phase==='blobs'?place.blobs:place.branch);return result;
        }
        await closeMaintenanceCursor();
        if(target.unknown){skipMaintenanceTarget(result);return result;}
        if(target.phase==='blobs'){
          ownerCheck();await io.rmdir(place.blobs);await syncDirectory(place.branch);target.phase='branch';return result;
        }
        const head=await readHead(target.key,true);
        if(head&&!head.deleted){error(fail('draft_storage_corrupt'));skipMaintenanceTarget(result);return result;}
        ownerCheck();
        if(head){await io.unlink(place.head);await syncDirectory(place.branch);}
        // A crash after unlink leaves an EMPTY trash directory, never source.
        await io.rmdir(place.branch);await syncDirectory(trash);
        result.removed=1;maintenanceTarget=undefined;return result;
      }
      if(!maintenanceCursor)maintenanceCursor=await io.opendir(maintenancePhase==='branches'?branches:trash);
      const entry=await maintenanceCursor.read();
      if(!entry){
        await closeMaintenanceCursor();
        if(maintenancePhase==='branches'){maintenancePhase='trash';maintenanceSkipped.clear();}
        else{maintenancePhase='branches';maintenanceSkipped.clear();result.done=true;}
        return result;
      }
      result.examined=1;
      if(!branchName(entry.name)){error(fail(digest(entry.name)?'draft_layout_unsupported':'draft_storage_corrupt'));return result;}
      if(!entry.isDirectory()){error(fail('draft_storage_corrupt'));return result;}
      const retired=maintenancePhase==='trash';
      if(retired&&maintenanceSkipped.has(entry.name))return result;
      let head;
      try{head=await readHead(entry.name,retired);}catch(errorValue){error(errorValue);return result;}
      if(!head){
        if(retired){
          // rmdir cannot remove a nonempty headless/unknown trash item.
          try{ownerCheck();await io.rmdir(locations(entry.name,true).branch);await syncDirectory(trash);result.removed=1;}catch(errorValue){error(errorValue.code==='ENOTEMPTY'?fail('draft_storage_corrupt'):errorValue);}
        }else error(fail('draft_storage_corrupt'));
        return result;
      }
      if(!head.deleted){if(retired)error(fail('draft_storage_corrupt'));return result;}
      if(retired){
        await closeMaintenanceCursor();maintenanceTarget={key:entry.name,phase:'blobs',unknown:false};return result;
      }
      if(protectedHead(head))return result;
      const place=locations(entry.name),destination=locations(entry.name,true);
      try{await io.lstat(destination.branch);error(fail('draft_storage_corrupt'));return result;}catch(errorValue){if(errorValue.code!=='ENOENT')throw errorValue;}
      ownerCheck();if(protectedHead(head))return result;
      await io.rename(place.branch,destination.branch);
      await syncDirectory(branches);await syncDirectory(trash);return result;
    }catch(errorValue){
      // One bad entry is retained and reported without poisoning the owner.
      // Cursor/IO failures close the current pass so its handle never leaks.
      await closeMaintenanceCursor().catch(()=>{});skipMaintenanceTarget(result);
      if(errorValue.code==='draft_lease_revoked')throw errorValue;
      error(errorValue);return result;
    }
  }
  return Object.freeze({
    maintain(options={maxUnits:1}){
      if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).length!==1||options.maxUnits!==1)return Promise.reject(fail('invalid_draft_limit'));
      return enqueue(ownerCheck,0,maintenanceUnit);
    },
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
      const claims=new Set();activeIncarnations.add(incarnationKey(bound));
      const revoke=()=>{
        revoked=true;leases.delete(revoke);activeIncarnations.delete(incarnationKey(bound));
        for(const key of claims){const count=retirementTargets.get(key);if(count===1)retirementTargets.delete(key);else retirementTargets.set(key,count-1);}claims.clear();
      };leases.add(revoke);
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
        try {check();({captured,expected}=capture(value,retiring));}catch(error){return Promise.reject(error);}
        if(retiring){
          const key=branchKey(captured.identity);
          if(!claims.has(key)){
            if(!retirementTargets.has(key)&&retirementTargets.size>=MAX_BRANCHES)return Promise.reject(fail('draft_retirement_capacity'));
            claims.add(key);retirementTargets.set(key,(retirementTargets.get(key)??0)+1);
          }
        }
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
          const found=[],prefix=selected===undefined?scopePrefix(bound):entryPrefix({...bound,entryId:selected});let matched=0;
          for await(const name of names()){
            if(!name.startsWith(prefix))continue;
            if(++matched>testHeadLimit)throw fail('draft_inventory_limit');
            const head=await readHead(name);
            if(head&&(head.identity.vaultId!==bound.vaultId||head.identity.clientId!==bound.clientId||selected!==undefined&&head.identity.entryId!==selected))throw fail('draft_storage_corrupt');
            if(head&&!head.deleted)found.push(receipt(head));
          }
          check();return found.sort((a,b)=>branchKey(a).localeCompare(branchKey(b)));
        });},
      });
    },
    async close(){closed=true;for(const revoke of leases)revoke();await tail;await closeMaintenanceCursor();},
  });
}
module.exports={openDraftJournal};
