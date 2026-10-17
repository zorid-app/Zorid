const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');

const fixtureExports = ['default','checkIdempotency','planMutation','validateSnapshot'];
const requiredExports = [...fixtureExports,
  'createEmptyFileState','inspectFileState','createEmptyTextState','materializeTextState',
  'materializeFile','materializeRetainedFile','verifyRetainedFileContent','classifyFileMaterializations',
  'recoveryFileContent','validateFamilyCommand','checkFamilyCommandReplay','familyMutationRequirements',
  'planFamilyMutation','rebindTextState','planTextReplace','planFileMutation','encodeFilePayload',
  'validateAuthoredSyncPayload','validateSyncWire','encodeSyncCursor','decodeSyncHello',
  'decodeSyncAccepted','decodeSyncPage','syncEnvelopeUpdateId',
  'WasmVaultKey','WasmFamilyMutationPlan','WasmAuthoredTextPlan','WasmAuthoredFilePlan',
  'WasmReceivedTextPlan','WasmReceivedFilePlan','WasmSyncUpdate'];
const planMethods = ['resultJson','checkPreconditions','free'];
const requiredMethods = {
  WasmVaultKey:['constructor','openSyncUpdate','seal','free'],
  WasmFamilyMutationPlan:[...planMethods,'metadataJson'],
  WasmAuthoredTextPlan:[...planMethods,'metadataJson'],
  WasmAuthoredFilePlan:[...planMethods,'metadataJson'],
  WasmReceivedTextPlan:planMethods, WasmReceivedFilePlan:planMethods,
  WasmSyncUpdate:['metadataJson','exactWire','matchesPayload','planText','planFile','free'],
};
function moduleBindings(source) {
  const parser = require(require.resolve('acorn',{paths:[path.dirname(require.resolve('webpack/package.json'))]}));
  const ast = parser.parse(source,{ecmaVersion:'latest',sourceType:'module'});
  const names = new Set(), classes = new Map();
  for (const node of ast.body) {
    const declaration = node.declaration ?? node;
    if (declaration.type === 'ClassDeclaration') classes.set(declaration.id.name,new Set(declaration.body.body.filter(method=>!method.static && method.type==='MethodDefinition').map(method=>method.key.name ?? method.key.value)));
    if (node.type === 'ExportDefaultDeclaration') names.add('default');
    if (node.type !== 'ExportNamedDeclaration' || node.source) continue;
    if (node.declaration?.id?.name) names.add(node.declaration.id.name);
    if (node.declaration?.type === 'VariableDeclaration') for (const item of node.declaration.declarations) if (item.id.type === 'Identifier') names.add(item.id.name);
    for (const specifier of node.specifiers) names.add(specifier.exported.name ?? specifier.exported.value);
  }
  return {names,classes};
}
async function createCoreWasmAssets(options = {}) {
  if (!options.enabled) return new Map();
  if (typeof options.directory !== 'string' || !options.directory) throw new Error('Core WASM enabled: an explicit generated artifact directory is required');
  if (options.fixture && (typeof options.buildId !== 'string' || !/^[0-9a-f]{7,64}(?:-dirty)?$/i.test(options.buildId))) throw new Error('Core WASM fixture enabled: source commit buildId is required');
  const files = new Map();
  for (const filename of ['zorid_wasm.js','zorid_wasm_bg.wasm']) {
    try { files.set(filename,await fs.readFile(path.join(options.directory,filename))); }
    catch(error) {throw new Error(`Core WASM enabled: cannot read generated ${filename}`,{cause:error});}
  }
  let bindings;
  try {bindings=moduleBindings(files.get('zorid_wasm.js').toString('utf8'));}
  catch(error) {throw new Error('Core WASM enabled: generated JavaScript is not a valid ES module',{cause:error});}
  const exports = options.fixture ? fixtureExports : requiredExports;
  for (const name of exports) if (!bindings.names.has(name)) throw new Error(`Core WASM enabled: generated module is missing export ${name}`);
  if (!options.fixture) for (const [name,methods] of Object.entries(requiredMethods)) for (const method of methods)
    if (!bindings.classes.get(name)?.has(method)) throw new Error(`Core WASM enabled: generated module is missing method ${name}.${method}`);
  const wasm = files.get('zorid_wasm_bg.wasm');
  if (wasm.length<8 || !wasm.subarray(0,8).equals(Buffer.from([0,97,115,109,1,0,0,0]))) throw new Error('Core WASM enabled: generated binary is not a version1 WASM module');
  const digest = createHash('sha256');
  for (const [name,bytes] of files) digest.update(name).update('\0').update(String(bytes.length)).update('\0').update(bytes);
  const contentHash = digest.digest('hex');
  const prefix = options.fixture ? 'lib/core' : `lib/core/${contentHash}`;
  const manifest = {formatVersion:1,buildId:options.buildId ?? null,contentHash,modulePath:`${prefix}/zorid_wasm.js`,requiredExports:exports,
    requiredMethods:options.fixture ? {} : requiredMethods,files:Object.fromEntries([...files].map(([name,bytes])=>[name,{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]))};
  const assets = new Map([...files].map(([name,bytes])=>[`${prefix}/${name}`,bytes]));
  assets.set(`${prefix}/manifest.json`,Buffer.from(JSON.stringify(manifest,null,2)+'\n'));
  assets.modulePath = manifest.modulePath;
  return assets;
}
class CoreWasmAssetsPlugin {
  constructor(options={}) {this.options=options;this.modulePath='';this.assets=new Map();}
  apply(compiler) {
    if (!this.options.enabled) return;
    const prepare = async () => {
      const directory = this.options.build ? await require('./build-core-wasm.cjs').buildCoreWasm({root:compiler.context}) : this.options.directory;
      this.assets=await createCoreWasmAssets({...this.options,directory});
      this.modulePath=this.assets.modulePath;
    };
    compiler.hooks.beforeRun.tapPromise('CoreWasmAssetsPlugin',prepare);
    compiler.hooks.watchRun.tapPromise('CoreWasmAssetsPlugin',prepare);
    compiler.hooks.thisCompilation.tap('CoreWasmAssetsPlugin',compilation=>{
      compilation.hooks.processAssets.tapPromise({name:'CoreWasmAssetsPlugin',stage:compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE},async()=>{
        for (const [name,bytes] of this.assets) compilation.emitAsset(name,new compiler.webpack.sources.RawSource(bytes),{minimized:true});
        if (this.options.build) {
          for (const file of await require('./build-core-wasm.cjs').sourceInputs(compiler.context)) compilation.fileDependencies.add(path.join(compiler.context,file));
          compilation.contextDependencies.add(path.join(compiler.context,'crates'));
        }
      });
    });
  }
}
module.exports={CoreWasmAssetsPlugin,createCoreWasmAssets,requiredExports,requiredMethods};
