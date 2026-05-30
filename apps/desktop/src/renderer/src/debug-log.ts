export type RendererDebugLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RendererDebugLogEntry {
  readonly level: RendererDebugLogLevel;
  readonly scope: string;
  readonly message: string;
  readonly data?: unknown;
}

export type SaveRendererDebugLog = (entry: RendererDebugLogEntry) => Promise<unknown>;

function serializeDebugData(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (value instanceof Event) {
    return {
      type: value.type,
      target: value.target instanceof Element ? value.target.tagName : undefined,
    };
  }
  return value;
}

export function createRendererDebugLogger(save: SaveRendererDebugLog, defaults: { readonly scope: string }) {
  return (entry: Omit<RendererDebugLogEntry, 'scope'> & { readonly scope?: string }) => {
    void save({
      level: entry.level,
      scope: entry.scope ?? defaults.scope,
      message: entry.message,
      ...(entry.data === undefined ? {} : { data: serializeDebugData(entry.data) }),
    }).catch((error: unknown) => {
      console.error('Failed to save Zorid debug log entry.', error);
    });
  };
}

export function installRendererDebugLogging(save: SaveRendererDebugLog): () => void {
  const log = createRendererDebugLogger(save, { scope: 'renderer' });
  const onError = (event: ErrorEvent) => {
    log({
      level: 'error',
      scope: 'renderer.window',
      message: event.message || 'Unhandled renderer error',
      data: event.error,
    });
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    log({
      level: 'error',
      scope: 'renderer.promise',
      message: 'Unhandled renderer promise rejection',
      data: event.reason,
    });
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onUnhandledRejection);
  };
}
