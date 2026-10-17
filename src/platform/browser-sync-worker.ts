/** Trusted worker-only fixture session. Networking never runs inside an IDB transaction. */
import { BrowserVaultError } from '../core/browser-vault.ts';
import type { BrowserSync, BrowserSyncKey, SyncCursor } from '../core/browser-sync.ts';
import { createBrowserSyncTransport, BrowserSyncTransportError } from './browser-sync-transport.ts';
import type { BrowserSyncTransport } from './browser-sync-transport.ts';
import { createBrowserGrpcTransport } from './browser-grpc-transport.ts';
export interface BrowserSyncFixtureCredentials {
  /** RPC2 is explicit. Unmarked legacy credentials select only the HTTP1 reference fixture. */
  version?:1|2;transport?:'grpc'|'http-json-v1';
  endpoint:string; realmId:string; vaultId:string; serverEpoch:string; keyEpoch:number;
  bearerToken:string; keyBytes:Uint8Array; allowLoopbackHttp?:boolean;
  /** Fresh synthetic vault only. Existing files are never implicitly adopted. */
  enrollEmpty?:boolean;
}
export interface BrowserRpcPage {
  through():string;complete():boolean;length():number;
  sequence(index:number):string;wire(index:number):Uint8Array;free():void;
}
export interface BrowserSyncCodec {
  WasmVaultKey:new(bytes:Uint8Array)=>BrowserSyncKey & {free():void};
  encodeSyncCursor(input:string):string;
  decodeSyncHello(expected:string,raw:Uint8Array):void;
  decodeSyncAccepted(expected:string,raw:Uint8Array):string;
  decodeSyncPage(expected:string,raw:Uint8Array):string;
  syncEnvelopeUpdateId(wire:Uint8Array):string;
  validateRpcHello?(raw:Uint8Array,realm:string,epoch:string):void;
  validateRpcAccepted?(raw:Uint8Array,vault:string,update:string,epoch:string):void;
  openRpcPage?(raw:Uint8Array,epoch:string,after:string,through?:string):BrowserRpcPage;
}
export interface BrowserSyncSweep {
  uploaded:number;received:number;
  /** Fixed relay snapshot consumed and sampled outbox empty, NOT causal/materialization
   * completeness, absence of missing chunks, or convergence with every peer. */
  complete:boolean;
}
interface Host {
  storage:BrowserSync; wasm:BrowserSyncCodec;
  assertOwner():void;
  fatal(code:string):void;
  /** Queues only local transactions, never the HTTP part of a sweep. */
  local<T>(operation:()=>Promise<T>):Promise<T>;
  changed(assertActive:()=>void):Promise<void>;
}
const failure=(code:string)=>new BrowserVaultError(code,'Browser sync session could not complete');
const opaque=/^[A-Za-z0-9_-]{1,128}(?![\s\S])/;
const json=JSON.stringify;
export class BrowserSyncWorker {
  private session?:{ storage:BrowserSync; transport:BrowserSyncTransport; key:BrowserSyncKey;
    free():void; assert():void; scope:{realm_id:string;vault_id:string;key_epoch:number}; epoch:string;
    ready:Promise<void>; rpc:boolean; active?:Promise<BrowserSyncSweep> };
  private generation=0;
  private host:Host;
  private transportFactory:typeof createBrowserSyncTransport;
  private grpcTransportFactory:typeof createBrowserSyncTransport;
  constructor(host:Host, transportFactory=createBrowserSyncTransport, grpcTransportFactory:typeof createBrowserSyncTransport=createBrowserGrpcTransport) {
    this.host=host;this.transportFactory=transportFactory;this.grpcTransportFactory=grpcTransportFactory;
  }
  revoke():void {
    this.generation++;
    const previous=this.session; this.session=undefined;
    previous?.transport.close(); previous?.free();
  }
  configure(input:BrowserSyncFixtureCredentials):Promise<void> {
    this.host.assertOwner();
    if(this.session) return Promise.reject(failure('sync_already_configured'));
    if(!input || ![input.realmId,input.vaultId,input.serverEpoch].every(value=>typeof value==='string'&&opaque.test(value)) ||
      !Number.isInteger(input.keyEpoch)||input.keyEpoch<1||input.keyEpoch>0xffffffff||!(input.keyBytes instanceof Uint8Array)||input.keyBytes.length!==32)
      return Promise.reject(failure('invalid_sync_credentials'));
    const rpc=input.version===2;
    const legacy=(input.version===undefined||input.version===1)&&(input.transport===undefined||input.transport==='http-json-v1');
    if(rpc?input.transport!=='grpc':!legacy)return Promise.reject(failure('invalid_sync_credentials'));
    if(rpc)for(const name of ['validateRpcHello','validateRpcAccepted','openRpcPage'] as const)if(typeof this.host.wasm[name]!=='function')return Promise.reject(failure('sync_bindings_unavailable'));
    for(const name of ['encodeSyncCursor','decodeSyncHello','decodeSyncAccepted','decodeSyncPage','syncEnvelopeUpdateId','WasmVaultKey'] as const)
      if(typeof this.host.wasm[name]!=='function')return Promise.reject(failure('sync_bindings_unavailable'));
    const generation=++this.generation;
    const assert=()=>{this.host.assertOwner();if(generation!==this.generation)throw failure('sync_session_revoked');};
    const scope={realm_id:input.realmId,vault_id:input.vaultId,key_epoch:input.keyEpoch},epoch=input.serverEpoch;
    let transport:BrowserSyncTransport;
    try { transport=(rpc?this.grpcTransportFactory:this.transportFactory)({endpoint:input.endpoint,vaultId:input.vaultId,bearerToken:input.bearerToken,allowLoopbackHttp:input.allowLoopbackHttp}); }
    catch { input.keyBytes.fill(0); return Promise.reject(failure('invalid_sync_credentials')); }
    if(rpc&&transport.format!=='grpc-protobuf-v2'||!rpc&&transport.format==='grpc-protobuf-v2'){transport.close();input.keyBytes.fill(0);return Promise.reject(failure('invalid_sync_credentials'));}
    let owned:BrowserSyncKey & {free():void};
    try { owned=new this.host.wasm.WasmVaultKey(input.keyBytes); }
    catch { transport.close(); return Promise.reject(failure('invalid_sync_credentials')); }
    finally { input.keyBytes.fill(0); }
    let freed=false;
    const free=()=>{if(!freed){freed=true;owned.free();}};
    const key:BrowserSyncKey={
      seal(header,bytes){assert();return owned.seal(header,bytes);},
      openSyncUpdate(context,wire){assert();return owned.openSyncUpdate(context,wire);},
    };
    let storage:BrowserSync;
    try{storage=this.host.storage.bindSession(assert);}catch(error){transport.close();free();return Promise.reject(this.sanitize(error));}
    const session={storage,transport,key,free,assert,scope,epoch,rpc,ready:Promise.resolve()};
    this.session=session;
    const enroll=input.enrollEmpty===true;
    session.ready=this.host.local(async()=>{
      assert();
      if(enroll)await storage.enroll(scope);
      const inspected=await storage.inspect();assert();
      if(!inspected.scope || inspected.scope.realm_id!==scope.realm_id||inspected.scope.vault_id!==scope.vault_id||inspected.scope.key_epoch!==scope.key_epoch)
        throw failure('sync_scope_conflict');
      if(inspected.cursor && inspected.cursor.server_epoch!==epoch)throw failure('sync_epoch_mismatch');
      if(!inspected.cursor)await storage.setCursor({realm_id:scope.realm_id,vault_id:scope.vault_id,server_epoch:epoch,after:'0'},null);
      assert();
    }).catch(error=>{if(this.session===session)this.revoke();throw this.sanitize(error);});
    return session.ready;
  }
  once():Promise<BrowserSyncSweep> {
    const session=this.session;
    if(!session)return Promise.reject(failure('sync_not_configured'));
    if(session.active)return session.active;
    session.active=this.sweep(session).catch(error=>{throw this.sanitize(error);}).finally(()=>{session.active=undefined;});
    return session.active;
  }
  private sanitize(error:unknown):BrowserVaultError {
    if(error instanceof BrowserSyncTransportError)return failure(error.code);
    if(error instanceof BrowserVaultError){
      if(['storage_closed','storage_corrupt','client_ownership_lost'].includes(error.code)){this.revoke();this.host.fatal(error.code);}
      return failure(error.code);
    }
    return failure('sync_protocol_rejected');
  }
  private async sweep(session:NonNullable<BrowserSyncWorker['session']>):Promise<BrowserSyncSweep> {
    await session.ready;session.assert();
    const {storage,transport,key,scope,epoch,rpc}=session;
    const local=<T>(operation:()=>Promise<T>)=>{const guarded=async()=>{session.assert();const value=await operation();session.assert();return value;};return storage.concurrentPreparation===true?guarded():this.host.local(guarded);};
    const result:BrowserSyncSweep={uploaded:0,received:0,complete:false};
    const deadline=Date.now()+30_000;
    const hello=await transport.hello();session.assert();
    if(rpc)this.host.wasm.validateRpcHello!(hello,scope.realm_id,epoch);
    else this.host.wasm.decodeSyncHello(json({realm_id:scope.realm_id,server_epoch:epoch}),hello);
    const pending=await local(()=>storage.pending(64));
    for(const item of pending) {
      if(Date.now()>=deadline)return result;
      const updateId=item.metadata.key.update_id;
      const wire=await local(()=>storage.seal(updateId,key));session.assert();
      const raw=await transport.upload(updateId,wire);session.assert();
      if(rpc)this.host.wasm.validateRpcAccepted!(raw,scope.vault_id,updateId,epoch);
      else this.host.wasm.decodeSyncAccepted(json({vault_id:scope.vault_id,update_id:updateId,server_epoch:epoch}),raw);
      await local(()=>storage.acknowledge(updateId,wire));result.uploaded++;
    }
    let cursor=(await local(()=>storage.inspect())).cursor;
    if(!cursor || cursor.server_epoch!==epoch)throw failure('sync_epoch_mismatch');
    let through:string|undefined;
    for(let pageNumber=0;pageNumber<16&&Date.now()<deadline;pageNumber++) {
      const raw=await transport.pull(this.host.wasm.encodeSyncCursor(json({server_epoch:epoch,after:cursor.after})),through);session.assert();
      let page:BrowserRpcPage;
      if(rpc)page=this.host.wasm.openRpcPage!(raw,epoch,cursor.after,through);
      else {
        // The HTTP1 reference decoder returns bounded validated Rust JSON.
        const decoded=JSON.parse(this.host.wasm.decodeSyncPage(json({server_epoch:epoch,after:cursor.after,through:through??null}),raw)) as
          {items:{sequence:string;wire:number[]}[];through:string;complete:boolean};
        page={through:()=>decoded.through,complete:()=>decoded.complete,length:()=>decoded.items.length,
          sequence:index=>decoded.items[index].sequence,wire:index=>new Uint8Array(decoded.items[index].wire),free:()=>{}};
      }
      try {
        through=page.through();
        for(let index=0;index<page.length();index++) {
          session.assert();
          const wire=page.wire(index),updateId=this.host.wasm.syncEnvelopeUpdateId(wire);
          const next:SyncCursor={realm_id:scope.realm_id,vault_id:scope.vault_id,server_epoch:epoch,after:page.sequence(index)};
          const expected=cursor;
          await local(async()=>{
            await storage.receive(updateId,wire,key,{expected,next});
            session.assert();await this.host.changed(session.assert);
          });
          cursor=next;result.received++;
        }
        if(page.complete()){result.complete=(await local(()=>storage.pending(1))).length===0;return result;}
      }finally{page.free();}
    }
    return result;
  }
}
