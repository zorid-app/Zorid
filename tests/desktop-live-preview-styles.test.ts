import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const livePreviewClasses = [
  'z-live-preview-heading',
  'z-live-preview-inline-code',
  'z-live-preview-strong',
  'z-live-preview-emphasis',
  'z-live-preview-strikethrough',
  'z-live-preview-highlight',
  'z-live-preview-link',
  'z-live-preview-wiki-link',
  'z-live-preview-tag',
  'z-live-preview-task-marker',
  'z-live-preview-task-checkbox',
  'z-live-preview-task-checkbox--checked',
  'z-live-preview-blockquote-line',
  'z-live-preview-code-block-widget',
  'z-live-preview-code-block-widget__header',
  'z-live-preview-code-block-widget__body',
  'z-live-preview-callout-widget',
  'z-live-preview-callout-widget__header',
  'z-live-preview-callout-widget__body',
];

describe('desktop Live Preview styles', () => {
  it('keeps the CodeMirror cursor visible on themed editor surfaces', async () => {
    const styles = await readFile('apps/desktop/src/renderer/src/styles.css', 'utf8');

    expect(styles).toMatch(/\.markdown-editor\s+\.cm-content\s*\{[^}]*caret-color:\s*var\(--z-color-accent\);[^}]*\}/s);
    expect(styles).toMatch(
      /\.markdown-editor\s+\.cm-cursor\s*\{[^}]*border-left-color:\s*var\(--z-color-accent\);[^}]*\}/s,
    );
    expect(styles).toContain('.markdown-editor .cm-selectionBackground');
    expect(styles).toContain('.markdown-editor .cm-content ::selection');
  });

  it('scopes all live-preview selectors to the markdown editor', async () => {
    const styles = await readFile('apps/desktop/src/renderer/src/styles.css', 'utf8');

    for (const className of livePreviewClasses) {
      expect(styles).toContain(`.markdown-editor .${className}`);
    }

    const selectorLines = styles
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('.z-live-preview-'));

    expect(selectorLines).not.toHaveLength(0);
    for (const selectorLine of selectorLines) {
      expect(selectorLine).toMatch(/^\.markdown-editor\s+\.z-live-preview-/);
    }

    expect(styles).not.toMatch(/\.markdown-preview-view\s+\.z-live-preview-blockquote-line/);
    expect(styles).not.toMatch(/^blockquote\s*\{/m);
  });
});
