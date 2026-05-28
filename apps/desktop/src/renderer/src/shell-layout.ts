export interface PaneLayout {
  readonly leftWidth: number;
  readonly rightWidth: number;
  readonly leftCollapsed: boolean;
  readonly rightCollapsed: boolean;
}

export interface PaneLayoutInput {
  readonly leftWidth?: unknown;
  readonly rightWidth?: unknown;
  readonly leftCollapsed?: unknown;
  readonly rightCollapsed?: unknown;
}

export interface PaneDragResolution {
  readonly width: number;
  readonly collapsed: boolean;
}

export interface PaneLayoutViewport {
  readonly viewportWidth: number;
  readonly preserveSide?: 'left' | 'right';
}

export const SHELL_LAYOUT = {
  railWidth: 56,
  resizeHandleWidth: 8,
  editorMinWidth: 420,
  leftDefaultWidth: 280,
  rightDefaultWidth: 260,
  leftMinWidth: 180,
  rightMinWidth: 160,
  leftMaxWidth: 520,
  rightMaxWidth: 480,
  collapsedWidth: 0,
  storagePrefix: 'zorid:desktop-shell:pane-layout:',
} as const;

export const DEFAULT_PANE_LAYOUT: PaneLayout = {
  leftWidth: SHELL_LAYOUT.leftDefaultWidth,
  rightWidth: SHELL_LAYOUT.rightDefaultWidth,
  leftCollapsed: false,
  rightCollapsed: false,
};

export function clampPaneWidth(width: number, min: number, max: number): number {
  if (!Number.isFinite(width)) return min;
  return Math.min(Math.max(Math.round(width), min), Math.max(min, max));
}

export function collapseThreshold(minWidth: number): number {
  return minWidth / 2;
}

export function shouldCollapsePane(width: number, minWidth: number): boolean {
  return Number.isFinite(width) && width < collapseThreshold(minWidth);
}

export function resolveDraggedPaneWidth(cursorWidth: number, minWidth: number, maxWidth: number): PaneDragResolution {
  if (shouldCollapsePane(cursorWidth, minWidth)) return { width: SHELL_LAYOUT.collapsedWidth, collapsed: true };
  return { width: clampPaneWidth(cursorWidth, minWidth, maxWidth), collapsed: false };
}

export function paneLayoutStorageKey(vaultId: string): string {
  return `${SHELL_LAYOUT.storagePrefix}${encodeURIComponent(vaultId)}`;
}

export function safePaneLayoutStorageKey(vaultId?: string): string | undefined {
  return vaultId ? paneLayoutStorageKey(vaultId) : undefined;
}

export function parsePaneLayout(value: string | null): PaneLayout | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as PaneLayoutInput;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return resolvePaneLayout(parsed, { viewportWidth: Number.POSITIVE_INFINITY });
  } catch {
    return undefined;
  }
}

export function resolvePaneLayout(input: PaneLayoutInput = {}, viewport: PaneLayoutViewport): PaneLayout {
  const availableWidth = Number.isFinite(viewport.viewportWidth) ? Math.max(0, viewport.viewportWidth) : Number.POSITIVE_INFINITY;
  const shellChromeWidth = SHELL_LAYOUT.railWidth + (SHELL_LAYOUT.resizeHandleWidth * 2) + SHELL_LAYOUT.editorMinWidth;
  const maxSideTotal = Math.max(0, availableWidth - shellChromeWidth);
  const rawLeftWidth = typeof input.leftWidth === 'number' ? input.leftWidth : DEFAULT_PANE_LAYOUT.leftWidth;
  const rawRightWidth = typeof input.rightWidth === 'number' ? input.rightWidth : DEFAULT_PANE_LAYOUT.rightWidth;
  let leftCollapsed = input.leftCollapsed === true || shouldCollapsePane(rawLeftWidth, SHELL_LAYOUT.leftMinWidth);
  let rightCollapsed = input.rightCollapsed === true || shouldCollapsePane(rawRightWidth, SHELL_LAYOUT.rightMinWidth);
  let leftWidth = leftCollapsed ? SHELL_LAYOUT.collapsedWidth : clampPaneWidth(rawLeftWidth, SHELL_LAYOUT.leftMinWidth, SHELL_LAYOUT.leftMaxWidth);
  let rightWidth = rightCollapsed ? SHELL_LAYOUT.collapsedWidth : clampPaneWidth(rawRightWidth, SHELL_LAYOUT.rightMinWidth, SHELL_LAYOUT.rightMaxWidth);

  if (Number.isFinite(maxSideTotal) && leftWidth + rightWidth > maxSideTotal) {
    const reduce = (side: 'left' | 'right', min: number): void => {
      const overflow = leftWidth + rightWidth - maxSideTotal;
      if (overflow <= 0) return;
      if (side === 'left') leftWidth = Math.max(min, leftWidth - overflow);
      else rightWidth = Math.max(min, rightWidth - overflow);
    };

    if (viewport.preserveSide === 'left') {
      reduce('right', rightCollapsed ? SHELL_LAYOUT.collapsedWidth : SHELL_LAYOUT.rightMinWidth);
      reduce('left', leftCollapsed ? SHELL_LAYOUT.collapsedWidth : SHELL_LAYOUT.leftMinWidth);
    } else if (viewport.preserveSide === 'right') {
      reduce('left', leftCollapsed ? SHELL_LAYOUT.collapsedWidth : SHELL_LAYOUT.leftMinWidth);
      reduce('right', rightCollapsed ? SHELL_LAYOUT.collapsedWidth : SHELL_LAYOUT.rightMinWidth);
    } else {
      reduce('right', rightCollapsed ? SHELL_LAYOUT.collapsedWidth : SHELL_LAYOUT.rightMinWidth);
      reduce('left', leftCollapsed ? SHELL_LAYOUT.collapsedWidth : SHELL_LAYOUT.leftMinWidth);
    }

    if (leftWidth < SHELL_LAYOUT.leftMinWidth) leftCollapsed = true;
    if (rightWidth < SHELL_LAYOUT.rightMinWidth) rightCollapsed = true;
  }

  return { leftWidth, rightWidth, leftCollapsed, rightCollapsed };
}

export function serializePaneLayout(layout: PaneLayout): string {
  return JSON.stringify(layout);
}
