import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { desktopNotices } from './desktop-notices.mjs';

export const desktopFiles = [
  'desktop/main.cjs', 'desktop/preload.cjs', 'desktop/vault-service.cjs',
  'desktop/vault-dispatch.cjs', 'desktop/window-broker.cjs', 'desktop/context-menu.cjs', 'desktop/menu-hotkeys.cjs',
];
export const requiredRendererFiles = [
  'dist/index.html', 'dist/lib/mathjax/LICENSE', 'dist/lib/mathjax/tex-chtml-nofont.js',
  'dist/lib/mathjax/ui/safe.js', 'dist/lib/mathjax/fonts/mathjax-tex-font/chtml.js',
  'dist/lib/mathjax/fonts/mathjax-mhchem-font-extension/chtml.js',
  'dist/lib/pdfjs/LICENSE', 'dist/lib/pdfjs/build/pdf.mjs', 'dist/lib/pdfjs/build/pdf.worker.mjs',
  'dist/lib/pdfjs/web/pdf_viewer.mjs', 'dist/lib/pdfjs/web/pdf_viewer.css',
  'dist/lib/prism/LICENSE', 'dist/lib/prism/prism.js', 'dist/lib/prism/manifest.json',
];
export const requiredRendererDirectories = [
  'dist/lib/mathjax/input/tex/', 'dist/lib/mathjax/fonts/mathjax-tex-font/chtml/woff2/',
  'dist/lib/mathjax/fonts/mathjax-mhchem-font-extension/chtml/woff2/',
  'dist/lib/pdfjs/cmaps/', 'dist/lib/pdfjs/standard_fonts/', 'dist/lib/pdfjs/wasm/',
  'dist/lib/pdfjs/iccs/', 'dist/lib/pdfjs/web/images/',
];
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sha256 = data => createHash('sha256').update(data).digest('hex');
const vendorAssetExtensions = new Set(['.js', '.mjs', '.mts', '.json', '.css', '.woff', '.woff2', '.ttf', '.pfb', '.bcmap', '.wasm', '.icc', '.svg', '.gif', '.png']);

function allowedRendererFile(relative) {
  if (relative === 'dist/index.html' || /^dist\/(?:main|\d+)\.[\da-f]+\.js(?:\.LICENSE\.txt)?$/.test(relative)) return true;
  if (!/^dist\/lib\/(?:mathjax|pdfjs|prism)\//.test(relative)) return false;
  return /^LICENSE(?:[_.-].*)?$/i.test(path.basename(relative)) || vendorAssetExtensions.has(path.extname(relative));
}

/** Enumerate without following symlinks into local data or build caches. */
async function collectFiles(root, relative) {
  const stat = await fs.lstat(path.join(root, relative));
  if (stat.isSymbolicLink()) throw new Error(`Release inputs must not be symlinks: ${relative}`);
  if (stat.isFile()) return relative.endsWith('.map') ? [] : [relative];
  if (!stat.isDirectory()) throw new Error(`Unsupported release input: ${relative}`);
  const result = [];
  for (const name of (await fs.readdir(path.join(root, relative))).sort()) {
    if (name.startsWith('.') || ['node_modules', 'recovered'].includes(name)) throw new Error(`Unexpected build input: ${relative}/${name}`);
    result.push(...await collectFiles(root, `${relative}/${name}`));
  }
  return result;
}

export async function stageDesktop(root = projectRoot) {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const desktopDirectory = await fs.lstat(path.join(root, 'desktop'));
  if (!desktopDirectory.isDirectory() || desktopDirectory.isSymbolicLink()) throw new Error('Desktop source directory must be a real directory');
  const rendererFiles = await collectFiles(root, 'dist');
  for (const file of rendererFiles) if (!allowedRendererFile(file)) throw new Error(`Unexpected renderer output: ${file}`);
  const files = [...desktopFiles, 'LICENSE', ...rendererFiles].sort();
  for (const relative of [...desktopFiles, 'LICENSE']) {
    const stat = await fs.lstat(path.join(root, relative));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected regular release input: ${relative}`);
  }
  for (const required of requiredRendererFiles) if (!files.includes(required)) throw new Error(`Missing built renderer asset: ${required}`);
  for (const directory of requiredRendererDirectories) {
    if (!files.some(file => file.startsWith(directory))) throw new Error(`Missing built renderer assets: ${directory}`);
  }
  if (!files.some(file => /^dist\/main\.[\da-f]+\.js$/.test(file))) throw new Error('Missing production renderer entry chunk');
  const notices = await desktopNotices(root, pkg);
  const staging = path.join(root, '.release');
  try { if ((await fs.lstat(staging)).isSymbolicLink()) throw new Error('Release staging directory must not be a symlink'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(staging, { recursive: true });
  const inputManifest = path.join(staging, 'inputs.json');
  try {
    const existing = await fs.lstat(inputManifest);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('Release input manifest must be a regular file');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const appDirectory = path.join(staging, 'app');
  await fs.rm(appDirectory, { recursive: true, force: true });
  await fs.mkdir(appDirectory);
  const inputs = { version: pkg.version, files: {} };
  for (const relative of files) {
    const data = await fs.readFile(path.join(root, relative));
    await fs.mkdir(path.dirname(path.join(appDirectory, relative)), { recursive: true });
    await fs.writeFile(path.join(appDirectory, relative), data);
    inputs.files[relative] = sha256(data);
  }
  for (const [relative, data] of notices) {
    await fs.mkdir(path.dirname(path.join(appDirectory, relative)), { recursive: true });
    await fs.writeFile(path.join(appDirectory, relative), data);
    inputs.files[relative] = sha256(data);
  }
  const appPackage = {
    name: pkg.name, version: pkg.version, description: pkg.description,
    author: { name: 'Zorid contributors' }, license: pkg.license, main: 'desktop/main.cjs',
  };
  const packageBytes = Buffer.from(`${JSON.stringify(appPackage, null, 2)}\n`);
  await fs.writeFile(path.join(appDirectory, 'package.json'), packageBytes);
  inputs.files['package.json'] = sha256(packageBytes);
  inputs.package = appPackage;
  const temporaryManifest = path.join(staging, `inputs-${randomUUID()}.json`);
  try {
    await fs.writeFile(temporaryManifest, `${JSON.stringify(inputs, null, 2)}\n`, { flag: 'wx' });
    await fs.rename(temporaryManifest, inputManifest);
  } finally { await fs.rm(temporaryManifest, { force: true }); }
  return { appDirectory, inputManifest, fileCount: Object.keys(inputs.files).length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stageDesktop().then(result => console.log(`Staged ${result.fileCount} desktop files in ${result.appDirectory}`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
