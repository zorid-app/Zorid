import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { apiInfoFixture, capabilityNames } from '../packages/platform-api/src/index';

const sourceExtensions = new Set(['.ts', '.tsx', '.vue']);
const ignoredDirectories = new Set(['node_modules', 'dist', 'out', '.git', '.omx', 'coverage']);

function listSourceFiles(root: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(root)) {
    if (ignoredDirectories.has(entry)) continue;
    const fullPath = path.join(root, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...listSourceFiles(fullPath));
      continue;
    }
    if (sourceExtensions.has(path.extname(entry))) results.push(fullPath);
  }
  return results;
}

describe('shared UI behavior boundaries', () => {
  it('keeps direct reka-ui imports inside packages/ui-vue/src only', () => {
    const offenders = listSourceFiles('.').filter((filePath) => {
      const source = readFileSync(filePath, 'utf8');
      if (!/from ['"]reka-ui['"]|import\(['"]reka-ui['"]\)/.test(source)) return false;
      return !filePath.startsWith(`packages${path.sep}ui-vue${path.sep}src${path.sep}`);
    });

    expect(offenders).toEqual([]);
  });

  it('does not add plugin-facing UI/dialog API surface in this pass', () => {
    expect(apiInfoFixture.namespaces).not.toHaveProperty('ui');
    expect(apiInfoFixture.namespaces).not.toHaveProperty('dialog');
    expect(capabilityNames).not.toContain('ui.dialog' as never);
    expect(capabilityNames).not.toContain('ui.components' as never);
  });
});
