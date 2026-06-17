// @vitest-environment happy-dom

import { readFile } from 'node:fs/promises';
import {
  cursorCharBackward,
  cursorCharForward,
  deleteCharBackward,
  deleteCharForward,
  undo,
} from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { type EditorView, WidgetType } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LivePreviewVisibleRange } from '../packages/editor/src';
import {
  createLivePreviewContext,
  createMountedMarkdownEditor,
  defaultLivePreviewRenderers,
  filterLivePreviewRanges,
  type MarkdownBlockRegistration,
} from '../packages/editor/src/index';
import {
  collectLivePreviewRangesWithWidgetSuppression,
  collectLivePreviewWidgetRangesForVisibleRanges,
} from '../packages/editor/src/live-preview/extension';
import type {
  InternalLivePreviewRange,
  InternalLivePreviewRenderer,
} from '../packages/editor/src/live-preview/internal-types';
import {
  defaultLivePreviewInternalRenderers,
  defaultLivePreviewWidgetRenderers,
} from '../packages/editor/src/live-preview/renderers';

function collectPublicRanges(doc: string, selection = 0, focused = false) {
  const state = EditorState.create({ doc, selection: { anchor: selection } });
  const context = createLivePreviewContext(state, { from: 0, to: doc.length }, focused);
  return filterLivePreviewRanges(
    defaultLivePreviewRenderers.flatMap((renderer) => renderer.match(context)),
    context,
  );
}

function collectWidgetRanges(doc: string, selection = 0, focused = false): InternalLivePreviewRange[] {
  const state = EditorState.create({ doc, selection: { anchor: selection } });
  const context = createLivePreviewContext(state, { from: 0, to: doc.length }, focused);
  return filterLivePreviewRanges(
    defaultLivePreviewWidgetRenderers.flatMap((renderer) => renderer.match(context)),
    context,
  ) as InternalLivePreviewRange[];
}

function collectAllRanges(doc: string, selection = 0, focused = false) {
  const state = EditorState.create({ doc, selection: { anchor: selection } });
  return collectLivePreviewRangesWithWidgetSuppression(
    defaultLivePreviewRenderers,
    defaultLivePreviewInternalRenderers,
    defaultLivePreviewWidgetRenderers,
    state,
    [{ from: 0, to: doc.length }],
    focused,
  );
}

async function waitForFocusEffect(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function waitForWidgetVisibleRangeEffect(): Promise<void> {
  await new Promise((resolve) => queueMicrotask(resolve));
}

const restoreWindowOverrides = new Set<() => void>();

afterEach(() => {
  for (const restore of [...restoreWindowOverrides].reverse()) restore();
});

function testHTMLElementBlockRegistration(className = 'z-live-preview-resizing-widget'): MarkdownBlockRegistration {
  return {
    id: 'test-resizing-widget',
    match: (context) => {
      const to = context.docText.indexOf('\n');
      return [
        {
          id: 'test-resizing-widget:0',
          type: 'test-resizing-widget',
          from: 0,
          to: to < 0 ? context.docText.length : to,
          activationFrom: 0,
          activationTo: to < 0 ? context.docText.length : to,
          definition: {
            kind: 'inline',
            sourceFrom: 0,
            sourceTo: to < 0 ? context.docText.length : to,
            sourceText: context.docText.slice(0, to < 0 ? context.docText.length : to),
          },
          className,
        },
      ];
    },
    render: () => {
      const element = document.createElement('div');
      element.className = className;
      element.textContent = 'resizing preview';
      return element;
    },
  };
}

class UpdatingBlockWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }

  eq(): boolean {
    return false;
  }

  toDOM(): HTMLElement {
    const element = document.createElement('div');
    element.className = 'z-live-preview-updating-widget';
    element.textContent = this.label;
    return element;
  }

  updateDOM(dom: HTMLElement, _view: EditorView, from: WidgetType): boolean {
    if (!(from instanceof UpdatingBlockWidget)) return false;
    dom.textContent = this.label;
    return true;
  }
}

