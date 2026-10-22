import test from 'node:test';
import assert from 'node:assert/strict';
import {assertMalformedRollup} from './malformed-rollup-oracle.mjs';
import {captured007} from './malformed-rollup-captured-007.mjs';
const verify = data => assertMalformedRollup(data.result, data.manifest, data.authors, data.malformed);
const mutated = run => { const copy = structuredClone(captured007); run(copy); return copy; };
test('captured browser007 payload satisfies the exact published Error/availability contract', () => verify(captured007));
for (const [name, change] of [
  ['missing author filter', x => x.result.diagnostics.splice(0, 1)],
  ['missing author unavailable bookCount', x => {x.result.diagnostics = x.result.diagnostics.filter(d => !(d.path === 'Authors/Ada.md' && d.property === 'note.bookCount'));}],
  ['extra diagnostic', x => x.result.diagnostics.push({...x.result.diagnostics[0]})],
  ['changed diagnostic code', x => {x.result.diagnostics[0].code = 'unavailable';}],
  ['changed diagnostic message', x => {x.result.diagnostics[0].message = 'another type error';}],
  ['changed property unavailable code', x => {x.result.diagnostics.find(d => d.property === 'note.bookCount').code = 'type';}],
  ['foreign author diagnostic identity', x => {x.result.diagnostics[0].entryId = 'foreign-author';}],
  ['changed author diagnostic path', x => {x.result.diagnostics[0].path = 'Wrong.md';}],
  ['changed diagnostic phase', x => {x.result.diagnostics[0].phase = 'value';}],
  ['changed diagnostic property', x => {x.result.diagnostics[0].property = 'note.bookCount';}],
  ['wrong captured author revision', x => {x.authors[0].witness.revision = 'stale';}],
  ['wrong malformed revision', x => {x.malformed.witness.revision = 'stale';}],
  ['missing unavailable metadata witness', x => {x.result.metadataIssues = [];}],
  ['fabricated author row', x => {x.result.rows = [{path: 'Authors/Ada.md'}];}],
  ['false complete metadata', x => {x.result.metadataComplete = true;}],
  ['lost relationship namespace', x => {x.result.relationshipsAvailable = false;}],
  ['missing manifest file', x => x.manifest.pop()],
  ['extra manifest file', x => x.manifest.push({path: 'Extra.md', witness: {entryId: 'extra', revision: 'r1'}})],
  ['duplicate file identity', x => {x.manifest[0].witness.entryId = x.manifest[1].witness.entryId;}],
]) test('rejects ' + name, () => assert.throws(() => verify(mutated(change)), /Malformed rollup oracle:/));
