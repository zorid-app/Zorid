import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('desktop file tree scoped styles', () => {
  it('uses left-pane scoped toolbar styles without replacing the generic toolbar contract', () => {
    const styles = readFileSync('apps/desktop/src/renderer/src/styles.css', 'utf8');

    expect(styles).toContain("[data-region='left-sidebar'] .file-pane-toolbar");
    expect(styles).not.toContain("[data-region='left-sidebar'] .file-pane-action,");
    expect(styles).not.toContain("[data-region='left-sidebar'] .file-pane-action:hover");
    expect(styles).not.toContain("[data-region='left-sidebar'] .file-pane-action:disabled");
    expect(styles).toContain("[data-region='left-sidebar'] .file-pane-sort");
    expect(styles).toContain('.toolbar.inline');
    expect(styles).toContain('.tree-type-label');
    expect(styles).toContain('.tree-disclosure');
  });
});
