import fs from 'node:fs/promises';
import path from 'node:path';

export type DesktopDebugLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface DesktopDebugLogEntry {
  readonly level: DesktopDebugLogLevel;
  readonly scope: string;
  readonly message: string;
  readonly timestamp?: string;
  readonly data?: unknown;
}

export function desktopDebugLogPath(logsRoot: string): string {
  return path.join(logsRoot, 'zorid-debug.jsonl');
}

function jsonSafeData(data: unknown): unknown {
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(data, (_key, value: unknown) => {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
    if (typeof value === 'symbol') return value.toString();
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  });
  return serialized === undefined ? String(data) : JSON.parse(serialized);
}

export function normalizeDebugLogEntry(entry: DesktopDebugLogEntry): DesktopDebugLogEntry {
  return {
    level: entry.level,
    scope: entry.scope,
    message: entry.message,
    timestamp: entry.timestamp ?? new Date().toISOString(),
    ...(entry.data === undefined ? {} : { data: jsonSafeData(entry.data) }),
  };
}

export async function appendDesktopDebugLog(logsRoot: string, entry: DesktopDebugLogEntry): Promise<string> {
  const logPath = desktopDebugLogPath(logsRoot);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `${JSON.stringify(normalizeDebugLogEntry(entry))}\n`, 'utf8');
  return logPath;
}
