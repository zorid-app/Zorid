const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {CoreWasmAssetsPlugin,createCoreWasmAssets,requiredExports,requiredMethods} = require('../scripts/core-wasm-assets-plugin.cjs');
const fixtureJs = Buffer.from('export function checkIdempotency() {}\nexport function planMutation() {}\nexport function validateSnapshot() {}\nasync function init() {}\nexport { init as default };\n');
const normalJs = Buffer.from(requiredExports.map(name=>name==='default'?'export default async function init() {}':requiredMethods[name]?`export class ${name} { ${requiredMethods[name].map(method=>`${method}() {}`).join('\n')} }`:`export function ${name}() {}`).join('\n'));
const wasm = Buffer.from([0,97,115,109,1,0,0,0]);
const buildId = '0123456789abcdef';
async function fixture(callback, js = fixtureJs) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'zorid-core-assets-'));
  try {
    await fs.writeFile(path.join(directory,'zorid_wasm.js'),js);
    await fs.writeFile(path.join(directory,'zorid_wasm_bg.wasm'),wasm);
    await callback(directory);
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
}
test('disabled core assets require no directory, environment, parser or compiler hooks',async()=>{
  assert.equal((await createCoreWasmAssets({enabled:false,directory:'/does-not-exist'})).size,0);
  new CoreWasmAssetsPlugin({enabled:false,directory:'/does-not-exist'}).apply({});
});
test('enabled assets reject absent files, invalid binary and names present only in comments',async()=>{
  await assert.rejects(createCoreWasmAssets({enabled:true,fixture:true,buildId}),/explicit generated artifact directory/);
  await fixture(async directory=>{
    await fs.rm(path.join(directory,'zorid_wasm.js'));
    await assert.rejects(createCoreWasmAssets({enabled:true,fixture:true,directory,buildId}),/cannot read generated zorid_wasm.js/);
    await fs.writeFile(path.join(directory,'zorid_wasm.js'),'// export function checkIdempotency() {}\nexport default "planMutation validateSnapshot";');
    await assert.rejects(createCoreWasmAssets({enabled:true,fixture:true,directory,buildId}),/missing export checkIdempotency/);
    await fs.writeFile(path.join(directory,'zorid_wasm.js'),fixtureJs);
    await fs.writeFile(path.join(directory,'zorid_wasm_bg.wasm'),'not wasm');
    await assert.rejects(createCoreWasmAssets({enabled:true,fixture:true,directory,buildId}),/not a version1 WASM module/);
  });
});
test('fixture exports preserve flat URLs, exact bytes, hashes and required source identity',async()=>{
  await fixture(async directory=>{
    await assert.rejects(createCoreWasmAssets({enabled:true,fixture:true,directory}),/source commit buildId/);
    const assets=await createCoreWasmAssets({enabled:true,fixture:true,directory,buildId});
    assert.deepEqual(assets.get('lib/core/zorid_wasm.js'),fixtureJs);
    assert.deepEqual(assets.get('lib/core/zorid_wasm_bg.wasm'),wasm);
    const manifest=JSON.parse(assets.get('lib/core/manifest.json'));
    assert.equal(manifest.buildId,buildId);
    assert.equal(manifest.files['zorid_wasm.js'].sha256,createHash('sha256').update(fixtureJs).digest('hex'));
  });
});
test('normal assets require complete family, recovery, sync exports and returned class methods',async()=>{
  await fixture(async directory=>{
    await assert.rejects(createCoreWasmAssets({enabled:true,directory}),/missing export createEmptyFileState/);
    await fs.writeFile(path.join(directory,'zorid_wasm.js'),normalJs.toString().replace('openSyncUpdate() {}','/* openSyncUpdate() {} */'));
    await assert.rejects(createCoreWasmAssets({enabled:true,directory}),/missing method WasmVaultKey.openSyncUpdate/);
  });
});
test('normal JS and WASM share a content version; changing either changes both URLs',async()=>{
  await fixture(async directory=>{
    const first=await createCoreWasmAssets({enabled:true,directory});
    assert.match(first.modulePath,/^lib\/core\/[a-f0-9]{64}\/zorid_wasm.js$/);
    const prefix=path.posix.dirname(first.modulePath),manifest=JSON.parse(first.get(`${prefix}/manifest.json`));
    assert.deepEqual(first.get(first.modulePath),normalJs);
    assert.deepEqual(first.get(`${prefix}/zorid_wasm_bg.wasm`),wasm);
    assert.deepEqual(manifest.requiredExports,requiredExports);
    assert.deepEqual(manifest.requiredMethods,requiredMethods);
    assert.equal(new URL(first.modulePath,'https://example.test/app/').href,`https://example.test/app/${first.modulePath}`);
    await fs.appendFile(path.join(directory,'zorid_wasm.js'),'\n// changed JS');
    const second=await createCoreWasmAssets({enabled:true,directory});assert.notEqual(second.modulePath,first.modulePath);
    await fs.appendFile(path.join(directory,'zorid_wasm_bg.wasm'),Buffer.from([0,1,0]));
    const third=await createCoreWasmAssets({enabled:true,directory});assert.notEqual(third.modulePath,second.modulePath);
  },normalJs);
});
test('webpack compiles the prepared module URL and emits its exact matching asset pair',async()=>{
  await fixture(async directory=>{
    const webpack=require('webpack'),plugin=new CoreWasmAssetsPlugin({enabled:true,directory});
    const entry=path.join(directory,'entry.js');await fs.writeFile(entry,'globalThis.coreModule = __ZORID_CORE_MODULE_PATH__;');
    const compiler=webpack({mode:'development',context:directory,entry,devtool:false,
      output:{path:path.join(directory,'dist'),filename:'main.js'},
      plugins:[plugin,new webpack.DefinePlugin({__ZORID_CORE_MODULE_PATH__:webpack.DefinePlugin.runtimeValue(()=>JSON.stringify(plugin.modulePath),true)})]});
    try {
      const stats=await new Promise((resolve,reject)=>compiler.run((error,stats)=>error?reject(error):resolve(stats)));
      assert.equal(stats.hasErrors(),false,stats.toString({all:false,errors:true}));
      assert.ok((await fs.readFile(path.join(directory,'dist/main.js'),'utf8')).includes(JSON.stringify(plugin.modulePath)));
      assert.deepEqual(await fs.readFile(path.join(directory,'dist',plugin.modulePath)),normalJs);
      assert.deepEqual(await fs.readFile(path.join(directory,'dist',path.posix.dirname(plugin.modulePath),'zorid_wasm_bg.wasm')),wasm);
    } finally {await new Promise((resolve,reject)=>compiler.close(error=>error?reject(error):resolve()));}
  },normalJs);
});
test('normal config generates web assets automatically; explicit desktop target omits toolchain',()=>{
  const config=require('../webpack.config.cjs');
  const web=config({}).plugins.find(plugin=>plugin instanceof CoreWasmAssetsPlugin);
  const desktop=config({target:'desktop'}).plugins.find(plugin=>plugin instanceof CoreWasmAssetsPlugin);
  assert.equal(web.options.enabled,true);assert.equal(web.options.build,true);
  assert.equal(desktop.options.enabled,false);desktop.apply({});
});
test('required exports cover every declared browser storage and transport binding',async()=>{
  const ts=require('typescript');
  for(const [file,names] of [
    ['src/core/browser-vault.ts',['BrowserVaultWasm']],
    ['src/core/browser-sync.ts',['BrowserSyncWasm']],
    ['src/platform/browser-sync-worker.ts',['BrowserSyncCodec']],
  ]) {
    const source=ts.createSourceFile(file,await fs.readFile(path.join(__dirname,'..',file),'utf8'),ts.ScriptTarget.Latest,true);
    for(const name of names) {
      const declaration=source.statements.find(node=>ts.isInterfaceDeclaration(node)&&node.name.text===name);
      assert.ok(declaration,`${file}: ${name}`);
      for(const member of declaration.members)assert.ok(requiredExports.includes(member.name.text),`missing asset contract ${name}.${member.name.text}`);
    }
  }
});
