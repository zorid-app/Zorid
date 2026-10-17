import { BrowserVaultError } from '../core/browser-vault.ts';
import type { BrowserVaultRead, BrowserVaultIntent, BrowserVaultOutcome } from '../core/browser-vault.ts';
import type { Checkpoint, DurableCheckpoints } from '../core/durable-checkpoints.ts';
import { boundedUtf8, checkpointStateLimit } from '../core/checkpoint-input.ts';
import { vaultPath } from './path.ts';
type Base = {
    operationId: string;
    entryId: string;
    path: string;
};
type Expected = {
    expectedContent?: string;
    expectedEntryId?: string;
    expectedRevision?: string;
};
export type BrowserFileCommandInput = Base & ({
    kind: 'createText';
    content: string;
} | ({
    kind: 'writeText';
    content: string;
} & Expected) | {
    kind: 'createBinary';
    data: Uint8Array;
} | ({
    kind: 'writeBinary';
    data: Uint8Array;
} & Omit<Expected, 'expectedContent'>) | {
    kind: 'mkdir' | 'trash';
} | ({
    kind: 'move';
    destination: string;
} & Omit<Expected, 'expectedContent'>) | {
    kind: 'delete';
    force: boolean;
});
export interface BrowserFileCommandBackend {
    readonly checkpoints: DurableCheckpoints;
    readEntry(path: string): Promise<BrowserVaultRead | null>;
    readMetadata?(path:string):Promise<BrowserVaultRead|null>;
    prepareFamily(intentId: string, commandJson: string): Promise<void>;
    commit(intentId: string): Promise<string>;
    intents(): Promise<BrowserVaultIntent[]>;
    acknowledge(intentId: string, outcome: BrowserVaultOutcome): Promise<void>;
}
const prefix = 'file-command/v1/', maxBytes = 16 * 1024 * 1024, maxSteps = 256;
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const failure = (code: string) => new BrowserVaultError(code, 'File operation could not finish; its exact request is retained.');
interface Request {
    kind: BrowserFileCommandInput['kind'];
    operationId: string;
    entryId: string;
    path: string;
    body?: string;
    expectedBody?: string;
    expectedEntryId?: string;
    expectedRevision?: string;
    destination?: string;
    force?: boolean;
}
type Mutation = {
    type: 'create';
    id: string;
    path: string;
    kind: 'file' | 'folder';
} | {
    type: 'write';
    id: string;
    expected: string;
} | {
    type: 'move';
    id: string;
    expected: string;
    path: string;
} | {
    type: 'delete';
    id: string;
    expected: string;
    recursive: boolean;
};
interface Step {
    operationId: string;
    mutation: Mutation;
    mode: 'text' | 'binary' | null;
}
interface State {
    version: 1;
    request: Request;
    signature: string;
    planSignature: string;
    steps: Step[];
    next: number;
    status: 'requested' | 'committed' | 'rejected';
    outcome?: BrowserVaultOutcome;
}
function path(value: string): string { try {
    const result = vaultPath(value);
    boundedUtf8(result, 8192, 'invalid_file_request');
    return result;
}
catch {
    throw failure('invalid_file_request');
} }
function encode(bytes: Uint8Array): string { let text = ''; for (let index = 0; index < bytes.length; index += 8192)
    text += String.fromCharCode(...bytes.subarray(index, index + 8192)); return btoa(text); }
function bytes(value: unknown): Uint8Array { if (typeof value !== 'string' || value.length > 22369624)
    throw failure('invalid_file_checkpoint'); let decoded; try {
    decoded = atob(value);
}
catch {
    throw failure('invalid_file_checkpoint');
} const result = Uint8Array.from(decoded, c => c.charCodeAt(0)); if (result.length > maxBytes || encode(result) !== value)
    throw failure('invalid_file_checkpoint'); return result; }
