// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import type { VaultEntry } from '../apps/desktop/src/renderer/src/types.js';

function entry(path: string, kind: VaultEntry['kind'], mtimeMs: number): VaultEntry {
  return { path, kind, mtimeMs, size: kind === 'directory' ? 0 : 10 };
}

async function flush(): Promise<void> {
  await flushPromises();
  await nextTick();
  await flushPromises();
  await nextTick();
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('desktop file tree toolbar contract', () => {
  it('uses compact left-pane-specific Lucide controls for file tree actions', () => {
    const app = readFileSync('apps/desktop/src/renderer/src/App.vue', 'utf8');

    for (const symbol of ['FilePlus', 'FolderPlus', 'ArrowDownUp', 'ChevronsDown', 'ChevronsUp']) {
      expect(app).toContain(symbol);
    }
    expect(app).toContain('class="file-pane-toolbar"');
    expect(app).toContain("import { ZIconButton } from '@zorid/ui-vue';");
    expect(app).toContain('<ZIconButton label="New file"');
    expect(app).toContain('<ZIconButton label="New folder"');
    expect(app).toContain('<ZIconButton label="Expand loaded folders"');
    expect(app).toContain('<ZIconButton label="Collapse loaded folders"');
    expect(app).not.toContain('class="file-pane-action"');
  });

  it('exposes discoverable name/modified sort modes and loaded-directory expand/collapse', () => {
    const app = readFileSync('apps/desktop/src/renderer/src/App.vue', 'utf8');

    expect(app).toContain("fileTreeSortMode = ref<FileTreeSortMode>('name-asc')");
    expect(app).toContain('FILE_TREE_SORT_MODES');
    expect(app).toContain('sortEntries(entries, fileTreeSortMode.value)');
    expect(app).toContain(':aria-label="`Sort files: ${fileTreeSortLabel}`"');
    expect(app).toContain('updateFileTreeSortMode');
    expect(app).toContain('expandLoadedDirectories');
    expect(app).toContain('collapseLoadedDirectories');
    expect(app).toContain("expandedDirectories.value = { '': true }");
    expect(app).not.toMatch(/created-asc|created-desc|ctime-asc|ctime-desc|birthtime-asc|birthtime-desc/i);
  });

  it('mounts with an accessible sort select that changes rendered file order', async () => {
    vi.stubGlobal('prompt', vi.fn());
    Object.defineProperty(window, 'zoridDesktop', {
      configurable: true,
      value: {
        getWindowRole: vi.fn().mockResolvedValue('editor'),
        getVaultProfile: vi.fn().mockResolvedValue({ id: 'vault-1', rootLabel: 'Vault' }),
        listVault: vi
          .fn()
          .mockImplementation((path = '') =>
            Promise.resolve(
              path === ''
                ? [entry('FolderB', 'directory', 20), entry('c.md', 'file', 30), entry('a.md', 'file', 10)]
                : [],
            ),
          ),
        listCommands: vi.fn().mockResolvedValue([]),
        listPluginStatuses: vi.fn().mockResolvedValue([]),
        listSettingsSections: vi.fn().mockResolvedValue([]),
        getSettingValue: vi.fn().mockResolvedValue({ value: undefined }),
        setSettingValue: vi.fn().mockResolvedValue(undefined),
        getIndexStatus: vi.fn().mockResolvedValue({ state: 'idle', fileCount: 3, diagnostics: [] }),
        listTags: vi.fn().mockResolvedValue([]),
        listTypes: vi.fn().mockResolvedValue([]),
        listBases: vi.fn().mockResolvedValue([]),
        renderDataView: vi.fn().mockResolvedValue(undefined),
        searchIndex: vi.fn().mockResolvedValue([]),
        getBacklinks: vi.fn().mockResolvedValue([]),
        getOutline: vi.fn().mockResolvedValue([]),
        getFileFields: vi.fn().mockResolvedValue({ path: 'a.md', fields: [] }),
        readVaultText: vi.fn().mockResolvedValue(''),
        writeVaultText: vi.fn().mockResolvedValue(undefined),
        createVaultFolder: vi.fn().mockResolvedValue(undefined),
        createMarkdownFile: vi.fn().mockResolvedValue(undefined),
        renameVaultPath: vi.fn().mockResolvedValue(undefined),
        deleteVaultPath: vi.fn().mockResolvedValue(undefined),
        updateFileField: vi.fn().mockResolvedValue({ path: 'a.md', fields: [] }),
        setFileType: vi.fn().mockResolvedValue({ path: 'a.md', fields: [] }),
        onIndexUpdated: vi.fn().mockReturnValue(() => undefined),
        onEditorSnapshot: vi.fn().mockReturnValue(() => undefined),
        executeCommand: vi.fn().mockResolvedValue(undefined),
        createVault: vi.fn().mockResolvedValue(undefined),
        openVault: vi.fn().mockResolvedValue(undefined),
        listRecentVaults: vi.fn().mockResolvedValue([]),
        openRecentVault: vi.fn().mockResolvedValue({ id: 'vault-1', rootLabel: 'Vault' }),
      },
    });

    const { default: App } = await import('../apps/desktop/src/renderer/src/App.vue');
    const wrapper = mount(App, {
      attachTo: document.body,
      global: {
        stubs: {
          ActivityRail: true,
          AppResizeHandle: true,
          AppStatusBar: true,
          CommandPaletteWindow: true,
          MarkdownEditor: true,
          RightSidebarPanels: true,
          SettingsWindow: true,
          TopTabStrip: true,
        },
      },
    });
    await flush();

    const select = wrapper.find<HTMLSelectElement>('.file-pane-sort select');
    expect(select.exists()).toBe(true);
    expect(select.attributes('aria-label')).toBe('Sort files: Name A to Z');
    expect(select.findAll('option').map((option) => option.attributes('value'))).toEqual([
      'name-asc',
      'name-desc',
      'modified-asc',
      'modified-desc',
    ]);
    expect(wrapper.findAll('.file-tree .tree-label').map((label) => label.text())).toEqual(['FolderB', 'a.md', 'c.md']);

    await select.setValue('modified-desc');
    await flush();

    expect(select.attributes('aria-label')).toBe('Sort files: Modified newest first');
    expect(wrapper.findAll('.file-tree .tree-label').map((label) => label.text())).toEqual(['FolderB', 'c.md', 'a.md']);
  });
});
