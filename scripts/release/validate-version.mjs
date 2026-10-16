import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// SemVer 2.0: numeric prerelease identifiers cannot have leading zeroes.
const numeric = '(?:0|[1-9][0-9]*)';
const prerelease = `(?:${numeric}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const semver = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
export function validateReleaseVersion({ ref, eventName, deleted = false, packageVersion }) {
  if (eventName !== 'push' || deleted || typeof ref !== 'string' || !ref.startsWith('refs/tags/v')) throw new Error('Releases require a new v-prefixed tag push.');
  const version = ref.slice('refs/tags/v'.length);
  if (!semver.test(version) || version.length > 128) throw new Error('Release tag must contain strict SemVer.');
  if (version !== packageVersion) throw new Error('Release tag version must equal package.json version.');
  return { version, tag: `v${version}`, prerelease: version.split('+')[0].includes('-') };
}
export function releaseRepository(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) throw new Error('Release repository must be owner/name.');
  return value;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const result = validateReleaseVersion({ ref: process.env.GITHUB_REF, eventName: process.env.GITHUB_EVENT_NAME, deleted: event.deleted, packageVersion: pkg.version });
  const repository = releaseRepository(process.env.GITHUB_REPOSITORY);
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required.');
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${result.version}\ntag=${result.tag}\nprerelease=${result.prerelease}\nrepository=${repository}\n`);
  console.log(`Validated ${result.tag} for ${repository}.`);
}
