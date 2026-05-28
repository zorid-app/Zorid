import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('desktop renderer reusable UI migration', () => {
  it('uses app-specific components for shell, sidebars, dialogs, resize, status, and file tree', () => {
    const app = readFileSync('apps/desktop/src/renderer/src/App.vue', 'utf8');
    for (const component of [
      'TopTabStrip',
      'ActivityRail',
      'FileTree',
      'RightSidebarPanels',
      'AppResizeHandle',
      'AppStatusBar',
      'CommandPaletteWindow',
      'SettingsWindow',
    ]) {
      expect(app).toContain(component);
    }
    expect(app).not.toContain('class="modal-backdrop"');
    expect(app).not.toContain('role="dialog"');
  });

  it('routes app-specific windows through shared Zorid UI dialog primitives', () => {
    const commandPalette = readFileSync('apps/desktop/src/renderer/src/components/CommandPaletteWindow.vue', 'utf8');
    const settings = readFileSync('apps/desktop/src/renderer/src/components/SettingsWindow.vue', 'utf8');
    expect(commandPalette).toContain('ZDialogWindow');
    expect(settings).toContain('ZDialogWindow');
  });

  it('uses shared icon buttons for the activity rail', () => {
    const activityRail = readFileSync('apps/desktop/src/renderer/src/components/ActivityRail.vue', 'utf8');

    expect(activityRail).toContain('ZIconButton');
    expect(activityRail).toContain(':label="item"');
    expect(activityRail).toContain('label="Command palette"');
    expect(activityRail).toContain('label="Settings"');
    expect(activityRail).not.toContain('<button');
  });

  it('uses shared panel/tag/status/resize primitives while keeping desktop visual classes', () => {
    const rightSidebar = readFileSync('apps/desktop/src/renderer/src/components/RightSidebarPanels.vue', 'utf8');
    const status = readFileSync('apps/desktop/src/renderer/src/components/AppStatusBar.vue', 'utf8');
    const resize = readFileSync('apps/desktop/src/renderer/src/components/AppResizeHandle.vue', 'utf8');
    expect(rightSidebar).toContain('ZPanel');
    expect(rightSidebar).toContain('ZTag');
    expect(status).toContain('ZStatusBar');
    expect(status).toContain('class="status-bar"');
    expect(resize).toContain('ZResizeHandle');
    expect(resize).toContain('class="resize-handle"');
  });
});

describe('reusable UI inventory documentation', () => {
  it('documents every shared and desktop component added by the migration', () => {
    const doc = readFileSync('docs/development/reusable-ui-components.md', 'utf8');
    for (const component of [
      'ZDialogWindow',
      'ZModalWindow',
      'ZDialogBackdrop',
      'ZConfirmDialog',
      'ZPromptDialog',
      'ZWindowFrame',
      'ZButton',
      'ZTextField',
      'ZCheckboxField',
      'ZPanel',
      'ZBadge',
      'ZTag',
      'ZStatusBar',
      'ZResizeHandle',
      'CommandPaletteWindow',
      'SettingsWindow',
      'TopTabStrip',
      'ActivityRail',
      'FileTree',
      'RightSidebarPanels',
      'AppResizeHandle',
      'AppStatusBar',
    ]) {
      expect(doc).toContain(component);
    }
    expect(doc).toContain('No platform/plugin UI component API is added in this pass.');
  });
});

describe('desktop explicit shared style wiring', () => {
  it('imports shared UI styles explicitly before app styles', () => {
    const main = readFileSync('apps/desktop/src/renderer/src/main.ts', 'utf8');
    expect(main.indexOf('@zorid/ui-vue/tokens.css')).toBeLessThan(main.indexOf('@zorid/ui-vue/components.css'));
    expect(main.indexOf('@zorid/ui-vue/components.css')).toBeLessThan(main.indexOf('./styles.css'));
  });
});
