import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('desktop editor startup-only vault actions', () => {
  it('keeps vault-opening affordances on the launcher instead of the editor shell', async () => {
    const source = await readFile('apps/desktop/src/renderer/src/App.vue', 'utf8');

    expect(source).not.toContain('@click="openVault"');
    expect(source).not.toContain('async function openVault');
    expect(source).not.toContain('Open a vault, then select');
    expect(source).toContain("'vault.open'");
    expect(source).toContain("'file-explorer.open-root'");
    expect(source).toContain('editorStartupOnlyCommandIds');
  });
});