function text(value: unknown): string { boundedUtf8(value, maxBytes, 'invalid_text'); return encode(new TextEncoder().encode(value as string)); }
function capture(input: BrowserFileCommandInput): Request {
    if (!input || !identity(input.operationId) || !identity(input.entryId))
        throw failure('invalid_file_request');
    const request: Request = { kind: input.kind, operationId: input.operationId, entryId: input.entryId, path: path(input.path) };
    if (input.kind === 'createText' || input.kind === 'writeText') {
        request.body = text(input.content);
        if (input.kind === 'writeText' && input.expectedContent !== undefined)
            request.expectedBody = text(input.expectedContent);
    }
    else if (input.kind === 'createBinary' || input.kind === 'writeBinary') {
        if (!(input.data instanceof Uint8Array) || input.data.length > maxBytes)
            throw failure('request_limit');
        request.body = encode(input.data);
    }
    else if (input.kind === 'move')
        request.destination = path(input.destination);
    else if (input.kind === 'delete') {
        if (typeof input.force !== 'boolean')
            throw failure('invalid_file_request');
        request.force = input.force;
    }
    else if (input.kind !== 'mkdir' && input.kind !== 'trash')
        throw failure('invalid_file_request');
    if ('expectedEntryId' in input || 'expectedRevision' in input) {
        if (!identity(input.expectedEntryId) || !identity(input.expectedRevision))
            throw failure('invalid_file_request');
        request.expectedEntryId = input.expectedEntryId;
        request.expectedRevision = input.expectedRevision;
    }
    return request;
}
const signature = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), b => b.toString(16).padStart(2, '0')).join('');
function family(step: Step, request: Request): string {
    const mutation = { ...step.mutation, ...(step.mutation.type === 'write' || step.mutation.type === 'create' ? { content: step.mutation.type === 'create' && step.mutation.kind === 'folder' ? null : Array.from(bytes(request.body)) } : {}) };
    const json = JSON.stringify({ version: 1, request: { operation_id: step.operationId, mutation }, create_mode: step.mode });
    boundedUtf8(json, 4 * 1024 * 1024, 'request_limit');
    return json;
}
/** Consumer-owned command checkpoints precede commit authorization. Trash is a
 * resumable sequence, not an atomic namespace batch. No completed prefix is replanned. */
