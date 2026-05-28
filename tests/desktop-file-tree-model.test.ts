import { describe, expect, it } from 'vitest';
import type { VaultEntry } from '@zorid/platform-api';
import { FILE_TREE_SORT_MODES, entryName, entryTypeLabel, sortEntries, sortModeLabel } from '../apps/desktop/src/renderer/src/components/file-tree-model';

function entry(path: string, kind: VaultEntry['kind'], mtimeMs: number): VaultEntry {
  return { path, kind, mtimeMs, size: kind === 'directory' ? 0 : 10 } as VaultEntry;
}

describe('desktop file tree model', () => {
  it('uses the final path segment as the display name', () => {
    expect(entryName(entry('02 - Career/Project Ideas/tasks.zbase', 'file', 10))).toBe('tasks.zbase');
    expect(entryName(entry('Index.md', 'file', 10))).toBe('Index.md');
  });

  it('maps Zorid base files to compact right-side labels', () => {
    expect(entryTypeLabel(entry('.zorid/views/tasks.zbase', 'file', 10))).toBe('BASE');
    expect(entryTypeLabel(entry('.zorid/types/book.ztype', 'file', 10))).toBeUndefined();
    expect(entryTypeLabel(entry('Notes/tasks.md', 'file', 10))).toBeUndefined();
    expect(entryTypeLabel(entry('.zorid/views', 'directory', 10))).toBeUndefined();
  });

  it('sorts directories before files by case-insensitive basename with path tie-breakers', () => {
    const entries = [
      entry('zeta.md', 'file', 3),
      entry('Projects/Beta.md', 'file', 2),
      entry('archive', 'directory', 4),
      entry('Projects/alpha.md', 'file', 1),
      entry('Notes', 'directory', 5),
    ];

    expect(sortEntries(entries, 'name-asc').map((item) => item.path)).toEqual([
      'archive',
      'Notes',
      'Projects/alpha.md',
      'Projects/Beta.md',
      'zeta.md',
    ]);
    expect(sortEntries(entries, 'name-desc').map((item) => item.path)).toEqual([
      'Notes',
      'archive',
      'zeta.md',
      'Projects/Beta.md',
      'Projects/alpha.md',
    ]);
    expect(sortEntries(entries, 'name-asc')).not.toBe(entries);
  });

  it('sorts directories before files by modified time with stable name/path tie-breakers', () => {
    const entries = [
      entry('b.md', 'file', 20),
      entry('a.md', 'file', 20),
      entry('new-folder', 'directory', 50),
      entry('old-folder', 'directory', 10),
      entry('old.md', 'file', 1),
    ];

    expect(sortEntries(entries, 'modified-asc').map((item) => item.path)).toEqual([
      'old-folder',
      'new-folder',
      'old.md',
      'a.md',
      'b.md',
    ]);
    expect(sortEntries(entries, 'modified-desc').map((item) => item.path)).toEqual([
      'new-folder',
      'old-folder',
      'b.md',
      'a.md',
      'old.md',
    ]);
  });

  it('exposes only name and modified-time sort modes with user-facing labels', () => {
    expect(FILE_TREE_SORT_MODES).toEqual(['name-asc', 'name-desc', 'modified-asc', 'modified-desc']);
    expect(FILE_TREE_SORT_MODES.join(' ')).not.toMatch(/created|ctime|birth/i);
    expect(sortModeLabel('modified-desc')).toBe('Modified newest first');
  });
});
