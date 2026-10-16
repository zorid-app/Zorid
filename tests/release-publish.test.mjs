import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertNewRelease, assertTagCommit, assertDraftAssets } from '../scripts/release/check-new-release.mjs';
import { assembleRelease, publishRelease } from '../scripts/release/publish-macos.mjs';
function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'zorid-release-publish-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { RELEASE_VERSION: '1.2.3', RELEASE_TAG: 'v1.2.3', GITHUB_REPOSITORY: 'zorid-app/Zorid', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GH_TOKEN: 'synthetic-token' };
  for (const arch of ['arm64', 'x64']) writeFileSync(path.join(dir, `Zorid-1.2.3-${arch}.dmg`), `synthetic-${arch}`);
  const archive = (_file, args) => { if (args[0] === 'rev-parse') return env.GITHUB_SHA; writeFileSync(args[args.indexOf('-o') + 1], 'synthetic source'); };
  return { dir, env, archive };
}
test('release existence check fails closed on authorization/network/server errors and existing releases', async () => {
  const input = { repository: 'zorid-app/Zorid', tag: 'v1.2.3', token: 'synthetic-token' };
  await assertNewRelease(input, async () => ({ status: 404 }));
  for (const status of [200, 401, 403, 500]) await assert.rejects(assertNewRelease(input, async () => ({ status, ok: status === 200 })));
  await assert.rejects(assertNewRelease(input, async () => { throw new Error('offline'); }));
});
test('publication requires exactly both architectures and hashes downloaded assets', t => {
  const { dir, env, archive } = fixture(t);
  writeFileSync(path.join(dir, 'unexpected.zip'), 'extra');
  assert.throws(() => assembleRelease(dir, env, archive), /exactly/);
  rmSync(path.join(dir, 'unexpected.zip'));
  const assets = assembleRelease(dir, env, archive);
  assert.equal(assets.length, 3);
  assert.match(readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8'), /^[a-f0-9]{64}  Zorid-1.2.3-arm64.dmg\n[a-f0-9]{64}  Zorid-1.2.3-x64.dmg\n[a-f0-9]{64}  Zorid-1.2.3-source.tar.gz\n$/);
});
test('publish uploads a draft before exposing it; changed artifacts or failed upload never publish', async t => {
  const { dir, env, archive } = fixture(t); assembleRelease(dir, env, archive);
  const calls = []; const check = async () => {};
  await publishRelease(dir, env, (_file, args) => calls.push(args), check, check, check);
  assert.equal(calls.length, 2); assert.equal(calls[0][1], 'create'); assert.ok(calls[0].includes('--draft')); assert.ok(calls[0].includes('--verify-tag')); assert.ok(calls[1].includes('--draft=false'));
  const failedCalls = [];
  await assert.rejects(publishRelease(dir, env, (_file, args) => { failedCalls.push(args); throw new Error('upload failed'); }, check, check, check), /upload failed/);
  assert.equal(failedCalls.length, 1);
  writeFileSync(path.join(dir, 'Zorid-1.2.3-arm64.dmg'), 'changed');
  await assert.rejects(publishRelease(dir, env, () => assert.fail('must not publish'), check, check, check), /artifact changed/);
});

test('remote tag verification peels annotated tags and rejects moved/invalid commit targets', async () => {
  const input = { repository: 'zorid-app/Zorid', tag: 'v1.2.3', token: 'synthetic', commit: 'a'.repeat(40) };
  await assertTagCommit(input, async url => ({ ok: true, json: async () => ({ object: url.includes('/git/ref/') ? { type: 'tag', sha: 'b'.repeat(40) } : { type: 'commit', sha: input.commit } }) }));
  await assert.rejects(assertTagCommit(input, async () => ({ ok: true, json: async () => ({ object: { type: 'commit', sha: 'c'.repeat(40) } }) })), /moved/);
  await assert.rejects(assertTagCommit(input, async () => ({ ok: false, status: 403 })), /HTTP 403/);
  await assert.rejects(assertTagCommit(input, async () => ({ ok: true, json: async () => ({ object: { type: 'tag', sha: 'b'.repeat(40) } }) })), /nesting/);
});
test('draft promotion requires all uploaded assets with matching sizes and available digests', async () => {
  const input = { repository: 'zorid-app/Zorid', tag: 'v1.2.3', token: 'synthetic', assets: [{ name: 'file', size: 2, sha256: 'a'.repeat(64) }] };
  const release = { draft: true, tag_name: input.tag, assets: [{ name: 'file', state: 'uploaded', size: 2, digest: `sha256:${'a'.repeat(64)}` }] };
  await assertDraftAssets(input, async () => ({ ok: true, json: async () => release }));
  release.assets[0].size = 1;
  await assert.rejects(assertDraftAssets(input, async () => ({ ok: true, json: async () => release })), /differs/);
});
test('tag movement between draft creation and promotion leaves the draft unpublished', async t => {
  const { dir, env, archive } = fixture(t); assembleRelease(dir, env, archive);
  const calls = []; let checks = 0;
  await assert.rejects(publishRelease(dir, env, (_file, args) => calls.push(args), async () => {}, async () => { if (++checks === 2) throw new Error('tag moved'); }, async () => {}), /tag moved/);
  assert.equal(calls.length, 1); assert.equal(calls[0][1], 'create');
});
