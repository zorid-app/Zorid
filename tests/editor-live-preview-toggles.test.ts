// @vitest-environment happy-dom

import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createMountedMarkdownEditor, defaultLivePreviewRenderers } from '../packages/editor/src/index';
import { collectLivePreviewRangesWithWidgetSuppression } from '../packages/editor/src/live-preview/extension';
import {
  defaultLivePreviewInternalRenderers,
  defaultLivePreviewWidgetRenderers,
} from '../packages/editor/src/live-preview/renderers';

function collectAllRanges(
  doc: string,
  selection = 0,
  focused = false,
  visibleRange: { readonly from: number; readonly to: number } = { from: 0, to: doc.length },
) {
  const state = EditorState.create({ doc, selection: { anchor: selection } });
  return collectLivePreviewRangesWithWidgetSuppression(
    defaultLivePreviewRenderers,
    defaultLivePreviewInternalRenderers,
    defaultLivePreviewWidgetRenderers,
    state,
    [visibleRange],
    focused,
  );
}

describe('editor Live Preview toggle projections', () => {
  it('recognizes complete toggle markers and leaves incomplete syntax plain', () => {
    const doc = ['>>+ Expanded', '    child', '', '>>- Collapsed', '    hidden child', '', '>>', '>>+', '>>-'].join(
      '\n',
    );
    const ranges = collectAllRanges(doc);

    expect(
      ranges.filter((range) => range.rendererId === 'toggle-line').map((range) => doc.slice(range.from, range.to)),
    ).toEqual(['>>+ Expanded', '>>- Collapsed']);
    expect(
      ranges
        .filter((range) => range.rendererId === 'toggle-hidden-children')
        .map((range) => doc.slice(range.from, range.to)),
    ).toEqual(['    hidden child']);
    expect(
      ranges
        .filter((range) => range.rendererId === 'toggle-structural-marker')
        .map((range) => doc.slice(range.from, range.to)),
    ).toEqual(['>>+ ', '>>- ']);
  });

  it('keeps toggle titles and children source-backed while chevrons mutate only the fold sign', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const text = ['>>- Title', '    child'].join('\n');
    const editor = createMountedMarkdownEditor({ parent, text });

    const chevron = parent.querySelector<HTMLElement>('.z-live-preview-toggle-chevron');
    expect(chevron).toBeTruthy();
    expect(chevron?.tabIndex).toBe(-1);
    expect(parent.textContent).toContain('Title');
    expect(parent.textContent).not.toContain('child');

    chevron!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 }));
    expect(editor.getText()).toBe(text);

    chevron!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    expect(editor.getText()).toBe(['>>+ Title', '    child'].join('\n'));
    expect(parent.querySelector('.z-live-preview-toggle-child-line')).toBeNull();
    expect(parent.querySelector('.cm-line.z-live-preview-toggle-line')?.textContent).toContain('Title');
    expect(parent.querySelector('.cm-line.z-live-preview-toggle-line')?.textContent).not.toContain('child');

    editor.destroy();
    parent.remove();
  });

  it('leaves expanded toggle children as normal indented markdown flow', () => {
    const text = ['>>+ Title', '    > quoted child', '    [[Linked child]]', 'after'].join('\n');
    const parent = document.createElement('div');
    document.body.append(parent);
    const editor = createMountedMarkdownEditor({ parent, text });

    const childLine = [...parent.querySelectorAll<HTMLElement>('.cm-line')].find((line) =>
      line.textContent?.includes('quoted child'),
    );

    expect(parent.querySelector('.z-live-preview-toggle-child-line')).toBeNull();
    expect(childLine?.classList.contains('z-live-preview-toggle-line')).toBe(false);
    expect(childLine?.classList.contains('z-live-preview-blockquote-line')).toBe(true);
    expect(parent.querySelector('[data-live-preview-renderer="wiki-link"]')?.textContent).toBe('Linked child');
    expect(editor.getText()).toBe(text);

    editor.destroy();
    parent.remove();
  });

  it('folds collapsed multi-line toggle children without rendering blank child rows', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const text = ['>>- Title', '    first child', '    second child', 'after'].join('\n');
    const editor = createMountedMarkdownEditor({ parent, text });

    const hiddenRows = [...parent.querySelectorAll<HTMLElement>('.cm-line.z-live-preview-toggle-hidden-children')];
    expect(hiddenRows).toHaveLength(2);
    expect(hiddenRows.map((row) => row.getAttribute('style'))).toEqual(['display: none;', 'display: none;']);
    expect(parent.textContent).not.toContain('first child');
    expect(parent.textContent).not.toContain('second child');
    expect(editor.getText()).toBe(text);

    editor.destroy();
    parent.remove();
  });

  it('derives collapsed toggle hidden-child ranges when the viewport starts below the title', () => {
    const doc = ['intro', '>>- Title', '    first child', '    second child', 'after'].join('\n');
    const firstChild = doc.indexOf('first child');
    const secondChild = doc.indexOf('second child');
    const ranges = collectAllRanges(doc, firstChild, false, { from: firstChild, to: secondChild });

    expect(
      ranges
        .filter((range) => range.rendererId === 'toggle-hidden-children')
        .map((range) => doc.slice(range.from, range.to)),
    ).toEqual(['    first child', '    second child']);
  });

  it('reveals toggle source only through structural positions and keeps collapsed children hidden until expansion', () => {
    const doc = ['>>- Title', '    child'].join('\n');
    const marker = { from: 0, to: '>>- '.length };
    const title = { from: doc.indexOf('Title'), to: doc.indexOf('Title') + 'Title'.length };
    const child = { from: doc.indexOf('child'), to: doc.indexOf('child') + 'child'.length };

    expect(collectAllRanges(doc, marker.from, true).map((range) => range.rendererId)).toEqual([
      'toggle-hidden-children',
    ]);
    expect(collectAllRanges(doc, title.from, true).map((range) => range.rendererId)).toEqual([
      'toggle-hidden-children',
    ]);
    expect(collectAllRanges(doc, child.from, true).map((range) => range.rendererId)).toEqual([
      'toggle-structural-marker',
      'toggle-line',
      'toggle-hidden-children',
    ]);

    const parent = document.createElement('div');
    document.body.append(parent);
    const editor = createMountedMarkdownEditor({ parent, text: doc });
    expect(parent.textContent).not.toContain('child');
    parent
      .querySelector<HTMLElement>('.z-live-preview-toggle-chevron')
      ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    expect(editor.getText()).toBe(['>>+ Title', '    child'].join('\n'));
    expect(parent.textContent).toContain('child');

    editor.destroy();
    parent.remove();
  });

  it('renders toggle headings with heading classes without replacing title source', () => {
    const doc = '>>+ # Heading';
    const ranges = collectAllRanges(doc);

    expect(ranges.map((range) => range.rendererId)).toEqual([
      'toggle-structural-marker',
      'toggle-line',
      'heading',
      'heading',
      'heading',
      'toggle-placeholder',
    ]);
    expect(ranges.find((range) => range.rendererId === 'toggle-line')?.className).toContain(
      'z-live-preview-heading--h1',
    );
    expect(ranges.map((range) => doc.slice(range.from, range.to))).toContain('Heading');
  });

  it('adds a visual-only empty expanded placeholder that creates a four-space child line', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const editor = createMountedMarkdownEditor({ parent, text: '>>+ Empty' });

    const placeholder = parent.querySelector<HTMLElement>('.z-live-preview-toggle-placeholder');
    expect(placeholder).toBeTruthy();
    expect(editor.getText()).toBe('>>+ Empty');
    expect(parent.textContent).toContain('Add child');

    placeholder!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    expect(editor.getText()).toBe('>>+ Empty\n    ');
    expect(editor.view.state.selection.main.head).toBe('>>+ Empty\n    '.length);

    editor.destroy();
    parent.remove();
  });
});
