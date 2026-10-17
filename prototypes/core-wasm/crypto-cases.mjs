// Fixture-only framing manipulations. Production framing belongs to Rust.
export function headerFor(update, device) {
  return JSON.stringify({ envelope_version: 1, purpose: 'vault_update', suite: 'xchacha20poly1305',
    realm_id: 'fixture-realm', vault_id: 'fixture-vault', update_id: update,
    origin_device_id: device, key_epoch: 1, document_format_version: 1,
    required_features: [], optional_extensions: {} });
}
export function contextFor(update, override = {}) {
  return JSON.stringify({ realm_id: 'fixture-realm', vault_id: 'fixture-vault', update_id: update, key_epoch: 1, ...override });
}
export function nonce(wire) {
  const bytes = Uint8Array.from(wire);
  const length = new DataView(bytes.buffer).getUint32(4);
  return bytes.slice(8 + length, 8 + length + 24);
}
export function same(actual, expected, label) {
  if (JSON.stringify(Array.from(actual)) !== JSON.stringify(Array.from(expected))) throw new Error(label);
}
export function distinct(actual, expected, label) {
  if (JSON.stringify(Array.from(actual)) === JSON.stringify(Array.from(expected))) throw new Error(label);
}
export function tampered(wire) {
  const bytes = Uint8Array.from(wire);
  const length = new DataView(bytes.buffer).getUint32(4);
  const body = 8 + length;
  function flip(index) { const result = bytes.slice(); result[index] ^= 1; return result; }
  function header(raw) {
    const encoded = new TextEncoder().encode(raw);
    const result = new Uint8Array(8 + encoded.length + bytes.length - body);
    result.set(bytes.slice(0, 4));
    new DataView(result.buffer).setUint32(4, encoded.length);
    result.set(encoded, 8);
    result.set(bytes.slice(body), 8 + encoded.length);
    return result;
  }
  const original = new TextDecoder().decode(bytes.slice(8, body));
  const changed = JSON.parse(original);
  changed.origin_device_id = 'forged-device';
  return [
    ['nonce', flip(body)], ['ciphertext', flip(body + 24)], ['tag', flip(bytes.length - 1)],
    ['header origin', header(JSON.stringify(changed))], ['exact header bytes', header(`${original} `)],
  ];
}
export const payload = new Uint8Array([...Array.from({ length: 256 }, (_, i) => i), ...new TextEncoder().encode('秘密 🦀\n')]);
