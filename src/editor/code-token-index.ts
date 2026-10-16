import type { CodeToken } from './code-highlight.ts';

/** Balanced source-range index; subtree end bounds also handle overlapping token runs. */
export class CodeTokenIndex {
  readonly tokens: readonly CodeToken[];
  private readonly ends: number[];
  constructor(tokens: readonly CodeToken[]) {
    this.tokens = tokens; this.ends = new Array(tokens.length);
    const build = (low: number, high: number): number => {
      if (low >= high) return 0;
      const middle = (low + high) >>> 1;
      return this.ends[middle] = Math.max(tokens[middle].to, build(low, middle), build(middle + 1, high));
    };
    build(0, tokens.length);
  }
  /** Input tokens are sorted by from. Skip subtrees before/after the query, visiting results in source order. */
  visit(from: number, to: number, callback: (token: CodeToken, index: number) => void): void {
    if (to <= from) return;
    const seek = (low: number, high: number): void => {
      if (low >= high) return;
      const middle = (low + high) >>> 1;
      if (this.ends[middle] <= from) return;
      const token = this.tokens[middle];
      seek(low, middle);
      if (token.from >= to) return;
      if (token.to > from) callback(token, middle);
      seek(middle + 1, high);
    };
    seek(0, this.tokens.length);
  }
}
