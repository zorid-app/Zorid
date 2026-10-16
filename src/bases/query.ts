import type { BaseViewConfig } from './document.ts';
import type { BaseExpressionValue, BaseFunctionRegistry } from './expression.ts';

/** Caller-owned revision token; no clock or filesystem access occurs in the query engine. */
export interface BaseQuerySnapshot {
  readonly version: string | number;
  readonly files: readonly BaseQueryFile[];
}
export interface BaseQueryFile {
  readonly path: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly ctime?: number;
  readonly mtime?: number;
  readonly size?: number;
  /** Complete tag strings supplied by the host, including frontmatter tags. */
  readonly tags?: readonly string[];
}
export interface BaseQueryOptions {
  readonly viewIndex?: number;
  readonly currentFilePath?: string;
  readonly functions?: BaseFunctionRegistry;
  readonly now?: () => Date;
  readonly maxSteps?: number;
  readonly ignore?: (path: string) => boolean;
  /** Pre-tokenized terms; matching spans visible properties, never file contents. */
  readonly searchTerms?: readonly string[];
}
export interface BaseQueryDiagnostic {
  readonly phase: 'input' | 'filter' | 'value' | 'search' | 'group' | 'sort';
  readonly path: string;
  readonly property?: string;
  readonly code: string;
  readonly message: string;
}
export interface BaseQueryRow {
  readonly path: string;
  /** Normalized property IDs. Missing properties yield a typed null. */
  readonly values: Readonly<Record<string, BaseExpressionValue>>;
}
export interface BaseQueryGroup {
  /** JS null denotes an ungrouped result; typed null denotes the empty-key group. */
  readonly key: BaseExpressionValue | null;
  readonly rows: readonly BaseQueryRow[];
}
export interface BaseQueryGroupOption {
  readonly key: BaseExpressionValue;
  /** Matching rows before search, sorting and the limit. */
  readonly count: number;
  readonly listed: boolean;
}
export interface BaseQueryResult {
  readonly version: BaseQuerySnapshot['version'];
  /** The selected complete view configuration, including unknown presentation options. */
  readonly view: BaseViewConfig;
  readonly rows: readonly BaseQueryRow[];
  readonly groups: readonly BaseQueryGroup[];
  /** Explicit group-order entries (including empty ones), followed by unlisted keys. */
  readonly groupOptions: readonly BaseQueryGroupOption[];
  readonly properties: readonly string[];
  readonly availableProperties: readonly string[];
  readonly counts: Readonly<{ scanned: number; matched: number; afterGroupOrder: number; afterSearch: number; returned: number }>;
  readonly diagnostics: readonly BaseQueryDiagnostic[];
}
