# Apple account and TestFlight setup

Owner: Apple setup worker, branch `tingkai-c/mobile-testflight-setup`.
Native/build owner: terminal `term_bbf1787b-d2e5-402a-b366-24d40a2385c3`.
Scope: `mobile/apple/**`; builds, archives, `ios`, Rust, root manifests and GitHub
workflows remain with their assigned owners. Main integration is coordinator-owned.

## Observed state — 2026-10-17, 19:11 UTC

Authenticated official ASC API calls returned HTTP 403 with code
`FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED` for all four reads:

- Apps filtered by bundle ID `app.zorid.notes`.
- Registered bundle IDs filtered by `app.zorid.notes`.
- Team users filtered by the requested tester username.
- Pending user invitations filtered by the requested tester email.

Consequently app existence/name availability, bundle availability, internal tester
eligibility and existing invitation state are **unknown**. No remote Apple changes
were made: no app, bundle registration, group, tester invitation, certificate or
provisioning profile was created. No signing key was created, build launched or
archive uploaded. No GitHub secret, variable or workflow was changed.

GitHub read-only inspection confirmed `zorid-app/Zorid` is public, default branch
`main`, and the current CLI identity has admin/push access. Repository secret names
include `APPLE_API_ISSUER_ID`, `APPLE_API_KEY_ID`, `APPLE_API_KEY_P8_BASE64` and
`MACOS_CERTIFICATE_*`/`MACOS_SIGNING_IDENTITY`; no iOS signing secrets were listed.
Secret values were neither fetched nor displayed. Existing Developer ID signing
material is for direct macOS distribution and does not establish iOS distribution
signing readiness.

## Diagnose safely

The local credential store is `~/certificates/apple/team/app-store-connect-api`.
`metadata.txt` supplies `APP_STORE_CONNECT_KEY_ID` and
`APP_STORE_CONNECT_ISSUER_ID`; the corresponding `AuthKey_<KEY_ID>.p8` stays there.
The helper reads those files directly, creates a ten-minute JWT in memory and
prints selected resource metadata or HTTP status/error codes. It never prints
private keys, tokens, raw API responses or credential values. Do not enable shell
tracing or HTTP debug logging around credential use.

Requires Ruby with the `jwt` gem (verified locally with Ruby 3.2.8 / jwt 2.10.2).
The global `fastlane` shim currently has no Ruby version selected. Without changing
global configuration, the available local runtime can run:

```sh
mise exec ruby@3.2.8 -- ruby mobile/apple/asc.rb diagnostics
mise exec ruby@3.2.8 -- ruby mobile/apple/asc.rb status
```

`diagnostics` checks each endpoint independently and exits nonzero if any fail.
`status` stops on the first failure. Output is suitable for reviewing and manually
redacting before adding a dated repository record; do not blindly save account
resource metadata into Git. `ZORID_APPLE_API_DIRECTORY` can override the local
credential directory. It accepts a directory path, never key contents.

## Resume after account recovery

