import { describe, expect, it } from 'vitest';
import { normalizeVaultPath } from '../packages/shared/src/index';
import { InMemoryIndexStore } from '../packages/db/src/index';
import { createJsIndexEngine } from '../packages/indexer-js/src/index';
import { createDataViewsService, createFieldsService, createObjectStoreService, parseZbase, parseZtype } from '../packages/object-store/src/index';

function fakeContainer(): HTMLElement {
  const children: Array<{ textContent: string | null }> = [];
  const node = { children, appendChild(child: { textContent: string | null }) { children.push(child); return child; }, replaceChildren() { children.splice(0); } } as unknown as HTMLElement & { children: Array<{ textContent: string | null }> };
  Object.defineProperty(node, 'textContent', { get: () => children.map((child) => child.textContent ?? '').join(''), set: (value: string | null) => { children.splice(0); if (value) children.push({ textContent: value }); } });
  Object.defineProperty(node, 'innerHTML', { get: () => node.textContent ?? '', set: (value: string) => { node.textContent = value; } });
  return node;
}


const taskTypeYaml = `fields:
  - key: status
    type: string
`;

describe('fields/types/data views', () => {
  it('parses .ztype YAML and rejects duplicate fields', () => {
    const doc = parseZtype(normalizeVaultPath('.zorid/types/task.ztype'), taskTypeYaml);
    expect(doc.fields[0]?.key).toBe('status');
    expect(() => parseZtype(normalizeVaultPath('bad.ztype'), `fields:
  - key: a
    type: string
  - key: a
    type: int
`)).toThrow(/Duplicate/);
  });

  it('parses .zbase YAML views and rejects duplicate IDs', () => {
    const doc = parseZbase(normalizeVaultPath('.zorid/views/tasks.zbase'), `views:
  - id: table
    type: table
`);
    expect(doc.views[0]?.renderer).toBe('table');
    expect(() => parseZbase(normalizeVaultPath('bad.zbase'), `views:
  - id: x
    type: table
  - id: x
    type: list
`)).toThrow(/Duplicate/);
  });

  it('exposes host-owned FieldsAPI and preserves ad-hoc fields across type changes', async () => {
    const engine = createJsIndexEngine();
    const [record] = (await engine.indexFiles({ files: [{ path: normalizeVaultPath('Task.md'), contents: `---
zorid:
  type: task
status: open
custom: keep
---
# Task` }] })).records;
    if (!record) throw new Error('missing record');
    const store = new InMemoryIndexStore();
    store.upsert(record);
    const objects = createObjectStoreService({ '.zorid/types/task.ztype': taskTypeYaml });
    const fields = createFieldsService(store, objects);
    await expect(fields.getFields(normalizeVaultPath('Task.md'))).resolves.toContainEqual({ key: 'custom', value: 'keep', source: 'frontmatter' });
    await fields.setType(normalizeVaultPath('Task.md'), undefined);
    expect(store.get(normalizeVaultPath('Task.md'))?.fields.custom).toBe('keep');
    await fields.setType(normalizeVaultPath('Task.md'), normalizeVaultPath('.zorid/types/task.ztype'));
    await expect(fields.getType(normalizeVaultPath('Task.md'))).resolves.toMatchObject({ fields: [{ key: 'status' }] });
  });

  it('evaluates .zbase filters and renders embeds with host-derived caller identity context', async () => {
    const engine = createJsIndexEngine();
    const records = (await engine.indexFiles({ files: [
      { path: normalizeVaultPath('A.md'), contents: '---\nstatus: open\n---\n# A' },
      { path: normalizeVaultPath('B.md'), contents: '---\nstatus: done\n---\n# B' },
    ] })).records;
    const store = new InMemoryIndexStore();
    store.replaceAll(records);
    const objects = createObjectStoreService({
      '.zorid/views/tasks.zbase': JSON.stringify({ views: [{ id: 'open', renderer: 'table', filters: { expression: { equals: ['status', 'open'] } } }] }),
    });
    const dataViews = createDataViewsService(store, objects);
    let caller = '';
    dataViews.registerRenderer({
      type: 'table',
      render: (container, renderedRecords, ctx) => {
        caller = ctx.callerPluginId;
        container.textContent = renderedRecords.map((record) => String(record.path)).join(',');
        return { dispose: () => { container.textContent = ''; } };
      },
    });
    await expect(dataViews.evaluateFilters({ expression: { equals: ['status', 'open'] } })).resolves.toMatchObject([{ path: 'A.md' }]);
    const container = fakeContainer();
    const disposable = await dataViews.renderEmbed(container, normalizeVaultPath('.zorid/views/tasks.zbase'), { basePath: normalizeVaultPath('.zorid/views/tasks.zbase') });
    expect(caller).toBe('zorid.host');
    expect(container.innerHTML).toContain('A.md');
    expect(container.innerHTML).not.toContain('B.md');
    await disposable.dispose();
    expect(container.innerHTML).toBe('');
  });
});
