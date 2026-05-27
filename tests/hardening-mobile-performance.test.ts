import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { computeVirtualWindow } from '../packages/ui-vue/src/index';
import { createMobileShellState, openMobileSheet } from '../packages/mobile-shell/src/index';
import { capacitorAppId } from '../apps/mobile/src/index';

const execFileAsync = promisify(execFile);

describe('hardening/mobile/performance docs', () => {
  it('has a mobile skeleton without claiming mobile parity', async () => {
    const config = JSON.parse(await readFile('apps/mobile/capacitor.config.json', 'utf8')) as { appId: string };
    expect(config.appId).toBe(capacitorAppId);
    expect(openMobileSheet(createMobileShellState(), 'settings').sheets).toEqual(['settings']);
  });

  it('computes a virtual window for large lists', () => {
    expect(computeVirtualWindow({ itemCount: 10000, itemHeight: 20, viewportHeight: 100, scrollTop: 200 })).toMatchObject({ start: 5, end: 20, totalHeight: 200000 });
  });

  it('passes performance smoke budget and records JSON evidence', async () => {
    const { stdout } = await execFileAsync('node', ['scripts/perf-smoke.mjs']);
    const report = JSON.parse(stdout) as { durationMs: number; budgetMs: number };
    expect(report.durationMs).toBeLessThanOrEqual(report.budgetMs);
  });
});
