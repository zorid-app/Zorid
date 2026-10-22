#!/usr/bin/env node
// Explicit actual-binary scenario, outside the default unit-test glob.
// Spawns the standalone CLI only: no Electron, host process, IPC or evaluator.
import assert from 'node:assert/strict';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {clockMs, folders, files, library, editedLibrary, editedCedar, expected, viewTypes} from './fixtures.mjs';
import {q3CommandCount, runQ3Campaign} from './q3-oracles.mjs';

const exec = promisify(execFile), repo = fileURLToPath(new URL('../../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const args = new Map();
for (let at = 2; at < process.argv.length; at += 2) {
  const key = process.argv[at], value = process.argv[at + 1];
  assert.ok(['--cli', '--expected-cli-sha256', '--source-revision', '--out', '--host', '--expected-host-sha256'].includes(key) && value && !args.has(key), `Invalid argument ${key}`);
  args.set(key, value);
}
for (const key of ['--cli', '--expected-cli-sha256', '--source-revision']) assert.ok(args.has(key), `${key} is required; see README.md`);
assert.match(args.get('--expected-cli-sha256'), /^[0-9a-f]{64}$/);
assert.match(args.get('--source-revision'), /^[0-9a-f]{40}$/);
assert.equal(args.has('--host'), args.has('--expected-host-sha256'), 'Host artifact and its expected hash must be provided together');
const cli = await fs.realpath(args.get('--cli'));
assert.ok(path.isAbsolute(cli));
const artifactStat = async () => {const stat = await fs.stat(cli, {bigint: true});return [stat.dev, stat.ino, stat.size, stat.mtimeNs].map(String);};
const cliStat = await artifactStat();
assert.equal(hash(await fs.readFile(cli)), args.get('--expected-cli-sha256'), 'CLI does not match the final build receipt');
assert.deepEqual(await artifactStat(), cliStat, 'CLI changed while checking its build receipt');
const git = async (...input) => (await exec('git', input, {cwd: repo, maxBuffer: 1024 * 1024})).stdout.trim();
const sourceRevision = args.get('--source-revision'), checkoutRevision = await git('rev-parse', 'HEAD');
const sourceInputs = {};
for (const input of ['crates', 'Cargo.toml', 'Cargo.lock']) {
  const selected = await git('rev-parse', `${sourceRevision}:${input}`);
  assert.equal(await git('rev-parse', `HEAD:${input}`), selected, `Checkout ${input} differs from the supplied build source`);
  sourceInputs[input] = selected;
}
await exec('git', ['diff', '--quiet', 'HEAD', '--', 'crates', 'Cargo.toml', 'Cargo.lock'], {cwd: repo});
assert.equal(await git('ls-files', '--others', '--exclude-standard', '--', 'crates'), '', 'Untracked Rust source is outside the claimed build closure');

// Resolve aliases before creating anything, including a nonexistent suffix below
// an existing symlink. Fixtures must remain outside source and build artifacts.
async function resolvedDestination(destination) {
  let ancestor = path.resolve(destination);const suffix = [];
  for (;;) {
    try {return path.join(await fs.realpath(ancestor), ...suffix.reverse());}
    catch (error) {if (error.code !== 'ENOENT') throw error;const next = path.dirname(ancestor);assert.notEqual(next, ancestor);suffix.push(path.basename(ancestor));ancestor = next;}
  }
}
const hostPath = args.has('--host') ? await fs.realpath(args.get('--host')) : null;
const commonGitDirectory = await fs.realpath(path.resolve(repo, await git('rev-parse', '--git-common-dir')));
const canonicalSourceRoot = path.dirname(commonGitDirectory);
const registeredWorktrees = (await git('worktree', 'list', '--porcelain', '-z')).split('\0').filter(field => field.startsWith('worktree ')).map(field => field.slice('worktree '.length));
const protectedRoots = [...new Set([await fs.realpath(repo), canonicalSourceRoot, ...await Promise.all(registeredWorktrees.map(root => fs.realpath(root))), path.dirname(cli), ...(hostPath ? [path.dirname(hostPath)] : [])])];
function assertFixtureParent(destination) {
  for (const root of protectedRoots) {const relative = path.relative(root, destination);assert.ok(relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative), `Fixture output must be outside protected source/artifact root: ${root}`);}
}
const parent = await resolvedDestination(args.has('--out') ? args.get('--out') : os.tmpdir());
assertFixtureParent(parent);await fs.mkdir(parent, {recursive: true});
assert.equal(await fs.realpath(parent), parent, 'Output parent aliases changed during admission');assertFixtureParent(await fs.realpath(parent));
const out = await fs.mkdtemp(path.join(parent, 'zorid-bases-cli-'));
const vault = path.join(out, 'vault'), localData = path.join(out, 'app-data');
for (const directory of [vault, localData, path.join(out, 'commands'), path.join(out, 'exports'), path.join(out, 'inputs')]) await fs.mkdir(directory);
const reportPath = path.join(out, 'report.json');
const evidence = {
  schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(),
  scope: 'Actual standalone CLI over disposable ordinary files; not UI or browser/WASM acceptance',
  source: {sourceRevision, checkoutRevision, inputs: sourceInputs},
  artifact: {path: cli, sha256: args.get('--expected-cli-sha256'), stat: cliStat, association: 'Expected artifact hash and source revision are supplied from the final build receipt; verified here, not inferred from executable version text'},
  oracle: {clockMs, phases: expected, views: viewTypes, readingList: {entryIds: ['atlas', 'delta'], ratingSum: 7}, missingPropertiesNote: 'empty'},
  fixture: {vault, localData, files: []}, commands: [], checks: [], exports: [],
  unsupportedCliSurface: ['No Base-specific cell-edit command; edits use existing revision-guarded full-file write', 'No CSV/TSV/Markdown table export command; existing JSON query and exact raw-source outputs are covered'],
};
const oracleSources=['run.mjs', 'fixtures.mjs', 'q3-oracles.mjs', '../fixtures/bases-q3-semantics.mjs'];
for (const name of oracleSources) evidence.source[name] = hash(await fs.readFile(new URL(name, import.meta.url)));
if (args.has('--host')) {
  const host = hostPath, sha256 = hash(await fs.readFile(host));
  assert.equal(sha256, args.get('--expected-host-sha256'));
  evidence.comparisonHostArtifact = {path: host, sha256, executed: false};
}
const started = Date.now(), env = {...process.env, ZORID_LOCAL_DATA_DIR: localData};
for (const key of ['DISPLAY', 'ZORID_IPC_ENDPOINT', 'ZORID_DESKTOP_ENDPOINT']) delete env[key];
const states = new Map(), sources = new Map(files.map(file => [file.id, {...file}]));
let sequence = 0;
// The original campaign is 85 commands. Q3 adds one create and exact raw export
// per file, one mkdir per folder, one build and one saved query per group.
const commandLimit = 128, plannedCommands = 85 + q3CommandCount;
assert.ok(plannedCommands <= commandLimit, 'Authored Q3 command plan exceeds the bounded campaign');
evidence.commandPlan = {original: 85, q3: q3CommandCount, total: plannedCommands, limit: commandLimit};

async function invoke(label, command, input = Buffer.alloc(0)) {
  assert.ok(Date.now() - started < 5 * 60_000, 'Bounded CLI scenario exceeded five minutes');
  assert.ok(++sequence <= commandLimit, 'Scenario command bound exceeded');
  assert.deepEqual(await artifactStat(), cliStat, 'CLI was replaced after the artifact freeze');
  const prefix = `${String(sequence).padStart(3, '0')}-${label.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 75)}`;
  const stdoutPath = path.join(out, 'commands', `${prefix}.stdout`), stderrPath = path.join(out, 'commands', `${prefix}.stderr`);
  const before = Date.now();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(cli, ['--vault', vault, ...command], {env, stdio: ['pipe', 'pipe', 'pipe']});
    const stdout = [], stderr = [];let bytes = 0, failure = null, closeTimer;
    const abort = message => {
      if (failure) return;failure = new Error(message);clearTimeout(timer);child.kill('SIGKILL');
      // Never report a successful cleanup from merely requesting a signal.
      closeTimer = setTimeout(() => reject(new Error(`${message}; owned child ${child.pid} close was not observed within five seconds`)), 5_000);
    };
    const timer = setTimeout(() => abort(`Owned CLI process timed out: ${label}`), 25_000);
    const collect = target => chunk => {bytes += chunk.length;if (bytes > 12 * 1024 * 1024) abort(`CLI output exceeded bound: ${label}`);else target.push(chunk);};
    child.stdout.on('data', collect(stdout));child.stderr.on('data', collect(stderr));
    child.once('error', error => {failure ??= error;});
    child.once('close', (code, signal) => {clearTimeout(timer);clearTimeout(closeTimer);resolve({code, signal, pid: child.pid, failure, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr)});});
    child.stdin.on('error', () => {});child.stdin.end(input);
  });
  await fs.writeFile(stdoutPath, result.stdout);await fs.writeFile(stderrPath, result.stderr);
  const stdinPath = input.length ? path.join(out, 'commands', `${prefix}.stdin`) : null;if (stdinPath) await fs.writeFile(stdinPath, input);
  evidence.commands.push({label, argv: ['--vault', vault, ...command], pid: result.pid, exit: result.code, signal: result.signal, elapsedMs: Date.now() - before,
    inputBytes: input.length, inputSha256: hash(input), stdin: stdinPath && path.relative(out, stdinPath), stdout: path.relative(out, stdoutPath), stdoutSha256: hash(result.stdout), stderr: path.relative(out, stderrPath), stderrSha256: hash(result.stderr)});
  if (result.failure) throw result.failure;
  return {...result, stdoutPath};
}
async function ok(label, command, input, raw = false) {
  const result = await invoke(label, command, input);
  assert.equal(result.code, 0, `${label}: ${result.stderr.toString('utf8')}`);assert.equal(result.signal, null);assert.equal(result.stderr.length, 0, label);
  if (raw) return result;
  const decoded = JSON.parse(result.stdout.toString('utf8'));assert.equal(decoded.version, 1);assert.equal(decoded.ok, true);
  return {...result, value: decoded.result};
}
async function fails(label, command, code, exit, input) {
  const result = await invoke(label, command, input);assert.equal(result.code, exit, label);assert.equal(result.stdout.length, 0);
  const decoded = JSON.parse(result.stderr.toString('utf8'));assert.equal(decoded.version, 1);assert.equal(decoded.ok, false);assert.equal(decoded.error.code, code, label);
}
function mutation(result, id) {
  assert.equal(result.durable_local_commit, true);assert.equal(result.synced, false);
  const entry = result.commit.changes.find(change => change.after?.id === id)?.after;assert.ok(entry, `Missing ${id} mutation receipt`);states.set(id, entry);return result.commit;
}
async function exactFile(id, label) {
  const expectedFile = sources.get(id), actual = await ok(label, ['read', '--id', id, '--raw'], undefined, true);
  assert.deepEqual(actual.stdout, Buffer.from(expectedFile.source));assert.deepEqual(await fs.readFile(path.join(vault, expectedFile.path)), actual.stdout);
  return actual;
}
async function build(label) {
  const {value} = await ok(label, ['document-index', 'build']);assert.equal(value.buildComplete, true);assert.equal(value.complete, true);assert.equal(value.synced, false);return value.snapshot;
}
const n = (value, message) => {assert.equal(value?.type, 'number', message);assert.ok(Number.isFinite(value.value), message);return value.value;};
const s = (value, message) => {assert.equal(value?.type, 'string', message);return value.value;};
const ids = rows => rows.map(row => row.entryId);
const sameIds = (actual, expectedIds, label) => assert.deepEqual([...actual].sort(), [...expectedIds].sort(), label);
function near(actual, target, label) {assert.ok(Math.abs(actual - target) < 1e-9, `${label}: ${actual} != ${target}`);}
async function query(id, view, label, expectedSnapshot, context = {clockMs, timezone: 'UTC'}) {
  const {value, stdoutPath} = await ok(label, ['base-query', '--id', id, ...(view ? ['--view', view] : []), '--clock-ms', String(context.clockMs), '--timezone', context.timezone]);
  assert.equal(value.operation, 'base_query');assert.equal(value.consistency, 'indexed_committed_snapshot');assert.equal(value.complete, true);assert.equal(value.coverageComplete, true);assert.equal(value.scanComplete, true);assert.equal(value.truncated, false);assert.equal(value.synced, false);
  assert.equal(value.clockMs, context.clockMs);assert.equal(value.timezone, context.timezone);assert.equal(value.selectedView, view ?? null);assert.equal(value.value.definition.id, id);
  assert.deepEqual(value.snapshot, expectedSnapshot);assert.deepEqual(value.value.result.snapshotId, value.snapshot);assert.equal(value.value.result.metadataComplete, true);
  assert.deepEqual(value.value.result.propertyDefinitionDiagnostics ?? [], []);
  const exportPath = path.join(out, 'exports', `${label}.json`);await fs.copyFile(stdoutPath, exportPath);
  assert.deepEqual(JSON.parse(await fs.readFile(exportPath, 'utf8')).result, value);
  evidence.exports.push({kind: 'base-query JSON stdout', file: path.relative(out, exportPath), sha256: hash(await fs.readFile(exportPath))});
  return value;
}
function assertGroups(result, oracle) {
  const groups = new Map(result.groups.map(group => [group.key?.type === 'null' ? 'missing' : s(group.key), group]));
  sameIds([...groups.keys()], Object.keys(oracle.groups), 'Group membership');
  for (const [key, entries] of Object.entries(oracle.groups)) {
    const group = groups.get(key);sameIds(group.entryIds, entries, key);
    if (key === 'missing') assert.equal(group.summaries['note.rating'].type, 'null');
    else assert.equal(n(group.summaries['note.rating']), entries.reduce((sum, id) => sum + oracle.rating[id], 0));
  }
}
async function phase(name, oracle, snapshot, renamed = false) {
  const all = (await query('library', 'All books', `${name}-table`, snapshot)).value.result;
  assert.equal(all.view.type, 'table');sameIds(ids(all.rows), ['atlas', 'birch', 'cedar', 'delta', 'empty']);assert.equal(all.counts.returned, 5);
  assert.equal(n(all.summaries['note.rating']), oracle.total);assert.equal(n(all.summaries['formula.scaledRating']), oracle.scaledTotal);assertGroups(all, oracle);
  sameIds(all.relationTargets.author.map(target => target.entryId), ['ada', 'grace'], 'Rust relation candidate filter');
  const byId = new Map(all.rows.map(row => [row.entryId, row]));
  for (const [id, rating] of Object.entries(oracle.rating)) {
    const row = byId.get(id);assert.equal(row.revision, states.get(id).revision);assert.equal(n(row.values['note.rating']), rating);assert.equal(n(row.values['formula.scaledRating']), rating * oracle.scale);
    assert.equal(s(row.values['formula.authorKind']), 'author');assert.equal(s(row.values['formula.publishedYear']), '2026');
    const author = id === 'delta' || id === 'cedar' && name === 'initial' ? 'grace' : 'ada';
    assert.equal(row.values['note.author'].type, 'link');assert.equal(row.values['note.author'].target.entryId, author);assert.equal(n(row.values['formula.authorBookCount']), oracle.authors[author].count);
  }
  const atlas = byId.get('atlas');assert.equal(atlas.path, 'Books/Atlas 😀.md');assert.equal(atlas.values['note.published'].type, 'date');assert.equal(atlas.values['note.published'].timestamp, Date.UTC(2026, 9, 1));assert.equal(atlas.values['note.published'].hasTime, false);assert.equal(s(atlas.values['note.code']), '2026-10-01');
  assert.deepEqual(atlas.editValues['note.published'], {type: 'string', value: '2026-10-01'});assert.deepEqual(atlas.editValues['note.author'], {type: 'string', value: '[[Authors/Ada]]'});
  assert.deepEqual(atlas.values['note.topics'], {type: 'list', value: [{type: 'string', value: 'Rust'}, {type: 'string', value: 'Design'}]});
  assert.equal(s(atlas.values['note.priority']), 'Low');assert.deepEqual(atlas.values['note.done'], {type: 'boolean', value: false});assert.deepEqual(byId.get('birch').values['note.done'], {type: 'boolean', value: true});
  if (name !== 'initial') assert.deepEqual(byId.get('cedar').values['note.topics'], {type: 'list', value: [{type: 'string', value: 'Rust'}, {type: 'string', value: 'Design'}]});
  for (const property of ['note.rating', 'note.status', 'note.author']) assert.equal(byId.get('empty').values[property].type, 'null');
  if (renamed) assert.equal(byId.get('birch').path, 'Books/Birch renamed.md');
  const top = (await query('library', 'Top rated', `${name}-cards`, snapshot)).value.result;assert.equal(top.view.type, viewTypes['Top rated']);assert.deepEqual(ids(top.rows), oracle.top);assert.equal(n(top.summaries['note.rating']), oracle.topTotal);assert.equal(top.counts.matched, 3);assert.equal(top.counts.returned, 2);
  const reading = (await query('library', 'Reading list', `${name}-list`, snapshot)).value.result;assert.equal(reading.view.type, 'list');sameIds(ids(reading.rows), ['atlas', 'delta']);assert.equal(n(reading.summaries['note.rating']), 7);
  const board = (await query('library', 'Board', `${name}-kanban`, snapshot)).value.result;assert.equal(board.view.type, 'kanban');sameIds(ids(board.rows), ids(all.rows));assert.equal(n(board.summaries['note.rating']), oracle.total);assertGroups(board, oracle);
  const empty = (await query('library', 'Empty', `${name}-empty`, snapshot)).value.result;assert.equal(empty.rows.length, 0);assert.equal(n(empty.summaries['note.rating']), 0);
  const authors = (await query('authors-base', 'Author stats', `${name}-authors`, snapshot)).value.result;
  for (const row of authors.rows) {const author = oracle.authors[row.entryId];assert.ok(author);assert.equal(n(row.values['note.bookCount']), author.count);assert.equal(n(row.values['note.totalRating']), author.total);near(n(row.values['note.averageRating']), author.average, row.path);sameIds(row.values['note.books'].value.map(link => link.target.entryId), author.books);assert.equal(row.editValues?.['note.bookCount'], undefined);}
  assert.equal(n(authors.summaries['note.bookCount']), 4);assert.equal(n(authors.summaries['note.totalRating']), oracle.total);
  evidence.checks.push({name: `${name}: all saved view queries, membership, summaries, formulas, relations and rollups`, total: oracle.total, scaledTotal: oracle.scaledTotal, snapshot});
  return all;
}

