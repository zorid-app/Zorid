#!/usr/bin/env node
// Actual standalone CLI processes only. This is deliberately outside the default
// unit-test glob; a coordinator supplies the matched executable and source receipt.
import assert from 'node:assert/strict';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse as parseYaml} from 'yaml';

const exec = promisify(execFile), repo = fileURLToPath(new URL('../../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const required = ['--cli', '--expected-cli-sha256', '--source-revision'];
const args = new Map();
for (let at = 2; at < process.argv.length; at += 2) {
  const key = process.argv[at], value = process.argv[at + 1];
  assert.ok([...required, '--out'].includes(key) && value && !args.has(key), `Invalid argument ${key}`);
  args.set(key, value);
}
for (const key of required) assert.ok(args.has(key), `${key} is required; see README.md`);
assert.match(args.get('--expected-cli-sha256'), /^[0-9a-f]{64}$/);
assert.match(args.get('--source-revision'), /^[0-9a-f]{40}$/);
const cli = await fs.realpath(args.get('--cli'));
const statArtifact = async () => {const s = await fs.stat(cli, {bigint: true});return [s.dev, s.ino, s.size, s.mtimeNs].map(String);};
const cliStat = await statArtifact();
assert.equal(hash(await fs.readFile(cli)), args.get('--expected-cli-sha256'), 'CLI differs from its build receipt');
assert.deepEqual(await statArtifact(), cliStat, 'CLI changed during initial artifact verification');
const git = async (...command) => (await exec('git', command, {cwd: repo, maxBuffer: 1024 * 1024})).stdout.trim();
const sourceRevision = args.get('--source-revision'), checkoutRevision = await git('rev-parse', 'HEAD');
const sourceInputs = {};
for (const input of ['crates', 'Cargo.toml', 'Cargo.lock']) {
  sourceInputs[input] = await git('rev-parse', `${sourceRevision}:${input}`);
  assert.equal(await git('rev-parse', `HEAD:${input}`), sourceInputs[input], `Checkout ${input} differs from the build source`);
}
await exec('git', ['diff', '--quiet', 'HEAD', '--', 'crates', 'Cargo.toml', 'Cargo.lock'], {cwd: repo});
assert.equal(await git('ls-files', '--others', '--exclude-standard', '--', 'crates'), '', 'Untracked Rust source is outside the build closure');

async function resolveDestination(input) {
  let ancestor = path.resolve(input);const suffix = [];
  for (;;) {
    try {return path.join(await fs.realpath(ancestor), ...suffix.reverse());}
    catch (error) {if (error.code !== 'ENOENT') throw error;const parent = path.dirname(ancestor);assert.notEqual(parent, ancestor);suffix.push(path.basename(ancestor));ancestor = parent;}
  }
}
const gitDirectory = await fs.realpath(path.resolve(repo, await git('rev-parse', '--git-common-dir')));
const worktrees = (await git('worktree', 'list', '--porcelain', '-z')).split('\0').filter(field => field.startsWith('worktree ')).map(field => field.slice(9));
const protectedRoots = [...new Set([await fs.realpath(repo), path.dirname(gitDirectory), path.dirname(cli), ...await Promise.all(worktrees.map(p => fs.realpath(p)))])];
function outsideProtected(destination) {
  for (const root of protectedRoots) {
    const relative = path.relative(root, destination);
    assert.ok(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), `Fixture parent is within source/artifact root ${root}`);
  }
}
const parent = await resolveDestination(args.get('--out') ?? os.tmpdir());
outsideProtected(parent);await fs.mkdir(parent, {recursive: true});
assert.equal(await fs.realpath(parent), parent, 'Fixture parent aliases changed');outsideProtected(await fs.realpath(parent));
const out = await fs.mkdtemp(path.join(parent, 'zorid-local-collections-cli-'));
const vault = path.join(out, 'vault'), data = path.join(out, 'app-data');
for (const directory of [vault, data, path.join(out, 'commands')]) await fs.mkdir(directory);
const scenarios = [
  'independent-collection-ownership', 'readable-projection-and-schema',
  'per-view-sources-and-hidden-member', 'revision-and-operation-retries',
  'identity-preserving-renames', 'collection-trash-and-collision-restore',
  'independent-process-reopen',
];
const evidence = {
  schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(),
  scope: 'Actual standalone CLI over disposable local collections; not UI, browser/WASM, sync, or interruption acceptance',
  source: {sourceRevision, checkoutRevision, inputs: sourceInputs, driver: {path: 'tests/local-collections-integration/run.mjs', sha256: hash(await fs.readFile(fileURLToPath(import.meta.url))) }},
  artifact: {path: cli, sha256: args.get('--expected-cli-sha256'), stat: cliStat, association: 'Caller-supplied exact build receipt; executable hash and Rust source closure verified here'},
  fixture: {vault, localData: data},
  commandPlan: {authored: 30, maximum: 42, timeoutMs: 25_000, totalTimeoutMs: 300_000, outputBytes: 16 * 1024 * 1024},
  scenarios: Object.fromEntries(scenarios.map(name => [name, {status: 'unexecuted'}])), commands: [], checks: [],
  excluded: ['UI/onboarding/focus', 'New filter-default synthesis', 'concurrent local clients', 'projection interruption/crash', 'external-edit reconciliation', 'browser/WASM/mobile', 'sync/encryption guarantees'],
};
const report = path.join(out, 'report.json');
const started = Date.now(), env = {...process.env, ZORID_LOCAL_DATA_DIR: data};
for (const key of ['DISPLAY', 'ZORID_IPC_ENDPOINT', 'ZORID_DESKTOP_ENDPOINT']) delete env[key];
let sequence = 0, activeScenario;
const saveReport = () => fs.writeFile(report, JSON.stringify(evidence, null, 2) + '\n');
function fixturePath(relative) {
  assert.equal(typeof relative, 'string');assert.ok(relative.length && !path.isAbsolute(relative) && !relative.includes('\\'));
  assert.ok(!relative.split('/').some(part => !part || part === '.' || part === '..'));
  const result = path.resolve(vault, relative);assert.ok(result.startsWith(vault + path.sep));return result;
}
function check(label, action) {action();evidence.checks.push({label, scenario: activeScenario, status: 'passed'});}
async function scenario(name, run) {
  activeScenario = name;evidence.scenarios[name] = {status: 'running'};await saveReport();
  try {await run();evidence.scenarios[name] = {status: 'passed'};}
  catch (error) {evidence.scenarios[name] = {status: 'failed', message: error.message};throw error;}
  finally {activeScenario = undefined;await saveReport();}
}
async function invoke(label, command, input = Buffer.alloc(0)) {
  assert.ok(Date.now() - started < evidence.commandPlan.totalTimeoutMs, 'Five-minute scenario budget exceeded');
  assert.ok(++sequence <= evidence.commandPlan.maximum, 'Authored command bound exceeded');
  assert.deepEqual(await statArtifact(), cliStat, 'CLI replaced after source/artifact freeze');
  const prefix = `${String(sequence).padStart(3, '0')}-${label.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80)}`;
  const before = Date.now();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(cli, ['--vault', vault, ...command], {env, stdio: ['pipe', 'pipe', 'pipe']});
    evidence.pendingChild = {pid: child.pid, label};
    const stdout = [], stderr = [];let bytes = 0, failure, forcedClose;
    const abort = message => {
      if (failure) return;failure = new Error(message);clearTimeout(timer);child.kill('SIGKILL');
      forcedClose = setTimeout(() => reject(new Error(`${message}; owned PID ${child.pid} close was not observed`)), 5000);
    };
    const timer = setTimeout(() => abort(`CLI timeout: ${label}`), evidence.commandPlan.timeoutMs);
    const collect = target => chunk => {bytes += chunk.length;if (bytes > evidence.commandPlan.outputBytes) abort(`CLI output limit: ${label}`);else target.push(chunk);};
    child.stdout.on('data', collect(stdout));child.stderr.on('data', collect(stderr));
    child.once('error', error => {failure ??= error;});
    child.once('close', (code, signal) => {clearTimeout(timer);clearTimeout(forcedClose);delete evidence.pendingChild;resolve({code, signal, pid: child.pid, failure, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr)});});
    child.stdin.on('error', () => {});child.stdin.end(input);
  });
  const stdout = path.join('commands', prefix + '.stdout'), stderr = path.join('commands', prefix + '.stderr');
  await fs.writeFile(path.join(out, stdout), result.stdout);await fs.writeFile(path.join(out, stderr), result.stderr);
  const stdin = input.length ? path.join('commands', prefix + '.stdin') : null;if (stdin) await fs.writeFile(path.join(out, stdin), input);
  evidence.commands.push({label, scenario: activeScenario, argv: ['--vault', vault, ...command], pid: result.pid, exit: result.code, signal: result.signal,
    closeObserved: true, elapsedMs: Date.now() - before, inputBytes: input.length, inputSha256: hash(input), stdin,
    stdout, stdoutSha256: hash(result.stdout), stderr, stderrSha256: hash(result.stderr)});
  await saveReport();if (result.failure) throw result.failure;return result;
}
async function ok(label, command, input, raw = false) {
  const result = await invoke(label, command, input);
  assert.equal(result.code, 0, `${label}: ${result.stderr.toString('utf8')}`);assert.equal(result.signal, null);assert.equal(result.stderr.length, 0, label);
  if (raw) return result.stdout;
  const value = JSON.parse(result.stdout);assert.equal(value.version, 1);assert.equal(value.ok, true);return value.result;
}
async function rejects(label, command, input, expectedCode, expectedExit) {
  const result = await invoke(label, command, input);
  assert.equal(result.code, expectedExit, label);assert.equal(result.signal, null);assert.equal(result.stdout.length, 0, label);
  const value = JSON.parse(result.stderr);assert.equal(value.version, 1);assert.equal(value.ok, false);assert.equal(value.error.code, expectedCode, label);
}
const encoded = command => Buffer.from(JSON.stringify({schemaVersion: 1, command}));
const dbArgs = ['database', 'request', '--input', '-'];
async function db(label, command) {
  const value = await ok(label, dbArgs, encoded(command));
  assert.ok(Array.isArray(value.collections) && Array.isArray(value.entries));
  assert.deepEqual(value.projection, {pending: 0, issues: []}, `${label}: durable state is not equivalent to completed readable publication`);
  assert.ok(value.entries.every(entry => entry.pendingProjection === false));return value;
}
const collection = (reply, id) => {const found = reply.collections.find(item => id ? item.id === id : true);assert.ok(found);return found;};
const entry = (reply, id) => {const found = reply.entries.find(item => item.entryId === id);assert.ok(found, `Missing ${id}`);return found;};
const property = (type, name) => {const found = type.properties.find(item => item.name === name);assert.ok(found, `Missing property ${name}`);return found;};
const option = (field, name) => {const found = field.options.find(item => item.name === name);assert.ok(found);return found;};
const sameIds = (actual, expected) => assert.deepEqual([...actual].sort(), [...expected].sort());
const schemaId = value => assert.match(value, /^[0-9a-z]{12}$/);
async function note(relative) {
  const raw = await fs.readFile(fixturePath(relative), 'utf8');assert.ok(raw.startsWith('---\n'));
  const close = raw.indexOf('\n---\n', 4);assert.ok(close >= 0, `No generated frontmatter close in ${relative}`);
  return {raw, properties: parseYaml(raw.slice(4, close)), body: raw.slice(close + 5)};
}
async function schema(name) {return parseYaml(await fs.readFile(fixturePath(`.zorid/types/${name}.yaml`), 'utf8'));}
async function absent(relative) {await assert.rejects(fs.stat(fixturePath(relative)), error => error.code === 'ENOENT');}
async function createFile(label, relative, id, source) {
  const value = await ok(label, ['create', relative, '--id', id, '--operation-id', `op-${id}`, '--input', '-'], Buffer.from(source));
  assert.equal(value.durable_local_commit, true);assert.equal(value.synced, false);return value;
}
async function build(label) {
  const value = await ok(label, ['document-index', 'build']);assert.equal(value.buildComplete, true);assert.equal(value.complete, true);return value.snapshot;
}
async function query(label, name, expectedIds, snapshot) {
  const value = await ok(label, ['base-query', '--id', 'collection-views', '--view', name, '--clock-ms', '1793102400000', '--timezone', 'UTC']);
  assert.equal(value.complete, true);assert.equal(value.coverageComplete, true);assert.equal(value.scanComplete, true);assert.equal(value.truncated, false);assert.equal(value.synced, false);
  assert.deepEqual(value.snapshot, snapshot);sameIds(value.value.result.rows.map(row => row.entryId), expectedIds);return value.value.result;
}

