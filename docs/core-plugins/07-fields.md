# Core Plugin: Fields

## Purpose

Make structured note data a first-class Zorid capability.

Fields are one of Zorid's key differentiators. They should work naturally in Markdown while powering search, data views, filters, grouping, sorting, and future automations.

Detailed field/type design lives in `Plan/Architecture/Fields and Types.md`.

## v0 decisions

- v0 field syntax is YAML frontmatter.
- Inline fields and block-scoped fields are deferred until the frontmatter model is proven.
- Files may have fields without declaring a Type.
- Files opt into a Type with `zorid.type` in frontmatter.
- Types are stored as `.ztype` files, defaulting to `.zorid/types/*.ztype`.
- A Type defines field semantics: `string`, `int`, `float`, `boolean`, `date`, `datetime`, `select`, and `multiselect`.
- Select stores one scalar YAML value; multiselect stores a YAML list.
- Type-declared fields are grouped in the field UI inside a box titled with the Type name.
- Undeclared fields remain preserved and appear as ad-hoc/other fields when shown.
- Removing `zorid.type` hides Type-specific UI but does not delete field values.
- Re-adding `zorid.type` restores the Type field box with previous values.
- Templates are not required for v0 field shape or field typing; Types take over that role.

## Example typed file

```md
---
zorid:
  type: task
status: todo
priority: high
due: 2026-06-01
estimate: 2.5
done: false
owners: [Casey, Morgan]
---
# Fix sync conflict UI
```

## Example Type

```yaml
schemaVersion: 1
id: task
name: Task

fields:
  status:
    type: select
    options: [todo, doing, done]
    default: todo

  priority:
    type: select
    options: [low, medium, high]
    default: medium

  due:
    type: date

  estimate:
    type: float

  done:
    type: boolean

  owners:
    type: multiselect
```

## v0 behavior

- Parse fields from Markdown frontmatter.
- Parse Type definitions from `.ztype` files.
- Store derived field index in `index.sqlite`.
- Provide the host-owned `ctx.fields` proxy implementation and `MetadataAPI` query helpers.
- Infer primitive value types for untyped files.
- Apply Type definitions for typed files.
- Feed Data Views filter/sort/group model.

## Uses

- `IndexEngine`
- `MetadataAPI`
- `SearchAPI`
- Feeds `DataViewsAPI` through metadata/object-store indexes; does not import Data Views internals.

## Acceptance criteria

- Fields can be queried by key.
- Field values are normalized and typed enough for sorting/filtering.
- Editing Markdown updates field index.
- Field extraction is deterministic and test-covered.
- Files can declare `zorid.type`.
- Type-declared fields render in a grouped UI box titled with the Type name.
- Removing/re-adding a Type preserves previous field values.
- Data Views can filter by `zorid.type`.

## Deferred topics

- Inline field syntax.
- Block-scoped fields.
- Type inheritance/composition.
- Folder default Types.
- Body/content Templates.
