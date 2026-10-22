import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Workspace } from '../src/ui/workspace.ts';
import type { BaseSession, BaseSessionOptions } from '../src/bases/session.ts';
import type { VaultEntry } from '../src/core/types.ts';

const entry = (path: string, entryId: string, revision: string): VaultEntry => ({
  path, entryId, revision, type: 'file', ctime: 0, mtime: 0, size: 1,
});

/** Exercise the workspace attachment boundary without starting an app or query.
 * These checks establish lease/identity behavior, not native or visual parity. */
function fixture(gate?: Promise<void>, fileCover = false) {
  const dom = new JSDOM('<main></main>');
  const entries = new Map([
    ['Old.png', entry('Old.png', 'replacement', 'replacement-revision')],
    ['Renamed.png', entry('Renamed.png', 'original', 'original-revision')],
  ]);
  const tokens = new Map([...entries.keys()].map(path => [path, Symbol(path)]));
  const acquired: string[] = [];
  let releases = 0;
  let options: BaseSessionOptions | undefined;
  const owner = {
    vault: { entries, metadata: { resolveLink: () => 'Old.png' } },
    attachments: { async acquire(path: string) {
      acquired.push(path);
      await gate;
      return { url: `blob:${path}`, release() { releases++; } };
    } },
    viewFactories: { base(_host: HTMLElement, captured: BaseSessionOptions) {
      options = captured;
      return {} as BaseSession;
    } },
    treeEntryToken(path: string) { return tokens.get(path); },
  };
  const create = Reflect.get(Workspace.prototype, 'createWorkspaceBaseSession') as (...args: unknown[]) => unknown;
  create.call(owner, dom.window.document.querySelector('main'), 'Work.base', () => ({}), () => {});
  assert.ok(options?.loadThumbnail);
  const load = () => options!.loadThumbnail!({
    row: fileCover ? { path: 'Old.png', entryId: 'original', revision: 'original-revision', values: {} } : { path: 'Book.md', values: {} },
    property: fileCover ? 'file.file' : 'note.cover', version: 1,
    value: fileCover ? { type: 'string', value: 'Old.png' } :
    { type: 'namespace', name: 'Old.png', get() { return undefined; },
      presentation: { kind: 'link', value: 'Old.png',
        target: { entryId: 'original', revision: 'original-revision' } } },
    signal: new AbortController().signal,
  });
  return { entries, acquired, load, get releases() { return releases; }, close() { dom.window.close(); } };
}

test('a witnessed thumbnail follows the original entry after rename instead of a reused path', async () => {
  const f = fixture();
  try {
    const resource = await f.load();
    assert.deepEqual(f.acquired, ['Renamed.png']);
    assert.equal(resource?.url, 'blob:Renamed.png');
    resource!.dispose();
    assert.equal(f.releases, 1);
  } finally { f.close(); }
});

test('a missing or changed thumbnail witness never falls back to the old path occupant', async () => {
  for (const replaced of [false, true]) {
    const f = fixture();
    try {
      if (replaced) f.entries.set('Renamed.png', entry('Renamed.png', 'original', 'new-revision'));
      else f.entries.delete('Renamed.png');
      assert.equal(await f.load(), null);
      assert.deepEqual(f.acquired, []);
      assert.equal(f.releases, 0);
    } finally { f.close(); }
  }
});

test('a thumbnail revision changing during acquisition releases the stale lease exactly once', async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const f = fixture(gate);
  try {
    const loading = f.load();
    assert.deepEqual(f.acquired, ['Renamed.png']);
    // Keep the path/token and entry ID unchanged: the revision check must reject it.
    f.entries.set('Renamed.png', entry('Renamed.png', 'original', 'new-revision'));
    finish();
    assert.equal(await loading, null);
    assert.equal(f.releases, 1);
  } finally { finish(); f.close(); }
});

test('a file.file thumbnail follows its captured row identity after rename and path reuse', async () => {
  const f = fixture(undefined, true);
  try {
    const resource = await f.load();
    assert.deepEqual(f.acquired, ['Renamed.png']);
    assert.equal(resource?.url, 'blob:Renamed.png');
    resource!.dispose();
    assert.equal(f.releases, 1);
  } finally { f.close(); }
});