// A readable label alone cannot grant hidden collection membership.
const ordinary = '---\n_type: Books\nRating: 99\ntags: [idea]\n---\n# Loose note\n\nNot a collection member.\n';
const registry = '# An ordinary legacy filename; it must not configure collections.\nproperties:\n  Rating: {type: text}\n';
const firstBody = '# The Left Hand of Darkness\n\nExact body: α and 雪.\n';
const firstInput = '---\n# Keep this unmanaged comment.\nsource: library\n---\n' + firstBody;
const hiddenBody = '# Hidden book\n\nOutside the Rating filter, but still owned.\n';
const projectBody = '# Project\n\nIndependent collection.\n';
const ids = {first: 'book-alpha', hidden: 'book-hidden', project: 'project-one', duplicate: 'book-copy', ordinary: 'loose-note', occupant: 'restore-occupant'};
const paths = {first: 'Book α.md', hidden: 'Hidden book.md', project: 'Project.md', duplicate: 'Book copy.md', ordinary: 'Loose.md'};
let books, projects, first, hidden, projectEntry, fields, projectSource, baseSource, beforeSet;
try {
  await saveReport();
  await scenario('independent-collection-ownership', async () => {
    const initialized = await ok('initialize-local', ['init']);assert.equal(initialized.initialized, true);assert.equal(initialized.sync_available, false);
    await createFile('ordinary-note', paths.ordinary, ids.ordinary, ordinary);
    await createFile('ordinary-legacy-registry', 'Properties.yaml', 'legacy-properties', registry);
    const b = await db('create-books', {op: 'create', operationId: 'create-books', name: 'Books', properties: [
      {name: 'Author', datatype: 'text'}, {name: 'Rating', datatype: 'number'},
      {name: 'Status', datatype: 'status', options: [{name: 'Unread', category: 'not_started'}, {name: 'Finished', category: 'done'}]},
    ]});books = collection(b);
    const p = await db('create-projects', {op: 'create', operationId: 'create-projects', name: 'Projects', properties: [{name: 'Rating', datatype: 'number'}]});projects = collection(p);
    fields = {author: property(books, 'Author'), rating: property(books, 'Rating'), status: property(books, 'Status')};
    check('same-name fields remain distinct collection identities', () => {schemaId(books.id);schemaId(projects.id);assert.notEqual(books.id, projects.id);assert.notEqual(fields.rating.id, property(projects, 'Rating').id);for (const f of books.properties) {schemaId(f.id);for (const o of f.options) schemaId(o.id);}});
    first = entry(await db('create-visible-book', {op: 'create_entry', operationId: 'create-book-alpha', collectionId: books.id, expectedCollectionRevision: books.revision, entryId: ids.first, path: paths.first, body: firstInput,
      values: {[fields.author.id]: 'Ursula K. Le Guin', [fields.rating.id]: 5, [fields.status.id]: option(fields.status, 'Unread').id}}), ids.first);
    hidden = entry(await db('create-hidden-book', {op: 'create_entry', operationId: 'create-book-hidden', collectionId: books.id, expectedCollectionRevision: books.revision, entryId: ids.hidden, path: paths.hidden, body: hiddenBody,
      values: {[fields.rating.id]: 1, [fields.status.id]: option(fields.status, 'Finished').id}}), ids.hidden);
    projectEntry = entry(await db('create-project-entry', {op: 'create_entry', operationId: 'create-project-one', collectionId: projects.id, expectedCollectionRevision: projects.revision, entryId: ids.project, path: paths.project, body: projectBody,
      values: {[property(projects, 'Rating').id]: 2}}), ids.project);
    await rejects('ordinary-note-is-not-member', dbArgs, encoded({op: 'get_entry', entryId: ids.ordinary}), 'invalid_mutation', 2);
    await rejects('existing-note-is-not-importable', dbArgs, encoded({op: 'create_entry', operationId: 'forbidden-import', collectionId: books.id, expectedCollectionRevision: books.revision, entryId: ids.ordinary, path: paths.ordinary}), 'invalid_mutation', 2);
    check('collection membership comes from creation only', () => {assert.equal(first.collectionId, books.id);assert.equal(hidden.collectionId, books.id);assert.equal(projectEntry.collectionId, projects.id);});
  });
  await scenario('readable-projection-and-schema', async () => {
    const n = await note(paths.first), s = await schema('Books');
    check('readable frontmatter and exact body preserve unmanaged data', () => {assert.equal(n.properties._id, ids.first);assert.equal(n.properties._type, 'Books');assert.equal(n.properties.Author, 'Ursula K. Le Guin');assert.equal(n.properties.Rating, 5);assert.equal(n.properties.Status, 'Unread');assert.equal(n.properties.source, 'library');assert.ok(n.raw.includes('# Keep this unmanaged comment.'));assert.equal(n.body, firstBody);assert.ok(!Object.hasOwn(n.properties, fields.status.id));});
    check('readable type YAML retains stable schema identity', () => {assert.equal(s.id, books.id);assert.equal(s.name, 'Books');assert.equal(s.properties.find(p => p.id === fields.status.id).options.find(o => o.id === option(fields.status, 'Unread').id).name, 'Unread');});
    assert.deepEqual(await ok('read-visible-note-through-cli', ['read', '--id', ids.first, '--raw'], undefined, true), Buffer.from(n.raw));
    projectSource = await fs.readFile(fixturePath(paths.project), 'utf8');
    assert.equal(await fs.readFile(fixturePath('Properties.yaml'), 'utf8'), registry);
  });
  await scenario('per-view-sources-and-hidden-member', async () => {
    baseSource = `views:\n  - type: table\n    name: Rated books\n    source: {kind: collection, id: ${books.id}}\n    filters: note[${JSON.stringify(fields.rating.id)}] >= 4\n    order: [file.name, note.${fields.rating.id}]\n  - type: table\n    name: Projects\n    source: {kind: collection, id: ${projects.id}}\n    order: [file.name]\n  - type: list\n    name: Loose notes\n    source: {kind: untyped}\n    order: [file.name]\n`;
    await createFile('create-independent-views', 'Collections.base', 'collection-views', baseSource);
    const snapshot = await build('publish-collection-query-snapshot');
    await query('query-visible-book-not-hidden-member', 'Rated books', [ids.first], snapshot);
    await query('query-only-project-collection', 'Projects', [ids.project], snapshot);
    const untyped = await query('query-only-untyped-note', 'Loose notes', [ids.ordinary], snapshot);
    check('untyped results expose no user-property grid', () => {assert.ok(untyped.properties.every(p => p.startsWith('file.')));assert.ok(untyped.rows.every(row => Object.keys(row.values).every(p => p.startsWith('file.'))));});
  });
  await scenario('revision-and-operation-retries', async () => {
    beforeSet = structuredClone(first);
    const command = {op: 'set_entry', operationId: 'set-book-rating', entryId: ids.first, expectedRevision: first.revision, expectedCollectionRevision: books.revision, values: {[fields.rating.id]: 4}};
    first = entry(await db('set-rating', command), ids.first);
    const replay = entry(await db('replay-exact-rating-operation', command), ids.first);
    check('exact retry does not author another entry revision', () => {assert.equal(first.revision, replay.revision);assert.equal(replay.values[fields.rating.id], 4);});
    const saved = await fs.readFile(fixturePath(paths.first));
    await rejects('stale-entry-write-rejected', dbArgs, encoded({...command, operationId: 'stale-rating-write', values: {[fields.rating.id]: 2}}), 'invalid_mutation', 2);
    await rejects('operation-reuse-different-input-rejected', dbArgs, encoded({...command, values: {[fields.rating.id]: 3}}), 'idempotency_conflict', 3);
    assert.deepEqual(await fs.readFile(fixturePath(paths.first)), saved);
    check('failed writes preserve file and current property values', () => assert.notEqual(first.revision, beforeSet.revision));
  });
  await scenario('identity-preserving-renames', async () => {
    const properties = structuredClone(books.properties);
    properties.find(p => p.id === fields.status.id).name = 'Progress';
    properties.find(p => p.id === fields.status.id).options.find(o => o.id === option(fields.status, 'Unread').id).name = 'Reading';
    const renamed = await db('rename-collection-field-option', {op: 'update', operationId: 'rename-books', collectionId: books.id, expectedRevision: books.revision, name: 'Reading library', properties});
    const originalId = books.id;books = collection(renamed, books.id);first = entry(renamed, ids.first);hidden = entry(renamed, ids.hidden);
    const n = await note(paths.first), s = await schema('Reading library');
    check('schema and option renames retain identity and readable values', () => {assert.equal(books.id, originalId);assert.equal(property(books, 'Progress').id, fields.status.id);assert.equal(option(property(books, 'Progress'), 'Reading').id, option(fields.status, 'Unread').id);assert.equal(first.values[fields.status.id], option(fields.status, 'Unread').id);assert.equal(n.properties._id, ids.first);assert.equal(n.properties._type, 'Reading library');assert.equal(n.properties.Progress, 'Reading');assert.ok(!Object.hasOwn(n.properties, 'Status'));assert.equal(n.body, firstBody);assert.equal(s.id, originalId);});
    await absent('.zorid/types/Books.yaml');
    assert.equal(await fs.readFile(fixturePath(paths.project), 'utf8'), projectSource);
    const copy = entry(await db('duplicate-in-same-collection', {op: 'duplicate_entry', operationId: 'duplicate-book', entryId: ids.first, expectedRevision: first.revision, newEntryId: ids.duplicate, path: paths.duplicate}), ids.duplicate);
    const duplicate = await note(paths.duplicate);
    check('duplicate gets a fresh note identity in its original collection', () => {assert.equal(copy.entryId, ids.duplicate);assert.equal(copy.collectionId, books.id);assert.equal(duplicate.properties._id, ids.duplicate);assert.equal(duplicate.body, firstBody);assert.deepEqual(copy.values, first.values);});
  });
  await scenario('collection-trash-and-collision-restore', async () => {
    const trashed = await db('trash-collection-including-hidden-member', {op: 'delete', operationId: 'delete-books', collectionId: books.id, expectedRevision: books.revision});
    books = collection(trashed, books.id);
    check('delete includes every member irrespective of the saved view filter', () => {assert.equal(books.deleted, true);sameIds(trashed.entries.map(e => e.entryId), [ids.first, ids.hidden, ids.duplicate]);for (const e of trashed.entries) {assert.equal(e.deleted, true);assert.ok(e.path.startsWith('.trash/'));}});
    for (const file of [paths.first, paths.hidden, paths.duplicate, '.zorid/types/Reading library.yaml']) await absent(file);
    assert.equal(await fs.readFile(fixturePath(paths.project), 'utf8'), projectSource);
    const occupant = '# Occupant created after deletion\n\nKeep every byte.\n';
    await createFile('create-restore-path-occupant', paths.first, ids.occupant, occupant);
    const restored = await db('restore-collection-with-path-collision', {op: 'restore', operationId: 'restore-books', collectionId: books.id, expectedRevision: books.revision});
    books = collection(restored, books.id);first = entry(restored, ids.first);hidden = entry(restored, ids.hidden);
    const restoredNote = await note(first.path);
    check('restore keeps identities and preserves occupying note', () => {assert.equal(books.deleted, false);sameIds(restored.entries.map(e => e.entryId), [ids.first, ids.hidden, ids.duplicate]);assert.ok(restored.entries.every(e => e.deleted === false && !e.path.startsWith('.')));assert.notEqual(first.path, paths.first);assert.equal(hidden.path, paths.hidden);assert.equal(restoredNote.properties._id, ids.first);assert.equal(restoredNote.body, firstBody);});
    assert.equal(await fs.readFile(fixturePath(paths.first), 'utf8'), occupant);
    assert.equal((await schema('Reading library')).id, books.id);
  });
  await scenario('independent-process-reopen', async () => {
    const finalBooks = await db('reopen-restored-collection', {op: 'get', collectionId: books.id});
    const finalProjects = await db('reopen-independent-projects', {op: 'get', collectionId: projects.id});
    const all = await db('reopen-list-collections', {op: 'list'});
    check('all logical state survives fresh CLI processes', () => {sameIds(all.collections.map(c => c.id), [books.id, projects.id]);assert.equal(collection(finalBooks, books.id).revision, books.revision);sameIds(finalBooks.entries.map(e => e.entryId), [ids.first, ids.hidden, ids.duplicate]);sameIds(finalProjects.entries.map(e => e.entryId), [ids.project]);});
    assert.equal(await fs.readFile(fixturePath('Properties.yaml'), 'utf8'), registry);
    assert.equal(await fs.readFile(fixturePath(paths.ordinary), 'utf8'), ordinary);
    assert.equal(await fs.readFile(fixturePath('Collections.base'), 'utf8'), baseSource);
    const status = await ok('final-local-status', ['status']);assert.equal(status.pending_projection, 0);assert.equal(status.pending_outbox, 0);assert.equal(status.sync_available, false);
    const list = await ok('final-file-identities', ['list']);
    const states = list.entries.map(e => e.state ?? e);
    check('restore occupant stays ordinary and owned entries retain identity', () => {assert.equal(states.find(e => e.id === ids.occupant)?.path, paths.first);assert.equal(states.find(e => e.id === ids.first)?.path, first.path);});
  });
  assert.equal(evidence.commands.length, evidence.commandPlan.authored, 'Executed command count differs from the authored plan');
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';evidence.failure = {name: error.name, message: error.message, stack: error.stack};process.exitCode = 1;
} finally {
  evidence.finishedAt = new Date().toISOString();evidence.elapsedMs = Date.now() - started;
  try {
    assert.deepEqual(await statArtifact(), cliStat);assert.equal(hash(await fs.readFile(cli)), args.get('--expected-cli-sha256'));
    for (const [input, expected] of Object.entries(sourceInputs)) assert.equal(await git('rev-parse', `HEAD:${input}`), expected, `${input} changed during the scenario`);
    await exec('git', ['diff', '--quiet', 'HEAD', '--', 'crates', 'Cargo.toml', 'Cargo.lock'], {cwd: repo});
    assert.equal(await git('ls-files', '--others', '--exclude-standard', '--', 'crates'), '');
    assert.equal(hash(await fs.readFile(fileURLToPath(import.meta.url))), evidence.source.driver.sha256, 'Driver changed during execution');
    assert.equal(evidence.pendingChild, undefined, 'An owned CLI child exit remains unobserved');evidence.finalFreeze = {status: 'passed'};
  }
  catch (error) {evidence.finalFreeze = {status: 'failed', message: error.message};evidence.status = 'failed';process.exitCode = 1;}
  await saveReport();console.log(JSON.stringify({status: evidence.status, report, commands: evidence.commands.length, passedChecks: evidence.checks.length, scenarios: evidence.scenarios}, null, 2));
}
