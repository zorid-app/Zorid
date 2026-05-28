import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const temporaryRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zorid-recents-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('RecentVaultStore', () => {
  it('stores full normalized paths behind opaque ids and keeps newest vault first', async () => {
    const { RecentVaultStore } = await import('../apps/desktop/src/main/recent-vaults');
    const userData = await makeTempRoot();
    const firstVault = await makeTempRoot();
    const secondVault = await makeTempRoot();
    let tick = 0;
    const store = new RecentVaultStore(path.join(userData, 'recent-vaults.json'), {
      now: () => new Date(Date.UTC(2026, 4, 28, 0, tick++)),
    });

    const first = await store.record(firstVault);
    const second = await store.record(secondVault);
    const reopenedFirst = await store.record(firstVault);

    expect(first.id).toMatch(/^recent:[a-f0-9]{20}$/);
    expect(first.id).not.toContain(firstVault);
    expect(second.id).not.toBe(first.id);
    expect(reopenedFirst.id).toBe(first.id);
    await expect(store.list()).resolves.toMatchObject([
      { id: first.id, path: await fs.realpath(firstVault), name: path.basename(firstVault) },
      { id: second.id, path: await fs.realpath(secondVault), name: path.basename(secondVault) },
    ]);

    const raw = JSON.parse(await fs.readFile(path.join(userData, 'recent-vaults.json'), 'utf8')) as {
      entries: Array<{ normalizedPath: string }>;
    };
    expect(raw.entries.map((entry) => entry.normalizedPath)).toEqual([
      await fs.realpath(firstVault),
      await fs.realpath(secondVault),
    ]);
  });

  it('resolves only known opaque ids', async () => {
    const { RecentVaultStore } = await import('../apps/desktop/src/main/recent-vaults');
    const userData = await makeTempRoot();
    const vaultRoot = await makeTempRoot();
    const store = new RecentVaultStore(path.join(userData, 'recent-vaults.json'));

    const recent = await store.record(vaultRoot);

    await expect(store.resolve(recent.id)).resolves.toBe(await fs.realpath(vaultRoot));
    await expect(store.resolve(vaultRoot)).resolves.toBeUndefined();
    await expect(store.resolve('recent:missing')).resolves.toBeUndefined();
  });

  it('recovers from corrupt stores and trims to the configured maximum', async () => {
    const { RecentVaultStore } = await import('../apps/desktop/src/main/recent-vaults');
    const userData = await makeTempRoot();
    const storePath = path.join(userData, 'recent-vaults.json');
    await fs.mkdir(userData, { recursive: true });
    await fs.writeFile(storePath, '{not json', 'utf8');
    const store = new RecentVaultStore(storePath, { maxEntries: 2 });
    const roots = [await makeTempRoot(), await makeTempRoot(), await makeTempRoot()];

    await expect(store.list()).resolves.toEqual([]);
    for (const root of roots) await store.record(root);

    const recent = await store.list();
    expect(recent).toHaveLength(2);
    expect(recent.map((entry) => entry.path)).toEqual([await fs.realpath(roots[2]!), await fs.realpath(roots[1]!)]);
  });

  it('serializes concurrent recent writes without temp-file collisions or lost entries', async () => {
    const { RecentVaultStore } = await import('../apps/desktop/src/main/recent-vaults');
    const userData = await makeTempRoot();
    const roots = [await makeTempRoot(), await makeTempRoot(), await makeTempRoot(), await makeTempRoot()];
    const store = new RecentVaultStore(path.join(userData, 'recent-vaults.json'));

    await Promise.all(roots.map((root) => store.record(root)));

    const recent = await store.list();
    expect(recent).toHaveLength(4);
    expect(new Set(recent.map((entry) => entry.id)).size).toBe(4);
    expect(new Set(recent.map((entry) => entry.path))).toEqual(
      new Set(await Promise.all(roots.map((root) => fs.realpath(root)))),
    );
  });

  it('opens recents through main-owned opaque id resolution only', async () => {
    const { openRecentVault } = await import('../apps/desktop/src/main/recent-vaults');
    const profile = { id: 'folder:resolved', kind: 'folder' as const, rootLabel: 'Resolved' };
    const runtime = { openVault: vi.fn(async () => profile) };
    const store = {
      resolve: vi.fn(async (id: string) => (id === 'recent:known' ? '/resolved/Vault' : undefined)),
      record: vi.fn(async () => ({
        id: 'recent:known',
        name: 'Vault',
        path: '/resolved/Vault',
        lastOpenedAt: '2026-05-28T00:00:00.000Z',
      })),
    };

    await expect(openRecentVault('recent:known', runtime, store)).resolves.toBe(profile);
    expect(store.resolve).toHaveBeenCalledWith('recent:known');
    expect(runtime.openVault).toHaveBeenCalledWith('/resolved/Vault');
    expect(runtime.openVault).not.toHaveBeenCalledWith('recent:known');
    expect(store.record).toHaveBeenCalledWith('/resolved/Vault');

    await expect(openRecentVault('/resolved/Vault', runtime, store)).rejects.toThrow('Recent vault not found.');
  });
});
