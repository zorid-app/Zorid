import type { ChangeDesc } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { Disposable } from '@zorid/shared';
import type { MarkdownBlockMatch } from './live-preview/markdown-blocks.js';

export const maxRetainedEmbedHosts = 20;
export const maxOffscreenAgeMs = 30_000;
export const maxOffscreenDistance = 100_000;
export const markdownEmbedFallbackHeight = 160;

export interface EditorEmbedOccurrence {
  readonly documentSessionKey: string;
  readonly kind: string;
  readonly referenceSyntax: string;
  readonly target: string;
  readonly fragment?: string;
  readonly rendererIdentity: string;
  readonly sourceFrom: number;
  readonly sourceTo: number;
  readonly sourceText: string;
}

export interface EditorEmbedMountContext {
  readonly occurrence: EditorEmbedOccurrence;
  readonly host: HTMLElement;
}

export interface EditorEmbedLifecycleOptions {
  readonly mount: (context: EditorEmbedMountContext) => Disposable;
  readonly now?: () => number;
  readonly requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelAnimationFrame?: (handle: number) => void;
}

interface EditorEmbedHostRecord {
  occurrence: EditorEmbedOccurrence;
  readonly host: HTMLElement;
  disposable: Disposable | undefined;
  placeholder: HTMLElement | undefined;
  height: number;
  lastVisibleAt: number;
  lastSeenFrom: number;
  attached: boolean;
  disposed: boolean;
  pendingPlaceholders: HTMLElement[];
  rafHandle: number | undefined;
  measureView: Pick<EditorView, 'requestMeasure'> | undefined;
  observer: ResizeObserver | undefined;
  connectionObserver: MutationObserver | undefined;
}

function occurrenceSemanticKey(occurrence: EditorEmbedOccurrence): string {
  return JSON.stringify([
    occurrence.documentSessionKey,
    occurrence.kind,
    occurrence.referenceSyntax,
    occurrence.target,
    occurrence.fragment ?? '',
    occurrence.rendererIdentity,
  ]);
}

function hostDomKey(occurrence: EditorEmbedOccurrence): string {
  return `${occurrenceSemanticKey(occurrence)}:${occurrence.sourceFrom}:${occurrence.sourceTo}`;
}

function toEmbedTarget(rawTarget: string): { path: string; fragment?: string } {
  const target = rawTarget.split('|', 1)[0] ?? rawTarget;
  const hashIndex = target.indexOf('#');
  if (hashIndex === -1) return { path: target };
  const fragment = target.slice(hashIndex + 1);
  return fragment ? { path: target.slice(0, hashIndex), fragment } : { path: target.slice(0, hashIndex) };
}

function markdownEmbedSourceOccurrences(docText: string): Array<{
  readonly sourceFrom: number;
  readonly sourceTo: number;
  readonly sourceText: string;
  readonly target: string;
  readonly fragment?: string;
  readonly referenceSyntax: string;
}> {
  const occurrences: Array<{
    readonly sourceFrom: number;
    readonly sourceTo: number;
    readonly sourceText: string;
    readonly target: string;
    readonly fragment?: string;
    readonly referenceSyntax: string;
  }> = [];
  const pattern = /!\[\[([^\]]+)\]\]/g;
  for (const match of docText.matchAll(pattern)) {
    const rawTarget = match[1]?.trim();
    if (!rawTarget) continue;
    const sourceFrom = match.index ?? 0;
    const sourceText = match[0];
    const parsed = toEmbedTarget(rawTarget);
    occurrences.push({
      sourceFrom,
      sourceTo: sourceFrom + sourceText.length,
      sourceText,
      target: parsed.path,
      ...(parsed.fragment ? { fragment: parsed.fragment } : {}),
      referenceSyntax: 'wikilink-embed',
    });
  }
  return occurrences;
}

export function markdownEmbedOccurrenceFromBlockMatch(
  match: MarkdownBlockMatch,
  options: {
    readonly documentSessionKey: string;
    readonly rendererIdentity: string;
  },
): EditorEmbedOccurrence | null {
  if (match.definition.kind !== 'external') return null;
  return {
    documentSessionKey: options.documentSessionKey,
    kind: match.type,
    referenceSyntax: match.definition.referenceSyntax,
    target: match.definition.path,
    ...(match.definition.fragment ? { fragment: match.definition.fragment } : {}),
    rendererIdentity: options.rendererIdentity,
    sourceFrom: match.definition.sourceFrom,
    sourceTo: match.definition.sourceTo,
    sourceText: `![[${match.meta?.rawTarget ?? match.definition.path}]]`,
  };
}