export function createBrowserFileCommands(backend: BrowserFileCommandBackend, assertActive: () => void = () => { }) {
    const checkpoints = backend.checkpoints;
    let tail: Promise<unknown> = Promise.resolve();
    function serial<T>(action: () => Promise<T>): Promise<T> { const task = tail.then(() => { assertActive(); return action(); }); tail = task.catch(() => { }); return task; }
    async function plan(request: Request): Promise<Step[]> {
        const observe=(path:string)=>backend.readMetadata?.(path)??backend.readEntry(path);
        const current = await (request.kind==='writeText'?backend.readEntry(request.path):observe(request.path)), steps: Step[] = [];
        const create = (entryPath: string, kind: 'file' | 'folder', id = request.entryId, operationId = request.operationId): Step => ({ operationId, mutation: { type: 'create', id, path: entryPath, kind }, mode: kind === 'folder' ? null : request.kind.endsWith('Binary') ? 'binary' : 'text' });
        if (request.kind === 'mkdir' || request.kind === 'createText' || request.kind === 'createBinary') {
            if (current)
                throw failure('revision_conflict');
            return [create(request.path, request.kind === 'mkdir' ? 'folder' : 'file')];
        }
        if (request.kind === 'writeText' || request.kind === 'writeBinary') {
            if (!current) {
                if (request.expectedBody !== undefined || request.expectedEntryId !== undefined)
                    throw failure('revision_conflict');
                return [create(request.path, 'file')];
            }
            if (current.entry.kind !== 'file' || request.kind==='writeText'&&!current.bytes)
                throw failure('invalid_request');
            if (request.expectedEntryId !== undefined && (current.entry.id !== request.expectedEntryId || current.entry.revision !== request.expectedRevision))
                throw failure('revision_conflict');
            if (request.expectedBody !== undefined && encode(current.bytes!) !== request.expectedBody)
                throw failure('revision_conflict');
            return [{ operationId: request.operationId, mutation: { type: 'write', id: current.entry.id, expected: current.entry.revision }, mode: null }];
        }
        if (request.kind === 'move' && request.expectedEntryId !== undefined && (!current || current.entry.id !== request.expectedEntryId || current.entry.revision !== request.expectedRevision))
            throw failure('revision_conflict');
        if (!current)
            throw failure('not_found');
        let destination = request.destination;
        if (request.kind === 'trash') {
            if (request.path === '.trash' || request.path.startsWith('.trash/'))
                throw failure('invalid_request');
            destination = `.trash/${request.operationId}/${request.path}`;
            const parts = destination.split('/');
            parts.pop();
            if (parts.length >= maxSteps)
                throw failure('request_limit');
            for (let index = 1; index <= parts.length; index++) {
                const parentPath = parts.slice(0, index).join('/'), parent = await observe(parentPath);
                if (parent) {
                    if (parent.entry.kind !== 'folder')
                        throw failure('invalid_request');
                }
                else
                    steps.push(create(parentPath, 'folder', crypto.randomUUID(), crypto.randomUUID()));
            }
        }
        if (request.kind === 'move' || request.kind === 'trash') {
            if (!destination || destination === request.path || destination.startsWith(request.path + '/') || await observe(destination))
                throw failure('revision_conflict');
            steps.push({ operationId: request.operationId, mutation: { type: 'move', id: current.entry.id, expected: current.entry.revision, path: destination }, mode: null });
        }
        else
            steps.push({ operationId: request.operationId, mutation: { type: 'delete', id: current.entry.id, expected: current.entry.revision, recursive: request.force! }, mode: null });
        return steps;
    }
    function persist(head: Checkpoint | null, state: State): Promise<Checkpoint> { assertActive(); const encodedState = JSON.stringify(state); boundedUtf8(encodedState, checkpointStateLimit, 'request_limit'); return checkpoints.compareAndSwap({ key: prefix + state.request.operationId, expectedRevision: head?.revision ?? null, nextRevision: crypto.randomUUID(), encodedState }); }
    async function decode(head: Checkpoint): Promise<State> {
        try {
            boundedUtf8(head.encodedState, checkpointStateLimit);
            const state = JSON.parse(head.encodedState!) as State, r = state.request;
            const recaptured = capture({ ...r, content: r.body === undefined || r.kind.endsWith('Binary') ? undefined : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes(r.body)), data: r.body === undefined ? undefined : bytes(r.body), expectedContent: r.expectedBody === undefined ? undefined : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes(r.expectedBody)) } as BrowserFileCommandInput);
            if (JSON.stringify(recaptured) !== JSON.stringify(r) || state.version !== 1 || head.key !== prefix + r.operationId || state.signature !== await signature(r) || state.planSignature !== await signature(state.steps) || !['requested', 'committed', 'rejected'].includes(state.status) || !Array.isArray(state.steps) || !state.steps.length || state.steps.length > maxSteps || !Number.isInteger(state.next) || state.next < 0 || state.next >= state.steps.length)
                throw 0;
            const ids = new Set<string>(), entries = new Set<string>();
            let previousParent = -1;
            for (let index = 0; index < state.steps.length; index++) {
                const step = state.steps[index], m = step.mutation, last = index === state.steps.length - 1;
                if (!identity(step.operationId) || !identity(m.id) || ids.has(step.operationId))
                    throw 0;
                ids.add(step.operationId);
                if (!last) {
                    const parents = `.trash/${r.operationId}/${r.path}`.split('/');
                    parents.pop();
                    const position = parents.map((_, i) => parents.slice(0, i + 1).join('/')).indexOf('path' in m ? m.path : '');
                    if (r.kind !== 'trash' || m.type !== 'create' || m.kind !== 'folder' || step.mode !== null || position <= previousParent || entries.has(m.id) || step.operationId === r.operationId)
                        throw 0;
                    previousParent = position;
                    entries.add(m.id);
                }
                else {
                    if (step.operationId !== r.operationId)
                        throw 0;
                    if (m.type === 'create') {
                        if (!['mkdir', 'createText', 'createBinary', 'writeText', 'writeBinary'].includes(r.kind) || m.id !== r.entryId || m.path !== r.path || m.kind !== (r.kind === 'mkdir' ? 'folder' : 'file') || step.mode !== (r.kind === 'mkdir' ? null : r.kind.endsWith('Binary') ? 'binary' : 'text') || r.expectedBody !== undefined || r.expectedEntryId !== undefined)
                            throw 0;
                    }
                    else {
                        if (step.mode !== null || !identity(m.expected))
                            throw 0;
                        if (r.expectedEntryId !== undefined && (m.id !== r.expectedEntryId || m.expected !== r.expectedRevision))
                            throw 0;
                        if (m.type === 'write') {
                            if (!['writeText', 'writeBinary'].includes(r.kind))
                                throw 0;
                        }
                        else if (m.type === 'move') {
                            if (r.kind !== 'trash' && r.kind !== 'move' || m.path !== (r.kind === 'trash' ? `.trash/${r.operationId}/${r.path}` : r.destination))
                                throw 0;
                        }
                        else if (m.type === 'delete') {
                            if (r.kind !== 'delete' || m.recursive !== r.force)
                                throw 0;
                        }
                        else
                            throw 0;
                    }
                }
                // Reject extra fields and invalid composites rather than replay arbitrary stored requests.
                const clean: Step = { operationId: step.operationId, mutation: m.type === 'create' ? { type: m.type, id: m.id, path: m.path, kind: m.kind } : m.type === 'move' ? { type: m.type, id: m.id, expected: m.expected, path: m.path } : m.type === 'write' ? { type: m.type, id: m.id, expected: m.expected } : { type: m.type, id: m.id, expected: m.expected, recursive: m.recursive }, mode: step.mode };
                if (JSON.stringify(clean) !== JSON.stringify(step))
                    throw 0;
                family(step, r);
            }
            if (state.status === 'requested' && (state.next === state.steps.length - 1 && state.outcome !== undefined || state.outcome?.status === 'rejected'))
                throw 0;
            if (state.status === 'committed' && (state.next !== state.steps.length - 1 || state.outcome?.status !== 'committed') || state.status === 'rejected' && state.outcome?.status !== 'rejected')
                throw 0;
            if (state.outcome)
                validateOutcome(state.outcome, state.steps[state.next].operationId);
            return state;
        }
        catch {
            throw failure('invalid_file_checkpoint');
        }
    }
    function validateOutcome(outcome: BrowserVaultOutcome, operationId: string): void {
        if (outcome.status === 'committed') {
            let receipt;
            try {
                receipt = JSON.parse(outcome.receipt);
            }
            catch {
                throw failure('invalid_file_receipt');
            }
            if (receipt.operation_id !== operationId || typeof receipt.sequence !== 'string' || !/^([1-9][0-9]{0,19})$/.test(receipt.sequence) || BigInt(receipt.sequence) > 18446744073709551615n)
                throw failure('invalid_file_receipt');
        }
        else if (outcome.status !== 'rejected' || !outcome.error || outcome.error.source !== 'rust' || typeof outcome.error.code !== 'string' || typeof outcome.error.message !== 'string')
            throw failure('invalid_file_receipt');
    }
    function exactRow(row: BrowserVaultIntent, step: Step, request: Request): void {
        if (row.client_id !== checkpoints.scope.clientId || row.intent_id !== step.operationId || row.operation_id !== step.operationId || !row.family_command_json)
            throw failure('intent_identity_mismatch');
        try {
            if (JSON.stringify(JSON.parse(row.family_command_json)) !== family(step, request) || JSON.stringify(JSON.parse(row.request_json)) !== JSON.stringify(JSON.parse(family(step, request)).request))
                throw 0;
        }
        catch {
            throw failure('intent_identity_mismatch');
        }
    }
    async function finish(head: Checkpoint, state: State): Promise<boolean> {
        let changed = state.next > 0;
        const prefixRows = await backend.intents();
        for (const step of state.steps.slice(0, state.next)) {
            const row = prefixRows.find(item => item.intent_id === step.operationId);
            if (!row) throw failure('intent_not_found');
            exactRow(row, step, state.request);
            if (row.status !== 'committed' || !row.acknowledged) throw failure('invalid_file_checkpoint');
            validateOutcome({status:'committed', receipt:row.receipt!}, step.operationId);
        }
        for (;;) {
            assertActive();
            const step = state.steps[state.next];
            let row = (await backend.intents()).find(item => item.intent_id === step.operationId);
            if (row)
                exactRow(row, step, state.request);
            if (!state.outcome) {
                if (!row) {
                    assertActive();
                    await backend.prepareFamily(step.operationId, family(step, state.request));
                    row = (await backend.intents()).find(item => item.intent_id === step.operationId);
                    if (!row)
                        throw failure('outcome_unknown');
                    exactRow(row, step, state.request);
                }
                if (row.status === 'prepared' || row.status === 'commit_requested') {
                    try {
                        assertActive();
                        await backend.commit(step.operationId);
                    }
                    catch (error) {
                        const settled = (await backend.intents()).find(item => item.intent_id === step.operationId);
                        if (!settled || !['committed', 'rejected'].includes(settled.status))
                            throw error;
                        row = settled;
                    }
                    row = (await backend.intents()).find(item => item.intent_id === step.operationId);
                    if (!row)
                        throw failure('outcome_unknown');
                    exactRow(row, step, state.request);
                }
                const outcome: BrowserVaultOutcome = row.status === 'committed' ? { status: 'committed', receipt: row.receipt! } : row.status === 'rejected' ? { status: 'rejected', error: row.error! } : (() => { throw failure('outcome_unknown'); })();
                validateOutcome(outcome, step.operationId);
                state = { ...state, outcome, status: outcome.status === 'rejected' ? 'rejected' : state.next === state.steps.length - 1 ? 'committed' : 'requested' };
                head = await persist(head, state);
            }
            if (!row)
                throw failure('intent_not_found');
            exactRow(row, step, state.request);
            const actual = row.status === 'committed' ? { status: 'committed', receipt: row.receipt } : row.status === 'rejected' ? { status: 'rejected', error: row.error } : null;
            if (JSON.stringify(actual) !== JSON.stringify(state.outcome))
                throw failure('intent_outcome_mismatch');
            const outcome = state.outcome;
            if (!outcome)
                throw failure('invalid_file_checkpoint');
            if (outcome.status === 'committed')
                changed = true;
            if (!row.acknowledged) {
                assertActive();
                await backend.acknowledge(step.operationId, outcome);
            }
            if (state.status === 'rejected')
                throw failure(outcome.status === 'rejected' ? outcome.error.code : 'file_operation_rejected');
            if (state.status === 'committed')
                return changed;
            state = { ...state, next: state.next + 1, outcome: undefined };
            head = await persist(head, state);
        }
    }
    return Object.freeze({
        execute(input: BrowserFileCommandInput): Promise<void> { let request: Request; try {
            request = capture(input);
        }
        catch (error) {
            return Promise.reject(error);
        } return serial(async () => { const key = prefix + request.operationId; let head = await checkpoints.load(key), state: State; if (head?.encodedState) {
            state = await decode(head);
            if (state.signature !== await signature(request))
                throw failure('idempotency_conflict');
        }
        else {
            if (head) throw failure('invalid_file_checkpoint');
            const steps = await plan(request);
            state = { version: 1, request, signature: await signature(request), planSignature:await signature(steps), steps, next: 0, status: 'requested' };
            for (const step of state.steps)
                family(step, request);
            head = await persist(head, state);
        } await finish(head!, state); }); },
        recover(): Promise<boolean> { return serial(async () => { let cursor: string | undefined, changed = false; for (let pageCount = 0; pageCount < 100; pageCount++) {
            const page = await checkpoints.list({ limit: 100, cursor });
            for (const item of page.items) {
                if (!item.key.startsWith(prefix))
                    continue;
                const head = await checkpoints.load(item.key);
                if (!head?.encodedState)
                    continue;
                const state = await decode(head);
                if (state.status !== 'requested') {
                    const row = (await backend.intents()).find(item => item.intent_id === state.steps[state.next].operationId);
                    if (row?.acknowledged) {
                        exactRow(row, state.steps[state.next], state.request);
                        const actual = row.status === 'committed' ? {status:'committed', receipt:row.receipt} : row.status === 'rejected' ? {status:'rejected', error:row.error} : null;
                        if (JSON.stringify(actual) !== JSON.stringify(state.outcome)) throw failure('intent_outcome_mismatch');
                        continue;
                    }
                }
                try {
                    changed = await finish(head, state) || changed;
                }
                catch (error) {
                    const latest = await checkpoints.load(item.key);
                    const settled = latest?.encodedState ? await decode(latest) : undefined;
                    const row = settled ? (await backend.intents()).find(value => value.intent_id === settled.steps[settled.next].operationId) : undefined;
                    if (settled?.status === 'rejected' && row?.acknowledged && error instanceof BrowserVaultError && settled.outcome?.status === 'rejected' && error.code === settled.outcome.error.code) {
                        changed = settled.next > 0 || changed;
                        continue;
                    }
                    throw error;
                }
            }
            if (page.cursor === null)
                return changed;
            cursor = page.cursor;
        } throw failure('file_recovery_limit'); }); },
    });
}
