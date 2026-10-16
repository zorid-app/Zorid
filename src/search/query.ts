/** Original search engine. Static compatibility contract: docs/search-reference.md.
 * All ranges are half-open JavaScript UTF-16 offsets. No vault IO occurs here.
 */
export type SearchRange = [number, number];
export type SearchScope = 'file' | 'path' | 'content' | 'line' | 'block' | 'section' | 'task' | 'task-todo' | 'task-done' | 'tag' | 'match-case' | 'ignore-case';
export type SearchQueryNode =
  | { kind: 'text' | 'quote' | 'regex'; value: string; start: number; end: number }
  | { kind: 'constant'; value: 'TRUE' | 'FALSE' | 'EMPTY'; start: number; end: number }
  | { kind: 'and' | 'or'; children: SearchQueryNode[]; start: number; end: number }
  | { kind: 'not'; child: SearchQueryNode; start: number; end: number }
  | { kind: 'compare'; operator: '<' | '>'; value: string; start: number; end: number }
  | { kind: 'scope'; scope: SearchScope; child: SearchQueryNode; start: number; end: number }
  | { kind: 'property'; key: SearchQueryNode; value: SearchQueryNode | null; start: number; end: number };

export class SearchQueryError extends Error {
  readonly code: 'unknown-operator' | 'invalid-nesting' | 'invalid-operand' | 'invalid-regex';
  readonly position: number;
  constructor(code: SearchQueryError['code'], position: number, message: string) {
    super(message); this.name = 'SearchQueryError'; this.code = code; this.position = position;
  }
}

export interface SearchPropertyMatch { key: string; subkey?: number[]; pos?: SearchRange }
export interface SearchMatch {
  content?: SearchRange[];
  filename?: SearchRange[];
  filepath?: SearchRange[];
  propertyName?: SearchRange[];
  tag?: SearchRange[];
  properties?: SearchPropertyMatch[];
}
export interface SearchMetadata {
  frontmatter?: Record<string, unknown>;
  tags?: readonly (string | { tag: string; start: number; end: number })[];
  headings?: readonly { level: number; line?: number; start?: number }[];
  sections?: readonly { type: string; start: number; end: number }[];
  listItems?: readonly { start: number; end: number; task?: string }[];
}
export interface SearchDocument { path: string; text: string; metadata?: SearchMetadata }
export interface SearchQueryOptions { caseSensitive?: boolean }
export interface SearchRequiredInputs { content: boolean; metadata: boolean }
export interface CompiledSearchQuery {
  readonly query: string;
  readonly ast: SearchQueryNode | null;
  readonly requiredInputs: SearchRequiredInputs;
  match(document: SearchDocument | PreparedSearchDocument): SearchMatch | null;
}

interface Token { kind: string; value: string; start: number; end: number }
const scopes = new Set<SearchScope>(['file', 'path', 'content', 'line', 'block', 'section', 'task', 'task-todo', 'task-done', 'tag', 'match-case', 'ignore-case']);
const isExclusive = (scope: string): boolean => scope !== 'match-case' && scope !== 'ignore-case' && scope !== '[';
const emptyText = (at: number): SearchQueryNode => ({ kind: 'text', value: '', start: at, end: at });

function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  while (cursor < query.length) {
    const start = cursor, first = query[cursor];
    if (first === ' ') { cursor++; continue; }
    if (first === '"' || first === '/') {
      cursor++;
      let value = '';
      while (cursor < query.length) {
        const character = query[cursor++];
        if (character === first) break;
        if (character === '\\' && cursor < query.length) {
          const next = query[cursor];
          if (first === '"' || next === '/') { value += next; cursor++; continue; }
          if (next === '\\') { value += '\\\\'; cursor++; continue; }
        }
        value += character;
      }
      tokens.push({ kind: first === '"' ? 'quote' : 'regex', value, start, end: cursor });
    } else if ('-[]():<>'.includes(first)) {
      tokens.push({ kind: first, value: first, start, end: ++cursor });
    } else {
      while (cursor < query.length && !' []():<>'.includes(query[cursor])) cursor++;
      const value = query.slice(start, cursor);
      tokens.push({ kind: ['OR', 'TRUE', 'FALSE', 'EMPTY'].includes(value) ? value : 'text', value, start, end: cursor });
    }
  }
  return tokens;
}