export function collectMarkdownEmbedOccurrencesFromText(
  docText: string,
  options: {
    readonly documentSessionKey: string;
    readonly rendererIdentityForTarget: (target: string) => string | undefined;
  },
): EditorEmbedOccurrence[] {
  return markdownEmbedSourceOccurrences(docText).flatMap((source) => {
    const rendererIdentity = options.rendererIdentityForTarget(source.target);
    if (!rendererIdentity) return [];
    return [
      {
        documentSessionKey: options.documentSessionKey,
        kind: 'embed-reference',
        referenceSyntax: source.referenceSyntax,
        target: source.target,
        ...(source.fragment ? { fragment: source.fragment } : {}),
        rendererIdentity,
        sourceFrom: source.sourceFrom,
        sourceTo: source.sourceTo,
        sourceText: source.sourceText,
      },
    ];
  });
}

export class EditorEmbedLifecycle {
  readonly #mount: (context: EditorEmbedMountContext) => Disposable;
  readonly #now: () => number;
  readonly #requestAnimationFrame: (callback: FrameRequestCallback) => number;
  readonly #cancelAnimationFrame: (handle: number) => void;
  readonly #records = new Map<string, EditorEmbedHostRecord>();
  #measureView: Pick<EditorView, 'requestMeasure'> | undefined;

  constructor(options: EditorEmbedLifecycleOptions) {
    this.#mount = options.mount;
    this.#now = options.now ?? (() => Date.now());
    this.#requestAnimationFrame =
      options.requestAnimationFrame ??
      ((callback) => globalThis.requestAnimationFrame?.(callback) ?? window.setTimeout(callback, 0));
    this.#cancelAnimationFrame =
      options.cancelAnimationFrame ?? ((handle) => globalThis.cancelAnimationFrame?.(handle) ?? clearTimeout(handle));
  }

