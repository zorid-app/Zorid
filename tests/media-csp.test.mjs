import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const project = fileURLToPath(new URL('../', import.meta.url));

test('packaged HTML allows local media blobs without broadening other resource policies', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'zorid-media-csp-'));
  let compiler;
  try {
    const config = require('../webpack.config.cjs')({});
    // Exercise the real packaging template/plugin with a tiny entry. No renderer
    // compilation or PDF/math asset copying is needed to verify the shipped CSP.
    const plugins = config.plugins.filter(plugin => plugin instanceof HtmlWebpackPlugin);
    assert.equal(plugins.length, 1);
    const entry = path.join(temporary, 'entry.js');
    await writeFile(entry, 'document.documentElement.dataset.policyTest = "ready";');
    compiler = webpack({
      mode: 'production', context: project, entry, plugins,
      output: { path: path.join(temporary, 'dist'), filename: 'main.js' },
      optimization: { minimize: false },
    });
    const stats = await new Promise((resolve, reject) => {
      compiler.run((error, result) => error ? reject(error) : resolve(result));
    });
    assert.equal(stats.hasErrors(), false, stats.toString({ all: false, errors: true }));
    const html = await readFile(path.join(temporary, 'dist/index.html'), 'utf8');
    const dom = new JSDOM(html);
    try {
      const policies = dom.window.document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]');
      assert.equal(policies.length, 1);
      const entries = policies[0].content.split(';').map(value => value.trim().split(/\s+/)).filter(([name]) => name);
      const directives = Object.fromEntries(entries.map(([name, ...sources]) => [name, sources]));
      assert.equal(Object.keys(directives).length, entries.length, 'no duplicate directives');
      // AttachmentResources creates object URLs; neither arbitrary network media
      // nor data URLs are needed. Keep executable/network policies unchanged.
      assert.deepEqual(directives, {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:', 'https:', 'http:'],
        'media-src': ['blob:'],
        'font-src': ["'self'", 'data:'],
        'connect-src': ["'self'", 'ws://127.0.0.1:*'],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
      });
      assert.equal(dom.window.document.querySelector('script[src]')?.getAttribute('src'), 'main.js');
    } finally { dom.window.close(); }
  } finally {
    if (compiler) await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
    await rm(temporary, { recursive: true, force: true });
  }
});