/** Incomplete delimiters and trailing OR retain the audited editor-friendly grammar. */
export function parseSearchQuery(query: string): SearchQueryNode | null {
  const tokens = tokenize(query);
  let cursor = 0;
  function group(kind: 'and' | 'or', children: SearchQueryNode[]): SearchQueryNode | null {
    return children.length === 0 ? null : children.length === 1 ? children[0]
      : { kind, children, start: children[0].start, end: children[children.length - 1].end };
  }
  function disjunction(stack: string[]): SearchQueryNode | null {
    const children: SearchQueryNode[] = [];
    while (cursor < tokens.length) {
      const child = conjunction(stack);
      if (!child) break;
      children.push(child);
      if (tokens[cursor]?.kind !== 'OR') break;
      cursor++;
    }
    return group('or', children);
  }
  function conjunction(stack: string[]): SearchQueryNode | null {
    const children: SearchQueryNode[] = [];
    while (cursor < tokens.length) {
      const child = unary(stack);
      if (!child) break;
      children.push(child);
    }
    return group('and', children);
  }
  function unary(stack: string[]): SearchQueryNode | null {
    const token = tokens[cursor];
    if (!token || [')', ']', ':', 'OR'].includes(token.kind)) return null;
    cursor++;
    if (token.kind === 'text' && tokens[cursor]?.kind === ':' && !stack.includes('[')) {
      cursor++;
      const name = token.value.toLowerCase();
      if (!scopes.has(name as SearchScope)) throw new SearchQueryError('unknown-operator', token.start, `Unknown search operator: ${name}`);
      const scope = name as SearchScope;
      if (isExclusive(scope)) {
        const outer = stack.find(value => isExclusive(value));
        if (outer && !(outer === 'section' && scope === 'section')) throw new SearchQueryError('invalid-nesting', token.start, `${scope} cannot be nested in ${outer}`);
      }
      const child = unary([...stack, scope]) ?? emptyText(tokens[cursor - 1].end);
      if (scope === 'tag' && child.kind !== 'text') throw new SearchQueryError('invalid-operand', child.start, 'tag requires plain text');
      return { kind: 'scope', scope, child, start: token.start, end: child.end };
    }
    if (token.kind === '[') {
      if (stack.includes('[')) throw new SearchQueryError('invalid-nesting', token.start, 'Properties cannot be nested');
      const key = disjunction([...stack, '[']) ?? emptyText(token.end);
      let value: SearchQueryNode | null = null;
      if (tokens[cursor]?.kind === ':') { cursor++; value = disjunction([...stack, '[']); }
      let end = value?.end ?? key.end;
      if (tokens[cursor]?.kind === ']') end = tokens[cursor++].end;
      return { kind: 'property', key, value, start: token.start, end };
    }
    if (token.kind === '(') {
      const child = disjunction(stack) ?? emptyText(token.end);
      if (tokens[cursor]?.kind === ')') cursor++;
      return child;
    }
    if (token.kind === '-') {
      const child = unary(stack);
      return child ? { kind: 'not', child, start: token.start, end: child.end } : null;
    }
    if (token.kind === '<' || token.kind === '>') {
      const child = unary(stack);
      if (!child) return null;
      if (child.kind !== 'text' && child.kind !== 'quote') throw new SearchQueryError('invalid-operand', token.start, 'Comparisons require text or quoted text');
      return { kind: 'compare', operator: token.kind, value: child.value, start: token.start, end: child.end };
    }
    if (token.kind === 'regex') {
      try { new RegExp(token.value); }
      catch { throw new SearchQueryError('invalid-regex', token.start, 'Invalid regular expression'); }
    }
    if (token.kind === 'TRUE' || token.kind === 'FALSE' || token.kind === 'EMPTY') return { kind: 'constant', value: token.kind, start: token.start, end: token.end };
    return { kind: token.kind as 'text' | 'quote' | 'regex', value: token.value, start: token.start, end: token.end };
  }
  return disjunction([]);
}

interface HeadingInterval { start: number; end: number; level: number; descendantEnd: number }
/** Prepare one immutable document snapshot per pass; replace it when text/metadata changes.
 * Derived indexes are built once on demand. Metadata is borrowed, never mutated. */