function testUpdatingWidgetRegistration(): MarkdownBlockRegistration {
  return {
    id: 'test-updating-widget',
    match: (context) => {
      const to = context.docText.indexOf('\n');
      const blockTo = to < 0 ? context.docText.length : to;
      return [
        {
          id: 'test-updating-widget:0',
          type: 'test-updating-widget',
          from: 0,
          to: blockTo,
          activationFrom: 0,
          activationTo: blockTo,
          definition: {
            kind: 'inline',
            sourceFrom: 0,
            sourceTo: blockTo,
            sourceText: context.docText.slice(0, blockTo),
          },
          className: 'z-live-preview-updating-widget',
        },
      ];
    },
    render: (match, context) => new UpdatingBlockWidget(context.sourceText(match)),
  };
}

function installResizeObserverHarness() {
  const originalResizeObserver = window.ResizeObserver;
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalCancelAnimationFrame = window.cancelAnimationFrame;
  const observerCallbacks: ResizeObserverCallback[] = [];
  const disconnects: Array<ReturnType<typeof vi.fn>> = [];
  const observerInstances: TestResizeObserver[] = [];
  const animationFrameCallbacks = new Map<number, FrameRequestCallback>();
  let nextAnimationFrame = 1;

  class TestResizeObserver implements ResizeObserver {
    readonly disconnect = vi.fn();
    readonly observedElements: Element[] = [];
    readonly observe = vi.fn((element: Element) => {
      this.observedElements.push(element);
    });
    readonly unobserve = vi.fn();

    constructor(readonly callback: ResizeObserverCallback) {
      observerCallbacks.push(callback);
      disconnects.push(this.disconnect);
      observerInstances.push(this);
    }
  }

  Object.defineProperty(window, 'ResizeObserver', {
    configurable: true,
    value: TestResizeObserver,
  });
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: vi.fn((callback: FrameRequestCallback) => {
      const id = nextAnimationFrame++;
      animationFrameCallbacks.set(id, callback);
      return id;
    }),
  });
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    value: vi.fn((id: number) => {
      animationFrameCallbacks.delete(id);
    }),
  });

  const restore = vi.fn(() => {
    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      value: originalResizeObserver,
    });
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: originalRequestAnimationFrame,
    });
    Object.defineProperty(window, 'cancelAnimationFrame', {
      configurable: true,
      value: originalCancelAnimationFrame,
    });
    restoreWindowOverrides.delete(restore);
  });
  restoreWindowOverrides.add(restore);

  return {
    triggerResize(index = 0) {
      observerCallbacks[index]?.([], {} as ResizeObserver);
    },
    triggerObservedResize(selector: string) {
      for (const observer of observerInstances) {
        if (
          observer.disconnect.mock.calls.length === 0 &&
          observer.observedElements.some((element) => element.matches(selector))
        ) {
          observer.callback([], observer);
          return;
        }
      }
    },
    flushAnimationFrames() {
      const callbacks = [...animationFrameCallbacks.values()];
      animationFrameCallbacks.clear();
      for (const callback of callbacks) callback(performance.now());
    },
    get scheduledAnimationFrameCount() {
      return animationFrameCallbacks.size;
    },
    activeObservedElementCount(selector: string) {
      return observerInstances.filter(
        (observer) =>
          observer.disconnect.mock.calls.length === 0 &&
          observer.observedElements.some((element) => element.matches(selector)),
      ).length;
    },
    disconnects,
    restore,
  };
}

