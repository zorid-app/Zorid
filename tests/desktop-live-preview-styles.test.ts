import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const livePreviewClasses = [
  'z-live-preview-heading',
  'z-live-preview-heading--h1',
  'z-live-preview-heading--h2',
  'z-live-preview-heading--h3',
  'z-live-preview-heading--h4',
  'z-live-preview-heading--h5',
  'z-live-preview-heading--h6',
  'z-live-preview-inline-code',
  'z-live-preview-strong',
  'z-live-preview-emphasis',
  'z-live-preview-strikethrough',
  'z-live-preview-highlight',
  'z-live-preview-link',
  'z-live-preview-wiki-link',
  'z-live-preview-tag',
  'z-live-preview-task-marker',
  'z-live-preview-list-marker',
  'z-live-preview-list-marker--ordered',
  'z-live-preview-task-checkbox',
  'z-live-preview-task-checkbox--checked',
  'z-live-preview-horizontal-rule',
  'z-live-preview-blockquote-line',
  'z-live-preview-code-block-widget',
  'z-live-preview-code-block-widget__header',
  'z-live-preview-code-block-widget__body',
  'z-live-preview-callout-line',
  'z-live-preview-callout-title-line',
  'z-live-preview-callout-structural-marker--title',
  'z-live-preview-callout-fold-chevron',
  'z-live-preview-callout-hidden-body',
  'z-live-preview-toggle-line',
  'z-live-preview-toggle-title-line',
  'z-live-preview-toggle-child-line',
  'z-live-preview-toggle-structural-marker',
  'z-live-preview-toggle-chevron',
  'z-live-preview-toggle-placeholder',
  'z-live-preview-toggle-hidden-children',
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

  it('prevents horizontal Markdown editor scrolling and breaks long words', async () => {
    const styles = await readFile('apps/desktop/src/renderer/src/styles.css', 'utf8');

    expect(styles).toMatch(/\.markdown-editor\s+\.cm-scroller\s*\{[^}]*overflow-x:\s*hidden;[^}]*\}/s);
    expect(styles).toMatch(/\.markdown-editor\s+\.cm-content\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*\}/s);
  });

  it('styles editor indentation guides as markdown-scoped line decorations', async () => {
    const styles = await readFile('apps/desktop/src/renderer/src/styles.css', 'utf8');

    expect(styles).toMatch(
      /\.markdown-editor\s+\.z-editor-indent-guide\s*\{[^}]*background-image:\s*repeating-linear-gradient\([^}]*\}/s,
    );
    expect(styles).toContain('leading source whitespace remains editable text');
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

  it('styles external live-preview links with a small outgoing indicator', async () => {
    const styles = await readFile('apps/desktop/src/renderer/src/styles.css', 'utf8');

    expect(styles).toMatch(
      /\.markdown-editor\s+\.z-live-preview-link\[data-live-preview-url\]::after\s*\{[^}]*content:\s*'↗';[^}]*font-size:\s*0\.72em;[^}]*\}/s,
    );
  });

  it('styles wiki links like regular links and task checkboxes like blue checked squares', async () => {
    const styles = await readFile('apps/desktop/src/renderer/src/styles.css', 'utf8');

    expect(styles).toMatch(
      /\.markdown-editor\s+\.z-live-preview-link,\s*\.markdown-editor\s+\.z-live-preview-wiki-link\s*\{/s,
    );
    expect(styles).toMatch(
      /\.markdown-editor\s+\.z-live-preview-wiki-link\s*\{[^}]*background:\s*transparent;[^}]*border-radius:\s*0;[^}]*\}/s,
    );
    expect(styles).toMatch(
      /\.markdown-editor\s+\.z-live-preview-task-checkbox--checked\s*\{[^}]*color:\s*#fff;[^}]*background:\s*var\(--z-color-accent\);[^}]*\}/s,
    );
  });

  it('styles horizontal rules as scoped separator bars', async () => {
    const styles = await readFile('apps/desktop/src/renderer/src/styles.css', 'utf8');

    expect(styles).toMatch(
      /\.markdown-editor\s+\.z-live-preview-horizontal-rule\s*\{[^}]*display:\s*block;[^}]*height:\s*1px;[^}]*background:\s*color-mix\(/s,
    );
  });

  it('animates callout folding for 120ms and snaps under reduced motion', async () => {
    const styles = await readFile('apps/desktop/src/renderer/src/styles.css', 'utf8');

    expect(styles).toMatch(
      /\.markdown-editor\s+\.z-live-preview-callout-fold-chevron\s*\{[^}]*transition:\s*transform\s+120ms\s+ease;[^}]*\}/s,
    );
    expect(styles).toMatch(
      /\.markdown-editor\s+\.z-live-preview-callout-hidden-body\s*\{[^}]*transition:\s*max-height\s+120ms\s+ease,\s*opacity\s+120ms\s+ease;[^}]*\}/s,
    );
    expect(styles).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.markdown-editor\s+\.z-live-preview-callout-fold-chevron,[^}]*\.markdown-editor\s+\.z-live-preview-toggle-chevron\s*\{[^}]*transition-duration:\s*0ms;[^}]*\}/s,
    );
  });

  it('animates toggle folding content and chevrons for 120ms and snaps under reduced motion', async () => {
    const styles = await readFile('apps/desktop/src/renderer/src/styles.css', 'utf8');

    expect(styles).toMatch(
      /\.markdown-editor\s+\.z-live-preview-toggle-chevron\s*\{[^}]*transition:\s*transform\s+120ms\s+ease;[^}]*\}/s,
    );
    expect(styles).toMatch(
      /\.markdown-editor\s+\.z-live-preview-toggle-hidden-children\s*\{[^}]*transition:\s*max-height\s+120ms\s+ease,\s*opacity\s+120ms\s+ease;[^}]*\}/s,
    );
    expect(styles).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.markdown-editor\s+\.z-live-preview-toggle-child-line,[^}]*\.markdown-editor\s+\.z-live-preview-toggle-hidden-children,[^}]*\.markdown-editor\s+\.z-live-preview-toggle-chevron\s*\{[^}]*transition-duration:\s*0ms;[^}]*\}/s,
    );
  });

  it('keeps live-preview list markers compact, muted, and scaled to 1.3x', async () => {
    const styles = await readFile('apps/desktop/src/renderer/src/styles.css', 'utf8');

    expect(styles).toMatch(
      /\.markdown-editor\s+\.z-live-preview-list-marker\s*\{[^}]*margin-right:\s*0\.2em;[^}]*color:\s*color-mix\([^}]*font-size:\s*0\.936em;[^}]*font-weight:\s*600;[^}]*\}/s,
    );
    expect(styles).toMatch(
      /\.markdown-editor\s+\.z-live-preview-task-checkbox\s*\{[^}]*width:\s*1\.235em;[^}]*height:\s*1\.235em;[^}]*font-size:\s*0\.72em;[^}]*\}/s,
    );
  });
});
