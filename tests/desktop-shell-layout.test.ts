import { describe, expect, it } from 'vitest';
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
});
