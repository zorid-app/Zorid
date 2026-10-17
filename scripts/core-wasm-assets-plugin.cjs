const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const requiredExports = ['default', 'checkIdempotency', 'planMutation', 'validateSnapshot'];

function moduleExports(source) {
  // Parse syntax rather than accepting names in strings/comments. This parser is
  // already a webpack dependency; disabled builds never load it or read assets.
  const parser = require(require.resolve('acorn', {paths:[path.dirname(require.resolve('webpack/package.json'))]}));
  const ast = parser.parse(source, {ecmaVersion:'latest', sourceType:'module'});
  const names = new Set();
  for (const node of ast.body) {
    if (node.type === 'ExportDefaultDeclaration') names.add('default');
    if (node.type !== 'ExportNamedDeclaration' || node.source) continue;
    if (node.declaration?.id?.name) names.add(node.declaration.id.name);
    if (node.declaration?.type === 'VariableDeclaration') {
      for (const declaration of node.declaration.declarations) if (declaration.id.type === 'Identifier') names.add(declaration.id.name);
    }
    for (const specifier of node.specifiers) names.add(specifier.exported.name ?? specifier.exported.value);
  }
  return names;
}

async function createCoreWasmAssets(options = {}) {
  if (!options.enabled) return new Map();
  if (typeof options.directory !== 'string' || !options.directory) throw new Error('Core WASM fixture enabled: an explicit generated artifact directory is required');
  if (typeof options.buildId !== 'string' || !/^[0-9a-f]{7,64}(?:-dirty)?$/i.test(options.buildId)) throw new Error('Core WASM fixture enabled: source commit buildId is required');
  const filenames = ['zorid_wasm.js', 'zorid_wasm_bg.wasm'];
  const files = new Map();
  for (const filename of filenames) {
    let bytes;
    try { bytes = await fs.readFile(path.join(options.directory, filename)); }
    catch (error) { throw new Error(`Core WASM fixture enabled: cannot read generated ${filename}`, {cause:error}); }
    files.set(filename, bytes);
  }
  let exports;
  try { exports = moduleExports(files.get('zorid_wasm.js').toString('utf8')); }
  catch (error) { throw new Error('Core WASM fixture enabled: generated JavaScript is not a valid ES module', {cause:error}); }
  for (const name of requiredExports) if (!exports.has(name)) throw new Error(`Core WASM fixture enabled: generated module is missing export ${name}`);
  const wasm = files.get('zorid_wasm_bg.wasm');
  if (wasm.length < 8 || !wasm.subarray(0,8).equals(Buffer.from([0,97,115,109,1,0,0,0]))) throw new Error('Core WASM fixture enabled: generated binary is not a version1 WASM module');
  const manifest = {buildId:options.buildId, requiredExports, files:Object.fromEntries([...files].map(([name,bytes])=>[name,{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]))};
  return new Map([...files].map(([name,bytes])=>[`lib/core/${name}`,bytes]).concat([
    ['lib/core/manifest.json',Buffer.from(JSON.stringify(manifest,null,2)+'\n')],
  ]));
}

class CoreWasmAssetsPlugin {
  constructor(options = {}) { this.options = options; }
  apply(compiler) {
    if (!this.options.enabled) return;
    compiler.hooks.thisCompilation.tap('CoreWasmAssetsPlugin', compilation => {
      compilation.hooks.processAssets.tapPromise({name:'CoreWasmAssetsPlugin',stage:compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE},async () => {
        for (const [name,bytes] of await createCoreWasmAssets(this.options)) compilation.emitAsset(name,new compiler.webpack.sources.RawSource(bytes),{minimized:true});
      });
    });
  }
}
module.exports = {CoreWasmAssetsPlugin,createCoreWasmAssets};
