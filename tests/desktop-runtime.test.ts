import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createDesktopRuntime } from '../apps/desktop/src/main/runtime';
import type { PluginManifest } from '../packages/plugin-api/src/index';
import { normalizeVaultPath } from '../packages/shared/src/index';

async function waitFor(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (lastError) throw lastError;
}

const settingsPluginManifest: PluginManifest = {
  schemaVersion: 1,
  id: 'zorid.core.status-bar',
  name: 'Status Bar',
  version: '0.1.0',
  kind: 'core',
  entry: './src/index.ts',
  zoridApi: '^0.1.0',
  platforms: ['desktop'],
  capabilities: { required: ['commands.register', 'settings.register'], optional: [] },
  activation: ['onCommand:status-bar.open'],
  contributes: {
    commands: [{ id: 'status-bar.open', title: 'Open Status Bar' }],
    settings: [{ id: 'status-bar', title: 'Status Bar', schema: { type: 'object' } }],
  },
};

describe('desktop runtime composition', () => {
  it('wires kernel, plugin host, core manifest placeholders, and static settings DTOs without activation', () => {
    const runtime = createDesktopRuntime();
    const statuses = runtime.listPluginStatuses();
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((status) => status.status === 'placeholder')).toBe(true);
    expect(runtime.listCommands().map((command) => command.id)).toEqual(
      expect.arrayContaining(['file-explorer.open-root', 'status-bar.open']),
    );
    expect(runtime.listCommands().map((command) => command.id)).toEqual(
      expect.arrayContaining(['vault.open', 'command-palette.open', 'settings.open']),
    );

    const settings = runtime.listSettingsSections();
    expect(settings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'app.general', source: 'app' }),
        expect.objectContaining({
          id: 'status-bar',
          source: 'plugin-manifest',
          pluginId: 'zorid.core.status-bar',
          pluginStatus: 'placeholder',
        }),
      ]),
    );
    expect(runtime.listPluginStatuses().find((status) => status.pluginId === 'zorid.core.status-bar')?.status).toBe(
      'placeholder',
    );

    expect(runtime.setSettingValue('app.general', { confirmDeletes: false })).toMatchObject({
      sectionId: 'app.general',
      value: { confirmDeletes: false },
    });
    expect(runtime.getSettingValue('app.general').value).toEqual({ confirmDeletes: false });
    expect(runtime.setSettingValue('status-bar', { compact: true }, 'zorid.core.status-bar')).toMatchObject({
      sectionId: 'status-bar',
      pluginId: 'zorid.core.status-bar',
      value: { compact: true },
    });
    expect(runtime.listPluginStatuses().find((status) => status.pluginId === 'zorid.core.status-bar')?.status).toBe(
      'placeholder',
    );
  });

  it('opens a folder vault through safe profile DTOs and file-operation bridge methods', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'zorid-runtime-vault-'));
    try {
      const runtime = createDesktopRuntime();
      const profile = await runtime.openVault(root);
      expect(profile.rootLabel).toBe(path.basename(root));
      expect(profile.id).not.toContain(root);
      expect(profile.id).toMatch(/^folder:[a-f0-9]{16}$/);

      await runtime.createVaultFolder('Notes');
      await runtime.createMarkdownFile('Notes/Test.md', '# Test');
      await expect(runtime.createMarkdownFile('Notes/Test.md', '# Overwrite')).rejects.toThrow(/already exists/);
      expect((await runtime.listVault('Notes')).map((entry) => entry.path)).toEqual(['Notes/Test.md']);
      expect(await runtime.readVaultText('Notes/Test.md')).toBe('# Test');
      await runtime.createMarkdownFile('Notes/Other.md', '# Other');
      await expect(runtime.renameVaultPath('Notes/Test.md', 'Notes/Other.md')).rejects.toThrow(/already exists/);
      await runtime.renameVaultPath('Notes/Test.md', 'Notes/Renamed.md');
      expect(await runtime.readVaultText('Notes/Renamed.md')).toBe('# Test');
      await runtime.deleteVaultPath('Notes/Renamed.md');
      await runtime.deleteVaultPath('Notes/Other.md');
      expect(await runtime.listVault('Notes')).toEqual([]);
      await runtime.deleteVaultPath('Notes');
      expect((await runtime.listVault()).map((entry) => entry.path)).not.toContain('Notes');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rebuilds and incrementally updates the derived SQLite index while ignoring DB artifacts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'zorid-index-vault-'));
    try {
      const runtime = createDesktopRuntime();
      await runtime.openVault(root);
      expect(runtime.getIndexStatus()).toMatchObject({ state: 'watching', fileCount: 0 });

      await runtime.createVaultFolder('.zorid/types');
      await runtime.writeVaultText(
        '.zorid/types/task.ztype',
        `fields:
  - key: status
    type: string
    required: true
  - key: done
    type: boolean
`,
      );
      expect(await runtime.listTypes()).toEqual([
        expect.objectContaining({
          name: 'task',
          fields: expect.arrayContaining([expect.objectContaining({ key: 'status' })]),
        }),
      ]);

      await runtime.createMarkdownFile(
        'A.md',
        `---
zorid.type: task
status: open
done: false
---
# A
See [[B.md]] #tag
![[.zorid/views/tasks.zbase#open]]`,
      );
      await runtime.createMarkdownFile(
        'B.md',
        `---
status: done
---
# B`,
      );
      await runtime.createVaultFolder('.zorid/views');
      await runtime.writeVaultText(
        '.zorid/views/tasks.zbase',
        JSON.stringify({
          views: [
            {
              id: 'open',
              renderer: 'table',
              filters: { expression: { equals: ['status', 'open'] } },
              groupBy: 'status',
              sortBy: 'status',
            },
          ],
        }),
      );
      expect(runtime.getIndexedFile('A.md')).toMatchObject({
        headings: ['A'],
        links: expect.arrayContaining(['B.md']),
        tags: ['tag'],
      });
      expect(runtime.getIndexStatus().fileCount).toBe(4);
      expect(runtime.searchIndex('tag')).toEqual([expect.objectContaining({ path: 'A.md', title: 'A' })]);
      expect(runtime.listTags()).toEqual([{ tag: 'tag', count: 1 }]);
      expect(runtime.getOutline('A.md')).toEqual([{ path: 'A.md', heading: 'A', ordinal: 1 }]);
      expect(runtime.getBacklinks('B.md')).toEqual([expect.objectContaining({ fromPath: 'A.md' })]);
      await expect(runtime.listBases()).resolves.toEqual([
        expect.objectContaining({ name: 'tasks', views: [expect.objectContaining({ id: 'open', renderer: 'table' })] }),
      ]);
      await expect(runtime.renderDataView('.zorid/views/tasks.zbase', 'open')).resolves.toMatchObject({
        viewId: 'open',
        renderer: 'table',
        rows: [expect.objectContaining({ path: 'A.md' })],
        groups: [expect.objectContaining({ key: 'open' })],
      });
      expect(runtime.getMarkdownEmbeds('A.md')).toEqual([
        { sourcePath: 'A.md', basePath: '.zorid/views/tasks.zbase', viewId: 'open' },
      ]);
      await expect(runtime.getFileFields('A.md')).resolves.toMatchObject({
        typeName: 'task',
        diagnostics: [],
        fields: expect.arrayContaining([expect.objectContaining({ key: 'status', value: 'open', type: 'string' })]),
      });
      await runtime.updateFileField('A.md', 'done', true);
      await expect(runtime.readVaultText('A.md')).resolves.toContain('done: true');
      await expect(runtime.updateFileField('A.md', 'status', null)).resolves.toMatchObject({
        diagnostics: [expect.objectContaining({ key: 'status' })],
      });

      await runtime.createVaultFolder('Folder');
      await runtime.createMarkdownFile('Folder/Child.md', '# Child');
      expect(runtime.getIndexedFile('Folder/Child.md')).toBeDefined();
      await runtime.deleteVaultPath('Folder');
      expect(runtime.getIndexedFile('Folder/Child.md')).toBeUndefined();

      await runtime.writeVaultText('.zorid/index/index.sqlite-wal', 'noise');
      expect(runtime.getIndexStatus().fileCount).toBe(4);

      await runtime.requireVault().writeText(normalizeVaultPath('A.md'), '# Updated');
      runtime.scheduleIndexUpdate(normalizeVaultPath('A.md'));
      await waitFor(() => expect(runtime.getIndexedFile('A.md')?.headings).toEqual(['Updated']));

      await runtime.deleteVaultPath('A.md');
      expect(runtime.getIndexedFile('A.md')).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('can switch open vaults without duplicate runtime services', async () => {
    const first = await mkdtemp(path.join(tmpdir(), 'zorid-runtime-first-'));
    const second = await mkdtemp(path.join(tmpdir(), 'zorid-runtime-second-'));
    try {
      const runtime = createDesktopRuntime();
      await runtime.openVault(first);
      await runtime.createMarkdownFile('First.md', '# First');
      expect(runtime.getIndexedFile('First.md')).toBeDefined();
      runtime.scheduleIndexUpdate(normalizeVaultPath('First.md'));
      await runtime.openVault(second);
      expect(runtime.vaultProfile()?.rootLabel).toBe(path.basename(second));
      expect(runtime.getIndexedFile('First.md')).toBeUndefined();
      await runtime.createMarkdownFile('Second.md', '# Second');
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(runtime.getIndexedFile('Second.md')).toBeDefined();
      expect(runtime.getIndexedFile('First.md')).toBeUndefined();
    } finally {
      await rm(first, { recursive: true, force: true });
      await rm(second, { recursive: true, force: true });
    }
  });

  it('deactivates active plugin stacks during runtime disposal', async () => {
    const deactivate = vi.fn();
    const disposable = { dispose: vi.fn() };
    const runtime = createDesktopRuntime({
      manifests: [settingsPluginManifest],
      load: () => ({
        activate(ctx) {
          ctx.register.disposable(disposable);
          ctx.register.command({ id: 'status-bar.open', title: 'Open Status Bar', callback: async () => 'opened' });
        },
        deactivate,
      }),
    });

    await runtime.executeCommand('status-bar.open');
    expect(runtime.listPluginStatuses().find((status) => status.pluginId === 'zorid.core.status-bar')?.status).toBe(
      'active',
    );

    await runtime.dispose();

    expect(deactivate).toHaveBeenCalledOnce();
    expect(disposable.dispose).toHaveBeenCalledOnce();
    expect(runtime.listPluginStatuses().find((status) => status.pluginId === 'zorid.core.status-bar')?.status).toBe(
      'placeholder',
    );
  });

  it('disposes plugin stacks even when plugin deactivation throws', async () => {
    const deactivate = vi.fn(() => {
      throw new Error('deactivate failed');
    });
    const disposable = { dispose: vi.fn() };
    const runtime = createDesktopRuntime({
      manifests: [settingsPluginManifest],
      load: () => ({
        activate(ctx) {
          ctx.register.disposable(disposable);
          ctx.register.command({ id: 'status-bar.open', title: 'Open Status Bar', callback: async () => 'opened' });
        },
        deactivate,
      }),
    });

    await runtime.executeCommand('status-bar.open');
    await expect(runtime.dispose()).rejects.toThrow('Desktop runtime disposal failed.');

    expect(deactivate).toHaveBeenCalledOnce();
    expect(disposable.dispose).toHaveBeenCalledOnce();
    expect(runtime.listPluginStatuses().find((status) => status.pluginId === 'zorid.core.status-bar')?.status).toBe(
      'placeholder',
    );
  });

  it('clears plugin active state even when plugin disposable cleanup throws', async () => {
    const deactivate = vi.fn();
    const runtime = createDesktopRuntime({
      manifests: [settingsPluginManifest],
      load: () => ({
        activate(ctx) {
          ctx.register.disposable({
            dispose: () => {
              throw new Error('disposable failed');
            },
          });
          ctx.register.command({ id: 'status-bar.open', title: 'Open Status Bar', callback: async () => 'opened' });
        },
        deactivate,
      }),
    });

    await runtime.executeCommand('status-bar.open');
    await expect(runtime.dispose()).rejects.toThrow('Desktop runtime disposal failed.');

    expect(deactivate).toHaveBeenCalledOnce();
    expect(runtime.listPluginStatuses().find((status) => status.pluginId === 'zorid.core.status-bar')?.status).toBe(
      'placeholder',
    );
  });

  it('continues runtime cleanup when a non-plugin disposable throws synchronously', async () => {
    const throwingWatcher = {
      dispose: vi.fn(() => {
        throw new Error('watcher failed');
      }),
    };
    const disposingKernel = { dispose: vi.fn() };
    const pluginRuntime = createDesktopRuntime({
      manifests: [settingsPluginManifest],
      load: () => ({
        activate(ctx) {
          ctx.register.disposable(throwingWatcher);
          ctx.register.disposable(disposingKernel);
          ctx.register.command({ id: 'status-bar.open', title: 'Open Status Bar', callback: async () => 'opened' });
        },
      }),
    });

    await pluginRuntime.executeCommand('status-bar.open');
    await expect(pluginRuntime.dispose()).rejects.toThrow('Desktop runtime disposal failed.');

    expect(throwingWatcher.dispose).toHaveBeenCalledOnce();
    expect(disposingKernel.dispose).toHaveBeenCalledOnce();
    expect(
      pluginRuntime.listPluginStatuses().find((status) => status.pluginId === 'zorid.core.status-bar')?.status,
    ).toBe('placeholder');
  });

  it('activates a lazy plugin only when its placeholder command runs', async () => {
    const runtime = createDesktopRuntime({
      manifests: [settingsPluginManifest],
      load: () => ({
        activate(ctx) {
          ctx.register.command({ id: 'status-bar.open', title: 'Open Status Bar', callback: async () => 'opened' });
          ctx.register.setting({ id: 'runtime-status-bar', title: 'Runtime Status Bar', schema: { type: 'object' } });
        },
      }),
    });
    expect(runtime.listPluginStatuses().find((status) => status.pluginId === 'zorid.core.status-bar')?.status).toBe(
      'placeholder',
    );
    await expect(runtime.executeCommand('status-bar.open')).resolves.toBe('opened');
    expect(runtime.listPluginStatuses().find((status) => status.pluginId === 'zorid.core.status-bar')?.status).toBe(
      'active',
    );
    expect(runtime.listSettingsSections()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'status-bar', source: 'plugin-manifest' }),
        expect.objectContaining({ id: 'runtime-status-bar', source: 'plugin-runtime' }),
      ]),
    );
  });
});
