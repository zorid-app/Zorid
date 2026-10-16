import { icon } from './icons.ts';

export interface SidebarControlsOptions {
  onToggleLeft(): void;
  onToggleRight(): void;
}

/** Workspace-owned controls survive tab rerenders, scrolling and split changes. */
export function createSidebarControls(root: HTMLElement, options: SidebarControlsOptions): {
  element: HTMLDivElement; refresh(): void; destroy(): void;
} {
  const doc = root.ownerDocument;
  const element = doc.createElement('div');
  element.className = 'workspace-sidebar-controls';
  let destroyed = false;
  const makeButton = (side: 'left' | 'right', action: () => void) => {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = `icon-button workspace-sidebar-toggle is-${side}`;
    button.dataset.windowNoDrag = '';
    button.append(icon(side === 'left' ? 'sidebar' : 'rightbar', 18, doc));
    button.addEventListener('click', () => {
      if (destroyed || !root.isConnected || !root.contains(element)) return;
      action();
      refresh();
    });
    element.append(button);
    return button;
  };
  const left = makeButton('left', options.onToggleLeft);
  const right = makeButton('right', options.onToggleRight);
  const marked = new Set<HTMLElement>();
  const clearMarkers = () => {
    for (const bar of marked) {
      delete bar.dataset.chromeEdgeLeft;
      delete bar.dataset.chromeEdgeRight;
      delete bar.dataset.windowDragRegion;
    }
    marked.clear();
  };
  const mark = (bar: HTMLElement | null) => {
    if (!bar) return;
    marked.add(bar);
    bar.dataset.windowDragRegion = '';
  };
  // Rows split horizontally on screen are "vertical" branches in SplitLayout.
  // A stacked branch contributes only its first child's headers to the top row.
  const topBars = (parent: Element): HTMLElement[] => {
    if (parent.classList.contains('pane')) {
      const bar = parent.querySelector<HTMLElement>(':scope > .tab-bar');
      return bar ? [bar] : [];
    }
    const children = [...parent.children].filter(child =>
      child.classList.contains('pane') || child.classList.contains('split-layout-group'));
    const visible = (parent as HTMLElement).dataset.direction === 'horizontal' ? children.slice(0, 1) : children;
    return visible.flatMap(topBars);
  };
  function refresh(): void {
    if (destroyed) return;
    clearMarkers();
    for (const [side, button] of [['left', left], ['right', right]] as const) {
      const expanded = !root.classList.contains(`${side}-hidden`);
      const label = `${expanded ? 'Collapse' : 'Expand'} ${side} sidebar`;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-expanded', String(expanded));
    }
    mark(root.querySelector<HTMLElement>(':scope > .sidebar > .sidebar-tabs'));
    mark(root.querySelector<HTMLElement>(':scope > .right-sidebar > .right-tabs'));
    const panes = root.querySelector(':scope > .workspace-center > .panes');
    const bars = panes ? topBars(panes) : [];
    bars.forEach(mark);
    if (bars.length) {
      bars[0].dataset.chromeEdgeLeft = '';
      bars[bars.length - 1].dataset.chromeEdgeRight = '';
    }
  }
  root.classList.add('has-sidebar-controls');
  root.append(element);
  refresh();
  const Observer = doc.defaultView?.MutationObserver;
  const stateObserver = Observer ? new Observer(refresh) : undefined;
  stateObserver?.observe(root, { attributes: true, attributeFilter: ['class'] });
  const layoutObserver = Observer ? new Observer(records => {
    // Editor DOM changes do not alter the workspace's top edge.
    if (records.some(record => record.target === root ||
      (record.target as Element).matches?.('.workspace-center, .panes, .split-layout-group, .pane, .sidebar, .right-sidebar'))) refresh();
  }) : undefined;
  layoutObserver?.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-direction'] });
  return {
    element, refresh,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stateObserver?.disconnect();
      layoutObserver?.disconnect();
      clearMarkers();
      root.classList.remove('has-sidebar-controls');
      element.remove();
    },
  };
}
