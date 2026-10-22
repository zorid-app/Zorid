import { catchUpDocumentIndex, DocumentSemanticsError } from '../core/document-semantics.ts';
import type { DocumentEntry, DocumentLink, DocumentPin, DocumentService, DocumentSnapshotId } from '../core/document-semantics.ts';
import { MetadataCache, parseMetadata } from '../core/metadata.ts';
import { isMarkdown } from '../core/types.ts';
import type { VaultEntry } from '../core/types.ts';
import type { Vault } from '../core/vault.ts';
import type { BaseMutationHost } from './controller.ts';
import type { BaseSavedWitness } from './shared-query.ts';

export interface BaseViewReferenceChange {
  readonly path: string;
  readonly before: string;
  readonly after: string;
  readonly witness?: BaseSavedWitness;
  readonly references: number;
}
export interface BaseViewReferencePlan {
  readonly basePath: string;
  readonly from: string;
  readonly to: string;
  readonly changes: readonly BaseViewReferenceChange[];
  readonly mode: 'core' | 'legacy';
}
export interface BaseViewRenameReport {
  readonly basePath: string;
  readonly from: string;
  readonly to: string;
  readonly completedPaths: readonly string[];
  readonly failedPaths: readonly string[];
  readonly references: number;
  readonly mode: 'core' | 'legacy';
}
export class BaseViewReferenceRenameError extends Error {
  readonly report: BaseViewRenameReport;
  readonly failures: ReadonlyMap<string, unknown>;
  constructor(report: BaseViewRenameReport, failures: ReadonlyMap<string, unknown>) {
    super(`The view was renamed, but ${failures.size} referencing file${failures.size === 1 ? '' : 's'} could not be saved. Retry the retained reference updates.`);
    this.name = 'BaseViewReferenceRenameError'; this.report = report; this.failures = failures;
  }
}
export interface BaseViewReferenceOperation {
  readonly plan: BaseViewReferencePlan;
  run(): Promise<BaseViewRenameReport>;
}
export interface PrepareBaseViewReferences {
  readonly vault: Vault;
  readonly base: Readonly<VaultEntry>;
  readonly from: string;
  readonly to: string;
  readonly mutations: BaseMutationHost;
  /** Preparation is tied to the originating displayed configuration. */
  readonly validate: () => void;
  /** Execution survives its own successful writes, but never a closed owner. */
  readonly validateWrite: () => void;
  /** Recheck the saved renamed configuration before each original file plan. */
  readonly validateRenamed: () => Promise<void>;
}

/** Reference heading matching is case-insensitive and punctuation-insensitive.
 * Output retains the exact valid view name so the current exact-name binding works. */
