const fs = require('node:fs/promises');
const path = require('node:path');

/** Ship the official PDF.js runtime with its license; no reference-app assets. */
class PdfAssetsPlugin {
  apply(compiler) {
    compiler.hooks.thisCompilation.tap('PdfAssetsPlugin', compilation => {
      compilation.hooks.processAssets.tapPromise({ name: 'PdfAssetsPlugin',
        // Preserve the vendor modules byte-for-byte after JS optimization.
        stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE }, async () => {
        const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
        const emit = async relative => {
          const source = path.join(root, relative);
          const stat = await fs.stat(source);
          if (stat.isDirectory()) {
            for (const entry of (await fs.readdir(source)).sort()) await emit(path.join(relative, entry));
          } else if (!relative.endsWith('.map')) {
            compilation.emitAsset('lib/pdfjs/' + relative.split(path.sep).join('/'),
              new compiler.webpack.sources.RawSource(await fs.readFile(source)),
              // Optimization is already handled by the vendor distribution.
              // Also prevents minimizers that process late-added assets.
              { minimized: true });
          }
        };
        for (const relative of ['LICENSE', 'build', 'web', 'cmaps', 'standard_fonts', 'wasm', 'iccs']) await emit(relative);
      });
    });
  }
}
module.exports = { PdfAssetsPlugin };
