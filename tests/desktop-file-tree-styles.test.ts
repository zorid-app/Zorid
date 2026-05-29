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
    expect(app).toContain("'--titlebar-pane-toggle-width': `${SHELL_LAYOUT.titlebarPaneToggleWidth}px`");
    expect(styles).toMatch(
      /--titlebar-left-width:\s*max\([^;]*var\(--activity-rail-width\)[^;]*var\(--traffic-light-space\)[^;]*var\(--titlebar-pane-toggle-width\)[^;]*\);/s,
    );
    expect(styles).toMatch(
      /--titlebar-right-width:\s*max\([^;]*var\(--right-sidebar-width\)[^;]*var\(--titlebar-pane-toggle-width\)[^;]*\);/s,
    );
    expect(styles).toMatch(
      /\.editor-titlebar\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*var\(--titlebar-left-width\) minmax\(420px, 1fr\) var\(--titlebar-right-width\)/s,
    );
    expect(styles).toMatch(/\.editor-titlebar\s*\{[^}]*transition:\s*grid-template-columns 180ms ease;[^}]*\}/s);
    expect(styles).toMatch(
      /\.titlebar-left-actions\s*\{[^}]*grid-column:\s*1;[^}]*padding-left:\s*max\(8px, calc\(var\(--traffic-light-space\) \+ 8px\)\);[^}]*border-right:\s*0;[^}]*\}/s,
    );
    expect(styles).not.toContain(".editor-titlebar[data-left-collapsed='true'] .titlebar-left-actions");
    expect(styles).toMatch(/\.top-tab-strip\s*\{[^}]*grid-column:\s*2;[^}]*\}/s);
    expect(styles).toMatch(/\.titlebar-right-actions\s*\{[^}]*grid-column:\s*3;[^}]*border-left:\s*0;[^}]*\}/s);
    expect(styles).toMatch(
      /\.zorid-shell::before\s*\{[^}]*left:\s*calc\(var\(--activity-rail-width\) \+ var\(--left-sidebar-width\) \+ var\(--resize-handle-half-width\)\);[^}]*\}/s,
    );
    expect(styles).toMatch(
      /\.zorid-shell::after\s*\{[^}]*right:\s*calc\(var\(--right-sidebar-width\) \+ var\(--resize-handle-half-width\)\);[^}]*\}/s,
    );
  });
});
