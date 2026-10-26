import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { desktopNotices } from './desktop-notices.mjs';
import { JSDOM } from 'jsdom';

export const desktopFiles = [
  'desktop/main.cjs', 'desktop/preload.cjs', 'desktop/vault-service.cjs',
  'desktop/vault-dispatch.cjs', 'desktop/window-broker.cjs', 'desktop/context-menu.cjs', 'desktop/menu-hotkeys.cjs',
  'desktop/editor-core.cjs', 'desktop/host-location.cjs', 'desktop/client-slots.cjs', 'desktop/client-admission.cjs',
  'desktop/core-vault-fixture-service.cjs', 'desktop/rust-vault-service.cjs', 'desktop/document-semantics.cjs', 'desktop/workblocks.cjs',
  'desktop/recovery-history.cjs', 'desktop/document-runtime.cjs', 'desktop/document-drafts.cjs',
  'desktop/durable-writes.cjs', 'desktop/durable-checkpoints.cjs', 'desktop/conditional-saved-source.cjs', 'desktop/text-create.cjs',
  'desktop/family-sync-protocol.cjs', 'desktop/family-fixture.cjs', 'desktop/family-fixture-preload.cjs',
  'desktop/family-fixture-renderer.js', 'desktop/family-fixture.html', 'desktop/family-fixture.css',
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

export const nativeResource = 'native/zorid-desktop-host';
export function nativeTarget(architecture) {
  const target = { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' }[architecture];
  if (!target) throw new Error('Only arm64 and x64 macOS native hosts are supported');
  return target;
}

/** Inspect without running a build input; a script or dylib is not a host. */
export async function readNativeHost(filename, architecture) {
  nativeTarget(architecture);
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111)) throw new Error('Native host must be a regular executable file');
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await file.stat();
    if (!actual.isFile() || !(actual.mode & 0o111) || actual.dev !== stat.dev || actual.ino !== stat.ino || actual.size < 32 || actual.size > 512 * 1024 * 1024) throw new Error('Invalid native host file size');
    const header = Buffer.alloc(32);
    if ((await file.read(header, 0, header.length, 0)).bytesRead !== 32 || header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(12) !== 2) throw new Error('Expected a thin macOS native host Mach-O executable');
    const cpu = header.readUInt32LE(4);
    const actualArchitecture = cpu === 0x0100000c ? 'arm64' : cpu === 0x01000007 ? 'x64' : null;
    if (actualArchitecture !== architecture) throw new Error(`Native host architecture does not match ${architecture}`);
    const data = await file.readFile();
    if (data.length !== actual.size) throw new Error('Native host changed while reading');
    return data;
  } finally { await file.close(); }
}

// Match only the flat hashed output layout selected by the renderer build.
const rendererAsset = /^dist\/assets\/[A-Za-z0-9_][A-Za-z0-9_.-]*-[A-Za-z0-9_-]{8,64}\.(?:js|css)$/;
function allowedRendererFile(relative) {
  if (relative === 'dist/index.html' || rendererAsset.test(relative)) return true;
  if (!/^dist\/lib\/(?:mathjax|pdfjs|prism)\//.test(relative)) return false;
  return /^LICENSE(?:[_.-].*)?$/i.test(path.basename(relative)) || vendorAssetExtensions.has(path.extname(relative));
}

/** Validate the entry actually loaded by packaged HTML, rather than guessing a
 * chunk name. Parsing never executes scripts or fetches referenced resources. */
async function validateRendererHtml(root, files) {
  const html = await fs.readFile(path.join(root, 'dist/index.html'));
  if (html.length > 1024 * 1024) throw new Error('Built renderer HTML exceeds the staging limit');
  const dom = new JSDOM(html.toString('utf8'));
  try {
    const document = dom.window.document, inventory = new Set(files);
    if (document.querySelector('base[href]')) throw new Error('Built renderer HTML must not override its local base URL');
    const requireAsset = (reference, extension) => {
      const relative = typeof reference === 'string' ? `dist/${reference.replace(/^\.\//, '')}` : '';
      if (!rendererAsset.test(relative) || !relative.endsWith(extension)) throw new Error(`Invalid local renderer reference: ${reference}`);
      if (!inventory.has(relative)) throw new Error(`Missing HTML-referenced renderer asset: ${relative}`);
    };
    const scripts = [...document.querySelectorAll('script')];
    if (scripts.length !== 1 || scripts[0].getAttribute('type')?.toLowerCase() !== 'module'
        || scripts[0].textContent.trim()) throw new Error('Built renderer HTML must load one external module entry');
    requireAsset(scripts[0].getAttribute('src'), '.js');
    const styles = [...document.querySelectorAll('link')].filter(link => link.relList.contains('stylesheet'));
    if (!styles.length) throw new Error('Built renderer HTML must load a stylesheet');
    for (const stylesheet of styles) requireAsset(stylesheet.getAttribute('href'), '.css');
    for (const preload of document.querySelectorAll('link')) if (preload.relList.contains('modulepreload')) requireAsset(preload.getAttribute('href'), '.js');
  } finally { dom.window.close(); }
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

export async function stageDesktop(root = projectRoot, options = {}) {
  const architecture = options.architecture ?? process.arch;
  const target = nativeTarget(architecture);
  const hostPath = options.nativeHost ?? process.env.ZORID_DESKTOP_HOST_BIN ?? path.join(root, 'target', target, 'release/zorid-desktop-host');
  if (!path.isAbsolute(hostPath)) throw new Error('Native host input path must be absolute');
  const nativeBytes = await readNativeHost(hostPath, architecture);
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
  await validateRendererHtml(root, rendererFiles);
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
  // Keep the executable outside ASAR so the installed app can spawn it directly.
  const nativeDirectory = path.join(staging, 'native');
  try { if ((await fs.lstat(nativeDirectory)).isSymbolicLink()) throw new Error('Native staging directory must not be a symlink'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.rm(nativeDirectory, { recursive: true, force: true });
  await fs.mkdir(nativeDirectory);
  await fs.writeFile(path.join(nativeDirectory, 'zorid-desktop-host'), nativeBytes, { mode: 0o755, flag: 'wx' });
  const inputs = { version: pkg.version, files: {}, native: {
    platform: 'darwin', architecture, resource: nativeResource,
    sourceSha256: sha256(nativeBytes), sourceByteLength: nativeBytes.length,
  } };
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
