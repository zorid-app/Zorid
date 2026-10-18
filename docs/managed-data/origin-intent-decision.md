# Private write-intent representation decision

Selected 2026-10-18 by shared-core integration coordinator. This authorizes
coordinated implementation of the reviewed contract; it is not implementation
or runtime acceptance. See origin-intent-contract.md and its exact review.

- Reserve checkpoint client UUID `f7bca1bf-2a2c-438e-b430-b3f05e5d9324` for
  host-owned managed intents. Ordinary client claims and every generic checkpoint
  API must reject it. The UUID is a namespace, not a secret or authorization.
- Use full Rust-canonical original registration/scope/operation/witness/command
  and semantic-input bytes, durably captured before first mutating dispatch.
  Current authorization remains mandatory. Committed replay precedes fresh
  preparation; a no-row old origin cannot acquire new defaults after upgrade.
- Preserve exact live-head validation in the publication transaction and explicit
  tagged committed/uncommitted settlement, including lost-response recovery and
  apply/retire races. Unknown outcomes never justify eviction or fresh identity.
- Accept bounds of32 live intents,16MiB live bytes,2MiB per request,4096 retained
  keys and16MiB charged historical metadata. Reserve settlement capacity during
  capture. These are internal bounded-stage limits, not unlimited product history.
  Existing managed replay storage already has4096/16MiB limits. Safe retention
  and compaction remain separate future work; never erase identity to gain space.
- Keep optional-only trusted lineage <=16 declarations/1MiB, test-only v2,
  zero migration-authored operations and unchanged encrypted records wire v1.
  No new DB/index/store version, dependency or public plugin API is selected.

Managed coordinator run_7a10da5526b5 assigns concrete isolated owners using the
contract's portable/native/WASM/browser/admission/transport boundaries. Start
portable lineage/intent work only after the current shared WorkBlock module
freeze; serialize shared module/registration/admission hunks. Native persistence
and browser/WASM changes follow their current-v1 freezes, never overlap active
owners or leave a generic apply bypass. Tasks delivery remains the priority.
Do not clear real vaults or provide a permissive old-request fallback.

Acceptance needs real SQLite and generated Rust/WASM with strict IDB, including
precommit/no-journal retry across upgrade separately from postcommit lost-ACK
replay, exact settlement and ordinary reserved-namespace denial. Unit fixtures
and this decision do not establish those behaviors.
