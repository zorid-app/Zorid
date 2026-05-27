# Index Schema and Indexing Algorithm

Status: v0 implementation handoff  
Date: 2026-05-27

## 1. Principle

SQLite is derived state only. It must be safe to delete and rebuild from canonical vault files.

Canonical data:

```text
*.md
*.zbase
.zorid/types/*.ztype
.zorid/config.json
.zorid/workspace.json
```

Derived data:

```text
.zorid/index/index.sqlite
.zorid/cache/**
```

---

## 2. Indexing Algorithm

Pipeline:

```text
VaultWatcher detects changes
  -> classify changed paths
  -> debounce/batch
  -> read changed files
  -> parse by file type
  -> produce normalized records
  -> write records in one SQLite transaction
  -> emit metadata:index-updated(paths)
```

File classification:

| Extension/path | Parser |
|---|---|
| `.md` | Markdown/frontmatter parser |
| `.zbase` | Zbase parser/validator |
| `.ztype` | Type parser/validator |
| other | file metadata only |

Markdown indexing steps:

1. Read file content.
2. Parse YAML frontmatter.
3. Parse Markdown headings.
4. Extract wiki links, Markdown links, embeds, and `.zbase` embeds.
5. Extract tags from frontmatter and body.
6. Extract fields from frontmatter.
7. Resolve `zorid.type` against indexed Types.
8. Apply Type field definitions when available.
9. Normalize field values for filtering/sorting.
10. Write records.

`.ztype` indexing steps:

1. Parse YAML.
2. Validate schema.
3. Register Type ID/name.
4. Register field definitions.
5. Record duplicate/conflict/validation errors.

`.zbase` indexing steps:

1. Parse YAML.
2. Validate schema.
3. Register base ID/name.
4. Register ordered view definitions.
5. Validate common fields and filter grammar.
6. Preserve renderer-specific config.
7. Record missing renderer/invalid filter warnings.

---

## 3. Transaction Strategy

For each batch:

```text
BEGIN IMMEDIATE;
  upsert files rows
  delete old child records for changed files
  insert parsed child records
  update search_fts rows
  insert diagnostics
COMMIT;
```

For deleted paths:

```text
BEGIN IMMEDIATE;
  mark files.deleted = 1 or delete rows
  cascade child rows
  remove FTS rows
COMMIT;
```

v0 recommendation: hard-delete rows for deleted files unless history needs soft-delete later.

---

## 4. Tables

### `files`

One row per vault file.

```sql
CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  extension TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  content_hash TEXT,
  title TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('markdown', 'zbase', 'ztype', 'other')),
  indexed_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_files_kind ON files(kind);
CREATE INDEX idx_files_extension ON files(extension);
```

### `markdown`

```sql
CREATE TABLE markdown (
  file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  frontmatter_json TEXT,
  body_hash TEXT,
  zorid_type TEXT,
  word_count INTEGER,
  heading_count INTEGER
);

CREATE INDEX idx_markdown_zorid_type ON markdown(zorid_type);
```

### `headings`

```sql
CREATE TABLE headings (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  level INTEGER NOT NULL,
  text TEXT NOT NULL,
  slug TEXT NOT NULL,
  line_start INTEGER,
  line_end INTEGER,
  position INTEGER NOT NULL
);

CREATE INDEX idx_headings_file ON headings(file_id, position);
```

### `links`

```sql
CREATE TABLE links (
  id INTEGER PRIMARY KEY,
  source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  target_path TEXT,
  raw_target TEXT NOT NULL,
  link_text TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('wiki', 'markdown', 'embed', 'zbase_embed')),
  line INTEGER
);

CREATE INDEX idx_links_source ON links(source_file_id);
CREATE INDEX idx_links_target_path ON links(target_path);
CREATE INDEX idx_links_kind ON links(kind);
```

### `tags`

```sql
CREATE TABLE tags (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('frontmatter', 'body'))
);

CREATE INDEX idx_tags_tag ON tags(tag);
CREATE INDEX idx_tags_file ON tags(file_id);
```

### `types`

For `.ztype` files.

```sql
CREATE TABLE types (
  id TEXT PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  valid INTEGER NOT NULL CHECK (valid IN (0, 1)),
  errors_json TEXT
);

CREATE INDEX idx_types_file ON types(file_id);
```

### `type_fields`

