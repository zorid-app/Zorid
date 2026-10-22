import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserFileCommands } from '../src/platform/browser-file-commands.ts';
import type { BrowserFileCommandBackend, BrowserFileCommandInput } from '../src/platform/browser-file-commands.ts';
import type { BrowserVaultIntent, BrowserVaultRead } from '../src/core/browser-vault.ts';
import type { Checkpoint } from '../src/core/durable-checkpoints.ts';
import { BrowserVaultError } from '../src/core/browser-vault.ts';
import { Vault } from '../src/core/vault.ts';
import { defaultBrowserAdapter } from '../src/platform/browser-default.ts';
import { decodeTextCreateReceipt } from '../src/core/text-create.ts';
import type { BrowserCoreRuntime } from '../src/platform/browser-core-runtime.ts';
import type { BrowserClientContext } from '../src/platform/browser-client-admission.ts';
// Phase-aware transport fake; Rust and IndexedDB behavior are covered by their own fixtures.
function fixture() {
    const heads = new Map<string, Checkpoint>(), rows = new Map<string, BrowserVaultIntent>(), files = new Map<string, BrowserVaultRead>(), events: string[] = [];
    let sequence = 0, checkpointFailure = 0, ackFailure = false, commitFailure = false, rejection = false;
    const backend: BrowserFileCommandBackend = {
        checkpoints: { scope: { vaultId: 'vault', clientId: 'client' },
            async load(key) { return structuredClone(heads.get(key) ?? null); },
            async compareAndSwap(change) { events.push('checkpoint'); if (checkpointFailure > 0 && --checkpointFailure === 0)
                throw new Error('checkpoint failed'); const previous = heads.get(change.key); assert.equal(previous?.revision ?? null, change.expectedRevision); const head: Checkpoint = { version: 1, vaultId: 'vault', clientId: 'client', key: change.key, revision: change.nextRevision, sequence: String(++sequence), deleted: false, byteLength: change.encodedState!.length, encodedState: change.encodedState }; heads.set(change.key, head); return structuredClone(head); },
            async list() { return { items: [...heads.values()], cursor: null, highWater: String(sequence) }; }, async changes() { return { items: [], cursor: null, highWater: String(sequence) }; },
        },
        async readEntry(path) { return structuredClone(files.get(path) ?? null); },
        async prepareFamily(id, json) { events.push('prepare:' + id); const old = rows.get(id); if (old) {
            assert.equal(old.family_command_json, json);
            return;
        } const family = JSON.parse(json); rows.set(id, { client_id: 'client', intent_id: id, operation_id: family.request.operation_id, request_json: JSON.stringify(family.request), family_command_json: json, order: String(rows.size + 1), acknowledged: false, status: 'prepared' }); },
        async commit(id) { events.push('commit:' + id); const row = rows.get(id)!; if (row.status === 'committed')
            return row.receipt!; if (rejection) {
            row.status = 'rejected';
            row.error = { code: 'revision_conflict', message: 'stale', source: 'rust' };
            throw new BrowserVaultError('revision_conflict', 'stale', undefined, 'rust');
        } const m = JSON.parse(row.request_json).mutation; row.status = 'committed'; row.receipt = JSON.stringify({ operation_id: id, sequence: String(++sequence), changes: m.type === 'create' ? [{ before: null, after: { id: m.id, path: m.path, kind: m.kind, revision: 'revision-' + sequence, deleted: false } }] : [] }); if (m.type === 'create')
            files.set(m.path, { entry: { id: m.id, path: m.path, kind: m.kind, revision: 'revision-' + sequence, deleted: false }, presentation: { id: m.id, ctime_ms: 1, mtime_ms: 1, size_bytes: m.content?.length ?? 0 }, ...(m.content ? { bytes: Uint8Array.from(m.content) } : {}) }); if (commitFailure) {
            commitFailure = false;
            throw new BrowserVaultError('outcome_unknown', 'lost response');
        } return row.receipt; },
        async intents() { return structuredClone([...rows.values()]); },
        async acknowledge(id, outcome) { events.push('ack:' + id); const row = rows.get(id)!; assert.deepEqual(outcome, row.status === 'committed' ? { status: 'committed', receipt: row.receipt } : { status: 'rejected', error: row.error }); row.acknowledged = true; if (ackFailure) {
            ackFailure = false;
            throw new BrowserVaultError('outcome_unknown', 'lost ACK response');
        } },
    };
    return { backend, heads, rows, files, events, consumer: () => createBrowserFileCommands(backend), failCheckpoint(n: number) { checkpointFailure = n; }, loseAck() { ackFailure = true; }, loseCommit() { commitFailure = true; }, reject() { rejection = true; } };
}
const create: BrowserFileCommandInput = { kind: 'createText', operationId: 'operation', entryId: 'entry', path: 'Note.md', content: 'draft' };
test('receipt API retains original committed file identity after lost ACK and a same-path replacement', async () => {
    const f = fixture(); f.loseCommit(); f.loseAck();
    await assert.rejects(f.consumer().createTextReceipt(create as Extract<BrowserFileCommandInput,{kind:'createText'}>), { code: 'outcome_unknown' });
    const original = structuredClone(f.files.get('Note.md')!.entry);
    f.files.set('Note.md', { ...existing(), entry: { ...existing().entry, id: 'replacement', revision: 'replacement-revision' } });
    const raw = await f.consumer().createTextReceipt(create as Extract<BrowserFileCommandInput,{kind:'createText'}>);
    const receipt = decodeTextCreateReceipt(raw, create);
    assert.equal(receipt.entryId, original.id); assert.equal(receipt.revision, original.revision); assert.equal(f.rows.size, 1);
    assert.equal(f.files.get('Note.md')!.entry.id, 'replacement');
    await assert.rejects(f.consumer().createTextReceipt({ ...create, content: 'changed' } as Extract<BrowserFileCommandInput,{kind:'createText'}>), { code: 'idempotency_conflict' });
});
function existing(path = 'Note.md', kind: 'file' | 'folder' = 'file'): BrowserVaultRead { return { entry: { id: 'old-entry', path, kind, revision: 'old-revision', deleted: false }, presentation: { id: 'old-entry', ctime_ms: 1, mtime_ms: 1, size_bytes: 3 }, ...(kind === 'file' ? { bytes: new TextEncoder().encode('old') } : {}) }; }
test('checkpoint precedes preparation and terminal checkpoint precedes exact ACK; identical retry retains IDs', async () => {
    const f = fixture(), c = f.consumer();
    await c.execute(create);
    assert.deepEqual(f.events, ['checkpoint', 'prepare:operation', 'commit:operation', 'checkpoint', 'ack:operation']);
    await c.execute(create);
    assert.equal(f.rows.size, 1);
    assert.equal(f.events.filter(e => e === 'commit:operation').length, 1);
    await assert.rejects(c.execute({ ...create, content: 'different' }), { code: 'idempotency_conflict' });
});
test('checkpoint failure never authorizes an unrecorded command', async () => { const f = fixture(); f.failCheckpoint(1); await assert.rejects(f.consumer().execute(create), /checkpoint failed/); assert.equal(f.rows.size, 0); });
test('outcome checkpoint failure recovers the exact committed command and ACKs only after persistence', async () => { const f = fixture(); f.failCheckpoint(2); await assert.rejects(f.consumer().execute(create), /checkpoint failed/); assert.equal(f.rows.get('operation')!.acknowledged, false); assert.equal(await f.consumer().recover(), true); assert.equal(f.rows.get('operation')!.acknowledged, true); assert.equal(f.events.filter(e => e === 'commit:operation').length, 1); });
test('lost commit and lost ACK responses preserve exact settled outcomes across restart', async () => { const f = fixture(); f.loseCommit(); f.loseAck(); await assert.rejects(f.consumer().execute(create), { code: 'outcome_unknown' }); assert.equal(await f.consumer().recover(), false); await f.consumer().execute(create); assert.equal(f.rows.size, 1); });
test('create never overwrites and stale expected identity/content never prepares', async () => { const f = fixture(); f.files.set('Note.md', existing()); await assert.rejects(f.consumer().execute(create), { code: 'revision_conflict' }); await assert.rejects(f.consumer().execute({ ...create, kind: 'writeText', expectedContent: 'old', expectedEntryId: 'replacement', expectedRevision: 'old-revision' }), { code: 'revision_conflict' }); await assert.rejects(f.consumer().execute({ ...create, kind: 'writeText', expectedContent: 'different' }), { code: 'revision_conflict' }); assert.equal(f.rows.size, 0); });
test('binary input snapshots before await; binary and text family modes are explicit', async () => { const f = fixture(), data = Uint8Array.from([0, 255, 128]); const writing = f.consumer().execute({ kind: 'createBinary', operationId: 'binary-op', entryId: 'binary-entry', path: 'data.bin', data }); data.fill(42); await writing; const family = JSON.parse(f.rows.get('binary-op')!.family_command_json!); assert.equal(family.create_mode, 'binary'); assert.deepEqual(family.request.mutation.content, [0, 255, 128]); await f.consumer().execute({ kind: 'writeBinary', operationId: 'binary-write', entryId: 'ignored', path: 'data.bin', data: Uint8Array.from([254]) }); assert.equal(JSON.parse(f.rows.get('binary-write')!.request_json).mutation.expected, f.files.get('data.bin')!.entry.revision); });
test('write binds exact captured revision and rejects Unicode loss before preparation', async () => { const f = fixture(); f.files.set('Note.md', existing()); await f.consumer().execute({ ...create, kind: 'writeText', expectedEntryId: 'old-entry', expectedRevision: 'old-revision', expectedContent: 'old' }); assert.deepEqual(JSON.parse(f.rows.get('operation')!.request_json).mutation, { type: 'write', id: 'old-entry', expected: 'old-revision', content: Array.from(new TextEncoder().encode('draft')) }); await assert.rejects(f.consumer().execute({ ...create, operationId: 'bad', content: '\ud800' }), { code: 'invalid_text' }); });
test('trash preserves nested parent plans and original final entry/revision through interruption', async () => { const f = fixture(); f.files.set('folder/Note.md', existing('folder/Note.md')); f.failCheckpoint(3); await assert.rejects(f.consumer().execute({ kind: 'trash', operationId: 'trash-op', entryId: 'unused', path: 'folder/Note.md' }), /checkpoint failed/); const saved = JSON.parse([...f.heads.values()][0].encodedState!); const planned = structuredClone(saved.steps); f.files.set('folder/Note.md', { ...existing('folder/Note.md'), entry: { ...existing('folder/Note.md').entry, id: 'replacement', revision: 'new-revision' } }); assert.equal(await f.consumer().recover(), true); const state = JSON.parse([...f.heads.values()][0].encodedState!); assert.deepEqual(state.steps, planned); assert.equal(state.status, 'committed'); assert.deepEqual(JSON.parse(f.rows.get('trash-op')!.request_json).mutation, { type: 'move', id: 'old-entry', expected: 'old-revision', path: '.trash/trash-op/folder/Note.md' }); assert.equal(f.rows.size, 4); assert.ok([...f.rows.values()].every(row => row.acknowledged)); });
test('rejected command is checkpointed before ACK and recovery settles without replay', async () => { const f = fixture(); f.reject(); await assert.rejects(f.consumer().execute(create), { code: 'revision_conflict' }); assert.equal(JSON.parse([...f.heads.values()][0].encodedState!).status, 'rejected'); assert.equal(f.rows.get('operation')!.acknowledged, true); assert.equal(await f.consumer().recover(), false); await assert.rejects(f.consumer().execute(create), { code: 'revision_conflict' }); assert.equal(f.events.filter(e => e === 'commit:operation').length, 1); });
test('tampered request signatures and command plans block recovery without preparation', async () => { for (const tamper of [(state: any) => state.request.path = 'Other.md', (state: any) => state.steps[0].mutation.path = 'Other.md']) {
    const f = fixture();
    f.failCheckpoint(2);
    await assert.rejects(f.consumer().execute(create));
    const head = [...f.heads.values()][0], state = JSON.parse(head.encodedState!);
    tamper(state);
    f.heads.set(head.key, { ...head, encodedState: JSON.stringify(state) });
    const before = f.events.length;
    await assert.rejects(f.consumer().recover(), { code: 'invalid_file_checkpoint' });
    assert.equal(f.events.length, before);
} });
test('stored command/intent disagreement prevents ACK or another mutation', async () => { const f = fixture(); f.failCheckpoint(2); await assert.rejects(f.consumer().execute(create)); f.rows.get('operation')!.family_command_json = f.rows.get('operation')!.family_command_json!.replace('Note.md', 'Other.md'); await assert.rejects(f.consumer().recover(), { code: 'intent_identity_mismatch' }); assert.equal(f.rows.get('operation')!.acknowledged, false); });
test('move/delete/mkdir planning and active fence preserve namespace safety', async () => { const f = fixture(); f.files.set('Note.md', existing()); await f.consumer().execute({ kind: 'move', operationId: 'move', entryId: 'unused', path: 'Note.md', destination: 'Moved.md' }); await f.consumer().execute({ kind: 'delete', operationId: 'delete', entryId: 'unused', path: 'Note.md', force: false }); await f.consumer().execute({ kind: 'mkdir', operationId: 'mkdir', entryId: 'folder', path: 'Folder' }); assert.deepEqual(JSON.parse(f.rows.get('delete')!.request_json).mutation, { type: 'delete', id: 'old-entry', expected: 'old-revision', recursive: false }); const closed = createBrowserFileCommands(f.backend, () => { throw new BrowserVaultError('storage_closed', 'closed'); }); await assert.rejects(closed.execute({ ...create, operationId: 'closed' }), { code: 'storage_closed' }); });
test('recovery ACKs newly observed rejection and reports already committed trash prefixes', async () => { const f = fixture(); f.files.set('folder/Note.md', existing('folder/Note.md')); f.failCheckpoint(3); await assert.rejects(f.consumer().execute({ kind: 'trash', operationId: 'trash-op', entryId: 'unused', path: 'folder/Note.md' })); f.reject(); assert.equal(await f.consumer().recover(), true); assert.equal(JSON.parse([...f.heads.values()][0].encodedState!).status, 'rejected'); assert.ok([...f.rows.values()].every(row => row.acknowledged)); });
test('oversized encoded family commands fail before checkpoint or authorization', async () => { const f = fixture(); await assert.rejects(f.consumer().execute({ kind: 'createBinary', operationId: 'large', entryId: 'entry', path: 'large.bin', data: new Uint8Array(2 * 1024 * 1024).fill(255) }), { code: 'request_limit' }); assert.equal(f.heads.size, 0); assert.equal(f.rows.size, 0); });

