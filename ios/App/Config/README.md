# Native app variants

Product variant and compiler mode are separate axes. These files are checked-in
Xcode configuration, with one App target and shared resources/code.

| Shared scheme | Run / Test / Analyze | Archive / Profile | Bundle ID | Display name |
| --- | --- | --- | --- | --- |
| App | Debug | Release | app.zorid.notes | Zorid |
| App-Dev | Debug-Dev | Release-Dev | app.zorid.notes.dev | Zorid Dev |
| App-Prod | Debug-Prod | Release-Prod | app.zorid.notes | Zorid |

Legacy Debug and Release are production aliases. The named configurations exist
at both project and target level. Debug retains native Debug optimization,
DEBUG, testability and Capacitor debug settings; Release retains native Release
optimization and disables Capacitor debug. Either mode can build either variant.

Development.xcconfig and Production.xcconfig own bundle identity, display name,
ZORID_APP_ENVIRONMENT and their ZORID_DEVELOPMENT / ZORID_PRODUCTION Swift
compilation conditions. Mode wrappers retain the existing ios/debug.xcconfig
include for Debug. Target compilation conditions inherit the xcconfig values;
project-level Zorid is only the display-name default. Do not add target-level
literal identity overrides that mask these xcconfigs.

Info.plist explicitly expands CFBundleDisplayName from ZORID_APP_DISPLAY_NAME
and the nonsecret ZoridAppEnvironment from ZORID_APP_ENVIRONMENT. Setting only
INFOPLIST_KEY_CFBundleDisplayName cannot replace that explicit Info.plist value.
AppVariant.current reads the environment enum from bundle metadata and returns
nil for unknown/missing metadata or a mismatch with the explicit variant compile
condition (including missing/conflicting conditions). It does not infer variant
from DEBUG or signing method. No current feature behavior differs by variant.

## Future strings, assets and native UI

Native SwiftUI/UIKit can consult AppVariant.current when a specific future
variant distinction is approved; compile-only code can use ZORID_DEVELOPMENT or
ZORID_PRODUCTION. Keep common strings, asset catalogs and UI shared. Add narrowly
scoped localization-table/asset-name selection at the actual call site if needed;
no alternate tables, icon sets, resources, or duplicate app have been invented.
No variant API is exposed to the shared web editor yet.

## Delivery boundary

The target/product remain App / App.app. Existing shipping App + Release and
simulator App + Debug callers remain production aliases. The SDK-specific Rust
library paths, bridging header and linker flags are unchanged; configuration
selection does not build Rust or choose a new Rust profile.

Development delivery scripts formerly built Debug with command-line bundle/name
overrides. Bundle/name overrides alone do not select environment or compile
flags. The delivery owner must select Debug-Dev (and its Debug-Dev-iphoneos output
path), or Release-Dev for optimized development, before relying on environment
metadata. Use scheme App-Dev or pass the matching configuration explicitly; do
not combine a prod configuration with dev bundle overrides. Script changes and
signing/provisioning are owned by delivery, not this config layer. Separate bundle
IDs use separate app containers; no cross-variant vault sharing/migration is added.

Source validation covers plist/project syntax, xcconfig includes, the six-config
matrix, scheme target/config references, mode settings and unchanged Rust links.
Xcode-resolved settings, signing, install/coexistence and native behavior require
owner verification after the active build finishes. No build is implied by these
checked-in configuration files.
