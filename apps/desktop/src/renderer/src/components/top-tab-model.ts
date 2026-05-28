export type TopTabItem = FileTopTabItem | PlaceholderTopTabItem;

export interface FileTopTabItem {
  readonly id: string;
  readonly kind: 'file';
  readonly path: string;
  readonly title: string;
}

export interface PlaceholderTopTabItem {
  readonly id: string;
  readonly kind: 'placeholder';
  readonly title: string;
}

export function fileTabId(path: string): string {
  return `file:${path}`;
}

export function placeholderTabId(monotonicId: number): string {
  return `placeholder:${monotonicId}`;
}

export function tabTitleForPath(path: string): string {
  return path.split('/').at(-1) ?? path;
}

export function fileTab(path: string): FileTopTabItem {
  return { id: fileTabId(path), kind: 'file', path, title: tabTitleForPath(path) };
}

export function placeholderTab(monotonicId: number): PlaceholderTopTabItem {
  return { id: placeholderTabId(monotonicId), kind: 'placeholder', title: 'New tab' };
}

export function nextTabIdAfterClose(tabs: readonly TopTabItem[], closingTabId: string): string | undefined {
  const closingIndex = tabs.findIndex((tab) => tab.id === closingTabId);
  if (closingIndex < 0) return undefined;
  return tabs[closingIndex + 1]?.id ?? tabs[closingIndex - 1]?.id;
}