test('Vault binary create rejects a peer created after its inventory check without adopting it as a write', async () => {
    const f = fixture(), commands = f.consumer();
    let race = false;
    const runtime = {
        async inventory() {
            const snapshot = structuredClone([...f.files.values()]);
            if (race) { race = false; f.files.set('race.bin', existing('race.bin')); }
            return snapshot;
        },
    } as unknown as BrowserCoreRuntime;
    const context = { durableWrites: {}, recoverCommands: () => commands.recover(), fileCommand: (input: BrowserFileCommandInput) => commands.execute(input) } as unknown as BrowserClientContext;
    const adapter = defaultBrowserAdapter(runtime, context), vault = new Vault(adapter);
    await vault.initialize(); race = true;
    const source = new Uint8Array([0, 255, 128]), creating = vault.createBinary('race.bin', source); source.fill(9);
    await assert.rejects(creating, { code: 'revision_conflict' });
    assert.deepEqual(f.files.get('race.bin')!.bytes, new TextEncoder().encode('old'));
    assert.equal(f.rows.size, 0, 'the peer must not be adopted into a write command');
    assert.equal(f.heads.size, 0);
});

test('namespace commands and creation use metadata while text replacement retains coherent body reads',async()=>{
  const f=fixture(),body=f.backend.readEntry;let metadata=0,reads=0;f.files.set('Large.bin',{...existing('Large.bin'),presentation:{...existing().presentation,size_bytes:67108864}});
  f.backend.readMetadata=async path=>{metadata++;const row=await body(path);if(!row)return null;const {bytes,...observed}=row;return observed;};
  f.backend.readEntry=async path=>{reads++;if(path==='Large.bin')throw new Error('whole binary body forbidden');return body(path);};
  await f.consumer().execute({kind:'move',operationId:'metadata-move',entryId:'unused',path:'Large.bin',destination:'Moved.bin'});
  await f.consumer().execute({kind:'trash',operationId:'metadata-trash',entryId:'unused',path:'Large.bin'});
  await f.consumer().execute({kind:'delete',operationId:'metadata-delete',entryId:'unused',path:'Large.bin',force:false});
  await f.consumer().execute({kind:'writeBinary',operationId:'metadata-write-binary',entryId:'unused',path:'Large.bin',data:Uint8Array.of(1),expectedEntryId:'old-entry',expectedRevision:'old-revision'});
  await f.consumer().execute({...create,operationId:'metadata-create'});assert.equal(reads,0);assert.ok(metadata>3);
  await f.consumer().execute({...create,kind:'writeText',operationId:'body-write',expectedContent:'draft'});assert.equal(reads,1);
});


