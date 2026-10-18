# Maintained roadmap documentation — 2026-10-18

The user requested one roadmap across storage/core, app features, self-hosted and
hosted sync, connected web and native mobile, with explicit gates between layers.
Latest steering makes storage the immediate priority. No implementation or
built-in goal was started by this documentation task.

Owner: documentation coordinator; isolated branch `tingkai-c/product-roadmap`,
based on canonical `cc00685f`. Native owner granted one docs-only main integration
window in `msg_3ca6c5ce2a99`; native source/builds/goal remain paused. The resulting
commit is recorded in Git history; main lock is returned after integration.

The maintained plan is [docs/roadmap.md](../roadmap.md). It credits existing
foundations without declaring a whole milestone accepted, preserves deferred
requirements, excludes removed spaced repetition, and keeps speculative public
plugin design behind its discussion gate. Historical feature plans receive a
current-sequencing banner rather than losing their capability inventory.

Validation: independent platform/flow and core/scope reviews, local documentation
link checks and `git diff --check`. No runtime source, generated assets, dependencies,
databases, app builds, live services or real user content changed.

## Modular-interface follow-up

User added explicit storage/index/cache interface review. Documentation coordinator
owns isolated `tingkai-c/module-interface-roadmap`, based on `5a4e7d46`, under
one-commit docs-only grant `msg_e63b7dc758f2`. S0 reviews storage contracts during
design; S0A formally gates S1 using supported-operation/consumer coverage, concrete
service semantics and meaningful existing-consumer proof. Existing stage IDs are
preserved. `architecture/interfaces.md` is a review guide, not a frozen new API.
Independent core review approved; relative links across18 roadmap/architecture
pages and whitespace checks pass. No implementation/build/goal changes occurred.
