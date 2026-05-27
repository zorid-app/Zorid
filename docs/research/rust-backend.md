Think of it as:

```text
TypeScript app platform
  editor
  plugins
  file watching
  storage adapters
  UI
  app lifecycle
  permissions
  cache persistence

Rust/WASM compute module
  Markdown parsing
  link extraction
  tag extraction
  frontmatter extraction
  heading/block extraction
  search indexing
  graph/backlink computation
  ranking/scoring
```

Not:

```text
Rust owns the app
```

But:

```text
Rust accelerates the expensive deterministic parts
```

## Recommended architecture

```text
Electron / Capacitor
        |
TypeScript host layer
        |
+-------------------------------+
| VaultStorage                  |
| - read/write/list/stat files  |
| - platform-specific           |
+-------------------------------+
        |
+-------------------------------+
| VaultWatcher                  |
| - desktop: fs watcher         |
| - mobile: scan/poll/resume    |
+-------------------------------+
        |
+-------------------------------+
| Index Worker                  |
| - loads Rust/WASM             |
| - batches changed files       |
+-------------------------------+
        |
+-------------------------------+
| Rust/WASM Index Engine        |
| - parse                       |
| - extract metadata            |
| - compute graph/search data   |
+-------------------------------+
        |
+-------------------------------+
| TypeScript CacheStore         |
| - IndexedDB / SQLite / files  |
| - disposable derived cache    |
+-------------------------------+
```

The Markdown files remain the source of truth.

```text
MyVault/
  Notes/
    Rust Core.md
    Plugins.md
  Daily/
    2026-05-26.md
  Assets/
    diagram.png

  .yourapp/
    config.json
    workspace.json
    cache/
      index.db
      graph.json
```

Your Rust/WASM module should not need to know where the files live. It should receive content and return structured index records.

## Good Rust boundary

Good:

```ts
const output = await indexer.indexFiles({
  files: [
    {
      path: "Notes/Rust Core.md",
      content: markdown,
      mtimeMs: 1779780000000,
      size: 4231
    }
  ]
});
```

Returns:

```ts
{
  records: [
    {
      path: "Notes/Rust Core.md",
      title: "Rust Core",
      headings: [...],
      links: [...],
      backlinksCandidates: [...],
      tags: [...],
      frontmatter: {...},
      blocks: [...],
      searchTokens: [...]
    }
  ]
}
```

Bad:

```ts
for (const line of file) {
  wasm.parseLine(line);
}
```

Avoid tiny repeated calls across the JS/WASM boundary. Send batches.

## What Rust should own

I would put this in Rust:

```text
parseMarkdown(content)
extractFrontmatter(content)
extractLinks(content)
extractTags(content)
extractHeadings(content)
extractBlockRefs(content)
buildSearchDocument(record)
scoreSearchResults(query, docs)
computeGraph(records)
computeBacklinks(records)
diffIndexRecords(oldRecord, newRecord)
```

Potentially later:

```text
fuzzy search
semantic chunk preparation
encryption
compression
sync conflict merging
large import/export transforms
```

## What TypeScript should own

Keep this in TypeScript:

```text
Electron main process
Capacitor app shell
CodeMirror editor
plugin runtime
theme system
workspace layout
command palette
file read/write
file watching
mobile lifecycle handling
database/cache persistence
permission model
settings
UI state
```

This keeps the app maintainable.

## The most important interface

Create a stable engine interface in TypeScript:

```ts
export interface IndexEngine {
  indexFiles(input: IndexFilesInput): Promise<IndexFilesOutput>;
  search(input: SearchInput): Promise<SearchOutput>;
  buildGraph(input: BuildGraphInput): Promise<BuildGraphOutput>;
}
```

Then provide a WASM implementation:

```ts
export class WasmIndexEngine implements IndexEngine {
  async indexFiles(input: IndexFilesInput): Promise<IndexFilesOutput> {
    return wasm.index_files(input);
  }

  async search(input: SearchInput): Promise<SearchOutput> {
    return wasm.search(input);
  }

  async buildGraph(input: BuildGraphInput): Promise<BuildGraphOutput> {
    return wasm.build_graph(input);
  }
}
```

