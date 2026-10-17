const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const {parse} = require('acorn');

// Exercise Vite itself without loading the application config, Rust build, or
// vendor-copy hooks. The generated runtime module stands in for wasm-bindgen JS;
// this test checks transport/import execution, not Rust/WASM semantics.
test('production Vite emits an ESM entry and executable IIFE worker with TS dependencies and runtime import', async () => {
  const {build} = await import('vite');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zorid-production-worker-'));
  try {
    await fs.writeFile(path.join(directory, 'index.html'), '<script type="module" src="./entry.ts"></script>');
    await fs.writeFile(path.join(directory, 'entry.ts'), "globalThis.worker = new Worker(new URL('./worker.ts', import.meta.url), {type: 'module'});");
    await fs.writeFile(path.join(directory, 'worker.ts'), `import {suffix} from './dep.ts';
self.onmessage = async (event: MessageEvent<string>) => {
  const moduleUrl = new URL(event.data, self.location.href);
  if (moduleUrl.origin !== new URL(self.location.href).origin) throw new Error('Cross-origin runtime');
  const wasm = await import(/* @vite-ignore */ moduleUrl.href);
  self.postMessage({dependency: suffix, initialized: await wasm.default()});
};`);
    await fs.writeFile(path.join(directory, 'dep.ts'), "export const suffix: string = 'typed dependency';");
    await build({
      configFile: false, root: directory, base: './', publicDir: false, logLevel: 'silent',
      build: {target: 'es2022', outDir: 'out', minify: false, modulePreload: false},
      worker: {format: 'iife'},
    });
    const output = path.join(directory, 'out', 'assets');
    const files = (await fs.readdir(output)).filter(name => name.endsWith('.js'));
    assert.equal(files.length, 2, 'only the renderer entry and worker are emitted; the runtime import remains external');
    const sources = await Promise.all(files.map(async name => ({name, code: await fs.readFile(path.join(output, name), 'utf8')})));
    const entry = sources.find(file => file.code.includes('new Worker'));
    const worker = sources.find(file => file !== entry);
    assert.ok(entry && worker, 'real renderer and worker chunks are present');
    parse(entry.code, {ecmaVersion: 'latest', sourceType: 'module'});
    assert.match(entry.code, /import\.meta\.url/);
    assert.ok(entry.code.includes(worker.name), 'relative entry URL points at the emitted worker');
    assert.doesNotMatch(entry.code, /webpack|\/src\/worker\.ts/);
    parse(worker.code, {ecmaVersion: 'latest', sourceType: 'script'});
    assert.match(worker.code, /import\(/, 'the runtime module is loaded dynamically');
    assert.match(worker.code, /typed dependency/, 'the actual TypeScript dependency was bundled');
    const runtime = path.join(directory, 'runtime.mjs');
    await fs.writeFile(runtime, "let calls = 0; export default async function initialize() { return `initialized:${++calls}`; }");
    const messages = [], context = vm.createContext({URL, location: {href: pathToFileURL(path.join(output, worker.name)).href}});
    context.self = context;
    context.postMessage = message => messages.push(JSON.parse(JSON.stringify(message)));
    const compiled = new vm.Script(worker.code, {filename: worker.name,
      importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER});
    compiled.runInContext(context, {timeout: 3000});
    await context.onmessage({data: pathToFileURL(runtime).href});
    await context.onmessage({data: pathToFileURL(runtime).href});
    assert.deepEqual(messages, [
      {dependency: 'typed dependency', initialized: 'initialized:1'},
      {dependency: 'typed dependency', initialized: 'initialized:2'},
    ], 'the IIFE executes bundled TS code and imports/initializes the same runtime module');
    await assert.rejects(context.onmessage({data: 'https://other.invalid/runtime.mjs'}), /Cross-origin runtime/);
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});

test('actual Prism source transforms into a classic dev worker and runs upstream tokenization', async () => {
  const {createServer} = await import('vite');
  const {createPrismAssets} = require('../scripts/prism-assets.cjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zorid-prism-dev-'));
  let server;
  try {
    server = await createServer({
      configFile: false, root: path.resolve(__dirname, '..'), base: './', publicDir: false, logLevel: 'silent',
      cacheDir: path.join(directory, 'cache'), optimizeDeps: {noDiscovery: true, include: []},
      server: {middlewareMode: true, hmr: false, watch: null}, worker: {format: 'iife'},
    });
    const caller = await server.transformRequest('/src/editor/code-highlight.ts');
    assert.ok(caller);
    assert.match(caller.code, /worker_file&type=classic/, 'the real constructor retains classic worker type');
    const transformed = await server.transformRequest('/src/editor/prism-worker.ts?worker_file&type=classic');
    assert.ok(transformed);
    // No export stripping or source substitutions: this parses the actual served
    // worker response, so an accidental trailing `export {}` fails here.
    parse(transformed.code, {ecmaVersion: 'latest', sourceType: 'script'});
    const messages = [], assets = await createPrismAssets(), context = vm.createContext({});
    context.self = context; context.window = context;
    context.postMessage = message => messages.push(JSON.parse(JSON.stringify(message)));
    const imports = [];
    context.importScripts = url => {
      imports.push(url);
      if (url === '/@vite/env') return; // Vite environment bootstrap has no Prism behavior.
      assert.equal(url, 'https://zorid.test/lib/prism/prism.js');
      vm.runInContext(assets.get('lib/prism/prism.js').toString(), context, {timeout: 3000});
    };
    new vm.Script(transformed.code, {filename: 'served-prism-worker.js'}).runInContext(context, {timeout: 3000});
    context.onmessage({data: {id: 1, source: 'const n = 2;', language: 'js', engineURL: 'https://zorid.test/lib/prism/prism.js'}});
    assert.equal(messages[0].id, 1);
    assert.equal(messages[0].error, undefined);
    assert.ok(messages[0].tokens.some(token => token.classes.includes('keyword')));
    assert.equal(imports.filter(url => url === 'https://zorid.test/lib/prism/prism.js').length, 1);
  } finally {
    if (server) await server.close();
    await fs.rm(directory, {recursive: true, force: true});
  }
});
