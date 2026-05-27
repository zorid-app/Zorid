---
name: feature-plan
description: Use when the user wants to define, clarify, scope, or document a software feature before implementation. This skill runs an interview to resolve requirements, edge cases, UX/API behavior, data model needs, constraints, risks, rollout, and validation, then outputs an implementation-ready feature description/specification.
---

# Feature Plan

## Purpose

Turn an incomplete feature idea into an implementation-ready feature description. Use this skill to interview the user until the feature is clear enough that an implementation agent can build it without guessing.

## Operating Mode

This is a clarification and specification skill, not an implementation skill.

- Do not edit code or create implementation files while this skill is active.
- Ask focused questions before writing the final feature description.
- Prefer one concise interview round at a time when requirements are unclear.
- Avoid asking questions whose answers can be inferred safely from repo context or existing product patterns.
- Stop interviewing when remaining unknowns are minor enough to record as explicit assumptions.

## Interview Workflow

### 1. Capture the seed idea

Restate the feature in one or two sentences and identify the current knowns:

- user problem or goal
- target users/personas
- affected product area
- expected outcome
- obvious constraints or non-goals

If the seed idea is too vague to proceed, ask the single most important clarifying question first.

### 2. Build the requirement map

Clarify the feature across these dimensions as needed:

1. **Problem and value** — What user pain, workflow, or business goal does this solve?
2. **Users and permissions** — Who can use it? Are there roles, auth, privacy, or access rules?
3. **User experience** — Entry points, screens, states, copy, navigation, empty/loading/error states.
4. **Core behavior** — Main flows, alternate flows, edge cases, failure handling, undo/retry behavior.
5. **Data and integrations** — Data created/read/updated/deleted, storage, APIs, events, background jobs, third-party services.
6. **Configuration and defaults** — Settings, feature flags, environment differences, migration needs.
7. **Compatibility** — Platforms, browsers/devices, accessibility, localization, offline/sync constraints.
8. **Performance and scale** — Latency targets, volume expectations, caching, resource limits.
9. **Security and safety** — Threats, validation, abuse cases, secrets, auditability.
10. **Observability and operations** — Logs, metrics, analytics, admin tools, support/debuggability.
11. **Acceptance criteria** — Concrete pass/fail behavior and testable examples.
12. **Rollout** — Release strategy, migration/backfill, beta/flagging, documentation, user communication.
13. **Non-goals** — Explicitly excluded behavior to prevent scope creep.

Do not mechanically ask every category. Ask only what materially affects implementation.

### 3. Interview question style

Use questions that are easy to answer and reduce implementation ambiguity.

Good question patterns:

- “What should happen when …?”
- “Who is allowed to …?”
- “Should this be stored permanently, derived, or session-only?”
- “Is this v1 behavior or a future enhancement?”
- “What is the success criterion for …?”

Avoid vague prompts such as “Anything else?” until the final check.

### 4. Readiness gate

Before producing the final description, confirm the spec has enough detail for implementation:

- primary user flow is defined
- inputs, outputs, states, and errors are defined
- data/API/storage implications are identified or explicitly ruled out
- permissions/security constraints are identified or explicitly ruled out
- acceptance criteria are testable
- non-goals and assumptions are listed
- open questions are either resolved or clearly marked as blockers/non-blockers

If a blocker remains, ask another question instead of producing a fake-complete spec.

## Final Output Format

When interviewing is complete, output this structure:

```markdown
# Feature: <name>

## Summary
<One-paragraph implementation-oriented description.>

## Problem / Goal
<Why this feature exists and what outcome it must produce.>

## Users and Scope
- Users/personas:
- Platforms/surfaces:
- Permissions/access rules:
- In scope:
- Out of scope:

## User Experience
- Entry points:
- Main flow:
- Alternate flows:
- Empty/loading/error states:
- Accessibility/localization notes:

## Functional Requirements
1. <Requirement with precise behavior.>
2. <Requirement with precise behavior.>

## Data, API, and State Requirements
- Data model/storage:
- API/events/integrations:
- Validation rules:
- Migration/backfill needs:

## Non-Functional Requirements
- Performance:
- Security/privacy:
- Reliability/offline/sync:
- Observability/analytics:

## Acceptance Criteria
- Given <context>, when <action>, then <observable result>.
- Given <context>, when <edge case>, then <observable result>.

## Test Plan
- Unit tests:
- Integration tests:
- UI/e2e tests:
- Manual verification:

## Rollout Plan
- Feature flags/config:
- Release/migration steps:
- Documentation/support notes:

## Assumptions
- <Assumption made because it is safe or conventional.>

## Open Questions
- Blocking:
- Non-blocking / future:

## Implementation Notes
<Repo-specific hints, affected areas, dependencies, sequencing, and risks if known.>
```

Keep the final description specific enough that an implementation agent can start directly from it. If repository files were inspected, cite concrete paths in Implementation Notes.
