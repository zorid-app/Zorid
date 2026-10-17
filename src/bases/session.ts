import { BaseController, createBaseMutationHost } from './controller.ts';
import type { BaseBufferHost, BaseControllerState } from './controller.ts';
import { BaseDocument } from './document.ts';
import { createBaseViewActions } from './view-actions.ts';
import { createBaseTableView } from './table-view.ts';
import { createBaseCardsView } from './cards-view.ts';
import type { BaseCardsViewOptions } from './cards-view.ts';
import { createBaseListView } from './list-view.ts';
import { createBaseKanbanView } from './kanban-view.ts';
import type { BaseQueryOptions, BaseQueryResult } from './query.ts';
import type { Vault } from '../core/vault.ts';
import type { NoteBuffer } from '../ui/note-buffer.ts';

export interface BaseSessionOptions {
  readonly vault: Vault;
  readonly basePath: string;
  /** Workspace and writable embeds must share their existing buffer registry. */
  readonly buffers?: BaseBufferHost;
  readonly readOnly?: boolean;
  readonly query?: BaseQueryOptions;
  readonly openFile: (path: string, event: MouseEvent | KeyboardEvent) => void;
  readonly validate: () => void;
  readonly loadThumbnail?: BaseCardsViewOptions['loadThumbnail'];
  readonly onState?: (state: BaseControllerState) => void;
  readonly onError?: (error: unknown) => void;
}
export interface BaseSession {
  readonly ready: Promise<void>;
  readonly state: BaseControllerState;
  refresh(): Promise<void>;
  selectView(index: number): Promise<void>;
  /** Workspace preflight: retain the mounted view while settling accepted edits. */
  flush(): Promise<void>;
  hasPendingChanges(): boolean;
  /** Retains UI/controller on failure; callers must not silently discard this rejection. */
  close(): Promise<void>;
}
interface MountedView {
  update(result: BaseQueryResult): void;
  destroy(): void;
  hasActiveEdits?(): boolean;
}

