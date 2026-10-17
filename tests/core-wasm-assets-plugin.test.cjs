const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {CoreWasmAssetsPlugin,createCoreWasmAssets} = require('../scripts/core-wasm-assets-plugin.cjs');
const js = Buffer.from('export function checkIdempotency() {}\nexport function planMutation() {}\nexport function validateSnapshot() {}\nasync function init() {}\nexport { init as default };\n');
const wasm = Buffer.from([0,97,115,109,1,0,0,0]);
const buildId = '0123456789abcdef';

test('disabled core assets require no directory, environment, parser or compiler hooks', async () => {
  assert.equal((await createCoreWasmAssets({enabled:false,directory:'/does-not-exist'})).size,0);
  new CoreWasmAssetsPlugin({enabled:false,directory:'/does-not-exist'}).apply({});
});
test('enabled core assets fail clearly for missing files and names present only in comments', async () => {
  await assert.rejects(createCoreWasmAssets({enabled:true,buildId}),/explicit generated artifact directory/);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'zorid-core-assets-'));
  try {
    await assert.rejects(createCoreWasmAssets({enabled:true,directory,buildId}),/cannot read generated zorid_wasm.js/);
    await fs.writeFile(path.join(directory,'zorid_wasm.js'),'// export function checkIdempotency() {}\nexport default "planMutation validateSnapshot";');
    await fs.writeFile(path.join(directory,'zorid_wasm_bg.wasm'),wasm);
    await assert.rejects(createCoreWasmAssets({enabled:true,directory,buildId}),/missing export checkIdempotency/);
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
});
test('valid fixture exports emit exact bytes, hashes, source identity and webpack assets', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'zorid-core-assets-'));
  try {
    await fs.writeFile(path.join(directory,'zorid_wasm.js'),js);
    await fs.writeFile(path.join(directory,'zorid_wasm_bg.wasm'),wasm);
    const options = {enabled:true,directory,buildId};
    const assets = await createCoreWasmAssets(options);
    assert.deepEqual(assets.get('lib/core/zorid_wasm.js'),js);
    assert.deepEqual(assets.get('lib/core/zorid_wasm_bg.wasm'),wasm);
    const manifest = JSON.parse(assets.get('lib/core/manifest.json'));
    assert.equal(manifest.buildId,buildId);
    assert.equal(manifest.files['zorid_wasm.js'].sha256,createHash('sha256').update(js).digest('hex'));
    let compile, emit; const emitted = new Map();
    const compiler = {hooks:{thisCompilation:{tap(_name,callback){compile=callback;}}},webpack:{Compilation:{PROCESS_ASSETS_STAGE_SUMMARIZE:100},sources:{RawSource:class {constructor(bytes){this.bytes=bytes;}}}}};
    new CoreWasmAssetsPlugin(options).apply(compiler);
    compile({hooks:{processAssets:{tapPromise(_options,callback){emit=callback;}}},emitAsset(name,source){emitted.set(name,source.bytes);}});
    await emit(); assert.deepEqual(emitted,assets);
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
});
