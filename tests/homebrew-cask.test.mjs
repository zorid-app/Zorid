import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateHomebrewCask, main, parseChecksums } from '../scripts/generate-homebrew-cask.mjs';
import { resolveTagCommit, updateCask, validateManifest, validateWorkflowRun } from '../assets/homebrew-tap/scripts/update-cask.mjs';

function fixture(version = '0.1.0') {
  const hashes = { arm64: 'a'.repeat(64), x64: 'b'.repeat(64) };
  const checksums = `${hashes.arm64}  Zorid-${version}-arm64.dmg\n${hashes.x64}  Zorid-${version}-x64.dmg\n${'c'.repeat(64)}  Zorid-${version}-source.tar.gz\n`;
  const release = {
    draft: false, prerelease: false, tag_name: `v${version}`,
    published_at: '2026-10-16T16:00:00Z',
    html_url: `https://github.com/zorid-app/Zorid/releases/tag/v${version}`,
    assets: ['arm64', 'x64'].map(arch => ({
      name: `Zorid-${version}-${arch}.dmg`, state: 'uploaded', size: 1024,
      digest: `sha256:${hashes[arch]}`,
      browser_download_url: `https://github.com/zorid-app/Zorid/releases/download/v${version}/Zorid-${version}-${arch}.dmg`,
    })),
  };
  release.assets.push({
    name: 'SHA256SUMS', state: 'uploaded', size: Buffer.byteLength(checksums),
    digest: `sha256:${createHash('sha256').update(checksums).digest('hex')}`,
    browser_download_url: `https://github.com/zorid-app/Zorid/releases/download/v${version}/SHA256SUMS`,
  });
  return { release, checksums };
}

