import { openNativeMobileVault } from './mobile-native.ts';
import type { NativeVaultPlugin } from './mobile-native.ts';
import type { PlatformVault } from './index.ts';

/** Prototype-only native Tauri bindings. Rust chooses all filesystem/data roots. */
interface NativeTauriAPI {
  core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
  event: { listen<T>(event: string, callback: (event: { payload: T }) => void): Promise<() => void> };
}
interface NativeBenchmarkTap {
  getVault(): Promise<{ path: string; name: string; reconciliation?: unknown }>;
  list(opaqueVault: string): ReturnType<PlatformVault['adapter']['list']>;
  read(opaqueVault: string, path: string): Promise<string>;
}
type NativeTauriWindow = Window & {
  __ZORID_TAURI__?: boolean;
  __TAURI__?: NativeTauriAPI;
  __ZORID_NATIVE_BENCH_ENABLED__?: boolean;
  __ZORID_NATIVE_BENCH__?: Readonly<NativeBenchmarkTap>;
};

/**
 * Reuse the shared leased native data adapter with the full desktop workspace.
 * This changes the native host/transport, not Markdown or durable-save semantics.
 * Desktop draft/work/Base-preview capabilities are not advertised by this adapter.
 */
export async function openTauriNativeVault(): Promise<PlatformVault> {
  const nativeWindow = window as NativeTauriWindow;
  const native = nativeWindow.__TAURI__;
  if (nativeWindow.__ZORID_TAURI__ !== true || !native?.core?.invoke || !native.event?.listen)
    throw new Error('The embedded Tauri host is unavailable.');

  const invoke = <T>(command: string, args?: Record<string, unknown>): Promise<T> =>
    native.core.invoke<T>(command, args);
  const plugin: NativeVaultPlugin = {
    context: () => invoke('tauri_context'),
    refresh: () => invoke('tauri_refresh'),
    request: input => invoke('tauri_request', { input }),
    addListener: async (event: string, callback: (input: any) => void) => {
      // The native adapter always installs lifecycle delivery before admission.
      // Other presentation/navigation listeners are only used when advertised.
      const name = event === 'lifecycleRequest' ? 'tauri:lifecycle' : `tauri:${event}`;
      const stop = await native.event.listen<unknown>(name, event => callback(event.payload));
      return { remove: async () => { stop(); } };
    },
    lifecycleAck: input => invoke('tauri_lifecycle_ack', { input }),
    // This shell has no separate native Recents or mobile formatting toolbar.
    // These presentation-only callbacks do not mutate data or claim a capability.
    noteOpened: async () => {},
    editorState: async () => {},
  };
  const admitted = await openNativeMobileVault(plugin);
  const {
    editorOnly: _editorOnly,
    nativeEditor: _nativeEditor,
    nativeDocumentNavigation: _nativeDocumentNavigation,
    nativeWebRouting: _nativeWebRouting,
    ...platform
  } = admitted;
  // Retain mobileLifecycle: the existing workspace flushes notes/session before
  // switchVault ACK. Native then releases the exact lease and drops the host on
  // its serial worker. A failed/early ACK leaves the actual window open.
  await invoke('tauri_lifecycle_ready');

  if (nativeWindow.__ZORID_NATIVE_BENCH_ENABLED__ === true) {
    nativeWindow.__ZORID_NATIVE_BENCH__ = Object.freeze({
      getVault: async () => ({ path: 'native-fixture', name: platform.label,
        ...(platform.reconciliation ? { reconciliation: platform.reconciliation.getStatus() } : {}) }),
      list: (_opaqueVault: string) => platform.adapter.list(),
      read: (_opaqueVault: string, path: string) => platform.adapter.read(path),
    });
  }
  return platform;
}
