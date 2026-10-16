import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateHomebrewCask, parseChecksums, releaseVersion, writeCask } from './generate-homebrew-cask.mjs';

const repo = 'zorid-app/Zorid';
const web = `https://github.com/${repo}`;
const api = `https://api.github.com/repos/${repo}`;
const workflow = '.github/workflows/release-macos.yml';
const commitPattern = /^[a-f0-9]{40}$/;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function uploadedAsset(release, name) {
  const matches = release.assets.filter(asset => asset?.name === name);
  check(matches.length === 1, `Expected one uploaded ${name} asset`);
  const asset = matches[0];
  check(asset.state === 'uploaded' && Number.isSafeInteger(asset.size) && asset.size > 0, `Incomplete ${name} asset`);
  check(asset.browser_download_url === `${web}/releases/download/${release.tag_name}/${name}`, `Unexpected ${name} asset URL`);
  return asset;
}

function checkTextAsset(release, name, text) {
  const asset = uploadedAsset(release, name);
  check(asset.size === Buffer.byteLength(text), `${name} size mismatch`);
  const digest = `sha256:${createHash('sha256').update(text).digest('hex')}`;
  check(asset.digest == null || asset.digest === digest, `${name} digest mismatch`);
}

export function validateManifest(release, manifest, checksumText) {
  const version = releaseVersion(release);
  check(manifest?.schemaVersion === 1 && manifest.repository === repo, 'Unexpected release manifest schema/repository');
  check(manifest.version === version && manifest.tag === release.tag_name, 'Release manifest version/tag mismatch');
  check(commitPattern.test(manifest.commit) && manifest.workflow === workflow, 'Unexpected release manifest commit/workflow');
  for (const field of ['runId', 'runAttempt']) {
    check(typeof manifest[field] === 'string' && /^[1-9]\d*$/.test(manifest[field]) && Number.isSafeInteger(Number(manifest[field])), `Invalid manifest ${field}`);
  }
  const checksums = parseChecksums(checksumText);
  const names = [`Zorid-${version}-arm64.dmg`, `Zorid-${version}-x64.dmg`, `Zorid-${version}-source.tar.gz`];
  check(Array.isArray(manifest.assets) && manifest.assets.length === names.length, 'Release manifest must describe both DMGs and source archive');
  for (const name of names) {
    const entries = manifest.assets.filter(asset => asset?.name === name);
    check(entries.length === 1, `Release manifest must describe ${name} once`);
    const entry = entries[0];
    const asset = uploadedAsset(release, name);
    check(Number.isSafeInteger(entry.size) && entry.size > 0 && entry.size === asset.size, `Manifest size mismatch for ${name}`);
    check(typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256) && checksums.get(name) === entry.sha256, `Manifest checksum mismatch for ${name}`);
    check(asset.digest == null || asset.digest === `sha256:${entry.sha256}`, `Asset digest mismatch for ${name}`);
  }
}

export function validateWorkflowRun(run, manifest, tagCommit) {
  check(commitPattern.test(tagCommit) && tagCommit === manifest.commit, 'Release manifest commit differs from current remote tag');
  check(run?.repository?.full_name === repo && run?.head_repository?.full_name === repo, 'Release workflow belongs to a different repository');
  check(run.id === Number(manifest.runId) && run.run_attempt === Number(manifest.runAttempt), 'Release workflow run/attempt differs from manifest');
  check(run.path === workflow && run.event === 'push', 'Release was not produced by the tag release workflow');
  check(run.head_branch === manifest.tag, 'Release workflow was triggered for a different tag');
  check(run.head_sha === tagCommit, 'Release workflow commit differs from current remote tag');
  check(run.status === 'completed' && run.conclusion === 'success', 'Release workflow has not completed successfully');
}

/** Bounded public metadata requests; no token or release-provided script is used. */
async function readRemote(url, fetcher, allowMissing = false) {
  const response = await fetcher(url, {
    headers: { Accept: url.startsWith(api) ? 'application/vnd.github+json' : 'application/octet-stream' },
    signal: AbortSignal.timeout(30_000),
  });
  if (allowMissing && response.status === 404) return null;
  check(response.ok, `Metadata request failed (${response.status})`);
  check(response.body, 'Metadata response has no body');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    check(size <= 2 * 1024 * 1024, 'Metadata response exceeds the size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function resolveTagCommit(tag, readJson) {
  check(/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag), 'Invalid tag name');
  const reference = await readJson(`${api}/git/ref/tags/${tag}`);
  check(reference?.ref === `refs/tags/${tag}`, 'Remote tag reference mismatch');
  let object = reference.object;
  for (let depth = 0; depth < 6; depth++) {
    check(object && commitPattern.test(object.sha), 'Remote tag has an invalid object');
    if (object.type === 'commit') return object.sha;
    check(object.type === 'tag', 'Remote tag does not resolve to a commit');
    object = (await readJson(`${api}/git/tags/${object.sha}`)).object;
  }
  throw new Error('Remote tag annotation chain is too deep');
}

/** Fetch metadata only, then update the tap's single cask after every gate passes. */
export async function updateCask({ directory = process.cwd(), fetcher = fetch } = {}) {
  const readJson = async url => JSON.parse(await readRemote(url, fetcher));
  const latest = await readRemote(`${api}/releases/latest`, fetcher, true);
  if (latest === null) return { changed: false, reason: 'No published stable release yet' };
  const release = JSON.parse(latest);
  const version = releaseVersion(release);
  const output = resolve(directory, 'Casks/zorid.rb');
  let current;
  try { current = await readFile(output, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  // Construct canonical URLs rather than following arbitrary asset URLs from JSON.
  uploadedAsset(release, 'release-manifest.json');
  uploadedAsset(release, 'SHA256SUMS');
  const manifestText = await readRemote(`${web}/releases/download/${release.tag_name}/release-manifest.json`, fetcher);
  const checksumText = await readRemote(`${web}/releases/download/${release.tag_name}/SHA256SUMS`, fetcher);
  checkTextAsset(release, 'release-manifest.json', manifestText);
  checkTextAsset(release, 'SHA256SUMS', checksumText);
  const manifest = JSON.parse(manifestText);
  validateManifest(release, manifest, checksumText);
  const tagCommit = await resolveTagCommit(release.tag_name, readJson);
  const run = await readJson(`${api}/actions/runs/${manifest.runId}/attempts/${manifest.runAttempt}`);
  if (run.status !== 'completed') return { changed: false, reason: 'Waiting for the source release workflow to finish' };
  validateWorkflowRun(run, manifest, tagCommit);
  const cask = generateHomebrewCask(release, checksumText, current);
  if (cask === current) return { changed: false, reason: `Zorid ${version} is already current` };
  await writeCask(output, cask);
  return { changed: true, reason: `Updated Zorid to ${version}` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  updateCask().then(result => process.stdout.write(`${result.reason}\n`)).catch(error => {
    process.stderr.write(`Homebrew update failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
