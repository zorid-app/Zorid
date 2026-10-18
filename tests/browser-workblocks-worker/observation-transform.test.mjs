import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {workBlockObservationTransform} from './observation-transform.mjs';
const workerPath='/fixture/src/platform/browser-core-worker.ts';
const source='import {normal} from "./normal.ts";\nnormal();\n';
test('authorized observation transform preserves the entire exact product body and witnesses both forms',()=>{
  const hook=workBlockObservationTransform({workerPath,source,channel:'owned:proof-123'});
  const result=hook.transform(source,workerPath+'?worker_file&type=module');
  assert.ok(result.code.endsWith(source));
  const prefix=result.code.slice(0,-source.length);
  assert.equal(prefix.split('\n').filter(Boolean).length,2);
  assert.equal(createHash('sha256').update(source).digest('hex'),hook.proof.originalSha256);
  assert.equal(createHash('sha256').update(result.code).digest('hex'),hook.proof.transformedSha256);
  assert.equal(createHash('sha256').update(prefix).digest('hex'),hook.proof.prependSha256);
});
test('transform cannot affect a registry/module substitute or accept changed frozen Worker bytes',()=>{
  const hook=workBlockObservationTransform({workerPath,source,channel:'owned:proof'});
  assert.equal(hook.transform('registry',workerPath.replace('browser-core-worker.ts','browser-managed-records-registry.ts')),null);
  assert.throws(()=>hook.transform(source+'changed',workerPath),/differs/);
  assert.throws(()=>workBlockObservationTransform({workerPath,source,channel:'unsafe";call()'}),/Invalid/);
});
