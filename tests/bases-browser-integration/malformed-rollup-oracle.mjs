// Exact, independently authored contract for the fourteen-file malformed stage.
// IDs/revisions come from ordinary admitted metadata reads, never diagnostics.
export const malformedRollupPaths = [
  '2026-01-02.md', 'Authors.base', 'Authors/Ada.md', 'Authors/Grace.md',
  'Books.base', 'Books/Compiler.md', 'Books/Foundations.md', 'Books/Pioneer.md',
  'Inline host.md', 'Invalid.md', 'Not a book.md', 'Properties.yaml',
  'Rich.base', 'covers/diagram.png',
];
const authorPaths = ['Authors/Ada.md', 'Authors/Grace.md'];
const unavailable = 'Rollup relation has invalid or unresolved targets';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const json = value => JSON.stringify(canonical(value));
function require(value, message) { if (!value) throw new Error('Malformed rollup oracle: ' + message); }
function same(actual, expected, message) { require(json(actual) === json(expected), message + ': ' + json({actual, expected})); }
export function assertMalformedRollup(result, manifest, authors, malformed) {
  require(Array.isArray(manifest), 'missing independent manifest witnesses');
  same(manifest.map(item => item.path).sort(), [...malformedRollupPaths].sort(), 'exact known file inventory');
  const byPath = new Map(), ids = new Set();
  for (const item of manifest) {
    require(typeof item.witness?.entryId === 'string' && item.witness.entryId.length > 0 && typeof item.witness.revision === 'string' && item.witness.revision.length > 0, 'missing file witness');
    require(!ids.has(item.witness.entryId), 'duplicate file identity');
    ids.add(item.witness.entryId); byPath.set(item.path, item.witness);
  }
  same(authors.map(item => item.path).sort(), [...authorPaths].sort(), 'exact author paths');
  for (const author of authors) same(author.witness, byPath.get(author.path), 'author witness changed');
  same(malformed.path, 'Invalid.md', 'malformed file path');
  same(malformed.witness, byPath.get('Invalid.md'), 'malformed witness changed');
  same(result.rows, [], 'unavailable aggregates must not fabricate rows');
  same(result.metadataComplete, false, 'malformed metadata coverage must remain incomplete');
  same(result.relationshipsAvailable, true, 'captured relationship namespace remains available');
  require(result.metadataIssues.some(issue => json(issue.witness) === json(malformed.witness) && issue.propertiesUnavailable === true), 'missing exact unavailable metadata witness');
  const expected = [];
  for (const path of authorPaths) expected.push({phase: 'filter', entryId: byPath.get(path).entryId, path, property: null, code: 'type', message: 'Cannot convert Error to number'});
  for (const path of malformedRollupPaths) for (const property of ['note.averageRating', 'note.bookCount']) expected.push({phase: 'property', entryId: byPath.get(path).entryId, path, property, code: 'unavailable', message: unavailable});
  require(Array.isArray(result.diagnostics), 'missing diagnostic multiset');
  const project = ({phase, entryId, path, property, code, message}) => ({phase, entryId, path, property, code, message});
  same(result.diagnostics.map(item => json(project(item))).sort(), expected.map(json).sort(), 'exact diagnostic multiset');
}
