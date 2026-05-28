import { describe, expect, it } from 'vitest';
import { InMemoryIndexStore, indexMigrations } from '../packages/db/src/index';
import { InlineIndexScheduler } from '../packages/index-worker/src/index';
import { createJsIndexEngine } from '../packages/indexer-js/src/index';
import { createMetadataService, createSearchService } from '../packages/metadata/src/index';
import { normalizeVaultPath } from '../packages/shared/src/index';

describe('index/metadata/search slice', () => {
  it('declares rebuildable derived index schema migrations', () => {
    expect(indexMigrations[0]?.sql).toContain('CREATE TABLE IF NOT EXISTS files');
    expect(indexMigrations[0]?.sql).toContain('search_fts');
  });

  it('rebuilds Markdown records and exposes metadata/search APIs', async () => {
    const engine = createJsIndexEngine();
    const scheduler = new InlineIndexScheduler(engine);
    const store = new InMemoryIndexStore();
    const output = await scheduler.rebuild([
      {
        path: normalizeVaultPath('A.md'),
        contents: '---\ntags: [project, active]\nstatus: open\n---\n# Title\nSee [[B.md]] #inline\nbody search term',
      },
      { path: normalizeVaultPath('B.md'), contents: '# B\nBack target' },
    ]);
    store.replaceAll(output.records);
    const metadata = createMetadataService(store);
    const search = createSearchService(store);
    await expect(metadata.getFile(normalizeVaultPath('A.md'))).resolves.toMatchObject({
      headings: ['Title'],
      tags: ['project', 'active', 'inline'],
    });
    await expect(metadata.backlinks(normalizeVaultPath('B.md'))).resolves.toEqual([{ from: 'A.md', to: 'B.md' }]);
    await expect(metadata.tags()).resolves.toContainEqual({ tag: 'active', count: 1 });
    await expect(search.search('search term')).resolves.toMatchObject([{ path: 'A.md' }]);
  });

  it('supports incremental updates by upserting changed records', async () => {
    const engine = createJsIndexEngine();
    const store = new InMemoryIndexStore();
    const [initial] = (await engine.indexFiles({ files: [{ path: normalizeVaultPath('A.md'), contents: '# Old' }] }))
      .records;
    if (!initial) throw new Error('missing initial record');
    store.upsert(initial);
    const [changed] = (
      await engine.indexFiles({ files: [{ path: normalizeVaultPath('A.md'), contents: '# New\n#tag' }] })
    ).records;
    if (!changed) throw new Error('missing changed record');
    store.upsert(changed);
    expect(store.get(normalizeVaultPath('A.md'))?.headings).toEqual(['New']);
  });
});