Your app should depend on `IndexEngine`, not directly on WASM.

That means you can later swap:

```text
WASM index engine
native Rust sidecar
pure JS fallback
test/mock engine
```

without rewriting the app.

## Suggested project structure

```text
notes-app/
  apps/
    desktop/
      src/
        main/
          file-watcher.ts
          file-system.ts
          windows.ts
        preload/
          index.ts
        renderer/
          main.tsx

    mobile/
      src/
        main.tsx
        capacitor-storage.ts
        mobile-vault-scanner.ts

  packages/
    editor/
      src/
        codemirror/
        markdown-editor.ts
        live-preview.ts

    plugin-api/
      src/
        index.ts
        VaultAPI.ts
        WorkspaceAPI.ts
        EditorAPI.ts

    plugin-host/
      src/
        loadPlugin.ts
        permissions.ts
        sandbox.ts

    engine-api/
      src/
        IndexEngine.ts
        VaultStorage.ts
        VaultWatcher.ts
        CacheStore.ts
        types.ts

    engine-js/
      src/
        NotesEngine.ts
        DesktopVaultStorage.ts
        MobileVaultStorage.ts
        DesktopVaultWatcher.ts
        MobileVaultWatcher.ts

    engine-wasm/
      src/
        WasmIndexEngine.ts
        indexer.worker.ts

    cache/
      src/
        IndexedDbCacheStore.ts
        SqliteCacheStore.ts

    shared/
      src/
        paths.ts
        schemas.ts
        errors.ts

  crates/
    index-core/
      src/
        lib.rs
        markdown.rs
        frontmatter.rs
        links.rs
        tags.rs
        headings.rs
        search.rs
        graph.rs

    index-wasm/
      src/
        lib.rs
```

## Runtime flow

When a file changes:

```text
1. TypeScript file watcher detects changed path.
2. TypeScript storage reads the Markdown file.
3. TypeScript batches changed files.
4. Worker sends batch to Rust/WASM.
5. Rust/WASM parses and indexes.
6. Rust/WASM returns index records.
7. TypeScript writes records to cache.
8. TypeScript emits app/plugin events.
9. UI updates backlinks, graph, search, metadata.
```

Example:

```ts
watcher.onChange(async changes => {
  const markdownFiles = changes.filter(change =>
    change.path.endsWith(".md")
  );

  const files = await Promise.all(
    markdownFiles.map(async change => ({
      path: change.path,
      content: await storage.read(change.path),
      mtimeMs: change.mtimeMs,
      size: change.size
    }))
  );

  const result = await indexEngine.indexFiles({ files });

  await cache.putRecords(result.records);

  events.emit("index:updated", {
    paths: result.records.map(record => record.path)
  });
});
```

## Plugin design

Plugins should never call Rust/WASM directly.

They should call a stable TypeScript API:

```ts
app.vault.read("Notes/Rust Core.md");
app.metadata.get("Notes/Rust Core.md");
app.search.query("rust wasm");
app.workspace.openFile("Notes/Rust Core.md");
```

Internally, your app may answer some of those calls using Rust-derived cache records, but plugin authors do not need to care.

This keeps plugins portable across:

```text
desktop
mobile
future web version
future native version
```

## A good rule of thumb

Use Rust/WASM for things that are:

```text
pure
batchable
CPU-heavy
deterministic
shared across platforms
```

Use TypeScript for things that are:

```text
platform-specific
UI-related
plugin-facing
I/O-heavy
permission-sensitive
lifecycle-dependent
```

So your conclusion is right:

```text
Rust:
  complex indexing/search/graph algorithms

TypeScript:
  editor, plugins, file watcher, storage orchestration, UI
```

That gives you most of the performance upside without turning your app into a cross-platform native-build maintenance project.


![[Untitled.base]]


