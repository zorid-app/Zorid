// @vitest-environment happy-dom

import { redo, undo } from '@codemirror/commands';
import { Transaction } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  createMountedMarkdownEditor,
  defaultMarkdownBlockRegistrations,
  type MarkdownBlockMatch,
  type MarkdownBlockRegistration,
  markdownBlockRegistrationsToInternalRenderers,
} from '../packages/editor/src';

class TestClipboardData {
  readonly values = new Map<string, string>();

  clearData(): void {
    this.values.clear();
  }

  setData(type: string, value: string): void {
    this.values.set(type, value);
  }

  getData(type: string): string {
    return this.values.get(type) ?? '';
  }
}

function clipboardEvent(type: 'copy' | 'cut'): { event: ClipboardEvent; data: TestClipboardData } {
  const data = new TestClipboardData();
  const event = new Event(type, { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', { value: data });
  return { event, data };
}

function dispatchClipboardEvent(
  editor: ReturnType<typeof createMountedMarkdownEditor>,
  type: 'copy' | 'cut',
): TestClipboardData {
  const { event, data } = clipboardEvent(type);
  expect(editor.view.contentDOM.dispatchEvent(event)).toBe(false);
  expect(event.defaultPrevented).toBe(true);
  return data;
}

function selectSource(editor: ReturnType<typeof createMountedMarkdownEditor>, doc: string, selected: string): void {
  const from = doc.indexOf(selected);
  if (from === -1) throw new Error(`Missing selected source: ${selected}`);
  editor.view.dispatch({ selection: { anchor: from, head: from + selected.length } });
}

function columnsRegistration(): MarkdownBlockRegistration {
  return {
    id: 'columns-widget',
    syntax: [{ kind: 'fenced-code', info: 'columns' }],
    render(match) {
      const element = document.createElement('section');
      element.className = 'test-columns-widget';
      element.dataset.kind = match.definition.kind;
      element.textContent = String(match.meta?.code ?? '');
      return element;
    },
    onCopy(_event, match) {
      return {
        kind: 'text',
        text: String(match.meta?.code ?? '')
          .replace(/---/g, '')
          .trim(),
      };
    },
    onCut(_event, match) {
      return { kind: 'text', text: `CUT:${String(match.meta?.code ?? '').trim()}` };
    },
  };
}

describe('editor Live Preview block registration API', () => {
  it('exports the registration adapter from the public package root', () => {
    expect(markdownBlockRegistrationsToInternalRenderers([columnsRegistration()])).toHaveLength(1);
  });

  it('exposes first-party default block registrations for built-in widgets', () => {
    expect(defaultMarkdownBlockRegistrations.map((registration) => registration.id)).toEqual([
      'code-block-widget',
      'callout-widget',
      'zbase-embed-widget',
    ]);
    expect(
      markdownBlockRegistrationsToInternalRenderers(defaultMarkdownBlockRegistrations).map((renderer) => renderer.id),
    ).toEqual(['code-block-widget', 'callout-widget', 'zbase-embed-widget']);
  });

  it('renders Markdown-defined fenced-code blocks through registered HTMLElement widgets', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const block = ['```columns', 'left', '---', 'right', '```'].join('\n');
    const doc = ['before', block, 'after'].join('\n');
    const editor = createMountedMarkdownEditor({
      parent,
      text: doc,
      markdownBlockRegistrations: [columnsRegistration()],
    });

    const widget = parent.querySelector<HTMLElement>('.test-columns-widget');
    expect(widget).toBeTruthy();
    expect(widget?.dataset.livePreviewRenderer).toBe('columns-widget');
    expect(widget?.dataset.kind).toBe('inline');
    expect(widget?.textContent).toContain('left');
    expect(editor.getText()).toBe(doc);

    editor.destroy();
    parent.remove();
  });

  it('matches external wikilink embeds as external block definitions', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    let captured: MarkdownBlockMatch | null = null;
    const zbaseRegistration: MarkdownBlockRegistration = {
      id: 'zbase-embed',
      syntax: [{ kind: 'embed-reference', extensions: ['.zbase'] }],
      render(match) {
        captured = match;
        const element = document.createElement('div');
        element.className = 'test-zbase-embed';
        element.textContent =
          match.definition.kind === 'external' ? `${match.definition.path}#${match.definition.fragment}` : '';
        return element;
      },
    };
    const doc = 'Dashboard: ![[views/tasks.zbase#open]]';
    const editor = createMountedMarkdownEditor({ parent, text: doc, markdownBlockRegistrations: [zbaseRegistration] });

    expect(parent.querySelector('.test-zbase-embed')?.textContent).toBe('views/tasks.zbase#open');
    expect(captured?.definition).toMatchObject({
      kind: 'external',
      sourceFrom: doc.indexOf('![[views/tasks.zbase#open]]'),
      sourceTo: doc.length,
      path: 'views/tasks.zbase',
      fragment: 'open',
      referenceSyntax: 'wikilink-embed',
    });

    editor.destroy();
    parent.remove();
  });

  it('renders a default .zbase embed widget and opens references through host actions', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const opened: Array<{ path: string; fragment?: string }> = [];
    const doc = 'Dashboard: ![[views/tasks.zbase#open]]';
    const editor = createMountedMarkdownEditor({
      parent,
      text: doc,
      onOpenReference: (target) => opened.push(target),
    });

    const widget = parent.querySelector<HTMLElement>('.z-live-preview-zbase-embed-widget');
    expect(widget).toBeTruthy();
    expect(widget?.textContent).toContain('Data view');
    expect(widget?.textContent).toContain('views/tasks.zbase#open');
    expect(editor.getText()).toBe(doc);

    widget?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));

    expect(opened).toEqual([{ path: 'views/tasks.zbase', fragment: 'open' }]);

    editor.destroy();
    parent.remove();
  });

  it('does not render .zbase embed widgets from inline code source', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const doc = 'Inline `![[views/tasks.zbase#open]]` code';
    const editor = createMountedMarkdownEditor({ parent, text: doc });

    expect(parent.querySelector('.z-live-preview-zbase-embed-widget')).toBeNull();
    expect(parent.querySelector('[data-live-preview-renderer="inline-code"]')).toBeTruthy();
    expect(parent.textContent).toContain('![[views/tasks.zbase#open]]');
    expect(editor.getText()).toBe(doc);

    editor.destroy();
    parent.remove();
  });

  it('lets a custom .zbase block registration suppress the default .zbase widget', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const zbaseRegistration: MarkdownBlockRegistration = {
      id: 'custom-zbase-embed',
      syntax: [{ kind: 'embed-reference', extensions: ['.zbase'] }],
      render(match) {
        const element = document.createElement('div');
        element.className = 'test-zbase-embed';
        element.textContent = match.definition.kind === 'external' ? match.definition.path : '';
        return element;
      },
    };
    const editor = createMountedMarkdownEditor({
      parent,
      text: 'Dashboard: ![[views/tasks.zbase#open]]',
      markdownBlockRegistrations: [zbaseRegistration],
    });

    expect(parent.querySelector('.test-zbase-embed')).toBeTruthy();
    expect(parent.querySelector('.z-live-preview-zbase-embed-widget')).toBeNull();

    editor.destroy();
    parent.remove();
  });

  it('keeps default .zbase rendering for paths outside a scoped custom registration', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const scopedZbaseRegistration: MarkdownBlockRegistration = {
      id: 'scoped-zbase-embed',
      syntax: [
        { kind: 'embed-reference', extensions: ['.zbase'], pathMatches: (path) => path === 'views/special.zbase' },
      ],
      render(match) {
        const element = document.createElement('div');
        element.className = 'test-scoped-zbase-embed';
        element.textContent = match.definition.kind === 'external' ? match.definition.path : '';
        return element;
      },
    };
    const editor = createMountedMarkdownEditor({
      parent,
      text: ['![[views/special.zbase#open]]', '![[views/general.zbase#open]]'].join('\n'),
      markdownBlockRegistrations: [scopedZbaseRegistration],
    });

    expect(parent.querySelector('.test-scoped-zbase-embed')?.textContent).toBe('views/special.zbase');
    expect(parent.querySelector('.z-live-preview-zbase-embed-widget')?.textContent).toContain(
      'views/general.zbase#open',
    );

    editor.destroy();
    parent.remove();
  });

  it('lets exact custom matcher ownership suppress the default .zbase widget for the same source range', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const source = '![[views/custom.zbase#open]]';
    const customMatcherRegistration: MarkdownBlockRegistration = {
      id: 'custom-matcher-zbase-embed',
      match({ docText }) {
        const from = docText.indexOf(source);
        if (from === -1) return [];
        const to = from + source.length;
        return [
          {
            id: `custom-matcher-zbase-embed:${from}:${to}`,
            type: 'embed-reference',
            from,
            to,
            activationFrom: from,
            activationTo: to,
            definition: {
              kind: 'external',
              sourceFrom: from,
              sourceTo: to,
              path: 'views/custom.zbase',
              fragment: 'open',
              referenceSyntax: 'wikilink-embed',
            },
            className: 'test-custom-matcher-zbase-embed',
          },
        ];
      },
      render() {
        const element = document.createElement('div');
        element.className = 'test-custom-matcher-zbase-embed';
        element.textContent = 'custom matcher';
        return element;
      },
    };
    const editor = createMountedMarkdownEditor({
      parent,
      text: source,
      markdownBlockRegistrations: [customMatcherRegistration],
    });

    expect(parent.querySelector('.test-custom-matcher-zbase-embed')?.textContent).toBe('custom matcher');
    expect(parent.querySelector('.z-live-preview-zbase-embed-widget')).toBeNull();

    editor.destroy();
    parent.remove();
  });

  it('lets a registered block fully customize whole-block copy text', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const block = ['```columns', 'left', '---', 'right', '```'].join('\n');
    const doc = ['before', block, 'after'].join('\n');
    const editor = createMountedMarkdownEditor({
      parent,
      text: doc,
      markdownBlockRegistrations: [columnsRegistration()],
    });

    selectSource(editor, doc, block);

    expect(dispatchClipboardEvent(editor, 'copy').getData('text/plain')).toBe(['left', '', 'right'].join('\n').trim());
    expect(editor.getText()).toBe(doc);

    editor.destroy();
    parent.remove();
  });

  it('lets a registered block customize cut clipboard text while the host removes source undoably', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const transactions: Transaction[] = [];
    const block = ['```columns', 'left', '```'].join('\n');
    const doc = ['before', block, 'after'].join('\n');
    const editor = createMountedMarkdownEditor({
      parent,
      text: doc,
      markdownBlockRegistrations: [columnsRegistration()],
      onChange: (_text, update) =>
        transactions.push(...update.transactions.filter((transaction) => transaction.docChanged)),
    });

    selectSource(editor, doc, block);

    expect(dispatchClipboardEvent(editor, 'cut').getData('text/plain')).toBe('CUT:left');
    expect(editor.getText()).toBe(['before', '', 'after'].join('\n'));
    expect(transactions.at(-1)?.annotation(Transaction.userEvent)).toBe('delete.cut');
    expect(undo(editor.view)).toBe(true);
    expect(editor.getText()).toBe(doc);
    expect(redo(editor.view)).toBe(true);
    expect(editor.getText()).toBe(['before', '', 'after'].join('\n'));

    editor.destroy();
    parent.remove();
  });
});

