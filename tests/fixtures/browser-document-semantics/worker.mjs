// No Markdown/YAML parser lives here. Only the generated WASM may produce an
// actual metadata result; canonical expected data is read exclusively to compare.
const encoder = new TextEncoder();
const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
async function fetchBytes(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Fetch failed (${response.status}): ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}
function mismatch(actual, expected, path = '$', ordered = false) {
  if (Object.is(actual, expected)) return null;
  if (actual === null || expected === null || typeof actual !== 'object' || typeof expected !== 'object') return { path, actual, expected };
  if (Array.isArray(actual) !== Array.isArray(expected)) return { path, actual, expected };
  if (Array.isArray(actual)) {
    if (actual.length !== expected.length) return { path: `${path}.length`, actual: actual.length, expected: expected.length };
    for (let i = 0; i < expected.length; i++) {
      const failure = mismatch(actual[i], expected[i], `${path}[${i}]`, ordered);
      if (failure) return failure;
    }
    return null;
  }
  const actualKeys = Object.keys(actual), expectedKeys = Object.keys(expected);
  if (ordered && JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) return { path: `${path}.[key order]`, actual: actualKeys, expected: expectedKeys };
  if (JSON.stringify([...actualKeys].sort()) !== JSON.stringify([...expectedKeys].sort())) return { path: `${path}.[keys]`, actual: actualKeys, expected: expectedKeys };
  for (const key of expectedKeys) {
    const failure = mismatch(actual[key], expected[key], `${path}.${key}`, ordered);
    if (failure) return failure;
  }
  return null;
}
function compareMetadata(actual, expected) {
  const failure = mismatch(actual, expected);
  if (failure) return failure;
  // Ordinary object field ordering in the metadata envelope is not significant;
  // recursive property map ordering is part of the shared data contract.
  for (let i = 0; i < expected.properties.length; i++) {
    const failure = mismatch(actual.properties[i].value, expected.properties[i].value, `$.properties[${i}].value`, true);
    if (failure) return failure;
  }
  return null;
}
function parseThrown(error) {
  try { return JSON.parse(String(error)); }
  catch { return { code: 'unexpected_transport_error', detail: String(error) }; }
}
function invalidRequestChecks(parse) {
  const base = { entryId: 'browser-note', contentRevision: 'revision-1', source: '' };
  const probes = [
    { id: 'invalid-entry-id', request: { ...base, entryId: 'bad:id' } },
    { id: 'invalid-revision', request: { ...base, contentRevision: 'bad:revision' } },
    { id: 'unpaired-high-surrogate', request: { ...base, source: String.fromCharCode(0xd800) } },
    { id: 'unpaired-low-surrogate', request: { ...base, source: String.fromCharCode(0xdc00) } },
  ];
  return probes.map(({ id, request }) => {
    // JSON.stringify MUST precede the &str binding. Modern JSON.stringify escapes
    // lone UTF-16 surrogates, allowing Rust serde to reject rather than replace.
    const input = JSON.stringify(request);
    try {
      const actual = parse(input);
      return { id, passed: false, input, unexpectedResult: actual };
    } catch (error) {
      const actual = parseThrown(error);
      return { id, passed: actual.code === 'invalid_request', input, error: actual };
    }
  });
}

self.onmessage = async ({ data: config }) => {
  const started = performance.now();
  const results = [], failures = [];
  try {
    const corpusBytes = await fetchBytes(config.corpusUrl);
    const corpus = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(corpusBytes));
    if (!Array.isArray(corpus.cases) || corpus.cases.length === 0) throw new Error('Canonical corpus has no cases');
    const wasmBytes = await fetchBytes(config.wasmUrl);
    const bindings = await import(config.moduleUrl);
    if (typeof bindings.default !== 'function' || typeof bindings.parseDocumentMetadata !== 'function') throw new Error('Generated WASM module lacks initializer or parseDocumentMetadata export');
    // Initialize with the exact bytes hashed in this report, not a second fetch.
    await bindings.default({ module_or_path: wasmBytes });
    const ids = new Set();
    for (const item of corpus.cases) {
      if (typeof item.id !== 'string' || ids.has(item.id)) throw new Error(`Invalid/duplicate corpus case ID ${item.id}`);
      ids.add(item.id);
      try {
        const raw = bindings.parseDocumentMetadata(JSON.stringify(item.request));
        if (typeof raw !== 'string') throw new Error('WASM metadata transport returned a non-string');
        const result = JSON.parse(raw);
        results.push({ id: item.id, result });
        const difference = compareMetadata(result, item.expected);
        if (difference) failures.push({ id: item.id, phase: 'compare', ...difference });
      } catch (error) {
        failures.push({ id: item.id, phase: 'extract', error: parseThrown(error) });
      }
      self.postMessage({ type: 'progress', completed: ids.size, total: corpus.cases.length });
    }
    const requestChecks = invalidRequestChecks(bindings.parseDocumentMetadata);
    for (const probe of requestChecks) if (!probe.passed) failures.push({ id: probe.id, phase: 'request-rejection', ...probe });
    const report = {
      status: failures.length ? 'failed' : 'passed',
      runtime: 'actual-browser-worker-generated-rust-wasm',
      ...config,
      corpusBaselineCommit: corpus.baselineCommit,
      corpusSha256: await hash(corpusBytes),
      wasmSha256: await hash(wasmBytes),
      actualResultsSha256: await hash(encoder.encode(JSON.stringify(results))),
      total: corpus.cases.length,
      passed: corpus.cases.length - failures.filter(failure => failure.phase !== 'request-rejection').length,
      requestChecks,
      elapsedMs: performance.now() - started,
      failures,
      results,
    };
    self.postMessage({ type: 'complete', report });
  } catch (error) {
    self.postMessage({ type: 'complete', report: { status: 'failed', ...config, elapsedMs: performance.now() - started, failures: [{ phase: 'bootstrap', message: String(error) }], results } });
  }
};
