'use strict';
const path = require('node:path');
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
  // The dependency collector can fall back from the staged app to the project.
  // Renderer dependencies are already bundled; exclude that separate collector.
  files: ['**/*', '!**/node_modules/**'],
  asar: true,
  extraResources: [{ from: '.release/native', to: 'native', filter: ['zorid-desktop-host'] }],
  npmRebuild: false,
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
