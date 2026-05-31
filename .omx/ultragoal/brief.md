Implement the approved left-sidebar search feature in one durable run with five execution stories only:
1) Left-pane UI migration: make Search the primary left-sidebar tab surface, keep right-sidebar non-search panels intact, and move search input/results off the right panel.
2) Search interaction UX: autofocus on Search tab activation; operator menu opens on focus; keyboard behavior exactly ArrowUp/ArrowDown navigate, Enter/Tab select, Esc defocus+close.
3) Runtime query engine: keep no-operator queries on existing full-text search path; add operator parsing/evaluation for path/file/tag/line/section/[property], with mixed-query AND semantics and malformed-operator fallback behavior.
4) Candidate sourcing + result quality: runtime-owned candidate data for path/file/tag/property; deterministic operator-mode excerpt fallback; maintain clickable result-open behavior.
5) Verification and hardening: implement tests per approved test spec (unit/integration/component/e2e), add observability/performance verification for stated p95 targets, and complete final cleaner + independent code-review gate.

Constraints: no new dependencies unless required; renderer must not do vault-wide scans.
Reference artifacts: .omx/plans/prd-left-sidebar-search-operators-20260531T002859Z.md and .omx/plans/test-spec-left-sidebar-search-operators-20260531T002859Z.md
