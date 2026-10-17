// Real browser/WASM checks. In-memory plans only: no persistence or HTTP sync claim.
import {
  generateKey, createEmptyFileState, inspectFileState, planFileMutation,
  createEmptyTextState, materializeTextState, planTextReplace,
  encodeSyncCursor, decodeSyncAccepted, decodeSyncPage,
  validateAuthoredSyncPayload, validateSyncWire, encodeFilePayload,
} from './pkg/zorid_wasm.js';
import { headerFor, contextFor } from './crypto-cases.mjs';

const encode = new TextEncoder();
const decode = new TextDecoder();
const j = JSON.stringify;
function assert(condition, label) { if (!condition) throw new Error(label); }
function rejects(fn, label) {
  try { fn(); } catch { return; }
  throw new Error(`expected rejection: ${label}`);
}

export function runSyncChecks(checks) {
  const handles = [];
  const own = value => { handles.push(value); return value; };
  try {
    const scope = { realm_id: 'fixture-realm', vault_id: 'fixture-vault' };
    const empty = JSON.parse(createEmptyFileState(j({ scope, version: 'graph-empty' })));
    const payload = {
      family: 'files', format_version: 2, scope, id: 'namespace-create',
      body: { kind: 'events', events: [{
        id: 'namespace-create', identity: { entry_id: 'note', bootstrap_id: 'namespace-create' }, parents: [],
        effect: { kind: 'create', entry_kind: 'file', location: { parent: null, name: 'note.md' },
          content: { kind: 'text', text_bootstrap_id: 'text-seed', text_format: 2 } },
      }] },
    };
    const filePlan = own(planFileMutation(j({ state: empty, payload, next_version: 'graph-created' })));
    const fileResult = JSON.parse(filePlan.resultJson());
    const graph = fileResult.namespace.next_state;
    const metadata = filePlan.metadataJson();
    const fileBytes = Uint8Array.from(fileResult.payload_bytes);
    validateAuthoredSyncPayload(metadata, fileBytes);
    assert(j(Array.from(encodeFilePayload(JSON.stringify(payload, null, 2)))) === j(Array.from(fileBytes)), 'canonical authored file retry');
    rejects(() => encodeFilePayload(`${j(payload).slice(0, -1)},"id":"namespace-create"}`), 'duplicate raw file field');
    filePlan.checkPreconditions(j({ state: empty, update_id_unused: true }));
    rejects(() => filePlan.checkPreconditions(j({ state: empty, update_id_unused: false })), 'global update collision');
    assert(JSON.parse(inspectFileState(j(graph))).content_bindings.note.kind === 'text', 'immutable text content binding');
    checks.push('WASM file-v2 authoring creates a Rust-validated text namespace and checks common update identity');

    const key = own(generateKey());
    const fileWire = key.seal(headerFor('namespace-create', 'browser-author'), fileBytes);
    validateSyncWire(metadata, fileWire);
    const fileUpdate = own(key.openSyncUpdate(contextFor('namespace-create'), fileWire));
    assert(fileUpdate.matchesPayload(fileBytes), 'exact authenticated file payload');
    assert(fileUpdate.metadataJson() === metadata, 'authored/authenticated file metadata agree');
    const receivedFile = own(fileUpdate.planFile(j({ state: empty, prior: null, next_version: 'graph-peer' })));
    receivedFile.checkPreconditions(j({ state: empty, prior: null }));
    const peerGraph = JSON.parse(receivedFile.resultJson()).namespace.next_state;
    assert(j(peerGraph.records) === j(graph.records), 'peer namespace receives same file records');
    rejects(() => fileUpdate.planText('{}'), 'file capability cannot plan text');
    checks.push('WASM authenticates file-v2 wire and plans peer namespace through an opaque family capability');

    const text = JSON.parse(createEmptyTextState(j({ identity: {
      ...scope, entry_id: 'note', bootstrap_id: 'text-seed',
    }, version: 'text-empty' })));
    const textPlan = own(planTextReplace(j({ state: text, namespace_state: graph,
      request: { expected_version: 'text-empty', next_version: 'text-authored', update_id: 'text-edit',
        actor: { actor: 7, owner: { replica_id: 'browser-author', incarnation_id: 'incarnation' } }, edits: [] },
      namespace: { bootstrap_id: 'namespace-create', parents: ['namespace-create'] },
      next_namespace_version: 'graph-text-authored',
    }), encode.encode('Hello browser 🦀')));
    const textResult = JSON.parse(textPlan.resultJson());
    const actual = { state: text, namespace_state: graph, update_id_unused: true };
    textPlan.checkPreconditions(j(actual));
    const staleText = structuredClone(actual); staleText.state.version = 'stale';
    const staleGraph = structuredClone(actual); staleGraph.namespace_state.version = 'stale';
    rejects(() => textPlan.checkPreconditions(j(staleText)), 'stale text state');
    rejects(() => textPlan.checkPreconditions(j(staleGraph)), 'stale namespace state');
    assert(textResult.namespace.next_state.activities['text-edit'], 'text update also creates namespace activity');
    const textMetadata = textPlan.metadataJson();
    assert(j(JSON.parse(textMetadata).text_binding.namespace) === j({ bootstrap_id: 'namespace-create', parents: ['namespace-create'] }), 'metadata binds exact namespace context');
    const textBytes = Uint8Array.from(textResult.text.authored.payload_bytes);
    validateAuthoredSyncPayload(textMetadata, textBytes);
    const wrongNamespace = JSON.parse(textMetadata);
    wrongNamespace.text_binding.namespace.parents = ['forged-parent'];
    rejects(() => validateAuthoredSyncPayload(j(wrongNamespace), textBytes), 'changed stored namespace witness');
    const textWire = key.seal(headerFor('text-edit', 'browser-author'), textBytes);
    const textUpdate = own(key.openSyncUpdate(contextFor('text-edit'), textWire));
    assert(textUpdate.metadataJson() === textMetadata, 'authored/authenticated text metadata agree');
    const receive = { state: text, namespace_state: peerGraph,
      request: { expected_version: 'text-empty', next_version: 'text-received', delivery: null },
      next_namespace_version: 'graph-text-received', prior: null, cursor: null };
    const receivedText = own(textUpdate.planText(j(receive)));
    receivedText.checkPreconditions(j({ state: text, namespace_state: peerGraph, prior: null, cursor: null }));
    const textReceived = JSON.parse(receivedText.resultJson());
    assert(decode.decode(materializeTextState(j(textReceived.text.next_state))) === 'Hello browser 🦀', 'received text materialization');
    assert(!Object.hasOwn(textReceived.text, 'authored'), 'received text creates no authored echo');
    assert(textReceived.namespace.next_state.activities['text-edit'], 'received text retains matching namespace activity');
    const badWire = textWire.slice(); badWire[badWire.length - 1] ^= 1;
    validateSyncWire(textMetadata, badWire); // Framing consistency is deliberately not authentication.
    rejects(() => key.openSyncUpdate(contextFor('text-edit'), badWire), 'tampered tag');
    rejects(() => key.openSyncUpdate(contextFor('text-edit', { key_epoch: 2 }), textWire), 'independent key epoch');
    checks.push('WASM combined text/namespace plans reject stale states, authenticate peer text, preserve no-echo and reject tampering');

    const maximum = '18446744073709551615';
    const cursor = JSON.parse(encodeSyncCursor(j({ server_epoch: 'epoch', after: maximum })));
    assert(cursor.after === maximum, 'cursor u64 maximum remains string');
    const expected = j({ vault_id: 'fixture-vault', update_id: 'text-edit', server_epoch: 'epoch' });
    const accepted = { vault_id: 'fixture-vault', update_id: 'text-edit', server_epoch: 'epoch', sequence: maximum };
    assert(JSON.parse(decodeSyncAccepted(expected, encode.encode(j(accepted)))).sequence === maximum, 'ACK u64 remains exact');
    rejects(() => decodeSyncAccepted(expected, encode.encode(j(accepted).replace('}', ',"sequence":"1"}'))), 'duplicate raw ACK field');
    const page = { items: [], next: cursor, through: maximum, complete: true };
    assert(JSON.parse(decodeSyncPage(j({ server_epoch: 'epoch', after: maximum, through: maximum }), encode.encode(j(page)))).through === maximum, 'page cursor u64 remains exact');
    rejects(() => encodeSyncCursor('{"server_epoch":"epoch","after":1}'), 'numeric cursor');
    checks.push('WASM raw transport codecs preserve u64 strings and reject duplicate fields and numeric cursors');
  } finally {
    for (const handle of handles.reverse()) handle.free();
  }
}
