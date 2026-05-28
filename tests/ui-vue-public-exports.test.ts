import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const expectedSharedExports = [
  'ZBadge',
  'ZButton',
  'ZCheckboxField',
  'ZConfirmDialog',
  'ZDialogBackdrop',
  'ZDialogWindow',
  'ZModalWindow',
  'ZPanel',
  'ZPromptDialog',
  'ZResizeHandle',
  'ZStatusBar',
  'ZTag',
  'ZTextField',
  'ZVisuallyHidden',
  'ZWindowFrame',
];

describe('ui-vue public component exports', () => {
  it('exports every shared component from the package index', () => {
    const index = readFileSync('packages/ui-vue/src/index.ts', 'utf8');
    for (const component of expectedSharedExports) {
      expect(index).toContain(`export { default as ${component} }`);
    }
  });

  it('does not leak Reka primitive exports through the app package index', () => {
    const index = readFileSync('packages/ui-vue/src/index.ts', 'utf8');
    expect(index).not.toContain('export { Dialog');
    expect(index).not.toContain('export { AlertDialog');
  });
});
