import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeVaultPath } from '../packages/shared/src/index';
import { createVaultService } from '../packages/vault/src/index';
import { createWorkspaceService } from '../packages/workspace/src/index';
import { EditorService } from '../packages/editor/src/index';
import { createDesktopShellState, withActiveTab } from '../packages/desktop-shell/src/index';

async function tempVault() { return mkdtemp(path.join(tmpdir(), 'zorid-vault-')); }

describe('desktop vault/editor/workspace slice', () => {
  it('creates, opens, edits, and saves markdown through vault/editor services', async () => {
    const root = await tempVault();
    try {
      const vault = createVaultService(root);
      const note = normalizeVaultPath('Notes/Test.md');
      await vault.write(note, '# Hello');
      expect(await vault.read(note)).toBe('# Hello');
      const editor = new EditorService(vault);
      const handle = await editor.open(note);
      handle.setText('# Hello\n\nEdited');
      expect(handle.isDirty()).toBe(true);
      await editor.save(handle);
      expect(handle.isDirty()).toBe(false);
      expect(await vault.read(note)).toContain('Edited');
      expect((await vault.list(normalizeVaultPath('Notes')))[0]?.path).toBe(note);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('opens files, splits panes, snapshots, and restores workspace state', async () => {
    const workspace = createWorkspaceService();
    const pathA = normalizeVaultPath('A.md');
    await workspace.openFile(pathA);
    const split = await workspace.split('vertical');
    await workspace.openFile(normalizeVaultPath('B.md'), { paneId: split });
    const snapshot = workspace.snapshot();
    const restored = createWorkspaceService();
    restored.restore(snapshot);
    expect(restored.snapshot().panes).toHaveLength(2);
    expect(restored.activeFile()).toBe(normalizeVaultPath('B.md'));
  });

  it('tracks desktop shell tabs without exposing shell internals to plugins', () => {
    const state = withActiveTab(createDesktopShellState(), normalizeVaultPath('Notes/Test.md'));
    expect(state.openTabs).toEqual(['Notes/Test.md']);
    expect(state.activePath).toBe('Notes/Test.md');
  });
});
