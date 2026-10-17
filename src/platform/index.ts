import {createDesktopBinaryStreams} from './desktop.ts';
import {createDesktopDocumentService} from './desktop-document-semantics.ts';
import type {DocumentService} from '../core/document-semantics.ts';
import type { DurableWrites } from '../core/durable-writes.ts';
import type { VaultAdapter } from '../core/types';
import type { DesktopBridge, DesktopVault, DesktopReconciliation } from './bridge';

export interface PlatformVault {
  readonly documentSemantics?:DocumentService;
  /** Presentation bridge only; native controls execute shared editor commands. */
  nativeEditor?: {
    setState(state:import('../ui/editor.ts').NativeEditorState):Promise<void>;
    subscribe(handler:(action:import('../ui/editor.ts').NativeEditorAction)=>void|Promise<void>,onStateRequest?:()=>void|Promise<void>):()=>void;
  };
  /** Native navigation owns the surrounding chrome; embed document content only. */
  editorOnly?: boolean;
  /** Native New note intent, applied once after durable admission/recovery. */
  createNoteOnOpen?: boolean;
  /** Native page selection, admitted together; paths alone do not identify a note. */
  initialPath?: string;
  initialEntryId?: string;
  /** Presentation history only; rejection must not fail editing or saving. */
  noteOpened?(path:string,entryId:string):Promise<void>;
  /** Reveal ready content or actionable UI; password/error never acknowledge a successful open. */
  presentationSettled?(input:{path:string;entryId:string;state:'ready'|'password'|'error'}):Promise<void>;
  mobileLifecycle?:import('./mobile-native.ts').MobileLifecycle; adapter: VaultAdapter; label: string; id: string; /** Await final consumer checkpoint/flush before release. */ release?(): Promise<void>; recoverCommands?():Promise<boolean>; legacyExport?():void; reconciliation?: {getStatus():DesktopReconciliation|null;subscribe(listener:(status:DesktopReconciliation)=>void):()=>void;retry():Promise<void>} }
