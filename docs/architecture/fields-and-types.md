# Fields and Types

Status: v0 design baseline  
Date: 2026-05-27

## 1. Decision Summary

Zorid fields are frontmatter values stored directly in Markdown files. Types are optional schemas that make a subset of those fields typed, visible, validated, and editor-enhanced.

This gives Zorid Notion-like structured records while keeping Markdown files self-contained and human-readable.

Core rule:

> Fields belong to the file. A Type controls which fields are active, grouped, typed, validated, and shown with richer editors.

---

## 2. Field Syntax

v0 field syntax is YAML frontmatter.

```md
---
status: active
priority: high
due: 2026-06-01
scheduledAt: 2026-06-01T14:30:00+08:00
estimate: 2.5
count: 12
done: false
tags: [project, writing]
---
```

Inline fields and block-scoped fields are not required for v0. They may be reconsidered after the frontmatter path is working well.

---

## 3. Primitive Inference

Without a Type, Zorid still indexes fields and infers primitive value types from YAML.

| YAML value | Inferred field type |
|---|---|
| `active` | string |
| `12` | int |
| `4.5` | float |
| `true` / `false` | boolean |
| `2026-06-01` | date |
| `2026-06-01T14:30:00+08:00` | datetime |
| `[a, b]` | list |
| empty/null | null |

Inference is useful for search, sorting, filtering, and ad-hoc metadata. It does not create select/multiselect semantics by itself.

---

## 4. Types

A Type is a reusable field schema stored in the vault.

Default location:

```text
.zorid/types/*.ztype
```

Example:

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

  scheduledAt:
    type: datetime

  estimate:
    type: float

  count:
    type: int

  owners:
    type: multiselect
```

Supported v0 type definitions:

- `string`
- `int`
- `float`
- `boolean`
- `date`
- `datetime`
- `select`
- `multiselect`

`select` stores one scalar YAML value. `multiselect` stores a YAML list.

---

## 5. Linking a Markdown File to a Type

A Markdown file opts into a Type with frontmatter:

```md
---
zorid:
  type: task
status: todo
priority: high
due: 2026-06-01
---
# Fix sync conflict UI
```

User-facing term: **Type**.  
Internal implementation term: schema/type definition.

`zorid.type` should reference the Type ID, not a path. The Type registry resolves IDs from `.zorid/types/*.ztype` and reports conflicts.

---

## 6. Fields Without a Type

A file may have fields without declaring `zorid.type`.

```md
---
status: active
priority: high
---
```

This is valid.

Behavior:

- fields are indexed;
- fields can be queried by Data Views;
- primitive types are inferred from YAML;
- no select/multiselect option set is enforced;
- no Type field group is shown;
- field UI may show raw/ad-hoc fields under a generic fields panel or hide them by default.

This keeps Zorid compatible with existing Markdown/frontmatter usage and supports ad-hoc metadata.

---

## 7. UI Behavior

For typed files, fields declared by the Type are grouped inside a dedicated box.

Example UI shape:

```text
┌─ Task ──────────────────────┐
│ Status:   [todo ▼]          │
│ Priority: [high ▼]          │
│ Due:      [2026-06-01]      │
└─────────────────────────────┘

Other fields
  source: GitHub
  confidence: 0.8
```

Rules:

- the Type name is the field group title;
- declared Type fields are shown first;
- declared fields use rich editors such as select, multiselect, date picker, datetime picker, number input, checkbox, and text input;
- frontmatter fields not declared by the Type are preserved and shown separately as “Other fields” when field UI is expanded;
- missing Type fields can be shown as empty/defaultable rows;
- invalid values should be surfaced as warnings, not silently deleted.

---

## 8. Notion-Like Preservation Behavior

Zorid should copy the useful part of Notion's property behavior: values can disappear from the structured UI while their state is preserved.

If a file removes its Type:

```yaml
zorid:
  type: task
```

is removed, then:

- `status`, `priority`, `due`, and other field values remain in frontmatter;
- the `Task` field box disappears;
- fields become raw/ad-hoc metadata;
- Data Views can still query them if a view filter references them.

If the file later restores:

```yaml
zorid:
  type: task
```

then:

- the `Task` field box reappears;
- previous field values are reused;
- select/date/multiselect editors and validation resume.

This achieves Notion-like “properties come back” behavior without hiding canonical user data in a database.

---

## 9. Starting a Task Database

Zorid should present this as a Type + Base workflow, not a hidden database.

User flow:

1. Create Type: `Task`.
2. Define fields: `status`, `priority`, `due`, etc.
3. Create task notes; Zorid writes `zorid.type: task` and default field values.
4. Create or suggest a `.zbase` view over tasks.

Example `.zbase`:

```yaml
schemaVersion: 1
id: tasks
name: Tasks

views:
  - type: table
    name: Table
    filters:
      and:
        - zorid.type == "task"
    sort:
      - property: due
        direction: ASC

  - type: kanban
    name: Board
    filters:
      and:
        - zorid.type == "task"
    groupBy:
      property: status
      direction: ASC
```

Conceptual mapping:

```text
Task Type      -> field definitions and editors
Task notes     -> Markdown files with zorid.type: task
Tasks .zbase   -> views over files where zorid.type == "task"
```

---

## 10. Relationship to Templates

Types take over the v0 features previously expected from Templates:

- field schema;
- field type definitions;
- select/multiselect options;
- default field values;
- typed field editing;
- filtering by record shape via `zorid.type`.

Therefore Templates are not needed for v0 structured data.

Templates may still be useful later for body/content scaffolding, such as headings, sections, checklist structure, or starter Markdown text. They should not be required for field typing.

---

## 11. Acceptance Criteria

- Frontmatter fields are parsed and indexed.
- Files can declare `zorid.type`.
- `.ztype` files define typed fields and options.
- Typed fields render in a grouped UI box titled with the Type name.
- Undeclared frontmatter fields are preserved and treated as ad-hoc fields.
- Removing a Type hides Type-specific UI but does not delete field values.
- Re-adding a Type restores Type-specific UI using preserved values.
- Data Views can filter by `zorid.type` and by typed/ad-hoc fields.
