const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createVendorAssets } = require('../scripts/vendor-assets.cjs');
const { createPdfAssets, PdfAssetsPlugin } = require('../scripts/pdf-assets.cjs');
const { createMathAssets, MathAssetsPlugin } = require('../scripts/math-assets.cjs');

test('vendor selection retains license bytes, selected order and sorted nested files while excluding maps and unselected roots', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zorid-vendor-assets-'));
  try {
    await fs.mkdir(path.join(root, 'runtime', 'nested'), {recursive:true});
    for (const [name, bytes] of [['LICENSE','upstream license'],['runtime/z.js','z'],['runtime/a.js','a'],['runtime/a.js.map','map'],['runtime/nested/font.woff2','font'],['unselected.js','omit']]) await fs.writeFile(path.join(root, name), bytes);
    const assets = await createVendorAssets(root, 'lib/vendor/', ['LICENSE', 'runtime']);
    assert.deepEqual([...assets.keys()], ['lib/vendor/LICENSE','lib/vendor/runtime/a.js','lib/vendor/runtime/nested/font.woff2','lib/vendor/runtime/z.js']);
    assert.deepEqual(assets.get('lib/vendor/LICENSE'), Buffer.from('upstream license'));
    assert.ok([...assets.values()].every(Buffer.isBuffer));
  } finally { await fs.rm(root, {recursive:true,force:true}); }
});

async function webpackAssets(Plugin) {
  const assets = new Map(); let collect;
  const stage = 1000;
  const compilation = {hooks:{processAssets:{tapPromise(options, callback){assert.equal(options.stage, stage);collect=callback;}}},
    emitAsset(name, source, info){assert.deepEqual(info,{minimized:true});assets.set(name,source.bytes);}};
  new Plugin().apply({hooks:{thisCompilation:{tap(_name, callback){callback(compilation);}}},
    webpack:{Compilation:{PROCESS_ASSETS_STAGE_SUMMARIZE:stage},sources:{RawSource:class{constructor(bytes){this.bytes=bytes;}}}}});
  await collect(); return assets;
}
test('bundler-independent PDF collection preserves current vendor selection and Webpack bytes', async () => {
  const assets = await createPdfAssets();
  assert.ok(assets.has('lib/pdfjs/LICENSE'));
  for (const selected of ['build','web','cmaps','standard_fonts','wasm','iccs']) assert.ok([...assets.keys()].some(name=>name.startsWith(`lib/pdfjs/${selected}/`)), selected);
  assert.ok([...assets.keys()].every(name=>/^lib\/pdfjs\/(LICENSE$|build\/|web\/|cmaps\/|standard_fonts\/|wasm\/|iccs\/)/.test(name)&&!name.endsWith('.map')&&!name.includes('\\')));
  assert.ok([...assets.values()].every(Buffer.isBuffer));
  assert.deepEqual(await webpackAssets(PdfAssetsPlugin), assets);
});
test('bundler-independent math collection preserves current runtime and font selections and Webpack bytes', async () => {
  const assets = await createMathAssets();
  for (const name of ['LICENSE','tex-chtml-nofont.js','input/tex/extensions/mhchem.js','ui/safe.js','fonts/mathjax-tex-font/package.json','fonts/mathjax-tex-font/chtml.js','fonts/mathjax-mhchem-font-extension/package.json','fonts/mathjax-mhchem-font-extension/chtml.js']) assert.ok(assets.has(`lib/mathjax/${name}`), name);
  assert.ok([...assets.keys()].every(name=>!name.endsWith('.map')&&!name.includes('/svg/')&&!name.includes('\\')));
  assert.ok([...assets.values()].every(Buffer.isBuffer));
  assert.deepEqual(await webpackAssets(MathAssetsPlugin), assets);
});
