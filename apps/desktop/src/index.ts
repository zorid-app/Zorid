export interface DesktopBridge {
  openVault(): Promise<string | undefined>;
  readVaultText(path: string): Promise<string>;
  writeVaultText(path: string, contents: string): Promise<void>;
}

export const preloadApiName = 'zoridDesktop' as const;

export function renderDesktopPlaceholder(root: HTMLElement): void {
  root.innerHTML = '<main data-zorid-shell><aside data-region="left-sidebar"></aside><section data-region="editor"></section><aside data-region="right-sidebar"></aside></main>';
}
