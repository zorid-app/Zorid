import { describe, expect, it } from 'vitest';
import { checkWorkspace, isImportAllowed } from '../scripts/check-import-boundaries.mjs';

describe('import boundary rules', () => {
  it('rejects forbidden platform-to-shell imports', () => {
    expect(isImportAllowed('@zorid/platform-api', '@zorid/desktop-shell')).toBe(false);
  });

  it('allows plugin-api to depend only on contracts/shared packages', () => {
    expect(isImportAllowed('@zorid/plugin-api', '@zorid/platform-api')).toBe(true);
    expect(isImportAllowed('@zorid/plugin-api', '@zorid/shared')).toBe(true);
    expect(isImportAllowed('@zorid/plugin-api', '@zorid/app-kernel')).toBe(false);
  });

  it('keeps current workspace boundary-clean', () => {
    expect(checkWorkspace()).toEqual([]);
  });
});
