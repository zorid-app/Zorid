import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function decodeSecret(value, name) {
  const compact = (value || '').replace(/\s/g, '');
  if (!compact || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) throw new Error(`${name} must contain valid base64.`);
  return Buffer.from(compact, 'base64');
}
export function validateNotaryResult(text) {
  const result = JSON.parse(text);
  if (result.status !== 'Accepted' || typeof result.id !== 'string' || !result.id) throw new Error('Apple notarization did not return Accepted.');
  return result.id;
}
export function validateSignature(text, identity, { app = true } = {}) {
  if (!identity.startsWith('Developer ID Application: ') || !text.split(/\r?\n/).includes(`Authority=${identity}`)) throw new Error('Developer ID signing identity does not match.');
  if (!/^Timestamp=.+$/m.test(text) || /Signature=adhoc/.test(text)) throw new Error('A timestamped Developer ID signature is required.');
  if (app && !/flags=.*\bruntime\b/.test(text)) throw new Error('Hardened runtime is required.');
}
export function releasePaths(env) {
  if (!['arm64', 'x64'].includes(env.RELEASE_ARCH) || !/^\d+$/.test(env.GITHUB_RUN_ID || '') || !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT || '') || !path.isAbsolute(env.RUNNER_TEMP || '')) throw new Error('Valid runner identity, absolute temporary path and release architecture are required.');
  const directory = path.join(env.RUNNER_TEMP, `zorid-signing-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${env.RELEASE_ARCH}`);
  return { directory, keychain: path.join(directory, 'release.keychain-db'), p12: path.join(directory, 'certificate.p12'), p8: path.join(directory, 'AuthKey.p8'), zip: path.join(directory, 'Zorid.zip'), mount: path.join(directory, 'mount') };
}
export function command(file, args) {
  try { return execFileSync(file, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { throw new Error(`${path.basename(file)} failed with exit status ${error.status ?? 'unknown'}.`); }
}
function required(env, name) { if (!env[name]) throw new Error(`${name} is required.`); return env[name]; }
function identity(env) {
  const value = required(env, 'MACOS_SIGNING_IDENTITY');
  if (!/^Developer ID Application: [^\r\n"]+ \([A-Z0-9]{10}\)$/.test(value)) throw new Error('MACOS_SIGNING_IDENTITY must be the full Developer ID Application identity.');
  return value;
}
export function prepareSigning(env = process.env, run = command) {
  const paths = releasePaths(env);
  const name = identity(env);
  const password = required(env, 'MACOS_CERTIFICATE_PASSWORD');
  if (!/^[A-Z0-9]{10}$/.test(required(env, 'APPLE_API_KEY_ID')) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(required(env, 'APPLE_API_ISSUER_ID'))) throw new Error('Apple team API key ID/issuer is invalid.');
  const certificate = decodeSecret(env.MACOS_CERTIFICATE_P12_BASE64, 'MACOS_CERTIFICATE_P12_BASE64');
  const key = decodeSecret(env.APPLE_API_KEY_P8_BASE64, 'APPLE_API_KEY_P8_BASE64');
  if (!key.toString('utf8').startsWith('-----BEGIN PRIVATE KEY-----')) throw new Error('Apple API key must be a PEM private key.');
  mkdirSync(paths.directory, { mode: 0o700 });
  writeFileSync(paths.p12, certificate, { mode: 0o600, flag: 'wx' });
  writeFileSync(paths.p8, key, { mode: 0o600, flag: 'wx' });
  const keychainPassword = randomBytes(32).toString('hex');
  run('security', ['create-keychain', '-p', keychainPassword, paths.keychain]);
  run('security', ['set-keychain-settings', '-lut', '21600', paths.keychain]);
  run('security', ['unlock-keychain', '-p', keychainPassword, paths.keychain]);
  run('security', ['import', paths.p12, '-k', paths.keychain, '-P', password, '-T', '/usr/bin/codesign', '-T', '/usr/bin/security']);
  run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', keychainPassword, paths.keychain]);
  const identities = run('security', ['find-identity', '-v', '-p', 'codesigning', paths.keychain]);
  if (!identities.includes(`"${name}"`)) throw new Error('Requested Developer ID identity is unavailable in the temporary keychain.');
  rmSync(paths.p12);
  const output = required(env, 'GITHUB_ENV');
  if ([paths.keychain, name].some(value => /[\r\n]/.test(value))) throw new Error('Invalid signing environment value.');
  appendFileSync(output, `CSC_KEYCHAIN=${paths.keychain}\nCSC_NAME=${name}\n`);
}
function signature(file, env, run, app) {
  run('codesign', ['--verify', '--strict', ...(app ? ['--deep'] : []), '--verbose=2', file]);
  // codesign writes display information to stderr, even on success.
  let details;
  if (run === command) {
    const result = spawnSync('codesign', ['-d', '--verbose=4', file], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (result.status !== 0) throw new Error('Unable to inspect code signature.');
    details = result.stderr;
  } else details = run('signature-display', [file]);
  validateSignature(details, identity(env), { app });
}
function submit(file, env, run) {
  const p = releasePaths(env);
  validateNotaryResult(run('xcrun', ['notarytool', 'submit', file, '--key', p.p8, '--key-id', required(env, 'APPLE_API_KEY_ID'), '--issuer', required(env, 'APPLE_API_ISSUER_ID'), '--wait', '--timeout', '30m', '--output-format', 'json']));
}
function staple(file, run) { run('xcrun', ['stapler', 'staple', file]); run('xcrun', ['stapler', 'validate', file]); }
export function notarizeApp(file, env = process.env, run = command) {
  signature(file, env, run, true);
  const p = releasePaths(env);
  run('ditto', ['-c', '-k', '--keepParent', file, p.zip]);
  submit(p.zip, env, run);
  staple(file, run);
  signature(file, env, run, true);
  run('spctl', ['--assess', '--type', 'execute', '--verbose=2', file]);
  rmSync(p.zip, { force: true });
}
export function notarizeDmg(file, env = process.env, run = command) {
  signature(file, env, run, false);
  submit(file, env, run);
  staple(file, run);
  signature(file, env, run, false);
  run('hdiutil', ['verify', file]);
  run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', file]);
}
export function verifyDmg(file, env = process.env, run = command) {
  const p = releasePaths(env);
  mkdirSync(p.mount, { mode: 0o700 });
  let mounted = false;
  try {
    run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', p.mount, file]); mounted = true;
    const app = path.join(p.mount, 'Zorid.app');
    if (readlinkSync(path.join(p.mount, 'Applications')) !== '/Applications') throw new Error('DMG must contain the drag-to-Applications link.');
    if (!existsSync(app)) throw new Error('DMG must contain Zorid.app.');
    signature(app, env, run, true);
    run('xcrun', ['stapler', 'validate', app]);
    run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
    const info = path.join(app, 'Contents', 'Info.plist');
    const bundleId = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', info]).trim();
    if (bundleId !== 'app.zorid.notes') throw new Error('Mounted application identifier differs from Zorid.');
    run('pnpm', ['run', 'package:verify', app]);
    const version = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', info]).trim();
    if (version !== required(env, 'RELEASE_VERSION')) throw new Error('Mounted application version differs from release version.');
    const executable = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', info]).trim();
    if (!executable || executable.includes('/') || executable.includes('\\') || executable === '..') throw new Error('Invalid app executable name.');
    const arch = run('lipo', ['-archs', path.join(app, 'Contents', 'MacOS', executable)]).trim();
    if (arch !== (env.RELEASE_ARCH === 'x64' ? 'x86_64' : 'arm64')) throw new Error('Mounted application architecture differs from release target.');
  } finally {
    if (mounted) run('hdiutil', ['detach', p.mount]);
    if (!mounted || !readdirSync(p.mount).length) rmSync(p.mount, { recursive: true, force: true });
  }
}
export function cleanupSigning(env = process.env, run = command) {
  const p = releasePaths(env);
  let error;
  if (existsSync(p.mount)) {
    try { run('hdiutil', ['detach', p.mount]); } catch (failure) { error = failure; }
  }
  if (existsSync(p.keychain)) {
    try { run('security', ['delete-keychain', p.keychain]); } catch (failure) { error = failure; }
  }
  // Never recursively delete a possibly mounted volume if detaching failed.
  for (const file of [p.p12, p.p8, p.zip]) rmSync(file, { force: true });
  if (!error) rmSync(p.directory, { recursive: true, force: true });
  if (error) throw error;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.platform !== 'darwin') throw new Error('macOS release signing requires a macOS runner.');
    const [action, file] = process.argv.slice(2);
    if (action === 'prepare') prepareSigning();
    else if (action === 'cleanup') cleanupSigning();
    else if (file && action === 'notarize-app') notarizeApp(path.resolve(file));
    else if (file && action === 'notarize-dmg') notarizeDmg(path.resolve(file));
    else if (file && action === 'verify-dmg') verifyDmg(path.resolve(file));
    else throw new Error('Unknown release action.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
