// Comparison/transport only. All expression, configuration and query semantics
// execute inside the actual generated shared Rust/WASM module.
const encoder = new TextEncoder();
const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
async function fetchBytes(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Fetch failed (${response.status}): ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}
async function fetchCorpus(url) {
  const bytes = await fetchBytes(url);
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!Array.isArray(value.cases) || value.cases.length === 0) throw new Error(`Corpus has no cases: ${url}`);
  return { value, sha256: await hash(bytes) };
}
function difference(actual, expected, path = '$') {
  // JSON numbers use numeric equality, matching the native oracle (including -0).
  if (actual === expected) return null;
  if (actual === null || expected === null || typeof actual !== 'object' || typeof expected !== 'object') return { path, actual, expected };
  if (Array.isArray(actual) !== Array.isArray(expected)) return { path, actual, expected };
  if (Array.isArray(actual)) {
    if (actual.length !== expected.length) return { path: `${path}.length`, actual: actual.length, expected: expected.length };
    for (let i = 0; i < expected.length; i++) {
      const failure = difference(actual[i], expected[i], `${path}[${i}]`);
      if (failure) return failure;
    }
    return null;
  }
  const actualKeys = Object.keys(actual).sort(), expectedKeys = Object.keys(expected).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) return { path: `${path}.[keys]`, actual: actualKeys, expected: expectedKeys };
  for (const key of expectedKeys) {
    const failure = difference(actual[key], expected[key], `${path}.${key}`);
    if (failure) return failure;
  }
  return null;
}
function thrown(error) {
  try { return JSON.parse(String(error)); }
  catch { return { code: 'unexpected_transport_error', message: String(error) }; }
}
function invoke(fn, request) {
  try {
    const raw = fn(JSON.stringify(request));
    if (typeof raw !== 'string') throw new Error('WASM transport returned a non-string');
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, error: thrown(error) };
  }
}
// The baseline intentionally freezes diagnostic codes, not dependency prose.
// Keep downloaded outputs intact; only comparison removes non-contract messages.
function compact(value) {
  if (!value || typeof value !== 'object') return value;
  if (value.type === 'error') return { type: 'error', code: value.code };
  if (Array.isArray(value)) return value.map(compact);
  return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, compact(value)]));
}
function expressionValue(outcome) {
  return outcome.ok ? compact(outcome.value.value) : { type: 'error', code: outcome.error.code };
}
function compareQuery(outcome, item) {
  if (!outcome.ok) return { path: '$', error: outcome.error, expected: 'successful shared query' };
  const result = outcome.value;
  const snapshotFailure = difference(result.snapshotId, item.request.snapshot?.snapshotId ?? item.request.snapshotId, '$.snapshotId');
  if (snapshotFailure) return snapshotFailure;
  const projected = {
    paths: result.rows.map(row => row.path),
    snapshotId: result.snapshotId,
    relationshipsAvailable: result.relationshipsAvailable,
    metadataComplete: result.metadataComplete,
    metadataIssues: result.metadataIssues,
    properties: result.properties,
    counts: result.counts,
    groups: result.groups.map(group => ({ key: compact(group.key), entryIds: group.entryIds })),
    groupOptions: compact(result.groupOptions),
  };
  for (const [key, expected] of Object.entries(item.expected)) {
    if (key === 'values') {
      for (const [path, values] of Object.entries(expected)) {
        const row = result.rows.find(row => row.path === path);
        if (!row) return { path: `$.rows[${path}]`, expected: 'row present' };
        for (const [property, value] of Object.entries(values)) {
          const failure = difference(compact(row.values[property]), compact(value), `$.rows[${path}].values.${property}`);
          if (failure) return failure;
        }
      }
    } else if (key === 'diagnostics') {
      for (const required of expected) {
        if (!result.diagnostics.some(actual => Object.entries(required).every(([key, value]) => difference(actual[key], value) === null))) return { path: '$.diagnostics', missing: required };
      }
    } else {
      const failure = difference(compact(projected[key]), compact(expected), `$.${key}`);
      if (failure) return failure;
    }
  }
  return null;
}
const currentEntryCaseIds = new Set([
  'current-entry-base-file-facts-with-empty-properties',
  'current-entry-markdown-properties',
]);
function compareCurrentEntryWitness(outcome, item) {
  if (!currentEntryCaseIds.has(item.id)) return null;
  if (!outcome.ok) return { path: '$', error: outcome.error, expected: 'successful current-entry query' };
  const selected = item.request.entries.find(entry => entry.id === item.request.options?.currentEntryId);
  if (!selected || selected.kind !== 'file') throw new Error(`Current-entry fixture ${item.id} lacks its exact file witness`);
  const row = outcome.value.rows.find(row => row.entryId === selected.id);
  if (!row) return { path: '$.rows', expectedEntryId: selected.id, expected: 'selected file row present' };
  return difference({ entryId: row.entryId, revision: row.revision, path: row.path },
    { entryId: selected.id, revision: selected.revision, path: selected.path }, '$.selectedWitness');
}
function requestChecks(bindings, queryRequest, generationRequest, currentRequest) {
  const checks = [
    { id: 'compile-unpaired-high-surrogate', input: String.fromCharCode(0xd800) },
    { id: 'compile-unpaired-low-surrogate', input: String.fromCharCode(0xdc00) },
    { id: 'compile-wrong-input-type', input: {} },
  ].map(({ id, input }) => {
    const actual = invoke(bindings.compileBaseSource, input);
    return { id, passed: !actual.ok && actual.error.code === 'invalid_request', actual };
  });
  const forged = { ...queryRequest, snapshot: { ...queryRequest.snapshot, relationships: {} } };
  const actual = invoke(bindings.queryBase, forged);
  checks.push({ id: 'reject-caller-authored-relationship-graph', passed: !actual.ok && actual.error.code === 'invalid_request', actual });
  const stale = structuredClone(generationRequest);
  const text = stale.sources.find(source => source.kind === 'text');
  if (!text) throw new Error('Canonical generation corpus needs one exact text witness for the stale-revision proof');
  text.request.contentRevision = 'stale-browser-revision';
  const staleResult = invoke(bindings.queryBaseFromSources, stale);
  checks.push({ id: 'reject-stale-generation-source-witness', passed: !staleResult.ok && staleResult.error.code === 'index_error' && staleResult.error.error === 'stale_source', actual: staleResult });
  const selected = currentRequest.entries.find(entry => entry.id === currentRequest.options?.currentEntryId);
  if (!selected || selected.kind !== 'file') throw new Error('Canonical context query needs a selected file witness');
  const reject = (id, request, code) => {
    const actual = invoke(bindings.queryBaseFromSources, request);
    checks.push({ id, passed: !actual.ok && actual.error.code === code, actual });
  };
  const missing = structuredClone(currentRequest);
  missing.options.currentEntryId = 'browser-missing-current-entry';
  reject('reject-missing-current-entry-id', missing, 'stale-source');
  const folder = structuredClone(currentRequest);
  folder.entries.push({ id: 'browser-current-folder', path: 'BrowserContextFolder', kind: 'folder', revision: 'folder-r1', deleted: false });
  folder.options.currentEntryId = 'browser-current-folder';
  reject('reject-folder-current-entry-id', folder, 'stale-source');
  const conflicting = structuredClone(currentRequest);
  conflicting.options.evaluation ??= {};
  conflicting.options.evaluation.currentRecord = {
    witness: { entryId: selected.id, revision: 'stale-browser-current-revision' },
    path: selected.path, properties: [],
  };
  reject('reject-stale-caller-current-record', conflicting, 'stale-source');
  // The generic wrapper intentionally clamps above-ceiling limits. Zero/tiny
  // lowered budgets must still fail in the actual Rust preparation/evaluator.
  for (const maxSteps of [0, 1]) {
    const limited = structuredClone(currentRequest);
    limited.options.maxSteps = maxSteps;
    reject(`reject-current-entry-max-steps-${maxSteps}`, limited, 'budget');
  }
  return checks;
}

