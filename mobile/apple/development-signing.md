# Direct iPhone development signing

Verified 2026-10-17 at approximately 20:00 UTC, without launching a build,
simulator, Xcode GUI or signing operation.

## Observed preflight

- The local keychain has one valid Apple Development signing identity, including
  its private key (`security find-identity -v -p codesigning`). No key was exported.
- An existing **iOS Team Provisioning Profile: \*** is a development profile with
  `get-task-allow=true`, expires May 26, 2027, matches the authorized Apple team,
  and contains the certificate matching the usable local signing identity.
- The plugged-in iPhone's physical UDID is listed in that profile.
- Device services report pairing complete, Developer Mode enabled and DDI
  services available. No trust/Developer Mode action is currently indicated.
- Main's iOS target uses `app.zorid.notes`. The inspected project has no explicit
  `CODE_SIGN_ENTITLEMENTS` setting or `.entitlements` file requiring capabilities
  that would conflict with the existing wildcard profile.
- Xcode preferences contain two configured Apple account entries. Their current
  online session validity was not tested; manual signing with the installed
  identity/profile does not require a new portal session.

## Local signing contract

Private directory: `~/certificates/apple/apps/zorid/development` (0700).

- `signing-contract-private.json` (0600): bundle ID, authorized team ID, profile
  name/UUID/path, matching identity fingerprint, physical device UDID and verified
  device preflight flags. Read locally; do not print the entire file in logs.
- `current.mobileprovision` (0600): exact copy of the existing profile already
  installed under Xcode's UserData provisioning-profile directory.
- `device-details-private.json` (0600): device-service observation; contains device
  identifiers and remains outside the repository.

Manual signing settings for the delivery owner's development build:

| Setting | Value |
| --- | --- |
| `CODE_SIGN_STYLE` | `Manual` |
| `CODE_SIGN_IDENTITY` | `Apple Development`, or matching identity from local contract |
| `DEVELOPMENT_TEAM` | Read `team_id` from the local contract |
| `PROVISIONING_PROFILE_SPECIFIER` | Read `profile_name` from the local contract; quote the wildcard |
| App bundle ID | `app.zorid.notes` |

The native owner holds the exclusive heavy slot. Delivery supplies build/install
scripts; Apple owner does not launch the build. Use existing manual signing to
avoid unnecessary online provisioning while ASC is blocked. No new certificate,
bundle registration or profile was created, and no developer private material was
copied into source or CI secrets.

This is signing/device **preflight evidence**, not a successful signed build,
installation or runtime check. The actual signing operation may require an
existing keychain access prompt; report a genuine prompt if it occurs rather than
changing keychain access policy preemptively. App installation/launch and native
behavior remain with the owner. TestFlight/distribution readiness is still pending.
