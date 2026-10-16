import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertNewRelease, assertTagCommit, assertDraftAssets } from './check-new-release.mjs';
import { releaseRepository, validateReleaseVersion } from './validate-version.mjs';
export function assembleRelease(directory, env, run = execFileSync) {
  const repository = releaseRepository(env.GITHUB_REPOSITORY);
  const version = env.RELEASE_VERSION;
  validateReleaseVersion({ ref: `refs/tags/${env.RELEASE_TAG}`, eventName: 'push', packageVersion: version });
  if (!/^[0-9a-f]{40}$/.test(env.GITHUB_SHA || '') || !/^\d+$/.test(env.GITHUB_RUN_ID || '') || !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT || '')) throw new Error('Valid source commit and workflow run identity are required.');
  const names = ['arm64', 'x64'].map(arch => `Zorid-${version}-${arch}.dmg`);
  if (readdirSync(directory).sort().join('\n') !== [...names].sort().join('\n')) throw new Error('Expected exactly the two validated architecture DMGs.');
  const source = `Zorid-${version}-source.tar.gz`;
  const head = run('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== env.GITHUB_SHA) throw new Error('Source archive checkout differs from the release commit.');
  run('git', ['archive', '--format=tar.gz', `--prefix=Zorid-${version}/`, '-o', path.join(directory, source), env.GITHUB_SHA], { stdio: 'inherit' });
  names.push(source);
  const assets = names.map(name => {
    const file = path.join(directory, name); const size = statSync(file).size;
    if (!size) throw new Error('Empty release DMG.');
    return { name, size, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') };
  });
  writeFileSync(path.join(directory, 'SHA256SUMS'), assets.map(asset => `${asset.sha256}  ${asset.name}\n`).join(''));
  writeFileSync(path.join(directory, 'release-manifest.json'), `${JSON.stringify({ schemaVersion: 1, repository, version, tag: env.RELEASE_TAG, commit: env.GITHUB_SHA, workflow: '.github/workflows/release-macos.yml', runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, assets }, null, 2)}\n`);
  return assets;
}
export async function publishRelease(directory, env, run = execFileSync, check = assertNewRelease, tagCheck = assertTagCommit, assetCheck = assertDraftAssets) {
  const repository = releaseRepository(env.GITHUB_REPOSITORY);
  const parsed = validateReleaseVersion({ ref: `refs/tags/${env.RELEASE_TAG}`, eventName: 'push', packageVersion: env.RELEASE_VERSION });
  await check({ repository, tag: parsed.tag, token: env.GH_TOKEN });
  const names = [...['arm64', 'x64'].map(arch => `Zorid-${parsed.version}-${arch}.dmg`), `Zorid-${parsed.version}-source.tar.gz`];
  const manifest = JSON.parse(readFileSync(path.join(directory, 'release-manifest.json'), 'utf8'));
  if (manifest.commit !== env.GITHUB_SHA || manifest.tag !== parsed.tag || manifest.repository !== repository || manifest.assets?.length !== 3) throw new Error('Release manifest identity differs from this run.');
  for (const name of names) {
    const entry = manifest.assets.find(asset => asset.name === name);
    const bytes = readFileSync(path.join(directory, name));
    if (!entry || entry.size !== bytes.length || entry.sha256 !== createHash('sha256').update(bytes).digest('hex')) throw new Error('Release artifact changed after validation.');
  }
  const expectedSums = names.map(name => `${manifest.assets.find(asset => asset.name === name).sha256}  ${name}\n`).join('');
  if (readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8') !== expectedSums) throw new Error('Release checksums differ from manifest.');
  const notes = path.join(directory, 'release-notes.md');
  writeFileSync(notes, `macOS release ${parsed.tag}\n\nDownload the arm64 DMG for Apple Silicon or x64 DMG for Intel. Open it and drag Zorid to Applications.\n\nBoth application and disk image were Developer ID signed, notarized, stapled, and verified by the release workflow.\n\nSource commit: ${env.GITHUB_SHA}\nWorkflow: https://github.com/${repository}/actions/runs/${env.GITHUB_RUN_ID}\n\nCorresponding source, license and build/release scripts: Zorid-${parsed.version}-source.tar.gz, generated from this exact commit. The same source is available at https://github.com/${repository}/tree/${parsed.tag}.\n\nSHA256SUMS and release-manifest.json describe the published artifacts.\n`);
  const files = [...names, 'SHA256SUMS', 'release-manifest.json'].map(name => path.join(directory, name));
  const options = { stdio: 'inherit' };
  // Upload into a draft first; failed uploads cannot expose a partial public release.
  await tagCheck({ repository, tag: parsed.tag, token: env.GH_TOKEN, commit: env.GITHUB_SHA });
  run('gh', ['release', 'create', parsed.tag, ...files, '--repo', repository, '--verify-tag', '--draft', '--title', `Zorid ${parsed.version}`, '--notes-file', notes, ...(parsed.prerelease ? ['--prerelease'] : [])], options);
  const uploaded = files.map(file => ({ name: path.basename(file), size: statSync(file).size, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }));
  await assetCheck({ repository, tag: parsed.tag, token: env.GH_TOKEN, assets: uploaded });
  await tagCheck({ repository, tag: parsed.tag, token: env.GH_TOKEN, commit: env.GITHUB_SHA });
  run('gh', ['release', 'edit', parsed.tag, '--repo', repository, '--draft=false', ...(parsed.prerelease ? ['--latest=false'] : [])], options);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [action, directory] = process.argv.slice(2);
    if (!directory) throw new Error('Release asset directory is required.');
    if (action === 'prepare') assembleRelease(directory, process.env);
    else if (action === 'publish') await publishRelease(directory, process.env);
    else throw new Error('Unknown publication action.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