test('stable release produces a two-architecture cask with versioned URLs and real checksums', () => {
  const { release, checksums } = fixture();
  const cask = generateHomebrewCask(release, checksums);
  assert.match(cask, /arch arm: "arm64", intel: "x64"/);
  assert.match(cask, /version "0\.1\.0"/);
  assert.match(cask, new RegExp(`sha256 arm:   "${'a'.repeat(64)}",\\n         intel: "${'b'.repeat(64)}"`));
  assert.match(cask, /releases\/download\/v#\{version\}\/Zorid-#\{version\}-#\{arch\}\.dmg/);
  assert.match(cask, /app "Zorid.app"/);
  assert.match(cask, /depends_on macos: ">= :ventura"/);
  assert.doesNotMatch(cask, /no_check|:latest|zap|uninstall|preflight|postflight/);
  assert.equal(generateHomebrewCask(release, checksums, cask), cask);
});

test('drafts, prereleases, malformed tags and unexpected repositories cannot become the default cask', () => {
  for (const change of [
    { draft: true }, { prerelease: true }, { prerelease: undefined }, { published_at: null },
    { tag_name: 'v0.1.0-beta.1' }, { tag_name: 'v0.1.0+build' }, { tag_name: 'v00.1.0' },
    { tag_name: 'v0.1.0"\npostflight do' }, { tag_name: '0.1.0' },
    { html_url: 'https://github.com/unrelated/Zorid/releases/tag/v0.1.0' },
  ]) {
    const { release, checksums } = fixture();
    Object.assign(release, change);
    assert.throws(() => generateHomebrewCask(release, checksums), undefined, JSON.stringify(change));
  }
});

test('missing, incomplete, duplicate or redirected assets are rejected', () => {
  for (const mutate of [
    release => release.assets.pop(),
    release => release.assets.shift(),
    release => release.assets.push({ ...release.assets[0] }),
    release => { release.assets[0].state = 'starter'; },
    release => { release.assets[0].size = 0; },
    release => { release.assets[0].browser_download_url += '?download=1'; },
    release => { release.assets[0].browser_download_url = 'https://evil.invalid/app.dmg'; },
    release => { release.assets[0].digest = `sha256:${'0'.repeat(64)}`; },
    release => { release.assets[2].size += 1; },
    release => { release.assets[2].digest = `sha256:${'0'.repeat(64)}`; },
  ]) {
    const { release, checksums } = fixture();
    mutate(release);
    assert.throws(() => generateHomebrewCask(release, checksums));
  }
});

test('checksum parsing allows normal text/binary formats but rejects duplicates, paths and bad hashes', () => {
  assert.deepEqual([...parseChecksums(`${'A'.repeat(64)} *file.dmg\r\n`)], [['file.dmg', 'a'.repeat(64)]]);
  for (const text of ['', 'no_check  file.dmg', `${'a'.repeat(64)}  ../file.dmg`, `${'a'.repeat(64)}  a/file.dmg`,
    `${'a'.repeat(64)}  file.dmg\n${'b'.repeat(64)}  file.dmg\n`]) assert.throws(() => parseChecksums(text));
  const { release, checksums } = fixture();
  const withoutArm = checksums.replace(/^.*arm64.*\n/m, '');
  release.assets[2].size = Buffer.byteLength(withoutArm);
  release.assets[2].digest = null;
  assert.throws(() => generateHomebrewCask(release, withoutArm), /Missing checksum/);
});

test('version comparison prevents downgrades and replacing a published version with different bytes', () => {
  const initial = fixture('0.9.0');
  const current = generateHomebrewCask(initial.release, initial.checksums);
  const newer = fixture('0.10.0');
  assert.match(generateHomebrewCask(newer.release, newer.checksums, current), /version "0.10.0"/);
  const older = fixture('0.8.99');
  assert.throws(() => generateHomebrewCask(older.release, older.checksums, current), /downgrade/);
  assert.throws(() => generateHomebrewCask(initial.release, initial.checksums, current.replace('a'.repeat(64), 'd'.repeat(64))), /different cask content/);
  assert.throws(() => generateHomebrewCask(initial.release, initial.checksums, 'version :latest'), /one stable version/);
});

test('CLI writes validated output atomically and preserves the existing file when validation fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorid-homebrew-'));
  try {
    const { release, checksums } = fixture();
    const releasePath = join(dir, 'release.json');
    const sumsPath = join(dir, 'SHA256SUMS');
    const output = join(dir, 'Casks', 'zorid.rb');
    await writeFile(releasePath, JSON.stringify(release));
    await writeFile(sumsPath, checksums);
    await main(['--release-json', releasePath, '--checksums', sumsPath, '--output', output]);
    const cask = await readFile(output, 'utf8');
    assert.equal(cask, generateHomebrewCask(release, checksums));
    release.prerelease = true;
    await writeFile(releasePath, JSON.stringify(release));
    await assert.rejects(main(['--release-json', releasePath, '--checksums', sumsPath, '--output', output]), /stable/);
    assert.equal(await readFile(output, 'utf8'), cask);
    assert.deepEqual(await readdir(join(dir, 'Casks')), ['zorid.rb']);
    await assert.rejects(main(['--release-json']), /Invalid argument/);
    await assert.rejects(main(['--repository', 'evil/repo']), /Invalid argument/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('generated cask is valid Ruby syntax when the system Ruby is available', t => {
  const { release, checksums } = fixture();
  try {
    const result = execFileSync('ruby', ['-c'], { input: generateHomebrewCask(release, checksums), encoding: 'utf8' });
    assert.match(result, /Syntax OK/);
  } catch (error) {
    if (error.code === 'ENOENT') t.skip('Ruby is not installed');
    else throw error;
  }
});

function publishingFixture() {
  const { release, checksums } = fixture();
  const sha = '1'.repeat(40);
  release.assets.push({
    name: 'Zorid-0.1.0-source.tar.gz', size: 1024, state: 'uploaded', digest: `sha256:${'c'.repeat(64)}`,
    browser_download_url: 'https://github.com/zorid-app/Zorid/releases/download/v0.1.0/Zorid-0.1.0-source.tar.gz',
  });
  const manifest = {
    schemaVersion: 1, repository: 'zorid-app/Zorid', version: '0.1.0', tag: 'v0.1.0', commit: sha,
    workflow: '.github/workflows/release-macos.yml', runId: '12345', runAttempt: '2',
    assets: release.assets.filter(asset => asset.name !== 'SHA256SUMS').map(asset => ({ name: asset.name, size: asset.size, sha256: asset.digest.slice(7) })),
  };
  const manifestText = JSON.stringify(manifest);
  release.assets.push({
    name: 'release-manifest.json', state: 'uploaded', size: Buffer.byteLength(manifestText),
    digest: `sha256:${createHash('sha256').update(manifestText).digest('hex')}`,
    browser_download_url: 'https://github.com/zorid-app/Zorid/releases/download/v0.1.0/release-manifest.json',
  });
  const run = {
    id: 12345, run_attempt: 2, status: 'completed', conclusion: 'success', event: 'push',
    path: '.github/workflows/release-macos.yml', head_sha: sha, head_branch: 'v0.1.0',
    repository: { full_name: 'zorid-app/Zorid' }, head_repository: { full_name: 'zorid-app/Zorid' },
  };
  const remote = new Map([
    ['https://api.github.com/repos/zorid-app/Zorid/releases/latest', release],
    ['https://github.com/zorid-app/Zorid/releases/download/v0.1.0/SHA256SUMS', checksums],
    ['https://github.com/zorid-app/Zorid/releases/download/v0.1.0/release-manifest.json', manifestText],
    ['https://api.github.com/repos/zorid-app/Zorid/git/ref/tags/v0.1.0', { ref: 'refs/tags/v0.1.0', object: { type: 'commit', sha } }],
    ['https://api.github.com/repos/zorid-app/Zorid/actions/runs/12345/attempts/2', run],
  ]);
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push(url);
    assert.equal('Authorization' in options.headers, false);
    assert.ok(remote.has(url), `Unexpected remote request: ${url}`);
    const value = remote.get(url);
    return new Response(typeof value === 'string' ? value : JSON.stringify(value));
  };
  return { release, checksums, manifest, manifestText, run, sha, remote, requests, fetcher };
}

test('release manifest and workflow gates bind repository, tag commit and exact successful run attempt', () => {
  const data = publishingFixture();
  validateManifest(data.release, data.manifest, data.checksums);
  validateWorkflowRun(data.run, data.manifest, data.sha);
  for (const mutation of [
    { id: 54321 }, { run_attempt: 1 }, { status: 'in_progress' }, { conclusion: 'failure' },
    { event: 'pull_request' }, { path: '.github/workflows/ci.yml' }, { head_sha: '2'.repeat(40) },
    { head_branch: 'v0.2.0' }, { head_branch: 'main' },
    { repository: { full_name: 'different/Zorid' } }, { head_repository: { full_name: 'fork/Zorid' } },
  ]) assert.throws(() => validateWorkflowRun({ ...data.run, ...mutation }, data.manifest, data.sha));
  assert.throws(() => validateWorkflowRun(data.run, data.manifest, '3'.repeat(40)), /remote tag/);
  for (const mutation of [
    { schemaVersion: 2 }, { repository: 'fork/Zorid' }, { tag: 'v0.2.0' }, { version: '0.2.0' },
    { runId: '../123' }, { runAttempt: '0' }, { commit: 'not-a-sha' }, { assets: [] },
  ]) assert.throws(() => validateManifest(data.release, { ...data.manifest, ...mutation }, data.checksums));
  const modified = structuredClone(data.manifest);
  modified.assets[2].sha256 = 'f'.repeat(64);
  assert.throws(() => validateManifest(data.release, modified, data.checksums), /checksum mismatch/);
});

test('tap updater fetches metadata only and performs no write before source workflow success', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorid-tap-'));
  try {
    const data = publishingFixture();
    data.run.status = 'in_progress';
    assert.equal((await updateCask({ directory: dir, fetcher: data.fetcher })).changed, false);
    assert.deepEqual(await readdir(dir), []);
    data.run.status = 'completed';
    data.run.conclusion = 'failure';
    await assert.rejects(updateCask({ directory: dir, fetcher: data.fetcher }), /successfully/);
    assert.deepEqual(await readdir(dir), []);
    data.run.conclusion = 'success';
    assert.equal((await updateCask({ directory: dir, fetcher: data.fetcher })).changed, true);
    const output = join(dir, 'Casks/zorid.rb');
    const cask = await readFile(output, 'utf8');
    assert.equal(cask, generateHomebrewCask(data.release, data.checksums));
    assert.equal((await updateCask({ directory: dir, fetcher: data.fetcher })).changed, false);
    assert.ok(data.requests.every(url => !url.endsWith('.dmg') && !url.endsWith('.tar.gz')));
    data.release.prerelease = true;
    await assert.rejects(updateCask({ directory: dir, fetcher: data.fetcher }), /stable/);
    assert.equal(await readFile(output, 'utf8'), cask);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('tap updater protects existing versions and rejects tampered downloaded metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorid-tap-integrity-'));
  try {
    const data = publishingFixture();
    await updateCask({ directory: dir, fetcher: data.fetcher });
    const output = join(dir, 'Casks/zorid.rb');
    const next = fixture('0.2.0');
    const current = generateHomebrewCask(next.release, next.checksums);
    await writeFile(output, current);
    await assert.rejects(updateCask({ directory: dir, fetcher: data.fetcher }), /downgrade/);
    assert.equal(await readFile(output, 'utf8'), current);
    data.remote.set('https://github.com/zorid-app/Zorid/releases/download/v0.1.0/release-manifest.json', data.manifestText.replace('12345', '54321'));
    await assert.rejects(updateCask({ directory: dir, fetcher: data.fetcher }), /digest mismatch/);
    assert.equal(await readFile(output, 'utf8'), current);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('tag resolver peels annotated tags and rejects wrong refs or non-commit targets', async () => {
  const annotation = 'a'.repeat(40), commit = 'b'.repeat(40);
  const urls = [];
  const read = async url => {
    urls.push(url);
    return urls.length === 1 ? { ref: 'refs/tags/v1.2.3', object: { type: 'tag', sha: annotation } } : { object: { type: 'commit', sha: commit } };
  };
  assert.equal(await resolveTagCommit('v1.2.3', read), commit);
  assert.equal(urls[1], `https://api.github.com/repos/zorid-app/Zorid/git/tags/${annotation}`);
  await assert.rejects(resolveTagCommit('v1.2.3', async () => ({ ref: 'refs/tags/v1.2.4' })), /reference mismatch/);
  await assert.rejects(resolveTagCommit('v1.2.3', async () => ({ ref: 'refs/tags/v1.2.3', object: { type: 'tree', sha: commit } })), /resolve to a commit/);
});

test('empty release repository is a no-op and oversized metadata is rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorid-tap-empty-'));
  try {
    const result = await updateCask({ directory: dir, fetcher: async () => new Response('', { status: 404 }) });
    assert.equal(result.changed, false);
    assert.deepEqual(await readdir(dir), []);
    await assert.rejects(updateCask({ directory: dir, fetcher: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) }), /size limit/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
