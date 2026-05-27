# v1 Feature: Templates

Status: optional v1 body/content scaffolding, not required for v0 fields/types or `.zbase` data views

## Purpose

Templates provide reusable Markdown body/content scaffolding, such as headings, sections, checklist structure, and starter text.

Templates are not needed for v0 field shape or field typing. Types take over the structured-data role: `.ztype` files define fields, field types, select/multiselect options, defaults, and filtering through `zorid.type`.

## Why templates matter

Fields and Data Views are Zorid's differentiator. Types, not Templates, make field usage consistent without forcing a Notion-style database/source model in v0.

Templates may eventually support:

- creating new files with predefined Markdown body text;
- adding headings, sections, and checklist scaffolds;
- optionally selecting a Type during creation;
- inserting default content around Type-defined fields;
- powering starter-note presets.

## Possible storage

Default location:

```text
.zorid/templates/*.ztemplate
```

Potential example:

```md
---
zorid:
  type: project
status: todo
priority: medium
---
# {{title}}

## Goal

## Notes

## Next actions
```

## Relationship to Types

Templates should not be used as the query/filter identity of a note. If a Template creates a structured note, it should write the Type into frontmatter:

```md
---
zorid:
  type: project
status: active
priority: medium
---
```

Future `.zbase` views should filter by Type, not Template:

```yaml
filters:
  and:
    - zorid.type == "project"
```

## v1 open decisions

- File extension: `.ztemplate` vs `.ztmpl` vs Markdown under `.zorid/templates/`.
- Whether Templates are pure Markdown snippets or full note creation recipes.
- How Templates select or suggest a Type during note creation.
- Whether plugins can contribute Template presets.
- Whether Templates should ever include logic, variables, or prompts.
