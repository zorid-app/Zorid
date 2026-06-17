// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import {
  adaptEditorContainerContribution,
  createEditorReadAPI,
} from '../packages/editor/src/editor-container-adapter.js';
import {
  type EditorWindowContext,
  type EditorWindowContribution,
  editorWindowPlacementKey,
  groupEditorWindowContributions,
  renderEditorWindowContributions,
} from '../packages/editor/src/editor-window-contributions.js';
import type { EditorContainerContribution } from '../packages/platform-api/src/index';

const context: EditorWindowContext = {
  documentPath: 'notes/today.md',
  editor: {
    hasFocus: true,
    selection: [{ from: 4, to: 4 }],
    mainCursor: 4,
    visibleRanges: [{ from: 0, to: 20 }],
    coordsAtPos: () => new DOMRect(1, 2, 3, 4),
    stateReadonly: { readonly: true },
  },
};

type ShouldActivateReturn =
  NonNullable<EditorContainerContribution['shouldActivate']> extends (context: never) => infer Return ? Return : never;

function contribution(
  id: string,
  placement: EditorWindowContribution['placement'],
  priority?: number,
): EditorWindowContribution {
  return { id, placement, priority };
}

describe('editor window contribution grouping', () => {
  it('groups cursor popovers into a shared stacked placement ordered by priority', () => {
    const groups = groupEditorWindowContributions(
      [contribution('low', { kind: 'cursor-popover' }, 1), contribution('high', { kind: 'cursor-popover' }, 10)],
      context,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ placementKey: 'cursor-popover', mode: 'stacked', suppressed: [] });
    expect(groups[0]?.active.map((item) => item.id)).toEqual(['high', 'low']);
  });

  it('keeps different editor-window surfaces in separate groups', () => {
    const groups = groupEditorWindowContributions(
      [
        contribution('properties', { kind: 'document-header' }, 5),
        contribution('cursor-help', { kind: 'cursor-popover' }, 5),
        contribution('selection-actions', { kind: 'selection-popover' }, 5),
      ],
      context,
    );

    expect(groups.map((group) => group.placementKey).sort()).toEqual([
      'cursor-popover',
      'document-header',
      'selection-popover',
    ]);
    expect(editorWindowPlacementKey({ kind: 'document-header' })).toBe('document-header');
  });

  it('suppresses lower-priority contributions when a popover placement is exclusive', () => {
    const groups = groupEditorWindowContributions(
      [
        contribution('spellcheck', { kind: 'cursor-popover', mode: 'exclusive' }, 5),
        contribution('link-preview', { kind: 'cursor-popover', mode: 'exclusive' }, 20),
        contribution('ai-help', { kind: 'cursor-popover', mode: 'exclusive' }, 10),
      ],
      context,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.active.map((item) => item.id)).toEqual(['link-preview']);
    expect(groups[0]?.suppressed.map((item) => item.id)).toEqual(['ai-help', 'spellcheck']);
    expect(groups[0]?.diagnostics).toEqual([
      'ai-help suppressed at cursor-popover by link-preview because the placement is exclusive.',
      'spellcheck suppressed at cursor-popover by link-preview because the placement is exclusive.',
    ]);
  });

  it('filters dynamic popovers with placement predicates before grouping', () => {
    const groups = groupEditorWindowContributions(
      [
        contribution('disabled', { kind: 'cursor-popover', when: () => false }, 10),
        contribution('enabled', { kind: 'cursor-popover', when: () => true }, 1),
      ],
      context,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.active.map((item) => item.id)).toEqual(['enabled']);
  });
});

