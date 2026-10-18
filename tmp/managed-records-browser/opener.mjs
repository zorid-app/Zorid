import {openBrowserStreamingVault} from '../../src/core/browser-streaming-vault.ts';

// Matched read-only to B current opener source on 2026-10-18 01:42 UTC; recheck after freeze.
// This is the single adaptation point if the final trusted opener API changes.
// No host double, fake key, merge implementation, or constructor for an authenticated update.
export async function openAuthority({name, wasm, clientId, assertActive}) {
  const vault = await openBrowserStreamingVault({name, wasm, clientId, assertActive});
  const records = vault.managedRecords;
  if (!records || ['register', 'apply', 'snapshot', 'retryPage', 'changes'].some(key => typeof records[key] !== 'function')) {
    vault.close();
    throw new Error('SOURCE_GATE: B must expose the agreed trusted fixture records authority on the real streaming opener; adapt opener.mjs to its frozen API');
  }
  return {vault, records};
}
