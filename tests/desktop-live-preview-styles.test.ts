import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const livePreviewClasses = [
  'z-live-preview-heading',
  'z-live-preview-inline-code',
  'z-live-preview-link',
  'z-live-preview-wiki-link',
  'z-live-preview-tag',
  'z-live-preview-task-marker',
  'z-live-preview-blockquote-line',
  'z-live-preview-code-block-widget',
  'z-live-preview-callout-widget',
];

describe('desktop Live Preview styles', () => {
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
