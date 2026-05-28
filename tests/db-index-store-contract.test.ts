import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type IndexStore, InMemoryIndexStore } from '../packages/db/src/index';
import { NodeSqliteIndexStore } from '../packages/db/src/node-sqlite';
import type { IndexedFileRecord } from '../packages/index-api/src/index';
import { normalizeVaultPath } from '../packages/shared/src/index';

const first: IndexedFileRecord = {
  path: normalizeVaultPath('Notes/A.md'),
  text: '# A\n#tag [[B]]',
  frontmatter: { title: 'A' },
  fields: { title: 'A', done: false },
  headings: ['A'],
  links: [normalizeVaultPath('Notes/B.md')],
  tags: ['tag'],
};

const second: IndexedFileRecord = {
  path: normalizeVaultPath('Notes/B.md'),
  text: '# B',
  frontmatter: { title: 'B' },
  fields: { title: 'B' },
  headings: ['B'],
  links: [],
  tags: [],
};

function expectIndexStoreContract(create: () => IndexStore): void {
  const store = create();
  try {
    store.replaceAll([second, first]);
    expect(store.all().map((record) => record.path)).toEqual(['Notes/A.md', 'Notes/B.md']);
    expect(store.get(first.path)).toMatchObject({
      path: first.path,
      headings: ['A'],
      links: ['Notes/B.md'],
      tags: ['tag'],
      fields: { title: 'A', done: false },
    });

    store.upsert({ ...first, text: 'updated', tags: ['changed'] });
    expect(store.get(first.path)?.text).toBe('updated');
    expect(store.get(first.path)?.tags).toEqual(['changed']);

    store.delete(second.path);
    expect(store.get(second.path)).toBeUndefined();
    expect(store.all().map((record) => record.path)).toEqual(['Notes/A.md']);
  } finally {
    void store.dispose();
  }
}

describe('IndexStore contract', () => {
  it('is implemented by the in-memory store', () => {
    expectIndexStoreContract(() => new InMemoryIndexStore());
  });

  it('is implemented by desktop node:sqlite store', () => {
    expectIndexStoreContract(() => new NodeSqliteIndexStore(':memory:'));
  });

  it('persists node:sqlite records on disk and creates FTS table', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'zorid-db-'));
    const dbPath = path.join(root, '.zorid', 'index', 'index.sqlite');
    try {
      const store = new NodeSqliteIndexStore(dbPath);
      store.replaceAll([first]);
      store.dispose();

      const reopened = new NodeSqliteIndexStore(dbPath);
      try {
        expect(reopened.get(first.path)?.frontmatter).toEqual({ title: 'A' });
        expect(
          reopened.database.prepare("SELECT name FROM sqlite_master WHERE name = 'search_fts'").get(),
        ).toBeTruthy();
      } finally {
        reopened.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
