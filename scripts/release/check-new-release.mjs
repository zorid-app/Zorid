import { pathToFileURL } from 'node:url';
import { releaseRepository } from './validate-version.mjs';
export async function assertNewRelease({ repository, tag, token }, fetcher = fetch) {
  releaseRepository(repository);
  if (!token || !tag?.startsWith('v')) throw new Error('Release tag and GitHub token are required.');
  const response = await fetcher(`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
  if (response.status === 404) return;
  if (response.ok) throw new Error('This version already has a release; it will not be overwritten.');
  throw new Error(`Unable to check existing release (HTTP ${response.status}).`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await assertNewRelease({ repository: process.env.GITHUB_REPOSITORY, tag: process.env.RELEASE_TAG, token: process.env.GH_TOKEN }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

export async function assertTagCommit({ repository, tag, token, commit }, fetcher = fetch) {
  releaseRepository(repository);
  if (!token || !tag?.startsWith('v') || !/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('Expected source commit and authenticated tag are required.');
  const get = async endpoint => {
    const response = await fetcher(`https://api.github.com/repos/${repository}/${endpoint}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
    if (!response.ok) throw new Error(`Unable to verify source tag (HTTP ${response.status}).`);
    return response.json();
  };
  let object = (await get(`git/ref/tags/${encodeURIComponent(tag)}`)).object;
  for (let depth = 0; depth < 8; depth++) {
    if (!object || !/^[a-f0-9]{40}$/.test(object.sha || '')) throw new Error('Source tag has an invalid target.');
    if (object.type === 'commit') {
      if (object.sha !== commit) throw new Error('Source tag moved; release publication stopped.');
      return;
    }
    if (object.type !== 'tag') throw new Error('Source tag does not resolve to a commit.');
    object = (await get(`git/tags/${object.sha}`)).object;
  }
  throw new Error('Source tag nesting exceeds the verification limit.');
}

export async function assertDraftAssets({ repository, tag, token, assets }, fetcher = fetch) {
  releaseRepository(repository);
  const response = await fetcher(`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
  if (!response.ok) throw new Error(`Unable to verify uploaded release assets (HTTP ${response.status}).`);
  const release = await response.json();
  if (release.draft !== true || release.tag_name !== tag || !Array.isArray(release.assets) || release.assets.length !== assets.length) throw new Error('Draft release is incomplete or changed.');
  for (const expected of assets) {
    const actual = release.assets.find(asset => asset.name === expected.name);
    if (!actual || actual.state !== 'uploaded' || actual.size !== expected.size || actual.digest && actual.digest !== `sha256:${expected.sha256}`) throw new Error('Uploaded release asset differs from the verified file.');
  }
}
