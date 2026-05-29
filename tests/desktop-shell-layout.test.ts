import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EDITOR_TRAFFIC_LIGHT_POSITION,
  MACOS_TRAFFIC_LIGHT_CONTROL_GROUP_WIDTH,
} from '../apps/desktop/src/chrome-layout';
import { managedWindowOptions } from '../apps/desktop/src/main/window-options';
import {
  clampPaneWidth,
  collapseThreshold,
  DEFAULT_PANE_LAYOUT,
  paneLayoutStorageKey,
  parsePaneLayout,
  resolveDraggedPaneWidth,
  resolvePaneLayout,
  SHELL_LAYOUT,
  shouldCollapsePane,
} from '../apps/desktop/src/renderer/src/shell-layout';

describe('desktop shell pane layout helpers', () => {
  it('clamps pane widths to safe bounds', () => {
    expect(clampPaneWidth(120, 180, 520)).toBe(180);
    expect(clampPaneWidth(700, 180, 520)).toBe(520);
    expect(clampPaneWidth(260, 180, 520)).toBe(260);
  });

  it('clamps at min width before collapsing below half the min width', () => {
    expect(collapseThreshold(SHELL_LAYOUT.leftMinWidth)).toBe(SHELL_LAYOUT.leftMinWidth / 2);
    expect(shouldCollapsePane(SHELL_LAYOUT.leftMinWidth / 2 - 1, SHELL_LAYOUT.leftMinWidth)).toBe(true);
    expect(shouldCollapsePane(SHELL_LAYOUT.leftMinWidth / 2, SHELL_LAYOUT.leftMinWidth)).toBe(false);
    expect(
      resolveDraggedPaneWidth(SHELL_LAYOUT.leftMinWidth + 12, SHELL_LAYOUT.leftMinWidth, SHELL_LAYOUT.leftMaxWidth),
    ).toEqual({ width: SHELL_LAYOUT.leftMinWidth + 12, collapsed: false });
    expect(
      resolveDraggedPaneWidth(SHELL_LAYOUT.leftMinWidth - 10, SHELL_LAYOUT.leftMinWidth, SHELL_LAYOUT.leftMaxWidth),
    ).toEqual({ width: SHELL_LAYOUT.leftMinWidth, collapsed: false });
    expect(
      resolveDraggedPaneWidth(SHELL_LAYOUT.leftMinWidth / 2 - 1, SHELL_LAYOUT.leftMinWidth, SHELL_LAYOUT.leftMaxWidth),
    ).toEqual({ width: 0, collapsed: true });
  });

  it('resolves unsafe persisted values to safe clamped widths', () => {
    expect(SHELL_LAYOUT.collapsedWidth).toBe(0);
    expect(resolvePaneLayout({ leftWidth: 100, rightWidth: 1000 }, { viewportWidth: 1400 })).toMatchObject({
      leftWidth: SHELL_LAYOUT.leftMinWidth,
      leftCollapsed: false,
      rightWidth: SHELL_LAYOUT.rightMaxWidth,
      rightCollapsed: false,
    });
    expect(parsePaneLayout('{bad json')).toBeUndefined();
    expect(parsePaneLayout(JSON.stringify({ leftWidth: 320, rightWidth: 300 }))).toMatchObject({
      leftWidth: 320,
      rightWidth: 300,
    });
  });

  it('uses vault id, not root label, for distinct storage keys', () => {
    expect(paneLayoutStorageKey('folder:aaa')).not.toBe(paneLayoutStorageKey('folder:bbb'));
    const first = { id: 'folder:aaa', rootLabel: 'Notes' };
    const second = { id: 'folder:bbb', rootLabel: 'Notes' };
    expect(first.rootLabel).toBe(second.rootLabel);
    expect(paneLayoutStorageKey(first.id)).not.toBe(paneLayoutStorageKey(second.id));
  });

  it('keeps combined side panes within the viewport side budget', () => {
    const viewportWidth = 1200;
    const layout = resolvePaneLayout({ leftWidth: 520, rightWidth: 480 }, { viewportWidth });
    const sideBudget =
      viewportWidth - SHELL_LAYOUT.railWidth - SHELL_LAYOUT.resizeHandleWidth * 2 - SHELL_LAYOUT.editorMinWidth;
    expect(layout.leftWidth + layout.rightWidth).toBeLessThanOrEqual(sideBudget);

    const preserveRight = resolvePaneLayout(
      { leftWidth: 520, rightWidth: 480 },
      { viewportWidth, preserveSide: 'right' },
    );
    expect(preserveRight.rightWidth).toBe(SHELL_LAYOUT.rightMaxWidth);
    expect(preserveRight.leftWidth + preserveRight.rightWidth).toBeLessThanOrEqual(sideBudget);
  });

  it('falls back to default layout for missing persisted input', () => {
    expect(resolvePaneLayout({}, { viewportWidth: 1600 })).toEqual(DEFAULT_PANE_LAYOUT);
  });

  it('reserves app chrome while keeping resize hit targets separate from visible highlights', () => {
    expect(SHELL_LAYOUT.titlebarHeight).toBeGreaterThanOrEqual(36);
    expect(SHELL_LAYOUT.trafficLightReservedWidth).toBeGreaterThanOrEqual(72);
    expect(SHELL_LAYOUT.trafficLightReservedWidth).toBeGreaterThanOrEqual(
      EDITOR_TRAFFIC_LIGHT_POSITION.x + MACOS_TRAFFIC_LIGHT_CONTROL_GROUP_WIDTH,
    );
    expect(SHELL_LAYOUT.resizeHandleWidth).toBeGreaterThanOrEqual(8);
  });

  it('applies native titlebar chrome to launcher and editor windows', () => {
    const launcher = managedWindowOptions('launcher', '/tmp/preload.cjs');
    const editor = managedWindowOptions('editor', '/tmp/preload.cjs');

    expect(launcher.titleBarStyle).toBe('hiddenInset');
    expect(launcher.trafficLightPosition).toEqual(EDITOR_TRAFFIC_LIGHT_POSITION);
    expect(editor.titleBarStyle).toBe('hiddenInset');
    expect(editor.trafficLightPosition).toEqual(EDITOR_TRAFFIC_LIGHT_POSITION);
    expect(editor.webPreferences).toMatchObject({
      preload: '/tmp/preload.cjs',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });
    expect(launcher.webPreferences).toEqual(editor.webPreferences);
  });

  it('keeps desktop chrome and wrapping behavior wired in renderer styles', () => {
    const styles = readFileSync('apps/desktop/src/renderer/src/styles.css', 'utf8');
    const app = readFileSync('apps/desktop/src/renderer/src/App.vue', 'utf8');
    const titlebar = readFileSync('apps/desktop/src/renderer/src/components/TopTabStrip.vue', 'utf8');
    const resizeHandle = readFileSync('apps/desktop/src/renderer/src/components/AppResizeHandle.vue', 'utf8');

    expect(titlebar).toContain('class="editor-titlebar"');
    expect(titlebar).toContain("import { ZIconButton } from '@zorid/ui-vue';");
    expect(titlebar).toContain('newTab: []');
    expect(titlebar).toContain('toggleLeftPane: []');
    expect(titlebar).toContain('toggleRightPane: []');
    expect(titlebar).toContain('updateTabOverflow');
    expect(titlebar).not.toContain('<button type="button" class="top-tab"');
    expect(app).toContain('fileTabId(path)');
    expect(app).toContain('placeholderTabCounter');
    expect(app).toContain('@new-tab="createPlaceholderTab"');
    expect(app).toContain('@toggle-left-pane="toggleLeftPane"');
    expect(app).toContain('@toggle-right-pane="toggleRightPane"');
    expect(app).toContain("event.key.toLowerCase() === 'w'");
    expect(app).toContain(
      'openTabs.value = openTabs.value.map((tab) => (tab.id === fileTabId(previous) ? fileTab(next) : tab))',
    );
    expect(app).toContain('await closeTab(fileTabId(previous))');
    expect(app).toMatch(
      /function createPlaceholderTab\(\): void \{[\s\S]*placeholderTabCounter\.value \+= 1;[\s\S]*activatePlaceholderTab\(tab\.id\);[\s\S]*\}/,
    );
    expect(app).toMatch(
      /function clearFileSelection\(\): void \{[\s\S]*selectedPath\.value = undefined;[\s\S]*editorText\.value = '';[\s\S]*savedText\.value = '';[\s\S]*\}/,
    );
    expect(app).toContain('class="traffic-light-spacer launcher-traffic-light-spacer"');
    expect(app).not.toContain('class="window-dots"');
    expect(titlebar).not.toContain('class="window-dots"');
    expect(resizeHandle).toContain('class="resize-handle"');
    expect(styles).toContain('position: relative;');
    expect(styles).toContain('grid-template-rows: var(--titlebar-height) minmax(0, 1fr);');
    expect(styles).toContain('position: absolute;');
    expect(styles).toContain('right: 0;');
    expect(styles).toContain('bottom: 0;');
    expect(styles).toContain('width: max-content;');
    expect(styles).toContain('border-right: 0;');
    expect(styles).toContain('border-bottom: 0;');
    expect(styles).toContain('border-radius: var(--z-radius-md) 0 0 0;');
    expect(styles).toContain('.status-bar__item');
    expect(styles).toMatch(/\.launcher-shell\s*\{[^}]*-webkit-app-region:\s*drag;[^}]*\}/s);
    expect(styles).toMatch(
      /\.launcher-shell\s+:is\([^)]*button[^)]*a[^)]*input[^)]*select[^)]*textarea[^)]*\[role='button'\][^)]*\[contenteditable='true'\][^)]*\)\s*\{[^}]*-webkit-app-region:\s*no-drag;[^}]*\}/s,
    );
    expect(styles).toContain('.resize-handle.active::before');
    expect(styles).toContain('.titlebar-left-actions');
    expect(styles).toContain('.titlebar-right-actions');
    expect(styles).toContain('.tab-add-button');
    expect(styles).toContain('.top-tab:hover .top-tab-close');
    expect(styles).toContain('-webkit-app-region: no-drag;');
    expect(styles).toContain('text-overflow: ellipsis;');
    expect(styles).toContain('white-space: nowrap;');
    expect(styles).not.toContain('.tab-bar');
    expect(styles).not.toContain('.window-dots');
  });
});
