import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = 'https://github.com/zorid-app/Zorid';
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

/** Parse the ordinary `shasum -a 256` / `sha256sum` release manifest format. */
export function parseChecksums(text) {
  requireCondition(typeof text === 'string', 'SHA256SUMS must be text');
  const checksums = new Map();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const match = /^([a-fA-F0-9]{64}) [ *]([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    requireCondition(match, `Malformed SHA256SUMS line ${index + 1}`);
    const [, hash, name] = match;
    requireCondition(!checksums.has(name), `Duplicate checksum for ${name}`);
    checksums.set(name, hash.toLowerCase());
  }
  requireCondition(checksums.size > 0, 'SHA256SUMS is empty');
  return checksums;
}

export function caskVersion(text) {
  const versions = [...text.matchAll(/^\s*version "([^"]+)"\s*$/gm)];
  requireCondition(versions.length === 1 && stableVersion.test(versions[0][1]), 'Current cask must contain one stable version');
  return versions[0][1];
}

function compareVersions(left, right) {
  const a = left.split('.').map(BigInt);
  const b = right.split('.').map(BigInt);
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

/**
 * Generate only from a published stable release and its uploaded checksums.
 * Signing/notarization and source-workflow success are upstream publication gates;
 * neither is inferable from a checksum or a release's filename.
 */
export function releaseVersion(release) {
  requireCondition(release && typeof release === 'object', 'A GitHub release object is required');
  requireCondition(release.draft === false && release.prerelease === false, 'Only published stable releases can update Homebrew');
  requireCondition(typeof release.published_at === 'string' && Number.isFinite(Date.parse(release.published_at)), 'Release must have a publication timestamp');
  requireCondition(typeof release.tag_name === 'string' && release.tag_name.startsWith('v'), 'Release tag must be vMAJOR.MINOR.PATCH');
  const version = release.tag_name.slice(1);
  requireCondition(stableVersion.test(version), 'Release tag must be vMAJOR.MINOR.PATCH without prerelease or build suffixes');
  requireCondition(release.html_url === `${repository}/releases/tag/v${version}`, 'Release URL does not match zorid-app/Zorid and its tag');
  requireCondition(Array.isArray(release.assets), 'Release assets are missing');
  return version;
}

export function generateHomebrewCask(release, checksumText, currentCask) {
  const version = releaseVersion(release);
  const checksums = parseChecksums(checksumText);

  function assetFor(name) {
    const matches = release.assets.filter(asset => asset?.name === name);
    requireCondition(matches.length === 1, `Release must contain exactly one ${name} asset`);
    const asset = matches[0];
    requireCondition(asset.state === 'uploaded' && Number.isSafeInteger(asset.size) && asset.size > 0, `${name} is not a complete uploaded asset`);
    requireCondition(asset.browser_download_url === `${repository}/releases/download/v${version}/${name}`, `Unexpected download URL for ${name}`);
    return asset;
  }

  function verifyDigest(asset, expected) {
    if (asset.digest === undefined || asset.digest === null) return;
    requireCondition(asset.digest === `sha256:${expected}`, `GitHub asset digest does not match SHA256SUMS for ${asset.name}`);
  }

  const manifest = assetFor('SHA256SUMS');
  requireCondition(manifest.size === Buffer.byteLength(checksumText, 'utf8'), 'SHA256SUMS size does not match its release asset');
  verifyDigest(manifest, createHash('sha256').update(checksumText).digest('hex'));
  const hashes = {};
  for (const architecture of ['arm64', 'x64']) {
    const name = `Zorid-${version}-${architecture}.dmg`;
    const asset = assetFor(name);
    const hash = checksums.get(name);
    requireCondition(hash, `Missing checksum for ${name}`);
    verifyDigest(asset, hash);
    hashes[architecture] = hash;
  }

  const cask = `cask "zorid" do
  arch arm: "arm64", intel: "x64"

  version "${version}"
  sha256 arm:   "${hashes.arm64}",
         intel: "${hashes.x64}"

  url "${repository}/releases/download/v#{version}/Zorid-#{version}-#{arch}.dmg"
  name "Zorid"
  desc "Open-source Markdown workspace"
  homepage "${repository}"

  depends_on macos: ">= :ventura"

  app "Zorid.app"
end
`;

  if (currentCask !== undefined) {
    const comparison = compareVersions(version, caskVersion(currentCask));
    requireCondition(comparison >= 0, 'Refusing to downgrade the Homebrew cask');
    requireCondition(comparison !== 0 || currentCask === cask, 'Refusing to replace an existing version with different cask content');
  }
  return cask;
}

export async function main(args) {
  const options = new Map();
  const allowed = new Set(['--release-json', '--checksums', '--output', '--current-cask']);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    requireCondition(allowed.has(flag) && !options.has(flag) && args[index + 1] && !args[index + 1].startsWith('--'), `Invalid argument: ${flag}`);
    options.set(flag, args[index + 1]);
  }
  for (const flag of ['--release-json', '--checksums']) requireCondition(options.has(flag), `Missing ${flag}`);
  const release = JSON.parse(await readFile(options.get('--release-json'), 'utf8'));
  const checksums = await readFile(options.get('--checksums'), 'utf8');
  const current = options.has('--current-cask') ? await readFile(options.get('--current-cask'), 'utf8') : undefined;
  const cask = generateHomebrewCask(release, checksums, current);
  if (!options.has('--output')) {
    process.stdout.write(cask);
    return;
  }
  await writeCask(options.get('--output'), cask);
}

export async function writeCask(path, cask) {
  const output = resolve(path);
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, cask, { flag: 'wx' });
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`Homebrew cask generation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
