import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
const workflow = parse(readFileSync(new URL('../.github/workflows/release-macos.yml', import.meta.url), 'utf8'));
test('release workflow builds only version tag pushes and isolates publication permission', () => {
  assert.deepEqual(workflow.on, { push: { tags: ['v*'] } });
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.jobs.publish.permissions, { contents: 'write' });
  assert.deepEqual(workflow.jobs.publish.needs, ['validate', 'build']);
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.deepEqual(workflow.jobs.build.strategy.matrix.include.map(row => [row.arch, row.runner]), [['arm64', 'macos-15'], ['x64', 'macos-15-intel']]);
});
test('release actions are immutable and credentials never persist through checkout or build upload', () => {
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps) {
    if (step.uses) assert.match(step.uses, /^[A-Za-z0-9/-]+@[a-f0-9]{40}$/);
    if (step.uses?.startsWith('actions/checkout@')) assert.equal(step.with['persist-credentials'], false);
  }
  const steps = workflow.jobs.build.steps;
  const cleanup = steps.findIndex(step => step.run?.includes('macos-release.mjs cleanup'));
  const upload = steps.findIndex(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert.ok(cleanup > 0 && cleanup < upload); assert.equal(steps[cleanup].if, '${{ always() }}');
  assert.equal(steps[upload].with.path, 'release/Zorid-${{ needs.validate.outputs.version }}-${{ matrix.arch }}.dmg');
  assert.equal(steps[upload].with['if-no-files-found'], 'error');
  assert.equal(steps[upload].if, undefined);
  for (const step of steps.filter(step => step.env?.MACOS_CERTIFICATE_P12_BASE64 || step.env?.APPLE_API_KEY_P8_BASE64)) assert.match(step.run, /macos-release.mjs prepare$/);
});
