const path = require('node:path');
const { createVendorAssets } = require('./vendor-assets.cjs');

/** Ship only upstream runtime/TeX-font assets needed by the local math loader. */
async function createMathAssets() {
  const packages = [
    ['mathjax', '', ['LICENSE', 'tex-chtml-nofont.js', 'input/tex', 'ui/safe.js']],
    ['@mathjax/mathjax-tex-font', 'fonts/mathjax-tex-font/', ['package.json', 'chtml.js', 'chtml']],
    ['@mathjax/mathjax-mhchem-font-extension', 'fonts/mathjax-mhchem-font-extension/', ['package.json', 'chtml.js', 'chtml']],
  ];
  const assets = new Map();
  for (const [name, prefix, selected] of packages) {
    const root = path.dirname(require.resolve(`${name}/package.json`));
    for (const [assetPath, bytes] of await createVendorAssets(root, `lib/mathjax/${prefix}`, selected)) assets.set(assetPath, bytes);
  }
  return assets;
}
class MathAssetsPlugin {
  apply(compiler) {
    compiler.hooks.thisCompilation.tap('MathAssetsPlugin', compilation => {
      compilation.hooks.processAssets.tapPromise({ name: 'MathAssetsPlugin',
        stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE }, async () => {
        for (const [name, bytes] of await createMathAssets()) {
          compilation.emitAsset(name, new compiler.webpack.sources.RawSource(bytes), { minimized: true });
        }
      });
    });
  }
}
module.exports = { MathAssetsPlugin, createMathAssets };