export class PreparedSearchDocument {
  readonly path: string;
  readonly text: string;
  readonly metadata?: SearchMetadata;
  private lines?: SearchRange[];
  private headings?: HeadingInterval[];
  private blocks?: { start: number; end: number }[];
  private tasks?: { start: number; end: number; task?: string }[];
  constructor(document: SearchDocument) {
    this.path = document.path; this.text = document.text; this.metadata = document.metadata;
  }
  lineRanges(): readonly SearchRange[] {
    if (!this.lines) {
      this.lines = [];
      let start = 0;
      for (let position = 0; position < this.text.length; position++) if (this.text[position] === '\n') { this.lines.push([start, position]); start = position + 1; }
      this.lines.push([start, this.text.length]);
    }
    return this.lines;
  }
  blockRanges(): readonly { start: number; end: number }[] {
    return this.blocks ??= [...(this.metadata?.sections ?? []).filter(section => section.type !== 'list'), ...(this.metadata?.listItems ?? [])];
  }
  taskRanges(): readonly { start: number; end: number; task?: string }[] {
    return this.tasks ??= (this.metadata?.listItems ?? []).filter(item => item.task !== undefined);
  }
  headingIntervals(): readonly HeadingInterval[] {
    if (!this.headings) {
      const headings = this.metadata?.headings ?? [];
      const position = (heading: typeof headings[number]): number => heading.start ?? this.lineRanges()[heading.line ?? 0]?.[0] ?? this.text.length;
      this.headings = headings.map((heading, index) => ({ start: position(heading), end: index + 1 < headings.length ? position(headings[index + 1]) : this.text.length, level: heading.level, descendantEnd: headings.length }));
      const ancestors: number[] = [];
      for (let index = 0; index < this.headings.length; index++) {
        while (ancestors.length && this.headings[ancestors[ancestors.length - 1]].level >= this.headings[index].level) this.headings[ancestors.pop()!].descendantEnd = index;
        ancestors.push(index);
      }
      if (this.headings[0]?.start > 0) {
        for (const heading of this.headings) heading.descendantEnd++;
        this.headings.unshift({ start: 0, end: this.headings[0].start, level: 0, descendantEnd: 1 });
      }
    }
    return this.headings;
  }
}
export function prepareSearchDocument(document: SearchDocument): PreparedSearchDocument { return new PreparedSearchDocument(document); }

type Field = 'content' | 'filename' | 'filepath' | 'propertyName' | 'tag';
const fields: Field[] = ['content', 'filename', 'filepath', 'propertyName', 'tag'];
type Outcome = SearchMatch | null | undefined;
interface Context {
  document: PreparedSearchDocument;
  strings: Partial<Record<Field, string>>;
  active: Field[];
  caseSensitive: boolean;
  typed?: unknown;
  section?: number | 'whole';
}

