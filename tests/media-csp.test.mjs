import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { JSDOM } from 'jsdom';

const project = fileURLToPath(new URL('../', import.meta.url));

test('packaged HTML allows local media blobs without broadening other resource policies', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'zorid-media-csp-'));
  try {
    // Build the actual HTML/CSP template with only its renderer entry redirected
    // to a tiny local module. No Rust compilation or vendor asset copies run.
    const template = await readFile(path.join(project, 'index.html'), 'utf8');
    assert.match(template, /<script\b(?=[^>]*\btype="module")(?=[^>]*\bsrc="\/src\/main\.ts")[^>]*>/);
    await writeFile(path.join(temporary, 'index.html'), template.replace('/src/main.ts', './entry.js'));
    await writeFile(path.join(temporary, 'entry.js'), 'document.documentElement.dataset.policyTest = "ready";');
    await build({
      configFile: false, root: temporary, base: './', publicDir: false, logLevel: 'silent',
      build: { target: 'es2022', outDir: 'dist', emptyOutDir: true, minify: false },
      worker: { format: 'iife' },
    });
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
      const script = dom.window.document.querySelector('script[src]');
      assert.equal(script?.getAttribute('type'), 'module');
      const source = script?.getAttribute('src');
      assert.match(source ?? '', /^\.\/assets\/[^/]+\.js$/);
      const entryUrl = new URL(source, 'file:///packaged/dist/index.html');
      assert.equal(entryUrl.protocol, 'file:');
      assert.equal(entryUrl.pathname.startsWith('/packaged/dist/assets/'), true);
      assert.match(await readFile(path.join(temporary, 'dist', source), 'utf8'), /policyTest/);
    } finally { dom.window.close(); }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
