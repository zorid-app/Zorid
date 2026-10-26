export const vaultName = 'bases-sidebar-pin';
export const BASE = 'Sidebar Context.base';
export const VIEW = 'Pinned context';
export const A = 'Context A.md';
export const B = 'Context B.md';
export const RENAMED_A = 'Renamed Context A.md';
export const ROW_A = 'Row One.md';
export const ROW_B = 'Row Two.md';
export const ROW_NULL = 'Null result.md';
const note = (properties, body) => `---\n${properties}---\n${body}\n`;
export function fixtureFiles() {
  return new Map([
    [BASE, `fixtureSentinel: sidebar-pin-only\nfilters: '(this == null && file.path == "${ROW_NULL}") || (this != null && note.kind == "entry" && note.category == this.category)'\nviews:\n  - type: table\n    name: ${VIEW}\n    order: [file.name, score]\n    sort: [{property: file.name, direction: ASC}]\n`],
    [A, note('kind: context\ncategory: One\n', '# Context A 😀\nExact first context body.')],
    [B, note('kind: context\ncategory: Two\n', '# Context B\nExact second context body.')],
    [ROW_A, note('kind: entry\ncategory: One\nscore: 11\n', '# Row One\nPinned row body remains exact.')],
    [ROW_B, note('kind: entry\ncategory: Two\nscore: 22\n', '# Row Two\nRetained draft row body remains exact.')],
    [ROW_NULL, note('kind: null-result\nscore: 0\n', '# No current file\nExplicit null context sentinel.')],
    ['Properties.yaml', 'properties:\n  score: {type: number}\n'],
  ]);
}
export function expectedFiles({renamed = false} = {}) {
  const files = fixtureFiles();
  if (renamed) { const source = files.get(A); files.delete(A); files.set(RENAMED_A, source); }
  return files;
}
export const phases = Object.freeze([
  'ordinary-sidebar-context', 'pin-freezes-first-context', 'unpin-follows-latest-context',
  'retained-draft-refuses-pin', 'blank-main-context-is-null', 'pinned-known-rename-keeps-identity',
  'pinned-context-survives-normal-restart',
]);
