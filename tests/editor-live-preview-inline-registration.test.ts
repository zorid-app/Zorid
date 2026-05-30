// @vitest-environment happy-dom

import { redo, undo } from '@codemirror/commands';
import { Transaction } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  createMountedMarkdownEditor,
  markdownInlineRegistrationsToInternalRenderers,
  toggleTaskMarkerAtSelection,
  type MarkdownInlineRegistration,
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

function triStateRegistration(): MarkdownInlineRegistration {
  return {
    id: 'tri-state-task',
    priority: 100,
    syntax: [{ kind: 'task-marker', states: [' ', '/', 'x'] }],
    render(match) {
      const element = document.createElement('span');
      element.className = 'test-tri-state-task';
      element.textContent = String(match.meta?.state);
      element.setAttribute('role', 'checkbox');
      element.setAttribute('aria-checked', match.meta?.state === 'x' ? 'true' : 'mixed');
      return { kind: 'replace', widget: element };
    },
    onActivate(_event, match) {
      const state = String(match.meta?.state ?? ' ');
      const next = state === ' ' ? '/' : state === '/' ? 'x' : ' ';
      return {
        kind: 'dispatch',
        transaction: {
          changes: { from: Number(match.meta?.checkboxFrom), to: Number(match.meta?.checkboxTo), insert: next },
          userEvent: 'input.task.toggle',
        },
      };
    },
    onCopy(_event, match) {
      return { kind: 'text', text: `STATE:${String(match.meta?.state)}` };
    },
    onCut(_event, match) {
      return { kind: 'text', text: `CUT:${match.sourceText}` };
    },
  };
}

describe('editor Live Preview inline registration API', () => {
  it('exports the inline registration adapter from the public package root', () => {
    expect(markdownInlineRegistrationsToInternalRenderers([triStateRegistration()])).toHaveLength(1);
  });

  it('renders registered inline task markers and lets plugins own nonstandard states', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const text = ['- [/] blocked', '- [x] done'].join('\n');
    const editor = createMountedMarkdownEditor({ parent, text, markdownInlineRegistrations: [triStateRegistration()] });

    const widgets = [...parent.querySelectorAll<HTMLElement>('.test-tri-state-task')];
    expect(widgets.map((widget) => widget.textContent)).toEqual(['/', 'x']);
    expect(parent.querySelector('.z-live-preview-task-checkbox')).toBeNull();
    expect(editor.getText()).toBe(text);

    editor.destroy();
    parent.remove();
  });

  it('runs registered activation hooks through undoable source transactions', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const userEvents: Array<string | undefined> = [];
    const editor = createMountedMarkdownEditor({
      parent,
      text: '- [/] blocked',
      markdownInlineRegistrations: [triStateRegistration()],
      onChange: (_text, update) => userEvents.push(update.transactions.at(-1)?.annotation(Transaction.userEvent)),
    });

    parent
      .querySelector<HTMLElement>('.test-tri-state-task')
      ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));

    expect(editor.getText()).toBe('- [x] blocked');
    expect(userEvents).toEqual(['input.task.toggle']);
    expect(undo(editor.view)).toBe(true);
    expect(editor.getText()).toBe('- [/] blocked');
    expect(redo(editor.view)).toBe(true);
    expect(editor.getText()).toBe('- [x] blocked');

    editor.destroy();
    parent.remove();
  });

  it('lets registered inline syntax customize whole-token copy and cut behavior', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const doc = ['before', '- [/] blocked', 'after'].join('\n');
    const editor = createMountedMarkdownEditor({
      parent,
      text: doc,
      markdownInlineRegistrations: [triStateRegistration()],
    });

    selectSource(editor, doc, '- [/]');
    expect(dispatchClipboardEvent(editor, 'copy').getData('text/plain')).toBe('STATE:/');
    expect(editor.getText()).toBe(doc);

    selectSource(editor, doc, '- [/]');
    expect(dispatchClipboardEvent(editor, 'cut').getData('text/plain')).toBe('CUT:- [/]');
    expect(editor.getText()).toBe(['before', ' blocked', 'after'].join('\n'));
    expect(undo(editor.view)).toBe(true);
    expect(editor.getText()).toBe(doc);

    editor.destroy();
    parent.remove();
  });

  it('keeps built-in task checkbox behavior when no inline task registration is provided', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const editor = createMountedMarkdownEditor({ parent, text: '- [ ] pending' });

    expect(parent.querySelector('.z-live-preview-task-checkbox')).toBeTruthy();
    editor.view.dispatch({ selection: { anchor: editor.getText().indexOf('pending') } });
    expect(toggleTaskMarkerAtSelection(editor.view)).toBe(true);
    expect(editor.getText()).toBe('- [x] pending');

    editor.destroy();
    parent.remove();
  });
});
