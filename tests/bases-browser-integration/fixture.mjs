import {BrowserCoreRuntime} from '../../src/platform/browser-core-runtime.ts';
import {admitBrowserClient} from '../../src/platform/browser-client-admission.ts';
import {defaultBrowserAdapter} from '../../src/platform/browser-default.ts';
import {catchUpDocumentIndex} from '../../src/core/document-semantics.ts';
import {setProperty, readProperties} from '../../src/core/properties.ts';
import {projectSharedBaseResult, sharedBaseWitness} from '../../src/bases/shared-query.ts';
import {inlineBaseRequest} from '../../src/bases/inline-base.ts';
import {files, alias, body, pioneer, settings, plainLinkNotes, plainLinkPaths, inlinePrelude, inlinePrefix, inlineBase, inlineNormalized, inlineNote, clockMs, timezone, groupNames} from './cases.mjs';

// Product Worker, admitted client, generated WASM and IndexedDB only. No direct
// WASM evaluator, synthetic generation, replacement Worker, private storage write
// or JavaScript query engine exists in this fixture.
const report = {status: 'running', groups: [], plannedGroups: groupNames, cleanup: [], remainingGates: [
  'No rendered table/property widget/HTML sanitization or full app UI acceptance in this fixture.',
  'No mobile, other-browser, sync or stress acceptance.',
]};
window.basesBrowserEvidence = report;
const hosts = new Set(), names = new Set();
const bytes = text => new TextEncoder().encode(text).length;
const typed = (type, value) => ({type, value});
const number = value => typed('number', value);
const string = value => typed('string', value);
const list = values => typed('list', values);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function assert(value, message) { if (!value) throw new Error(message); }
function equal(actual, expected, message) {
  assert(JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected)), message + ': ' + JSON.stringify({actual, expected}));
}
async function rejects(run, code) {
  try { await run(); } catch (error) {
    assert(error.code === code, `Expected ${code}, got ${error.code}: ${error.message}`);
    return {code: error.code, message: error.message, details: error.details};
  }
  throw new Error('Expected rejection: ' + code);
}
async function group(index, run) {
  const started = performance.now();
  try { const evidence = await run(); report.groups.push({name: groupNames[index], status: 'passed', elapsedMs: performance.now() - started, evidence}); }
  catch (error) { report.groups.push({name: groupNames[index], status: 'failed', error: {code: error.code, message: String(error.stack ?? error)}}); throw error; }
}
async function start(database = 'zorid-core-vault:bases-browser-' + crypto.randomUUID(), clientId = crypto.randomUUID()) {
  names.add(database);
  const runtime = await BrowserCoreRuntime.open({database, clientId, wasmModuleUrl: '/target/browser-wasm/generated/zorid_wasm.js', allowNewVault: true, initializeLocal: true});
  const consumer = admitBrowserClient(runtime, {assertOwner: () => runtime.assertActive()});
  const adapter = defaultBrowserAdapter(runtime, consumer), service = adapter.documentSemantics;
  assert(service, 'Normal documentSemantics capability missing');
  const host = {database, clientId, runtime, consumer, adapter, service, pins: new Set()}; hosts.add(host); return host;
}
async function pin(host) { const value = await host.service.open(); host.pins.add(value); return value; }
async function closePin(host, value) { await value.close(); host.pins.delete(value); }
async function close(host) {
  try { for (const value of [...host.pins]) await closePin(host, value); await host.consumer.release(() => {}); }
  finally { host.runtime.close(); hosts.delete(host); }
}
async function build(host) { await catchUpDocumentIndex(host.service, {isCurrent: () => true, maxPumps: 100}); }
async function metadata(host, path) { const row = await host.runtime.readMetadata(path); assert(row?.entry, 'Missing fixture file: ' + path); return row.entry; }
async function query(host, selected, path, viewName, options = {}) {
  const definition = await metadata(host, path);
  const result = await selected.base({id: definition.id, viewName, options: {clockMs, timezone, randomSeed: 123, ...options}});
  equal(result.snapshot, selected.snapshot, 'Outer Base snapshot');
  equal(result.value.result.snapshotId, selected.snapshot, 'Inner Base snapshot');
  assert(result.value.definition.id === definition.id, 'Definition identity changed');
  return result;
}
function row(result, path) { const found = result.value.result.rows.find(row => row.path === path); assert(found, 'Missing result row: ' + path); return found; }
function groupFor(result, key) { const found = result.value.result.groups.find(group => group.key?.type === 'string' && group.key.value === key); assert(found, 'Missing group: ' + key); return found; }
function noErrors(result) { equal(result.value.result.diagnostics, [], 'Unexpected query diagnostics'); }
function witness(entry) { return {entryId: entry.id, revision: entry.revision}; }
// editValues contains only raw values that differ from their typed projection.
// Unchanged scalars/lists remain directly editable through values.
function editValue(item, property) { return item.editValues?.[property] ?? item.values[property]; }
function sameSemanticRead(actual, expected, message) {
  // Work accounting can legitimately improve on warm cache hits. It is not a
  // row/value oracle and must not obscure exact snapshot/source semantics.
  const semantic = read => {const {stepsUsed, ...result} = read.value.result; return {...read, value: {...read.value, result}};};
  equal(semantic(actual), semantic(expected), message);
}

