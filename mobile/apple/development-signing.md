# Direct iPhone development signing

Updated 2026-10-17. Apple worker performed signing/device preflight only; the
native owner performed the builds, signing verification, install and launch
reported below under the exclusive heavy slot.

## Verified owner execution

| Owner session | Result | Scope |
| --- | --- | --- |
| `87781` | Xcode exit 65 | Manual signing rejected the existing Xcode-managed wildcard profile; a manually managed profile was required. This was a signing-style mismatch despite matching certificate/device coverage. |
| `39896` | Development phone build succeeded; codesign verification PASS | `CODE_SIGN_STYLE=Automatic`, existing authorized team, cached development identity/profile, with no provisioning-update or device-registration flags. |
| `80894` | Install exit 0 | Installed separate development app `app.zorid.notes.dev`, display name `ZoridDev`, on the connected iPhone. |
| `63110` | Launch exit 0 | Launched the installed development app. This establishes launch, not complete feature/runtime acceptance. |

These are owner-confirmed observations, not builds rerun by the Apple worker.
The formal development/production configurations imported afterward have **not**
yet been rebuilt; the successful cached build does not validate those changes.
Production app data and TestFlight/distribution remain separate.

## Existing signing/device preflight

Verified at approximately 20:00 UTC without launching a build, simulator, Xcode
GUI or signing operation:

- The local keychain had one valid Apple Development signing identity with its
  private key. No key was exported.
- The existing **iOS Team Provisioning Profile: \*** is a development profile with
  `get-task-allow=true`, expires May 26, 2027, matches the authorized Apple team,
  and contains the certificate matching the usable local signing identity.
- The connected iPhone's physical UDID is listed in that profile.
- Device services reported pairing complete, Developer Mode enabled and DDI
  services available. No trust/Developer Mode action was indicated.
- The inspected iOS project had no explicit `CODE_SIGN_ENTITLEMENTS` setting or
  `.entitlements` file requiring capabilities incompatible with the wildcard.
- Xcode preferences contained two configured Apple account entries. Their online
  session validity was not established by this read-only preference inspection.

The original preflight suggested Manual signing based on coverage alone. Owner
session `87781` disproved that recommendation for this **Xcode-managed** profile.
Use the owner-verified cached Automatic path rather than treating certificate/
device matching as proof that a managed profile supports Manual signing.

## Existing private local contract — unchanged

Directory: `~/certificates/apple/apps/zorid/development` (0700).

- `signing-contract-private.json` (0600): original preflight bundle/team/profile
  name/UUID/path, matching identity fingerprint, physical device UDID and device
  flags. This source-private contract has **not** been changed by this follow-up;
  its earlier Manual setting and production bundle must not override the verified
  cached Automatic development build settings above.
- `current.mobileprovision` (0600): exact preserved copy of the existing profile
  installed under Xcode's UserData provisioning-profile directory.
- `device-details-private.json` (0600): original device-service observation,
  including device identifiers, kept outside the repository.

Owner-verified build selection:

| Setting | Verified cached build |
| --- | --- |
| `CODE_SIGN_STYLE` | `Automatic` |
| Team | Existing authorized team from local metadata |
| Provisioning | Let Xcode select the cached managed development profile |
| Online provisioning flags | None; no provisioning-update/device-registration flags |
| App bundle ID | `app.zorid.notes.dev` |
| Display name | `ZoridDev` |

The native owner retains the exclusive build slot; root is sole Git push owner.
Apple worker has not created a certificate/profile or changed private-key access,
CI secrets or private signing contracts. No builds, simulators or uploads were
launched by this follow-up.

## One ASC readiness recheck — 20:39:59 UTC

One read-only diagnostic pass used the existing helper and private credentials
with fresh, correctly shaped JWTs for each existing key type:

- Team key: apps, bundle IDs, requested user and requested invitation all returned
  HTTP 403 `FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED`.
- Account Holder individual key (`sub=user`, no issuer): apps, requested user and
  requested invitation returned the same 403. Bundle lookup returned HTTP 401
  `NOT_AUTHORIZED`, consistent with the documented individual-key provisioning
  restriction.

The agreement gate remains blocked after the accepted agreement was previously
verified. No repeated retry, Apple write, CI secret write or duplicate support
case was performed. The original private support case remains pending; its
number, contact information and message are excluded from tracked source.
