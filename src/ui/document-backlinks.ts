import { catchUpDocumentIndex, DocumentSemanticsError } from '../core/document-semantics.ts';
import type {
  DocumentCursor, DocumentEntry, DocumentPin, DocumentRelationshipPage,
  DocumentPage, DocumentService, DocumentSnapshotId, DocumentSourceId, DocumentStatus,
} from '../core/document-semantics.ts';
import { icon } from './icons.ts';

export type DocumentBacklinksTarget = Pick<DocumentEntry, 'id' | 'path'>;
export interface DocumentBacklinksOptions {
  readonly service: DocumentService | null | undefined;
  readonly target: DocumentBacklinksTarget | null;
  /** An opaque caller-owned vault instance token, not a path or display label. */
  readonly vaultIdentity: unknown;
  /** Must check active pane/tab, target ID/path and vault instance together. */
  readonly isCurrent: (vaultIdentity: unknown, target: DocumentBacklinksTarget | null) => boolean;
  readonly onOpenStableEntry: (id: string, oldPath: string) => void | Promise<void>;
  /** Observe reads a saved pin without index demand or a current-source claim.
   * An explicit Rebuild index action remains a foreground request. */
  readonly freshness?: 'request' | 'observe';
  readonly maxPumps?: number;
  readonly maxRestarts?: number;
  readonly maxPages?: number;
  readonly pageLimit?: number;
  readonly maxSources?: number;
}
export interface DocumentBacklinksView {
  readonly element: HTMLElement;
  /** Current refresh, including its own pin-close attempt. Never rejects. */
  readonly ready: Promise<void>;
  refresh(target?: DocumentBacklinksTarget | null): Promise<void>;
  cancel(): void;
  /** Pending opens are retired and close themselves if they arrive later. */
  dispose(): void;
}
interface Run {
  readonly generation: number;
  readonly freshness: AbortController;
  readonly target: DocumentBacklinksTarget | null;
  cancelled: boolean;
  finished: boolean;
  pin: DocumentPin | null;
  closing: Promise<void> | null;
}
const sameSource = (a: DocumentSourceId, b: DocumentSourceId): boolean =>
  a.localStoreId === b.localStoreId && a.watermark === b.watermark;
const sameSnapshot = (a: DocumentSnapshotId, b: DocumentSnapshotId): boolean =>
  a.localStoreId === b.localStoreId && a.generationEpoch === b.generationEpoch
  && a.generation === b.generation && a.versions.schema === b.versions.schema
  && a.versions.extraction === b.versions.extraction && a.versions.resolver === b.versions.resolver
  && a.versions.query === b.versions.query;
const sameTarget = (a: DocumentBacklinksTarget | null, b: DocumentBacklinksTarget | null): boolean =>
  a === null || b === null ? a === b : a.id === b.id && a.path === b.path;
const copyTarget = (target: DocumentBacklinksTarget | null): DocumentBacklinksTarget | null =>
  target ? { id: target.id, path: target.path } : null;
const bound = (value: number | undefined, fallback: number, maximum: number): number =>
  value === undefined ? fallback : Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;

/** Renders only Rust-owned relationship reports. Saved source identity, parsing,
 * resolver policy and index maintenance are supplied by the shared service.
 * A refresh owns exactly its opened pin; retiring it never closes a vault or
 * another consumer's pin. No timer, observer or background polling is installed. */