```sql
CREATE TABLE type_fields (
  id INTEGER PRIMARY KEY,
  type_id TEXT NOT NULL REFERENCES types(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL,
  field_type TEXT NOT NULL CHECK (field_type IN ('string', 'int', 'float', 'boolean', 'date', 'datetime', 'select', 'multiselect')),
  options_json TEXT,
  default_json TEXT,
  required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
  position INTEGER NOT NULL,
  UNIQUE(type_id, field_key)
);

CREATE INDEX idx_type_fields_type ON type_fields(type_id, position);
CREATE INDEX idx_type_fields_key ON type_fields(field_key);
```

### `fields`

One row per Markdown frontmatter field except reserved nested `zorid` metadata.

```sql
CREATE TABLE fields (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_json TEXT,
  value_text TEXT,
  value_number REAL,
  value_bool INTEGER,
  value_date TEXT,
  inferred_type TEXT NOT NULL,
  declared_type TEXT,
  type_id TEXT,
  valid INTEGER NOT NULL DEFAULT 1 CHECK (valid IN (0, 1)),
  errors_json TEXT,
  UNIQUE(file_id, key)
);

CREATE INDEX idx_fields_key ON fields(key);
CREATE INDEX idx_fields_key_text ON fields(key, value_text);
CREATE INDEX idx_fields_key_number ON fields(key, value_number);
CREATE INDEX idx_fields_key_date ON fields(key, value_date);
CREATE INDEX idx_fields_type_id ON fields(type_id);
```

`inferred_type` values:

```text
string | int | float | boolean | date | datetime | list | object | null
```

`declared_type` is set only when the file has `zorid.type` and that Type declares the field.

### `field_values`

For list/multiselect item indexing.

```sql
CREATE TABLE field_values (
  id INTEGER PRIMARY KEY,
  field_id INTEGER NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  item_index INTEGER NOT NULL,
  item_json TEXT,
  item_text TEXT,
  item_number REAL,
  item_date TEXT
);

CREATE INDEX idx_field_values_field ON field_values(field_id, item_index);
CREATE INDEX idx_field_values_text ON field_values(item_text);
```

### `zbases`

```sql
CREATE TABLE zbases (
  id TEXT PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  valid INTEGER NOT NULL CHECK (valid IN (0, 1)),
  errors_json TEXT
);

CREATE INDEX idx_zbases_file ON zbases(file_id);
```

### `zbase_views`

```sql
CREATE TABLE zbase_views (
  id INTEGER PRIMARY KEY,
  zbase_id TEXT NOT NULL REFERENCES zbases(id) ON DELETE CASCADE,
  view_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  position INTEGER NOT NULL,
  filters_json TEXT,
  sort_json TEXT,
  group_json TEXT,
  config_json TEXT,
  valid INTEGER NOT NULL CHECK (valid IN (0, 1)),
  errors_json TEXT,
  UNIQUE(zbase_id, view_id)
);

CREATE INDEX idx_zbase_views_zbase ON zbase_views(zbase_id, position);
CREATE INDEX idx_zbase_views_type ON zbase_views(type);
```

`config_json` stores renderer-specific fields not part of the common schema.

### `index_errors`

```sql
CREATE TABLE index_errors (
  id INTEGER PRIMARY KEY,
  file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  details_json TEXT
);

CREATE INDEX idx_index_errors_file ON index_errors(file_id);
CREATE INDEX idx_index_errors_source ON index_errors(source);
CREATE INDEX idx_index_errors_severity ON index_errors(severity);
```

### `search_fts`

Simple v0 FTS table.

```sql
CREATE VIRTUAL TABLE search_fts USING fts5(
  path,
  title,
  body,
  headings,
  tags,
  fields
);
```

Implementation note: store one FTS row per Markdown file. Use the `files.id` rowid when practical so updates can replace the row deterministically.

---

## 5. Query Responsibilities

Metadata/Search APIs should hide raw SQL from plugins.

Examples:

- `metadata.getFileRecord(path)`
- `metadata.getFields(path)`
- `metadata.getBacklinks(path)`
- `metadata.queryFiles(filterAst)`
- `search.searchText(query)`

Plugins do not receive raw SQLite access in v0.

---

## 6. Rebuild

Full rebuild:

1. Move/delete old `index.sqlite`.
2. Create schema.
3. Walk vault files.
4. Index `.ztype` files first.
5. Index Markdown and `.zbase` files.
6. Emit full index-ready event.

Index `.ztype` files first so Markdown field validation can apply Type definitions in the first pass.
