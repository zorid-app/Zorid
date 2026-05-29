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

  it('keeps titlebar controls on the same grid as the pane resize columns', () => {
    const styles = readFileSync('apps/desktop/src/renderer/src/styles.css', 'utf8');
    const app = readFileSync('apps/desktop/src/renderer/src/App.vue', 'utf8');

    expect(app).toContain("'--resize-handle-half-width': `${SHELL_LAYOUT.resizeHandleWidth / 2}px`");
    expect(styles).toMatch(
      /\.editor-titlebar\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*var\(--activity-rail-width\) var\(--left-sidebar-width\) var\(--resize-handle-width\)/s,
    );
    expect(styles).toMatch(
      /\.titlebar-left-actions\s*\{[^}]*grid-column:\s*1\s*\/\s*4;[^}]*border-right:\s*0;[^}]*\}/s,
    );
    expect(styles).toMatch(/\.top-tab-strip\s*\{[^}]*grid-column:\s*4;[^}]*\}/s);
    expect(styles).toMatch(
      /\.titlebar-right-actions\s*\{[^}]*grid-column:\s*5\s*\/\s*7;[^}]*border-left:\s*0;[^}]*\}/s,
    );
    expect(styles).toMatch(
      /\.zorid-shell::before\s*\{[^}]*left:\s*calc\(var\(--activity-rail-width\) \+ var\(--left-sidebar-width\) \+ var\(--resize-handle-half-width\)\);[^}]*\}/s,
    );
    expect(styles).toMatch(
      /\.zorid-shell::after\s*\{[^}]*right:\s*calc\(var\(--right-sidebar-width\) \+ var\(--resize-handle-half-width\)\);[^}]*\}/s,
    );
  });
});
