import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendDesktopDebugLog, desktopDebugLogPath, normalizeDebugLogEntry } from '../apps/desktop/src/main/debug-log';

describe('desktop debug log helper', () => {
  it('normalizes debug entries with timestamps and circular-safe data', () => {
    const data: { self?: unknown; count: bigint } = { count: 1n };
    data.self = data;

    const entry = normalizeDebugLogEntry({ level: 'error', scope: 'test.scope', message: 'boom', data });

    expect(entry.timestamp).toEqual(expect.any(String));
    expect(entry.data).toEqual({ count: '1', self: '[Circular]' });
  });

  it('appends JSONL debug entries under the Electron logs root', async () => {
    const logsRoot = await mkdtemp(path.join(os.tmpdir(), 'zorid-debug-log-'));
    try {
      const logPath = await appendDesktopDebugLog(logsRoot, {
        level: 'warn',
        scope: 'test',
        message: 'saved',
        timestamp: '2026-05-30T00:00:00.000Z',
      });

      expect(logPath).toBe(desktopDebugLogPath(logsRoot));
      expect(await readFile(logPath, 'utf8')).toBe(
        '{"level":"warn","scope":"test","message":"saved","timestamp":"2026-05-30T00:00:00.000Z"}\n',
      );
    } finally {
      await rm(logsRoot, { recursive: true, force: true });
    }
  });
});
