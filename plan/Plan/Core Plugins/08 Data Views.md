# Core Plugin: Data Views

## Purpose

Provide Zorid's structured-data differentiator: readable, embeddable, extensible views over files and their fields/tags/links/metadata.

Data Views should support table/list in v0 and provide the architecture for kanban, calendar, timeline, grouped views, and plugin renderers such as charts.

## v0 decisions

- Use `.zbase` as the canonical view-base file extension.
- `.zbase` files are YAML content with a custom extension.
- `.zbase` files may contain multiple views.
- `.zorid/views/` is the default creation location, but users may put `.zbase` files anywhere in the vault.
- Markdown embeds use the full vault-relative path:

```md
![[.zorid/views/project-tracker.zbase]]
![[Dashboards/project-tracker.zbase]]
```

- There is no specific-view embed syntax in v0.
- There is no `defaultView`; the order of `views:` is the UI order and the first view is shown initially.
- View IDs are lowercase and derived from file/view names, with automatic conflict suffixes when needed.
- No `sources`, `dataSources`, `source`, `query`, or `kind` wrapper in v0.
- Each view directly defines `filters`.
- Filters use readable expression strings like the user's original example, not structured AST YAML.
- Core view types use readable names: `table`, `list`, `kanban`, `calendar`, `timeline`.
- Plugins can register namespaced view types such as `charts.bar` or `vendor.plugin.renderer`.
- Types provide v0 field schemas and can be filtered with `zorid.type`.
- Templates are not required for v0 structured data; they are deferred for possible body/content scaffolding later.

## Example `.zbase`

```yaml
schemaVersion: 1
id: project-tracker
name: Project Tracker

views:
  - type: table
    name: Table
    filters:
      and:
        - file.hasLink("01 - Personal/Better ways to say it")
        - '!test.contains("abse")'
    groupBy:
      property: test
      direction: ASC
    sort:
      - property: priority
        direction: DESC

  - type: kanban
    name: Kanban
    filters:
      and:
        - file.hasTag("project")
        - status.exists()
    groupBy:
      property: status
      direction: ASC

  - type: calendar
    name: Calendar
    filters:
      and:
        - due.exists()
    date:
      property: due

  - type: timeline
    name: Timeline
    filters:
      and:
        - start.exists()
    date:
      start: start
      end: end

  - type: charts.bar
    name: Status Chart
    filters:
      and:
        - file.hasTag("project")
    x: status
    y:
      aggregate: count
```

## Filter model

The primary indexed record in v0 is a file. Filters evaluate against file metadata, fields, tags, links, paths, frontmatter, and extracted content.

Example expressions:

```yaml
filters:
  and:
    - file.hasLink("Projects/Zorid")
    - file.hasTag("project")
    - zorid.type == "task"
    - file.path.startsWith("Projects/")
    - status == "active"
    - priority >= 2
    - due.exists()
    - '!archived'
    - '!test.contains("abse")'
```

The expression language must be safe and Zorid-defined; it must not execute arbitrary JavaScript.

## Renderer extensibility

Core renderers use readable type names:

```yaml
type: table
type: kanban
type: calendar
type: timeline
```

Plugin renderers use namespaced type names:

```yaml
type: charts.bar
type: acme.matrix
type: vendor.plugin.renderer
```

Data Views resolves the type to a registered renderer. If the renderer is missing, Zorid shows a missing-renderer message instead of failing the whole base.

Conceptual host-owned proxy API (`ctx.dataViews`):

```ts
export interface DataViewsAPI {
  registerRenderer(renderer: DataViewRenderer): Disposable;
  evaluateFilters(filters: ZbaseFilters): Promise<FileRecord[]>;
  openBase(path: string): Promise<void>;
  renderEmbed(container: HTMLElement, path: string, ctx: DataViewRenderContext): Promise<Disposable>;
}
```

## Uses

- `VaultAPI`
- `MetadataAPI`
- `FieldsAPI`
- `WorkspaceAPI`
- `EditorAPI`
- `PluginRegistryAPI` only for future declared plugin renderer exports; v0 Fields/DataViews access uses host-owned `ctx.fields`/`ctx.dataViews` proxies.

## Acceptance criteria

- A Markdown note can embed a `.zbase` file with `![[path/to/file.zbase]]`.
- A `.zbase` file can contain multiple ordered views.
- Table/list view can filter, sort, and group by fields.
- Core readable view types resolve without namespacing.
- Plugin namespaced view types can be registered.
- Missing plugin renderers produce a useful placeholder/error state.
- Deleting/rebuilding `index.sqlite` does not lose `.zbase` definitions.
- The Data Views plugin exposes a public core-plugin API for future plugin renderers.

## Deferred/non-blocking topics

The v0 implementation handoff for `.zbase` and filters lives in `Plan/Architecture/Zbase Schema and Filter Grammar.md`.

These topics can be handled after the table/list v0 path works:

- visual view editor UI beyond YAML editing;
- advanced missing/moved `.zbase` recovery workflows;
- collaborative conflict handling for `.zbase` files;
- full third-party renderer dependency resolution;
- kanban/calendar/timeline renderer contracts and full implementations.
