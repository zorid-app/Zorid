import assert from 'node:assert/strict';
import {q3Files, q3Folders, q3Groups} from '../fixtures/bases-q3-semantics.mjs';
import {files,q3LegacyDiagnostics} from './fixtures.mjs';

// This is an assertion layer over independently authored inert expectations.
// No product imports, expression evaluator, source parser or expected-value
// derivation from the queried result is permitted here.
const diagnosticKey = issue => [issue.phase ?? null,issue.entryId ?? null,issue.path ?? null,issue.property ?? null,issue.code];
const orderedDiagnostics = issues => issues.map(diagnosticKey)
  .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
const objectPrototypeDescriptors=Object.getOwnPropertyDescriptors(Object.prototype);

export const q3CommandCount = q3Folders.length + 2 * q3Files.length + q3Groups.length + 1;

function stableTypedValue(value) {
  if (value?.type === 'error') {
    assert.equal(typeof value.message, 'string', 'Typed error must retain a diagnostic message');
    assert.ok(value.message.length > 0, 'Typed error diagnostic message cannot be empty');
    const {message, ...stable} = value;
    return stable;
  }
  if (Array.isArray(value)) return value.map(stableTypedValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, stableTypedValue(child)]));
  return value;
}

function expectedWithWitnesses(value, states, parentType, key) {
  if (value && typeof value === 'object' && Object.hasOwn(value, '$fixtureWitness')) {
    assert.equal(parentType, 'link', 'Fixture witness belongs only to an expected Link target');
    assert.equal(key, 'target', 'Fixture witness belongs only to an expected Link target');
    assert.deepEqual(Object.keys(value), ['$fixtureWitness'], 'Fixture witness must be an exact inert marker');
    const file = q3Files.find(file => file.path === value.$fixtureWitness);
    assert.ok(file, `Unknown fixture witness path: ${value.$fixtureWitness}`);
    const receipt = states.get(file.id);
    assert.equal(receipt?.id, file.id, `Missing committed fixture receipt: ${file.id}`);
    assert.equal(typeof receipt.revision, 'string', `Missing committed fixture revision: ${file.id}`);
    assert.ok(receipt.revision.length > 0, `Empty committed fixture revision: ${file.id}`);
    return {entryId: file.id, revision: receipt.revision};
  }
  if (Array.isArray(value)) return value.map(child => expectedWithWitnesses(child, states));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, expectedWithWitnesses(child, states, value.type, childKey)]));
  return value;
}

function expectedDiagnostics(group,states){
  const bound=(issue,file)=>{
    assert.ok(file,`${group.name}: unknown authored diagnostic source`);
    assert.equal(file.id,issue.entryId,`${group.name}: authored diagnostic identity mismatch`);
    assert.equal(file.path,issue.path,`${group.name}: authored diagnostic path mismatch`);
    const receipt=states.get(file.id);
    assert.equal(receipt?.id,file.id,`${group.name}: missing committed diagnostic receipt`);
    assert.equal(receipt.path,file.path,`${group.name}: diagnostic receipt path changed`);
    assert.equal(typeof receipt.revision,'string',`${group.name}: missing diagnostic revision`);
    assert.ok(receipt.revision.length>0,`${group.name}: empty diagnostic revision`);
    return issue;
  };
  const q3=group.diagnostics.map(issue=>{
    const file=q3Files.find(file=>file.path===issue.path);
    return bound({...issue,phase:'value',entryId:file?.id},file);
  });
  const legacy=q3LegacyDiagnostics.map(issue=>bound(issue,files.find(file=>file.id===issue.entryId)));
  return{q3,legacy,all:[...q3,...legacy]};
}

