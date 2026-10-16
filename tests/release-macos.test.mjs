import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeSecret, validateNotaryResult, validateSignature, releasePaths, prepareSigning, cleanupSigning, notarizeApp, notarizeDmg, verifyDmg } from '../scripts/release/macos-release.mjs';
const name = 'Developer ID Application: Example Test (ABCDEFGHIJ)';
const signature = `Authority=${name}\nTimestamp=Oct 16, 2026\nCodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=1\n`;
function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zorid-release-test-'));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const env = { RUNNER_TEMP: directory, RELEASE_ARCH: 'arm64', RELEASE_VERSION: '1.2.3', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_ENV: path.join(directory, 'env'), MACOS_SIGNING_IDENTITY: name, MACOS_CERTIFICATE_PASSWORD: 'synthetic-test-password', MACOS_CERTIFICATE_P12_BASE64: Buffer.from('synthetic-test-certificate').toString('base64'), APPLE_API_KEY_P8_BASE64: Buffer.from('-----BEGIN PRIVATE KEY-----\nsynthetic-test-key\n-----END PRIVATE KEY-----').toString('base64'), APPLE_API_KEY_ID: 'ABCDEFGHIJ', APPLE_API_ISSUER_ID: '00000000-0000-0000-0000-000000000000' };
  return { env, paths: releasePaths(env) };
}
test('signing and notary validators reject ad hoc, wrong identity, missing runtime/timestamp and nonaccepted results', () => {
  validateSignature(signature, name);
  for (const value of [signature.replace(name, 'other'), signature.replace('Timestamp=', 'Date='), signature.replace('runtime', 'none'), `${signature}\nSignature=adhoc`]) assert.throws(() => validateSignature(value, name));
  validateSignature(signature.replace('runtime', 'none'), name, { app: false });
  assert.equal(validateNotaryResult('{"status":"Accepted","id":"submission"}'), 'submission');
  for (const value of ['{}', '{"status":"Invalid","id":"id"}', '{"status":"In Progress","id":"id"}', '{"status":"Accepted"}', 'bad']) assert.throws(() => validateNotaryResult(value));
  for (const value of ['', 'invalid!!', 'A=']) assert.throws(() => decodeSecret(value, 'test'));
});
test('prepare creates private files, selects explicit identity and cleanup removes credentials after partial failure', t => {
  const { env, paths } = fixture(t); const calls = [];
  const run = (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === 'create-keychain') writeFileSync(paths.keychain, 'synthetic-keychain');
    if (args[0] === 'find-identity') return `1) ABC "${name}"`;
    return '';
  };
  prepareSigning(env, run);
  assert.equal(statSync(paths.directory).mode & 0o777, 0o700);
  assert.equal(statSync(paths.p8).mode & 0o777, 0o600);
  assert.equal(existsSync(paths.p12), false);
  assert.match(readFileSync(env.GITHUB_ENV, 'utf8'), /CSC_KEYCHAIN=.*release.keychain-db/);
  assert.ok(calls.some(call => call.includes('set-key-partition-list')));
  cleanupSigning(env, run);
  assert.equal(existsSync(paths.directory), false);
  assert.ok(calls.some(call => call.includes('delete-keychain')));
  assert.throws(() => prepareSigning(env, (file, args) => { run(file, args); if (args[0] === 'import') throw new Error('synthetic import failed'); return ''; }), /import failed/);
  assert.ok(existsSync(paths.p8));
  cleanupSigning(env, run); assert.equal(existsSync(paths.directory), false);
});
test('app submission is signed first, never staples rejection, and accepted app gets gatekeeper verification', t => {
  const { env, paths } = fixture(t); mkdirSync(paths.directory);
  const calls = [];
  const run = (file, args) => { calls.push([file, ...args]); return file === 'signature-display' ? signature : args[0] === 'notarytool' ? '{"status":"Invalid","id":"id"}' : ''; };
  assert.throws(() => notarizeApp('/test/Zorid.app', env, run), /Accepted/);
  assert.equal(calls.some(call => call.includes('stapler')), false);
  calls.length = 0;
  notarizeApp('/test/Zorid.app', env, (file, args) => { if (args[0] === 'notarytool') { calls.push([file, ...args]); return '{"status":"Accepted","id":"id"}'; } return run(file, args); });
  assert.equal(calls[0][0], 'codesign');
  assert.ok(calls.some(call => call[0] === 'spctl' && call.includes('execute')));
  assert.ok(calls.some(call => call[1] === 'stapler' && call[2] === 'validate'));
});
test('DMG verification checks native app version/architecture/link and detaches on failure', t => {
  const { env, paths } = fixture(t); mkdirSync(paths.directory);
  let detached = 0;
  const run = (file, args) => {
    if (file === 'signature-display') return signature;
    if (file === 'hdiutil' && args[0] === 'attach') { mkdirSync(path.join(paths.mount, 'Zorid.app')); symlinkSync('/Applications', path.join(paths.mount, 'Applications')); }
    if (file === 'hdiutil' && args[0] === 'detach') { detached++; rmSync(path.join(paths.mount, 'Zorid.app'), { recursive: true }); rmSync(path.join(paths.mount, 'Applications')); }
    if (file.endsWith('PlistBuddy')) return args[1].endsWith('CFBundleIdentifier') ? 'app.zorid.notes' : args[1].endsWith('CFBundleShortVersionString') ? '1.2.3' : 'Zorid';
    if (file === 'lipo') return 'x86_64';
    return '';
  };
  assert.throws(() => verifyDmg('/test.dmg', env, run), /architecture/);
  assert.equal(detached, 1); assert.equal(existsSync(paths.mount), false);
  verifyDmg('/test.dmg', env, (file, args) => file === 'lipo' ? 'arm64' : run(file, args));
  assert.equal(detached, 2);
});
test('cleanup preserves a mounted directory when detach fails but still deletes private key material', t => {
  const { env, paths } = fixture(t); mkdirSync(paths.directory); mkdirSync(paths.mount); writeFileSync(paths.p8, 'synthetic key'); writeFileSync(path.join(paths.mount, 'do-not-delete'), 'mounted');
  assert.throws(() => cleanupSigning(env, () => { throw new Error('detach failed'); }), /detach failed/);
  assert.equal(existsSync(paths.p8), false); assert.equal(existsSync(path.join(paths.mount, 'do-not-delete')), true);
});
test('DMG notarization is gated by signing and includes image/staple/Gatekeeper verification', t => {
  const { env } = fixture(t); const calls = [];
  notarizeDmg('/test.dmg', env, (file, args) => { calls.push([file, ...args]); return file === 'signature-display' ? signature : args[0] === 'notarytool' ? '{"status":"Accepted","id":"id"}' : ''; });
  assert.ok(calls.some(call => call[0] === 'hdiutil' && call[1] === 'verify'));
  assert.ok(calls.some(call => call[0] === 'spctl' && call.includes('context:primary-signature')));
});
