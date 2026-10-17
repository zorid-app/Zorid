/** Shared by palette, Settings and contextual insertion. No default bindings. */
export const INSERTION_COMMANDS = [
  { id: 'editor-insert-table', name: 'Insert table', label: 'Table' },
  { id: 'editor-insert-callout', name: 'Insert callout', label: 'Callout' },
  { id: 'editor-insert-code-block', name: 'Insert code block', label: 'Code block' },
  { id: 'editor-insert-math-block', name: 'Insert math block', label: 'Math block' },
  { id: 'editor-insert-rule', name: 'Insert horizontal rule', label: 'Horizontal rule' },
  { id: 'editor-insert-link', name: 'Insert link', label: 'Link' },
  { id: 'editor-insert-image', name: 'Insert image', label: 'Image' },
  { id: 'editor-insert-footnote', name: 'Insert footnote', label: 'Footnote' },
] as const;
export type InsertionCommandId = typeof INSERTION_COMMANDS[number]['id'];