test('witnessed move rejects malformed, stale, replacement and missing sources before checkpoint or authorization', async () => {
    for (const expected of [
        { expectedEntryId: 'old-entry' }, { expectedRevision: 'old-revision' },
        { expectedEntryId: undefined, expectedRevision: undefined },
        { expectedEntryId: 'bad/id', expectedRevision: 'old-revision' },
    ]) {
        const f = fixture(); f.files.set('Note.md', existing());
        await assert.rejects(f.consumer().execute({ kind: 'move', operationId: 'move', entryId: 'unused', path: 'Note.md', destination: 'Renamed.md', ...expected } as BrowserFileCommandInput), { code: 'invalid_file_request' });
        assert.equal(f.heads.size, 0); assert.equal(f.rows.size, 0);
    }
    for (const [expectedEntryId, expectedRevision, missing] of [
        ['replacement', 'old-revision', false], ['old-entry', 'stale-revision', false], ['old-entry', 'old-revision', true],
    ] as const) {
        const f = fixture(); if (!missing) f.files.set('Note.md', existing());
        await assert.rejects(f.consumer().execute({ kind: 'move', operationId: 'move', entryId: 'unused', path: 'Note.md', destination: 'Renamed.md', expectedEntryId, expectedRevision }), { code: 'revision_conflict' });
        assert.equal(f.heads.size, 0); assert.equal(f.rows.size, 0);
        assert.equal(f.files.has('Renamed.md'), false);
    }
});

