import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// This checks stored expectations and candidate output. It is deliberately not
// an alternative Markdown parser or a substitute for native/WASM execution.
const directory = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(await readFile(path.join(directory, 'corpus.json'), 'utf8'));
const args = process.argv.slice(2);
assert(args.length % 2 === 0, 'usage: node verify.mjs [--typescript /abs/metadata.ts] [--results /abs/results.json]');
const options = new Map();
for (let i = 0; i < args.length; i += 2) {
  assert(['--typescript', '--results'].includes(args[i]), `unknown option ${args[i]}`);
  assert(!options.has(args[i]), `duplicate option ${args[i]}`);
  options.set(args[i], args[i + 1]);
}
const utf8 = value => Buffer.byteLength(value, 'utf8');
function checkRange(source, range) {
  assert.deepEqual(Object.keys(range).sort(), ['bytes', 'utf16']);
  for (const key of ['bytes', 'utf16']) {
    assert.equal(range[key].length, 2);
    assert(range[key].every(Number.isSafeInteger));
    assert(range[key][0] >= 0 && range[key][1] >= range[key][0]);
  }
  const [from, to] = range.utf16;
  assert(to <= source.length);
  assert.deepEqual(range.bytes, [utf8(source.slice(0, from)), utf8(source.slice(0, to))]);
  // Prevent accepting a UTF-16 position inside a surrogate pair.
  for (const at of [from, to]) assert(!(/[\uD800-\uDBFF]/.test(source[at - 1] ?? '') && /[\uDC00-\uDFFF]/.test(source[at] ?? '')));
}
function walkRanges(source, object) {
  if (!object || typeof object !== 'object') return;
  if (Object.hasOwn(object, 'bytes') && Object.hasOwn(object, 'utf16') && Array.isArray(object.bytes)) checkRange(source, object);
  else for (const value of Object.values(object)) walkRanges(source, value);
}
const ids = new Set();
for (const { id, request, expected, propertyKeySpellings } of corpus.cases) {
  assert(!ids.has(id), `duplicate fixture ${id}`); ids.add(id);
  const s = request.source;
  assert.equal(expected.entryId, request.entryId);
  assert(/^[A-Za-z0-9_-]{1,128}$/.test(request.entryId));
  assert(/^[A-Za-z0-9_-]{1,128}$/.test(request.contentRevision));
  assert.equal(expected.contentRevision, request.contentRevision);
  assert.equal(expected.schemaVersion, 1);
  assert.equal(expected.dialectVersion, 'zorid-markdown-1');
  assert.deepEqual(expected.sourceLength, { bytes: utf8(s), utf16: s.length });
  walkRanges(s, expected);
  const slice = range => s.slice(...range.utf16);
  if (propertyKeySpellings) assert.equal(propertyKeySpellings.length, expected.properties.length);
  expected.properties.forEach((p, i) => assert.equal(slice(p.keyRange), propertyKeySpellings?.[i] ?? p.key, `${id} property source key spelling`));
  for (const tag of expected.tagOccurrences) assert.equal(slice(tag.range), '#' + tag.name, `${id} tag`);
  assert.deepEqual(expected.tags, [...new Set(expected.tags)], `${id} tag deduplication`);
  for (const link of expected.links) {
    assert.equal(slice(link.targetRange), link.target, `${id} link target`);
    if (link.definitionRange === null) {
      assert(link.targetRange.utf16[0] >= link.range.utf16[0] && link.targetRange.utf16[1] <= link.range.utf16[1]);
    } else assert(link.targetRange.utf16[0] >= link.definitionRange.utf16[0] && link.targetRange.utf16[1] <= link.definitionRange.utf16[1]);
  }
  for (const h of expected.headings) assert.equal(h.line, (s.slice(0, h.range.utf16[0]).match(/\r\n|\r|\n/g) ?? []).length);
  for (const task of expected.tasks) {
    assert.equal(slice(task.range), '[' + task.status + ']');
    assert.equal(slice(task.statusRange), task.status);
    assert.equal(task.status.length, 1);
    assert.equal(slice(task.textRange), task.text);
    assert.equal(task.checked, task.status !== ' ');
    assert.equal(task.completed, /^[xX]$/.test(task.status));
    assert.equal(task.line, (s.slice(0, task.range.utf16[0]).match(/\r\n|\r|\n/g) ?? []).length);
  }
  for (const list of [expected.headings, expected.tagOccurrences, expected.links, expected.tasks]) {
    assert.deepEqual(list.map(x => x.range.bytes[0]), list.map(x => x.range.bytes[0]).sort((a, b) => a - b), `${id} source ordering`);
  }
  assert.equal(expected.frontmatter.bodyStart.byte, utf8(s.slice(0, expected.frontmatter.bodyStart.utf16)));
  if (expected.frontmatter.state === 'valid' || expected.frontmatter.state === 'invalid') assert.equal(expected.frontmatter.bodyStart.byte, expected.frontmatter.range.bytes[1]);
  if (expected.frontmatter.state === 'invalid') assert.deepEqual(expected.properties, []);
}
console.log(`PASS ${corpus.cases.length} corpus cases: provenance, ranges, source slices, ordering and task invariants`);

// JSON-safe encoding only for the historical TS observation (.nan/.inf are a
// discovered old-reader issue). It is never part of the proposed Rust contract.
const safe = object => JSON.parse(JSON.stringify(object, (_key, value) => typeof value === 'number' && !Number.isFinite(value) ? { tsNonFiniteNumber: String(value) } : value));
if (options.has('--typescript')) {
  const metadataPath = path.resolve(options.get('--typescript'));
  const { parseMetadata } = await import(pathToFileURL(metadataPath));
  const { readProperties } = await import(pathToFileURL(path.join(path.dirname(metadataPath), 'properties.ts')));
  const observed = [];
  for (const c of corpus.cases) {
    let properties = null, propertiesError = false;
    try { properties = readProperties(c.request.source); } catch { propertiesError = true; }
    observed.push(safe({ id: c.id, metadata: parseMetadata('Fixture.md', c.request.source), properties, propertiesError }));
  }
  const baseline = JSON.parse(await readFile(path.join(directory, 'typescript-baseline.json'), 'utf8'));
  assert.equal(baseline.sourceCommit, corpus.baselineCommit);
  assert.deepEqual(observed, baseline.cases);
  console.log(`PASS ${observed.length} current TypeScript observations match recorded baseline ${baseline.sourceCommit}`);
}
if (options.has('--results')) {
  const observed = JSON.parse(await readFile(path.resolve(options.get('--results')), 'utf8'));
  assert.deepEqual(observed, corpus.cases.map(c => ({ id: c.id, result: c.expected })));
  console.log(`PASS ${observed.length} candidate results match exact shared contract`);
}