/** Merge touching as well as overlapping ranges without mutating caller-owned metadata. */
export function mergeSearchRanges(ranges: readonly SearchRange[]): SearchRange[] {
  const ordered = ranges.map(([start, end]): SearchRange => [start, end]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const result: SearchRange[] = [];
  for (const range of ordered) {
    const previous = result[result.length - 1];
    if (previous && previous[1] >= range[0]) previous[1] = Math.max(previous[1], range[1]);
    else result.push(range);
  }
  return result;
}
function combine(left: SearchMatch, right: SearchMatch): SearchMatch {
  const merged: SearchMatch = { ...left };
  for (const field of fields) if (right[field]) merged[field] = [...(left[field] ?? []), ...right[field]!];
  if (right.properties) merged.properties = [...(left.properties ?? []), ...right.properties];
  return merged;
}
function requirements(node: SearchQueryNode | null): SearchRequiredInputs {
  if (!node) return { content: false, metadata: false };
  if (node.kind === 'and' || node.kind === 'or') return node.children.map(requirements).reduce((a, b) => ({ content: a.content || b.content, metadata: a.metadata || b.metadata }), { content: false, metadata: false });
  if (node.kind === 'not') return requirements(node.child);
  if (node.kind === 'property') return { content: false, metadata: true };
  if (node.kind === 'scope') {
    if (node.scope === 'file' || node.scope === 'path') return { content: false, metadata: requirements(node.child).metadata };
    if (node.scope === 'match-case' || node.scope === 'ignore-case') return requirements(node.child);
    return { content: true, metadata: ['block', 'section', 'task', 'task-todo', 'task-done', 'tag'].includes(node.scope) || requirements(node.child).metadata };
  }
  return { content: ['text', 'quote', 'regex'].includes(node.kind), metadata: false };
}
const literalPattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The shipped boundary table is historical. Modern BMP letter/digit classification
// is an explicit approximation for newly assigned characters; see the audit.
const wordCharacter = (character: string): boolean => /[\p{L}\p{Nd}]/u.test(character);

export function compileSearchQuery(query: string, options: SearchQueryOptions = {}): CompiledSearchQuery {
  const ast = parseSearchQuery(query);
  const regexes = new Map<string, RegExp>();
  function regex(pattern: string, sensitive: boolean): RegExp {
    const key = `${sensitive ? 's' : 'i'}:${pattern}`;
    let expression = regexes.get(key);
    if (!expression) { expression = new RegExp(pattern, sensitive ? 'gm' : 'gmi'); regexes.set(key, expression); }
    return expression;
  }
  function textMatch(node: Extract<SearchQueryNode, { kind: 'text' | 'quote' | 'regex' }>, context: Context): Outcome {
    if (!node.value) return node.kind === 'text' ? null : undefined;
    const result: SearchMatch = {};
    for (const field of context.active) {
      const text = context.strings[field] ?? '';
      if (field === 'propertyName' && node.kind === 'quote') {
        if (text.toLowerCase() === node.value.toLowerCase()) result[field] = [[0, node.value.length]];
        continue;
      }
      const expression = regex(node.kind === 'regex' ? node.value : literalPattern(node.value), context.caseSensitive);
      expression.lastIndex = 0;
      const matches: SearchRange[] = [];
      let match: RegExpExecArray | null;
      while ((match = expression.exec(text))) {
        if (!match[0].length) { expression.lastIndex++; continue; }
        const start = match.index, end = start + match[0].length;
        if (node.kind === 'quote' && field === 'content') {
          if (wordCharacter(node.value[0]) && start > 0 && wordCharacter(text[start - 1])) continue;
          if (wordCharacter(node.value[node.value.length - 1]) && end < text.length && wordCharacter(text[end])) continue;
        }
        matches.push([start, end]);
      }
      if (matches.length) result[field] = matches;
    }
    return Object.keys(result).length ? result : null;
  }
  function segments(node: SearchQueryNode, context: Context, ranges: Iterable<SearchRange | { start: number; end: number; section?: number }>, allTasks = false): Outcome {
    let result: SearchMatch | null = null, unavailable = false;
    const parentStart = typeof context.section === 'number' ? context.document.headingIntervals()[context.section].start : 0;
    for (const input of ranges) {
      const range = Array.isArray(input) ? { start: input[0], end: input[1], section: undefined } : input;
      const text = context.document.text.slice(range.start, range.end);
      const childContext: Context = { ...context, strings: { ...context.strings, content: text }, active: ['content'], section: range.section ?? context.section };
      const match = allTasks ? { content: [[0, 0]] as SearchRange[] } : evaluate(node, childContext);
      if (match === undefined) unavailable = true;
      else if (match) {
        const offset = range.start - parentStart;
        const hits: SearchRange[] = match.content ? match.content.map(([start, end]) => [start + offset, end + offset]) : [[offset, offset]];
        result = combine(result ?? {}, { content: hits });
      }
    }
    return result ?? (unavailable ? undefined : null);
  }
  function property(node: Extract<SearchQueryNode, { kind: 'property' }>, context: Context): Outcome {
    if (!Object.hasOwn(context.strings, 'content')) return undefined;
    const frontmatter = context.document.metadata?.frontmatter;
    if (!frontmatter) return null;
    const properties: SearchPropertyMatch[] = [];
    for (const key of Object.keys(frontmatter)) {
      if (!evaluate(node.key, { ...context, strings: { ...context.strings, propertyName: key }, active: ['propertyName'] })) continue;
      if (!node.value) { properties.push({ key }); continue; }
      const value = frontmatter[key], array = Array.isArray(value), values = array ? value : [value];
      values.forEach((item, index) => {
        const found = evaluate(node.value!, { ...context, strings: { ...context.strings, content: String(item) }, active: ['content'], typed: item });
        if (found?.content) for (const pos of array ? mergeSearchRanges(found.content) : found.content) properties.push(array ? { key, subkey: [index], pos } : { key, pos });
      });
    }
    return properties.length ? { properties } : null;
  }
  function scoped(node: Extract<SearchQueryNode, { kind: 'scope' }>, context: Context): Outcome {
    const { scope, child } = node;
    if (scope === 'match-case' || scope === 'ignore-case') return evaluate(child, { ...context, caseSensitive: scope === 'match-case' });
    if (scope === 'file' || scope === 'path' || scope === 'content') {
      const key = scope === 'file' ? 'filename' : scope === 'path' ? 'filepath' : 'content';
      return Object.hasOwn(context.strings, key) ? evaluate(child, { ...context, active: [key] }) : undefined;
    }
    if (scope === 'tag') {
      const value = (child as Extract<SearchQueryNode, { kind: 'text' | 'quote' | 'regex' }>).value;
      const prefix = value.startsWith('#') ? value : `#${value}`;
      const accepts = (tag: string): boolean => { const normalized = (tag.startsWith('#') ? tag : `#${tag}`).toLowerCase(), target = prefix.toLowerCase(); return normalized === target || normalized.startsWith(`${target}/`); };
      const metadata = context.document.metadata;
      if (!metadata) return null;
      const matches: SearchMatch = { content: [] };
      let found = false;
      for (const tag of metadata.tags ?? []) {
        if (!accepts(typeof tag === 'string' ? tag : tag.tag)) continue;
        found = true;
        if (typeof tag !== 'string') matches.content!.push([tag.start, tag.end]);
      }
      const frontmatter = metadata.frontmatter ?? {};
      const tagKey = Object.keys(frontmatter).find(key => key.toLowerCase() === 'tags');
      if (tagKey !== undefined) {
        const tags = frontmatter[tagKey];
        const values = Array.isArray(tags) ? tags : typeof tags === 'string' ? [tags] : [];
        if (values.some(tag => {
          if (typeof tag !== 'string') return false;
          const value = tag.trim();
          return Boolean(value) && !value.includes(' ') && accepts(value);
        })) {
          found = true;
          matches.properties = [{ key: Object.hasOwn(frontmatter, 'tags') ? 'tags' : tagKey }];
        }
      }
      return found ? matches : null;
    }
    if (scope === 'line') return segments(child, context, context.document.lineRanges());
    const metadata = context.document.metadata;
    if (!metadata) return null;
    if (scope === 'block') return segments(child, context, context.document.blockRanges());
    if (scope === 'section') {
      if (metadata.headings === undefined) return context.section !== undefined ? null : evaluate(child, { ...context, section: 'whole' });
      const headings = context.document.headingIntervals();
      const parent = typeof context.section === 'number' ? context.section : undefined;
      const start = parent === undefined ? 0 : parent + 1, end = parent === undefined ? headings.length : headings[parent].descendantEnd;
      return segments(child, context, headings.slice(start, end).map((heading, index) => ({ ...heading, section: start + index })));
    }
    const tasks = context.document.taskRanges().filter(item => scope === 'task' || (scope === 'task-todo') === (item.task === ' '));
    return segments(child, context, tasks, child.kind === 'quote' && child.value === '');
  }
  function evaluate(node: SearchQueryNode, context: Context): Outcome {
    switch (node.kind) {
      case 'text': case 'quote': case 'regex': return textMatch(node, context);
      case 'constant': {
        const expected = node.value === 'TRUE' ? true : node.value === 'FALSE' ? false : null;
        const actual = Object.hasOwn(context, 'typed') ? context.typed : null;
        return actual === expected ? { content: [[0, String(actual).length]] } : null;
      }
      case 'compare': {
        const value = context.typed;
        // Relational operators deliberately retain JS coercion, including lexical strings.
        if (value === null || value === undefined) return null;
        const comparable = value as string;
        return (node.operator === '<' ? comparable < node.value : comparable > node.value) ? { content: [[0, String(value).length]] } : null;
      }
      case 'not': { const found = evaluate(node.child, context); return found === undefined ? undefined : found ? null : {}; }
      case 'and': case 'or': {
        let result: Outcome;
        for (const child of node.children) {
          const found = evaluate(child, context);
          if (node.kind === 'and' && found === null) return null;
          if (found) result = combine(result ?? {}, found);
          else if (result === undefined && found === null) result = null;
        }
        return result;
      }
      case 'property': return property(node, context);
      case 'scope': return scoped(node, context);
    }
  }
  return {
    query, ast, requiredInputs: requirements(ast),
    match(input) {
      if (!ast) return null;
      const document = input instanceof PreparedSearchDocument ? input : prepareSearchDocument(input);
      const filename = document.path.slice(document.path.lastIndexOf('/') + 1);
      const extension = filename.slice(filename.lastIndexOf('.') + 1);
      const active: Field[] = ['md', 'canvas', 'base'].includes(extension) ? ['filename'] : [];
      if (extension === 'md') active.push('content');
      const result = evaluate(ast, { document, strings: { filename, filepath: document.path, content: document.text }, active, caseSensitive: options.caseSensitive ?? false });
      if (result === null) return null;
      const normalized = { ...result };
      for (const field of fields) if (normalized[field]) normalized[field] = mergeSearchRanges(normalized[field]!);
      return normalized;
    },
  };
}
