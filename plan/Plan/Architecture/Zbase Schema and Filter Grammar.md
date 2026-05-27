# Zbase Schema and Filter Grammar

Status: v0 implementation handoff  
Date: 2026-05-27

## 1. Purpose

`.zbase` files define ordered views over Markdown files and their indexed metadata. They are canonical, human-readable YAML files and can be embedded from Markdown with normal wiki embed syntax.

```md
![[.zorid/views/tasks.zbase]]
![[Dashboards/tasks.zbase]]
```

`.zorid/views/` is only the default creation location. Users may place `.zbase` files anywhere in the vault.

---

## 2. v0 `.zbase` Schema

Example:

```yaml
schemaVersion: 1
id: tasks
name: Tasks

views:
  - id: table
    type: table
    name: Table
    filters:
      and:
        - zorid.type == "task"
        - status != "done"
    sort:
      - property: due
        direction: ASC
    groupBy:
      property: status
      direction: ASC

  - id: list
    type: list
    name: List
    filters:
      and:
        - zorid.type == "task"
```

### Required top-level fields

| Field | Type | Rule |
|---|---|---|
| `schemaVersion` | integer | v0 supports `1` |
| `id` | slug string | unique base ID; lowercase recommended |
| `name` | string | display name |
| `views` | array | one or more views |

### Optional top-level fields

| Field | Type | Rule |
|---|---|---|
| `description` | string | display/help text |

Unknown top-level fields: warning, preserved on write if possible.

---

## 3. View Schema

### Required view fields

| Field | Type | Rule |
|---|---|---|
| `type` | string | core readable type or plugin namespaced type |
| `name` | string | display name |
| `filters` | object | filter tree |

### Optional view fields

| Field | Type | Rule |
|---|---|---|
| `id` | slug string | generated from name if missing |
| `sort` | array | ordered sort specs |
| `groupBy` | object | grouping spec |
| `description` | string | display/help text |

View ID generation:

```text
lowercase slug from view name
conflicts get suffix: table, table-2, table-3
```

Unknown view fields are allowed because plugin renderers need custom config.

Example plugin renderer config:

```yaml
  - id: status-chart
    type: charts.bar
    name: Status Chart
    filters:
      and:
        - zorid.type == "task"
    x: status
    y:
      aggregate: count
```

Common fields are indexed separately; renderer-specific fields are stored as `config_json`.

---

## 4. Core View Types

Core readable view types:

```text
table
list
kanban
calendar
timeline
```

v0 implementation scope:

```text
table
list
```

Kanban/calendar/timeline remain valid schema values but may show “not implemented yet” until renderer support exists.

Plugin renderers use namespaced types:

```text
charts.bar
acme.matrix
vendor.plugin.renderer
```

Missing renderer behavior:

- show missing-renderer placeholder for that view;
- do not fail the whole `.zbase`;
- keep other views usable.

---

## 5. Sort Schema

```yaml
sort:
  - property: due
    direction: ASC
  - property: priority
    direction: DESC
```

Rules:

- `property` is required;
- `direction` is `ASC` or `DESC`;
- missing values sort last in v0;
- sort uses declared Type when available, otherwise inferred field type.

---

## 6. Group Schema

```yaml
groupBy:
  property: status
  direction: ASC
```

Rules:

- `property` is required;
- `direction` is `ASC` or `DESC`;
- missing values group under `No value`.

---

## 7. Filter Tree Shape

Filters use readable expression strings inside boolean trees.

```yaml
filters:
  and:
    - zorid.type == "task"
    - status != "done"
    - or:
        - priority == "high"
        - due <= today()
```

Allowed boolean keys:

```text
and
or
not
```

Rules:

- `and` and `or` values are arrays;
- `not` value is one expression or one nested filter object;
- array items may be expression strings or nested filter objects;
- empty `and` is true;
- empty `or` is false.

---

## 8. Expression Grammar

v0 expression language is Zorid-defined and parsed to AST. It must never use `eval`, `new Function`, or arbitrary JavaScript execution.

Informal grammar:

```text
expression      := unary | comparison | call | identifier
unary           := '!' expression
comparison      := operand operator operand
operator        := '==' | '!=' | '>' | '>=' | '<' | '<=' | 'in' | 'contains'
operand         := identifier | literal | list | call | member
identifier      := [A-Za-z_][A-Za-z0-9_-]*
member          := identifier ('.' identifier)*
call            := member '(' arguments? ')'
arguments       := expression (',' expression)*
literal         := string | number | boolean | null
list            := '[' (literal (',' literal)*)? ']'
```

String literals use double quotes in recommended examples:

```text
"task"
"Projects/Zorid"
```

Single quotes may be accepted by parser, but docs should prefer double quotes.

---

## 9. Supported Operators

```text
==
!=
>
>=
<
<=
in
contains
```

Examples:

```yaml
- status == "todo"
- priority in ["high", "medium"]
- estimate >= 2.5
- due <= today()
- title contains "sync"
```

`contains` works on strings and lists.

---

## 10. Supported Helpers

File helpers:

```text
file.hasTag("project")
file.hasLink("Projects/Zorid")
file.path.startsWith("Projects/")
file.path.contains("Archive")
file.name.contains("Meeting")
```

Field helpers:

```text
status.exists()
owners.contains("Casey")
```

Date/time helpers:

```text
today()
now()
```

`today()` returns the current local date. `now()` returns the current local datetime.

---

## 11. Special Fields

```text
zorid.type
file.path
file.name
file.extension
file.title
```

`zorid.type` comes from Markdown frontmatter:

```yaml
zorid:
  type: task
```

---

## 12. Missing Field Behavior

```text
missing field == null
missing.exists() -> false
missing == "x" -> false
missing != "x" -> true
missing > 1 -> false
missing contains "x" -> false
```

Required Type fields that are missing should produce a warning, not prevent the file from appearing unless the filter excludes it.

---

## 13. Type Coercion

Rules:

- Declared Type wins over inferred YAML type.
- Untyped fields use inferred YAML type.
- Number comparisons only work on numbers.
- Date comparisons only work on parsed date/datetime values.
- String comparisons are case-sensitive in v0.
- `contains` on strings is case-sensitive in v0.
- List membership checks compare normalized scalar values.

---

## 14. Validation Behavior

Invalid `.zbase` top-level schema:

- mark base invalid;
- show validation error;
- do not delete or rewrite user file automatically.

Invalid view schema or filter:

- mark that view invalid;
- show validation error in the view area;
- other valid views remain usable.

Unknown plugin renderer type:

- mark view as renderer-missing warning;
- show placeholder;
- other views remain usable.

---

## 15. v0 Acceptance Criteria

- `.zbase` YAML parses and validates.
- Multiple ordered views are supported.
- Table and list views render filtered file records.
- Filters support `and`, `or`, `not`, comparison operators, `in`, `contains`, `.exists()`, `file.hasTag()`, `file.hasLink()`, `file.path.*`, `today()`, and `now()`.
- Missing fields behave predictably.
- Invalid filters produce user-visible diagnostics without crashing the app.
- Missing plugin renderers show placeholders.
