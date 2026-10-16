import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReleaseVersion, releaseRepository } from '../scripts/release/validate-version.mjs';
const validate = (version, extra = {}) => validateReleaseVersion({ ref: `refs/tags/v${version}`, eventName: 'push', packageVersion: version, ...extra });
test('release accepts strict stable and prerelease SemVer with package equality', () => {
  assert.deepEqual(validate('1.2.3'), { tag: 'v1.2.3', version: '1.2.3', prerelease: false });
  for (const version of ['0.0.0', '1.2.3-alpha.1', '1.2.3-0', '1.2.3-x-y.z+build.01', '1.2.3+build-2']) assert.equal(validate(version).version, version);
  assert.equal(validate('1.2.3+build-2').prerelease, false);
  assert.throws(() => validate('1.2.3', { packageVersion: '1.2.4' }), /package.json/);
});
test('release rejects malformed tags, non-tag events, deletion and shell metacharacters', () => {
  for (const version of ['1.2', '01.2.3', '1.02.3', '1.2.03', '1.2.3-01', '1.2.3-a..b', '1.2.3+', '1.2.3\n', '1.2.3;echo bad', '$(id)', '1.2.3/extra']) assert.throws(() => validate(version));
  for (const extra of [{ eventName: 'workflow_dispatch' }, { eventName: 'pull_request' }, { eventName: 'release' }, { ref: 'refs/heads/v1.2.3' }, { deleted: true }]) assert.throws(() => validate('1.2.3', extra));
});
test('release repository is configurable but cannot inject a command or URL', () => {
  assert.equal(releaseRepository('zorid-app/Zorid'), 'zorid-app/Zorid');
  assert.equal(releaseRepository('private-owner/public-releases'), 'private-owner/public-releases');
  for (const value of ['', 'https://github.com/a/b', 'a/b/c', 'a/b\n', 'a/b;id', '--flag']) assert.throws(() => releaseRepository(value));
});
