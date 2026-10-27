/** Presentation adapter only: all selection, formulas, grouping and ordering run
 * in Rust. No renderer callback or detached metadata enters the shared query. */
import { catchUpDocumentIndex, DocumentSemanticsError, documentErrorCode } from '../core/document-semantics.ts';
import type { DocumentBaseResult, DocumentBaseValue, DocumentPin, DocumentService } from '../core/document-semantics.ts';
import type { DocumentBasePreviewResult, DocumentPreviewHandle } from '../core/document-preview.ts';
import type { DocumentRuntimeUpdate } from '../core/document-runtime.ts';
import type { DocumentIndexProgress } from '../core/document-semantics.ts';
import type { VaultEntry } from '../core/types.ts';
import { createSharedBaseValueProjector } from './shared-values.ts';
import type { BaseExpressionValue } from './expression.ts';
import type { BaseQueryOptions, BaseQueryResult, BaseQueryDiagnostic } from './query.ts';
import type { BaseViewConfig, BaseValue } from './document.ts';
import { createBaseClockHost } from './clock.ts';
import type { BaseClockCapture, BaseClockHost } from './clock.ts';

function invalid(message = 'The shared Base response does not match the saved snapshot.'): never { throw new Error(message); }
export interface BaseSavedWitness { readonly entryId: string; readonly revision: string }
const witnesses = new WeakMap<BaseQueryResult, ReadonlyMap<string, BaseSavedWitness>>();
const captures = new WeakMap<BaseQueryResult, BaseClockCapture>();
const previews = new WeakMap<BaseQueryResult, DocumentBasePreviewResult>();
/** Exact read-only classification, never inferred from row IDs or display text. */
export function sharedBasePreview(result: BaseQueryResult): DocumentBasePreviewResult | undefined { return previews.get(result); }
export interface BaseSharedCoverage { readonly generationComplete: boolean; readonly metadataComplete: boolean }
const coverage = new WeakMap<BaseQueryResult, BaseSharedCoverage>();
/** Snapshot-bound coverage supplied by the admitted report, never inferred from rows. */
export function sharedBaseCoverage(result: BaseQueryResult): BaseSharedCoverage | undefined { return coverage.get(result); }

