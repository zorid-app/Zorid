/** Presentation adapter only: all selection, formulas, grouping and ordering run
 * in Rust. No renderer callback or detached metadata enters the shared query. */
import { catchUpDocumentIndex, DocumentSemanticsError } from '../core/document-semantics.ts';
import type { DocumentBaseResult, DocumentBaseValue, DocumentPin, DocumentService } from '../core/document-semantics.ts';
import type { VaultEntry } from '../core/types.ts';
import { BASE_NULL, BaseExpressionError } from './expression.ts';
import type { BaseExpressionValue } from './expression.ts';
import type { BaseQueryOptions, BaseQueryResult, BaseQueryDiagnostic } from './query.ts';
import type { BaseViewConfig } from './document.ts';

function invalid(message = 'The shared Base response does not match the saved snapshot.'): never { throw new Error(message); }
export function projectSharedBaseResult(raw: DocumentBaseResult, version: number, entries: readonly VaultEntry[], timezone = 'UTC'): BaseQueryResult {
  const result = structuredClone(raw);
  let dataBudget = 400000;
  const freezeData = (item: unknown, depth = 0): void => {
    if (--dataBudget < 0 || depth > 384) return invalid('The Base result is too large to display.');
    if (item && typeof item === 'object') { for (const child of Object.values(item)) freezeData(child, depth + 1); Object.freeze(item); }
  };
  freezeData(result);
  let remaining = 200000;
  const namespaces = new Map<string, BaseExpressionValue>();
  const value = (input: DocumentBaseValue, depth = 0): BaseExpressionValue => {
    if (--remaining < 0 || depth > 128) return invalid('The Base result is too large to display.');
    switch (input.type) {
      case 'null': return BASE_NULL;
      case 'boolean': case 'number': case 'string': return Object.freeze({ ...input });
      case 'date': return Object.freeze({ ...input, ...(!input.hasTime ? { presentationTimezone: timezone } : {}) });
      // Existing presentation values express weeks as calendar days. No query
      // arithmetic or grouping is repeated here.
      case 'duration': return Object.freeze({ ...input, days: input.days + input.weeks * 7 });
      case 'list': return Object.freeze({ type: 'list', value: Object.freeze(input.value.map(item => value(item, depth + 1))) });
      case 'object': return Object.freeze({ type: 'object', value: Object.freeze(Object.fromEntries(input.value.map(([key, item]) => [key, value(item, depth + 1)]))) });
      case 'error': {
        const error = new BaseExpressionError('unsupported', input.message);
        // Preserve Rust codes (including unavailable/numeric-domain) while
        // adapting to the preexisting renderer's Error-shaped value.
        Object.defineProperty(error, 'code', { value: input.code, enumerable: true });
        return Object.freeze({ type: 'error', error: Object.freeze(error) });
      }
      case 'file': case 'link': {
        const key = JSON.stringify(input), existing = namespaces.get(key);
        if (existing) return existing;
        // The existing view renders a namespace by name. Its inert data getter
        // is not an evaluator/host callback and cannot access a live vault.
        const projected: BaseExpressionValue = Object.freeze({ type: 'namespace', name: input.type === 'link' ? input.display ?? input.path : input.path,
          sharedValue: Object.freeze({ ...input }), get(name: string) { return name === 'path' ? Object.freeze({ type: 'string', value: input.path }) : BASE_NULL; } });
        namespaces.set(key, projected); return projected;
      }
    }
  };
  const rows = Object.freeze(result.rows.map(row => Object.freeze({ path: row.path, entryId: row.entryId, revision: row.revision,
    values: Object.freeze(Object.fromEntries(Object.entries(row.values).map(([key, item]) => [key, value(item)]))) })));
  const byId = new Map(result.rows.map((row, index) => [row.entryId, rows[index]]));
  if (byId.size !== rows.length) return invalid();
  const groups = Object.freeze(result.groups.map(group => Object.freeze({ key: group.key === null ? null : value(group.key),
    rows: Object.freeze(group.entryIds.map(id => byId.get(id) ?? invalid())) })));
  const diagnostics: BaseQueryDiagnostic[] = result.diagnostics.map(item => Object.freeze({ ...item, property: item.property ?? undefined, phase: item.phase as BaseQueryDiagnostic['phase'] }));
  const paths = new Map(entries.filter(entry => entry.entryId).map(entry => [entry.entryId, entry.path]));
  for (const issue of result.metadataIssues) {
    const path = paths.get(issue.witness.entryId) ?? '';
    if (issue.propertiesUnavailable) diagnostics.push(Object.freeze({ phase: 'input', path, code: 'unavailable', message: `Saved properties are unavailable for entry ${issue.witness.entryId} (${issue.exclusion ?? 'invalid frontmatter'}).` }));
    for (const diagnostic of issue.diagnostics) diagnostics.push(Object.freeze({ phase: 'input', path, code: diagnostic.code, message: `Saved metadata: ${diagnostic.code}` }));
  }
  const view = result.view as Readonly<Record<string, unknown>>;
  if (!view || typeof view !== 'object' || Array.isArray(view) || typeof view.type !== 'string' || typeof view.name !== 'string') return invalid();
  return Object.freeze({ version, view: view as BaseViewConfig, rows, groups,
    groupOptions: Object.freeze(result.groupOptions.map(option => Object.freeze({ ...option, key: value(option.key) }))),
    properties: Object.freeze([...result.properties]), availableProperties: Object.freeze([...result.availableProperties]),
    counts: Object.freeze({ ...result.counts }), diagnostics: Object.freeze(diagnostics),
    // Retain shared identity/coverage evidence without changing view contracts.
    shared: result,
  });
}
interface Run { active: boolean; pin?: DocumentPin; closing?: Promise<void> }
export interface SharedBaseQueryInput {
  service: DocumentService; definition: VaultEntry; current: VaultEntry; entries: readonly VaultEntry[];
  query: BaseQueryOptions; viewIndex: number; viewName?: string; version: number; isCurrent(): boolean;
}
export class SharedBaseQueryRunner {
  private runs = new Set<Run>();
  private close(run: Run): Promise<void> {
    if (run.closing) return run.closing;
    if (!run.pin) { if (!run.active) this.runs.delete(run); return Promise.resolve(); }
    run.closing = run.pin.close().then(() => { run.pin = undefined; if (!run.active) this.runs.delete(run); }).finally(() => { run.closing = undefined; });
    return run.closing;
  }
  cancel(): void { for (const run of this.runs) { run.active = false; void this.close(run).catch(() => { /* Retain ownership and retry before another pin is opened. */ }); } }
  async query(input: SharedBaseQueryInput): Promise<BaseQueryResult> {
    const run: Run = { active: true }; this.runs.add(run);
    const live = () => run.active && input.isCurrent();
    const check = () => { if (!live()) throw new DocumentSemanticsError('document_request_cancelled'); };
    try {
      await Promise.all([...this.runs].filter(other => other !== run && !other.active).map(other => this.close(other))); check();
      if (input.query.functions) return invalid('Custom Base functions are unavailable with shared document queries.');
      if (!input.definition.entryId || !input.definition.revision || !input.current.entryId || !input.current.revision) return invalid('Saved entry identity is unavailable for this Base.');
      const clockMs = input.query.now?.().getTime() ?? Date.now();
      if (!Number.isSafeInteger(clockMs)) return invalid('The Base query clock is invalid.');
      const ignorePaths = input.query.ignore ? input.entries.filter(entry => entry.type === 'file' && input.query.ignore!(entry.path)).map(entry => entry.path) : undefined;
      const maintained = await catchUpDocumentIndex(input.service, { isCurrent: live }); check();
      if (!maintained.current || !maintained.snapshot || maintained.rebuildRequired) return invalid('Saved notes are still being indexed. Refresh this Base to continue.');
      run.pin = await input.service.open(); check();
      const metadata = await run.pin.metadata(input.definition.entryId); check();
      const definition = metadata.value.entry;
      if (definition.id !== input.definition.entryId || definition.revision !== input.definition.revision || definition.path !== input.definition.path) return invalid('The Base definition changed. Refresh before editing.');
      const timezone = 'UTC';
      const options = { viewIndex: input.viewIndex, searchTerms: input.query.searchTerms, ignorePaths, clockMs, timezone, maxRows: 1000,
        currentEntryId: input.current.entryId, maxSteps: input.query.maxSteps };
      const report = await run.pin.base({ id: definition.id, viewName: input.viewName, options }); check();
      if (report.value.definition.id !== definition.id || report.value.definition.revision !== definition.revision || report.value.definition.path !== definition.path
        || JSON.stringify(report.value.result.snapshotId) !== JSON.stringify(run.pin.snapshot)) return invalid();
      return projectSharedBaseResult(report.value.result, input.version, input.entries, timezone);
    } finally { run.active = false; await this.close(run); }
  }
}
