import type { DurableWrites } from '../core/durable-writes.ts';
import type { VaultAdapter } from '../core/types';
import type { DesktopBridge, DesktopVault } from './bridge';

export interface PlatformVault { adapter: VaultAdapter; label: string; id: string; /** Await final consumer checkpoint/flush before release. */ release?(): Promise<void> }
async function desktopVault(bridge: DesktopBridge, info: DesktopVault): Promise<PlatformVault> {
  const binding = await bridge.getDurableContext?.(info.path);
  let durableWrites: DurableWrites | undefined;
  let release: (() => Promise<void>) | undefined;
  let createText: ((path:string,content:string)=>Promise<void>) | undefined;
  if (binding) {
    if (!bridge.durableInvoke || !bridge.releaseDurableContext || !binding.admissionId || !binding.scope?.vaultId || !binding.scope.clientId) throw new Error('Incomplete durable desktop capability');
    const invoke = bridge.durableInvoke.bind(bridge), releaseContext = bridge.releaseDurableContext.bind(bridge);
    const admissionId = binding.admissionId, scope = Object.freeze({...binding.scope});
    let released = false;
    const call = <T>(method: string, ...args: unknown[]): Promise<T> => {
      if (released) return Promise.reject(Object.assign(new Error('Durable desktop context released'), {code:'client_not_admitted',source:'host'}));
      return invoke(info.path, admissionId, method, args) as Promise<T>;
    };
    const pendingCreates=new Map<string,{operationId:string;entryId:string;path:string;content:string}>();
    createText=async(path,content)=>{
      let request=pendingCreates.get(path);
      if(request&&request.content!==content)throw new Error('A different create is still pending for this path');
      if(!request){request={operationId:crypto.randomUUID(),entryId:crypto.randomUUID(),path,content};pendingCreates.set(path,request);}
      await call<void>('createText',request);pendingCreates.delete(path);
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
    release = async () => { if (!released) { await releaseContext(info.path, admissionId); released = true; } };
  }
  return {
    ...(release ? {release} : {}),
    id: durableWrites ? `desktop-core:${durableWrites.checkpoints.scope.vaultId}:${durableWrites.checkpoints.scope.clientId}` : `desktop:${info.path}`,
    label: info.name,
    adapter: {
      ...(durableWrites ? {durableWrites} : {}),
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
  const { BrowserAdapter } = await import('./browser');
  return { adapter: new BrowserAdapter(), label: 'Browser vault', id: 'browser:default' };
}
