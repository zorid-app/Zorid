import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile, listPackage, statFile } from '@electron/asar';
import { sha256 } from './stage-desktop.mjs';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

/** Compare every packed runtime file with the enumerated staging inputs. */
export async function verifyDesktopArchive(archive, inputManifest) {
  const inputs = JSON.parse(await fs.readFile(inputManifest, 'utf8'));
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
