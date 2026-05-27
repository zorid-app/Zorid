import { access, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeVaultPath } from '../packages/shared/src/index';
import { createVaultService } from '../packages/vault/src/index';

describe('desktop bridge vault boundary model', () => {
  it('rejects absolute/traversal renderer paths before vault resolution', () => {
    expect(() => normalizeVaultPath('../secrets.txt')).toThrow(/inside the vault/);
    expect(() => normalizeVaultPath('/../secrets.txt')).toThrow(/inside the vault/);
  });

  it('uses FolderVault resolution as the only filesystem boundary', () => {
    const vault = createVaultService('/tmp/vault');
    expect(vault.resolve(normalizeVaultPath('Notes/A.md'))).toContain('/tmp/vault/Notes/A.md');
  });

  it('rejects symlink escapes for reads and writes without creating outside directories', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'zorid-vault-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'zorid-outside-'));
    try {
      await writeFile(path.join(outside, 'secret.md'), 'secret', 'utf8');
      await symlink(outside, path.join(root, 'linked-outside'));
      const vault = createVaultService(root);
      await expect(vault.read(normalizeVaultPath('linked-outside/secret.md'))).rejects.toThrow(/symlink/);
      await expect(vault.write(normalizeVaultPath('linked-outside/new.md'), 'nope')).rejects.toThrow(/symlink/);
      await expect(vault.write(normalizeVaultPath('linked-outside/subdir/new.md'), 'nope')).rejects.toThrow(/symlink/);
      await expect(access(path.join(outside, 'subdir'))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects dangling symlink writes without creating the outside target', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'zorid-vault-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'zorid-outside-'));
    const outsideTarget = path.join(outside, 'created-by-symlink.md');
    try {
      await symlink(outsideTarget, path.join(root, 'dangling.md'));
      const vault = createVaultService(root);
      await expect(vault.write(normalizeVaultPath('dangling.md'), 'escaped')).rejects.toThrow(/symlink/);
      await expect(access(outsideTarget)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