/** Compose existing Bases modules for a workspace pane or an embedded base. */
export function createBaseSession(container: HTMLElement, options: BaseSessionOptions): BaseSession {
  options.validate();
  if (!options.readOnly && !options.buffers) throw new Error('Writable Bases require the shared workspace buffer host');
  const doc = container.ownerDocument, win = doc.defaultView;
  const root = doc.createElement('div'), toolbar = doc.createElement('div'), selector = doc.createElement('select');
  const content = doc.createElement('div'), status = doc.createElement('div');
  root.className = 'bases-session'; toolbar.className = 'bases-session-toolbar'; content.className = 'bases-session-content';
  selector.setAttribute('aria-label', 'Base view'); status.className = 'bases-session-status'; status.setAttribute('role', 'status');
  toolbar.append(selector); root.append(toolbar, content, status); container.append(root);
  let disposed = false, closing = false, mounted: MountedView | undefined, mountedType: string | undefined;
  let mountedResult: BaseQueryResult | undefined, deferred: BaseControllerState | undefined;
  let mountedIndex = -1, mountedMove = false;
  let propertyLabels: unknown;
  let selectedIndex = options.query?.viewIndex ?? 0;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  const pending = new Set<Promise<unknown>>(), changedBuffers = new Set<NoteBuffer>();
  const alive = () => { options.validate(); if (disposed) throw new Error('This base view is closed'); };
  const action = () => { alive(); if (closing) throw new Error('This base view is closing'); };
  const report = (error: unknown) => {
    if (!disposed) status.textContent = error instanceof Error ? error.message : String(error);
    try { options.onError?.(error); } catch { /* User error reporters do not change persistence. */ }
  };
  const activeDraft = () => !!mounted?.hasActiveEdits?.() || !!content.querySelector('.zorid-bases-table-input, .bases-rendered-value input:not([type="checkbox"])');
  const schedule = () => {
    if (disposed || scheduled !== undefined) return;
    scheduled = setTimeout(() => { scheduled = undefined; if (deferred && !pending.size && !activeDraft()) { deferred = undefined; render(controller.state); } }, 0);
  };
  const releaseCleanBuffers = () => { for (const buffer of changedBuffers) if (!buffer.dirty && !buffer.error) changedBuffers.delete(buffer); };
  const track = <T>(operation: () => Promise<T>): Promise<T> => {
    action();
    const promise = operation(); pending.add(promise);
    const settled = () => {
      pending.delete(promise);
      releaseCleanBuffers();
      schedule();
    };
    void promise.then(settled, error => { settled(); report(error); });
    return promise;
  };
  const mutations = options.buffers ? createBaseMutationHost({ ...options.buffers,
    validate() { alive(); options.buffers!.validate(); },
    onBufferChange(path, buffer, previousText) {
      changedBuffers.add(buffer);
      options.buffers!.onBufferChange?.(path, buffer, previousText);
    },
  }) : { async transform() { throw new Error('This base is read-only'); } };
  const controller = new BaseController({ vault: options.vault, basePath: options.basePath, mutations, query: options.query,
    onChange(state) { render(state); options.onState?.(state); },
  });
  const actions = createBaseViewActions(controller, { validate: action, canRename: !!options.buffers?.rename,
    validateFolder(path) { if (path && options.vault.entries.get(path)?.type !== 'folder') throw new Error('The destination folder no longer exists'); },
  });
  function render(state: BaseControllerState): void {
    if (disposed) return;
    if (state.error) { deferred = undefined; status.textContent = state.error.message; return; }
    if (!state.result) return;
    if (pending.size || activeDraft()) { deferred = state; return; }
    deferred = undefined;
    const result = state.result;
    if (mountedResult === result) return;
    const document = BaseDocument.parse(state.source);
    const choices = document.views;
    selector.replaceChildren(...choices.map((view, index) => {
      const option = doc.createElement('option'); option.value = String(index); option.textContent = view.name; return option;
    }));
    selector.value = String(selectedIndex);
    propertyLabels = document.getRoot('properties');
    const getPropertyLabel = (property: string) => {
      if (propertyLabels && typeof propertyLabels === 'object' && !Array.isArray(propertyLabels)) {
        const config = (propertyLabels as Record<string, unknown>)[property] ?? (propertyLabels as Record<string, unknown>)[property.replace(/^note\./, '')];
        if (config && typeof config === 'object' && 'displayName' in config && typeof config.displayName === 'string') return config.displayName;
      }
      return property.replace(/^(?:note|file|formula)\./, '');
    };
    const writable = !options.readOnly;
    const shared = { result, getPropertyLabel,
      openFile(path: string, event: MouseEvent | KeyboardEvent) { try { action(); options.openFile(path, event); } catch (error) { report(error); } },
      ...(writable ? { editProperty: (edit: Parameters<typeof actions.editProperty>[0]) => track(() => actions.editProperty(edit)) } : {}),
      onError: report, onEditStateChange: schedule,
    };
    const moveEnabled = writable && actions.canMove(result);
    if (mounted && mountedType === result.view.type && mountedIndex === selectedIndex && mountedMove === moveEnabled) mounted.update(result);
    else {
      mounted?.destroy(); mounted = undefined; content.replaceChildren();
      switch (result.view.type) {
        case 'table': mounted = createBaseTableView(content, shared); break;
        case 'cards': mounted = createBaseCardsView(content, { ...shared, loadThumbnail: options.loadThumbnail }); break;
        case 'list': mounted = createBaseListView(content, shared); break;
        case 'kanban': mounted = createBaseKanbanView(content, { result, openFile: shared.openFile, onError: report,
          readOnly: !writable,
          ...(moveEnabled ? { requestMove: request => track(() => actions.requestMove(request)) } : {}),
          ...(writable ? { requestGroupOrder: request => track(() => actions.requestGroupOrder(request)) } : {}),
        }); break;
        default: content.textContent = `Unsupported base view: ${result.view.type}`;
      }
      mountedType = result.view.type; mountedIndex = selectedIndex; mountedMove = moveEnabled;
    }
    mountedResult = result; status.textContent = '';
  }
  const observer = win?.MutationObserver ? new win.MutationObserver(schedule) : undefined;
  observer?.observe(content, { subtree: true, childList: true });
  async function selectView(index: number): Promise<void> {
    action();
    if (pending.size || activeDraft()) throw new Error('Finish or cancel the property edit before switching views');
    const views = BaseDocument.parse(controller.state.source).views;
    if (!Number.isInteger(index) || index < 0 || index >= views.length) throw new Error('The selected base view does not exist');
    selectedIndex = index; await controller.setView(index);
  }
  selector.addEventListener('change', () => { void selectView(Number(selector.value)).catch(error => { selector.value = String(selectedIndex); report(error); }); });
  async function settle(): Promise<void> {
    await Promise.allSettled([...pending]);
    // Let property widgets finish handling their accepted/rejected operations.
    await Promise.resolve();
    for (const buffer of changedBuffers) await buffer.flush();
    releaseCleanBuffers();
    if (activeDraft()) throw new Error('Finish or cancel the property edit before leaving this base');
  }
  async function finish(close: boolean): Promise<void> {
    if (disposed) return;
    if (closing) throw new Error('This base view is already finishing edits');
    closing = true;
    try {
      await settle();
      if (close) {
        mounted?.destroy(); mounted = undefined; observer?.disconnect();
        if (scheduled !== undefined) clearTimeout(scheduled);
        controller.dispose(); disposed = true; root.remove();
      }
    } catch (error) { report(error); throw error; }
    finally { closing = false; }
  }
  return {
    ready: controller.refresh(),
    get state() { return controller.state; },
    refresh: () => controller.refresh(),
    selectView,
    hasPendingChanges: () => !disposed && (!!pending.size || activeDraft() || [...changedBuffers].some(buffer => buffer.dirty || !!buffer.error)),
    flush: () => finish(false),
    close: () => finish(true),
  };
}
