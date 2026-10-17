const path = require('node:path');
const { createVendorAssets } = require('./vendor-assets.cjs');

/** Ship the official PDF.js runtime with its license; no reference-app assets. */
async function createPdfAssets() {
  const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
  return createVendorAssets(root, 'lib/pdfjs/', ['LICENSE', 'build', 'web', 'cmaps', 'standard_fonts', 'wasm', 'iccs']);
}
class PdfAssetsPlugin {
  apply(compiler) {
    compiler.hooks.thisCompilation.tap('PdfAssetsPlugin', compilation => {
      compilation.hooks.processAssets.tapPromise({ name: 'PdfAssetsPlugin',
        // Preserve the vendor modules byte-for-byte after JS optimization.
        stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE }, async () => {
        for (const [name, bytes] of await createPdfAssets()) {
          // Optimization is already handled by the vendor distribution.
          compilation.emitAsset(name, new compiler.webpack.sources.RawSource(bytes), { minimized: true });
        }
      });
    });
  }
}
module.exports = { PdfAssetsPlugin, createPdfAssets };
