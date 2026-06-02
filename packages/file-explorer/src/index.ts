import type { VaultEntry } from '@zorid/platform-api';

export type FileTreeSortMode = 'name-asc' | 'name-desc' | 'modified-asc' | 'modified-desc';

export const FILE_TREE_SORT_MODES = [
  'name-asc',
  'name-desc',
  'modified-asc',
  'modified-desc',
] as const satisfies readonly FileTreeSortMode[];

export type FileTreeContextActionKind = 'rename' | 'reveal' | 'duplicate' | 'delete';

export interface FileTreeContextAction {
  readonly id: FileTreeContextActionKind;
  readonly label: string;
}

export function entryName(entry: Pick<VaultEntry, 'path'>): string {
  return entry.path.split('/').filter(Boolean).at(-1) ?? entry.path;
}

export function entryTypeLabel(entry: Pick<VaultEntry, 'kind' | 'path'>): string | undefined {
  if (entry.kind !== 'file') return undefined;
  const lowerPath = entry.path.toLowerCase();
  if (lowerPath.endsWith('.zbase')) return 'BASE';
  return undefined;
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function compareByKind(left: VaultEntry, right: VaultEntry): number {
  if (left.kind === right.kind) return 0;
  return left.kind === 'directory' ? -1 : 1;
}

function stablePathTieBreak(left: VaultEntry, right: VaultEntry): number {
  return compareText(left.path, right.path);
}

function compareByName(left: VaultEntry, right: VaultEntry): number {
  return compareText(entryName(left), entryName(right)) || stablePathTieBreak(left, right);
}

function compareByModified(left: VaultEntry, right: VaultEntry): number {
  return left.mtimeMs - right.mtimeMs || compareByName(left, right);
}

export function sortEntries(entries: readonly VaultEntry[], mode: FileTreeSortMode): readonly VaultEntry[] {
  const direction = mode.endsWith('-desc') ? -1 : 1;
  const compareWithinKind = mode.startsWith('modified') ? compareByModified : compareByName;
  return [...entries].sort((left, right) => compareByKind(left, right) || direction * compareWithinKind(left, right));
}

export function sortModeLabel(mode: FileTreeSortMode): string {
  switch (mode) {
    case 'name-asc':
      return 'Name A to Z';
    case 'name-desc':
      return 'Name Z to A';
    case 'modified-asc':
      return 'Modified oldest first';
    case 'modified-desc':
      return 'Modified newest first';
  }
}

export function normalizeCreateFileName(name: string): string {
  if (name.toLowerCase().endsWith('.md')) return name;
  return `${name}.md`;
}

export function splitNameAndSuffix(name: string): { base: string; suffix: string } {
  const extensionIndex = name.lastIndexOf('.');
  if (extensionIndex <= 0) return { base: name, suffix: '' };
  return { base: name.slice(0, extensionIndex), suffix: name.slice(extensionIndex) };
}

export function resolveUniqueEntryName(entries: readonly VaultEntry[], rawName: string): string {
  const existing = new Set(entries.map((entry) => entryName(entry).toLowerCase()));
  if (!existing.has(rawName.toLowerCase())) return rawName;

  const { base, suffix } = splitNameAndSuffix(rawName);
  let attempt = 1;
  let next = `${base}${attempt}${suffix}`;
  while (existing.has(next.toLowerCase())) {
    attempt += 1;
    next = `${base}${attempt}${suffix}`;
  }

  return next;
}

export function fileTreeContextActions(entry: Pick<VaultEntry, 'kind'>): readonly FileTreeContextAction[] {
  const actions: FileTreeContextAction[] = [
    { id: 'rename', label: 'Rename' },
    { id: 'reveal', label: 'Reveal in file manager' },
  ];

  if (entry.kind === 'file') {
    actions.splice(1, 0, { id: 'duplicate', label: 'Duplicate' });
  }

  return [...actions, { id: 'delete', label: 'Delete' }];
}
