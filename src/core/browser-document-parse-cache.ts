import {BrowserVaultError} from './browser-vault.ts';
import {decimalOrder,decimalU64,nextDecimalU64,normalizedTransact} from './browser-normalized-idb.ts';

/** Format, capacity, admission and eviction work limits are supplied by Rust.
 * This adapter executes only scoped IndexedDB transactions; it defines no parser
 * or cache policy. Payloads are opaque typed Rust results, not source authority. */
export interface BrowserParseCachePolicy {formatVersion:number;maxRows:number;maxBytes:number;maxRowBytes:number;maxEvictionsPerWrite:number}
export interface BrowserParseCacheUsage {rows:number;bytes:number}
export type BrowserParseCacheAdmission='skipOversized'|'skipEvictionLimit'|'write'|'evictOldest';
export type BrowserParseCacheLookup={outcome:'hit';payload:string}|{outcome:'miss'|'unavailable'|'corrupt'|'unsupported'};
interface Host {db:IDBDatabase;authorityId:string;assertActive():void;policy:BrowserParseCachePolicy;admit(usage:BrowserParseCacheUsage,replaced:number|null,incoming:number,evicted:number):BrowserParseCacheAdmission}
interface Catalog {formatVersion:number;authorityId:string;rows:number;bytes:number;nextOrdinal:string;clearing?:string}
interface Row {key:string;locator:string;ordinal:string;bytes:number;payload:string}
interface Order {key:string;locator:string;ordinal:string;bytes:number}
const PREFIX='document-parse-cache:v1/',CATALOG=PREFIX+'catalog',ROWS=PREFIX+'row/',ORDER=PREFIX+'oldest/';
const size=(value:string)=>new TextEncoder().encode(value).byteLength;
class Corrupt extends Error {}
class Unsupported extends Error {}
function corrupt():never {throw new Corrupt('Optional parse cache is inconsistent');}
const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const locator=(value:string):void=>{if(!/^[0-9a-f]{64}$/.test(value))corrupt();};
/** Authority/admission/source errors are never converted into cache misses. */
function unavailable(error:unknown):boolean {
  return error instanceof BrowserVaultError&&['storage_failure','strict_durability_unavailable'].includes(error.code)
    ||error instanceof DOMException&&['QuotaExceededError','AbortError','InvalidStateError','UnknownError','NotFoundError'].includes(error.name);
}
export function browserDocumentParseCache(host:Host){
  const p=Object.freeze({...host.policy});
  if(![p.formatVersion,p.maxRows,p.maxBytes,p.maxRowBytes,p.maxEvictionsPerWrite].every(n=>integer(n)&&n>0))throw new Error('Invalid Rust parse-cache policy');
  const empty=():Catalog=>({formatVersion:p.formatVersion,authorityId:host.authorityId,rows:0,bytes:0,nextOrdinal:'0'});
  const run=<T>(mode:IDBTransactionMode,start:(tx:IDBTransaction,done:(value:T)=>void,abort:(error:unknown)=>void)=>void)=>normalizedTransact(host.db,{authorityId:host.authorityId,stores:['control'],mode,assertActive:host.assertActive},start);
  const on=<T>(request:IDBRequest<T>,action:(value:T)=>void,abort:(error:unknown)=>void)=>{request.onsuccess=()=>{try{host.assertActive();action(request.result);}catch(error){abort(error);}};};
  function catalog(raw:any):Catalog {
    if(raw===undefined)return empty();
    const c=raw?.value as Catalog;if(!raw||Object.keys(raw).some(k=>!['key','value'].includes(k))||c&&Object.keys(c).some(k=>!['formatVersion','authorityId','rows','bytes','nextOrdinal','clearing'].includes(k))||raw.key!==CATALOG||!c||c.authorityId!==host.authorityId||!integer(c.rows)||!integer(c.bytes)||c.rows>p.maxRows||c.bytes>p.maxBytes||(c.rows===0)!==(c.bytes===0)||c.rows>c.bytes||c.bytes>c.rows*p.maxRowBytes||c.clearing!==undefined&&(typeof c.clearing!=='string'||c.clearing.length!==36))corrupt();
    if(c.formatVersion!==p.formatVersion)throw new Unsupported('Optional cache format unavailable');
    try{decimalU64(c.nextOrdinal);}catch{corrupt();}return c;
  }
  const readCatalog=(tx:IDBTransaction,done:(value:Catalog,missing:boolean)=>void,abort:(error:unknown)=>void)=>on(tx.objectStore('control').get(CATALOG),raw=>done(catalog(raw),raw===undefined),abort);
  const putCatalog=(tx:IDBTransaction,c:Catalog)=>tx.objectStore('control').put({key:CATALOG,value:c});
  function row(raw:any,key:string):Row {locator(key);const r=raw as Row;if(!r||Object.keys(r).some(k=>!['key','locator','ordinal','bytes','payload'].includes(k))||r.key!==ROWS+key||r.locator!==key||typeof r.payload!=='string'||!integer(r.bytes)||r.bytes<1||r.bytes>p.maxRowBytes||r.payload.length>p.maxRowBytes||size(r.payload)!==r.bytes)corrupt();try{decimalU64(r.ordinal);}catch{corrupt();}return r;}
  const orderKey=(ordinal:string,key:string)=>ORDER+decimalOrder(ordinal)+'/'+key;
  function order(raw:any):Order {const r=raw as Order;if(!r||Object.keys(r).some(k=>!['key','locator','ordinal','bytes'].includes(k))||typeof r.locator!=='string')corrupt();locator(r.locator);try{decimalU64(r.ordinal);}catch{corrupt();}if(r.key!==orderKey(r.ordinal,r.locator)||!integer(r.bytes)||r.bytes<1||r.bytes>p.maxRowBytes)corrupt();return r;}
  const bounds=(prefix:string)=>IDBKeyRange.bound(prefix,prefix+'\uffff');
  const same=(a:Row,b:Order)=>a.locator===b.locator&&a.ordinal===b.ordinal&&a.bytes===b.bytes;
  return {
    async lookup(key:string):Promise<BrowserParseCacheLookup>{
      locator(key);
      try{return await run<BrowserParseCacheLookup>('readonly',(tx,done,abort)=>readCatalog(tx,(c,missing)=>{
        if(c.clearing){done({outcome:'unavailable'});return;}
        on(tx.objectStore('control').get(ROWS+key),raw=>{
          if(raw===undefined){done({outcome:'miss'});return;}if(missing||c.rows===0)corrupt();const r=row(raw,key);
          if(r.bytes>c.bytes||BigInt(r.ordinal)>=BigInt(c.nextOrdinal))corrupt();on(tx.objectStore('control').get(orderKey(r.ordinal,key)),raw=>{if(!same(r,order(raw)))corrupt();done({outcome:'hit',payload:r.payload});},abort);
        },abort);
      },abort));}catch(error){if(error instanceof Corrupt)return{outcome:'corrupt'};if(error instanceof Unsupported)return{outcome:'unsupported'};if(unavailable(error))return{outcome:'unavailable'};throw error;}
    },
    async store(key:string,payload:string):Promise<void>{
      locator(key);const incoming=size(payload);if(!incoming)corrupt();
      try{await run<void>('readwrite',(tx,done,abort)=>readCatalog(tx,(c,missing)=>{
        if(c.clearing){done();return;}
        on(tx.objectStore('control').get(ROWS+key),raw=>{
          const previous=raw===undefined?undefined:row(raw,key);if(previous&&(missing||c.rows===0||previous.bytes>c.bytes||BigInt(previous.ordinal)>=BigInt(c.nextOrdinal)))corrupt();
          const start=()=>{let removed=0;
            const admit=()=>{
              let action:BrowserParseCacheAdmission;try{action=host.admit({rows:c.rows,bytes:c.bytes},previous?.bytes??null,incoming,removed);}catch{corrupt();}
              if(action==='skipOversized'||action==='skipEvictionLimit'){done();return;}
              if(action==='write'){
                let ordinal=previous?.ordinal;if(ordinal===undefined){ordinal=c.nextOrdinal;try{c.nextOrdinal=nextDecimalU64(c.nextOrdinal);}catch{corrupt();}c.rows++;}
                const value:Row={key:ROWS+key,locator:key,ordinal,bytes:incoming,payload};
                c.bytes+=incoming-(previous?.bytes??0);tx.objectStore('control').put(value);if(!previous)tx.objectStore('control').add({key:orderKey(ordinal,key),locator:key,ordinal,bytes:incoming});else tx.objectStore('control').put({key:orderKey(ordinal,key),locator:key,ordinal,bytes:incoming});putCatalog(tx,c);done();return;
              }
              if(action!=='evictOldest'||removed>=p.maxEvictionsPerWrite)corrupt();
              const request=tx.objectStore('control').openCursor(bounds(ORDER));
              on(request,function next(cursor){if(!cursor)corrupt();const victim=order(cursor.value);if(victim.locator===key){if(!previous||!same(previous,victim))corrupt();cursor.continue();return;}
                on(tx.objectStore('control').get(ROWS+victim.locator),raw=>{const old=row(raw,victim.locator);if(!same(old,victim)||old.bytes>c.bytes||c.rows===0||BigInt(old.ordinal)>=BigInt(c.nextOrdinal))corrupt();tx.objectStore('control').delete(old.key);tx.objectStore('control').delete(victim.key);c.rows--;c.bytes-=old.bytes;removed++;putCatalog(tx,c);admit();},abort);
              },abort);
            };admit();
          };
          if(previous){on(tx.objectStore('control').get(orderKey(previous.ordinal,key)),raw=>{if(!same(previous,order(raw)))corrupt();start();},abort);return;}
          if(!missing){start();return;}
          // An absent usage row may only describe a genuinely empty prefix.
          on(tx.objectStore('control').openKeyCursor(bounds(ROWS)),cursor=>{if(cursor)corrupt();on(tx.objectStore('control').openKeyCursor(bounds(ORDER)),cursor=>{if(cursor)corrupt();start();},abort);},abort);
        },abort);
      },abort));}catch(error){if(error instanceof Corrupt||error instanceof Unsupported||unavailable(error))return;throw error;}
    },
    async clear():Promise<void>{
      // Explicit derived-only repair blocks concurrent cache stores with a nonce.
      // Each transaction visits at most the shared bounded work count. No source,
      // pending checkpoint, receipt, generation or pin key is an eviction target.
      const nonce=crypto.randomUUID();
      try{await run<void>('readwrite',(tx,done)=>{putCatalog(tx,{...empty(),clearing:nonce});done();});
        for(const prefix of [ROWS,ORDER])for(;;){const more=await run<boolean>('readwrite',(tx,done,abort)=>readCatalog(tx,c=>{if(c.clearing!==nonce){done(false);return;}let count=0;const request=tx.objectStore('control').openKeyCursor(bounds(prefix));on(request,function next(cursor){if(!cursor){done(false);return;}tx.objectStore('control').delete(cursor.primaryKey);count++;if(count===p.maxEvictionsPerWrite){done(true);return;}cursor.continue();},abort);},abort));if(!more)break;await new Promise<void>(resolve=>setTimeout(resolve,0));}
        await run<void>('readwrite',(tx,done,abort)=>readCatalog(tx,c=>{if(c.clearing===nonce)putCatalog(tx,empty());done();},abort));
      }catch(error){if(error instanceof Corrupt||error instanceof Unsupported||unavailable(error))return;throw error;}
    },
  };
}
