#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const packageKinds = new Map([
  ['@zorid/shared', 'shared'],
  ['@zorid/platform-api', 'platform-api'],
  ['@zorid/plugin-api', 'plugin-api'],
  ['@zorid/plugin-ui', 'plugin-ui'],
  ['@zorid/ui-vue', 'ui-vue'],
  ['@zorid/desktop-shell', 'shell'],
  ['@zorid/mobile-shell', 'shell'],
  ['@zorid/desktop-app', 'app'],
  ['@zorid/mobile-app', 'app'],
  ['@zorid/file-explorer', 'implementation'],
]);

const implementationPackages = new Set([
  '@zorid/app-kernel',
  '@zorid/vault',
  '@zorid/workspace',
  '@zorid/editor',
  '@zorid/metadata',
  '@zorid/object-store',
  '@zorid/db',
  '@zorid/index-api',
  '@zorid/indexer-js',
  '@zorid/index-worker',
  '@zorid/plugin-host',
  '@zorid/sync',
]);

const pluginPackages = new Set([
  '@zorid/plugin-file-explorer',
  '@zorid/plugin-search',
  '@zorid/plugin-backlinks',
  '@zorid/plugin-outline',
  '@zorid/plugin-tags',
  '@zorid/plugin-status-bar',
  '@zorid/plugin-fields',
  '@zorid/plugin-data-views',
  '@zorid/plugin-images',
]);

for (const name of implementationPackages) packageKinds.set(name, 'implementation');
for (const name of pluginPackages) packageKinds.set(name, 'core-plugin');

const lowerLevel = new Map([
  ['@zorid/db', new Set(['@zorid/index-api'])],
  ['@zorid/indexer-js', new Set(['@zorid/index-api'])],
  ['@zorid/index-worker', new Set(['@zorid/index-api'])],
  ['@zorid/metadata', new Set(['@zorid/index-api'])],
  ['@zorid/object-store', new Set(['@zorid/db'])],
  ['@zorid/plugin-host', new Set(['@zorid/plugin-api'])],
  [
    '@zorid/app-kernel',
    new Set([
      '@zorid/plugin-host',
      '@zorid/vault',
      '@zorid/workspace',
      '@zorid/editor',
      '@zorid/metadata',
      '@zorid/object-store',
    ]),
  ],
]);

export function classifyPackage(packageName) {
  return packageKinds.get(packageName) ?? 'unknown';
}

export function isImportAllowed(ownerPackage, specifier) {
  if (!specifier.startsWith('@zorid/')) return true;
  const specifierParts = specifier.split('/');
  const targetPackage = specifierParts.length >= 2 ? `${specifierParts[0]}/${specifierParts[1]}` : specifier;
  if (ownerPackage === targetPackage) return true;
  const ownerKind = classifyPackage(ownerPackage);
  const targetKind = classifyPackage(targetPackage);

  if (ownerKind === 'shared') return false;
  if (ownerKind === 'platform-api') return specifier === '@zorid/shared';
  if (ownerKind === 'plugin-api') return specifier === '@zorid/shared' || specifier === '@zorid/platform-api';
  if (ownerKind === 'plugin-ui') return specifier === '@zorid/shared' || specifier === '@zorid/platform-api';
  if (ownerKind === 'ui-vue') return specifier === '@zorid/shared' || specifier === '@zorid/platform-api';
  if (ownerKind === 'core-plugin') {
    return (
      specifier === '@zorid/shared' ||
      specifier === '@zorid/platform-api' ||
      specifier === '@zorid/plugin-api' ||
      specifier === '@zorid/plugin-ui'
    );
  }
  if (ownerKind === 'shell') {
    return (
      specifier === '@zorid/shared' ||
      specifier === '@zorid/platform-api' ||
      targetKind === 'implementation' ||
      targetKind === 'ui-vue'
    );
  }
  if (ownerKind === 'app') {
    if (ownerPackage === '@zorid/desktop-app' && specifier === '@zorid/plugin-data-views/file-renderers') return true;
    if (ownerPackage === '@zorid/desktop-app' && specifier === '@zorid/plugin-images/file-renderers') return true;
    return targetKind !== 'core-plugin';
  }
  if (ownerKind === 'implementation') {
    return (
      specifier === '@zorid/shared' ||
      specifier === '@zorid/platform-api' ||
      (lowerLevel.get(ownerPackage)?.has(specifier) ?? false)
    );
  }
  return false;
}

function findNearestPackageJson(filePath) {
  let dir = path.dirname(filePath);
  while (dir.startsWith(repoRoot)) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readPackageName(packageJsonPath) {
  return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).name;
}

const importPattern =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"]*from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

function collectFiles(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, files);
    else if (/\.(ts|tsx|js|mjs|vue)$/.test(entry.name)) files.push(full);
  }
  return files;
}

function checkRelativeImport(ownerPackageJson, file, specifier) {
  if (!specifier.startsWith('.')) return null;
  const ownerRoot = path.dirname(ownerPackageJson);
  const resolved = path.resolve(path.dirname(file), specifier);
  if (!resolved.startsWith(ownerRoot + path.sep) && resolved !== ownerRoot) {
    return `relative import escapes package root: ${specifier}`;
  }
  return null;
}

export function checkWorkspace(root = repoRoot) {
  const roots = ['apps', 'packages', 'plugins/core'].map((segment) => path.join(root, segment));
  const errors = [];
  for (const file of roots.flatMap((dir) => collectFiles(dir))) {
    const packageJson = findNearestPackageJson(file);
    if (!packageJson) continue;
    const owner = readPackageName(packageJson);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2];
      const relativeError = checkRelativeImport(packageJson, file, specifier);
      if (relativeError) errors.push(`${path.relative(root, file)}: ${relativeError}`);
      if (!isImportAllowed(owner, specifier)) {
        errors.push(`${path.relative(root, file)}: ${owner} must not import ${specifier}`);
      }
    }
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = checkWorkspace();
  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log('import boundaries ok');
}
