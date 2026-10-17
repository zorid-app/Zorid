# Canvas/Bases native verification — 2026-10-17

## Initial candidate

Source `6869abf`, based on main `050d7ef`. Production build session83614
passed TypeScript and webpack with bundle-size warnings. Native session94401
used disposable fixture `/private/tmp/zorid-canvas-bases-ux-js6p8dp9` and its
isolated profile. `launched-build.json` records actual artifact hashes.

The app opened the synthetic Canvas and Work.base. Accessibility exposed the
four expected Base rows and toolbar actions. This alone did not prove layout:
the user's screenshot showed the standalone Base collapsed to a narrow centered
strip. Cause: inline-size containment removed intrinsic width while the generic
attachment host centered its children. The native gate correctly remains failed
until sizing is repaired and rechecked.

CUA native screenshot captures returned nearly white images despite the actual
rendered app shown in the user's screenshot. This is a capture limitation, not
evidence of a blank renderer. No visual verification is inferred from AX data.
The test app was quit through UI, session94401 exited0, and the read-only fixture
inventory reported no changed/added/missing vault files. No user vault was used.

Sizing repair and repeat native verification are in progress. No main
integration or completed UX outcome is claimed by this initial pass.