export function mountDocumentBacklinks(container: HTMLElement, options: DocumentBacklinksOptions): DocumentBacklinksView {
  const doc = container.ownerDocument, service = options.service;
  const element = doc.createElement('section');
  element.className = 'document-backlinks'; element.setAttribute('aria-label', 'Linked mentions');
  const heading = doc.createElement('h3'); heading.className = 'right-heading'; heading.textContent = 'Linked mentions';
  const status = doc.createElement('p'); status.className = 'sidebar-empty'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const rows = doc.createElement('div'); rows.setAttribute('role', 'list'); rows.setAttribute('aria-label', 'Linked notes');
  const actions = doc.createElement('div');
  element.append(heading, status, rows, actions); container.append(element);
  const maxPages = bound(options.maxPages, 10, 100), pageLimit = bound(options.pageLimit, 100, 1000);
  const maxSources = bound(options.maxSources, 1000, 1000);
  const runs = new Set<Run>();
  let generation = 0, current: Run | null = null, target = copyTarget(options.target), disposed = false;
  let ready: Promise<void> = Promise.resolve();

  const live = (run: Run): boolean => {
    if (disposed || run.cancelled || current !== run || generation !== run.generation || !sameTarget(target, run.target)) return false;
    try { return options.isCurrent(options.vaultIdentity, run.target); } catch { return false; }
  };
  const show = (run: Run, state: string, message: string, busy = false, alert = false): void => {
    if (!live(run)) return;
    element.dataset.state = state; element.setAttribute('aria-busy', String(busy));
    status.textContent = message; status.setAttribute('role', alert ? 'alert' : 'status'); actions.replaceChildren();
  };
  const action = (run: Run, label: string, rebuild = false): void => {
    if (!live(run)) return;
    const button = doc.createElement('button'); button.type = 'button'; button.className = 'backlink-row'; button.textContent = label;
    button.addEventListener('click', () => { if (live(run)) ready = start(run.target, rebuild); }); actions.append(button);
  };
  const closeOwned = (run: Run): Promise<void> => {
    if (run.closing) return run.closing;
    const pin = run.pin;
    if (!pin) return Promise.resolve();
    const closing = Promise.resolve().then(() => pin.close()).then(() => {
      // A rejected close retains ownership so the next refresh/dispose can retry.
      run.pin = null;
      if (run.finished) runs.delete(run);
    }).finally(() => { if (run.closing === closing) run.closing = null; });
    run.closing = closing;
    return closing;
  };
  const retire = (run: Run): void => {
    run.cancelled = true;
    run.freshness.abort();
    // The run's finally also awaits this same promise; cancellation is nonblocking.
    void closeOwned(run).catch(() => {});
  };
  const row = (run: Run, source: DocumentEntry): void => {
    if (!live(run)) return;
    const item = doc.createElement('div'); item.setAttribute('role', 'listitem');
    const button = doc.createElement('button'); button.type = 'button'; button.className = 'backlink-row';
    button.dataset.entryId = source.id; button.dataset.revision = source.revision; button.dataset.path = source.path;
    button.title = source.path; button.setAttribute('aria-label', `Open linked note: ${source.path}`);
    button.append(icon('file', 14, doc), doc.createTextNode(source.path.split('/').at(-1)!.replace(/\.md$/i, '')));
    button.addEventListener('click', () => {
      if (!live(run)) return;
      void (async () => {
        try { await options.onOpenStableEntry(source.id, source.path); if (!live(run)) return; }
        catch { if (live(run)) show(run, 'unavailable', 'This linked note could not be opened.', false, true); }
      })();
    });
    item.append(button); rows.append(item);
  };
  const validate = (page: DocumentPage<DocumentRelationshipPage>, pin: DocumentPin, run: Run): void => {
    const value = page.result.value;
    if (!sameSnapshot(page.result.snapshot, pin.snapshot) || !sameSnapshot(value.snapshot, pin.snapshot)
      || !sameSource(page.result.source, pin.source)
      || (page.cursor === null) !== value.scanComplete || value.next !== null
      || value.edges.some(edge => edge.target.id !== run.target?.id || edge.source.kind !== 'file' || edge.source.deleted)) {
      throw new DocumentSemanticsError('document_invalid_response');
    }
  };
  const failed = (run: Run, error: unknown, requesting: boolean): void => {
    if (!live(run)) return;
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code === 'rebuild_required' || code === 'index_rebuild_required') {
      show(run, 'unavailable', 'The note index needs to be rebuilt before linked mentions are available.', false, true);
      action(run, 'Rebuild index', true); return;
    }
    if (code === 'stale_source' || code === 'stale_index' || code === 'index_not_ready' || code === 'document_request_cancelled' || !requesting && code === 'not_ready') {
      show(run, 'indexing', requesting ? 'The note index is still updating. Continue indexing to refresh linked mentions.' : 'The note index is still updating. Linked mentions will refresh when a saved snapshot is available.');
      if (requesting) action(run, 'Continue indexing'); return;
    }
    const message = code === 'snapshot_expired'
      ? 'Linked mentions changed while loading. Refresh to load a saved snapshot.'
      : code === 'missing_source' || code === 'not_found'
        ? 'This note is not available in the indexed snapshot. Refresh after its changes are indexed.'
        : 'Linked mentions are temporarily unavailable. Refresh to try again.';
    show(run, 'unavailable', message, false, true); action(run, 'Refresh linked mentions');
  };
  async function perform(run: Run, rebuild: boolean): Promise<void> {
    const requesting = options.freshness !== 'observe' || rebuild;
    try {
      if (!live(run)) return;
      if (!run.target) { show(run, 'unavailable', 'Open a saved note to see linked mentions.'); return; }
      if (!service) { show(run, 'unavailable', 'Linked mentions are unavailable for this vault.'); return; }
      // Retry failed retired closes before acquiring another quota-limited pin.
      await Promise.all([...runs].filter(previous => previous !== run).map(closeOwned));
      if (!live(run)) return;
      let maintained: DocumentStatus | undefined;
      if (requesting) {
        maintained = await catchUpDocumentIndex(service, {
          isCurrent: () => live(run), signal: run.freshness.signal, rebuild, maxPumps: options.maxPumps, maxRestarts: options.maxRestarts,
          onProgress(progress) {
            const message = progress.phase === 'rebuild' ? 'Rebuilding the note index…'
              : progress.phase === 'indexing' && progress.prepared !== undefined && progress.total !== undefined
                ? `Indexing saved notes… ${progress.prepared} of ${progress.total}` : 'Updating the note index…';
            show(run, 'indexing', message, true);
          },
        });
        if (!live(run)) return;
        if (maintained.rebuildRequired) throw new DocumentSemanticsError('rebuild_required');
        if (!maintained.snapshot) {
          show(run, 'indexing', 'The note index is still updating. Continue indexing to load linked mentions.');
          action(run, 'Continue indexing'); return;
        }
      }
      const pin = await service.open(); run.pin = pin;
      if (!live(run)) return;
      if (maintained && pin.snapshot.localStoreId !== maintained.source.localStoreId || pin.source.localStoreId !== pin.snapshot.localStoreId) {
        throw new DocumentSemanticsError('document_invalid_response');
      }
      show(run, 'loading', 'Finding linked mentions…', true);
      let cursor: DocumentCursor | null = null, scanComplete = false, coverageComplete = pin.coverageComplete;
      const seen = new Set<string>(), cursors = new Set<DocumentCursor>();
      for (let pageIndex = 0; pageIndex < maxPages && seen.size < maxSources; pageIndex++) {
        if (!live(run)) return;
        const page = await pin.backlinks({ targetId: run.target.id, cursor, limit: pageLimit });
        if (!live(run)) return;
        validate(page, pin, run);
        coverageComplete = coverageComplete && page.result.coverageComplete && page.result.value.coverageComplete;
        let omitted = false;
        for (const edge of page.result.value.edges) {
          if (seen.has(edge.source.id)) continue;
          if (seen.size === maxSources) { omitted = true; break; }
          seen.add(edge.source.id); row(run, edge.source);
        }
        scanComplete = page.result.value.scanComplete && !omitted;
        if (scanComplete || omitted) break;
        cursor = page.cursor;
        if (!cursor || cursors.has(cursor)) throw new DocumentSemanticsError('document_invalid_cursor');
        cursors.add(cursor);
      }
      if (!requesting) {
        // Coverage belongs to this pin, not to the latest source. No observation
        // or maintenance request was made to prove currentness for a passive view.
        const messages = ['Linked mentions from a saved snapshot. Recent changes may not be included.'];
        if (!seen.size) messages.push('No linked notes in this saved snapshot.');
        if (!coverageComplete) messages.push('Some saved files could not be indexed. Linked mentions may be missing.');
        if (!scanComplete) messages.push('Some linked mentions are not shown.');
        show(run, !scanComplete || !coverageComplete ? 'incomplete' : 'historical', messages.join(' '));
        return;
      }
      const observed = await service.status(); if (!live(run)) return;
      if (observed.source.localStoreId !== pin.source.localStoreId) throw new DocumentSemanticsError('document_invalid_response');
      if (observed.rebuildRequired) throw new DocumentSemanticsError('rebuild_required');
      const lagged = !observed.current || !sameSource(observed.source, pin.source) || !observed.snapshot || !sameSnapshot(observed.snapshot, pin.snapshot);
      if (lagged || !scanComplete || !coverageComplete) {
        const messages: string[] = [];
        if (lagged) messages.push('Recent changes are still being indexed.');
        if (!coverageComplete) messages.push('Some saved files could not be indexed. Linked mentions may be missing.');
        if (!scanComplete) messages.push('Some linked mentions are not shown.');
        show(run, lagged ? 'lagged' : 'incomplete', messages.join(' '));
        if (lagged) action(run, 'Continue indexing');
      } else if (!seen.size) show(run, 'empty', 'No backlinks found.');
      else show(run, 'ready', `${seen.size} linked ${seen.size === 1 ? 'note' : 'notes'}.`);
    } catch (error) { failed(run, error, requesting); }
    finally {
      try { await closeOwned(run); }
      catch {
        // Disposal may precede a late open. Allow one final transient-close retry
        // because a disposed view cannot receive a subsequent refresh.
        if (disposed) { try { await closeOwned(run); } catch { /* Ownership remains until the vault service closes. */ } }
        else if (live(run)) { show(run, 'unavailable', 'Linked mentions could not finish refreshing. Refresh to try again.', false, true); action(run, 'Refresh linked mentions'); }
      }
      if (live(run)) element.setAttribute('aria-busy', 'false');
    }
  }
  function start(next: DocumentBacklinksTarget | null, rebuild = false): Promise<void> {
    for (const run of runs) retire(run);
    target = copyTarget(next);
    const run: Run = { generation: ++generation, freshness: new AbortController(), target: copyTarget(target), cancelled: false, finished: false, pin: null, closing: null };
    current = run; runs.add(run);
    if (live(run)) { rows.replaceChildren(); show(run, 'indexing', 'Updating linked mentions…', true); }
    const work = perform(run, rebuild).finally(() => { run.finished = true; if (!run.pin) runs.delete(run); });
    ready = work; return work;
  }
  ready = start(target);
  return {
    element, get ready() { return ready; },
    refresh(next = target) { if (disposed) return Promise.resolve(); return start(next); },
    cancel() { if (current) retire(current); },
    dispose() { if (disposed) return; disposed = true; generation++; for (const run of runs) retire(run); element.remove(); },
  };
}