async function desktopVault(bridge: DesktopBridge, info: DesktopVault): Promise<PlatformVault> {
  let reconciliationStatus=info.reconciliation??null;
  const reconciliation=info.reconciliation&&bridge.retryReconciliation?{
    getStatus:()=>reconciliationStatus,
    subscribe:(listener:(status:DesktopReconciliation)=>void)=>{
      let changed=false,disposed=false;
      const stop=bridge.onChange(change=>{
        if(change.vault===info.path&&change.reconciliation){changed=true;reconciliationStatus=change.reconciliation;listener(change.reconciliation);}
      });
      // Catch a scan that finished between getVault and this subscription.
      void bridge.getVault().then(latest=>{if(!disposed&&!changed&&latest?.path===info.path&&latest.reconciliation){reconciliationStatus=latest.reconciliation;listener(latest.reconciliation);}}).catch(()=>{});
      return ()=>{disposed=true;stop();};
    },
    retry:async()=>{reconciliationStatus=await bridge.retryReconciliation!(info.path);},
  }:undefined;
  const binding = await bridge.getDurableContext?.(info.path);
  let durableWrites: DurableWrites | undefined;
  let release: (() => Promise<void>) | undefined;
  let createText: ((path:string,content:string)=>Promise<void>) | undefined;
  let commands:Partial<VaultAdapter>={};
  let binary:ReturnType<typeof createDesktopBinaryStreams>|undefined;
  let documents:ReturnType<typeof createDesktopDocumentService>|undefined;
  if (binding) {
    if (!bridge.durableInvoke || !bridge.releaseDurableContext || !binding.admissionId || !binding.scope?.vaultId || !binding.scope.clientId) throw new Error('Incomplete durable desktop capability');
    const invoke = bridge.durableInvoke.bind(bridge), releaseContext = bridge.releaseDurableContext.bind(bridge);
    const admissionId = binding.admissionId, scope = Object.freeze({...binding.scope});
    let released = false;
    const call = <T>(method: string, ...args: unknown[]): Promise<T> => {
      if (released) return Promise.reject(Object.assign(new Error('Durable desktop context released'), {code:'client_not_admitted',source:'host'}));
      return invoke(info.path, admissionId, method, args) as Promise<T>;
    };
    type Input={kind:string;path:string;content?:string;expectedContent?:string;expectedEntryId?:string;expectedRevision?:string;data?:Uint8Array;destination?:string;force?:boolean};
    const pending=new Map<string,Input&{operationId:string;entryId:string}>();
    const execute=async(input:Input):Promise<void>=>{
      const key=`${input.kind}:${input.path}`, prior=pending.get(key);
      const same=(a:Input,b:Input)=>a.kind===b.kind&&a.path===b.path&&a.content===b.content&&a.expectedContent===b.expectedContent&&a.expectedEntryId===b.expectedEntryId&&a.expectedRevision===b.expectedRevision&&a.destination===b.destination&&a.force===b.force&&
        (!a.data&&!b.data||!!a.data&&!!b.data&&a.data.length===b.data.length&&a.data.every((byte,i)=>byte===b.data![i]));
      if(prior&&!same(prior,input))throw new Error('A different file operation is still pending for this path');
      const request=prior??{...input,...(input.data?{data:new Uint8Array(input.data)}:{}),operationId:crypto.randomUUID(),entryId:crypto.randomUUID()};
      pending.set(key,request);
      try{await call<void>('fileCommand',request);if(pending.get(key)===request)pending.delete(key);}
      catch(error){if(error&&typeof error==='object'&&'code'in error&&['invalid_request','not_found','revision_conflict','idempotency_conflict'].includes(String(error.code))&&(!('commitUncertain'in error)||!error.commitUncertain)&&pending.get(key)===request)pending.delete(key);throw error;}
    };
    createText=(path,content)=>execute({kind:'createText',path,content});
    commands={durableNamespace:true,
      write:(path,content)=>execute({kind:'writeText',path,content}),
      compareAndWrite:(path,expectedContent,content,expectedIdentity)=>execute({kind:'writeText',path,expectedContent,content,...(expectedIdentity?{expectedEntryId:expectedIdentity.entryId,expectedRevision:expectedIdentity.revision}:{})}),
      createBinary:(path,data)=>execute({kind:'createBinary',path,data}),
      writeBinary:(path,data)=>execute({kind:'writeBinary',path,data}),
      mkdir:path=>execute({kind:'mkdir',path}),rename:(path,destination)=>execute({kind:'move',path,destination}),
      trash:path=>execute({kind:'trash',path}),remove:(path,force)=>execute({kind:'delete',path,force}),
    };
    durableWrites = Object.freeze<DurableWrites>({
      readText: path => call('readText',path), readTextById: id => call('readTextById',id),
      planWrite: input => call('planWrite',input), prepare: plan => call('prepare',plan),
      commit: ref => call('commit',ref), query: ref => call('query',ref),
      listUnacknowledged: () => call('listUnacknowledged'), acknowledge: (ref,outcome) => call('acknowledge',ref,outcome),
      checkpoints: Object.freeze<DurableWrites['checkpoints']>({scope,load: key => call('checkpoints.load',key),
        compareAndSwap: change => call('checkpoints.compareAndSwap',change),
        list: options => call('checkpoints.list',options), changes: options => call('checkpoints.changes',options)}),
    });
    let binaryDrained=false,documentsDrained=false;
    if(binding.documentSemantics)documents=createDesktopDocumentService(request=>call('documentCommand',request));
    if(binding.binaryLimits)binary=createDesktopBinaryStreams({scope,checkpoints:durableWrites.checkpoints,limits:binding.binaryLimits,assertActive:()=>{if(released||binaryDrained)throw new Error('Desktop binary context released');},invoke:bytes=>call<Uint8Array>('binaryCommand',bytes)});
    release = async () => { if (!released) { if(binary&&!binaryDrained){await binary.release();binaryDrained=true;} if(documents&&!documentsDrained){await documents.release();documentsDrained=true;} await releaseContext(info.path, admissionId); released = true; } };
  }
  return {
    ...(release ? {release} : {}),
    ...(documents?{documentSemantics:documents.service}:{}),
    ...(reconciliation?{reconciliation}:{}),
    ...(binary?{recoverCommands:()=>binary!.recover()}:{}),
    id: durableWrites ? `desktop-core:${durableWrites.checkpoints.scope.vaultId}:${durableWrites.checkpoints.scope.clientId}` : `desktop:${info.path}`,
    label: info.name,
    adapter: {
      ...(durableWrites ? {durableWrites} : {}),
      ...(documents?{documentSemantics:documents.service}:{}),
      ...(binary ? {binaryStreams:binary.streams} : {}),
      ...(createText ? {createText} : {}),
      list: () => bridge.list(info.path),
      stat: path => bridge.stat(info.path, path),
      read: path => bridge.read(info.path, path),
      readBinary: path => bridge.readBinary(info.path, path),
      write: (path, data) => bridge.write(info.path, path, data),
      ...(bridge.compareAndWrite ? { compareAndWrite: (path: string, expectedContent: string, contents: string) => bridge.compareAndWrite!(info.path, path, expectedContent, contents) } : {}),
      writeBinary: (path, data) => bridge.writeBinary(info.path, path, data),
      mkdir: path => bridge.mkdir(info.path, path),
      rename: (from, to) => bridge.rename(info.path, from, to),
      trash: path => bridge.trash(info.path, path),
      ...(bridge.remove ? { remove: (path: string, force: boolean) => bridge.remove!(info.path, path, force) } : {}),
      ...commands,
      subscribe: listener => bridge.onChange(change => { if (!change.vault || change.vault === info.path) listener(change.path ? [change.path] : undefined); }),
    },
  };
}

export async function pickDesktopVault(): Promise<PlatformVault | null> {
  const bridge = window.zorid;
  if (!bridge) return null;
  const info = await bridge.openVault();
  return info ? desktopVault(bridge, info) : null;
}

export async function createPlatformAdapter(): Promise<PlatformVault | null> {
  if (window.zorid) {
    const info = await window.zorid.getVault();
    return info ? desktopVault(window.zorid, info) : null;
  }
  const { Capacitor } = await import('@capacitor/core');
  if (Capacitor.isNativePlatform()) {
    if (Capacitor.getPlatform() === 'ios') {
      const { openNativeMobileVault } = await import('./mobile-native.ts');
      return openNativeMobileVault();
    }
    // Android retains its current adapter until the native/JNI binding is ready.
    const { MobileAdapter } = await import('./mobile');
    const adapter = new MobileAdapter();
    await adapter.initialize();
    return { adapter, label: 'Zorid', id: 'mobile:documents:Zorid' };
  }
  if (typeof __ZORID_CORE_FIXTURES__ !== 'undefined' && __ZORID_CORE_FIXTURES__) {
    const { browserCoreFixtureConfig, openBrowserCoreFixture } = await import('./browser-core-fixture');
    const config = browserCoreFixtureConfig(true, new URL(window.location.href), __ZORID_CORE_BUILD_ID__);
    if (config) return openBrowserCoreFixture(config);
  }
  const { openDefaultBrowserVault } = await import('./browser-default.ts');
  return openDefaultBrowserVault();
}
