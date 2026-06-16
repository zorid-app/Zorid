// @vitest-environment happy-dom

import { readFile } from 'node:fs/promises';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  collectLivePreviewRanges,
  createLivePreviewContext,
  createMountedMarkdownEditor,
  defaultLivePreviewRenderers,
  filterLivePreviewRanges,
  type LivePreviewRenderer,
  livePreviewExtension,
  livePreviewRangeIntersectsSelection,
  shouldRenderLivePreviewRange,
} from '../packages/editor/src/index';
import { collectLivePreviewRangesWithWidgetSuppression } from '../packages/editor/src/live-preview/extension';
import {
  defaultLivePreviewInternalRenderers,
  defaultLivePreviewWidgetRenderers,
} from '../packages/editor/src/live-preview/renderers';

describe('editor Live Preview primitives', () => {
  const adr0003StructuralPreviewFixture = {
    doc: ['> [!note]- Folded title', '> Hidden body', '', '- [?] Toggle title', '  - Hidden child'].join('\n'),
    callout: {
      marker: { from: 2, to: 10 },
      title: { from: 11, to: 23 },
      body: { from: 26, to: 37 },
    },
    toggle: {
      marker: { from: 39, to: 44 },
      title: { from: 45, to: 57 },
      child: { from: 62, to: 74 },
    },
  } as const;

  const renderer: LivePreviewRenderer = {
    id: 'test-emphasis',
    match: () => [
      { rendererId: 'test-emphasis', from: 0, to: 4, className: 'z-preview-a' },
      { rendererId: 'test-emphasis', from: 10, to: 14, className: 'z-preview-b' },
    ],
  };

  it('filters preview ranges by visible range deterministically', () => {
    const state = EditorState.create({ doc: '0123456789abcd' });
    const context = createLivePreviewContext(state, { from: 8, to: 12 });

    expect(collectLivePreviewRanges([renderer], context)).toEqual([
      { rendererId: 'test-emphasis', from: 10, to: 14, className: 'z-preview-b' },
    ]);
  });

  it('reveals source when focused selection intersects a preview range', () => {
    const range = { from: 5, to: 10 };

    expect(livePreviewRangeIntersectsSelection(range, [{ from: 7, to: 7 }])).toBe(true);
    expect(shouldRenderLivePreviewRange(range, { focused: true, selectionRanges: [{ from: 7, to: 7 }] })).toBe(false);
    expect(shouldRenderLivePreviewRange(range, { focused: false, selectionRanges: [{ from: 7, to: 7 }] })).toBe(true);
  });

  it('supports caret-only and never reveal policies for focused selections', () => {
    const caretOnlyRange = { from: 5, to: 10, revealPolicy: 'caret' as const };
    const neverRevealRange = { from: 5, to: 10, revealPolicy: 'never' as const };

    expect(livePreviewRangeIntersectsSelection(caretOnlyRange, [{ from: 7, to: 7 }])).toBe(true);
    expect(livePreviewRangeIntersectsSelection(caretOnlyRange, [{ from: 6, to: 9 }])).toBe(false);
    expect(shouldRenderLivePreviewRange(caretOnlyRange, { focused: true, selectionRanges: [{ from: 6, to: 9 }] })).toBe(
      true,
    );
    expect(livePreviewRangeIntersectsSelection(neverRevealRange, [{ from: 7, to: 7 }])).toBe(false);
    expect(
      shouldRenderLivePreviewRange(neverRevealRange, { focused: true, selectionRanges: [{ from: 7, to: 7 }] }),
    ).toBe(true);
  });

  it('supports structural reveal policy fixtures without mutating source text', () => {
    const { doc, callout, toggle } = adr0003StructuralPreviewFixture;
    const structuralRanges = [
      {
        from: callout.marker.from,
        to: callout.body.to,
        activationFrom: callout.marker.from,
        activationTo: callout.marker.to,
      },
      {
        from: toggle.marker.from,
        to: toggle.child.to,
        activationFrom: toggle.marker.from,
        activationTo: toggle.marker.to,
      },
    ];

    for (const range of structuralRanges) {
      expect(
        shouldRenderLivePreviewRange(range, { focused: true, selectionRanges: [{ from: range.from, to: range.from }] }),
      ).toBe(false);
      expect(
        shouldRenderLivePreviewRange(range, {
          focused: true,
          selectionRanges: [{ from: range.to - 1, to: range.to - 1 }],
        }),
      ).toBe(true);
    }

    expect(doc.slice(callout.title.from, callout.title.to)).toBe('Folded title');
    expect(doc.slice(callout.body.from, callout.body.to)).toBe('Hidden body');
    expect(doc.slice(toggle.title.from, toggle.title.to)).toBe('Toggle title');
    expect(doc.slice(toggle.child.from, toggle.child.to)).toBe('Hidden child');
    expect(adr0003StructuralPreviewFixture.doc).toBe(doc);
  });

  it('keeps non-intersecting focused ranges previewable', () => {
    expect(
      filterLivePreviewRanges(
        [
          { rendererId: 'a', from: 0, to: 3, className: 'a' },
          { rendererId: 'b', from: 5, to: 8, className: 'b' },
        ],
        { visibleFrom: 0, visibleTo: 10, focused: true, selectionRanges: [{ from: 1, to: 1 }] },
      ),
    ).toEqual([{ rendererId: 'b', from: 5, to: 8, className: 'b' }]);
  });

  it('keeps inactive ranges previewed but reveals active source while focused', () => {
    const doc = '# Heading\n\n`code`';
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.indexOf('Heading') },
    });

    const inactiveContext = createLivePreviewContext(state, { from: 0, to: doc.length }, false);
    expect(
      collectLivePreviewRanges(defaultLivePreviewRenderers, inactiveContext).map((range) => range.rendererId),
    ).toEqual(['heading', 'heading', 'heading', 'inline-code-delimiter', 'inline-code', 'inline-code-delimiter']);

    const focusedContext = createLivePreviewContext(state, { from: 0, to: doc.length }, true);
    expect(
      collectLivePreviewRanges(defaultLivePreviewRenderers, focusedContext).map((range) => range.rendererId),
    ).toEqual(['heading', 'heading', 'inline-code-delimiter', 'inline-code', 'inline-code-delimiter']);
  });

  it('adds decorations without changing source text', () => {
    const parent = document.createElement('div');
    const editor = createMountedMarkdownEditor({
      parent,
      text: '# Heading',
      extensionContributions: [{ id: 'live-preview', extension: livePreviewExtension([renderer]) }],
    });

    expect(editor.getText()).toBe('# Heading');
    expect(parent.querySelector('[data-live-preview-renderer="test-emphasis"]')).toBeTruthy();

    editor.destroy();
  });

  it('ships MVP renderers for low-risk Markdown syntax only', () => {
    const doc = [
      '# Heading',
      '',
      'Use `code` with [link](target.md), [[Wiki Link]], and #tag/sub.',
      '- [x] completed task',
      '| table | stays plain |',
      '```',
      '- [ ] fenced code sample stays plain',
      '```',
      '    - [ ] indented code sample stays plain',
    ].join('\n');
    const state = EditorState.create({ doc });
    const context = createLivePreviewContext(state, { from: 0, to: doc.length });

    const ranges = collectLivePreviewRanges(defaultLivePreviewRenderers, context);
    const rendererIds = ranges.map((range) => range.rendererId);

    expect(rendererIds).toEqual([
      'heading',
      'heading',
      'heading',
      'inline-code-delimiter',
      'inline-code',
      'inline-code-delimiter',
      'markdown-link',
      'markdown-link',
      'markdown-link',
      'wiki-link',
      'wiki-link',
      'wiki-link',
      'tag',
    ]);
    expect(
      doc.slice(
        ranges.find((range) => range.rendererId === 'tag')?.from,
        ranges.find((range) => range.rendererId === 'tag')?.to,
      ),
    ).toBe('#tag/sub');
    expect(rendererIds).not.toContain('table');
    expect(rendererIds).not.toContain('task-marker');
    expect(ranges.map((range) => doc.slice(range.from, range.to))).not.toContain('- [ ]');
    expect(ranges.map((range) => doc.slice(range.from, range.to))).not.toContain('    - [ ]');
  });

  it('keeps fenced-code task markers plain when the visible range starts inside the fence', () => {
    const doc = ['intro', '```', '- [ ] fenced code sample stays plain', '```', '- [ ] real task'].join('\n');
    const visibleFrom = doc.indexOf('fenced code sample');
    const visibleTo = doc.indexOf('```', doc.indexOf('fenced code sample'));
    const state = EditorState.create({ doc });
    const ranges = collectLivePreviewRanges(
      defaultLivePreviewRenderers,
      createLivePreviewContext(state, { from: visibleFrom, to: visibleTo }),
    );

    expect(ranges.map((range) => range.rendererId)).not.toContain('task-marker');
    expect(ranges.map((range) => doc.slice(range.from, range.to))).not.toContain('- [ ]');
  });

  it('keeps matcher ranges deterministic and avoids simple inline-code false positives', () => {
    const doc = [
      '# Heading',
      'Use `#not-a-tag [not](link.md) [[Nope]]` beside [link](target.md), [[Note|Alias]], and #tag/sub.',
      '- [ ] pending task',
      'https://example.com/#fragment',
      '| table | stays plain |',
    ].join('\n');
    const state = EditorState.create({ doc });
    const ranges = collectLivePreviewRanges(
      defaultLivePreviewRenderers,
      createLivePreviewContext(state, { from: 0, to: doc.length }),
    );

    expect(ranges.map((range) => range.rendererId)).toEqual([
      'heading',
      'heading',
      'heading',
      'inline-code-delimiter',
      'inline-code',
      'inline-code-delimiter',
      'markdown-link',
      'markdown-link',
      'markdown-link',
      'wiki-link',
      'wiki-link',
      'wiki-link',
      'tag',
    ]);
    expect(ranges.map((range) => doc.slice(range.from, range.to))).toEqual([
      '# ',
      '# ',
      'Heading',
      '`',
      '#not-a-tag [not](link.md) [[Nope]]',
      '`',
      '[',
      'link',
      '](target.md)',
      '[[Note|',
      'Alias',
      ']]',
      '#tag/sub',
    ]);
    expect(ranges.every((range, index) => index === 0 || ranges[index - 1]!.from <= range.from)).toBe(true);
    expect(ranges.map((range) => range.rendererId)).not.toContain('table');
  });

  it('renders inline markdown links only when the syntax tree includes a URL target', () => {
    const doc = '[plain] [link](target.md)';
    const state = EditorState.create({ doc });
    const ranges = collectLivePreviewRanges(
      defaultLivePreviewRenderers,
      createLivePreviewContext(state, { from: 0, to: doc.length }),
    );

    expect(ranges.map((range) => [range.rendererId, doc.slice(range.from, range.to), range.kind])).toEqual([
      ['markdown-link', '[', 'replace'],
      ['markdown-link', 'link', undefined],
      ['markdown-link', '](target.md)', 'replace'],
    ]);
  });

  it('hides inactive heading markers and marks heading content by level', () => {
    const doc = ['# Title', '### Section'].join('\n');
    const state = EditorState.create({ doc });
    const ranges = collectLivePreviewRanges(
      defaultLivePreviewRenderers,
      createLivePreviewContext(state, { from: 0, to: doc.length }),
    );

    expect(ranges.map((range) => [doc.slice(range.from, range.to), range.kind, range.className])).toEqual([
      ['# ', 'replace', 'z-live-preview-heading'],
      ['# ', undefined, 'z-live-preview-heading z-live-preview-heading--h1'],
      ['Title', undefined, 'z-live-preview-heading z-live-preview-heading--h1'],
      ['### ', 'replace', 'z-live-preview-heading'],
      ['### ', undefined, 'z-live-preview-heading z-live-preview-heading--h3'],
      ['Section', undefined, 'z-live-preview-heading z-live-preview-heading--h3'],
    ]);
  });

  it('keeps # alone plain and activates headings only after a following space', () => {
    const plainDoc = '#';
    const plainState = EditorState.create({ doc: plainDoc });
    expect(
      collectLivePreviewRanges(
        defaultLivePreviewRenderers,
        createLivePreviewContext(plainState, { from: 0, to: plainDoc.length }),
      ).filter((range) => range.rendererId === 'heading'),
    ).toEqual([]);

    const headingDoc = '# ';
    const headingState = EditorState.create({ doc: headingDoc });
    const ranges = collectLivePreviewRanges(
      defaultLivePreviewRenderers,
      createLivePreviewContext(headingState, { from: 0, to: headingDoc.length }),
    );

    expect(ranges.map((range) => [headingDoc.slice(range.from, range.to), range.kind, range.className])).toEqual([
      ['# ', 'replace', 'z-live-preview-heading'],
      ['# ', undefined, 'z-live-preview-heading z-live-preview-heading--h1'],
    ]);
  });

  it('reveals the marker with heading styling for caret editing while keeping heading content styled', () => {
    const doc = '# Title';
    const state = EditorState.create({ doc, selection: { anchor: doc.indexOf('Title') } });
    const ranges = collectLivePreviewRanges(
      defaultLivePreviewRenderers,
      createLivePreviewContext(state, { from: 0, to: doc.length }, true),
    );

    expect(ranges.map((range) => [doc.slice(range.from, range.to), range.kind, range.className])).toEqual([
      ['# ', undefined, 'z-live-preview-heading z-live-preview-heading--h1'],
      ['Title', undefined, 'z-live-preview-heading z-live-preview-heading--h1'],
    ]);
  });

  it('keeps selected headings rendered while preserving source text', () => {
    const doc = '# Title';
    const state = EditorState.create({ doc, selection: { anchor: 0, head: doc.length } });
    const ranges = collectLivePreviewRanges(
      defaultLivePreviewRenderers,
      createLivePreviewContext(state, { from: 0, to: doc.length }, true),
    );

    expect(ranges.map((range) => [doc.slice(range.from, range.to), range.kind, range.className])).toEqual([
      ['# ', 'replace', 'z-live-preview-heading'],
      ['# ', undefined, 'z-live-preview-heading z-live-preview-heading--h1'],
      ['Title', undefined, 'z-live-preview-heading z-live-preview-heading--h1'],
    ]);
    expect(state.sliceDoc(0, doc.length)).toBe('# Title');
  });

  it('hides inactive inline style delimiters while keeping styled content marks', () => {
    const doc = '**bold** *em* ~~gone~~ ==mark==';
    const state = EditorState.create({ doc });
    const ranges = collectLivePreviewRanges(
      defaultLivePreviewRenderers,
      createLivePreviewContext(state, { from: 0, to: doc.length }),
    );

    expect(ranges.map((range) => [range.rendererId, doc.slice(range.from, range.to), range.kind])).toEqual([
      ['strong', '**', 'replace'],
      ['strong', 'bold', undefined],
      ['strong', '**', 'replace'],
      ['emphasis', '*', 'replace'],
      ['emphasis', 'em', undefined],
      ['emphasis', '*', 'replace'],
      ['strikethrough', '~~', 'replace'],
      ['strikethrough', 'gone', undefined],
      ['strikethrough', '~~', 'replace'],
      ['highlight', '==', 'replace'],
      ['highlight', 'mark', undefined],
      ['highlight', '==', 'replace'],
    ]);
  });

  it('keeps inline style content rendered for content selections and reveals only touched delimiter syntax', () => {
    const doc = '**bold** *em*';
    const contentState = EditorState.create({
      doc,
      selection: { anchor: doc.indexOf('bold'), head: doc.indexOf('bold') + 2 },
    });
    const contentRanges = collectLivePreviewRanges(
      defaultLivePreviewRenderers,
      createLivePreviewContext(contentState, { from: 0, to: doc.length }, true),
    );

    expect(contentRanges.map((range) => [range.rendererId, doc.slice(range.from, range.to), range.kind])).toEqual([
      ['strong', '**', 'replace'],
      ['strong', 'bold', undefined],
      ['strong', '**', 'replace'],
      ['emphasis', '*', 'replace'],
      ['emphasis', 'em', undefined],
      ['emphasis', '*', 'replace'],
    ]);

    const delimiterState = EditorState.create({ doc, selection: { anchor: 1 } });
    const delimiterRanges = collectLivePreviewRanges(
      defaultLivePreviewRenderers,
      createLivePreviewContext(delimiterState, { from: 0, to: doc.length }, true),
    );

    expect(delimiterRanges.map((range) => [range.rendererId, doc.slice(range.from, range.to), range.kind])).toEqual([
      ['strong', 'bold', undefined],
      ['strong', '**', 'replace'],
      ['emphasis', '*', 'replace'],
      ['emphasis', 'em', undefined],
      ['emphasis', '*', 'replace'],
    ]);
    expect(delimiterState.doc.toString()).toBe(doc);
  });

  it('opens inactive rendered web links through the editor reference handler', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const opened: Array<{ path: string; fragment?: string }> = [];
    const editor = createMountedMarkdownEditor({
      parent,
      text: '[Course Requirement](https://google.com)',
      onOpenReference: (target) => opened.push(target),
    });
    const link = parent.querySelector<HTMLElement>('.z-live-preview-link[data-live-preview-url]');

    expect(link?.textContent).toBe('Course Requirement');
    link?.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));

    expect(opened).toEqual([{ path: 'https://google.com' }]);
    expect(editor.getText()).toBe('[Course Requirement](https://google.com)');

    editor.destroy();
    parent.remove();
  });

  it('renders wiki links as regular link labels and opens local references through the editor handler', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const opened: Array<{ path: string; fragment?: string }> = [];
    const editor = createMountedMarkdownEditor({
      parent,
      text: 'See [[test.md]] and [[folder/note.md#section|Note Section]]',
      onOpenReference: (target) => opened.push(target),
    });
    const links = [...parent.querySelectorAll<HTMLElement>('.z-live-preview-wiki-link[data-live-preview-reference]')];

    expect(links.map((link) => link.textContent)).toEqual(['test.md', 'Note Section']);
    expect(parent.textContent).not.toContain('[[test.md]]');
    expect(links[0]?.getAttribute('data-live-preview-reference')).toBe('test.md');
    expect(links[1]?.getAttribute('data-live-preview-reference')).toBe('folder/note.md');
    expect(links[1]?.getAttribute('data-live-preview-reference-fragment')).toBe('section');

    links[0]?.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
    links[1]?.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));

    expect(opened).toEqual([{ path: 'test.md' }, { path: 'folder/note.md', fragment: 'section' }]);
    expect(editor.getText()).toBe('See [[test.md]] and [[folder/note.md#section|Note Section]]');

    editor.destroy();
    parent.remove();
  });

  it('keeps link display text rendered for label selections and reveals touched hidden syntax', () => {
    const doc = 'See [Label](target.md) and [[Target#part|Alias]]';
    const labelState = EditorState.create({
      doc,
      selection: { anchor: doc.indexOf('Label'), head: doc.indexOf('Label') + 3 },
    });
    const labelRanges = collectLivePreviewRanges(
      defaultLivePreviewRenderers,
      createLivePreviewContext(labelState, { from: 0, to: doc.length }, true),
    );

    expect(labelRanges.map((range) => [range.rendererId, doc.slice(range.from, range.to), range.kind])).toEqual([
      ['markdown-link', '[', 'replace'],
      ['markdown-link', 'Label', undefined],
      ['markdown-link', '](target.md)', 'replace'],
      ['wiki-link', '[[Target#part|', 'replace'],
      ['wiki-link', 'Alias', undefined],
      ['wiki-link', ']]', 'replace'],
    ]);

    const syntaxState = EditorState.create({ doc, selection: { anchor: doc.indexOf('target.md') } });
    const syntaxRanges = collectLivePreviewRanges(
      defaultLivePreviewRenderers,
      createLivePreviewContext(syntaxState, { from: 0, to: doc.length }, true),
    );

    expect(syntaxRanges.map((range) => [range.rendererId, doc.slice(range.from, range.to), range.kind])).toEqual([
      ['markdown-link', '[', 'replace'],
      ['markdown-link', 'Label', undefined],
      ['wiki-link', '[[Target#part|', 'replace'],
      ['wiki-link', 'Alias', undefined],
      ['wiki-link', ']]', 'replace'],
    ]);
    expect(syntaxState.doc.toString()).toBe(doc);
  });

  it('renders complete wiki links only after closing syntax and preserves alias display text', () => {
    const doc = '[[Page|Alias]] [[Incomplete|Alias]';
    const state = EditorState.create({ doc });
    const ranges = collectLivePreviewRanges(
      defaultLivePreviewRenderers,
      createLivePreviewContext(state, { from: 0, to: doc.length }),
    ).filter((range) => range.rendererId === 'wiki-link');

    expect(ranges.map((range) => [doc.slice(range.from, range.to), range.kind])).toEqual([
      ['[[Page|', 'replace'],
      ['Alias', undefined],
      [']]', 'replace'],
    ]);
    expect(state.doc.toString()).toBe(doc);

    const missingTargetDoc = '[[|MissingTarget]]';
    const missingTargetState = EditorState.create({ doc: missingTargetDoc });
    expect(
      collectLivePreviewRanges(
        defaultLivePreviewRenderers,
        createLivePreviewContext(missingTargetState, { from: 0, to: missingTargetDoc.length }),
      ).filter((range) => range.rendererId === 'wiki-link'),
    ).toEqual([]);
  });

  it('keeps complete tags rendered while active or selected and drops preview when reduced to #', () => {
    const doc = '#math #';
    const activeState = EditorState.create({ doc, selection: { anchor: doc.indexOf('math') } });
    const selectedState = EditorState.create({ doc, selection: { anchor: 0, head: '#math'.length } });

    for (const state of [activeState, selectedState]) {
      const ranges = collectLivePreviewRanges(
        defaultLivePreviewRenderers,
        createLivePreviewContext(state, { from: 0, to: doc.length }, true),
      ).filter((range) => range.rendererId === 'tag');
      expect(ranges.map((range) => doc.slice(range.from, range.to))).toEqual(['#math']);
      expect(state.doc.toString()).toBe(doc);
    }

    const reducedDoc = '#';
    const reducedState = EditorState.create({ doc: reducedDoc, selection: { anchor: 1 } });
    expect(
      collectLivePreviewRanges(
        defaultLivePreviewRenderers,
        createLivePreviewContext(reducedState, { from: 0, to: reducedDoc.length }, true),
      ).filter((range) => range.rendererId === 'tag'),
    ).toEqual([]);
  });

  it('keeps heading content rendered while focused caret reveals heading source marker', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const editor = createMountedMarkdownEditor({
      parent,
      text: '# Heading\n\n`code`',
    });

    expect(parent.querySelector('[data-live-preview-renderer="heading"]')).toBeTruthy();

    editor.focus();
    editor.view.dispatch({ selection: { anchor: 2 } });
    expect(
      [...parent.querySelectorAll('[data-live-preview-renderer="heading"]')].map((node) => node.textContent),
    ).toEqual(['# ', 'Heading']);
    expect(parent.querySelector('[data-live-preview-renderer="inline-code"]')).toBeTruthy();

    editor.view.dispatch({ selection: { anchor: editor.getText().length } });
    expect(parent.querySelector('[data-live-preview-renderer="heading"]')).toBeTruthy();

    editor.destroy();
    parent.remove();
  });

  it('keeps public defaults free of private line and widget projection ranges', async () => {
    const doc = ['> quote', '- [ ] pending task', '```ts', 'code', '```'].join('\n');
    const state = EditorState.create({ doc });
    const ranges = collectLivePreviewRanges(
      defaultLivePreviewRenderers,
      createLivePreviewContext(state, { from: 0, to: doc.length }),
    );
    const rendererSource = await readFile('packages/editor/src/live-preview/renderers.ts', 'utf8');
    const rootBarrelSource = await readFile('packages/editor/src/index.ts', 'utf8');
    const livePreviewBarrelSource = await readFile('packages/editor/src/live-preview/index.ts', 'utf8');

    expect(ranges.map((range) => range.rendererId)).toEqual([]);
    expect(defaultLivePreviewRenderers.map((renderer) => renderer.id)).not.toEqual(
      expect.arrayContaining(['blockquote', 'task-marker', 'code-block-widget', 'callout-widget']),
    );
    expect(rendererSource).not.toContain('as LivePreviewRenderer');
    expect(rootBarrelSource).not.toContain('taskMarkerLivePreviewRenderer');
    expect(livePreviewBarrelSource).not.toContain('taskMarkerLivePreviewRenderer');
    expect(state.doc.toString()).toBe(doc);
  });

  it('keeps task marker preview source-preserving as a private visual checkbox projection', () => {
    const doc = '- [ ] pending task';
    const state = EditorState.create({ doc });
    const ranges = collectLivePreviewRangesWithWidgetSuppression(
      defaultLivePreviewRenderers,
      defaultLivePreviewInternalRenderers,
      defaultLivePreviewWidgetRenderers,
      state,
      [{ from: 0, to: doc.length }],
      false,
    );

    expect(ranges).toContainEqual(
      expect.objectContaining({
        rendererId: 'task-marker',
        from: 0,
        to: 5,
        className: 'z-live-preview-task-checkbox',
        kind: 'replace',
      }),
    );
    expect(state.doc.toString()).toBe(doc);
    expect(ranges.find((range) => range.rendererId === 'task-marker')?.attributes).toBeUndefined();
  });

  it('wires public and private first-party preview renderers into mounted default editors', () => {
    const parent = document.createElement('div');
    const editor = createMountedMarkdownEditor({
      parent,
      text: ['# Heading', '', 'See [[Note]] and #tag.', '', '> quote', '- bullet', '- [ ] task'].join('\n'),
    });

    expect(parent.querySelector('[data-live-preview-renderer="heading"]')).toBeTruthy();
    expect(parent.querySelector('[data-live-preview-renderer="wiki-link"]')).toBeTruthy();
    expect(parent.querySelector('[data-live-preview-renderer="tag"]')).toBeTruthy();
    expect(parent.querySelector('.cm-line.z-live-preview-blockquote-line')).toBeTruthy();
    expect(parent.querySelectorAll('.z-live-preview-list-marker')).toHaveLength(1);
    expect(parent.querySelector('.z-live-preview-task-checkbox')).toBeTruthy();
    expect(editor.getText()).toContain('- [ ] task');

    editor.destroy();
  });

  it('renders unordered and ordered list markers without mutating or normalizing source delimiters', () => {
    const text = [
      '- dash',
      '* star',
      '+ plus',
      '- ',
      '* ',
      '+ ',
      '-',
      '*',
      '+',
      '3. dot',
      '4) paren',
      '5. ',
      '6) ',
      '7.',
      '8)',
    ].join('\n');
    const parent = document.createElement('div');
    const editor = createMountedMarkdownEditor({ parent, text });

    const markers = [...parent.querySelectorAll<HTMLElement>('.z-live-preview-list-marker')];

    expect(markers.map((marker) => marker.textContent)).toEqual(['•', '•', '•', '•', '•', '•', '3.', '4)', '5.', '6)']);
    expect(editor.getText()).toBe(text);

    editor.destroy();
  });

  it('projects indentation guides only for nonblank real leading indentation without replacing source', () => {
    const text = ['    child', '\ttab child', '  shallow', 'plain', '    ', '', '>>+ Toggle', '    toggle child'].join(
      '\n',
    );
    const parent = document.createElement('div');
    const editor = createMountedMarkdownEditor({ parent, text });

    const guideLines = [...parent.querySelectorAll<HTMLElement>('.cm-line.z-editor-indent-guide')];

    expect(guideLines.map((line) => line.getAttribute('data-indent-depth'))).toEqual(['1', '1', '1']);
    expect(guideLines.map((line) => line.textContent)).toEqual(['    child', '\ttab child', '    toggle child']);
    expect(parent.querySelectorAll('.z-editor-indent-guide [contenteditable="false"]')).toHaveLength(0);
    expect(editor.getText()).toBe(text);

    editor.destroy();
  });

  it('keeps explicit livePreviewRenderers customization on the public renderer path only', () => {
    const parent = document.createElement('div');
    const editor = createMountedMarkdownEditor({
      parent,
      text: ['# Heading', '> quote', '- [ ] task'].join('\n'),
      livePreviewRenderers: [renderer],
    });

    expect(parent.querySelector('[data-live-preview-renderer="test-emphasis"]')).toBeTruthy();
    expect(parent.querySelector('[data-live-preview-renderer="heading"]')).toBeNull();
    expect(parent.querySelector('.cm-line.z-live-preview-blockquote-line')).toBeNull();
    expect(parent.querySelector('.z-live-preview-task-checkbox')).toBeNull();
    expect(editor.getText()).toBe(['# Heading', '> quote', '- [ ] task'].join('\n'));

    editor.destroy();
  });

  it('hides inactive inline-code delimiters, suppresses nested markdown, and reveals touched delimiter syntax', () => {
    const doc = 'Use `code` here';
    const inactiveState = EditorState.create({ doc, selection: { anchor: 0 } });
    const inactiveRanges = collectLivePreviewRanges(
      defaultLivePreviewRenderers,
      createLivePreviewContext(inactiveState, { from: 0, to: doc.length }, true),
    );
    expect(inactiveRanges.map((range) => [range.rendererId, doc.slice(range.from, range.to), range.kind])).toEqual([
      ['inline-code-delimiter', '`', 'replace'],
      ['inline-code', 'code', undefined],
      ['inline-code-delimiter', '`', 'replace'],
    ]);
    expect(inactiveState.doc.toString()).toBe(doc);

    const activeState = EditorState.create({ doc, selection: { anchor: doc.indexOf('code') + 1 } });
    const activeRanges = collectLivePreviewRanges(
      defaultLivePreviewRenderers,
      createLivePreviewContext(activeState, { from: 0, to: doc.length }, true),
    );
    expect(activeRanges.map((range) => [range.rendererId, doc.slice(range.from, range.to), range.kind])).toEqual([
      ['inline-code-delimiter', '`', 'replace'],
      ['inline-code', 'code', undefined],
      ['inline-code-delimiter', '`', 'replace'],
    ]);
    expect(activeState.doc.toString()).toBe(doc);

    const delimiterState = EditorState.create({ doc, selection: { anchor: doc.indexOf('`') } });
    const delimiterRanges = collectLivePreviewRanges(
      defaultLivePreviewRenderers,
      createLivePreviewContext(delimiterState, { from: 0, to: doc.length }, true),
    );
    expect(delimiterRanges.map((range) => [range.rendererId, doc.slice(range.from, range.to), range.kind])).toEqual([
      ['inline-code', 'code', undefined],
      ['inline-code-delimiter', '`', 'replace'],
    ]);

    const nestedDoc = 'Use `#not-a-tag [not](link.md) [[Nope]]` here';
    const nestedState = EditorState.create({ doc: nestedDoc });
    expect(
      collectLivePreviewRanges(
        defaultLivePreviewRenderers,
        createLivePreviewContext(nestedState, { from: 0, to: nestedDoc.length }),
      ).map((range) => range.rendererId),
    ).toEqual(['inline-code-delimiter', 'inline-code', 'inline-code-delimiter']);
  });

  it('keeps save shortcut wiring inside the mounted editor factory', () => {
    const parent = document.createElement('div');
    let saves = 0;
    const editor = createMountedMarkdownEditor({
      parent,
      text: 'save me',
      onSave: () => {
        saves += 1;
      },
    });

    editor.focus();
    editor.view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }),
    );

    expect(saves).toBe(1);

    editor.destroy();
  });
});
