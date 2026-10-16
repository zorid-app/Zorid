/** Renderer persistence policy. Window identity must come from authenticated native IPC. */
export interface WorkspaceWindowInfo { id: string; initialState: 'restore' | 'empty' }
export interface WorkspaceWindowBridge {
  getWindowInfo(): Promise<WorkspaceWindowInfo>;
  newWindow(): Promise<{ id: string }>;
}
export function workspaceWindowBridge(value: unknown): WorkspaceWindowBridge | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const bridge = value as Partial<WorkspaceWindowBridge>;
  return typeof bridge.getWindowInfo === 'function' && typeof bridge.newWindow === 'function' ? bridge as WorkspaceWindowBridge : undefined;
}
export function validateWorkspaceWindowInfo(value: WorkspaceWindowInfo): WorkspaceWindowInfo {
  if (!value || typeof value.id !== 'string' || !value.id || value.id.length > 200 || !['restore', 'empty'].includes(value.initialState)) {
    throw new Error('The native host supplied an invalid window identity.');
  }
  return { id: value.id, initialState: value.initialState };
}
export class WorkspaceStorageScope {
  readonly windowInfo?: WorkspaceWindowInfo;
  constructor(windowInfo?: WorkspaceWindowInfo) { this.windowInfo = windowInfo; }
  sessionKey(vaultId: string): string {
    return this.windowInfo ? `zorid:workspace:window:${encodeURIComponent(this.windowInfo.id)}:${encodeURIComponent(vaultId)}` : `zorid:workspace:${vaultId}`;
  }
  draftPrefix(vaultId: string): string {
    return this.windowInfo ? `zorid:draft:window:${encodeURIComponent(this.windowInfo.id)}:${encodeURIComponent(vaultId)}` : `zorid:draft:${vaultId}`;
  }
  /** Only the stable primary window inherits old single-window data. Copy first,
   * then remove the legacy key; a failed storage write leaves recovery reachable. */
  migrateLegacy(storage: Storage, vaultId: string): void {
    if (this.windowInfo?.id !== 'main' || this.windowInfo.initialState !== 'restore') return;
    const marker = `zorid:window-migration:v1:${encodeURIComponent(vaultId)}`;
    if (storage.getItem(marker) === 'complete') return;
    const migrate = (oldKey: string, newKey: string) => {
      const value = storage.getItem(oldKey);
      if (value === null) return;
      // Never discard a divergent old recovery draft when a newer scoped one exists.
      const current = storage.getItem(newKey);
      if (current === null) storage.setItem(newKey, value);
      if (storage.getItem(newKey) === value) storage.removeItem(oldKey);
    };
    migrate(`zorid:workspace:${vaultId}`, this.sessionKey(vaultId));
    const legacyPrefix = `zorid:draft:${vaultId}:`;
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => !!key && key.startsWith(legacyPrefix));
    for (const key of keys) {
      const suffix = key.slice(legacyPrefix.length);
      // NoteBuffer appends encodeURIComponent(path). A raw colon belongs to a
      // longer vault ID, not this vault's encoded note path.
      try { if (!suffix || encodeURIComponent(decodeURIComponent(suffix)) !== suffix) continue; } catch { continue; }
      migrate(key, `${this.draftPrefix(vaultId)}:${suffix}`);
    }
    // Divergent legacy drafts remain available for manual recovery, but must not
    // resurrect after the newer scoped draft is successfully saved and removed.
    storage.setItem(marker, 'complete');
  }
}