export function baseViewReferenceKey(value: string): string {
  return value.replace(/[!"#$%&()*+,.:;<=>?@^`{|}~\/\[\]\\\r\n]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}
function fragmentMatches(fragment: string, from: string, kind: 'wiki' | 'markdown'): boolean {
  if (!fragment.startsWith('#')) return false;
  let name = fragment.slice(1);
  if (kind === 'markdown') try { name = decodeURIComponent(name); } catch { /* Keep malformed literal spelling. */ }
  return baseViewReferenceKey(name) === baseViewReferenceKey(from);
}
interface Edit { readonly start: number; readonly end: number; readonly before: string; readonly after: string }
function changedSource(source: string, links: readonly Pick<DocumentLink, 'fragment' | 'kind' | 'targetRange'>[], from: string, to: string): { after: string; count: number } {
  const edits = new Map<string, Edit>();
  for (const link of links) {
    if (!fragmentMatches(link.fragment, from, link.kind)) continue;
    const start = link.targetRange.utf16[1], end = start + link.fragment.length;
    if (!Number.isSafeInteger(start) || start < 0 || end > source.length || source.slice(start, end) !== link.fragment) throw new Error('A saved Base reference no longer matches its original source range');
    const after = `#${link.kind === 'markdown' ? encodeURIComponent(to) : to}`;
    edits.set(`${start}:${end}`, { start, end, before: link.fragment, after });
  }
  let after = source, previous = source.length;
  for (const edit of [...edits.values()].sort((a, b) => b.start - a.start)) {
    if (edit.end > previous) throw new Error('Overlapping Base reference ranges cannot be rewritten safely');
    after = after.slice(0, edit.start) + edit.after + after.slice(edit.end); previous = edit.start;
  }
  return { after, count: edits.size };
}
const failedCloses = new WeakMap<DocumentService, Set<DocumentPin>>();
export async function closeBaseViewReferenceQueries(service: DocumentService): Promise<void> {
  for (const pin of [...failedCloses.get(service) ?? []]) { await pin.close(); failedCloses.get(service)?.delete(pin); }
}
function sameEntry(entry: Readonly<VaultEntry> | null | undefined, expected: Pick<DocumentEntry, 'id' | 'revision' | 'path'>): boolean {
  return !!entry && entry.type === 'file' && entry.path === expected.path && entry.entryId === expected.id && entry.revision === expected.revision;
}
function sameSnapshot(a: DocumentSnapshotId, b: DocumentSnapshotId): boolean {
  return a.localStoreId === b.localStoreId && a.generationEpoch === b.generationEpoch && a.generation === b.generation
    && a.versions.schema === b.versions.schema && a.versions.extraction === b.versions.extraction && a.versions.resolver === b.versions.resolver && a.versions.query === b.versions.query;
}

/** Capture all indexed references from one retained core generation, then release
 * the read pin before any configuration or shared-buffer write is attempted. */
export async function prepareBaseViewReferences(input: PrepareBaseViewReferences): Promise<BaseViewReferenceOperation> {
  const adapter = input.vault.adapter, service = adapter.documentSemantics;
  const check = () => { input.validate(); if (input.vault.adapter !== adapter || adapter.documentSemantics !== service) throw new Error('The Base reference owner changed'); };
  check();
  const changes: BaseViewReferenceChange[] = [];
  if (service) {
    if (!input.base.entryId || !input.base.revision) throw new Error('Saved Base identity is unavailable for reference updates');
    await closeBaseViewReferenceQueries(service); check();
    const maintained = await catchUpDocumentIndex(service, { isCurrent: () => { try { check(); return true; } catch { return false; } } }); check();
    if (!maintained.current || !maintained.snapshot || maintained.rebuildRequired) throw new Error('Saved references are still indexing; refresh before renaming the view');
    let pin: DocumentPin | undefined;
    try {
      pin = await service.open(); check();
      const base = await pin.metadata(input.base.entryId); check();
      if (!sameEntry(input.base, base.value.entry) || base.value.entry.deleted || !sameSnapshot(base.snapshot, pin.snapshot) || base.source.localStoreId !== pin.source.localStoreId || base.source.watermark !== pin.source.watermark) throw new Error('The saved Base changed before its references were captured');
      const sources = new Map<string, { entry: DocumentEntry; links: DocumentLink[] }>();
      let cursor: Parameters<DocumentPin['backlinks']>[0]['cursor'];
      const cursors = new Set<string>();
      do {
        const page = await pin.backlinks({ targetId: input.base.entryId, ...(cursor ? { cursor } : {}), limit: 1000 }); check();
        if (!sameSnapshot(page.result.snapshot, pin.snapshot) || page.result.source.localStoreId !== pin.source.localStoreId || page.result.source.watermark !== pin.source.watermark || !page.result.coverageComplete
          || !sameSnapshot(page.result.value.snapshot, pin.snapshot) || !page.result.value.coverageComplete || page.result.value.next !== null || (page.cursor === null) !== page.result.value.scanComplete || (page.cursor === null && !page.result.value.complete)) throw new DocumentSemanticsError('document_invalid_response');
        for (const edge of page.result.value.edges) {
          if (edge.target.id !== input.base.entryId || edge.target.revision !== input.base.revision || edge.target.path !== input.base.path || edge.source.deleted || edge.source.kind !== 'file') throw new DocumentSemanticsError('document_invalid_response');
          if (!fragmentMatches(edge.link.fragment, input.from, edge.link.kind)) continue;
          const existing = sources.get(edge.source.id);
          if (existing && (existing.entry.revision !== edge.source.revision || existing.entry.path !== edge.source.path)) throw new DocumentSemanticsError('document_invalid_response');
          if (existing) existing.links.push(edge.link); else sources.set(edge.source.id, { entry: edge.source, links: [edge.link] });
        }
        cursor = page.cursor;
        if (cursor && cursors.has(cursor)) throw new DocumentSemanticsError('document_invalid_response');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      for (const { entry, links } of sources.values()) {
        const observe = async () => adapter.stat ? await adapter.stat(entry.path) : (await adapter.list()).find(row => row.path === entry.path);
        const beforeEntry = await observe(); check();
        if (!sameEntry(beforeEntry, entry)) throw new Error(`A referencing file changed: ${entry.path}`);
        const before = await adapter.read(entry.path); check();
        const afterEntry = await observe(); check();
        if (!sameEntry(afterEntry, entry)) throw new Error(`A referencing file changed: ${entry.path}`);
        const updated = changedSource(before, links, input.from, input.to);
        if (updated.after !== before) changes.push(Object.freeze({ path: entry.path, before, after: updated.after, references: updated.count, witness: Object.freeze({ entryId: entry.id, revision: entry.revision }) }));
      }
      const current = await service.status(); check();
      if (!current.current || current.rebuildRequired || !current.snapshot || !sameSnapshot(current.snapshot, pin.snapshot) || current.source.watermark !== pin.source.watermark || current.source.localStoreId !== pin.source.localStoreId) throw new Error('Saved references changed while the view rename was being prepared');
    } finally {
      if (pin) try { await pin.close(); } catch (error) {
        let pins = failedCloses.get(service); if (!pins) { pins = new Set(); failedCloses.set(service, pins); } pins.add(pin); throw error;
      }
    }
  } else {
    // Explicit legacy adapter support uses the existing mutation-local parser,
    // never as a fallback after a normal admitted core endpoint has failed.
    const entries = await adapter.list(); check();
    const cache = new MetadataCache(); cache.setFiles(entries.filter(entry => entry.type === 'file').map(entry => entry.path));
    for (const entry of entries) {
      if (entry.type !== 'file' || !isMarkdown(entry.path)) continue;
      const before = await adapter.read(entry.path); check();
      const links = parseMetadata(entry.path, before).links.filter(link => cache.resolveLink(entry.path, link.target, link.kind) === input.base.path);
      const updated = changedSource(before, links.map(link => ({ fragment: link.fragment, kind: link.kind, targetRange: { utf16: [link.start, link.end], bytes: [0, 0] } })), input.from, input.to);
      if (updated.after !== before) changes.push(Object.freeze({ path: entry.path, before, after: updated.after, references: updated.count }));
    }
  }
  check();
  const plan: BaseViewReferencePlan = Object.freeze({ basePath: input.base.path, from: input.from, to: input.to, mode: service ? 'core' : 'legacy', changes: Object.freeze(changes) });
  const completed = new Set<string>(); let running: Promise<BaseViewRenameReport> | undefined;
  return Object.freeze({ plan, run() {
    if (running) return running;
    const task = (async () => {
      input.validateWrite();
      if (input.vault.adapter !== adapter || adapter.documentSemantics !== service) throw new Error('The Base reference owner changed');
      await input.validateRenamed(); input.validateWrite();
      const failures = new Map<string, unknown>();
      for (const change of changes) {
        if (completed.has(change.path)) continue;
        try {
          input.validateWrite();
          if (input.vault.adapter !== adapter || adapter.documentSemantics !== service) throw new Error('The Base reference owner changed');
          await input.validateRenamed(); input.validateWrite();
          await input.mutations.transform(change.path, source => {
            if (source !== change.before && source !== change.after) throw new Error(`The referencing note has an unsaved or external edit: ${change.path}`);
            return change.after;
          }, input.validateWrite, input.validateWrite, change.witness);
          completed.add(change.path);
        } catch (error) { failures.set(change.path, error); }
      }
      const report: BaseViewRenameReport = Object.freeze({ basePath: plan.basePath, from: plan.from, to: plan.to, completedPaths: Object.freeze([...completed]), failedPaths: Object.freeze([...failures.keys()]), references: changes.filter(change => completed.has(change.path)).reduce((total, change) => total + change.references, 0), mode: plan.mode });
      if (failures.size) throw new BaseViewReferenceRenameError(report, failures);
      return report;
    })();
    running = task; void task.finally(() => { if (running === task) running = undefined; }).catch(() => {}); return task;
  } });
}
