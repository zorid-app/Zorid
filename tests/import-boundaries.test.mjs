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

  it('allows core plugins to use the blessed plugin-ui authoring package', () => {
    expect(isImportAllowed('@zorid/plugin-data-views', '@zorid/plugin-ui')).toBe(true);
    expect(isImportAllowed('@zorid/platform-api', '@zorid/plugin-ui')).toBe(false);
  });

  it('allows only the desktop trusted renderer loader to import the first-party data-views renderer', () => {
    expect(isImportAllowed('@zorid/desktop-app', '@zorid/plugin-data-views/file-renderers')).toBe(true);
    expect(isImportAllowed('@zorid/desktop-app', '@zorid/plugin-data-views')).toBe(false);
    expect(isImportAllowed('@zorid/mobile-app', '@zorid/plugin-data-views')).toBe(false);
    expect(isImportAllowed('@zorid/mobile-app', '@zorid/plugin-data-views/file-renderers')).toBe(false);
  });

  it('keeps current workspace boundary-clean', () => {
    expect(checkWorkspace()).toEqual([]);
  });
});