  get retainedHostCount(): number {
    return [...this.#records.values()].filter((record) => !record.disposed).length;
  }

  setMeasureView(view: Pick<EditorView, 'requestMeasure'> | undefined): void {
    this.#measureView = view;
    for (const record of this.#records.values()) record.measureView = view;
  }

  renderPlaceholder(occurrence: EditorEmbedOccurrence, view?: Pick<EditorView, 'requestMeasure'>): HTMLElement {
    const record = this.#recordForOccurrence(occurrence);
    const placeholder = document.createElement('section');
    placeholder.className = 'z-editor-embed-placeholder';
    placeholder.dataset.editorEmbedPlaceholder = 'true';
    placeholder.dataset.editorEmbedKey = hostDomKey(occurrence);
    placeholder.style.minHeight = `${Math.max(1, record.height)}px`;
    placeholder.style.position = 'relative';
    record.measureView = view ?? this.#measureView;
    record.pendingPlaceholders.push(placeholder);
    this.#watchPlaceholderConnection(record);
    this.#schedulePlaceholderConnectionSync(record);
    window.setTimeout(() => this.#syncPlaceholderConnection(record), 0);
    return placeholder;
  }

  reconcile(
    occurrences: readonly EditorEmbedOccurrence[],
    options: {
      readonly visibleFrom?: number;
      readonly visibleTo?: number;
      readonly documentClosed?: boolean;
    } = {},
  ): void {
    if (options.documentClosed) {
      this.dispose();
      return;
    }
    const now = this.#now();
    const nextRecords = new Map<string, EditorEmbedHostRecord>();
    const oldBySemanticKey = new Map<string, EditorEmbedHostRecord[]>();
    const remainingNewBySemanticKey = new Map<string, number>();
    for (const occurrence of occurrences) {
      const key = occurrenceSemanticKey(occurrence);
      remainingNewBySemanticKey.set(key, (remainingNewBySemanticKey.get(key) ?? 0) + 1);
    }
    for (const record of this.#records.values()) {
      if (record.disposed) continue;
      const key = occurrenceSemanticKey(record.occurrence);
      oldBySemanticKey.set(key, [...(oldBySemanticKey.get(key) ?? []), record]);
    }

    for (const occurrence of [...occurrences].sort((left, right) => left.sourceFrom - right.sourceFrom)) {
      const semanticKey = occurrenceSemanticKey(occurrence);
      const candidates = oldBySemanticKey.get(semanticKey) ?? [];
      const remainingNew = remainingNewBySemanticKey.get(semanticKey) ?? 1;
      remainingNewBySemanticKey.set(semanticKey, remainingNew - 1);
      let record: EditorEmbedHostRecord | undefined;
      let recordIndex = -1;
      let distance = Number.POSITIVE_INFINITY;
      const firstCandidateFrom = Math.min(...candidates.map((candidate) => candidate.lastSeenFrom));
      if (!(candidates.length < remainingNew && occurrence.sourceFrom < firstCandidateFrom)) {
        for (const [index, candidate] of candidates.entries()) {
          const candidateDistance = Math.abs(candidate.lastSeenFrom - occurrence.sourceFrom);
          if (candidateDistance < distance) {
            record = candidate;
            recordIndex = index;
            distance = candidateDistance;
          }
        }
      }
      if (record) candidates.splice(recordIndex, 1);
      else record = this.#createRecord(occurrence);
      record.occurrence = occurrence;
      record.lastSeenFrom = occurrence.sourceFrom;
      if (
        options.visibleFrom !== undefined &&
        options.visibleTo !== undefined &&
        occurrence.sourceFrom < options.visibleTo &&
        occurrence.sourceTo > options.visibleFrom
      ) {
        record.lastVisibleAt = now;
      }
      nextRecords.set(hostDomKey(occurrence), record);
    }

    for (const record of this.#records.values()) {
      if (record.disposed) continue;
      if ([...nextRecords.values()].includes(record)) continue;
      this.#disposeRecord(record);
    }
    this.#records.clear();
    for (const [key, record] of nextRecords) this.#records.set(key, record);
    for (const record of this.#records.values()) this.#syncPlaceholderConnection(record);
    this.evictOffscreen({
      ...(options.visibleFrom === undefined ? {} : { visibleFrom: options.visibleFrom }),
      ...(options.visibleTo === undefined ? {} : { visibleTo: options.visibleTo }),
    });
  }

  mapSourceRanges(changes: Pick<ChangeDesc, 'mapPos'>): void {
    for (const [key, record] of this.#records) {
      const sourceFrom = changes.mapPos(record.occurrence.sourceFrom, 1);
      const sourceTo = changes.mapPos(record.occurrence.sourceTo, -1);
      if (sourceTo <= sourceFrom) {
        this.#disposeRecord(record);
        this.#records.delete(key);
        continue;
      }
      record.lastSeenFrom = sourceFrom;
      record.occurrence = { ...record.occurrence, sourceFrom, sourceTo };
    }
  }

  evictOffscreen(options: { readonly visibleFrom?: number; readonly visibleTo?: number } = {}): void {
    const now = this.#now();
    for (const record of this.#records.values()) {
      if (record.disposed || record.attached) continue;
      const tooOld = now - record.lastVisibleAt > maxOffscreenAgeMs;
      const tooFar =
        options.visibleFrom !== undefined &&
        options.visibleTo !== undefined &&
        Math.min(
          Math.abs(record.occurrence.sourceTo - options.visibleFrom),
          Math.abs(record.occurrence.sourceFrom - options.visibleTo),
        ) > maxOffscreenDistance;
      if (tooOld || tooFar) this.#disposeRecord(record);
    }
    const retained = [...this.#records.values()].filter((record) => !record.disposed && !record.attached);
    retained.sort((left, right) => left.lastVisibleAt - right.lastVisibleAt);
    for (const record of retained.slice(0, Math.max(0, retained.length - maxRetainedEmbedHosts)))
      this.#disposeRecord(record);
  }

  dispose(): void {
    for (const record of this.#records.values()) this.#disposeRecord(record);
    this.#records.clear();
  }

  #recordForOccurrence(occurrence: EditorEmbedOccurrence): EditorEmbedHostRecord {
    const key = hostDomKey(occurrence);
    const existing = this.#records.get(key);
    if (existing && !existing.disposed) return existing;
    const record = this.#createRecord(occurrence);
    this.#records.set(key, record);
    return record;
  }

  #createRecord(occurrence: EditorEmbedOccurrence): EditorEmbedHostRecord {
    const host = document.createElement('div');
    host.className = 'z-editor-embed-host';
    host.dataset.editorEmbedHost = 'true';
    const record: EditorEmbedHostRecord = {
      occurrence,
      host,
      disposable: undefined,
      height: markdownEmbedFallbackHeight,
      lastVisibleAt: this.#now(),
      lastSeenFrom: occurrence.sourceFrom,
      attached: false,
      disposed: false,
      placeholder: undefined,
      pendingPlaceholders: [],
      rafHandle: undefined,
      measureView: undefined,
      observer: undefined,
      connectionObserver: undefined,
    };
    return record;
  }

  #ensureMounted(record: EditorEmbedHostRecord): void {
    if (record.disposed || record.disposable) return;
    record.disposable = this.#mount({ occurrence: record.occurrence, host: record.host });
  }

  #observe(record: EditorEmbedHostRecord): void {
    if (record.observer) return;
    const ResizeObserverConstructor =
      record.host.ownerDocument.defaultView?.ResizeObserver ?? globalThis.ResizeObserver;
    if (!ResizeObserverConstructor) return;
    record.observer = new ResizeObserverConstructor(() => this.#scheduleHeightWrite(record));
    record.observer.observe(record.host);
    this.#scheduleHeightWrite(record);
  }

  #watchPlaceholderConnection(record: EditorEmbedHostRecord): void {
    if (record.connectionObserver) return;
    const placeholder = record.pendingPlaceholders.at(-1) ?? record.placeholder;
    if (!placeholder) return;
    const MutationObserverConstructor =
      placeholder.ownerDocument.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    if (!MutationObserverConstructor) return;
    record.connectionObserver = new MutationObserverConstructor(() => this.#syncPlaceholderConnection(record));
    record.connectionObserver.observe(placeholder.ownerDocument.body, { childList: true, subtree: true });
  }

  #syncPlaceholderConnection(record: EditorEmbedHostRecord): void {
    if (record.disposed) return;
    if (record.placeholder && !record.placeholder.isConnected) {
      record.attached = false;
      record.placeholder = undefined;
    }
    const placeholder = [...record.pendingPlaceholders]
      .reverse()
      .find((pendingPlaceholder) => pendingPlaceholder.isConnected);
    if (placeholder) this.#attachPlaceholder(record, placeholder);
    if (!record.placeholder && record.pendingPlaceholders.length === 0) {
      record.connectionObserver?.disconnect();
      record.connectionObserver = undefined;
    }
  }

  #schedulePlaceholderConnectionSync(record: EditorEmbedHostRecord, remainingAttempts = 4): void {
    queueMicrotask(() => {
      this.#syncPlaceholderConnection(record);
      if (!record.disposed && record.pendingPlaceholders.length > 0 && remainingAttempts > 0) {
        this.#schedulePlaceholderConnectionSync(record, remainingAttempts - 1);
      }
    });
  }

  #attachPlaceholder(record: EditorEmbedHostRecord, placeholder: HTMLElement): void {
    if (record.disposed || !record.pendingPlaceholders.includes(placeholder) || !placeholder.isConnected) return;
    record.pendingPlaceholders = [];
    record.placeholder = placeholder;
    record.attached = true;
    record.lastVisibleAt = this.#now();
    this.#ensureMounted(record);
    placeholder.style.minHeight = `${Math.max(1, record.height)}px`;
    placeholder.replaceChildren(record.host);
    this.#observe(record);
    this.#scheduleHeightWrite(record);
  }

  #scheduleHeightWrite(record: EditorEmbedHostRecord): void {
    if (record.disposed || record.rafHandle !== undefined) return;
    record.rafHandle = this.#requestAnimationFrame(() => {
      record.rafHandle = undefined;
      if (record.disposed || !record.placeholder) return;
      const measuredHeight = Math.max(
        1,
        record.host.getBoundingClientRect().height || record.host.offsetHeight || record.height,
      );
      if (Math.abs(measuredHeight - record.height) >= 1) {
        record.height = measuredHeight;
        record.placeholder.style.minHeight = `${measuredHeight}px`;
      }
      record.measureView?.requestMeasure();
    });
  }

  #disposeRecord(record: EditorEmbedHostRecord): void {
    if (record.disposed) return;
    record.disposed = true;
    if (record.rafHandle !== undefined) this.#cancelAnimationFrame(record.rafHandle);
    record.observer?.disconnect();
    record.connectionObserver?.disconnect();
    record.disposable?.dispose();
    record.host.remove();
    record.placeholder?.replaceChildren();
    for (const placeholder of record.pendingPlaceholders) placeholder.replaceChildren();
    record.pendingPlaceholders = [];
  }
}