/** Exact host input retained only for wake comparisons, never row authority. */
export function sharedBaseCapture(result: BaseQueryResult): BaseClockCapture | undefined { return captures.get(result); }
/** Only Rust-produced results have witnesses; absence never creates a shared edit fallback. */
export function sharedBaseWitness(result: BaseQueryResult, path: string): BaseSavedWitness | undefined {
  if (previews.has(result)) return invalid('Indexing previews are read-only. Wait for saved results before editing.');
  const saved = witnesses.get(result);
  if (!saved) return undefined;
  return saved.get(path) ?? invalid('This saved Base result has no edit identity for the file.');
}
function projectBaseResult(raw: DocumentBaseResult|DocumentBasePreviewResult, version: number, entries: readonly VaultEntry[], timezone = 'UTC', definition?: { readonly id: string; readonly revision: string; readonly path: string }): BaseQueryResult {
  const result = structuredClone(raw);
  let dataBudget = 400000;
  const freezeData = (item: unknown, depth = 0): void => {
    if (--dataBudget < 0 || depth > 384) return invalid('The Base result is too large to display.');
    if (item && typeof item === 'object') { for (const child of Object.values(item)) freezeData(child, depth + 1); Object.freeze(item); }
  };
  freezeData(result);
  const budget = { remaining: 200000 };
  const value = createSharedBaseValueProjector(timezone, budget);
  // Decode only the core-authorized persisted configuration representation.
  // Typed display values never become YAML via labels or client inference.
  const persistedKey = (input: DocumentBaseValue, depth = 0): BaseValue => {
    if (--budget.remaining < 0 || depth > 128) return invalid('The Base group key is too large to display.');
    switch(input.type) {
      case 'null': return null;
      case 'string': case 'boolean': return input.value;
      case 'number': return Number.isFinite(input.value) ? input.value : invalid('The Base group order key is invalid.');
      case 'list': return Object.freeze(input.value.map(item=>persistedKey(item,depth+1))) as unknown as BaseValue;
      case 'object': return Object.freeze(Object.fromEntries(input.value.map(([key,item])=>[key,persistedKey(item,depth+1)])));
      default: return invalid('The shared Base group order key is not a persisted value.');
    }
  };
  const rows = Object.freeze(result.rows.map(row => Object.freeze({ path: row.path, entryId: row.entryId, revision: row.revision,
    ...(row.editValues?{editValues:Object.freeze(Object.fromEntries(Object.entries(row.editValues).map(([key,item])=>[key,value(item)])))}:{}),
    values: Object.freeze(Object.fromEntries(Object.entries(row.values).map(([key, item]) => [key, value(item)]))) })));
  const byId = new Map(result.rows.map((row, index) => [row.entryId, rows[index]]));
  if (byId.size !== rows.length) return invalid();
  const groups = Object.freeze(result.groups.map(group => {
    const keyId = (group as typeof group & { readonly keyId?: string | null }).keyId;
    if (group.key === null ? keyId !== null : typeof keyId !== 'string' || !keyId.length) return invalid('Shared Base group identity is missing.');
    return Object.freeze({ key: group.key === null ? null : value(group.key), sharedKeyId: keyId,
      ...(group.editKey!==undefined?{editKey:value(group.editKey)}:{}),...(group.orderKey!==undefined?{orderKey:persistedKey(group.orderKey)}:{}),
      ...(group.summaries ? { summaries: Object.freeze(Object.fromEntries(Object.entries(group.summaries).map(([key, item]) => [key, value(item)]))) } : {}),
      rows: Object.freeze(group.entryIds.map(id => byId.get(id) ?? invalid())) });
  }));
  const diagnostics: BaseQueryDiagnostic[] = result.diagnostics.map(item => Object.freeze({ ...item, property: item.property ?? undefined, phase: item.phase as BaseQueryDiagnostic['phase'] }));
  if ('propertyDefinitionDiagnostics' in result && Array.isArray(result.propertyDefinitionDiagnostics)) for(const diagnostic of result.propertyDefinitionDiagnostics) diagnostics.push(Object.freeze({phase:'input',path:definition?.path ?? '',property:diagnostic.property??undefined,code:diagnostic.code??'configuration',message:diagnostic.message}));
  const paths = new Map(entries.filter(entry => entry.entryId).map(entry => [entry.entryId, entry.path]));
  for (const issue of result.metadataIssues) {
    const path = paths.get(issue.witness.entryId) ?? '';
    if (issue.propertiesUnavailable) diagnostics.push(Object.freeze({ phase: 'input', path, code: 'unavailable', message: `Saved properties are unavailable for entry ${issue.witness.entryId} (${issue.exclusion ?? 'invalid frontmatter'}).` }));
    for (const diagnostic of issue.diagnostics) diagnostics.push(Object.freeze({ phase: 'input', path, code: diagnostic.code, message: `Saved metadata: ${diagnostic.code}` }));
  }
  const view = result.view as Readonly<Record<string, unknown>>;
  if (!view || typeof view !== 'object' || Array.isArray(view) || typeof view.type !== 'string' || typeof view.name !== 'string') return invalid();
  const projected = Object.freeze({
    ...('summaryPreviews' in result && result.summaryPreviews ? { summaryPreviews: Object.freeze(Object.fromEntries(Object.entries(result.summaryPreviews).map(([key,item]) => [key,value(item)]))) } : {}),
    ...('summaries' in result && result.summaries ? { summaries: Object.freeze(Object.fromEntries(Object.entries(result.summaries).map(([key,item]) => [key,value(item)]))) } : {}),
    ...('relationTargets' in result && result.relationTargets ? { relationTargets: result.relationTargets } : {}),
    version, view: view as BaseViewConfig, rows, groups,
    groupOptions: Object.freeze(result.groupOptions.map(option => {
      const keyId = (option as typeof option & { readonly keyId?: string }).keyId;
      if (typeof keyId !== 'string' || !keyId.length) return invalid('Shared Base group option identity is missing.');
      const {editKey,orderKey,...plain}=option;
      return Object.freeze({ ...plain, sharedKeyId: keyId, key: value(option.key), ...(editKey!==undefined?{editKey:value(editKey)}:{}), ...(orderKey!==undefined?{orderKey:persistedKey(orderKey)}:{}) });
    })),
    properties: Object.freeze([...result.properties]), availableProperties: Object.freeze([...result.availableProperties]),
    counts: Object.freeze({ ...result.counts }), diagnostics: Object.freeze(diagnostics),
    // Retain shared identity/coverage evidence without changing view contracts.
    shared: result,
  });
  if ('status' in result) previews.set(projected, result);
  else {
    const saved = new Map<string, BaseSavedWitness>(result.rows.map(row => [row.path, Object.freeze({ entryId: row.entryId, revision: row.revision })]));
    if (definition) saved.set(definition.path, Object.freeze({ entryId: definition.id, revision: definition.revision }));
    witnesses.set(projected, saved);
  }
  return projected;
}
export function projectSharedBaseResult(raw: DocumentBaseResult, version: number, entries: readonly VaultEntry[], timezone = 'UTC', definition?: { readonly id: string; readonly revision: string; readonly path: string }): BaseQueryResult {
  return projectBaseResult(raw, version, entries, timezone, definition);
}
export function projectSharedBasePreview(raw: DocumentBasePreviewResult, version: number, entries: readonly VaultEntry[], timezone = 'UTC'): BaseQueryResult {
  return projectBaseResult(raw, version, entries, timezone);
}
interface Run {
  active: boolean; abort: AbortController; opening: boolean; reading: boolean; finalRetry?: boolean; pin?: DocumentPin; closing?: Promise<void>;
  preview?: DocumentPreviewHandle; previewOpening?: Promise<void>; previewClosing?: Promise<void>;
  previewTask?: Promise<void>; previewRequested?: boolean; previewEnabled?: boolean;
}
export interface SharedBaseQueryInput {
  service: DocumentService; definition: VaultEntry; current: VaultEntry | null; entries: readonly VaultEntry[];
  readFile?(path: string): Promise<string>;
  query: BaseQueryOptions; viewIndex: number; viewName?: string; readonly version: number; isCurrent(): boolean; clock?: BaseClockHost;
  onPreview?(result: BaseQueryResult): void;
  onPreviewStatus?(message: string): void;
}
export class SharedBaseQueryRunner {
  private runs = new Set<Run>();
  private disposed = false;
  private clock = createBaseClockHost();
  private closePreview(run: Run): Promise<void> {
    if (run.previewClosing) return run.previewClosing;
    if (run.previewOpening) return run.previewOpening.then(() => this.closePreview(run));
    const handle = run.preview;
    if (!handle) return Promise.resolve();
    const closing = handle.close().then(() => { if (run.preview === handle) run.preview = undefined; })
      .finally(() => { if (run.previewClosing === closing) run.previewClosing = undefined; });
    run.previewClosing = closing;
    return closing;
  }
  private close(run: Run): Promise<void> {
    if (run.closing) return run.closing;
    // DocumentPin does not promise that closing may overlap an in-flight read.
    // Fence its result now, but retain the handle until that read settles.
    if (run.opening || run.reading) return this.closePreview(run);
    if (!run.pin) return this.closePreview(run).then(() => { if (!run.active && !run.opening && !run.previewTask) this.runs.delete(run); });
    run.closing = Promise.all([run.pin.close().then(() => { run.pin = undefined; }), this.closePreview(run)])
      .then(() => { if (!run.active && !run.previewTask) this.runs.delete(run); }).finally(() => { run.closing = undefined; });
    return run.closing;
  }
  private async retire(run: Run): Promise<void> {
    try { await this.close(run); }
    catch (error) {
      if (!this.disposed || run.finalRetry) throw error;
      run.finalRetry = true; await this.close(run);
    }
  }
  cancel(): void { for (const run of this.runs) { run.active = false; run.previewEnabled = false; run.abort.abort(); void this.retire(run).catch(() => { /* Keep failed closes owned; next refresh retries before opening. */ }); } }
  dispose(): void { this.disposed = true; this.cancel(); }
  async query(input: SharedBaseQueryInput): Promise<BaseQueryResult> {
    if (this.disposed) throw new DocumentSemanticsError('document_request_cancelled');
    this.cancel(); // A runner owns only its newest Base invocation.
    const run: Run = { active: true, abort: new AbortController(), opening: false, reading: false }; this.runs.add(run);
    const live = () => !this.disposed && run.active && input.isCurrent();
    const check = () => { if (!live()) throw new DocumentSemanticsError('document_request_cancelled'); };
    try {
      await Promise.all([...this.runs].filter(other => other !== run && !other.active).map(other => this.close(other))); check();
      if (input.query.functions) return invalid('Custom Base functions are unavailable with shared document queries.');
      if (!input.definition.entryId || !input.definition.revision || input.current !== null && (!input.current?.entryId || !input.current.revision)) return invalid('Saved entry identity is unavailable for this Base.');
      if (input.query.currentFilePath === null && input.current !== null) return invalid('The Base current-file context is inconsistent.');
      if (input.query.currentFileEntryId !== undefined && (!input.current || input.current.entryId !== input.query.currentFileEntryId)) return invalid('The pinned current note changed. Refresh before using this Base.');
      const ignorePaths = input.query.ignore ? input.entries.filter(entry => entry.type === 'file' && input.query.ignore!(entry.path)).map(entry => entry.path) : undefined;
      const previewSupported = !input.query.inlineSource && input.service.basePreviewAvailable === true && !!input.service.maintenance;
      if (previewSupported && typeof input.service.openPreview !== 'function') return invalid('The Base preview capability is incomplete.');
      run.previewEnabled = previewSupported && !!input.onPreview;
      const previewLive = () => live() && run.previewEnabled === true;
      const loadPreview = () => {
        if (!previewLive()) return;
        run.previewRequested = true;
        if (run.previewTask) return;
        const task = (async () => {
          while (run.previewRequested && previewLive()) {
            run.previewRequested = false;
            try {
              // An old close ACK remains owned; never open around its failure.
              for (const other of this.runs) if (other !== run && !other.active) {
                await other.previewTask; await this.closePreview(other);
              }
              await this.closePreview(run);
              if (!previewLive()) return;
              const opening = input.service.openPreview!().then(handle => { run.preview = handle ?? undefined; })
                .finally(() => { run.previewOpening = undefined; });
              run.previewOpening = opening; await opening;
              if (!previewLive()) return;
              const handle = run.preview;
              if (!handle) { input.onPreviewStatus?.('Indexing… waiting for the first indexed notes.'); continue; }
              const captured = (input.clock ?? this.clock).capture(input.query.timezone);
              const clockMs = input.query.now?.().getTime() ?? captured.clockMs;
              if (!Number.isSafeInteger(clockMs)) return invalid('The Base query clock is invalid.');
              const report = await handle.base({ id: input.definition.entryId!, viewName: input.viewName, options: {
                viewIndex: input.viewIndex, searchTerms: input.query.searchTerms, ignorePaths, clockMs, timezone: captured.timezone,
                maxRows: 10000, ...(input.current ? { currentEntryId: input.current.entryId } : {}), maxSteps: input.query.maxSteps,
              } });
              if (!previewLive()) return;
              if (report.definition.id !== input.definition.entryId || report.definition.revision !== input.definition.revision || report.definition.path !== input.definition.path) return invalid('The captured Base definition changed.');
              const result = projectSharedBasePreview(report.result, input.version, input.entries, captured.timezone);
              captures.set(result, Object.freeze({ clockMs, timezone: captured.timezone })); input.onPreview?.(result);
            } catch (error) {
              if (previewLive()) input.onPreviewStatus?.(['index_preview_not_ready', 'index_source_unavailable'].includes(documentErrorCode(error) ?? '')
                ? 'Indexing… this Base or its current file has not been indexed yet.'
                : 'Indexing continues. A read-only preview is temporarily unavailable.');
            }
          }
        })().finally(() => {
          if (run.previewTask === task) run.previewTask = undefined;
          // Delivery can land after the loop's final check but before this
          // promise settles. Preserve that actual nudge without a timer.
          if (run.previewRequested && previewLive()) loadPreview();
          if (!run.active) void this.retire(run).catch(() => {});
        });
        run.previewTask = task; void task.catch(() => {});
      };
      // Each callback comes from actual maintenance delivery. Equal counts do not
      // prove that a replacement capture has the same definition or context.
      const onProgress = (_progress: DocumentIndexProgress) => { loadPreview(); };
      let maintained = await catchUpDocumentIndex(input.service, { isCurrent: live, signal: run.abort.signal, onProgress }); check();
      if (!maintained.current && input.service.maintenance) {
        // A bounded demand can finish before the first build. Wait on actual
        // owner updates, without submitting another demand or pumping the core.
        // Property settings and inline definitions can disable previews while
        // still requiring the same automatic published-generation handoff.
        let stopped = false, unsubscribe: (() => void) | undefined, serial = 0, last: DocumentRuntimeUpdate | null = null, notify = () => {};
        let rejectAbort: (reason: unknown) => void = () => {};
        const changed = () => { serial++; notify(); };
        const onAbort = () => { changed(); rejectAbort(new DocumentSemanticsError('document_request_cancelled')); };
        run.abort.signal.addEventListener('abort', onAbort, { once: true });
        const update = (value: DocumentRuntimeUpdate | null) => {
          if (stopped || !live()) return;
          last = value; changed();
          if (value?.phase === 'indexing') onProgress({ phase: 'indexing', ...(value.progress ? { prepared: value.progress.prepared, total: value.progress.total } : {}) });
        };
        const registering = input.service.maintenance!.observeAndSubscribe(update);
        void registering.then(value => { if (stopped) value.unsubscribe(); else unsubscribe = value.unsubscribe; }, () => {});
        try {
          const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; if (run.abort.signal.aborted) onAbort(); });
          void aborted.catch(() => {});
          const observed = await Promise.race([registering, aborted]); check();
          unsubscribe = observed.unsubscribe;
          // Registration is receiver-first. Its returned snapshot may predate a
          // callback already delivered while the promise was pending.
          if (serial === 0) update(observed.snapshot);
          while (!maintained.current) {
            check(); const seen = serial, current = last as DocumentRuntimeUpdate | null;
            if (!current || current.error) return invalid('Saved notes could not finish indexing. Refresh this Base to retry.');
            if (current?.freshness === 'current') { maintained = await input.service.status(); check(); if (maintained.current) break; }
            if (serial === seen) await new Promise<void>(resolve => { notify = resolve; if (serial !== seen || run.abort.signal.aborted) resolve(); });
          }
        } finally { stopped = true; unsubscribe?.(); run.abort.signal.removeEventListener('abort', onAbort); }
      }
      run.previewEnabled = false; run.previewRequested = false;
      await this.closePreview(run); await run.previewTask; check();
      if (!maintained.current || !maintained.snapshot || maintained.rebuildRequired) return invalid('Saved notes are still being indexed. Refresh this Base to continue.');
      run.opening = true;
      try { run.pin = await input.service.open(); } finally { run.opening = false; }
      check();
      const pin = run.pin;
      const read = async <T>(action: () => Promise<T>): Promise<T> => { run.reading = true; try { return await action(); } finally { run.reading = false; } };
      const metadata = await read(() => pin.metadata(input.definition.entryId!)); check();
      const definition = metadata.value.entry;
      if (definition.id !== input.definition.entryId || definition.revision !== input.definition.revision || definition.path !== input.definition.path) return invalid('The Base definition changed. Refresh before editing.');
      // Capture after index catch-up and retained definition admission, so a
      // long first build does not age the invocation before Rust evaluates it.
      const captured = (input.clock ?? this.clock).capture(input.query.timezone);
      const clockMs = input.query.now?.().getTime() ?? captured.clockMs;
      if (!Number.isSafeInteger(clockMs)) return invalid('The Base query clock is invalid.');
      const timezone = captured.timezone;
      const options = { viewIndex: input.viewIndex, searchTerms: input.query.searchTerms, ignorePaths, clockMs, timezone, maxRows: 10000, summaryPreviewProperty: input.query.summaryPreviewProperty, summaryPreviewGroupKeyId: input.query.summaryPreviewGroupKeyId, randomSeed: input.query.randomSeed,
        ...(input.current ? { currentEntryId: input.current.entryId } : {}), maxSteps: input.query.maxSteps, inlineSource: input.query.inlineSource };
      const report = await read(() => pin.base({ id: definition.id, viewName: input.viewName, options })); check();
      if (report.value.definition.id !== definition.id || report.value.definition.revision !== definition.revision || report.value.definition.path !== definition.path
        || JSON.stringify(report.value.result.snapshotId) !== JSON.stringify(pin.snapshot)) return invalid();
      if (typeof report.coverageComplete !== 'boolean' || typeof report.value.result.metadataComplete !== 'boolean') return invalid();
      const result = projectSharedBaseResult(report.value.result, input.version, input.entries, timezone, definition);
      coverage.set(result, Object.freeze({ generationComplete: report.coverageComplete, metadataComplete: report.value.result.metadataComplete }));
      captures.set(result, Object.freeze({ clockMs, timezone }));
      return result;
    } finally { run.active = false; run.previewEnabled = false; run.abort.abort(); await this.retire(run); }
  }
}
