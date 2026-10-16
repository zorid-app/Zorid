'use strict';
const methods = new Set(['list', 'stat', 'read', 'readBinary', 'write', 'writeBinary', 'mkdir', 'rename', 'trash', 'remove']);

function dispatchVaultOperation(vault, expectedRoot, method, args) {
  if (!vault) throw new Error('Open a vault first');
  if (typeof expectedRoot !== 'string' || expectedRoot !== vault.root) {
    throw new Error('The selected vault changed. The old vault operation was not applied.');
  }
  if (!methods.has(method)) throw new Error('Unsupported vault operation');
  return vault[method](...args);
}
module.exports = { dispatchVaultOperation };
