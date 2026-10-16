import test from 'node:test';
import assert from 'node:assert/strict';
import { Filesystem, Encoding } from '@capacitor/filesystem';
import { MobileAdapter } from '../src/platform/mobile.ts';

test('mobile binary bridge omits text encoding and atomically renames the base64 temporary file', async () => {
  const files = new Map<string, Uint8Array>();
  const writes: any[] = [];
  let failRename = false;
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
    await assert.rejects(adapter.readBinary('../outside'), /Invalid/);
  } finally { stop(); }
});
