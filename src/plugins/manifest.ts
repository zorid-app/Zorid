import type { PluginManifest } from './plugin.ts';

/** Stricter host input validation, not a reproduction of permissive discovery. */
export function validatePluginManifest(value: unknown): asserts value is PluginManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Plugin manifest must be an object');
  const fields = value as Record<string, unknown>;
  for (const key of ['id', 'name', 'version', 'minAppVersion', 'description', 'author']) {
    if (typeof fields[key] !== 'string') throw new Error(`Plugin manifest ${key} must be a string`);
    if (!['description', 'author'].includes(key) && !(fields[key] as string).trim()) {
      throw new Error(`Plugin manifest ${key} must not be empty`);
    }
  }
  for (const key of ['authorUrl', 'dir']) {
    if (fields[key] !== undefined && typeof fields[key] !== 'string') throw new Error(`Plugin manifest ${key} must be a string`);
  }
  if (fields.isDesktopOnly !== undefined && typeof fields.isDesktopOnly !== 'boolean') {
    throw new Error('Plugin manifest isDesktopOnly must be a boolean');
  }
}

/** Directory comes from discovery by the host, never from the JSON payload. */
export function parsePluginManifest(json: string, directory: string): PluginManifest {
  if (!directory.trim()) throw new Error('Plugin directory must not be empty');
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Plugin manifest must be an object');
  const fields = value as Record<string, unknown>;
  const author = fields.author;
  const manifest = { ...fields, dir: directory, author: !author || (typeof author === 'string' && author.toLowerCase() === 'obsidian') ? '' : author };
  validatePluginManifest(manifest);
  return manifest;
}

/** Numeric dotted-component comparison; deliberately not full semver. */
export function isApiVersionSupported(current: string, minimum: string): boolean {
  const parse = (version: string) => version.split('.').map(part => Number.parseInt(part, 10));
  const actual = parse(current), required = parse(minimum);
  if ([...actual, ...required].some(part => !Number.isFinite(part) || part < 0)) return false;
  for (let index = 0; index < Math.max(actual.length, required.length); index++) {
    const difference = (actual[index] ?? 0) - (required[index] ?? 0);
    if (difference) return difference > 0;
  }
  return true;
}

export interface PluginLoadPolicy {
  communityPluginsEnabled: boolean;
  allowedPlugins: boolean | readonly string[];
  isDesktopApp: boolean;
  /** Installation selection may opt in; audited installed loading does not. */
  minimumVersion?: { currentVersion: string; enforce: boolean };
  /** Release-specific exclusions are supplied by the host, not frozen here. */
  incompatibility?: (manifest: PluginManifest) => string | undefined;
}

export function pluginLoadBlockReason(manifest: PluginManifest, policy: PluginLoadPolicy): string | undefined {
  if (!policy.communityPluginsEnabled) return 'Community plugins are disabled';
  if (policy.allowedPlugins !== true && !(Array.isArray(policy.allowedPlugins) && policy.allowedPlugins.includes(manifest.id))) {
    return 'Plugin is blocked by host policy';
  }
  if (manifest.isDesktopOnly && !policy.isDesktopApp) return 'Plugin requires the desktop app';
  if (policy.minimumVersion?.enforce && !isApiVersionSupported(policy.minimumVersion.currentVersion, manifest.minAppVersion)) {
    return `Plugin requires app version ${manifest.minAppVersion}`;
  }
  return policy.incompatibility?.(manifest);
}
