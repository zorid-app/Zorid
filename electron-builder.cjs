'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const pkg = require('./package.json');
const unsigned = process.env.ZORID_UNSIGNED_BUILD === '1';
const identity = process.env.CSC_NAME?.trim();
if (!unsigned && (!identity || identity === '-' || !process.env.CSC_KEYCHAIN?.trim())) {
  throw new Error('Signed packaging requires a non-ad-hoc CSC_NAME and an explicit CSC_KEYCHAIN');
}
if (!unsigned && process.env.CSC_LINK) throw new Error('CSC_LINK conflicts with the explicit release keychain');

module.exports = {
  appId: 'app.zorid.notes',
  productName: 'Zorid',
  electronVersion: pkg.devDependencies.electron,
  directories: { app: '.release/app', output: 'release', buildResources: 'build' },
  // Renderer dependencies are bundled. Keep development modules out even when
  // changing builder defaults or inspecting the staged runtime separately.
  files: ['**/*', '!**/node_modules/**'],
  asar: true,
  extraResources: [{ from: '.release/native', to: 'native', filter: ['zorid-desktop-host'] }],
  // Returning false is electron-builder's supported externally-handled-modules
  // contract: skip both rebuilding and dependency collection. npmRebuild:false
  // alone skips this hook and still searches the development workspace when
  // the intentionally dependency-free staged app returns no modules.
  beforeBuild: async ({ appDir }) => {
    const metadata = JSON.parse(await fs.readFile(path.join(appDir, 'package.json'), 'utf8'));
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies', 'bundledDependencies', 'bundleDependencies']) {
      const value = metadata[field];
      if (value != null && (typeof value !== 'object' || Object.keys(value).length > 0)) {
        throw new Error(`Staged desktop must be dependency-free; unexpected ${field}`);
      }
    }
    return false;
  },
  forceCodeSigning: !unsigned,
  artifactName: 'Zorid-${version}-${arch}.${ext}',
  publish: null,
  mac: {
    target: ['dmg'],
    binaries: ['Contents/Resources/native/zorid-desktop-host'],
    category: 'public.app-category.productivity',
    minimumSystemVersion: '13.0',
    darkModeSupport: true,
    identity: unsigned ? null : identity,
    type: 'distribution',
    hardenedRuntime: !unsigned,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    // CI notarizes/staples the signed app before building the DMG, then the DMG.
    notarize: false,
  },
  dmg: {
    sign: !unsigned,
    format: 'UDZO',
    title: 'Zorid ${version}',
    window: { width: 540, height: 380 },
    contents: [{ x: 130, y: 190, type: 'file' }, { x: 410, y: 190, type: 'link', path: '/Applications' }],
  },
  afterSign: async context => {
    if (unsigned) return;
    const { recordSignedNativeHost } = await import('./scripts/verify-desktop-package.mjs');
    await recordSignedNativeHost(
      path.join(context.appOutDir, 'Zorid.app/Contents/Resources/app.asar'),
      path.join(__dirname, '.release/inputs.json'), identity,
      ({ 1: 'x64', 3: 'arm64' }[context.arch] ?? 'unsupported'),
    );
  },
  afterPack: async context => {
    const { verifyDesktopArchive } = await import('./scripts/verify-desktop-package.mjs');
    await verifyDesktopArchive(
      path.join(context.appOutDir, 'Zorid.app/Contents/Resources/app.asar'),
      path.join(__dirname, '.release/inputs.json'),
      { architecture: ({ 1: 'x64', 3: 'arm64' }[context.arch] ?? 'unsupported'), sourceOnly: true },
    );
  },
};