try {
  let host = await start();
  for (const folder of ['Authors', 'Books', 'covers']) await host.adapter.mkdir(folder);
  for (const [path, source] of files) await host.adapter.createText(path, source);
  // A real attachment travels through the normal binary command as well; the
  // semantic image result remains inert and does not fetch remote resources.
  await host.adapter.createBinary('covers/diagram.png', Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=='), char => char.charCodeAt(0)));
  await build(host);
  const original = await pin(host), ada = await metadata(host, 'Authors/Ada.md'), grace = await metadata(host, 'Authors/Grace.md');
  const all = await query(host, original, 'Books.base', 'All');
  let afterRawEdit;
  await group(0, async () => {
    noErrors(all);
    equal(all.value.result.rows.map(row => row.path), ['Books/Compiler.md', 'Books/Foundations.md', 'Books/Pioneer.md'], 'Ordinary membership/order');
    for (const item of all.value.result.rows) {
      equal(item.values['formula.cross'], string('Ada'), 'Cross-file source-relative link');
      equal(item.values['formula.nested'], string('Grace'), 'Nested cross-file source-relative link');
      equal(item.values['formula.missing'], {type: 'null'}, 'Missing property must stay null');
    }
    const item = row(all, 'Books/Pioneer.md');
    equal(item.values['formula.owner'], string('Ada'), 'Own relative link');
    equal(item.values['formula.external'], typed('boolean', true), 'Ordinary URL inference');
    equal(item.values['note.author'].target, witness(ada), 'Link target identity/revision');
    equal(item.values['note.author'].display, 'A. Lovelace', 'Readable alias');
    equal(item.values['note.published'], {type: 'date', timestamp: Date.UTC(2026, 0, 2, 5), hasTime: false}, 'Automatic date uses explicit Toronto timezone');
    equal(all.value.result.summaries['note.rating'], number(15), 'Overall sum');
    equal(all.value.result.summaries['note.author'], list([string('Grace'), string('Ada'), string('Ada')]), 'Link summary must preserve original source identity');
    equal(all.value.result.summaries['file.file'], list([string('Grace'), string('Ada'), string('Ada')]), 'File summary dereferences exact file properties');
    assert(!all.value.result.propertyDefinitionDiagnostics?.length, 'No registry should be required');
    return {snapshot: all.snapshot, rows: all.value.result.rows, summaries: all.value.result.summaries};
  });
  await group(1, async () => {
    const item = row(all, 'Books/Pioneer.md');
    equal(item.editValues['note.author'], string(alias), 'Raw alias is not a display value');
    equal(item.editValues['note.published'], string('2026-01-02'), 'Raw date spelling');
    const nested = item.editValues['note.references'];
    equal(nested, list([{type: 'object', value: [['author', string('[[../Authors/Grace|Grace H.]]')]]}]), 'Nested raw links must remain strings');
    const projected = projectSharedBaseResult(all.value.result, 1, await host.adapter.list(), timezone, all.value.definition);
    const projection = projected.rows.find(row => row.path === item.path);
    equal(projection.editValues['note.author'], string(alias), 'TypeScript presentation adapter retains raw alias');
    equal(sharedBaseWitness(projected, item.path), {entryId: item.entryId, revision: item.revision}, 'Projected edit witness');
    const raw = await host.adapter.read(item.path); equal(raw, pioneer, 'Exact initial CRLF note');
    equal(editValue(item, 'note.topics'), list([string('Rust'), string('Design')]), 'Exact raw initial topics');
    const topics = editValue(item, 'note.topics').value.map(value => value.value);
    const next = setProperty(raw, 'topics', [...topics, 'Compilers'], 'list');
    assert(next.endsWith(body), 'Unrelated body/CRLF/Unicode changed');
    assert(next.includes(`author: '${alias}' # Keep this alias`), 'Alias, quote or comment changed');
    await host.adapter.compareAndWrite(item.path, raw, next, {entryId: item.entryId, revision: item.revision});
    equal(await host.adapter.read(item.path), next, 'Durable exact edited note');
    const rejection = await rejects(() => host.adapter.compareAndWrite(item.path, raw, next + 'stale\r\n', {entryId: item.entryId, revision: item.revision}), 'revision_conflict');
    equal(await host.adapter.read(item.path), next, 'Stale write damaged current note');
    await build(host); afterRawEdit = await pin(host);
    const updated = await query(host, afterRawEdit, 'Books.base', 'All');
    equal(row(updated, item.path).editValues['note.author'], string(alias), 'Reindex lost original alias');
    equal(editValue(row(updated, item.path), 'note.topics'), list([string('Rust'), string('Design'), string('Compilers')]), 'Reindex raw edited list');
    sameSemanticRead(await query(host, original, 'Books.base', 'All'), all, 'Old pin substituted new note revision');
    return {saved: next, rejected: rejection, updatedRow: row(updated, item.path)};
  });
  let limited;
  await group(2, async () => {
    limited = await query(host, afterRawEdit, 'Books.base', 'Limited'); noErrors(limited);
    equal(limited.value.result.rows.map(row => row.path), ['Books/Pioneer.md', 'Books/Compiler.md'], 'Global limit applies before summaries');
    equal(limited.value.result.summaries['note.rating'], number(12), 'Overall summary uses two final rows');
    equal(groupFor(limited, 'A').summaries['note.rating'], number(7), 'Group A excludes rating-three row removed by limit');
    equal(groupFor(limited, 'B').summaries['note.rating'], number(5), 'Group B exact scope');
    equal(groupFor(limited, 'A').summaries['note.author'], list([string('Ada')]), 'Group target identity');
    equal(limited.value.result.counts.returned, 2, 'Returned count');
    return limited.value.result;
  });
  await group(3, async () => {
    const overall = await query(host, afterRawEdit, 'Books.base', 'Limited', {summaryPreviewProperty: 'rating'});
    equal(overall.value.result.summaryPreviews.Sum, number(12), 'Overall preview');
    const scoped = await query(host, afterRawEdit, 'Books.base', 'Limited', {summaryPreviewProperty: 'rating', summaryPreviewGroupKeyId: groupFor(limited, 'A').keyId});
    equal(scoped.value.result.summaryPreviews.Sum, number(7), 'Scoped group preview');
    equal(scoped.value.result.rows, overall.value.result.rows, 'Preview altered membership');
    equal(scoped.value.result.summaries, overall.value.result.summaries, 'Preview altered saved summary');
    const rejected = await rejects(() => query(host, afterRawEdit, 'Books.base', 'Limited', {summaryPreviewProperty: 'rating', summaryPreviewGroupKeyId: 'base-key-v1:no-longer-present'}), 'index_base_evaluation');
    return {overall: overall.value.result.summaryPreviews, groupA: scoped.value.result.summaryPreviews, rejected};
  });
  await group(4, async () => {
    const rich = await query(host, afterRawEdit, 'Rich.base', 'Rich');
    const repeated = await query(host, afterRawEdit, 'Rich.base', 'Rich'); sameSemanticRead(repeated, rich, 'Fixed seed/source query is not deterministic');
    const different = await query(host, afterRawEdit, 'Rich.base', 'Rich', {randomSeed: 124});
    assert(different.value.result.rows.some((row, index) => row.values['formula.sample'].value !== rich.value.result.rows[index].values['formula.sample'].value), 'Changing captured seed did not change samples');
    for (const item of rich.value.result.rows) {
      equal(item.values['formula.richHtml'], typed('html', '<b>Ready</b><script>globalThis.__basesUnsafe = true</script>'), 'Inert HTML transport');
      equal(item.values['formula.richImage'], typed('image', 'covers/diagram.png'), 'Image type');
      equal(item.values['formula.richIcon'], typed('icon', 'book-open'), 'Icon type');
      const link = item.values['formula.richLink'];
      assert(link.type === 'link' && link.path === item.path && !link.external, 'File-backed rich link');
      equal(link.target, {entryId: item.entryId, revision: item.revision}, 'Rich link target witness');
      equal(link.displayValue, typed('icon', 'book'), 'Recursive icon label');
      const sample = item.values['formula.sample']; assert(sample.type === 'number' && sample.value >= 0 && sample.value < 1, 'Random domain');
      equal(item.values['formula.formatted'], string('Sunday, 21st January 2024 14:04:05.067 -05:00'), 'Moment tokens and captured timezone');
      equal(item.values['formula.today'], string('2024-01-21'), 'Case-insensitive captured Today');
      equal(item.values['formula.missing'], {type: 'null'}, 'Missing file');
      for (const [field, code] of [['unsupportedRegex', 'unsupported'], ['unknown', 'unknown-function'], ['cycleA', 'cycle']]) {
        const value = item.values['formula.' + field]; assert(value.type === 'error' && value.code === code, `${field} must preserve explicit ${code} diagnostic`);
      }
    }
    assert(window.__basesUnsafe === undefined, 'Inert HTML executed during transport');
    const projected = projectSharedBaseResult(rich.value.result, 2, await host.adapter.list(), timezone, rich.value.definition);
    equal(projected.rows[0].values['formula.richLink'].presentation.label.presentation.kind, 'icon', 'Presentation adapter lost nested rich label');
    return {rows: rich.value.result.rows, diagnostics: rich.value.result.diagnostics, refreshHint: rich.value.result.refreshHint, changedSeed: different.value.result.rows.map(row => row.values['formula.sample'])};
  });
  await group(5, async () => {
    const entry = await metadata(host, 'Inline host.md');
    // The public contract selects the entire physical fence, while its source
    // is normalized YAML. Compare the hand-authored oracle with the actual
    // UI source producer before passing that independent oracle to the core.
    const inlineSource = {source: inlineNormalized, startByte: bytes(inlinePrelude), endByte: bytes(inlinePrefix) + bytes(inlineBase) + 3};
    const produced = inlineBaseRequest(inlineNote, inlinePrelude.length, inlinePrefix.length + inlineBase.length + 3);
    assert(produced, 'Product inline source producer rejected the authored fence');
    equal({source: produced.source, startByte: bytes(inlineNote.slice(0, produced.from)), endByte: bytes(inlineNote.slice(0, produced.to))}, inlineSource, 'Product producer must match full-fence/normalized-source oracle');
    equal(new TextDecoder().decode(new TextEncoder().encode(inlineNote).slice(inlineSource.startByte, inlineSource.endByte)), '```base\r\n' + inlineBase + '```', 'Independent UTF-8 full-fence selection');
    const options = {clockMs, timezone, currentEntryId: entry.id, inlineSource};
    const read = await afterRawEdit.base({id: entry.id, viewName: 'Here', options});
    equal(read.value.result.rows.map(row => row.path), ['Inline host.md'], 'Saved fenced this context');
    const rejected = [];
    rejected.push(await rejects(() => afterRawEdit.base({id: entry.id, options: {...options, currentEntryId: ada.id}}), 'index_inline_source_mismatch'));
    rejected.push(await rejects(() => afterRawEdit.base({id: entry.id, options: {...options, inlineSource: {...inlineSource, source: inlineNormalized + '# forged\n'}}}), 'index_inline_source_mismatch'));
    rejected.push(await rejects(() => afterRawEdit.base({id: entry.id, options: {...options, inlineSource: {...inlineSource, startByte: inlineSource.startByte + 1}}}), 'index_inline_source_mismatch'));
    return {read, inlineSource, rejected};
  });
  let configured, definition, currentActor, relationBaseline, datedTarget;
  await group(6, async () => {
    for (const [path, source] of plainLinkNotes) await host.adapter.createText(path, source);
    await host.adapter.createText('Properties.yaml', settings); await build(host); configured = await pin(host); definition = await metadata(host, 'Properties.yaml');
    datedTarget = await metadata(host, '2026-01-02.md');
    const authors = await query(host, configured, 'Authors.base', 'Authors'); noErrors(authors);
    const invalid = await metadata(host, 'Invalid.md');
    assert(authors.value.result.metadataIssues.some(issue => issue.witness.entryId === invalid.id && issue.witness.revision === invalid.revision && issue.propertiesUnavailable), 'Invalid candidate fixture must have actual unavailable metadata');
    equal(authors.value.result.rows.map(row => row.path), ['Authors/Ada.md', 'Authors/Grace.md'], 'Rollup filter/order');
    for (const [path, count, average, weighted, expectedBooks] of [
      ['Authors/Ada.md', 2, 5, 10, ['Books/Foundations.md', 'Books/Pioneer.md']],
      ['Authors/Grace.md', 1, 5, 5, ['Books/Compiler.md']],
    ]) {
      const item = row(authors, path);
      equal(item.values['note.bookCount'], number(count), 'Reverse count'); equal(item.values['note.averageRating'], number(average), 'Average rollup');
      equal(item.values['formula.weighted'], number(weighted), 'Formula consumes rollup');
      equal(item.values['note.books'].value.map(value => value.path).sort(), expectedBooks, 'Reverse relation exact sources');
      assert(item.values['note.books'].value.every(value => value.target?.entryId), 'Reverse link lacks target witness');
    }
    equal(authors.value.result.summaries['note.bookCount'], number(3), 'Aggregate derived values');
    assert(typeof configured.propertyTargets === 'function', 'Normal property-target capability missing');
    const targets = await configured.propertyTargets({options: {clockMs, timezone}});
    equal(targets.value.definition, definition, 'Property target source witness');
    equal(targets.value.relationTargets.author.map(target => target.path).sort(), ['Authors/Ada.md', 'Authors/Grace.md'], 'Target filter candidates');
    equal(targets.value.relationTargets.author.find(target => target.path === 'Authors/Ada.md').entryId, ada.id, 'Target identity');
    equal(targets.value.propertyDefinitionDiagnostics, [], 'Property settings diagnostics');
    for (const property of ['reference', 'published', 'website']) {
      const candidates = targets.value.relationTargets[property];
      equal(candidates.map(target => target.path).sort(), plainLinkPaths, 'Plain Link candidates include every note regardless of metadata or relation filter');
      for (const target of candidates) equal({entryId: target.entryId, revision: target.revision}, witness(await metadata(host, target.path)), 'Plain Link choice exact saved identity/revision');
    }
    assert(!Object.hasOwn(targets.value, 'currentRelationValues'), 'No-current request must omit saved relation values');
    currentActor = await metadata(host, 'Books/Pioneer.md');
    relationBaseline = await configured.propertyTargets({options: {clockMs, timezone, currentEntryId: currentActor.id}});
    equal(relationBaseline.snapshot, configured.snapshot, 'Current relation frame snapshot');
    equal(relationBaseline.source, configured.source, 'Current relation frame source');
    const current = relationBaseline.value.currentRelationValues;
    assert(current, 'Ordinary current relation values missing from admitted endpoint');
    equal(current.witness, witness(currentActor), 'Current relation actor identity/revision');
    equal(current.editValues.author, string(alias), 'Current saved raw alias');
    assert(current.values.author.type === 'link', 'Current relation display must be typed');
    equal(current.values.author.path, 'Authors/Ada.md', 'Current relation canonical display path');
    equal(current.values.author.target, witness(ada), 'Current relation resolved target witness');
    equal(current.values.author.display, 'A. Lovelace', 'Current relation display alias');
    equal(current.editValues.reference, string(alias), 'Plain Link raw alias baseline');
    equal(current.values.reference, {type: 'link', path: 'Authors/Ada.md', target: witness(ada), display: 'A. Lovelace', external: false}, 'Plain Link typed alias target');
    equal(current.editValues.published, string('2026-01-02'), 'Date-shaped Link raw filename must stay text');
    equal(current.values.published, {type: 'link', path: '2026-01-02.md', target: witness(datedTarget), display: null, external: false}, 'Configured Link overrides automatic date inference with real note target');
    equal(current.editValues.website, string('https://example.test'), 'Manual URL raw baseline');
    equal(current.values.website, {type: 'link', path: 'https://example.test', target: null, display: null, external: true}, 'Manual URL remains an external Link without note target');
    sameSemanticRead(await query(host, original, 'Books.base', 'All'), all, 'New property registry substituted into old pin');
    return {authors: authors.value.result, targets, currentRelationValues: relationBaseline};
  });
  await group(7, async () => {
    const base = await metadata(host, 'Authors.base'), rejected = [];
    for (const propertyDefinitionsSource of [{id: definition.id, source: settings + '# forged\n'}, {id: ada.id, source: settings}]) {
      rejected.push(await rejects(() => configured.base({id: base.id, options: {clockMs, propertyDefinitionsSource}}), 'index_property_source_mismatch'));
      rejected.push(await rejects(() => configured.propertyTargets({options: {clockMs, propertyDefinitionsSource}}), 'index_property_source_mismatch'));
    }
    rejected.push(await rejects(() => configured.base({id: base.id, options: {clockMs, randomSeed: Number.MAX_SAFE_INTEGER + 1}}), 'index_invalid_request'));
    return {rejected, exactSource: settings, sourceWitness: definition};
  });
  await group(8, async () => {
    const other = await start(host.database);
    const baseId = (await metadata(host, 'Authors.base')).id;
    let foreign; try { foreign = await rejects(() => other.consumer.documentIndex.base({pinId: configured.pinId, id: baseId, options: {clockMs}}), 'index_snapshot_expired'); }
    finally { await close(other); }
    const expired = await pin(host); await closePin(host, expired);
    const closed = await rejects(() => expired.base({id: baseId, options: {clockMs}}), 'snapshot_expired');
    // The browser owns four pin slots. Earlier no-settings pin assertions are
    // complete; retain only the configured baseline across this next mutation.
    await closePin(host, original); await closePin(host, afterRawEdit);
    const originalSource = await host.adapter.read('Books/Pioneer.md');
    const authorSource = await host.adapter.read('Authors/Ada.md');
    const ineligibleSource = setProperty(authorSource, 'type', 'project', 'text');
    // Candidate eligibility changes independently of the current note. Existing
    // saved links still display their real target; this is not picker membership.
    await host.adapter.compareAndWrite('Authors/Ada.md', authorSource, ineligibleSource, witness(ada));
    await build(host); const eligibilityPin = await pin(host);
    const ineligibleAuthor = await metadata(host, 'Authors/Ada.md');
    const eligibility = await eligibilityPin.propertyTargets({options: {clockMs, timezone, currentEntryId: currentActor.id}});
    equal(eligibility.value.currentRelationValues.witness, witness(currentActor), 'Unedited actor witness changed with target eligibility');
    equal(eligibility.value.relationTargets.author.map(target => target.path), ['Authors/Grace.md'], 'Ineligible existing target remained a picker candidate');
    equal(eligibility.value.currentRelationValues.editValues.author, string(alias), 'Eligibility change rewrote saved alias');
    equal(eligibility.value.currentRelationValues.values.author.target, witness(ineligibleAuthor), 'Existing ineligible relation lost its actual current target witness');
    for (const property of ['reference', 'published', 'website']) equal(eligibility.value.relationTargets[property].map(target => target.path).sort(), plainLinkPaths, 'Plain Link suggestions must remain unfiltered after relation target eligibility changes');
    equal(eligibility.value.currentRelationValues.editValues.reference, string(alias), 'Plain Link alias changed with unrelated target metadata');
    equal(eligibility.value.currentRelationValues.values.reference.target, witness(ineligibleAuthor), 'Plain Link current display must use actual target revision even when filtered relation rejects it');
    equal(eligibility.value.relationTargets.reference.find(target => target.path === 'Authors/Ada.md').revision, ineligibleAuthor.revision, 'Plain Link candidate must carry current target revision');
    equal(eligibility.value.currentRelationValues.values.published, relationBaseline.value.currentRelationValues.values.published, 'Date-shaped Link changed with unrelated target metadata');
    equal(eligibility.value.currentRelationValues.values.website, relationBaseline.value.currentRelationValues.values.website, 'Manual URL changed with unrelated target metadata');
    equal(await configured.propertyTargets({options: {clockMs, timezone, currentEntryId: currentActor.id}}), relationBaseline, 'Retained relation frame substituted target eligibility/revision');
    await closePin(host, eligibilityPin);
    const unresolvedAlias = '[[../Authors/Missing|Lost alias]]';
    const unresolvedSource = setProperty(originalSource, 'author', unresolvedAlias, 'text');
    await host.adapter.compareAndWrite('Books/Pioneer.md', originalSource, unresolvedSource, witness(currentActor));
    await build(host); const unresolvedPin = await pin(host);
    const changedActor = await metadata(host, 'Books/Pioneer.md');
    assert(changedActor.id === currentActor.id && changedActor.revision !== currentActor.revision, 'Changed relation did not retain identity and advance revision');
    const unresolved = await unresolvedPin.propertyTargets({options: {clockMs, timezone, currentEntryId: changedActor.id}});
    equal(unresolved.value.currentRelationValues.witness, witness(changedActor), 'Unresolved relation actor witness');
    equal(unresolved.value.currentRelationValues.editValues.author, string(unresolvedAlias), 'Unresolved raw relation was erased or canonicalized');
    const lost = unresolved.value.currentRelationValues.values.author;
    assert(lost.type === 'link' && lost.target === null && lost.display === 'Lost alias', 'Unresolved relation must remain a typed unresolved link');
    equal(await host.adapter.read('Books/Pioneer.md'), unresolvedSource, 'Read-only relation discovery mutated unresolved source');
    equal(unresolved.value.currentRelationValues.editValues.reference, string(alias), 'Changing filtered relation damaged independent plain Link raw alias');
    equal(unresolved.value.currentRelationValues.values.reference.target, witness(ineligibleAuthor), 'Plain Link resolution must survive unresolved filtered relation');
    equal(await configured.propertyTargets({options: {clockMs, timezone, currentEntryId: currentActor.id}}), relationBaseline, 'Retained relation frame substituted modified current note');
    const unbound = await unresolvedPin.propertyTargets({options: {clockMs, timezone}});
    assert(!Object.hasOwn(unbound.value, 'currentRelationValues'), 'No-current request returned another actor frame');
    await closePin(host, unresolvedPin);
    // Restore only these disposable owned notes before the existing restart
    // oracle, using fresh admitted revisions and the exact original source.
    await host.adapter.compareAndWrite('Books/Pioneer.md', unresolvedSource, originalSource, witness(changedActor));
    await host.adapter.compareAndWrite('Authors/Ada.md', ineligibleSource, authorSource, witness(ineligibleAuthor));
    await build(host);
    equal(await host.adapter.read('Books/Pioneer.md'), originalSource, 'Restoration did not preserve the exact aliased note');
    const database = host.database, clientId = host.clientId;
    await close(host); host = await start(database, clientId); await build(host);
    equal(await host.adapter.read('Books/Pioneer.md'), originalSource, 'Restart lost exact note source');
    equal(readProperties(originalSource).find(property => property.key === 'author').value, alias, 'Restart changed raw alias');
    const reopened = await pin(host), authors = await query(host, reopened, 'Authors.base', 'Authors'); noErrors(authors);
    equal(row(authors, 'Authors/Ada.md').values['note.bookCount'], number(2), 'Restart lost derived index semantics');
    equal((await reopened.propertyTargets({options: {clockMs}})).value.definition.id, definition.id, 'Restart changed settings identity');
    return {foreign, closed, eligibility, unresolved, noCurrentOmitted: !Object.hasOwn(unbound.value, 'currentRelationValues'), retainedCurrent: relationBaseline, reopenedSnapshot: reopened.snapshot, rows: authors.value.result.rows, exactRawSource: originalSource};
  });
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = {code: error.code, message: String(error.stack ?? error)}; }
finally {
  for (const host of [...hosts]) try { await close(host); } catch (error) { report.status = 'failed'; report.cleanup.push({resource: 'host', error: String(error.stack ?? error)}); }
  for (const database of names) {
    try { await new Promise((resolve, reject) => {const request = indexedDB.deleteDatabase(database), timer = setTimeout(() => reject(new Error('Owned database deletion deadline')), 10000); request.onsuccess = () => {clearTimeout(timer); resolve();}; request.onerror = () => {clearTimeout(timer); reject(request.error);}; request.onblocked = () => {clearTimeout(timer); reject(new Error('Owned database still has an open connection'));};}); report.cleanup.push({database, deleted: true}); }
    catch (error) { report.status = 'failed'; report.cleanup.push({database, error: String(error.stack ?? error)}); }
  }
  report.unexecutedGroups = groupNames.filter(name => !report.groups.some(group => group.name === name));
  report.finished = true; window.basesBrowserComplete = true;
  document.querySelector('#result').textContent = JSON.stringify(report, null, 2);
}
