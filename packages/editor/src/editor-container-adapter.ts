import type {
  EditorContainerActivationContext,
  EditorContainerContribution,
  EditorReadAPI,
  EditorSourceRange,
} from '@zorid/platform-api';
import type { Disposable, PluginId } from '@zorid/shared';
import type { DisposableView, EditorWindowContext, EditorWindowContribution } from './editor-window-contributions.js';

export interface EditorContainerAdapterOptions {
  readonly pluginId: PluginId;
  readonly contribution: EditorContainerContribution;
  readonly getText: () => string;
  readonly close?: (containerId: string) => void;
}

function clampRange(range: EditorSourceRange, length: number): EditorSourceRange {
  const from = Math.max(0, Math.min(range.from, length));
  const to = Math.max(from, Math.min(range.to, length));
  return { from, to };
}

export function createEditorReadAPI(context: EditorWindowContext, getText: () => string): EditorReadAPI {
  const text = getText();
  const selection = context.editor?.selection ?? [];
  const cursor = context.editor?.mainCursor ?? 0;
  return {
    documentPath: context.documentPath as EditorReadAPI['documentPath'],
    cursor,
    selection,
    visibleRanges: context.editor?.visibleRanges ?? [],
    getText(range) {
      if (!range) return text;
      const bounded = clampRange(range, text.length);
      return text.slice(bounded.from, bounded.to);
    },
    getCursorText(maxChars = 80) {
      const boundedCursor = Math.max(0, Math.min(cursor, text.length));
      const from = Math.max(0, boundedCursor - maxChars);
      const to = Math.min(text.length, boundedCursor + maxChars);
      return text.slice(from, to);
    },
    getSelectedText() {
      return selection.map((range) => this.getText(range)).join('\n');
    },
  };
}

function activationContext(
  pluginId: PluginId,
  contribution: EditorContainerContribution,
  context: EditorWindowContext,
  getText: () => string,
): EditorContainerActivationContext {
  return { pluginId, containerId: contribution.id, read: createEditorReadAPI(context, getText) };
}

export function adaptEditorContainerContribution({
  pluginId,
  contribution,
  getText,
  close,
}: EditorContainerAdapterOptions): EditorWindowContribution {
  const disposables: Disposable[] = [];
  let mountedRoot: HTMLElement | undefined;
  let closedWhileActive = false;
  return {
    id: contribution.id,
    placement: contribution.placement,
    ...(contribution.priority === undefined ? {} : { priority: contribution.priority }),
    render(context): DisposableView | undefined {
      const activation = activationContext(pluginId, contribution, context, getText);
      const active = contribution.shouldActivate?.(activation) ?? true;
      if (active !== true) {
        closedWhileActive = false;
        return undefined;
      }
      if (closedWhileActive) return undefined;
      mountedRoot = document.createElement('section');
      mountedRoot.dataset.editorContainer = contribution.id;
      if (contribution.input.capturedKeys && contribution.input.capturedKeys.length > 0)
        mountedRoot.dataset.editorContainerCapturedKeys = JSON.stringify(contribution.input.capturedKeys);
      void contribution.mount({
        ...activation,
        root: mountedRoot,
        placement: contribution.placement,
        input: contribution.input,
        dispose(disposable) {
          disposables.push(typeof disposable === 'function' ? { dispose: disposable } : disposable);
        },
        close: () => {
          closedWhileActive = true;
          close?.(contribution.id);
        },
      });
      return {
        element: mountedRoot,
        dispose: () => {
          for (const disposable of disposables.splice(0).reverse()) void disposable.dispose();
          mountedRoot = undefined;
        },
      };
    },
    update(context) {
      if (!mountedRoot) return;
      void contribution.update?.({
        ...activationContext(pluginId, contribution, context, getText),
        placement: contribution.placement,
      });
    },
    dispose() {
      for (const disposable of disposables.splice(0).reverse()) void disposable.dispose();
      void contribution.dispose?.();
      mountedRoot = undefined;
    },
  };
}
