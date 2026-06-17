// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { routeEditorContainerCapturedKeydown } from '../apps/desktop/src/renderer/src/editor-container-key-routing.js';
import { createTrustedEditorContainerContribution } from '../apps/desktop/src/renderer/src/trusted-editor-containers.js';
import type { EditorContainerMatchDto } from '../apps/desktop/src/renderer/src/types.js';
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

const slashContext: EditorWindowContext = {
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

describe('desktop editor container interaction wiring', () => {
  it('rerenders editor window containers when cursor or selection moves', () => {
    const source = readFileSync('apps/desktop/src/renderer/src/components/MarkdownEditor.vue', 'utf8');

    expect(source).toContain('if (update.selectionSet) renderEditorWindowHost();');
  });

  it('routes captured editor keydown events to active editor-container roots', () => {
    const host = document.createElement('div');
    const container = document.createElement('section');
    container.dataset.editorContainer = 'fixture.container';
    container.dataset.editorContainerCapturedKeys = JSON.stringify(['ArrowDown', 'Escape', 'Enter']);
    const listener = vi.fn((event: KeyboardEvent) => event.preventDefault());
    container.addEventListener('keydown', listener);
    host.append(container);

    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true, bubbles: true });
    const routed = routeEditorContainerCapturedKeydown(host, event);

    expect(routed).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0].key).toBe('ArrowDown');
    expect(event.defaultPrevented).toBe(true);
  });

  it('routes captured keys through trusted slash-menu adapter root to nested menu behavior', () => {
    const host = document.createElement('div');
    const close = vi.fn();
    const contribution = createTrustedEditorContainerContribution({ match: slashMatch, getText: () => '/', close });
    const view = contribution.render?.(slashContext);
    expect(view).toBeDefined();
    host.append(view!.element);

    expect([...host.querySelectorAll('li')].map((item) => item.dataset.selected)).toEqual(['true', 'false', 'false']);
    const arrowDown = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true, bubbles: true });
    expect(routeEditorContainerCapturedKeydown(host, arrowDown)).toBe(true);
    expect(arrowDown.defaultPrevented).toBe(true);
    expect([...host.querySelectorAll('li')].map((item) => item.dataset.selected)).toEqual(['false', 'true', 'false']);

    const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, bubbles: true });
    expect(routeEditorContainerCapturedKeydown(host, enter)).toBe(true);
    expect(close).toHaveBeenCalledWith('zorid.core.slash-menu.cursor');
    expect(host.querySelector<HTMLElement>('.z-editor-slash-menu')?.dataset.acceptedAction).toBe('Insert task');

    view?.dispose?.();
    contribution.dispose?.();
  });

  it('ignores keys not declared by active editor containers', () => {
    const host = document.createElement('div');
    const container = document.createElement('section');
    container.dataset.editorContainer = 'fixture.container';
    container.dataset.editorContainerCapturedKeys = JSON.stringify(['Escape']);
    const listener = vi.fn();
    container.addEventListener('keydown', listener);
    host.append(container);

    const event = new KeyboardEvent('keydown', { key: 'a', cancelable: true, bubbles: true });

    expect(routeEditorContainerCapturedKeydown(host, event)).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
