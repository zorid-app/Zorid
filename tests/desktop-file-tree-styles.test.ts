import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('desktop file tree scoped styles', () => {
  it('uses left-pane scoped toolbar styles without replacing the generic toolbar contract', () => {
    const styles = readFileSync('apps/desktop/src/renderer/src/styles.css', 'utf8');

    expect(styles).toContain("[data-region='left-sidebar'] .file-pane-toolbar");
    expect(styles).toContain("[data-region='left-sidebar'] {");
    expect(styles).toMatch(
      /\[data-region='left-sidebar'\] \.file-pane-toolbar\s*\{[^}]*justify-content:\s*center;[^}]*gap:\s*6px;[^}]*width:\s*100%;[^}]*\}/s,
    );
    expect(styles).not.toMatch(
      /\[data-region='left-sidebar'\] \.file-pane-toolbar\s*\{[^}]*justify-content:\s*space-between;[^}]*\}/s,
    );
    expect(styles).not.toMatch(
      /\[data-region='left-sidebar'\] \.file-pane-toolbar\s*\{[^}]*justify-content:\s*space-around;[^}]*\}/s,
    );
    expect(styles).not.toMatch(
      /\[data-region='left-sidebar'\] \.file-pane-toolbar\s*\{[^}]*justify-content:\s*space-evenly;[^}]*\}/s,
    );
    expect(styles).toMatch(
      /\[data-region='left-sidebar'\] \.file-pane-toolbar \.z-icon-button\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;[^}]*\}/s,
    );
    expect(styles).toMatch(/\.rail-button\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px;[^}]*\}/s);
    expect(styles).not.toContain("[data-region='left-sidebar'] .file-pane-action,");
    expect(styles).not.toContain("[data-region='left-sidebar'] .file-pane-action:hover");
    expect(styles).not.toContain("[data-region='left-sidebar'] .file-pane-action:disabled");
    expect(styles).toContain("[data-region='left-sidebar'] .file-pane-sort");
    expect(styles).toContain('.toolbar.inline');
    expect(styles).toContain('.tree-type-label');
    expect(styles).toContain('.tree-disclosure');
    expect(styles).toContain('--activity-rail-width: 42px;');
    expect(styles).not.toContain('packages/ui-vue/src/components.css');
  });
});
