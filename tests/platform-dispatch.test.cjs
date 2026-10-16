const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dispatchVaultOperation } = require('../desktop/vault-dispatch.cjs');

test('a delayed write from the old vault cannot write into a newly selected vault', async () => {
  const written = [];
  const nextVault = { root: '/notes/second', write: async (...args) => written.push(args) };
  assert.throws(() => dispatchVaultOperation(nextVault, '/notes/first', 'write', ['Note.md', 'old content']), /selected vault changed/);
  assert.deepEqual(written, []);
  await dispatchVaultOperation(nextVault, '/notes/second', 'write', ['Note.md', 'new content']);
  assert.deepEqual(written, [['Note.md', 'new content']]);
});

test('vault dispatcher rejects absent vaults, non-string identity and arbitrary method calls', () => {
  assert.throws(() => dispatchVaultOperation(null, '/notes', 'read', []), /Open a vault/);
  const vault = { root: '/notes' };
  assert.throws(() => dispatchVaultOperation(vault, {}, 'read', []), /selected vault changed/);
  assert.throws(() => dispatchVaultOperation(vault, '/notes', 'constructor', []), /Unsupported/);
});

test('binary operations retain the stale-vault boundary and structured bytes', async () => {
  const calls = [];
  const data = new Uint8Array([0, 128, 255]);
  const vault = { root: '/notes/current',
    writeBinary: async (...args) => calls.push(args),
    readBinary: async () => data,
  };
  assert.throws(() => dispatchVaultOperation(vault, '/notes/old', 'writeBinary', ['image.png', data]), /selected vault changed/);
  assert.throws(() => dispatchVaultOperation(vault, '/notes/old', 'readBinary', ['image.png']), /selected vault changed/);
  assert.deepEqual(calls, []);
  await dispatchVaultOperation(vault, '/notes/current', 'writeBinary', ['image.png', structuredClone(data)]);
  assert.deepEqual(calls, [['image.png', data]]);
  assert.deepEqual(await dispatchVaultOperation(vault, '/notes/current', 'readBinary', ['image.png']), data);
});
