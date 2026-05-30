// @vitest-environment happy-dom

import { redo, undo } from '@codemirror/commands';
import { Transaction } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  createMountedMarkdownEditor,
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
