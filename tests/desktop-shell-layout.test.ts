import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EDITOR_TRAFFIC_LIGHT_POSITION, MACOS_TRAFFIC_LIGHT_CONTROL_GROUP_WIDTH } from '../apps/desktop/src/chrome-layout';
import { managedWindowOptions } from '../apps/desktop/src/main/window-options';
import { DEFAULT_PANE_LAYOUT, SHELL_LAYOUT, clampPaneWidth, collapseThreshold, paneLayoutStorageKey, parsePaneLayout, resolveDraggedPaneWidth, resolvePaneLayout, shouldCollapsePane } from '../apps/desktop/src/renderer/src/shell-layout';

describe('desktop shell pane layout helpers', () => {
  it('clamps pane widths to safe bounds', () => {
    expect(clampPaneWidth(120, 180, 520)).toBe(180);
    expect(clampPaneWidth(700, 180, 520)).toBe(520);
    expect(clampPaneWidth(260, 180, 520)).toBe(260);
  });

  it('clamps at min width before collapsing below half the min width', () => {
    expect(collapseThreshold(SHELL_LAYOUT.leftMinWidth)).toBe(SHELL_LAYOUT.leftMinWidth / 2);
    expect(shouldCollapsePane((SHELL_LAYOUT.leftMinWidth / 2) - 1, SHELL_LAYOUT.leftMinWidth)).toBe(true);
    expect(shouldCollapsePane(SHELL_LAYOUT.leftMinWidth / 2, SHELL_LAYOUT.leftMinWidth)).toBe(false);
    expect(resolveDraggedPaneWidth(SHELL_LAYOUT.leftMinWidth + 12, SHELL_LAYOUT.leftMinWidth, SHELL_LAYOUT.leftMaxWidth)).toEqual({ width: SHELL_LAYOUT.leftMinWidth + 12, collapsed: false });
    expect(resolveDraggedPaneWidth(SHELL_LAYOUT.leftMinWidth - 10, SHELL_LAYOUT.leftMinWidth, SHELL_LAYOUT.leftMaxWidth)).toEqual({ width: SHELL_LAYOUT.leftMinWidth, collapsed: false });
    expect(resolveDraggedPaneWidth((SHELL_LAYOUT.leftMinWidth / 2) - 1, SHELL_LAYOUT.leftMinWidth, SHELL_LAYOUT.leftMaxWidth)).toEqual({ width: 0, collapsed: true });
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
    expect(parsePaneLayout(JSON.stringify({ leftWidth: 320, rightWidth: 300 }))).toMatchObject({ leftWidth: 320, rightWidth: 300 });
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
    const sideBudget = viewportWidth - SHELL_LAYOUT.railWidth - (SHELL_LAYOUT.resizeHandleWidth * 2) - SHELL_LAYOUT.editorMinWidth;
    expect(layout.leftWidth + layout.rightWidth).toBeLessThanOrEqual(sideBudget);

    const preserveRight = resolvePaneLayout({ leftWidth: 520, rightWidth: 480 }, { viewportWidth, preserveSide: 'right' });
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
    expect(SHELL_LAYOUT.statusBarMinHeight).toBe(30);
    expect(SHELL_LAYOUT.statusBarMaxHeight).toBeGreaterThan(SHELL_LAYOUT.statusBarMinHeight);
  });

  it('applies native titlebar chrome only to editor windows', () => {
    const launcher = managedWindowOptions('launcher', '/tmp/preload.cjs');
    const editor = managedWindowOptions('editor', '/tmp/preload.cjs');

    expect(launcher.titleBarStyle).toBeUndefined();
    expect(launcher.trafficLightPosition).toBeUndefined();
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

    expect(app).toContain('class="editor-titlebar"');
    expect(app).toContain(":class=\"resizeHandleClasses('left')\"");
    expect(styles).toContain('grid-template-rows: var(--titlebar-height) minmax(0, 1fr) auto;');
    expect(styles).toContain('max-height: var(--status-bar-max-height);');
    expect(styles).toContain('-webkit-app-region: drag;');
    expect(styles).toContain('.resize-handle.active::before');
    expect(styles).toContain('overflow-wrap: anywhere;');
    expect(styles).toContain('white-space: normal;');
    expect(styles).not.toContain('.tab-bar');
  });
});