describe('editor Live Preview block interaction hooks', () => {
  it('runs HTMLElement activate/edit hooks through host-mediated actions', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const opened: Array<{ path: string; fragment?: string }> = [];
    const block = ['```columns', 'left', '```'].join('\n');
    const editor = createMountedMarkdownEditor({
      parent,
      text: block,
      markdownBlockRegistrations: [
        {
          ...columnsRegistration(),
          onActivate() {
            return { kind: 'open-reference', path: 'views/tasks.zbase', fragment: 'open' };
          },
          onEdit(_event, match) {
            return {
              kind: 'reveal-source',
              range: { from: match.definition.sourceFrom, to: match.definition.sourceTo },
            };
          },
        },
      ],
      onOpenReference: (target) => opened.push(target),
    });

    const widget = parent.querySelector<HTMLElement>('.test-columns-widget');
    expect(widget).toBeTruthy();
    widget?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(opened).toEqual([{ path: 'views/tasks.zbase', fragment: 'open' }]);

    widget?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    expect(editor.view.state.selection.main.from).toBe(0);
    expect(editor.view.state.selection.main.to).toBe(block.length);

    editor.destroy();
    parent.remove();
  });

  it('runs registered block paste hooks at the selection head', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const block = ['```columns', 'left', '```'].join('\n');
    const editor = createMountedMarkdownEditor({
      parent,
      text: block,
      markdownBlockRegistrations: [
        {
          ...columnsRegistration(),
          onPaste() {
            return {
              kind: 'dispatch',
              transaction: { changes: { from: block.length, to: block.length, insert: '\nPASTED' } },
            };
          },
        },
      ],
    });

    editor.view.dispatch({ selection: { anchor: block.indexOf('left') } });
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    expect(editor.view.contentDOM.dispatchEvent(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(editor.getText()).toBe(`${block}\nPASTED`);

    editor.destroy();
    parent.remove();
  });
});
