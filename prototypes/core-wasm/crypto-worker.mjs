import init, { WasmVaultKey, generateKey } from './pkg/zorid_wasm.js';
import { headerFor, contextFor, nonce, same, distinct, tampered, payload } from './crypto-cases.mjs';
function reject(fn, label) { try { fn(); } catch { return; } throw new Error(`accepted ${label}`); }
self.onmessage = async ({ data }) => {
  const handles = [];
  try {
    await init();
    const importedBytes = Uint8Array.from(data.key);
    const key = new WasmVaultKey(importedBytes); handles.push(key);
    importedBytes.fill(0); data.key.fill(0);
    same(key.open(contextFor('native-a'), Uint8Array.from(data.first)), payload, 'native seal/browser open bytes');
    same(key.open(contextFor('native-b'), Uint8Array.from(data.second)), payload, 'native second envelope bytes');
    distinct(nonce(data.first), nonce(data.second), 'native reused nonce');
    for (const [label, wire] of tampered(data.first)) reject(() => key.open(contextFor('native-a'), wire), label);
    for (const override of [{ realm_id: 'other' }, { vault_id: 'other' }, { update_id: 'other' }, { key_epoch: 2 }]) {
      reject(() => key.open(contextFor('native-a', override), Uint8Array.from(data.first)), 'wrong independent context');
    }
    const other = generateKey(); handles.push(other);
    reject(() => other.open(contextFor('native-a'), Uint8Array.from(data.first)), 'wrong key');
    for (const length of [0, 31, 33]) reject(() => new WasmVaultKey(new Uint8Array(length)), 'wrong key length');
    reject(() => key.open(contextFor('native-a', { extra: true }), Uint8Array.from(data.first)), 'unknown context field');
    reject(() => key.open(contextFor('native-a', { key_epoch: 0 }), Uint8Array.from(data.first)), 'zero epoch');
    reject(() => key.open(' '.repeat(4097), Uint8Array.from(data.first)), 'oversized context');
    reject(() => key.open(contextFor('native-a'), new Uint8Array(8 + 4096 + 24 + 1048576 + 16 + 1)), 'oversized frame');
    reject(() => key.seal(headerFor('oversized', 'browser'), new Uint8Array(1048577)), 'oversized plaintext');
    const unsupported = JSON.parse(headerFor('unsupported', 'browser'));
    unsupported.required_features = ['unknown'];
    reject(() => key.seal(JSON.stringify(unsupported), payload), 'required header semantics');
    const malformed = Uint8Array.of(0, 1, 2);
    reject(() => key.open(contextFor('native-a'), malformed), 'malformed frame');
    // Actual browser Crypto.getRandomValues supplies both key and per-envelope nonce.
    const browserKey = generateKey(); handles.push(browserKey);
    const first = browserKey.seal(headerFor('browser-a', 'browser'), payload);
    const second = browserKey.seal(headerFor('browser-b', 'browser'), payload);
    distinct(nonce(first), nonce(second), 'browser reused nonce');
    same(browserKey.open(contextFor('browser-a'), first), payload, 'browser local roundtrip');
    const secret = browserKey.exportSecret();
    self.postMessage({ ok: true, key: Array.from(secret), first: Array.from(first), second: Array.from(second), browser: navigator.userAgent,
      checks: ['native ciphertext opens in real browser WASM with binary/Unicode payload',
        'native and browser platform entropy produce distinct sampled nonces',
        'browser rejects modified header, nonce, ciphertext, tag, wrong key and independent contexts',
        'browser rejects invalid key lengths, malformed/oversized input and required semantics',
        'browser-generated key seals two envelopes for native verification'] });
    secret.fill(0);
  } catch { self.postMessage({ ok: false, error: 'crypto worker validation failed (payloads redacted)' }); }
  finally { for (const handle of handles) handle.free(); }
};
