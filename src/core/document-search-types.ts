/** Readonly projection of the coordinated Rust rich-search wire contract.
 * Matching, counts, snippet coordinates and ordering are supplied by the core. */
import type { DocumentEntry, DocumentRange, DocumentPageStatus } from './document-semantics.ts';

export type SearchSort = 'nameAsc'|'nameDesc'|'modifiedDesc'|'modifiedAsc'|'createdDesc'|'createdAsc';
export type SearchScope = 'file'|'path'|'content'|'line'|'block'|'section'|'task'
  |'task-todo'|'task-done'|'tag'|'match-case'|'ignore-case';
export type SearchSpec = {
  readonly query:string;readonly caseSensitive:boolean;readonly sort:SearchSort;
  readonly context:'line'|'section';readonly explain:boolean;
};
export type SearchCount = {readonly relation:'exact'|'atLeast';readonly value:number}
  |{readonly relation:'unknown';readonly value:null};
export type SearchKeyMatch = {readonly kind:'ranges';readonly ranges:readonly DocumentRange[]}|{readonly kind:'exists'};
export type SearchLocator =
  |{readonly origin:'source';readonly range:DocumentRange;readonly kind:'occurrence'|'anchor'}
  |{readonly origin:'filename'|'path';readonly range:DocumentRange}
  |{readonly origin:'propertyKey';readonly key:string;readonly match:SearchKeyMatch}
  |{readonly origin:'propertyValue';readonly key:string;readonly arrayPath:readonly number[];
     readonly valueText:string;readonly range:DocumentRange};
export type SearchLocation = {
  readonly index:number; // stable per-file ordinal, not array index of this chunk
  readonly locator:SearchLocator;
  readonly role:'occurrence'|'existence'|'predicate'|'anchor';
  readonly occurrences:number;
};
export type SearchSnippet = {
  readonly origin:'source'|'filename'|'path'|'propertyKey'|'propertyValue';
  readonly key?:string;readonly arrayPath?:readonly number[];
  readonly text:string;readonly originRange:DocumentRange;
  readonly primaryLocationIndex:number;
  readonly highlights:readonly {
    readonly utf16:readonly[number,number];readonly locationIndices:readonly number[];
  }[];
  readonly clippedBefore:boolean;readonly clippedAfter:boolean;
};
export type SearchFileChunk = {
  readonly entry:DocumentEntry;readonly chunk:number;readonly lastChunk:boolean;
  readonly occurrenceCount:number; // exact evaluated file count; repeated, NOT additive
  readonly locations:readonly SearchLocation[];readonly snippets:readonly SearchSnippet[];
};
export type ExplanationNode = {
  readonly kind:'text'|'quoted'|'regex'|'constant'|'and'|'or'|'not'|'compare'|'scope'|'property';
  readonly queryRange:DocumentRange;
  readonly caseSensitive:boolean;
  readonly scope:SearchScope|null;
  readonly operand:string|null;
  readonly children:readonly ExplanationNode[];
};
export type CoreSearchExplanation = {readonly dialect:'zorid-search-rust-unicode-1';readonly root:ExplanationNode|null};
export type DocumentRichSearchPage = DocumentPageStatus & {
  readonly dialect:'zorid-search-rust-unicode-1';readonly spec:SearchSpec;
  readonly explanation:CoreSearchExplanation|null;
  readonly files:readonly SearchFileChunk[];
  readonly totals:{readonly files:SearchCount;readonly occurrences:SearchCount};
  readonly coverage:{readonly candidateFiles:number;readonly evaluatedFiles:number;readonly unavailableFiles:number;
    readonly scanComplete:boolean;readonly queryCoverageComplete:boolean};
  readonly outputComplete:boolean;
  readonly work:{readonly documents:number;readonly sourceBytes:number;readonly units:number};
};
