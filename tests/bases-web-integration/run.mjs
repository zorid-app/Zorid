#!/usr/bin/env node
// The normal application entry point, not the Bases fixture page or a replacement adapter.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { CDP, delay } from '../tasks-electron-integration/cdp.mjs';
import { UI } from '../bases-electron-integration/ui.mjs';
import { observeOwnedChild, cleanupOwnedResources } from '../browser-workblocks-worker/cleanup.mjs';
import { databaseName, noteName, notePath, marker, source, phaseNames, savedNote, editorFrame, reloadFrame, searchFrame, readOnlyDatabaseSnapshot, trackedHarnessInputs, trackOwnedStartup, finalEvidence, classifyRuntimeErrors, awaitRuntimeHealth, waitForObservation, streamingStorageSchema, storageObservationSnapshot } from './oracles.mjs';

const args = process.argv.slice(2), accepted = new Set(['--root', '--expected-head', '--wasm-dir', '--chrome', '--out', '--timeout-ms']);
assert.equal(args.filter(value => value === '--runtime-authorized').length, 1, 'Explicit coordinator runtime authorization required');
const values = new Map();
for (let index = 0; index < args.length; index++) {
  const key = args[index]; if (key === '--runtime-authorized') continue;
  assert.ok(accepted.has(key) && !values.has(key) && args[index + 1] && !args[index + 1].startsWith('--'), 'Invalid or duplicate argument ' + key);
  values.set(key, args[++index]);
}
for (const key of ['--root', '--expected-head', '--wasm-dir', '--chrome', '--out']) assert.ok(values.has(key), 'Explicit ' + key + ' required');
const timeoutMs = Number(values.get('--timeout-ms') ?? 120000);
assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 300000, 'Whole-run budget must be1000..300000ms');
const root = await fs.realpath(values.get('--root')), expectedHead = values.get('--expected-head');
assert.equal(root, await fs.realpath(fileURLToPath(new URL('../..', import.meta.url))), 'Run the harness from the selected frozen checkout');
assert.match(expectedHead, /^[a-f0-9]{40}$/);
const generated = await fs.realpath(values.get('--wasm-dir'));
assert.equal(generated, await fs.realpath(path.join(root, 'target/browser-wasm/generated')), 'Normal config uses its own already-built generated module; no fixture override');
const chromeExecutable = await fs.realpath(values.get('--chrome'));
await fs.access(chromeExecutable, 1);
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
const canonicalSourceRoot = path.dirname(await fs.realpath(path.resolve(root, git('rev-parse', '--git-common-dir'))));
const requestedOut = path.resolve(values.get('--out'));
const out = path.join(await fs.realpath(path.dirname(requestedOut)), path.basename(requestedOut));
for (const protectedRoot of [root, canonicalSourceRoot, generated, path.dirname(chromeExecutable)]) assert.ok(out !== protectedRoot && !out.startsWith(protectedRoot + path.sep), 'Evidence must be outside source/artifact roots');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fileHash(file) { const hash = createHash('sha256'); for await (const bytes of createReadStream(file)) hash.update(bytes); return hash.digest('hex'); }
const require = createRequire(path.join(root, 'package.json'));
const { sourceInputs } = require(path.join(root, 'scripts/build-core-wasm.cjs'));
async function provenance() {
  assert.equal(git('rev-parse', 'HEAD'), expectedHead, 'Frozen HEAD'); assert.equal(git('diff', '--name-only', 'HEAD'), '', 'Frozen tracked source');
  assert.equal(git('ls-files', '--others', '--exclude-standard', '--', 'crates'), '', 'No untracked Rust build inputs');
  assert.equal(git('ls-files', '--others', '--exclude-standard', '--', 'src', 'desktop', 'scripts', 'tests/bases-web-integration'), '', 'No untracked executable source in this runtime closure');
  const inputs = await sourceInputs(root), fingerprint = createHash('sha256').update('wasm-bindgen 0.2.129\0');
  for (const name of inputs) fingerprint.update(name).update('\0').update(await fs.readFile(path.join(root, name))).update('\0');
  const metadata = JSON.parse(await fs.readFile(path.join(generated, 'build.json'), 'utf8'));
  assert.equal(metadata.bindgenVersion, '0.2.129'); assert.equal(metadata.fingerprint, fingerprint.digest('hex'), 'STALE_WASM: rebuild explicitly before this harness; it never requests a compilation');
  const files = {};
  const contentHash = createHash('sha256');
  for (const name of ['zorid_wasm.js', 'zorid_wasm_bg.wasm']) {
    const bytes = await fs.readFile(path.join(generated, name)); files[name] = sha(bytes); assert.equal(files[name], metadata.files[name]);
    contentHash.update(name).update('\0').update(String(bytes.length)).update('\0').update(bytes);
  }
  const tracked = git('ls-files', '-z', 'src', 'desktop', 'scripts', 'tests/bases-web-integration', 'tests/tasks-electron-integration/cdp.mjs', 'tests/bases-electron-integration/ui.mjs', 'tests/browser-workblocks-worker/cleanup.mjs', 'index.html', 'vite.config.mjs', 'package.json', 'pnpm-lock.yaml').split('\0').filter(Boolean).sort();
  trackedHarnessInputs(tracked);
  return { head: expectedHead, cratesTree: git('rev-parse', 'HEAD:crates'), rustInputs: await Promise.all(inputs.map(async name => [name, await fileHash(path.join(root, name))])), tracked: await Promise.all(tracked.map(async name => [name, await fileHash(path.join(root, name))])), wasm: { fingerprint: metadata.fingerprint, files, modulePrefix: 'lib/core/' + contentHash.digest('hex') }, chrome: { file: chromeExecutable, sha256: await fileHash(chromeExecutable) } };
}
// Check the warm cache before normal Vite config can call its normal cache loader.
const before = await provenance();
await fs.mkdir(out); // Fresh evidence only. Never overwrite an earlier run.
const profile = path.join(out, 'chrome-profile'); await fs.mkdir(profile);
const started = Date.now(), deadline = started + timeoutMs;
const evidence = { kind: 'actual-normal-web-workspace-smoke', status: 'running', started: new Date(started).toISOString(), timeoutMs, provenance: before, phases: phaseNames.map(name => ({ name, status: 'unexecuted' })), actions: [], observations: [], requests: [], workerTargets: [], errorEvents: [], errorObservedAt: [], networkReceipts: [], exceptions: [], ambientNetworkErrors: [], pendingNetworkErrors: [], startupDiagnostics: [], storageObservations: [], storageReadbacks: [], storageReadCount: 0, limitations: ['Five normal note UI phases only; not full Bases, desktop/mobile, sync, performance or visual parity.', 'CDP pointer/keyboard input and read-only IndexedDB inspection; not physical keyboard or OS focus parity.', 'The normal Vite development entry is exercised, not a production bundle.', 'Saved-byte checks inspect the normal streaming-v8 inline text projection, not encrypted retained graph integrity or chunked/binary content.'] };
let server, chrome, childReceipt, cdp, ui, cleanupCall, failure, timedOut = false;
let stderr = '', eventOverflow = 0;
const startupTasks = [];
const networkById = new Map(), networkWaiters = new Set();
const storageObservationHashes = new Set(), storageReadbackHashes = new Set();
function live() { if (timedOut || Date.now() >= deadline) { timedOut = true; throw Error('Whole normal-web smoke deadline'); } }
async function bounded(action, resource) {
  live(); let timer;
  const work = Promise.resolve().then(action);
  const owned = resource ? trackOwnedStartup(work, resource.name, resource.closeLate) : undefined;
  if (owned) startupTasks.push(owned);
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => { if (owned) owned.state.expired = true; timedOut = true; reject(Error('Whole normal-web smoke deadline')); }, Math.max(1, deadline - Date.now())); })]); }
  finally { clearTimeout(timer); }
}
async function until(check, label) {
  return waitForObservation(() => bounded(check), { now: Date.now, deadline, assertHealthy: healthy, pause: delay, label });
}
function runtimeErrors(final = false) {
  const state = classifyRuntimeErrors(evidence.errorEvents, evidence.networkReceipts, evidence.origin, { observedAt: evidence.errorObservedAt, now: Date.now(), final });
  Object.assign(evidence, state); evidence.eventOverflow = eventOverflow; return { ...state, eventOverflow };
}
async function healthy() {
  return awaitRuntimeHealth(() => { live(); return runtimeErrors(); }, expiresAt => new Promise(resolve => {
    const finish = () => { clearTimeout(timer); networkWaiters.delete(finish); resolve(); };
    const timer = setTimeout(finish, Math.max(1, Math.min(expiresAt, deadline) - Date.now())); networkWaiters.add(finish);
  }));
}
function networkEvent(message) {
  const value = message.params, id = value?.requestId;
  if (typeof id !== 'string' || id.length > 128) { eventOverflow++; return; }
  let record = networkById.get(id);
  if (!record) {
    if (evidence.networkReceipts.length >= 2000) { eventOverflow++; return; }
    record = { requestId: id, requestCount: 0, responseCount: 0 }; networkById.set(id, record); evidence.networkReceipts.push(record);
  }
  const request = message.method === 'Network.requestWillBeSent', data = request ? value.request : value.response;
  if (typeof data?.url !== 'string' || data.url.length > 4096) { eventOverflow++; return; }
  if (request) { record.requestCount++; record.request = { method: data.method, url: data.url, type: value.type, initiatorType: value.initiator?.type, initiatorHasStack: !!value.initiator?.stack, redirected: !!value.redirectResponse }; }
  else { record.responseCount++; record.response = { url: data.url, status: data.status, type: value.type }; }
  for (const finish of [...networkWaiters]) finish();
}
async function diagnostic(label, afterFailure = false) {
  const expression = `(()=>{const control=document.querySelector('.workspace .sidebar-toolbar button[aria-label="New note"]'),active=document.activeElement;return {url:location.href,title:document.title,readyState:document.readyState,visibility:document.visibilityState,workspace:!!document.querySelector('.workspace'),desktopBridge:!!window.zorid,fixtureMarker:!!document.querySelector('meta[name="zorid-core-fixture-build"]'),newNote:control?{connected:control.isConnected,visible:!!control.getClientRects().length,disabled:control.matches(':disabled')}:null,active:active?{tag:active.tagName,label:active.getAttribute('aria-label')}:null,body:document.body?.innerText.slice(0,12000)??''};})()`;
  const reply = await (afterFailure ? cleanupCall('Runtime.evaluate', { expression, returnByValue: true }) : cdp.call('Runtime.evaluate', { expression, returnByValue: true }));
  if (reply.exceptionDetails) throw Error('Public diagnostic evaluation failed');
  assert.ok(evidence.startupDiagnostics.length < 4); evidence.startupDiagnostics.push({ label, at: Date.now(), ...reply.result.value });
}
async function dom(body) { return bounded(() => cdp.evaluate(`(()=>{${body}})()`)); }
async function screenshot(name) { const image = await bounded(() => cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })); await fs.writeFile(path.join(out, name + '.png'), Buffer.from(image.data, 'base64')); }
async function storage() {
  assert.ok(evidence.storageReadCount++ < 2000, 'Bounded read-only storage observations');
  const probe = await bounded(() => cdp.evaluate(`(${readOnlyDatabaseSnapshot.toString()})(${JSON.stringify(databaseName)},${JSON.stringify(streamingStorageSchema)})`));
  // Keep actual inventory/schema evidence even when the strict decoder rejects
  // it. Repeated readiness reads do not duplicate the same full schema payload.
  const observed = { kind: probe?.kind, code: probe?.code, message: probe?.message, inventory: probe?.inventory, schema: probe?.schema }, observedHash = sha(JSON.stringify(observed));
  if (!storageObservationHashes.has(observedHash)) { assert.ok(storageObservationHashes.size < 32, 'Bounded schema variants'); storageObservationHashes.add(observedHash); evidence.storageObservations.push({ at: Date.now(), sha256: observedHash, ...observed }); }
  if (probe?.snapshot) {
    const digest = sha(JSON.stringify(probe.snapshot));
    if (!storageReadbackHashes.has(digest)) { assert.ok(storageReadbackHashes.size < 64, 'Bounded durable readback variants'); storageReadbackHashes.add(digest); evidence.storageReadbacks.push({ at: Date.now(), sha256: digest, snapshot: probe.snapshot }); }
  }
  return storageObservationSnapshot(probe);
}
async function frame(label) {
  // This is JavaScript source for a second parser. Preserve its string escapes,
  // including the line separator used to read the actual CodeMirror DOM.
  const value = await dom(String.raw`const editors=[...document.querySelectorAll('.pane.is-active .cm-content[contenteditable="true"]')].filter(e=>e.getClientRects().length),e=editors[0];return {workspace:!!document.querySelector('.workspace'),desktopBridge:!!window.zorid,fixtureMarker:!!document.querySelector('meta[name="zorid-core-fixture-build"]'),title:document.querySelector('.pane.is-active .note-title')?.value,editors:editors.length,connected:!!e?.isConnected,editable:e?.getAttribute('contenteditable')==='true',focusedEditor:document.activeElement===e,text:e?[...e.querySelectorAll('.cm-line')].map(line=>line.textContent).join('\n'):null,saveState:document.querySelector('.save-state')?.textContent??null,timeOrigin:performance.timeOrigin};`);
  assert.ok(evidence.observations.length < 2000, 'Bounded passive frame receipts'); evidence.observations.push({ label, ...value }); return value;
}
async function phase(index, run) { const item = evidence.phases[index]; item.status = 'running'; item.started = new Date().toISOString(); try { await run(); item.status = 'passed'; } catch (error) { item.status = 'failed'; item.error = error.message; throw error; } finally { item.finished = new Date().toISOString(); } }
try {
  // These variables affect only this dedicated harness process, never the user's shell.
  for (const key of ['ZORID_CORE_FIXTURES', 'ZORID_CORE_BUILD_ID', 'ZORID_CORE_WASM_DIR']) delete process.env[key];
  // A cache race must fail, never launch an implicit compiler from normal config.
  process.env.CARGO = '/usr/bin/false'; process.env.WASM_BINDGEN = '/usr/bin/false';
  const vite = await bounded(() => import('vite'));
  server = await bounded(() => vite.createServer({ root, configFile: path.join(root, 'vite.config.mjs'), envFile: false, mode: 'development', clearScreen: false, logLevel: 'error', cacheDir: path.join(profile, 'vite-cache'), server: { host: '127.0.0.1', port: 0, strictPort: true, fs: { allow: [root, canonicalSourceRoot] } }, plugins: [{ name: 'normal-web-smoke-passive-request-receipts', enforce: 'pre', configureServer(viteServer) { viteServer.middlewares.use((request, response, next) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/src/main.ts' || pathname === '/favicon.ico' || pathname.includes('/src/platform/browser-core-worker.ts') || pathname.startsWith('/' + before.wasm.modulePrefix + '/')) {
      assert.ok(evidence.requests.length < 1000, 'Bounded normal-app request receipts');
      const record = { path: pathname, method: request.method, userAgent: request.headers['user-agent'] ?? '', at: Date.now() }; evidence.requests.push(record);
      response.once('finish', () => { record.statusCode = response.statusCode; record.finished = Date.now(); });
    } next();
  }); } }] }), { name: 'Vite createServer', closeLate: late => late.close() });
  assert.equal(server.config.define.__ZORID_CORE_FIXTURES__, 'false');
  assert.equal(JSON.parse(server.config.define.__ZORID_CORE_MODULE_PATH__), before.wasm.modulePrefix + '/zorid_wasm.js');
  await bounded(() => server.listen(), { name: 'Vite listen', closeLate: () => server.close() }); const address = server.httpServer.address();
  assert.ok(address && typeof address === 'object' && address.port > 0); const origin = `http://127.0.0.1:${address.port}`; evidence.origin = origin;
  chrome = spawn(chromeExecutable, ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  childReceipt = observeOwnedChild(chrome); let spawnError; chrome.on('error', error => { spawnError = error; }); chrome.stderr.on('data', bytes => { if (stderr.length < 128000) stderr += bytes; });
  const port = await until(async () => { if (spawnError) throw spawnError; assert.ok(!childReceipt.exit, 'Owned Chrome exited during startup'); const value = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; assert.match(value, /^[1-9][0-9]{0,4}$/); assert.ok(Number(value) <= 65535); return value; }, 'Owned Chrome debugger');
  const target = await bounded(() => fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) }).then(reply => reply.json()));
  cdp = new CDP(target.webSocketDebuggerUrl); cleanupCall = cdp.call.bind(cdp);
  // Shared input helpers must also stop after the whole-run deadline. Cleanup
  // alone retains the original bounded transport for Browser.close/screenshots.
  cdp.call = async (method, parameters) => { await healthy(); return bounded(() => cleanupCall(method, parameters)); };
  ui = new UI(cdp, evidence.actions);
  cdp.ws.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.method === 'Network.requestWillBeSent' || message.method === 'Network.responseReceived') networkEvent(message); if (message.method === 'Target.targetCreated' && message.params.targetInfo.type === 'worker') { if (evidence.workerTargets.length < 32) evidence.workerTargets.push(message.params.targetInfo); else eventOverflow++; } if (message.method === 'Runtime.exceptionThrown' || message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error' || message.method === 'Log.entryAdded' && message.params.entry.level === 'error') { if (evidence.errorEvents.length < 128) { evidence.errorEvents.push(message); evidence.errorObservedAt.push(Date.now()); } else eventOverflow++; for (const finish of [...networkWaiters]) finish(); } });
  for (const method of ['Runtime.enable', 'Page.enable', 'Network.enable', 'Log.enable']) await bounded(() => cdp.call(method));
  await bounded(() => cdp.call('Target.setDiscoverTargets', { discover: true })); evidence.browser = await bounded(() => cdp.call('Browser.getVersion'));
  await bounded(() => cdp.call('Page.navigate', { url: origin + '/' }));
  await until(async () => { assert.equal(await dom('return !!document.querySelector(".workspace .sidebar-toolbar button[aria-label=\\"New note\\"]");'), true); assert.equal(await dom('return !!window.zorid||!!document.querySelector("meta[name=\\"zorid-core-fixture-build\\"]");'), false); }, 'Normal browser Workspace');
  await diagnostic('workspace-ready');
  let created, renamed, saved, savedTime;
  await phase(0, async () => {
    await bounded(() => ui.button('New note', '[aria-label="Left sidebar"]'));
    created = await until(async () => savedNote(await storage(), 'Untitled.md', ''), 'Normal UI create persisted');
    await bounded(() => ui.type('.pane.is-active .note-title', noteName)); await bounded(() => ui.key('Enter'));
    renamed = await until(async () => { const current = savedNote(await storage(), notePath, '', created); editorFrame(await frame('title-Enter-focus'), noteName, '', true); return current; }, 'Normal rename and title transfer');
    assert.notEqual(renamed.revision, created.revision); await healthy();
  });
  await phase(1, async () => {
    // In particular: no pointer, focus(), or editor API call before this input.
    editorFrame(await frame('before-body-input'), noteName, '', true);
    await bounded(() => cdp.call('Input.insertText', { text: source })); evidence.actions.push({ action: 'keyboard-insertText-after-normal-title-transfer', text: source });
    saved = await until(async () => { editorFrame(await frame('saved-note-ready'), noteName, source); return savedNote(await storage(), notePath, source, created); }, 'Durable whole note and settled normal save state');
    assert.notEqual(saved.revision, renamed.revision); savedTime = await dom('return performance.timeOrigin;'); await screenshot('saved-note'); await healthy();
  });
  await phase(2, async () => {
    await bounded(() => cdp.call('Page.reload', { ignoreCache: true }));
    await until(async () => { const f = await frame('reload-ready'); editorFrame(f, noteName, source); const current = savedNote(await storage(), notePath, source); reloadFrame(savedTime, f.timeOrigin, saved, current); }, 'Normal reload retains document source and identity');
    await screenshot('reopened-note'); await healthy();
  });
  await phase(3, async () => {
    await bounded(() => ui.button('Search', '[aria-label="Left sidebar"]')); await bounded(() => ui.type('.document-search input[aria-label="Search vault"]', marker));
    await until(async () => { const found = await dom(`const root=document.querySelector('.document-search');return {query:root?.querySelector('input[aria-label="Search vault"]')?.value,total:root?.querySelector('.document-search-total')?.textContent,status:root?.querySelector('.document-search-status')?.textContent.trim(),groups:root?[...root.querySelectorAll('.document-search-file')].map(e=>({entryId:e.dataset.entryId,path:e.querySelector('.document-search-title')?.title,title:e.querySelector('.document-search-name')?.textContent,badge:e.querySelector('.document-search-badge')?.textContent,snippets:[...e.querySelectorAll('.document-search-excerpt')].map(n=>({text:n.textContent,marks:[...n.querySelectorAll('mark')].map(m=>m.textContent)}))})):[]};`); searchFrame(found, saved); evidence.search = found; }, 'Exact normal rich search');
    await screenshot('rich-search'); await healthy();
  });
  await phase(4, async () => {
    await bounded(() => ui.click('.document-search-title'));
    await until(async () => { editorFrame(await frame('opened-search-result'), noteName, source); assert.deepEqual(savedNote(await storage(), notePath, source), saved); }, 'Search opens the same saved note'); await healthy();
  });
  assert.equal(eventOverflow, 0, 'No passive evidence overflow');
  assert.ok(evidence.requests.some(row => row.path === '/src/main.ts' && row.statusCode === 200 && /Chrome\//.test(row.userAgent)), 'Actual normal main.ts requested');
  assert.ok(evidence.requests.some(row => row.path.includes('/src/platform/browser-core-worker.ts') && row.statusCode === 200 && /Chrome\//.test(row.userAgent)), 'Actual product core Worker requested');
  assert.ok(evidence.workerTargets.some(row => row.url.includes('/src/platform/browser-core-worker.ts')), 'Actual product Worker target observed');
  evidence.assetResponses = [];
  for (const name of ['zorid_wasm.js', 'zorid_wasm_bg.wasm']) {
    const assetPath = '/' + before.wasm.modulePrefix + '/' + name;
    assert.ok(evidence.requests.some(row => row.path === assetPath && row.statusCode === 200 && /Chrome\//.test(row.userAgent)), 'Browser fetched exact content-addressed core asset ' + name);
    // A separately labelled driver GET verifies the same ordinary server route's bytes.
    const response = await bounded(() => fetch(origin + assetPath, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) })); assert.equal(response.status, 200);
    const digest = sha(Buffer.from(await bounded(() => response.arrayBuffer()))); assert.equal(digest, before.wasm.files[name]); evidence.assetResponses.push({ name, sha256: digest, route: assetPath, kind: 'driver-read-only-verification-after-observed-browser-fetch' });
  }
  assert.deepEqual(await bounded(provenance), before, 'Source/artifact freeze after actual workflow'); evidence.provenanceVerified = true;
  await healthy(); evidence.workflowCompleted = true;
} catch (error) {
  failure = error; evidence.status = 'failed'; evidence.failure = String(error.stack ?? error);
  if (cleanupCall) try { await diagnostic('failure', true); } catch (diagnosticError) { evidence.failureDiagnosticError = diagnosticError.message; }
  if (cleanupCall) try { const image = await cleanupCall('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await fs.writeFile(path.join(out, 'failure.png'), Buffer.from(image.data, 'base64')); } catch (captureError) { evidence.failureScreenshotError = captureError.message; }
} finally {
  // Browser.close is the positive normal-close attempt. Fallback cleanup cannot
  // turn a failed normal close into a passing smoke test.
  if (cdp && chrome && !childReceipt.exit) {
    evidence.normalClose = { requested: true };
    try { await cleanupCall('Browser.close'); } catch (error) { evidence.normalClose.replyError = error.message; }
    const end = Date.now() + 4000; while (!childReceipt.exit && Date.now() < end) await delay(50);
  }
  const cleanup = await cleanupOwnedResources({ chrome, childReceipt, server, cdp }); // Profile is intentionally retained as evidence.
  evidence.cleanup = { ...cleanup, retainedProfile: profile };
  let startupTimer;
  try {
    evidence.startupCleanupTimedOut = await Promise.race([Promise.all(startupTasks.map(task => task.settled)).then(() => false), new Promise(resolve => { startupTimer = setTimeout(() => resolve(true), 10000); })]);
  } finally { clearTimeout(startupTimer); }
  evidence.startupResources = startupTasks.map(task => structuredClone(task.state));
  if (evidence.startupCleanupTimedOut || evidence.startupResources.some(resource => !resource.creationSettled || resource.cleanupError)) { failure ??= Error('Owned late startup resource cleanup is incomplete or failed'); evidence.status = 'failed'; }
  if (cleanup.failures.length || !childReceipt?.exit || childReceipt.exit.code !== 0 || childReceipt.exit.signal !== null || cleanup.chrome.signals.length) {
    failure ??= Error('Normal Browser.close and owned resource cleanup did not complete cleanly'); evidence.status = 'failed';
  }
  try { assert.deepEqual(await provenance(), before); evidence.finalProvenanceVerified = true; } catch (error) { failure ??= error; evidence.status = 'failed'; evidence.finalProvenanceError = error.message; }
  runtimeErrors(true);
  if (!failure) try { finalEvidence(evidence); evidence.status = 'passed'; } catch (error) { failure = error; evidence.status = 'failed'; evidence.finalAcceptanceError = error.message; }
  evidence.finished = new Date().toISOString(); evidence.elapsedMs = Date.now() - started; evidence.cleanupDeadlineExcludedMs = Math.max(0, Date.now() - deadline);
  await fs.writeFile(path.join(out, 'chrome-stderr.log'), stderr); await fs.writeFile(path.join(out, 'cdp-events.json'), JSON.stringify(cdp?.events ?? [], null, 2));
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(evidence, null, 2) + '\n');
}
console.log(JSON.stringify({ status: evidence.status, phases: evidence.phases, report: path.join(out, 'report.json') }));
if (failure) { console.error(failure.stack ?? failure); process.exitCode = 1; }
