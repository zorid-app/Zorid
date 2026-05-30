// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import {
  editorWindowPlacementKey,
  groupEditorWindowContributions,
  renderEditorWindowContributions,
  type EditorWindowContext,
  type EditorWindowContribution,
} from '../packages/editor/src';

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
      [
        contribution('low', { kind: 'cursor-popover' }, 1),
        contribution('high', { kind: 'cursor-popover' }, 10),
      ],
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
            return { element, dispose: () => void (disposed += 1) };
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

    expect([...parent.querySelectorAll('[data-editor-window-contribution-tab]')].map((node) => node.textContent)).toEqual([
      'link-preview',
      'ai-help',
    ]);
    expect([...parent.querySelectorAll('[data-editor-window-contribution-section]')].map((node) => node.textContent)).toEqual([
      'Link',
      'AI',
    ]);

    host.dispose();
  });
});
