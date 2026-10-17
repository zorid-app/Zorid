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
  files: ['**/*'],
  asar: true,
  npmRebuild: false,
  forceCodeSigning: !unsigned,
  artifactName: 'Zorid-${version}-${arch}.${ext}',
  publish: null,
  mac: {
    target: ['dmg'],
    category: 'public.app-category.productivity',
    minimumSystemVersion: '10.15',
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
  afterPack: async context => {
    const { verifyDesktopArchive } = await import('./scripts/verify-desktop-package.mjs');
    await verifyDesktopArchive(
      path.join(context.appOutDir, 'Zorid.app/Contents/Resources/app.asar'),
      path.join(__dirname, '.release/inputs.json'),
    );
  },
};
