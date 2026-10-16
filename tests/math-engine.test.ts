import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { JSDOM, ResourceLoader, VirtualConsole } from 'jsdom';
import { renderMath } from '../src/ui/math-renderer.ts';

const require = createRequire(import.meta.url);
test('pinned upstream engine and emitted local assets render TeX, mhchem, extensions and safe output without remote fetches',
  { timeout: 20000 }, async t => {
    for (const name of ['mathjax', '@mathjax/mathjax-tex-font', '@mathjax/mathjax-mhchem-font-extension']) assert.equal(require(`${name}/package.json`).version, '4.1.3');
    const { MathAssetsPlugin } = require('../scripts/math-assets.cjs');
    const assets = new Map<string, Buffer>();
    let collect!: () => Promise<void>;
    const compilation = { hooks: { processAssets: { tapPromise(_options: unknown, callback: () => Promise<void>) { collect = callback; } } },
      emitAsset(name: string, source: { source(): Buffer }) { assets.set(name, source.source()); } };
    new MathAssetsPlugin().apply({ hooks: { thisCompilation: { tap(_name: string, callback: (value: unknown) => void) { callback(compilation); } } },
      webpack: { Compilation: { PROCESS_ASSETS_STAGE_SUMMARIZE: 1 }, sources: { RawSource: class {
        value: Buffer; constructor(value: Buffer) { this.value = value; } source() { return this.value; }
      } } } });
    await collect();
    assert.ok(assets.has('lib/mathjax/tex-chtml-nofont.js'));
    assert.ok(assets.has('lib/mathjax/input/tex/extensions/mhchem.js'));
    assert.ok(assets.has('lib/mathjax/fonts/mathjax-tex-font/chtml.js'));
    assert.ok(assets.has('lib/mathjax/fonts/mathjax-mhchem-font-extension/chtml.js'));
    assert.ok(assets.has('lib/mathjax/LICENSE'));
    for (const prefix of ['fonts/mathjax-tex-font/', 'fonts/mathjax-mhchem-font-extension/']) {
      const metadata = JSON.parse(assets.get(`lib/mathjax/${prefix}package.json`)!.toString());
      assert.equal(metadata.license, 'Apache-2.0'); assert.equal(metadata.version, '4.1.3');
    }
    assert.ok([...assets.keys()].every(name => !name.endsWith('.map') && !name.includes('/svg/')));
    const requested: string[] = [], failures: string[] = [];
    class LocalResources extends ResourceLoader {
      fetch(url: string) {
        requested.push(url);
        const parsed = new URL(url), key = parsed.pathname.replace(/^\/sub\//, '');
        const data = parsed.origin === 'https://math.local' ? assets.get(key) : undefined;
        if (!data) { failures.push(url); return null; }
        const promise = Promise.resolve(data) as ReturnType<ResourceLoader['fetch']> & { abort(): void }; promise!.abort = () => {}; return promise;
      }
    }
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', error => { failures.push(String(error)); });
    const dom = new JSDOM('<!doctype html><head></head><body></body>', { url: 'https://math.local/sub/index.html',
      runScripts: 'dangerously', resources: new LocalResources(), pretendToBeVisual: true, virtualConsole });
    t.after(() => dom.window.close());
    const document = dom.window.document;
    const bounded = async <T>(promise: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(JSON.stringify({ failures, requested }))), 5000); })]); }
      finally { clearTimeout(timer); }
    };
    for (const [source, display] of [
      ['\\frac{1}{2}+x^2', false], ['\\ce{SO4^2- + Ba^2+ -> BaSO4 v}', true],
      ['\\cancel{x}+\\boldsymbol{y}+\\bbox[red]{z}', false], ['\\RequirePackage{color}\\color{blue}{x}', false],
    ] as const) {
      const parent = document.createElement('span'); document.body.append(parent);
      assert.equal(await bounded(renderMath(parent, source, { display }).ready), true, source);
      assert.ok(parent.querySelector('mjx-container'), source);
      assert.equal(parent.querySelector('mjx-merror'), null, source);
    }
    const unsafe = document.createElement('span'); document.body.append(unsafe);
    await bounded(renderMath(unsafe, '\\href{javascript:alert(1)}{x}').ready);
    assert.equal(unsafe.querySelector('[href^="javascript:"]'), null);
    assert.deepEqual(failures, []);
    assert.ok(requested.length > 2); assert.ok(requested.every(url => url.startsWith('https://math.local/sub/lib/mathjax/')));
    const style = [...document.querySelectorAll('style')].map(node => node.textContent + '\n' + [...(node.sheet?.cssRules ?? [])].map(rule => rule.cssText).join('\n')).join('\n');
    assert.ok(style.includes('/fonts/mathjax-tex-font/chtml/woff2/'));
    for (const match of style.matchAll(/url\(["']?([^\)"']+)/g)) {
      const url = new URL(match[1], document.baseURI);
      assert.equal(url.origin, 'https://math.local');
      assert.ok(assets.has(url.pathname.replace(/^\/sub\//, '')), url.href);
    }
    assert.equal(style.includes('cdn.jsdelivr.net'), false);
  });