test('witnessed move retains its exact identity, revision and retry signature after lost ACK', async () => {
    const f = fixture(); f.files.set('Note.md', existing()); f.loseCommit(); f.loseAck();
    const request: BrowserFileCommandInput = { kind: 'move', operationId: 'move', entryId: 'unused', path: 'Note.md', destination: 'Renamed.md', expectedEntryId: 'old-entry', expectedRevision: 'old-revision' };
    await assert.rejects(f.consumer().execute(request), { code: 'outcome_unknown' });
    const original = JSON.parse(f.rows.get('move')!.request_json).mutation;
    assert.deepEqual(original, { type: 'move', id: 'old-entry', expected: 'old-revision', path: 'Renamed.md' });
    f.files.set('Note.md', { ...existing(), entry: { ...existing().entry, id: 'replacement', revision: 'replacement-revision' } });
    f.backend.readMetadata = async () => { throw new Error('retained move must not replan from a replacement'); };
    await assert.rejects(f.consumer().execute({ ...request, expectedRevision: 'replacement-revision' }), { code: 'idempotency_conflict' });
    assert.equal(await f.consumer().recover(), false);
    await f.consumer().execute(request);
    assert.deepEqual(JSON.parse(f.rows.get('move')!.request_json).mutation, original);
    assert.equal(f.rows.size, 1); assert.equal(f.rows.get('move')!.acknowledged, true);
});

test('one MiB Markdown creation admits worst-case numeric byte-array framing',async()=>{
    const f=fixture();const content='z'.repeat(1024*1024);
    await f.consumer().execute({...create,content});
    const row=f.rows.get('operation')!;
    assert.equal(row.status,'committed');
    assert.ok(new TextEncoder().encode(row.request_json).byteLength>4*1024*1024);
    assert.equal(row.request_json.length<8*1024*1024,true);
    assert.deepEqual(JSON.parse(row.request_json).mutation.content,Array.from(new TextEncoder().encode(content)));
});
