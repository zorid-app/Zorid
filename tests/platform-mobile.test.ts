import test from 'node:test';
import assert from 'node:assert/strict';
import { Filesystem, Encoding } from '@capacitor/filesystem';
import { MobileAdapter } from '../src/platform/mobile.ts';

test('mobile binary writes preserve original bytes and clean temporary files after write or rename failure', async () => {
  const files = new Map<string, Uint8Array>();
  const writes: any[] = [];
  let failRename = false;
  let failWrite = false;
  const mock = {
    async stat({ path }: any) {
      if (path === 'Zorid') return { type: 'directory', size: 0, mtime: 1 };
      if (!files.has(path)) throw new Error('Missing');
      return { type: 'file', size: files.get(path)!.length, mtime: 1 };
    },
    async readdir() { return { files: [...files.keys()].map(path => ({ name: path.split('/').at(-1), type: 'file', size: files.get(path)!.length, mtime: 1 })) }; },
    async writeFile(options: any) {
      writes.push(options);
      files.set(options.path, options.encoding === Encoding.UTF8 ? new TextEncoder().encode(options.data) : new Uint8Array(Buffer.from(options.data, 'base64')));
      if (failWrite) throw new Error('Storage full');
    },
    async readFile(options: any) {
      const bytes = files.get(options.path)!;
      return { data: options.encoding === Encoding.UTF8 ? new TextDecoder().decode(bytes) : Buffer.from(bytes).toString('base64') };
    },
    async rename({ from, to }: any) {
      if (failRename) throw new Error('Rename failed');
      files.set(to, files.get(from)!); files.delete(from);
    },
    async deleteFile({ path }: any) { files.delete(path); },
  } as unknown as typeof Filesystem;
  const adapter = new MobileAdapter(mock);
  const changes: (readonly string[] | undefined)[] = [];
  const stop = adapter.subscribe(paths => changes.push(paths));
  try {
    const data = new Uint8Array([9, 0, 128, 255, 0, 9]).subarray(1, 5);
    await adapter.writeBinary('image.png', data);
    assert.equal('encoding' in writes[0], false);
    assert.match(writes[0].path, /^Zorid\/\.zorid-write-/);
    assert.deepEqual(await adapter.readBinary('image.png'), data);
    assert.equal((await adapter.stat('image.png'))!.size, 4);
    assert.deepEqual(changes, [['image.png']]);
    await adapter.write('Note.md', 'café');
    assert.equal(writes[1].encoding, Encoding.UTF8);
    assert.deepEqual(await adapter.readBinary('Note.md'), new TextEncoder().encode('café'));
    failRename = true;
    await assert.rejects(adapter.writeBinary('image.png', new Uint8Array([1])), /Rename failed/);
    assert.deepEqual(await adapter.readBinary('image.png'), data);
    assert.ok([...files.keys()].every(path => !path.includes('.zorid-write-')));
    failRename = false;
    failWrite = true;
    await assert.rejects(adapter.writeBinary('image.png', new Uint8Array([1])), /Storage full/);
    assert.deepEqual(await adapter.readBinary('image.png'), data);
    assert.ok([...files.keys()].every(path => !path.includes('.zorid-write-')));
    assert.deepEqual(changes, [['image.png'], ['Note.md']]);
    await assert.rejects(adapter.readBinary('../outside'), /Invalid/);
  } finally { stop(); }
});

test('mobile storage capability and permission errors are preserved even if the parent listing is empty', async () => {
  for (const code of ['OS-PLUG-FILE-0004', 'OS-PLUG-FILE-0007', 'OS-PLUG-FILE-0009', 'EACCES', 'EPERM', 'UNIMPLEMENTED', 'UNAVAILABLE']) {
    const denied = Object.assign(new Error(`Native storage unavailable: ${code}`), { code });
    let mutations = 0;
    const adapter = new MobileAdapter({
      async stat() { throw denied; },
      async readdir() { return { files: [] }; },
      async mkdir() { mutations++; },
      async writeFile() { mutations++; },
    } as unknown as typeof Filesystem);
    await assert.rejects(adapter.initialize(), error => error === denied);
    await assert.rejects(adapter.stat('Note.md'), error => error === denied);
    await assert.rejects(adapter.write('Note.md', 'text'), error => error === denied);
    assert.equal(mutations, 0);
  }
});

test('mobile missing-file code allows root creation and a missing stat without requesting a listing', async () => {
  const created: string[] = [];
  const adapter = new MobileAdapter({
    async stat() { throw Object.assign(new Error('Missing'), { code: 'OS-PLUG-FILE-0008' }); },
    async readdir() { throw new Error('Unexpected listing'); },
    async mkdir({ path }: { path: string }) { created.push(path); },
  } as unknown as typeof Filesystem);
  await adapter.initialize();
  assert.deepEqual(created, ['Zorid']);
  assert.equal(await adapter.stat('Note.md'), null);
});
