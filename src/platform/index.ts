import type { VaultAdapter } from '../core/types';
import type { DesktopBridge, DesktopVault } from './bridge';

export interface PlatformVault { adapter: VaultAdapter; label: string; id: string }
function desktopVault(bridge: DesktopBridge, info: DesktopVault): PlatformVault {
  return {
    id: `desktop:${info.path}`,
    label: info.name,
    adapter: {
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
