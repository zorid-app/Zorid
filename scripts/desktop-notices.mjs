import fs from 'node:fs/promises';
import path from 'node:path';
import { verifyElectronRuntime } from './electron-runtime.mjs';

const legalFile = /^(licen[cs]e|copying|notice)([._-].*)?$/i;
const apacheFontPackages = new Set(['@mathjax/mathjax-tex-font', '@mathjax/mathjax-mhchem-font-extension', '@mathjax/mathjax-newcm-font']);
async function readNotice(filename) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Distribution notice must be a regular file: ${path.basename(filename)}`);
  return fs.readFile(filename);
}

/** Follow installed package locations without depending on package export maps. */
async function packageDirectory(name, from) {
  for (let directory = from; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'node_modules', name, 'package.json');
    try {
      const metadata = await fs.lstat(candidate);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Package metadata must be a regular file: ${name}`);
      return await fs.realpath(path.dirname(candidate));
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (directory === path.dirname(directory)) throw Object.assign(new Error(`Missing installed dependency: ${name}`), { code: 'ENOENT' });
  }
}

/** Conservative notices for regular production dependencies and installed peers. */
export async function desktopNotices(root, metadata) {
  const packages = [], visited = new Set();
  async function visit(name, from, optional = false) {
    let directory;
    try { directory = await packageDirectory(name, from); }
    catch (error) { if (optional && error.code === 'ENOENT') return; throw error; }
    if (visited.has(directory)) return;
    visited.add(directory);
    const pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
    const texts = [];
    for (const filename of (await fs.readdir(directory)).filter(name => legalFile.test(name)).sort()) {
      texts.push({ filename, text: (await readNotice(path.join(directory, filename))).toString('utf8') });
    }
    if (!texts.length && apacheFontPackages.has(pkg.name) && pkg.license === 'Apache-2.0') {
      const mathjax = await packageDirectory('mathjax', root);
      texts.push({ filename: 'Apache-2.0 license text (from installed mathjax/LICENSE)', text: (await readNotice(path.join(mathjax, 'LICENSE'))).toString('utf8') });
    }
    if (!texts.length) throw new Error(`No distribution license text found for ${pkg.name}@${pkg.version}; audit this package before release`);
    packages.push({ name: pkg.name, version: pkg.version, license: pkg.license, repository: typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url, texts });
    // Optional native PDF.js canvas packages are not shipped by the browser build.
    const dependencies = { ...pkg.dependencies, ...pkg.peerDependencies };
    for (const dependency of Object.keys(dependencies).sort()) {
      await visit(dependency, directory, pkg.peerDependenciesMeta?.[dependency]?.optional === true);
    }
  }
  for (const dependency of Object.keys(metadata.dependencies ?? {}).sort()) {
    await visit(dependency, root);
  }
  packages.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'));
  let text = 'Zorid third-party dependency notices\n\n';
  text += 'This inventory conservatively includes regular production dependencies and installed peers. Some packages are build inputs whose code may be omitted by bundling. Optional native modules are not shipped. Original bundled/runtime license and notice files are also preserved.\n\n';
  for (const pkg of packages) {
    text += `${'='.repeat(72)}\n${pkg.name}@${pkg.version}\nDeclared license: ${JSON.stringify(pkg.license ?? 'unspecified')}\n`;
    if (pkg.repository) text += `Repository: ${pkg.repository}\n`;
    for (const notice of pkg.texts) text += `\n--- ${notice.filename} ---\n${notice.text.trim()}\n`;
    text += '\n';
  }
  const electron = await verifyElectronRuntime(root);
  return new Map([
    ['THIRD_PARTY_NOTICES.txt', Buffer.from(text)],
    ['licenses/electron/LICENSE', electron.license],
    ['licenses/electron/LICENSES.chromium.html', electron.chromiumNotices],
  ]);
}
