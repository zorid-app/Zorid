import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlatformAdapter } from '../../src/platform/index.ts';
import { Vault } from '../../src/core/vault.ts';

const require = createRequire(import.meta.url);
const { VaultService } = require('../../desktop/vault-service.cjs');
const { admitDesktopFixtureClient } = require('../../desktop/client-admission.cjs');

test('actual native captured text creation reconciles original receipts and preserves replacements', { timeout: 60000 }, async () => {
  const executable = process.env.ZORID_DESKTOP_HOST_BIN;
  assert.ok(executable && path.isAbsolute(executable), 'Set ZORID_DESKTOP_HOST_BIN to the coordinated existing executable; this test never compiles');
  const root = await mkdtemp(path.join(tmpdir(), 'zorid-create-receipts-native-'));
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const sources = ['src/core/types.ts', 'src/core/text-create.ts', 'src/core/vault.ts', 'src/platform/index.ts', 'src/platform/bridge.d.ts', 'desktop/text-create.cjs', 'desktop/client-admission.cjs', 'desktop/editor-core.cjs', 'desktop/rust-vault-service.cjs', 'tests/text-create-receipts/native.integration.ts'];
  const sourceProof = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, createHash('sha256').update(await readFile(path.join(repository, file))).digest('hex')])));
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let service: any, admission: any, platform: Awaited<ReturnType<typeof createPlatformAdapter>>;
  const evidence: any = { status: 'running', executable, executableSha256: createHash('sha256').update(await readFile(executable)).digest('hex'), sourceSha256: await sourceProof(), scenarios: [] };
  try {
    service = await VaultService.open(root, { coreFixture: { executable, initializeLocal: true, familyMode: true } });
    admission = await admitDesktopFixtureClient(service, { fixture: true, clientId: randomUUID(), assertOwner() {} });
    let loseReply = false, failPublication = false;
    const calls: any[] = [];
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { zorid: {
      getVault: async () => ({ path: root, name: 'Disposable receipt fixture' }),
      getDurableContext: async () => ({ admissionId: 'receipt-fixture', scope: admission.scope, textCreateReceiptsAvailable: true }),
      releaseDurableContext: async () => admission.release(() => {}),
      list: async () => { if (failPublication) { failPublication = false; throw new Error('injected publication unavailable'); } return service.list(); },
      stat: (_root: string, file: string) => service.stat(file), read: (_root: string, file: string) => service.read(file),
      durableInvoke: async (_root: string, _admission: string, method: string, args: any[]) => {
        if (method === 'createTextReceipt') {
          calls.push(structuredClone(args[0]));
          const receipt = await admission.createTextReceipt(args[0]);
          if (loseReply) { loseReply = false; throw Object.assign(new Error('injected lost create reply'), { code: 'host_timeout', commitUncertain: true }); }
          return receipt;
        }
        assert.equal(method, 'fileCommand'); return admission.fileCommand(args[0]);
      },
    } } });
    platform = await createPlatformAdapter(); assert.ok(platform?.adapter.captureTextCreate);
    const vault = new Vault(platform.adapter); await vault.initialize();
    const content = '\uFEFF---\r\nstatus: Template\r\n---\r\n# {{title}}\r\nLiteral 😀\r\n';
    loseReply = true; const first = vault.createOperation('First.md', content);
    await assert.rejects(first.run(), /lost create reply/);
    const original = await service.stat('First.md'), cursor = (await service.host.listSnapshot()).cursor;
    const created = await first.run();
    assert.equal(created.entryId, original.entryId); assert.equal(created.revision, original.revision); assert.equal(await service.read('First.md'), content);
    assert.deepEqual(calls[0], calls[1]); assert.equal((await service.host.listSnapshot()).cursor, cursor);
    evidence.scenarios.push({ name: 'lost reply resumes original committed create without another vault mutation', entryId: created.entryId, revision: created.revision, cursor });

    loseReply = true; const second = vault.createOperation('Replaced.md', 'original');
    await assert.rejects(second.run(), /lost create reply/);
    const replacedOriginal = await service.stat('Replaced.md');
    await admission.fileCommand({ kind: 'delete', path: 'Replaced.md', force: true, operationId: randomUUID(), entryId: randomUUID() });
    await admission.fileCommand({ kind: 'createText', path: 'Replaced.md', content: 'replacement', operationId: randomUUID(), entryId: randomUUID() });
    const replacement = await service.stat('Replaced.md'), replacedCursor = (await service.host.listSnapshot()).cursor;
    await assert.rejects(second.run(), { code: 'created_file_changed' });
    assert.notEqual(replacement.entryId, replacedOriginal.entryId); assert.equal(await service.read('Replaced.md'), 'replacement');
    assert.equal((await service.host.listSnapshot()).cursor, replacedCursor); assert.deepEqual(calls[2], calls[3]);
    evidence.scenarios.push({ name: 'uncertain original receipt cannot adopt a replacement at the same path', originalEntryId: replacedOriginal.entryId, replacementEntryId: replacement.entryId, cursor: replacedCursor });

    const baseCapture = platform.adapter.captureTextCreate!.bind(platform.adapter);
    platform.adapter.captureTextCreate = (file, text) => {
      const captured = baseCapture(file, text); let failOnce = true;
      return { ...captured, async run() { const receipt = await captured.run(); if (failOnce) { failOnce = false; failPublication = true; } return receipt; } };
    };
    const third = vault.createOperation('Advanced.md', 'initial');
    await assert.rejects(third.run(), /publication unavailable/);
    platform.adapter.captureTextCreate = baseCapture;
    const advancedOriginal = await service.stat('Advanced.md');
    await admission.fileCommand({ kind: 'writeText', path: 'Advanced.md', content: 'later edit', expectedEntryId: advancedOriginal.entryId, expectedRevision: advancedOriginal.revision, operationId: randomUUID(), entryId: randomUUID() });
    await assert.rejects(third.run(), { code: 'created_file_changed' });
    assert.equal((await service.stat('Advanced.md')).entryId, advancedOriginal.entryId); assert.equal(await service.read('Advanced.md'), 'later edit');
    evidence.scenarios.push({ name: 'acknowledged publication failure cannot adopt an advanced original revision', entryId: advancedOriginal.entryId });
    assert.deepEqual(await sourceProof(), evidence.sourceSha256, 'Receipt sources changed during native execution'); evidence.status = 'passed';
  } finally {
    if (platform?.release) await platform.release().catch(() => {}); else if (admission) await admission.retire().catch(() => {});
    if (service) await service.close();
    if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window');
    await rm(root, { recursive: true, force: true });
    evidence.cleaned = true;
    if (process.env.ZORID_CREATE_RECEIPT_EVIDENCE) await writeFile(process.env.ZORID_CREATE_RECEIPT_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
  }
});