self.onmessage = async ({ data: config }) => {
  const started = performance.now();
  const results = [], failures = [];
  try {
    const expressions = await fetchCorpus(config.expressionsUrl);
    const queries = await fetchCorpus(config.queriesUrl);
    const documents = await fetchCorpus(config.documentsUrl);
    const generationQueries = await fetchCorpus(config.generationQueriesUrl);
    const currentCases = generationQueries.value.cases.filter(item => currentEntryCaseIds.has(item.id));
    if (currentCases.length !== currentEntryCaseIds.size || !generationQueries.value.cases.some(item => item.id === 'omitted-current-entry-retains-no-this')) {
      throw new Error('Canonical generation corpus lacks the three frozen current-entry cases; stage the contract owner corpus with these fixture assets');
    }
    const wasmBytes = await fetchBytes(config.wasmUrl);
    const bindings = await import(config.moduleUrl);
    for (const name of ['default', 'evaluateBaseExpression', 'queryBase', 'queryBaseFromSources', 'compileBaseSource']) {
      if (typeof bindings[name] !== 'function') throw new Error(`Generated WASM module lacks ${name}`);
    }
    await bindings.default({ module_or_path: wasmBytes });
    const total = expressions.value.cases.length + queries.value.cases.length + documents.value.cases.length + generationQueries.value.cases.length;
    let completed = 0;
    for (const item of expressions.value.cases) {
      if (!item.request || !Object.hasOwn(item, 'expected')) throw new Error(`Accepted expression ${item.id} lacks canonical transport-ready request/expected; run the Base owner's shared projector`);
      const outcomes = Array.from({ length: item.repeat ?? 1 }, () => invoke(bindings.evaluateBaseExpression, item.request));
      results.push({ id: item.id, operation: 'expression', result: outcomes });
      const actual = item.repeat ? outcomes.map(expressionValue) : expressionValue(outcomes[0]);
      const failure = difference(actual, item.expected);
      if (failure) failures.push({ id: item.id, operation: 'expression', ...failure });
      self.postMessage({ type: 'progress', completed: ++completed, total });
    }
    for (const item of queries.value.cases) {
      if (!item.request?.snapshot || !Object.hasOwn(item, 'expected')) throw new Error(`Accepted query ${item.id} lacks canonical transport-ready request/expected; run the Base owner's shared projector`);
      const outcome = invoke(bindings.queryBase, item.request);
      results.push({ id: item.id, operation: 'query', result: outcome });
      const failure = compareQuery(outcome, item);
      if (failure) failures.push({ id: item.id, operation: 'query', ...failure });
      self.postMessage({ type: 'progress', completed: ++completed, total });
    }
    for (const item of generationQueries.value.cases) {
      if (!item.request?.snapshotId || !Array.isArray(item.request.sources) || !Object.hasOwn(item, 'expected')) throw new Error(`Accepted generation query ${item.id} lacks canonical source factory request/expected`);
      const outcome = invoke(bindings.queryBaseFromSources, item.request);
      results.push({ id: item.id, operation: 'generationQuery', result: outcome });
      const failure = compareQuery(outcome, item) ?? compareCurrentEntryWitness(outcome, item);
      if (failure) failures.push({ id: item.id, operation: 'generationQuery', ...failure });
      self.postMessage({ type: 'progress', completed: ++completed, total });
    }
    for (const item of documents.value.cases) {
      if (typeof item.source !== 'string' || typeof item.current?.valid !== 'boolean') throw new Error(`Invalid source fixture ${item.id}`);
      const outcome = invoke(bindings.compileBaseSource, item.source);
      results.push({ id: item.id, operation: 'compile', result: outcome });
      const sharedCompileError = !outcome.ok && ['yaml', 'semantic'].includes(outcome.error.phase) && typeof outcome.error.diagnostic?.code === 'string';
      if (outcome.ok !== item.current.valid || (!outcome.ok && !sharedCompileError)) failures.push({ id: item.id, operation: 'compile', expectedValid: item.current.valid, actual: outcome });
      self.postMessage({ type: 'progress', completed: ++completed, total });
    }
    const currentRequest = currentCases.find(item => item.id === 'current-entry-markdown-properties').request;
    const checks = requestChecks(bindings, queries.value.cases[0].request, generationQueries.value.cases[0].request, currentRequest);
    for (const check of checks) if (!check.passed) failures.push({ id: check.id, operation: 'request-rejection', ...check });
    self.postMessage({ type: 'complete', report: {
      status: failures.length ? 'failed' : 'passed', runtime: 'actual-browser-worker-generated-rust-wasm',
      currentEntryCoverage: {
        cases: currentCases.length,
        passed: currentCases.length - failures.filter(failure => failure.operation === 'generationQuery' && currentEntryCaseIds.has(failure.id)).length,
        scope: 'exact entry ID/revision/path from the supplied Rust-owned generation; live host persistence not exercised',
        genericMaxStepsPolicy: 'above-ceiling values clamp; zero/tiny lowered budgets reject',
      },
      relationshipCoverage: { detachedQueries: 'graphless', generationQueryCases: generationQueries.value.cases.length, passedGenerationQueries: generationQueries.value.cases.length - failures.filter(failure => failure.operation === 'generationQuery').length, scope: 'canonical Rust-owned source-generation queries; production host persistence not exercised' }, ...config,
      corpusHashes: { expressions: expressions.sha256, queries: queries.sha256, generationQueries: generationQueries.sha256, documents: documents.sha256 },
      wasmSha256: await hash(wasmBytes), actualResultsSha256: await hash(encoder.encode(JSON.stringify(results))),
      totals: { expressions: expressions.value.cases.length, queries: queries.value.cases.length, generationQueries: generationQueries.value.cases.length, compile: documents.value.cases.length },
      total, passed: total - failures.filter(failure => failure.operation !== 'request-rejection').length,
      requestChecks: checks, elapsedMs: performance.now() - started, results, failures,
    } });
  } catch (error) {
    self.postMessage({ type: 'complete', report: { status: 'failed', ...config, elapsedMs: performance.now() - started, results, failures: [{ operation: 'bootstrap', message: String(error) }] } });
  }
};
