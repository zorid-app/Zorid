import type {
  OpenFileOptions,
  OpenViewOptions,
  PaneId,
  WorkspaceSnapshot as PublicWorkspaceSnapshot,
  ViewContribution,
  WorkspaceAPI,
} from '@zorid/platform-api';
import { type Disposable, type VaultPath, ZoridError } from '@zorid/shared';

export interface WorkspacePane {
  readonly id: string;
  readonly items: WorkspaceItem[];
  activeItemId?: string;
}
export interface WorkspaceItem {
  readonly id: string;
  readonly kind: 'file' | 'view';
  readonly title: string;
  readonly path?: VaultPath;
  readonly viewId?: string;
}
export interface WorkspaceSnapshot {
  readonly panes: readonly WorkspacePane[];
  readonly activePaneId: string;
}

export class WorkspaceService implements WorkspaceAPI {
  #panes: WorkspacePane[] = [{ id: 'pane-1', items: [] }];
  #activePaneId = 'pane-1';
  #listeners = new Set<(snapshot: PublicWorkspaceSnapshot) => void>();
  #views = new Map<string, ViewContribution>();

  activeFile(): VaultPath | undefined {
    const pane = this.#activePane();
    return pane.items.find((item) => item.id === pane.activeItemId && item.kind === 'file')?.path;
  }

  async openFile(path: VaultPath, options: OpenFileOptions = {}): Promise<PaneId> {
    const pane = this.#pane(options.paneId ?? this.#activePaneId);
    const item = {
      id: `file:${path}`,
      kind: 'file' as const,
      title: String(path).split('/').at(-1) ?? String(path),
      path,
    };
    const existing = pane.items.find((candidate) => candidate.id === item.id);
    if (!existing) pane.items.push(item);
    pane.activeItemId = item.id;
    this.#activePaneId = pane.id;
    this.#notify();
    return pane.id;
  }

  async openView(
    typeOrView: string | ViewContribution,
    inputOrOptions: unknown | OpenViewOptions = {},
    maybeOptions: OpenViewOptions = {},
  ): Promise<PaneId> {
    const contribution =
      typeof typeOrView === 'string'
        ? (this.#views.get(typeOrView) ?? { id: typeOrView, title: typeOrView, view: { mount: () => undefined } })
        : typeOrView;
    const options = typeof typeOrView === 'string' ? maybeOptions : (inputOrOptions as OpenViewOptions);
    const pane = this.#pane(options.paneId ?? this.#activePaneId);
    const item = {
      id: `view:${contribution.id}`,
      kind: 'view' as const,
      title: contribution.title,
      viewId: contribution.id,
    };
    if (!pane.items.find((candidate) => candidate.id === item.id)) pane.items.push(item);
    if (options.focus !== false) pane.activeItemId = item.id;
    this.#activePaneId = pane.id;
    this.#notify();
    return pane.id;
  }

  async split(direction: 'horizontal' | 'vertical'): Promise<PaneId> {
    return this.splitPane(this.#activePaneId, direction === 'horizontal' ? 'right' : 'down');
  }
  async splitPane(_paneId: PaneId, direction: 'left' | 'right' | 'up' | 'down'): Promise<PaneId> {
    const id = `${direction}-${this.#panes.length + 1}`;
    this.#panes.push({ id, items: [] });
    this.#activePaneId = id;
    this.#notify();
    return id;
  }

  async closePane(paneId: PaneId): Promise<void> {
    if (this.#panes.length === 1) throw new ZoridError('workspace.pane.last', 'Cannot close the final pane.');
    this.#panes = this.#panes.filter((pane) => pane.id !== paneId);
    if (this.#activePaneId === paneId) this.#activePaneId = this.#panes[0]?.id ?? 'pane-1';
    this.#notify();
  }

  registerView(contribution: ViewContribution): Disposable {
    this.#views.set(contribution.id, contribution);
    return {
      dispose: () => {
        this.#views.delete(contribution.id);
      },
    };
  }
  subscribe(listener: (snapshot: PublicWorkspaceSnapshot) => void): Disposable {
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
  }
  getSnapshot(): PublicWorkspaceSnapshot {
    return this.snapshot() as unknown as PublicWorkspaceSnapshot;
  }
  snapshot(): WorkspaceSnapshot {
    return {
      panes: this.#panes.map((pane) => ({ ...pane, items: [...pane.items] })),
      activePaneId: this.#activePaneId,
    };
  }
  restore(snapshot: WorkspaceSnapshot): void {
    this.#panes = snapshot.panes.map((pane) => ({ ...pane, items: [...pane.items] }));
    this.#activePaneId = snapshot.activePaneId;
    this.#notify();
  }
  #notify(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.#listeners) listener(snapshot);
  }
  #activePane(): WorkspacePane {
    return this.#pane(this.#activePaneId);
  }
  #pane(id: string): WorkspacePane {
    const pane = this.#panes.find((candidate) => candidate.id === id);
    if (!pane) throw new ZoridError('workspace.pane.missing', `Pane not found: ${id}`);
    return pane;
  }
}

export function createWorkspaceService(): WorkspaceService {
  return new WorkspaceService();
}
