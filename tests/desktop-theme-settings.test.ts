// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import type { SettingsSectionDto } from '../apps/desktop/src/renderer/src/types.js';

const appearanceSection: SettingsSectionDto = {
  id: 'app.appearance',
  title: 'Appearance',
  source: 'app',
  schema: {
    type: 'object',
    properties: {
      theme: {
        type: 'string',
        title: 'Theme',
        default: 'system',
        enum: ['system', 'light', 'dark'],
      },
    },
  },
};

async function flush(): Promise<void> {
  await flushPromises();
  await nextTick();
  await flushPromises();
  await nextTick();
}

function stubMatchMedia(matches: boolean): { emit: (nextMatches: boolean) => void } {
  const listeners = new Set<() => void>();
  const query = {
    matches,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: vi.fn((_event: 'change', listener: () => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_event: 'change', listener: () => void) => listeners.delete(listener)),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => query),
  );
  return {
    emit: (nextMatches: boolean) => {
      query.matches = nextMatches;
      for (const listener of listeners) listener();
    },
  };
}

function stubDesktop(themeValue: unknown): { emitSettingUpdated: (setting: unknown) => void } {
  let settingUpdated: ((setting: unknown) => void) | undefined;
  Object.defineProperty(window, 'zoridDesktop', {
    configurable: true,
    value: {
      getWindowRole: vi.fn().mockResolvedValue('editor'),
      getVaultProfile: vi.fn().mockResolvedValue({ id: 'vault-1', rootLabel: 'Vault' }),
      listVault: vi.fn().mockResolvedValue([]),
      listCommands: vi.fn().mockResolvedValue([]),
      listPluginStatuses: vi.fn().mockResolvedValue([]),
      listSettingsSections: vi.fn().mockResolvedValue([appearanceSection]),
      getSettingValue: vi.fn().mockResolvedValue({ value: themeValue }),
      setSettingValue: vi.fn().mockResolvedValue(undefined),
      getIndexStatus: vi.fn().mockResolvedValue({ state: 'idle', fileCount: 0, diagnostics: [] }),
      listTags: vi.fn().mockResolvedValue([]),
      listTypes: vi.fn().mockResolvedValue([]),
      listBases: vi.fn().mockResolvedValue([]),
      renderDataView: vi.fn().mockResolvedValue(undefined),
      searchIndex: vi.fn().mockResolvedValue([]),
      searchIndexCandidates: vi.fn().mockResolvedValue([]),
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
      onSettingUpdated: vi.fn((callback) => {
        settingUpdated = callback;
        return () => {
          settingUpdated = undefined;
        };
      }),
      executeCommand: vi.fn().mockResolvedValue(undefined),
      createVault: vi.fn().mockResolvedValue(undefined),
      openVault: vi.fn().mockResolvedValue(undefined),
      listRecentVaults: vi.fn().mockResolvedValue([]),
      openRecentVault: vi.fn().mockResolvedValue({ id: 'vault-1', rootLabel: 'Vault' }),
    },
  });
  return {
    emitSettingUpdated: (setting: unknown) => settingUpdated?.(setting),
  };
}

function stubLauncherDesktop(themeValue: unknown): { emitSettingUpdated: (setting: unknown) => void } {
  let settingUpdated: ((setting: unknown) => void) | undefined;
  Object.defineProperty(window, 'zoridDesktop', {
    configurable: true,
    value: {
      getWindowRole: vi.fn().mockResolvedValue('launcher'),
      listRecentVaults: vi.fn().mockResolvedValue([]),
      createVault: vi.fn().mockResolvedValue(undefined),
      openVault: vi.fn().mockResolvedValue(undefined),
      openRecentVault: vi.fn().mockResolvedValue({ id: 'vault-1', rootLabel: 'Vault' }),
      listSettingsSections: vi.fn().mockResolvedValue([appearanceSection]),
      getSettingValue: vi.fn().mockResolvedValue({ value: themeValue }),
      setSettingValue: vi.fn().mockResolvedValue(undefined),
      onSettingUpdated: vi.fn((callback) => {
        settingUpdated = callback;
        return () => {
          settingUpdated = undefined;
        };
      }),
    },
  });
  return {
    emitSettingUpdated: (setting: unknown) => settingUpdated?.(setting),
  };
}

async function mountApp() {
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
  return wrapper;
}

afterEach(() => {
  document.body.innerHTML = '';
  delete document.documentElement.dataset.zTheme;
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('desktop theme settings', () => {
  it('applies explicit light theme from app appearance settings', async () => {
    stubMatchMedia(true);
    stubDesktop({ theme: 'light' });

    const wrapper = await mountApp();

    expect(wrapper.find('.zorid-shell').attributes('data-z-theme')).toBe('light');
    expect(document.documentElement.dataset.zTheme).toBe('light');
  });

  it('resolves system theme from OS preference changes', async () => {
    const media = stubMatchMedia(true);
    stubDesktop({ theme: 'system' });

    const wrapper = await mountApp();
    expect(wrapper.find('.zorid-shell').attributes('data-z-theme')).toBe('dark');

    media.emit(false);
    await nextTick();

    expect(wrapper.find('.zorid-shell').attributes('data-z-theme')).toBe('light');
    expect(document.documentElement.dataset.zTheme).toBe('light');
  });

  it('loads app appearance settings for launcher windows', async () => {
    stubMatchMedia(false);
    stubLauncherDesktop({ theme: 'dark' });

    const wrapper = await mountApp();

    expect(wrapper.find('.launcher-shell').attributes('data-z-theme')).toBe('dark');
    expect(document.documentElement.dataset.zTheme).toBe('dark');
  });

  it('updates open windows from app setting change notifications', async () => {
    stubMatchMedia(false);
    const desktop = stubDesktop({ theme: 'light' });

    const wrapper = await mountApp();
    expect(wrapper.find('.zorid-shell').attributes('data-z-theme')).toBe('light');

    desktop.emitSettingUpdated({ sectionId: 'app.appearance', value: { theme: 'dark' } });
    await nextTick();

    expect(wrapper.find('.zorid-shell').attributes('data-z-theme')).toBe('dark');
    expect(document.documentElement.dataset.zTheme).toBe('dark');
  });
});