describe('editor window contribution host', () => {
  it('mounts document-header contributions and disposes rendered views', () => {
    const parent = document.createElement('div');
    let disposed = 0;
    const host = renderEditorWindowContributions({
      parent,
      context,
      contributions: [
        {
          id: 'properties',
          placement: { kind: 'document-header' },
          render() {
            const element = document.createElement('div');
            element.textContent = 'Properties';
            return {
              element,
              dispose: () => {
                disposed += 1;
              },
            };
          },
        },
      ],
    });

    expect(parent.querySelector('[data-placement-key="document-header"]')?.textContent).toBe('Properties');
    expect(parent.querySelector('[data-editor-window-contribution="properties"]')).toBeTruthy();

    host.dispose();
    expect(disposed).toBe(1);
    expect(parent.querySelector('.z-editor-window-contributions')).toBeNull();
  });

  it('renders grouped cursor popovers with tabs and sections', () => {
    const parent = document.createElement('div');
    const host = renderEditorWindowContributions({
      parent,
      context,
      contributions: [
        {
          id: 'ai-help',
          placement: { kind: 'cursor-popover' },
          priority: 1,
          render: () => Object.assign(document.createElement('div'), { textContent: 'AI' }),
        },
        {
          id: 'link-preview',
          placement: { kind: 'cursor-popover' },
          priority: 2,
          render: () => Object.assign(document.createElement('div'), { textContent: 'Link' }),
        },
      ],
    });

    expect(
      [...parent.querySelectorAll('[data-editor-window-contribution-tab]')].map((node) => node.textContent),
    ).toEqual(['link-preview', 'ai-help']);
    expect(
      [...parent.querySelectorAll('[data-editor-window-contribution-section]')].map((node) => node.textContent),
    ).toEqual(['Link', 'AI']);

    host.dispose();
  });

  it('anchors cursor popovers to the host-owned cursor coordinates', () => {
    const parent = document.createElement('div');
    parent.getBoundingClientRect = () => new DOMRect(10, 20, 200, 100);
    const host = renderEditorWindowContributions({
      parent,
      context: {
        ...context,
        editor: {
          ...context.editor!,
          mainCursor: 8,
          coordsAtPos: (position) => (position === 8 ? new DOMRect(30, 50, 2, 10) : null),
        },
      },
      contributions: [
        {
          id: 'slash-menu',
          placement: { kind: 'cursor-popover' },
          render: () => Object.assign(document.createElement('div'), { textContent: 'Slash' }),
        },
      ],
    });

    const group = parent.querySelector<HTMLElement>('[data-placement-key="cursor-popover"]');
    expect(group?.dataset.anchor).toBe('cursor');
    expect(group?.style.position).toBe('absolute');
    expect(group?.style.left).toBe('20px');
    expect(group?.style.top).toBe('40px');

    host.dispose();
  });
});

describe('editor container adapter', () => {
  it('keeps public editor container activation synchronous', () => {
    const syncOnly: ShouldActivateReturn = true;
    expect(syncOnly).toBe(true);
  });

  it('builds a safe EditorReadAPI without raw editor state', () => {
    const read = createEditorReadAPI(context, () => 'abcd/ef');
    expect(read.documentPath).toBe('notes/today.md');
    expect(read.cursor).toBe(4);
    expect(read.getText({ from: 0, to: 4 })).toBe('abcd');
    expect(read.getSelectedText()).toBe('');
    expect(JSON.stringify(read)).not.toContain('stateReadonly');
  });

  it('adapts public cursor-popover containers through mount update dispose and input policy', () => {
    const events: string[] = [];
    const adapted = adaptEditorContainerContribution({
      pluginId: 'zorid.core.test' as never,
      getText: () => '/',
      contribution: {
        id: 'test.cursor',
        title: 'Test Cursor',
        placement: { kind: 'cursor-popover' },
        input: {
          keyboardFocus: 'editor',
          textInput: 'editor',
          capturedKeys: ['ArrowUp', 'ArrowDown', 'Enter', 'Escape'],
          pointer: { hitArea: 'content' },
        },
        shouldActivate: (ctx) => ctx.read.getText({ from: ctx.read.cursor - 1, to: ctx.read.cursor }) === '/',
        mount(ctx) {
          events.push(`mount:${ctx.input.pointer?.hitArea}`);
          ctx.dispose(() => events.push('dispose-registered'));
          ctx.root.textContent = 'fixture';
        },
        update: () => events.push('update'),
        dispose: () => events.push('dispose-contribution'),
      },
    });
    const view = adapted.render?.({ ...context, editor: { ...context.editor!, mainCursor: 1 } });
    expect(view?.element.textContent).toBe('fixture');
    adapted.update?.({ ...context, editor: { ...context.editor!, mainCursor: 1 } });
    view?.dispose?.();
    adapted.dispose?.();
    expect(events).toEqual(['mount:content', 'update', 'dispose-registered', 'dispose-contribution']);
  });

  it('suppresses a closed container until activation invalidates', () => {
    let text = '/';
    let closes = 0;
    const adapted = adaptEditorContainerContribution({
      pluginId: 'zorid.core.test' as never,
      getText: () => text,
      close: () => {
        closes += 1;
      },
      contribution: {
        id: 'test.closeable',
        title: 'Closeable',
        placement: { kind: 'cursor-popover' },
        input: {
          keyboardFocus: 'editor',
          textInput: 'editor',
          capturedKeys: ['Escape'],
          pointer: { hitArea: 'content' },
        },
        shouldActivate: (ctx) => ctx.read.getText({ from: ctx.read.cursor - 1, to: ctx.read.cursor }) === '/',
        mount(ctx) {
          ctx.root.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            ctx.close();
          });
          ctx.root.textContent = 'closeable';
        },
      },
    });

    const activeContext = { ...context, editor: { ...context.editor!, mainCursor: 1 } };
    const view = adapted.render?.(activeContext);
    expect(view?.element.dataset.editorContainerCapturedKeys).toBe('["Escape"]');
    view?.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true }));
    view?.dispose?.();
    expect(closes).toBe(1);
    expect(adapted.render?.(activeContext)).toBeUndefined();

    text = '';
    expect(adapted.render?.(activeContext)).toBeUndefined();
    text = '/';
    expect(adapted.render?.(activeContext)?.element.textContent).toBe('closeable');
  });
});
