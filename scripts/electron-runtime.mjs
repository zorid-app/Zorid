import fs from 'node:fs/promises';
import path from 'node:path';

export const electronExecutable = 'Electron.app/Contents/MacOS/Electron';

export async function verifyRuntimeDirectories(distribution) {
  for (const relative of ['', 'Electron.app', 'Electron.app/Contents', 'Electron.app/Contents/MacOS']) {
    const stat = await fs.lstat(path.join(distribution, relative));
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Electron executable directories must be real directories');
  }
}

export async function regularRuntimeFile(filename) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Electron runtime input must be a regular file: ${path.basename(filename)}`);
  return fs.readFile(filename);
}

export async function electronPackage(root) {
  const project = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  // Resolve the explicitly installed project dependency without invoking Electron's
  // index.js, which can download a runtime as a side effect in Electron 42+.
  const directory = await fs.realpath(path.join(root, 'node_modules/electron'));
  const metadata = JSON.parse(await regularRuntimeFile(path.join(directory, 'package.json')));
  if (metadata.version !== project.devDependencies.electron) throw new Error('Installed Electron version does not match the release pin; run the explicit frozen dependency install');
  return { directory, version: metadata.version };
}

export async function macRuntimeArchitecture(filename) {
  const header = (await regularRuntimeFile(filename)).subarray(0, 8);
  if (header.length !== 8 || header.readUInt32LE(0) !== 0xfeedfacf) throw new Error('Expected a thin macOS Electron Mach-O executable');
  const cpu = header.readUInt32LE(4);
  if (cpu === 0x0100000c) return 'arm64';
  if (cpu === 0x01000007) return 'x64';
  throw new Error('Unsupported Electron executable architecture');
}

export async function verifyElectronRuntime(root, architecture) {
  const pkg = await electronPackage(root);
  const directory = path.join(pkg.directory, 'dist');
  await verifyRuntimeDirectories(directory);
  const version = (await regularRuntimeFile(path.join(directory, 'version'))).toString('utf8').trim().replace(/^v/, '');
  if (version !== pkg.version) throw new Error('Downloaded Electron distribution does not match its package version');
  const executable = (await regularRuntimeFile(path.join(pkg.directory, 'path.txt'))).toString('utf8').trim();
  if (executable !== electronExecutable) throw new Error('Installed Electron executable path is not the macOS distribution path');
  const actualArchitecture = await macRuntimeArchitecture(path.join(directory, executable));
  if (architecture && actualArchitecture !== architecture) throw new Error(`Installed Electron architecture is ${actualArchitecture}, expected ${architecture}; use a separate dependency installation for each architecture`);
  const license = await regularRuntimeFile(path.join(directory, 'LICENSE'));
  const chromiumNotices = await regularRuntimeFile(path.join(directory, 'LICENSES.chromium.html'));
  return { ...pkg, distribution: directory, architecture: actualArchitecture, license, chromiumNotices };
}