export function assertQ3Result(result, group, states) {
  assert.equal(result.view.name, group.view, `${group.name}: selected view`);
  assert.deepEqual(result.rows.map(row => row.path), group.rows.map(row => row.path), `${group.name}: exact membership and order`);
  assert.equal(result.counts.returned, group.rows.length, `${group.name}: returned count`);
  const byPath = new Map(q3Files.map(file => [file.path, file]));
  for (let at = 0; at < group.rows.length; at++) {
    const actual = result.rows[at], expected = group.rows[at], file = byPath.get(expected.path);
    assert.ok(file, `${group.name}: missing authored row source ${expected.path}`);
    assert.equal(actual.entryId, file.id, `${group.name}: stable row identity`);
    assert.equal(actual.revision, states.get(file.id)?.revision, `${group.name}: exact committed row revision`);
    for (const [property, value] of Object.entries(expected.values)) {
      assert.deepEqual(stableTypedValue(actual.values[property]), expectedWithWitnesses(value, states), `${group.name}: ${expected.path} ${property}`);
    }
    for(const property of group.ownKeyStringProperties??[]){
      const parsed=JSON.parse(actual.values[property].value);
      assert.ok(Object.hasOwn(parsed,'__proto__'),`${group.name}: Object display lost its inert own key`);
      assert.equal(parsed.__proto__,'inert',`${group.name}: inert own-key data changed`);
      assert.equal(Object.getPrototypeOf(parsed),Object.prototype,`${group.name}: parsed Object display changed its prototype`);
      assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype),objectPrototypeDescriptors,`${group.name}: Object prototype was mutated`);
    }
  }
  assert.deepEqual(stableTypedValue(result.summaries ?? {}), expectedWithWitnesses(group.summaries ?? {}, states), `${group.name}: exact summaries`);
  if (group.groups) {
    const byId = new Map(q3Files.map(file => [file.id, file.path]));
    const membership = paths => JSON.stringify([...paths].sort());
    const expectedGroups = new Map(group.groups.map(item => [membership(item.paths), item]));
    assert.equal(expectedGroups.size, group.groups.length, `${group.name}: authored groups need distinct memberships`);
    assert.equal(result.groups.length, group.groups.length, `${group.name}: exact group count`);
    const keyIds = new Set(), actualMemberships = new Set();
    for (const actual of result.groups) {
      assert.equal(typeof actual.keyId, 'string', `${group.name}: opaque group key ID`);
      assert.ok(actual.keyId.length > 0, `${group.name}: nonempty opaque group key ID`);
      keyIds.add(actual.keyId);
      const paths = actual.entryIds.map(id => {assert.ok(byId.has(id), `${group.name}: unknown group member ${id}`);return byId.get(id);});
      const memberKey = membership(paths), expected = expectedGroups.get(memberKey);
      assert.ok(expected, `${group.name}: unexpected group membership ${memberKey}`);
      actualMemberships.add(memberKey);
      assert.deepEqual(stableTypedValue(actual.key), expectedWithWitnesses(expected.key, states), `${group.name}: exact group public key`);
      assert.deepEqual(stableTypedValue(actual.summaries ?? {}), expectedWithWitnesses(expected.summaries ?? {}, states), `${group.name}: exact group summaries`);
    }
    assert.equal(keyIds.size, result.groups.length, `${group.name}: provenance groups must retain distinct opaque key IDs`);
    assert.equal(actualMemberships.size, expectedGroups.size, `${group.name}: every authored group appears exactly once`);
  }
  assert.deepEqual(orderedDiagnostics(result.diagnostics),orderedDiagnostics(expectedDiagnostics(group,states).all),`${group.name}: exact Q3 and legacy diagnostic phase/identity/path/property/code, including duplicates`);
}

export async function runQ3Campaign({mkdir, create, build, query, exportSource, states, evidence}) {
  // Deliberately late: these notes cannot affect the original relation candidates,
  // counts, stale-snapshot cases or source-byte assertions.
  for (const [id, folder] of q3Folders) await mkdir(id, folder);
  for (const file of q3Files) await create(file);
  const snapshot = await build('q3-index');
  for (const group of q3Groups) {
    const result = await query(group.baseId, group.view, `q3-${group.name}`, snapshot,
      {clockMs: group.clockMs, timezone: group.timezone});
    assertQ3Result(result.value.result, group, states);
    evidence.checks.push({name: `Q3: ${group.name}`, snapshot,
      clockMs: group.clockMs, timezone: group.timezone,
      expectedRows: expectedWithWitnesses(group.rows, states), expectedSummaries: expectedWithWitnesses(group.summaries ?? {}, states),
      expectedGroups: expectedWithWitnesses(group.groups, states), expectedDiagnostics: expectedDiagnostics(group,states).all,
      expectedQ3Diagnostics:expectedDiagnostics(group,states).q3,expectedLegacyContextDiagnostics:expectedDiagnostics(group,states).legacy});
  }
  // Export every new authoritative input byte-for-byte after all queries. This
  // detects accidental formula materialization as well as changed note bodies.
  for (const file of q3Files) await exportSource(file);
}
