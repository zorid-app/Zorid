const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { createPrismAssets } = require('../scripts/prism-assets.cjs');

let prepared;
async function assets() { return prepared ??= createPrismAssets(); }
async function upstreamEngine() {
  const files = await assets(), context = vm.createContext({ Prism: { manual: true, disableWorkerMessageHandler: true } });
  context.window = context; context.self = context;
  vm.runInContext(files.get('lib/prism/prism.js').toString(), context, { timeout: 3000 });
  return { files, context, Prism: context.Prism };
}

test('official Prism bundle stages all 297 components in dependency order with license and hashes', async () => {
  const { files, Prism } = await upstreamEngine(), manifest = JSON.parse(files.get('lib/prism/manifest.json'));
  assert.equal(manifest.version, '1.30.0'); assert.equal(manifest.languages.length, 297); assert.equal(new Set(manifest.languages).size, 297); assert.equal(manifest.sources.length, 298);
  assert.match(files.get('lib/prism/LICENSE').toString(), /MIT LICENSE/); assert.match(manifest.bundleSha256, /^[a-f0-9]{64}$/);
  const components = require('prismjs/components.json');
  for (const [name, config] of Object.entries(components.languages)) {
    if (name === 'meta' || typeof config !== 'object') continue;
    for (const required of [].concat(config.require || [])) assert.ok(manifest.languages.indexOf(required) < manifest.languages.indexOf(name), `${required} precedes ${name}`);
    for (const alias of [].concat(config.alias || [])) assert.equal(typeof Prism.languages[alias], 'object', alias);
  }
  for (const name of ['js', 'ts', 'py', 'html', 'sh', 'yml', 'cpp', 'rust', 'sql', 'json']) assert.equal(typeof Prism.languages[name], 'object', name);
});

test('worker uses real upstream grammars, returns source ranges, preserves unknown text and does not emit HTML', async () => {
  const files = await assets(), messages = [], context = vm.createContext({}); context.window = context; context.self = context;
  context.postMessage = message => messages.push(JSON.parse(JSON.stringify(message)));
  context.importScripts = url => { assert.equal(url, 'https://zorid.test/lib/prism/prism.js'); vm.runInContext(files.get('lib/prism/prism.js').toString(), context, { timeout: 3000 }); };
  const worker = stripTypeScriptTypes(await fs.readFile(path.join(__dirname, '../src/editor/prism-worker.ts'), 'utf8')).replace(/export\s*\{\s*\};?\s*$/, '');
  vm.runInContext(worker, context);
  const fixtures = [
    ['js', 'const value = /a+/g;', 'keyword'], ['ts', 'interface User { name: string }', 'keyword'], ['py', 'def add(x):\n    return x + 1', 'keyword'],
    ['html', '<script>let x = 1;</script>', 'tag'], ['json', '{"safe": true, "n": 2}', 'property'], ['sql', 'SELECT * FROM notes WHERE id = 1;', 'keyword'],
    ['rust', 'fn main() { println!("hello"); }', 'keyword'], ['cpp', 'int main() { return 0; }', 'keyword'], ['yml', 'enabled: true', 'key'],
  ];
  for (const [language, source, expected] of fixtures) {
    context.onmessage({ data: { id: messages.length + 1, source, language, engineURL: 'https://zorid.test/lib/prism/prism.js' } });
    const result = messages.at(-1); assert.equal(result.error, undefined, language); assert.ok(result.tokens.some(token => token.classes.includes(expected)), language);
    for (const token of result.tokens) { assert.ok(token.from >= 0 && token.to <= source.length && token.from < token.to); assert.equal(typeof source.slice(token.from, token.to), 'string'); assert.equal('html' in token, false); }
  }
  for (const language of ['unknown-language', '__proto__', 'constructor', 'extend']) {
    context.onmessage({ data: { id: messages.length + 1, source: '<script>alert(1)</script>', language, engineURL: 'https://zorid.test/lib/prism/prism.js' } });
    assert.deepEqual(messages.at(-1).tokens, [], language);
  }
});