describe('editor Live Preview structured widgets', () => {
  it('coalesces HTMLElement block widget resizes into one CodeMirror layout measure without dispatching', () => {
    const resizeHarness = installResizeObserverHarness();
    const parent = document.createElement('div');
    document.body.append(parent);
    const editor = createMountedMarkdownEditor({
      parent,
      text: 'resizing block\n\nparagraph',
      markdownBlockRegistrations: [testHTMLElementBlockRegistration()],
    });
    try {
      const requestMeasure = vi.spyOn(editor.view, 'requestMeasure');
      const dispatch = vi.spyOn(editor.view, 'dispatch');

      expect(parent.querySelector('.z-live-preview-resizing-widget')).toBeTruthy();
      expect(resizeHarness.activeObservedElementCount('.z-live-preview-resizing-widget')).toBe(1);
      resizeHarness.flushAnimationFrames();
      requestMeasure.mockClear();
      dispatch.mockClear();

      resizeHarness.triggerObservedResize('.z-live-preview-resizing-widget');
      resizeHarness.triggerObservedResize('.z-live-preview-resizing-widget');

      expect(resizeHarness.scheduledAnimationFrameCount).toBe(1);
      expect(requestMeasure).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();

      resizeHarness.flushAnimationFrames();

      expect(requestMeasure).toHaveBeenCalledTimes(1);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      editor.destroy();
      parent.remove();
      resizeHarness.restore();
    }
  });

  it('disconnects HTMLElement block widget resize observation and cancels pending measure on destroy', () => {
    const resizeHarness = installResizeObserverHarness();
    const parent = document.createElement('div');
    document.body.append(parent);
    const editor = createMountedMarkdownEditor({
      parent,
      text: 'resizing block\n\nparagraph',
      markdownBlockRegistrations: [testHTMLElementBlockRegistration()],
    });
    try {
      const requestMeasure = vi.spyOn(editor.view, 'requestMeasure');

      expect(resizeHarness.activeObservedElementCount('.z-live-preview-resizing-widget')).toBe(1);
      resizeHarness.flushAnimationFrames();
      requestMeasure.mockClear();

      resizeHarness.triggerObservedResize('.z-live-preview-resizing-widget');
      expect(resizeHarness.scheduledAnimationFrameCount).toBe(1);

      editor.destroy();

      expect(resizeHarness.disconnects[0]).toHaveBeenCalledTimes(1);
      expect(resizeHarness.scheduledAnimationFrameCount).toBe(0);

      resizeHarness.triggerObservedResize('.z-live-preview-resizing-widget');

      expect(resizeHarness.scheduledAnimationFrameCount).toBe(0);
      expect(requestMeasure).not.toHaveBeenCalled();
    } finally {
      editor.destroy();
      parent.remove();
      resizeHarness.restore();
    }
  });

  it('mounts HTMLElement block widgets when ResizeObserver is unavailable', () => {
    const originalResizeObserver = window.ResizeObserver;
    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      value: undefined,
    });
    const restoreResizeObserver = () => {
      Object.defineProperty(window, 'ResizeObserver', {
        configurable: true,
        value: originalResizeObserver,
      });
      restoreWindowOverrides.delete(restoreResizeObserver);
    };
    restoreWindowOverrides.add(restoreResizeObserver);

    const parent = document.createElement('div');
    document.body.append(parent);
    const editor = createMountedMarkdownEditor({
      parent,
      text: 'resizing block\n\nparagraph',
      markdownBlockRegistrations: [testHTMLElementBlockRegistration()],
    });
    try {
      expect(parent.querySelector('.z-live-preview-resizing-widget')).toBeTruthy();
    } finally {
      editor.destroy();
      parent.remove();
      restoreResizeObserver();
    }
  });

  it.each([
    ['table', ['| A | B |', '| - | - |', '| 1 | 2 |'].join('\n'), '.z-live-preview-table-widget'],
    ['code block', ['```ts', 'const value = 1;', '```'].join('\n'), '.z-live-preview-code-block-widget'],
  ])('measures first-party %s block widget resizes at the block decoration boundary', (_name, text, selector) => {
    const resizeHarness = installResizeObserverHarness();
    const parent = document.createElement('div');
    document.body.append(parent);
    const editor = createMountedMarkdownEditor({ parent, text });
    try {
      const requestMeasure = vi.spyOn(editor.view, 'requestMeasure');
      const dispatch = vi.spyOn(editor.view, 'dispatch');

      expect(parent.querySelector(selector)).toBeTruthy();
      expect(resizeHarness.activeObservedElementCount(selector)).toBe(1);
      resizeHarness.flushAnimationFrames();
      requestMeasure.mockClear();
      dispatch.mockClear();

      resizeHarness.triggerObservedResize(selector);
      resizeHarness.flushAnimationFrames();

      expect(requestMeasure).toHaveBeenCalledTimes(1);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      editor.destroy();
      parent.remove();
      resizeHarness.restore();
    }
  });

  it('keeps resize measurement through successful block widget updateDOM reuse without duplicating observers', () => {
    const resizeHarness = installResizeObserverHarness();
    const parent = document.createElement('div');
    document.body.append(parent);
    const editor = createMountedMarkdownEditor({
      parent,
      text: 'stable one\n\nparagraph',
      markdownBlockRegistrations: [testUpdatingWidgetRegistration()],
    });
    try {
      const requestMeasure = vi.spyOn(editor.view, 'requestMeasure');
      const dispatch = vi.spyOn(editor.view, 'dispatch');
      const widget = parent.querySelector<HTMLElement>('.z-live-preview-updating-widget');

      expect(widget?.textContent).toBe('stable one');
      expect(resizeHarness.activeObservedElementCount('.z-live-preview-updating-widget')).toBe(1);

      editor.view.dispatch({ changes: { from: 'stable '.length, to: 'stable one'.length, insert: 'two' } });

      expect(parent.querySelector<HTMLElement>('.z-live-preview-updating-widget')).toBe(widget);
      expect(widget?.textContent).toBe('stable two');
      expect(resizeHarness.activeObservedElementCount('.z-live-preview-updating-widget')).toBe(1);
      resizeHarness.flushAnimationFrames();
      requestMeasure.mockClear();
      dispatch.mockClear();

      resizeHarness.triggerObservedResize('.z-live-preview-updating-widget');
      resizeHarness.flushAnimationFrames();

      expect(requestMeasure).toHaveBeenCalledTimes(1);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      editor.destroy();
      parent.remove();
      resizeHarness.restore();
    }
  });

  it('does not measure non-block replace widgets for horizontal rules, lists, or tasks', () => {
    const resizeHarness = installResizeObserverHarness();
    const parent = document.createElement('div');
    document.body.append(parent);
    const editor = createMountedMarkdownEditor({
      parent,
      text: ['---', '', '- plain item', '- [ ] task'].join('\n'),
    });
    try {
      expect(parent.querySelector('.z-live-preview-horizontal-rule')).toBeTruthy();
      expect(parent.querySelector('.z-live-preview-list-marker')).toBeTruthy();
      expect(parent.querySelector('.z-live-preview-task-checkbox')).toBeTruthy();
      expect(resizeHarness.activeObservedElementCount('.z-live-preview-horizontal-rule')).toBe(0);
      expect(resizeHarness.activeObservedElementCount('.z-live-preview-list-marker')).toBe(0);
      expect(resizeHarness.activeObservedElementCount('.z-live-preview-task-checkbox')).toBe(0);
    } finally {
      editor.destroy();
      parent.remove();
      resizeHarness.restore();
    }
  });

  it('collects widget ranges from bounded visible windows rather than full document context', () => {
    const doc = [
      'intro',
      '```ts',
      'const visible = true;',
      '```',
      ...Array.from({ length: 500 }, (_, index) => `filler ${index}`),
      '```js',
      'const distant = true;',
      '```',
    ].join('\n');
    const state = EditorState.create({ doc });
    const visibleRange = { from: doc.indexOf('visible'), to: doc.indexOf('visible') + 'visible'.length };
    const contexts: LivePreviewVisibleRange[] = [];
    const recordingRenderer: InternalLivePreviewRenderer = {
      id: 'recording-widget',
      match: (context) => {
        contexts.push({ from: context.visibleFrom, to: context.visibleTo });
        return [];
      },
    };

    collectLivePreviewWidgetRangesForVisibleRanges([recordingRenderer], state, [visibleRange], false);

    expect(contexts).not.toEqual([{ from: 0, to: doc.length }]);
    expect(
      contexts.every((context) => context.from < doc.indexOf('distant') && context.to < doc.indexOf('distant')),
    ).toBe(true);
  });

  it('finds a fenced-code widget from bounded semantic-container context when the viewport is inside the block', () => {
    const doc = ['intro', '```ts', 'const visible = true;', '```', '', 'paragraph'].join('\n');
    const state = EditorState.create({ doc });
    const visibleRange = { from: doc.indexOf('visible'), to: doc.indexOf('visible') + 'visible'.length };

    const ranges = collectLivePreviewWidgetRangesForVisibleRanges(
      defaultLivePreviewWidgetRenderers,
      state,
      [visibleRange],
      false,
    );

    expect(ranges.map((range) => [range.rendererId, doc.slice(range.from, range.to)])).toEqual([
      ['code-block-widget', ['```ts', 'const visible = true;', '```'].join('\n')],
    ]);
  });

  it('dedupes widgets collected from overlapping visible windows', () => {
    const doc = ['```ts', 'const visible = true;', '```', '', 'paragraph'].join('\n');
    const state = EditorState.create({ doc });
    const visible = doc.indexOf('visible');

    const ranges = collectLivePreviewWidgetRangesForVisibleRanges(
      defaultLivePreviewWidgetRenderers,
      state,
      [
        { from: visible, to: visible + 3 },
        { from: visible + 2, to: visible + 'visible'.length },
      ],
      false,
    );

    expect(ranges.map((range) => [range.rendererId, doc.slice(range.from, range.to)])).toEqual([
      ['code-block-widget', ['```ts', 'const visible = true;', '```'].join('\n')],
    ]);
  });

  it('keeps the public renderer list free of private widget ranges', () => {
    const doc = ['```ts', 'const value = 1;', '```', '', '#tag'].join('\n');

    const ranges = collectPublicRanges(doc);

    expect(ranges.map((range) => range.rendererId)).toEqual(['tag']);
    expect(ranges.map((range) => range.kind)).not.toContain('widget');
  });

  it('emits private fenced-code widget ranges only for complete backtick and tilde fences', () => {
    const doc = [
      '```ts',
      'const value = 1;',
      '```',
      '',
      '~~~js',
      'console.log(value);',
      '~~~',
      '',
      '```unclosed',
      'raw only',
    ].join('\n');

    const ranges = collectWidgetRanges(doc);

    expect(ranges.map((range) => [range.from, range.to, range.className, range.kind])).toEqual([
      [0, 26, 'z-live-preview-code-block-widget', 'widget'],
      [28, 57, 'z-live-preview-code-block-widget', 'widget'],
    ]);
    expect(ranges.map((range) => doc.slice(range.from, range.to))).toEqual([
      ['```ts', 'const value = 1;', '```'].join('\n'),
      ['~~~js', 'console.log(value);', '~~~'].join('\n'),
    ]);
  });

  it('requires matching complete fences and leaves indented code raw', () => {
    const doc = ['````', '``` nested text', '````', '', '```', 'still raw', '~~~', '', '    ``` indented'].join('\n');
    const ranges = collectWidgetRanges(doc);

    expect(ranges.map((range) => doc.slice(range.from, range.to))).toEqual([
      ['````', '``` nested text', '````'].join('\n'),
    ]);
  });

  it('suppresses inline, task, tag, link, and blockquote renderers inside fenced code only', () => {
    const doc = [
      '```md',
      '#tag [link](target.md) [[Wiki]]',
      '- [ ] task',
      '> quote',
      '```',
      '',
      '#tag [link](target.md) [[Wiki]]',
      '- [ ] task',
      '> quote',
    ].join('\n');

    const ranges = collectAllRanges(doc);
    expect(ranges.map((range) => range.rendererId)).toEqual([
      'code-block-widget',
      'tag',
      'markdown-link',
      'markdown-link',
      'markdown-link',
      'wiki-link',
      'wiki-link',
      'wiki-link',
      'task-marker',
      'blockquote',
    ]);
    expect(ranges.filter((range) => range.rendererId === 'code-block-widget')).toHaveLength(1);
  });

  it('reveals raw fenced code while focused selection intersects the widget range', () => {
    const doc = ['```ts', 'const value = 1;', '```', '', '#tag'].join('\n');

    expect(collectAllRanges(doc, 0, false).map((range) => range.rendererId)).toEqual(['code-block-widget', 'tag']);
    expect(collectAllRanges(doc, doc.indexOf('value'), true).map((range) => range.rendererId)).toEqual(['tag']);
    expect(collectAllRanges(doc, doc.length, true).map((range) => range.rendererId)).toEqual([
      'code-block-widget',
      'tag',
    ]);
  });

  it('freezes focused widget activation boundary semantics', () => {
    const doc = ['```ts', 'const value = 1;', '```', '', 'paragraph'].join('\n');
    const widgetRange = collectWidgetRanges(doc)[0]!;

    expect(collectAllRanges(doc, widgetRange.from, true).map((range) => range.rendererId)).not.toContain(
      'code-block-widget',
    );
    expect(collectAllRanges(doc, doc.indexOf('value'), true).map((range) => range.rendererId)).not.toContain(
      'code-block-widget',
    );
    expect(collectAllRanges(doc, widgetRange.to, true).map((range) => range.rendererId)).not.toContain(
      'code-block-widget',
    );
    expect(collectAllRanges(doc, widgetRange.to + 1, true).map((range) => range.rendererId)).toContain(
      'code-block-widget',
    );
  });

  it('keeps mounted code-block widget hidden source when an unfocused selection transaction enters the block', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const text = ['```ts', 'const value = 1;', '```', '', 'paragraph'].join('\n');
    const editor = createMountedMarkdownEditor({ parent, text });

    expect(parent.querySelector('.z-live-preview-code-block-widget')).toBeTruthy();

    editor.view.dispatch({ selection: { anchor: text.indexOf('value') } });
    expect(parent.querySelector('.z-live-preview-code-block-widget')).toBeTruthy();
    expect(editor.getText()).toBe(text);

    editor.destroy();
    parent.remove();
  });

  it('suppresses and restores mounted code-block widget when focused selection enters and leaves the source range', async () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const text = ['```ts', 'const value = 1;', '```', '', 'paragraph'].join('\n');
    const editor = createMountedMarkdownEditor({ parent, text });

    expect(parent.querySelector('.z-live-preview-code-block-widget')).toBeTruthy();
    expect(editor.getText()).toBe(text);

    editor.focus();
    await waitForFocusEffect();
    editor.view.dispatch({ selection: { anchor: text.indexOf('value') } });
    expect(parent.querySelector('.z-live-preview-code-block-widget')).toBeNull();
    expect(editor.getText()).toBe(text);

    editor.view.dispatch({ selection: { anchor: text.indexOf('paragraph') } });
    expect(parent.querySelector('.z-live-preview-code-block-widget')).toBeTruthy();
    expect(editor.getText()).toBe(text);

    editor.destroy();
    parent.remove();
  });

  it('updates widget viewport state after CodeMirror update cycle without plugin crashes', async () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const text = ['```ts', 'const value = 1;', '```', '', 'paragraph'].join('\n');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const editor = createMountedMarkdownEditor({ parent, text });

    editor.view.dispatch({ changes: { from: text.length, insert: '\nmore' } });
    await waitForWidgetVisibleRangeEffect();

    expect(consoleError.mock.calls.flat().join('\n')).not.toContain('CodeMirror plugin crashed');

    editor.destroy();
    consoleError.mockRestore();
    parent.remove();
  });

  it('activates mounted code-block widget through pointer selection without changing source', async () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const text = ['```ts', 'const value = 1;', '```', '', 'paragraph'].join('\n');
    const editor = createMountedMarkdownEditor({ parent, text });

    const widget = parent.querySelector<HTMLElement>('.z-live-preview-code-block-widget');
    expect(widget).toBeTruthy();

    widget?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await waitForFocusEffect();

    expect(editor.view.state.selection.main.head).toBe(text.indexOf('const value'));
    expect(parent.querySelector('.z-live-preview-code-block-widget')).toBeNull();
    expect(editor.getText()).toBe(text);

    editor.destroy();
    parent.remove();
  });

  it('mounts code-block widget DOM with safe source-preserving text', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const text = ['```ts', '<script>alert("safe text")</script>', '```', '', 'paragraph'].join('\n');
    const editor = createMountedMarkdownEditor({ parent, text });

    const widget = parent.querySelector('.z-live-preview-code-block-widget');
    const surface = widget?.querySelector(':scope > .z-live-preview-code-block-widget__surface');
    expect(widget).toBeTruthy();
    expect(surface).toBeTruthy();
    expect(surface?.querySelector(':scope > .z-live-preview-code-block-widget__header')?.textContent).toBe('ts');
    expect(surface?.querySelector(':scope > .z-live-preview-code-block-widget__body')).toBeTruthy();
    expect(widget?.textContent).toContain('<script>alert("safe text")</script>');
    expect(widget?.querySelector('script')).toBeNull();
    expect(editor.getText()).toBe(text);

    editor.destroy();
    parent.remove();
  });

  it('documents the no-atomic-ranges policy with cursor, deletion, and reveal coverage', async () => {
    const extensionSource = await readFile('packages/editor/src/live-preview/extension.ts', 'utf8');
    const parent = document.createElement('div');
    document.body.append(parent);
    const text = ['```ts', 'const value = 1;', '```', '', 'paragraph'].join('\n');
    const widgetRange = collectWidgetRanges(text)[0]!;
    const editor = createMountedMarkdownEditor({ parent, text });

    expect(extensionSource).not.toContain('atomicRanges');
    expect(parent.querySelector('.z-live-preview-code-block-widget')).toBeTruthy();

    editor.focus();
    await waitForFocusEffect();
    editor.view.dispatch({ selection: { anchor: 0 } });
    expect(parent.querySelector('.z-live-preview-code-block-widget')).toBeNull();

    expect(cursorCharForward(editor.view)).toBe(true);
    expect(editor.view.state.selection.main.head).toBe(1);
    expect(cursorCharBackward(editor.view)).toBe(true);
    expect(editor.view.state.selection.main.head).toBe(0);
    expect(editor.getText()).toBe(text);

    expect(deleteCharForward(editor.view)).toBe(true);
    expect(editor.getText()).toBe(text.slice(1));
    expect(undo(editor.view)).toBe(true);
    expect(editor.getText()).toBe(text);

    editor.view.dispatch({ selection: { anchor: widgetRange.to } });
    expect(parent.querySelector('.z-live-preview-code-block-widget')).toBeNull();
    expect(deleteCharBackward(editor.view)).toBe(true);
    expect(editor.getText()).toBe(text.slice(0, widgetRange.to - 1) + text.slice(widgetRange.to));
    expect(undo(editor.view)).toBe(true);
    expect(editor.getText()).toBe(text);

    editor.view.dispatch({ selection: { anchor: widgetRange.to + 1 } });
    expect(parent.querySelector('.z-live-preview-code-block-widget')).toBeTruthy();
    expect(deleteCharBackward(editor.view)).toBe(true);
    expect(editor.getText()).toBe(text.slice(0, widgetRange.to) + text.slice(widgetRange.to + 1));
    expect(undo(editor.view)).toBe(true);
    expect(editor.getText()).toBe(text);

    editor.destroy();
    parent.remove();
  });
});
