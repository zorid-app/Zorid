import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserAdapter } from '../src/platform/browser.ts';

const storage = new Map<string, string>();
let failWrites = false;
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    if (failWrites) throw new Error('Quota exceeded');
    storage.set(key, value);
  },
} });

test('browser vault persists text, empty folders, folder moves and recoverable trash', async () => {
  storage.clear();
  const adapter = new BrowserAdapter();
  await adapter.mkdir('Empty');
  await adapter.write('Folder/One.md', 'hello [[Two]]');
  await adapter.write('Folder/Two.md', '# Two');
  await adapter.rename('Folder', 'Moved');
  const reopened = new BrowserAdapter();
  assert.equal(await reopened.read('Moved/One.md'), 'hello [[Two]]');
  assert.deepEqual((await reopened.list()).map(entry => entry.path), ['Empty', 'Moved', 'Moved/One.md', 'Moved/Two.md']);
  await reopened.trash('Moved');
  assert.deepEqual((await reopened.list()).map(entry => entry.path), ['Empty']);
  const contents = JSON.parse(storage.get('zorid.browser-vault.v1')!);
  assert.ok(Object.values(contents).some((entry: any) => entry.path.startsWith('.trash/') && entry.content === 'hello [[Two]]'));
});

test('browser vault rejects overwrite moves and failed storage commits preserve prior contents', async () => {
  storage.clear();
  const adapter = new BrowserAdapter();
  await adapter.write('One.md', 'original');
  await adapter.write('Two.md', 'keep');
  await assert.rejects(adapter.rename('One.md', 'Two.md'), /already exists/);
  await assert.rejects(adapter.write('../Escape.md', 'bad'), /Invalid/);
  failWrites = true;
  try { await assert.rejects(adapter.write('One.md', 'replacement'), /Quota/); }
  finally { failWrites = false; }
  assert.equal(await adapter.read('One.md'), 'original');
  assert.equal(await adapter.read('Two.md'), 'keep');
});

test('browser vault treats inherited object property names as ordinary filenames', async () => {
  storage.clear();
  const adapter = new BrowserAdapter();
  await adapter.mkdir('__proto__');
  await adapter.write('__proto__/constructor', 'safe');
  await adapter.write('toString', 'also safe');
  assert.equal(await adapter.read('__proto__/constructor'), 'safe');
  assert.equal(await adapter.read('toString'), 'also safe');
  await adapter.rename('__proto__', 'renamed');
  assert.equal(await adapter.read('renamed/constructor'), 'safe');
});

test('browser single-entry stats omit content and writes include their changed path', async () => {
  storage.clear();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable:true, value:{addEventListener(){},removeEventListener(){}} });
  try {
    const adapter = new BrowserAdapter(), changes:(readonly string[]|undefined)[]=[];
    const stop=adapter.subscribe(paths=>changes.push(paths));
    await adapter.write('Note.md','café 🌱');
    const entry=await adapter.stat('Note.md');
    assert.equal(entry!.size,new TextEncoder().encode('café 🌱').length);
    assert.equal('content' in entry!,false);
    assert.equal(await adapter.stat('Missing.md'),null);
    assert.deepEqual(changes,[['Note.md']]);stop();
  } finally { if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window'); }
});

test('browser attachments preserve arbitrary bytes, slices and byte stats across reopen and rename', async () => {
  storage.clear();
  const adapter = new BrowserAdapter();
  const backing = new Uint8Array([9, 0, 127, 128, 255, 0, 9]);
  const bytes = backing.subarray(1, 6);
  await adapter.writeBinary('Attachments/image.png', bytes);
  assert.deepEqual(await new BrowserAdapter().readBinary('Attachments/image.png'), bytes);
  const entry = await adapter.stat('Attachments/image.png');
  assert.equal(entry!.size, 5);
  assert.equal('binary' in entry!, false);
  assert.equal('binary' in (await adapter.list()).find(entry => entry.type === 'file')!, false);
  await adapter.rename('Attachments/image.png', 'Attachments/moved.png');
  assert.deepEqual(await adapter.readBinary('Attachments/moved.png'), bytes);
  await adapter.writeBinary('Attachments/empty.bin', new Uint8Array());
  assert.deepEqual(await adapter.readBinary('Attachments/empty.bin'), new Uint8Array());
  await adapter.write('Note.md', 'café 🌱');
  assert.deepEqual(await adapter.readBinary('Note.md'), new TextEncoder().encode('café 🌱'));
  failWrites = true;
  try { await assert.rejects(adapter.writeBinary('Attachments/moved.png', new Uint8Array([1])), /Quota/); }
  finally { failWrites = false; }
  assert.deepEqual(await adapter.readBinary('Attachments/moved.png'), bytes);
});

test('browser attachments larger than function argument limits encode without spreading bytes', async () => {
  storage.clear();
  const bytes = Uint8Array.from({ length: 400_001 }, (_, index) => index % 256);
  const adapter = new BrowserAdapter();
  await adapter.writeBinary('large.bin', bytes);
  assert.deepEqual(await adapter.readBinary('large.bin'), bytes);
  assert.equal((await adapter.stat('large.bin'))!.size, bytes.length);
});
