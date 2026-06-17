// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { createTrustedEditorContainerContribution } from '../apps/desktop/src/renderer/src/trusted-editor-containers';
import type { EditorContainerMatchDto } from '../apps/desktop/src/renderer/src/types';
import type { EditorWindowContext } from '../packages/editor/src/editor-window-contributions.js';

const slashMatch: EditorContainerMatchDto = {
  pluginId: 'zorid.core.slash-menu',
  containerId: 'zorid.core.slash-menu.cursor',
  title: 'Slash Menu',
  placement: { kind: 'cursor-popover' },
  priority: 100,
  containerEntry: './src/editor-containers.ts',
  containerExport: 'slashMenuEditorContainer',
};

const context: EditorWindowContext = {
  documentPath: 'Today.md',
  editor: {
    hasFocus: true,
    selection: [{ from: 1, to: 1 }],
    mainCursor: 1,
    visibleRanges: [{ from: 0, to: 1 }],
    coordsAtPos: () => null,
    stateReadonly: {},
  },
};

describe('desktop trusted editor container loader', () => {
  it('adapts the allowlisted slash menu without exposing private editor APIs', () => {
    const contribution = createTrustedEditorContainerContribution({ match: slashMatch, getText: () => '/' });
    const view = contribution.render?.(context);
    expect(view?.element.textContent).toContain('Slash menu');
    expect(view?.element.querySelector('[data-editor-container="zorid.core.slash-menu.cursor"]')).toBeTruthy();
    view?.dispose?.();
    contribution.dispose?.();
  });

  it('rejects editor container metadata that does not match the trusted import map', () => {
    expect(() =>
      createTrustedEditorContainerContribution({
        match: { ...slashMatch, containerExport: 'otherExport' },
        getText: () => '/',
      }),
    ).toThrow(/not allowlisted/);
  });
});
