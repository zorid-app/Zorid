const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

/** Build only from the pinned official dependency. No recovered application assets. */
async function createPrismAssets() {
  const root = path.dirname(require.resolve('prismjs/package.json'));
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (pkg.version !== '1.30.0') throw new Error(`Expected Prism 1.30.0; found ${pkg.version}`);
  const components = JSON.parse(await fs.readFile(path.join(root, 'components.json'), 'utf8'));
  const getLoader = require(path.join(root, 'dependencies.js'));
  const languages = Object.keys(components.languages).filter(name => name !== 'meta');
  const ordered = getLoader(components, languages).getIds();
  const parts = [], sources = [];
  for (const id of ['core', ...ordered]) {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error('Unexpected Prism component identifier');
    const file = `components/prism-${id}.min.js`, data = await fs.readFile(path.join(root, file));
    sources.push({ id, file, sha256: createHash('sha256').update(data).digest('hex') });
    parts.push(data);
  }
  const bundle = Buffer.concat(parts.flatMap(data => [data, Buffer.from('\n;\n')]));
  const manifest = { package: 'prismjs', version: pkg.version, languages: ordered,
    bundleSha256: createHash('sha256').update(bundle).digest('hex'), sources };
  return new Map([
    ['lib/prism/prism.js', bundle],
    ['lib/prism/LICENSE', await fs.readFile(path.join(root, 'LICENSE'))],
    ['lib/prism/manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n')],
  ]);
}
class PrismAssetsPlugin {
  apply(compiler) {
    compiler.hooks.thisCompilation.tap('PrismAssetsPlugin', compilation => {
      compilation.hooks.processAssets.tapPromise({ name: 'PrismAssetsPlugin', stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE }, async () => {
        for (const [name, data] of await createPrismAssets()) compilation.emitAsset(name, new compiler.webpack.sources.RawSource(data), { minimized: true });
      });
    });
  }
}
module.exports = { PrismAssetsPlugin, createPrismAssets };