try {
  await ok('initialize', ['init']);
  for (const [id, folder] of folders) mutation((await ok(`mkdir-${id}`, ['mkdir', folder, '--id', id, '--operation-id', `mkdir-${id}`])).value, id);
  for (const file of files) {
    const bytes = Buffer.from(file.source);await fs.writeFile(path.join(out, 'inputs', file.id), bytes);
    mutation((await ok(`create-${file.id}`, ['create', file.path, '--id', file.id, '--operation-id', `create-${file.id}`, '--input', '-'], bytes)).value, file.id);
    evidence.fixture.files.push({id: file.id, path: file.path, bytes: bytes.length, sha256: hash(bytes)});
  }
  const status = (await ok('index-status-before-build', ['document-index', 'status'])).value;assert.equal(status.status.state, 'uninitialized');
  await fails('query-before-build', ['base-query', '--id', 'library', '--clock-ms', String(clockMs)], 'index_not_ready', 4);
  let snapshot = await build('initial-index');const initialSnapshot = snapshot;
  await phase('initial', expected.initial, snapshot);
  const defaultView = await query('library', undefined, 'default-saved-view', snapshot);assert.equal(defaultView.value.result.view.name, 'All books');sameIds(ids(defaultView.value.result.rows), ['atlas', 'birch', 'cedar', 'delta', 'empty']);
  await fails('unknown-view', ['base-query', '--id', 'library', '--view', 'Does not exist'], 'base_view_not_found', 4);
  for (const id of sources.keys()) await exactFile(id, `initial-bytes-${id}`);
  evidence.checks.push({name: 'Queries did not add missing properties, materialize derived author fields or rewrite any file'});

  const oldCedar = states.get('cedar').revision, cedarBytes = Buffer.from(editedCedar);
  const editArgs = ['write', '--id', 'cedar', '--expected-revision', oldCedar, '--operation-id', 'edit-cedar', '--input', '-'];
  const commit = mutation((await ok('edit-cedar', editArgs, cedarBytes)).value, 'cedar');sources.get('cedar').source = editedCedar;
  assert.deepEqual((await ok('replay-exact-edit', editArgs, cedarBytes)).value.commit, commit);
  await fails('reject-stale-note-edit', ['write', '--id', 'cedar', '--expected-revision', oldCedar, '--operation-id', 'stale-edit-cedar', '--input', '-'], 'revision_conflict', 3, Buffer.from('must not replace Cedar'));
  await exactFile('cedar', 'edited-note-readback');
  const stale = await query('library', 'Top rated', 'stale-before-explicit-build', snapshot);assert.deepEqual(ids(stale.value.result.rows), expected.initial.top);assert.notEqual(stale.source.watermark, stale.observedIndex.observedSourceHead);
  snapshot = await build('index-after-note-edit');await phase('edited', expected.edited, snapshot);
  await fails('reject-old-snapshot', ['base-query', '--id', 'library', '--expected-snapshot', JSON.stringify(initialSnapshot)], 'snapshot_expired', 3);
  evidence.checks.push({name: 'Revision CAS, exact operation replay, stale snapshot reporting and explicit index refresh'});

  mutation((await ok('edit-base-config', ['write', '--id', 'library', '--expected-revision', states.get('library').revision, '--operation-id', 'edit-library', '--input', '-'], Buffer.from(editedLibrary))).value, 'library');sources.get('library').source = editedLibrary;
  assert.equal(n((await query('library', 'All books', 'stale-base-source-before-build', snapshot)).value.result.summaries['formula.scaledRating']), 32);
  snapshot = await build('index-after-config-edit');await phase('configured', expected.configured, snapshot);await exactFile('library', 'base-config-exact-readback');
  assert.ok(editedLibrary.includes('# Standalone CLI fixture:'));assert.ok(editedLibrary.includes('fixtureSentinel: keep-me'));

  mutation((await ok('rename-birch', ['move', 'Books/Birch renamed.md', '--id', 'birch', '--expected-revision', states.get('birch').revision, '--operation-id', 'rename-birch'])).value, 'birch');sources.get('birch').path = 'Books/Birch renamed.md';
  await assert.rejects(fs.access(path.join(vault, 'Books/Birch.md')), {code: 'ENOENT'});snapshot = await build('index-after-rename');
  const moved = await query('library', 'All books', 'renamed-row', snapshot);const renamed = moved.value.result.rows.find(row => row.entryId === 'birch');assert.equal(renamed.path, 'Books/Birch renamed.md');assert.equal(renamed.revision, states.get('birch').revision);
  const movedAuthors = await query('authors-base', 'Author stats', 'renamed-reverse-relation', snapshot);const reverse = movedAuthors.value.result.rows.find(row => row.entryId === 'ada').values['note.books'];assert.ok(reverse.value.some(link => link.target.entryId === 'birch'));await exactFile('birch', 'renamed-note-exact-bytes');
  evidence.checks.push({name: 'File move retains stable identity, source bytes and reverse-relation membership'});

  mutation((await ok('delete-grace', ['delete', '--id', 'grace', '--expected-revision', states.get('grace').revision, '--operation-id', 'delete-grace'])).value, 'grace');sources.delete('grace');await assert.rejects(fs.access(path.join(vault, 'Authors/Grace.md')), {code: 'ENOENT'});snapshot = await build('index-after-related-note-delete');
  const dangling = (await query('library', 'All books', 'dangling-relation', snapshot)).value.result;const delta = dangling.rows.find(row => row.entryId === 'delta');assert.equal(dangling.rows.length, 5);assert.equal(delta.values['note.author'].type, 'link');assert.equal(delta.values['note.author'].target, null);assert.ok(dangling.diagnostics.some(issue => issue.entryId === 'delta' && issue.code === 'unresolved_relation'));
  await exactFile('delta', 'no-cascade-raw-readback');assert.ok(sources.get('delta').source.includes('[[Authors/Grace]]'));
  const survivingAuthors = (await query('authors-base', 'Author stats', 'surviving-author-rollups', snapshot)).value.result;assert.deepEqual(ids(survivingAuthors.rows), ['ada']);assert.equal(n(survivingAuthors.summaries['note.bookCount']), 3);
  const rebuilt = (await ok('explicit-derived-rebuild', ['document-index', 'rebuild'])).value;assert.equal(rebuilt.complete, true);assert.notDeepEqual(rebuilt.snapshot, snapshot);
  const afterRebuild = (await query('library', 'All books', 'rebuild-preserves-result', rebuilt.snapshot)).value.result;assert.deepEqual(afterRebuild.rows, dangling.rows);assert.deepEqual(afterRebuild.summaries, dangling.summaries);
  evidence.checks.push({name: 'Related-note deletion preserves dangling links and books; rebuilding changes only derived identity'});

  for (const id of sources.keys()) await exactFile(id, `final-bytes-${id}`);
  for (const id of ['atlas', 'library', 'property-definitions', 'ada']) {
    const file = sources.get(id), raw = await exactFile(id, `export-raw-${id}`), destination = path.join(out, 'exports', `${id}.raw`);await fs.copyFile(raw.stdoutPath, destination);
    evidence.exports.push({kind: 'read --raw stdout', file: path.relative(out, destination), bytes: Buffer.byteLength(file.source), sha256: hash(await fs.readFile(destination))});
  }
  assert.equal(sequence, 85, 'Original campaign command count changed before Q3');
  await runQ3Campaign({states, evidence, build, query,
    async mkdir(id, folder) {
      mutation((await ok(`q3-mkdir-${id}`, ['mkdir', folder, '--id', id, '--operation-id', `q3-mkdir-${id}`])).value, id);
    },
    async create(file) {
      assert.ok(!sources.has(file.id), `Q3 fixture ID collides with existing source: ${file.id}`);
      assert.ok(![...sources.values()].some(source => source.path === file.path), `Q3 fixture path collides: ${file.path}`);
      const bytes = Buffer.from(file.source);await fs.writeFile(path.join(out, 'inputs', file.id), bytes);
      mutation((await ok(`q3-create-${file.id}`, ['create', file.path, '--id', file.id, '--operation-id', `q3-create-${file.id}`, '--input', '-'], bytes)).value, file.id);
      sources.set(file.id, {...file});
      evidence.fixture.files.push({id: file.id, path: file.path, bytes: bytes.length, sha256: hash(bytes)});
    },
    async exportSource(file) {
      const raw = await exactFile(file.id, `q3-export-raw-${file.id}`), destination = path.join(out, 'exports', `${file.id}.raw`);
      await fs.copyFile(raw.stdoutPath, destination);
      evidence.exports.push({kind: 'read --raw stdout', file: path.relative(out, destination), bytes: Buffer.byteLength(file.source), sha256: hash(await fs.readFile(destination))});
    },
  });
  assert.equal(sequence, plannedCommands, 'Q3 command count differs from the authored bounded plan');
  assert.equal(hash(await fs.readFile(cli)), args.get('--expected-cli-sha256'), 'CLI artifact changed during the scenario');
  await exec('git', ['diff', '--quiet', 'HEAD', '--', 'crates', 'Cargo.toml', 'Cargo.lock'], {cwd: repo});
  assert.equal(await git('ls-files', '--others', '--exclude-standard', '--', 'crates'), '', 'Untracked Rust source appeared during verification');
  for (const [input, identity] of Object.entries(sourceInputs)) assert.equal(await git('rev-parse', `HEAD:${input}`), identity, 'Rust source closure changed during verification');
  for(const name of oracleSources)assert.equal(hash(await fs.readFile(new URL(name,import.meta.url))),evidence.source[name],`Oracle source changed during execution: ${name}`);
  evidence.status = 'passed';evidence.finishedAt = new Date().toISOString();evidence.elapsedMs = Date.now() - started;evidence.commandCount = sequence;
} catch (error) {
  evidence.status = 'failed';evidence.error = {name: error.name, message: error.message, stack: error.stack};process.exitCode = 1;
} finally {
  await fs.writeFile(reportPath, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({status: evidence.status, report: reportPath, commands: sequence, checks: evidence.checks.length}));
}
