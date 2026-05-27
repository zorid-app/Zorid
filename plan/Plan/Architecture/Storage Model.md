# Storage Model

Status: decided for v0 direction

## Decision

Use Markdown files, `.zbase` YAML view-base files, and `.ztype` YAML Type files as canonical vault data. Use SQLite only for derived local index/cache in v0.

## Canonical data

```text
*.md
*.zbase
.zorid/types/*.ztype
.zorid/config.json
.zorid/workspace.json
```

## Derived data

```text
.zorid/index/index.sqlite
.zorid/cache/**
```

## View-base embedding

Markdown embeds a view-base file by vault-relative path:

```md
![[.zorid/views/project-tracker.zbase]]
```

`.zorid/views/` is the default creation location, but users may place `.zbase` files anywhere in the vault and embed the full path:

```md
![[Dashboards/project-tracker.zbase]]
```

## Why

- Keeps Markdown clean while using familiar embed syntax.
- Keeps view and Type definitions human-readable and sync-friendly.
- Avoids syncing live canonical SQLite files through S3/Drive.
- Lets SQLite remain disposable and rebuildable.
- Leaves room for future operation logs and CRDT-backed object types.

## Future stage

Add offline concurrent editing via operation logs:

```text
.zorid/sync/ops/devices/<device-id>/*.jsonl
```

CRDTs may be used later for selected object types such as canvas/whiteboard objects.
