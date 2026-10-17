import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile, listPackage, statFile } from '@electron/asar';
import { sha256, nativeResource, readNativeHost } from './stage-desktop.mjs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { validateSignature } from './release/macos-release.mjs';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

/** Compare every packed runtime file with the enumerated staging inputs. */
async function verifyArchiveFiles(archive, inputs) {
  const expected = Object.keys(inputs.files).sort(), actual = [];
  for (const entry of listPackage(archive)) {
    const relative = entry.replace(/^\//, ''), stat = statFile(archive, relative, false);
    if (stat.link) throw new Error(`Unexpected ASAR symlink: ${relative}`);
    if (stat.files) continue;
    if (stat.unpacked) throw new Error(`Unexpected unpacked runtime file: ${relative}`);
    actual.push(relative);
  }
  actual.sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Packaged file inventory does not match staged release inputs');
  for (const relative of expected) {
    const data = extractFile(archive, relative);
    if (relative === 'package.json') {
      // Builder normalizes JSON formatting; every metadata value must still match.
      const pkg = JSON.parse(data.toString());
      if (!inputs.package || JSON.stringify(canonical(pkg)) !== JSON.stringify(canonical(inputs.package))) {
        throw new Error('Packaged application metadata differs from the staged runtime contract');
      }
    } else if (sha256(data) !== inputs.files[relative]) throw new Error(`Packaged file content mismatch: ${relative}`);
  }
  return { version: inputs.version, fileCount: actual.length };
}

async function readManifest(filename) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Release input manifest must be a regular file');
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}
async function nativeFile(archive, inputs, architecture) {
  const native = inputs.native;
  if (!native || native.platform !== 'darwin' || native.resource !== nativeResource ||
      !['arm64', 'x64'].includes(native.architecture) || !/^[a-f0-9]{64}$/.test(native.sourceSha256) ||
      !Number.isSafeInteger(native.sourceByteLength) || native.sourceByteLength < 32) throw new Error('Missing or invalid native host release manifest');
  if (architecture !== undefined && architecture !== native.architecture) throw new Error('Packaged native host target architecture mismatch');
  const directory = path.join(path.dirname(archive), 'native');
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Packaged native host directory must be a real directory');
  if (JSON.stringify(await fs.readdir(directory)) !== JSON.stringify(['zorid-desktop-host'])) throw new Error('Packaged native resource inventory mismatch');
  const filename = path.join(directory, 'zorid-desktop-host');
  return { filename, data: await readNativeHost(filename, native.architecture), native };
}
function verifyNativeSignature(filename, identity) {
  const options = { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 };
  const verified = spawnSync('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', filename], options);
  if (verified.error || verified.status !== 0) throw new Error('Native host code signature verification failed');
  const displayed = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', filename], options);
  if (displayed.error || displayed.status !== 0) throw new Error('Native host code signature inspection failed');
  validateSignature(displayed.stderr, identity, { app: true });
}

/** Exact source bytes before signing; exact signed bytes and identity afterward. */
export async function verifyDesktopArchive(archive, inputManifest, options = {}) {
  const inputs = await readManifest(inputManifest);
  const result = await verifyArchiveFiles(archive, inputs);
  const { filename, data, native } = await nativeFile(archive, inputs, options.architecture);
  const signed = options.sourceOnly ? undefined : native.signed;
  const expectedHash = signed?.sha256 ?? native.sourceSha256;
  const expectedLength = signed?.byteLength ?? native.sourceByteLength;
  if (sha256(data) !== expectedHash || data.length !== expectedLength) throw new Error('Packaged native host content mismatch');
  if (signed) verifyNativeSignature(filename, signed.identity);
  return { ...result, nativeArchitecture: native.architecture };
}

/** Called only after builder signing, following the exact-byte afterPack gate.
 * Preserve the source digest; codesign changes the executable's signature bytes.
 * The external manifest is not shipped inside the app or altered by notarization.
 */
export async function recordSignedNativeHost(archive, inputManifest, identity, architecture) {
  if (!identity?.startsWith('Developer ID Application: ')) throw new Error('Native host requires the expected Developer ID signing identity');
  const inputs = await readManifest(inputManifest);
  await verifyArchiveFiles(archive, inputs);
  const { filename, data, native } = await nativeFile(archive, inputs, architecture);
  const source = await readNativeHost(path.join(path.dirname(inputManifest), nativeResource), native.architecture);
  if (sha256(source) !== native.sourceSha256 || source.length !== native.sourceByteLength) throw new Error('Native host staging input changed after packing');
  verifyNativeSignature(filename, identity);
  inputs.native.signed = { identity, sha256: sha256(data), byteLength: data.length };
  const temporary = `${inputManifest}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(inputs, null, 2)}\n`, { flag: 'wx' });
    await fs.rename(temporary, inputManifest);
  } finally { await fs.rm(temporary, { force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv.slice(2).filter(argument => argument !== '--')[0];
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!target) { console.error('Usage: package:verify <Zorid.app or app.asar>'); process.exitCode = 1; }
  else {
    const archive = target.endsWith('.app') ? path.join(target, 'Contents/Resources/app.asar') : target;
    verifyDesktopArchive(archive, path.join(root, '.release/inputs.json'))
      .then(result => console.log(`Verified ${result.fileCount} packaged files for Zorid ${result.version}`))
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