1. The Account Holder must inspect [Developer account](https://developer.apple.com/account/)
   and [App Store Connect Business](https://appstoreconnect.apple.com/business)
   and personally review required agreements. The API error does not identify
   which agreement is missing or expired. Do not assume a Paid Apps Agreement or
   payment is required. [Apple explains the Account Holder requirement](https://developer.apple.com/help/account/access/roles).
2. Rerun diagnostics. Reconcile existing app, bundle and tester records before any
   mutation. Report recovered state to the native owner.
3. If the exact bundle ID is absent from this team's list, attempt registration:
   `mise exec ruby@3.2.8 -- ruby mobile/apple/asc.rb register-bundle`.
   This command rechecks first and only registers `app.zorid.notes`, name `Zorid`,
   platform `IOS`. A missing team record alone does not prove global availability;
   successful registration is the availability evidence. This mutation has **not**
   been exercised because Apple blocked its prerequisite read.
4. If no ASC app exists, create it on the ASC website: iOS, name `Zorid`, primary
   language English, exact registered bundle, unique SKU (proposed `zorid-ios`).
   Check name availability in that flow; do not silently pick another product name.
   The [official Apps API](https://developer.apple.com/documentation/appstoreconnectapi/apps)
   explicitly directs new app creation to the website. API key credentials alone
   do not provide an interactive Apple Account session or two-factor verification.
5. Inspect whether the requested tester `tingkaichiu.ca@gmail.com` is already an ASC
   user, their eligible role and app access. Do not change unrelated users or their
   app access. Existing eligible users need no new team invitation.
6. If a new team invitation is needed, first report to the native owner that
   **Marketing** is an eligible app-limited role but grants marketing permissions,
   not merely permission to run a beta. Use only Zorid access, no reports or
   Certificates, Identifiers & Profiles access. Do not grant Admin/Finance or
   account-wide app access as a workaround. A pending invitation must be accepted
   before team eligibility can be verified. The user authorized this tester email
   invitation; no unrelated invitations are authorized.
7. Create/reuse internal group `Zorid Internal`, verify `isInternalGroup`, keep
   automatic distribution disabled, then add only the requested eligible tester.
   Do not create an external tester as a workaround for internal eligibility.
8. Coordinate iOS distribution certificate/profile ownership with the native/CI
   owner before generating private material. Store keys/passwords only in the
   authorized certificate directory or ignored secure temporary storage. A verified
   archive and processed build are still required before actual TestFlight testing.

Apple references checked 2026-10-17:
[internal testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers),
[internal tester role glossary](https://developer.apple.com/help/glossary/internal-testers/),
[app-limited user access](https://developer.apple.com/help/app-store-connect/manage-your-team/edit-access-to-apps),
[bundle registration API](https://developer.apple.com/documentation/appstoreconnectapi/post-v1-bundleids),
[add app record](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app).

## Verification boundary

Ruby syntax and actual authenticated read-only error handling were verified.
Remote setup, app name/bundle availability, tester membership, invitation delivery,
iOS signing, CI execution, archive validation and TestFlight installation remain
pending. The registration request follows the documented endpoint but is not a
verified successful remote mutation. This helper does not build, sign or upload.

## Agreed delivery secret contract

GitHub environment: `ios-testflight`. Exact secret names:

- `IOS_DISTRIBUTION_P12_BASE64`
- `IOS_DISTRIBUTION_P12_PASSWORD`
- `IOS_PROVISION_PROFILE_BASE64`
- `IOS_TEAM_ID`
- `ASC_API_KEY_ID`
- `ASC_API_ISSUER_ID`
- `ASC_API_PRIVATE_KEY_BASE64`

Apple owner provisions Apple resources and signing files. Delivery owner
`term_bd57df29-2b68-4dea-9eb6-cd708f2f457f` sets these environment secrets with
`gh` using local files/stdin after app/profile/signing readiness is verified.
No secret writes are currently ready or performed. API identifiers come from the
metadata file described above; the private API key comes from the corresponding
`.p8` file. iOS P12, password and provisioning profile paths remain pending their
creation. The Apple team identifier is present locally but is not reproduced in
messages or source. Existing repository-wide `APPLE_API_*` secrets remain untouched.

## Agreement acceptance follow-up — 2026-10-17, 19:16 UTC

The user reported signing the agreement. A refreshed, signed-in Developer account
page independently showed the Apple Developer Program License Agreement issued
October 13, 2026 and accepted October 17, 2026. No agent accepted legal terms.

Fresh-JWT retries at 19:14:30, 19:15:34 and approximately 19:16:10 UTC still returned
the same agreement HTTP 403 for all four original endpoints. The signed-in ASC
Apps/Business pages also retained the updated-license warning; selecting New App
opened an agreement-update blocker dialog instead of the creation form. The
visible app grid contained no Zorid app, but the authoritative filtered API check
remains blocked. No creation request was submitted and no invitation was sent.

The confirmed acceptance plus ASC's older warning suggests propagation delay;
this is an inference, not a verified recovery. Do not ask the user to sign again
based only on the stale ASC warning. No banking/tax action was taken or proposed
as a workaround for free TestFlight. Continue holding delivery secret writes
until Apple reads and app/profile/signing verification succeed.

Final retry in this pass: 19:17:39 UTC, all four reads still returned
`FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED`. Remote changes in this pass:
none. Safe next action is a fresh diagnostic retry after Apple updates its state;
there is no app/invitation creation attempt to repeat or clean up.
