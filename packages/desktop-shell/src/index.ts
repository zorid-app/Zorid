import type { VaultPath } from '@zorid/shared';

export interface DesktopShellState {
  readonly activityRail: readonly string[];
  readonly leftSidebarVisible: boolean;
  readonly rightSidebarVisible: boolean;
  readonly openTabs: readonly VaultPath[];
  readonly activePath?: VaultPath;
}

export function createDesktopShellState(): DesktopShellState {
  return {
    activityRail: ['files', 'search', 'backlinks', 'tags'],
    leftSidebarVisible: true,
    rightSidebarVisible: true,
    openTabs: [],
  };
}

export function withActiveTab(state: DesktopShellState, path: VaultPath): DesktopShellState {
  const openTabs = state.openTabs.includes(path) ? state.openTabs : [...state.openTabs, path];
  return { ...state, openTabs, activePath: path };
}
