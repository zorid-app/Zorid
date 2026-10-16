const fs = require('node:fs/promises');
const path = require('node:path');

/** Ship only upstream runtime/TeX-font assets needed by the local math loader. */
class MathAssetsPlugin {
  apply(compiler) {
    compiler.hooks.thisCompilation.tap('MathAssetsPlugin', compilation => {
      compilation.hooks.processAssets.tapPromise({ name: 'MathAssetsPlugin',
        stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE }, async () => {
        const packages = [
          ['mathjax', '', ['LICENSE', 'tex-chtml-nofont.js', 'input/tex', 'ui/safe.js']],
          ['@mathjax/mathjax-tex-font', 'fonts/mathjax-tex-font/', ['package.json', 'chtml.js', 'chtml']],
          ['@mathjax/mathjax-mhchem-font-extension', 'fonts/mathjax-mhchem-font-extension/', ['package.json', 'chtml.js', 'chtml']],
        ];
        for (const [name, prefix, selected] of packages) {
          const root = path.dirname(require.resolve(`${name}/package.json`));
          const emit = async relative => {
            const source = path.join(root, relative), stat = await fs.stat(source);
            if (stat.isDirectory()) {
              for (const entry of (await fs.readdir(source)).sort()) await emit(path.join(relative, entry));
            } else if (!relative.endsWith('.map')) {
              compilation.emitAsset(`lib/mathjax/${prefix}${relative.split(path.sep).join('/')}`,
                new compiler.webpack.sources.RawSource(await fs.readFile(source)), { minimized: true });
            }
          };
          for (const relative of selected) await emit(relative);
        }
      });
    });
  }
}
module.exports = { MathAssetsPlugin };
