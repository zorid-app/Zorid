import type { DocumentBaseInlineSource, DocumentBaseResult } from '../core/document-semantics.ts';
import type { DocumentBasePreviewResult } from '../core/document-preview.ts';
import { BaseDocument } from './document.ts';
import type { BaseValue, BaseViewConfig } from './document.ts';
import { BASE_NULL, BaseExpressionError, BaseFunctionRegistry, baseDate, baseExpressionValue, baseValueIsTruthy, baseValuesEqual, baseValueToString, evaluateBaseExpression, evaluateBaseExpressionOrThrow, parseBaseExpression } from './expression.ts';
import type { BaseExpression, BaseExpressionContext, BaseExpressionValue, BaseNamespaceValue } from './expression.ts';

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
  /** Selected IANA/fixed timezone; omitted uses the host device timezone. */
  readonly timezone?: string;
  readonly maxSteps?: number;
  readonly ignore?: (path: string) => boolean;
  /** Pre-tokenized terms; matching spans visible properties, never file contents. */
  readonly searchTerms?: readonly string[];
  readonly inlineSource?: DocumentBaseInlineSource;
  readonly summaryPreviewProperty?: string;
  readonly summaryPreviewGroupKeyId?: string;
  readonly randomSeed?: number;
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
  /** Opaque Rust grouping identity; absent on legacy evaluator results. */
  readonly sharedKeyId?: string | null;
  /** JS null denotes an ungrouped result; typed null denotes the empty-key group. */
  readonly key: BaseExpressionValue | null;
  readonly rows: readonly BaseQueryRow[];
  readonly summaries?: Readonly<Record<string, BaseExpressionValue>>;
}
export interface BaseQueryGroupOption {
  readonly sharedKeyId?: string;
  readonly key: BaseExpressionValue;
  /** Matching rows before search, sorting and the limit. */
  readonly count: number;
  readonly listed: boolean;
}
export interface BaseQueryResult {
  readonly summaryPreviews?: Readonly<Record<string, BaseExpressionValue>>;
  readonly summaries?: Readonly<Record<string, BaseExpressionValue>>;
  readonly relationTargets?: DocumentBaseResult['relationTargets'];
  /** Read-only shared evidence marks Rust-owned row/group/query semantics. */
  readonly shared?: DocumentBaseResult | DocumentBasePreviewResult;
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

export class BaseQueryError extends Error {
  constructor(message: string) { super(message); this.name = 'BaseQueryError'; }
}
type Direction = 'ASC' | 'DESC';
type Criterion = Readonly<{ property: string; direction: Direction }>;
type Filter = { kind: 'expression'; expression: BaseExpression | BaseExpressionError }
  | { kind: 'and' | 'or' | 'not'; children: readonly Filter[] };
interface Entry {
  path: string;
  note: Extract<BaseExpressionValue, { type: 'object' }>;
  file: BaseNamespaceValue;
  context: BaseExpressionContext;
  value(property: string): BaseExpressionValue;
}
const scalarFileProperties = ['file.file', 'file.name', 'file.basename', 'file.fullname', 'file.path', 'file.folder', 'file.ext', 'file.ctime', 'file.mtime', 'file.size', 'file.tags'] as const;
const stringValue = (value: string): BaseExpressionValue => ({ type: 'string', value });
const errorValue = (error: unknown): Extract<BaseExpressionValue, { type: 'error' }> => ({ type: 'error', error: error instanceof BaseExpressionError ? error : new BaseExpressionError('unsupported', error instanceof Error ? error.message : String(error)) });
const raise = (message: string): never => { throw new BaseQueryError(message); };
const mapping = (value: unknown): value is Readonly<Record<string, BaseValue>> => value !== null && typeof value === 'object' && !Array.isArray(value);
const ownKey = (value: Readonly<Record<string, unknown>>, name: string) => Object.hasOwn(value, name) ? name : Object.keys(value).find(key => key.toLowerCase() === name.toLowerCase());

/** Persisted property normalization is case-sensitive; runtime note lookup is not. */
export function normalizeBaseProperty(property: string): string {
  if (typeof property !== 'string') return raise('Property IDs must be strings');
  return /^(?:note|file|formula)\./.test(property) ? property : property === 'file' ? 'file.file' : `note.${property}`;
}
function validateComposite(value: BaseExpressionValue, ancestors = new Set<object>()): void {
  if (value.type !== 'list' && value.type !== 'object') return;
  if (ancestors.has(value) || ancestors.size >= 256) throw new BaseExpressionError('unsupported', 'Cyclic or excessively nested result value');
  ancestors.add(value);
  try { for (const item of value.type === 'list' ? value.value : Object.values(value.value)) validateComposite(item, ancestors); }
  finally { ancestors.delete(value); }
}
function compile(source: string): BaseExpression | BaseExpressionError {
  try { return parseBaseExpression(source); } catch (error) { return errorValue(error).error; }
}
function parseFilter(value: BaseValue, depth = 0): Filter {
  if (depth > 256) return raise('Filter nesting exceeds 256');
  if (typeof value === 'string') return { kind: 'expression', expression: compile(value) };
  if (!mapping(value) || Object.keys(value).length !== 1) return raise('A filter must be an expression or exactly one and/or/not array');
  const kind = Object.keys(value)[0];
  if (kind !== 'and' && kind !== 'or' && kind !== 'not') return raise('Unknown filter conjunction');
  const children = value[kind];
  if (!Array.isArray(children)) return raise('Filter children must be an array');
  return { kind, children: children.map(child => parseFilter(child, depth + 1)) };
}
function optimize(filter: Filter): Filter | undefined {
  if (filter.kind === 'expression') return filter;
  const children: Filter[] = [];
  for (const child of filter.children) {
    const optimized = optimize(child);
    if (!optimized) continue;
    if (filter.kind !== 'not' && optimized.kind === filter.kind) { for (const nested of optimized.children) children.push(nested); }
    else children.push(optimized);
  }
  if (!children.length) return undefined;
  if (filter.kind !== 'not' && children.length === 1) return children[0];
  if (filter.kind === 'not' && children.length === 1 && children[0].kind === 'not') return optimize({ kind: 'and', children: children[0].children });
  return { kind: filter.kind, children };
}
function effectiveFilter(root: BaseValue | undefined, view: BaseValue | undefined): Filter | undefined {
  // The observed conjunction helper returns a lone filter unchanged. Empty
  // groups are removed only when combining two filters through optimization.
  const filters = [root, view].filter(value => !!value).map(value => parseFilter(value!));
  return filters.length === 1 ? filters[0] : optimize({ kind: 'and', children: filters });
}
function testFilter(filter: Filter, context: BaseExpressionContext): boolean {
  if (filter.kind === 'expression') {
    if (filter.expression instanceof BaseExpressionError) throw filter.expression;
    const value = evaluateBaseExpressionOrThrow(filter.expression, context);
    if (value.type === 'error') throw value.error;
    return baseValueIsTruthy(value);
  }
  if (filter.kind === 'and') return filter.children.every(child => testFilter(child, context));
  if (filter.kind === 'or') return filter.children.some(child => testFilter(child, context));
  return !filter.children.some(child => testFilter(child, context));
}
function readCriterion(value: BaseValue | undefined): Criterion | undefined {
  if (!mapping(value)) return undefined;
  const property = value.column || value.property;
  return typeof property === 'string' && property && (value.direction === 'ASC' || value.direction === 'DESC')
    ? { property: normalizeBaseProperty(property), direction: value.direction } : undefined;
}
function display(value: BaseExpressionValue, files: WeakSet<object>): string {
  if (value.type === 'error') throw value.error;
  if (value.type === 'namespace' && files.has(value)) return value.name;
  return baseValueToString(value);
}
function durationScalar(value: Extract<BaseExpressionValue, { type: 'duration' }>, now: Date): number {
  const date = new Date(now.getTime());
  if (value.years) date.setFullYear(date.getFullYear() + value.years);
  if (value.months) date.setMonth(date.getMonth() + value.months);
  if (value.days) date.setDate(date.getDate() + value.days);
  if (value.hours) date.setHours(date.getHours() + value.hours);
  if (value.minutes) date.setMinutes(date.getMinutes() + value.minutes);
  if (value.seconds) date.setSeconds(date.getSeconds() + value.seconds);
  if (value.milliseconds) date.setMilliseconds(date.getMilliseconds() + value.milliseconds);
  return date.getTime() - now.getTime();
}

/**
 * Execute synchronously over detached metadata. Every call starts new per-file
 * formula caches; no live vault, incremental dependency graph or renderer is owned.
 */
export function executeBaseQuery(document: BaseDocument, snapshot: BaseQuerySnapshot, options: BaseQueryOptions = {}): BaseQueryResult {
  const version = snapshot.version, inputFiles = [...snapshot.files];
  if ((typeof version !== 'string' && typeof version !== 'number') || (typeof version === 'number' && !Number.isFinite(version))) return raise('Snapshot version must be a string or finite number');
  const viewIndex = options.viewIndex ?? 0;
  if (!Number.isInteger(viewIndex) || !document.views[viewIndex]) return raise('View index is out of range');
  const view = document.views[viewIndex], filter = effectiveFilter(document.getRoot('filters'), view.filters);
  if (options.maxSteps !== undefined && (!Number.isSafeInteger(options.maxSteps) || options.maxSteps < 0)) return raise('maxSteps must be a finite nonnegative safe integer');
  const formulasValue = document.getRoot('formulas');
  if (formulasValue !== undefined && !mapping(formulasValue)) return raise('Formulas must be a named mapping');
  const formulas: Record<string, BaseExpression | BaseExpressionError> = Object.create(null);
  for (const [name, source] of Object.entries(formulasValue ?? {})) {
    if (typeof source !== 'string') return raise('Formula definitions must be expression strings');
    formulas[name] = compile(source);
  }
  if (view.order !== undefined && (!Array.isArray(view.order) || !view.order.every(value => typeof value === 'string'))) return raise('View order must be an array of property IDs');
  const order = (view.order === undefined ? ['file.name'] : view.order as readonly string[]).map(normalizeBaseProperty);
  let groupBy: Criterion | undefined;
  if (view.groupBy !== undefined) {
    if (!mapping(view.groupBy) || !Object.hasOwn(view.groupBy, 'property') || !Object.hasOwn(view.groupBy, 'direction')) return raise('groupBy requires property and direction');
    groupBy = readCriterion(view.groupBy);
  }
  const groupOrder = groupBy && Array.isArray(view.groupOrder) ? view.groupOrder.map(value => baseExpressionValue(value)) : undefined;
  const configuredSort = Array.isArray(view.sort) ? view.sort.map(readCriterion).filter((value): value is Criterion => !!value) : [];
  const limit = typeof view.limit === 'number' && view.limit > 0 ? view.limit : 0;
  const terms = (options.searchTerms ?? []).map(term => {
    if (typeof term !== 'string') return raise('Search terms must be strings');
    return term.toLowerCase();
  });
  const diagnostics: BaseQueryDiagnostic[] = [], diagnosticKeys = new Set<string>();
  function report(phase: BaseQueryDiagnostic['phase'], path: string, error: unknown, property?: string) {
    const { code, message } = errorValue(error).error;
    const key = JSON.stringify([phase, path, property, code, message]);
    if (!diagnosticKeys.has(key)) { diagnosticKeys.add(key); diagnostics.push(Object.freeze({ phase, path, ...(property === undefined ? {} : { property }), code, message })); }
  }
  const fileFields = new WeakMap<object, Readonly<Record<string, BaseExpressionValue>>>();
  const fileValues = new WeakSet<object>(), fileInfo = new WeakMap<object, { path: string; tags: readonly string[]; properties: Readonly<Record<string, BaseExpressionValue>> }>();
  class QueryFunctions extends BaseFunctionRegistry {
    override find(name: string, subject?: BaseExpressionValue) { return options.functions?.find(name, subject) ?? super.find(name, subject); }
  }
  const functions = new QueryFunctions();
  const requireFile = (subject?: BaseExpressionValue) => {
    const file = subject && fileInfo.get(subject);
    if (!file) throw new BaseExpressionError('type', 'This method requires a snapshot file value');
    return file;
  };
  functions.register('toString', { receiver: 'namespace', parameters: [], invoke: (_, __, subject) => stringValue(requireFile(subject).path) });
  functions.register('inFolder', { receiver: 'namespace', parameters: [{ types: ['string'] }], invoke: ([arg], _, subject) => {
    const folder = (arg as Extract<BaseExpressionValue, { type: 'string' }>).value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
    return { type: 'boolean', value: !folder || requireFile(subject).path.startsWith(`${folder}/`) };
  } });
  functions.register('hasProperty', { receiver: 'namespace', parameters: [{ types: ['string'] }], invoke: ([arg], _, subject) => ({ type: 'boolean', value: Object.hasOwn(requireFile(subject).properties, (arg as Extract<BaseExpressionValue, { type: 'string' }>).value) }) });
  functions.register('hasTag', { receiver: 'namespace', parameters: [{ types: ['string'], variadic: true }], invoke: (args, _, subject) => {
    const tags = requireFile(subject).tags.map(tag => tag.replace(/^#/, '').toLowerCase());
    return { type: 'boolean', value: args.some(arg => { const tag = (arg as Extract<BaseExpressionValue, { type: 'string' }>).value.replace(/^#/, '').toLowerCase(); return tags.some(candidate => candidate === tag || candidate.startsWith(`${tag}/`)); }) };
  } });
  const entries = new Map<string, Entry>();
  let current: Entry | undefined;
  const thisValue: BaseNamespaceValue = Object.freeze({ type: 'namespace', name: 'this', get: (name: string) => current?.context.resolveIdentifier(name) ?? BASE_NULL });
  const inputPaths = new Set<string>();
  for (const input of inputFiles) {
    if (typeof input.path !== 'string' || !input.path || input.path.startsWith('/') || input.path.includes('\\') || input.path.split('/').some(part => !part || part === '.' || part === '..')) return raise('Snapshot paths must be nonempty normalized vault-relative paths');
    if (inputPaths.has(input.path)) return raise(`Duplicate snapshot path: ${input.path}`);
    inputPaths.add(input.path);
    try {
      const note = baseExpressionValue(input.properties ?? {});
      if (note.type !== 'object') throw new BaseExpressionError('type', 'File properties must be a plain mapping');
      const tags = [...new Set(input.tags ?? [])];
      if (!tags.every(tag => typeof tag === 'string')) throw new BaseExpressionError('type', 'File tags must be strings');
      for (const field of ['ctime', 'mtime', 'size'] as const) if (input[field] !== undefined && !Number.isFinite(input[field])) throw new BaseExpressionError('type', `Invalid file ${field}`);
      const fullname = input.path.slice(input.path.lastIndexOf('/') + 1), dot = fullname.lastIndexOf('.');
      const ext = dot < 0 ? '' : fullname.slice(dot + 1), basename = dot < 0 ? fullname : fullname.slice(0, dot);
      const fields: Readonly<Record<string, BaseExpressionValue>> = {
        name: stringValue(ext === 'md' ? basename : fullname), basename: stringValue(basename), fullname: stringValue(fullname), path: stringValue(input.path),
        folder: stringValue(input.path.includes('/') ? input.path.slice(0, input.path.lastIndexOf('/')) : '/'), ext: stringValue(ext),
        ctime: input.ctime === undefined ? BASE_NULL : baseDate(input.ctime), mtime: input.mtime === undefined ? BASE_NULL : baseDate(input.mtime),
        size: input.size === undefined ? BASE_NULL : baseExpressionValue(input.size), tags: baseExpressionValue(tags), properties: note,
      };
      const file: BaseNamespaceValue = Object.freeze({ type: 'namespace', name: input.path, get(name: string) {
        const key = name.toLowerCase();
        if (key === 'file') return file;
        if (['links', 'backlinks', 'embeds'].includes(key)) throw new BaseExpressionError('unsupported', `file.${key} requires resolved-link metadata support`);
        return Object.hasOwn(fields, key) ? fields[key] : BASE_NULL;
      } });
      fileFields.set(file, fields); fileValues.add(file); fileInfo.set(file, { path: input.path, tags, properties: note.value });
      const formulaCache = new Map<string, BaseExpressionValue>(), pending = new Set<string>();
      const formula: BaseNamespaceValue = { type: 'namespace', name: 'formula', get(name, runtime) {
        const key = ownKey(formulas, name);
        if (key === undefined) return BASE_NULL;
        if (pending.has(key)) throw new BaseExpressionError('cycle', `Circular formula dependency: ${key}`);
        if (!formulaCache.has(key)) {
          pending.add(key);
          try {
            const expression = formulas[key];
            if (expression instanceof BaseExpressionError) throw expression;
            formulaCache.set(key, runtime.evaluate(expression, context));
          } catch (error) {
            const value = errorValue(error);
            if (value.error.code === 'budget') throw value.error;
            formulaCache.set(key, value);
          } finally { pending.delete(key); }
        }
        const result = formulaCache.get(key)!;
        if (result.type === 'error') throw result.error;
        return result;
      } };
      const context: BaseExpressionContext = { functions, now: options.now, maxSteps: options.maxSteps, resolveIdentifier(name) {
        switch (name.toLowerCase()) {
          case 'file': return file;
          case 'note': return note;
          case 'this': return current ? thisValue : BASE_NULL;
          case 'formula': return formula;
        }
        const key = ownKey(note.value, name); return key === undefined ? BASE_NULL : note.value[key];
      } };
      const values = new Map<string, BaseExpressionValue>();
      const entry: Entry = { path: input.path, note, file, context, value(property) {
        if (!values.has(property)) {
          const separator = property.indexOf('.'), namespace = property.slice(0, separator), name = property.slice(separator + 1);
          // A literal property name can contain dots, spaces or prototype names.
          const expression: BaseExpression = { kind: 'member', object: { kind: 'identifier', name: namespace }, key: { kind: 'literal', value: stringValue(name) }, computed: true };
          let value = evaluateBaseExpression(expression, context);
          try { validateComposite(value); } catch (error) { value = errorValue(error); }
          values.set(property, value);
        }
        return values.get(property)!;
      } };
      entries.set(input.path, entry);
    } catch (error) { report('input', input.path, error); }
  }
  if (options.currentFilePath !== undefined) current = entries.get(options.currentFilePath);
  let matched: Entry[] = [];
  for (const entry of entries.values()) {
    if (options.ignore?.(entry.path)) continue;
    try { if (!filter || testFilter(filter, entry.context)) matched.push(entry); }
    catch (error) { report('filter', entry.path, error); }
  }
  const matchedCount = matched.length;
  const clock = options.now?.() ?? new Date();
  const compareText = (left: string, right: string) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
  const read = (entry: Entry, property: string, phase: BaseQueryDiagnostic['phase']): BaseExpressionValue => {
    const value = entry.value(property);
    if (value.type === 'error') { report(phase, entry.path, value.error, property); throw value.error; }
    return value;
  };
  const keyFor = (entry: Entry): BaseExpressionValue => {
    const value = entry.value(groupBy!.property);
    if (value.type === 'error') report('group', entry.path, value.error, groupBy!.property);
    return value;
  };
  const equalGroup = (left: BaseExpressionValue, right: BaseExpressionValue) => baseValuesEqual(left, right, true, clock);
  const orderIndex = (entry: Entry) => {
    const key = keyFor(entry);
    return groupOrder!.findIndex(candidate => equalGroup(candidate, key) || (candidate.type === 'string' && candidate.value === display(key, fileValues)));
  };
  const groupOptions: BaseQueryGroupOption[] = [];
  if (groupOrder) {
    const counts = groupOrder.map(() => 0), unlisted: { key: BaseExpressionValue; count: number }[] = [];
    const listed: Entry[] = [];
    for (const entry of matched) {
      let index = -1;
      try { index = orderIndex(entry); } catch (error) { report('group', entry.path, error, groupBy!.property); }
      if (index >= 0) { counts[index]++; listed.push(entry); }
      else { const key = keyFor(entry), group = unlisted.find(group => equalGroup(group.key, key)); if (group) group.count++; else unlisted.push({ key, count: 1 }); }
    }
    groupOrder.forEach((key, index) => groupOptions.push({ key, count: counts[index], listed: true }));
    groupOptions.push(...unlisted.map(group => ({ ...group, listed: false })));
    matched = listed;
  }
  const afterGroupOrder = matched.length;
  if (terms.length) matched = matched.filter(entry => {
    const remaining = new Set(terms);
    for (const property of order) {
      try { const value = read(entry, property, 'search'); if (value.type === 'null') continue; const text = display(value, fileValues).toLowerCase(); for (const term of remaining) if (text.includes(term)) remaining.delete(term); }
      catch (error) { report('search', entry.path, error, property); }
      if (!remaining.size) return true;
    }
    return !remaining.size;
  });
  const afterSearch = matched.length;
  matched.sort((left, right) => compareText(left.path, right.path));
  const available = new Set<string>(scalarFileProperties);
  for (const entry of matched) for (const key of Object.keys(entry.note.value)) available.add(`note.${key}`);
  for (const key of Object.keys(formulas)) available.add(`formula.${key}`);
  const properties = order.filter(property => available.has(property) || property.startsWith('note.'));
  let sort = configuredSort.filter(criterion => available.has(criterion.property));
  if (!sort.length) sort = [{ property: 'file.name', direction: 'ASC' }];
  matched.sort((left, right) => {
    for (const criterion of sort) {
      try {
        const a = read(left, criterion.property, 'sort'), b = read(right, criterion.property, 'sort');
        let comparison = 0;
        if (a.type === 'null' && b.type === 'null') continue;
        if (a.type === 'boolean' || b.type === 'boolean') comparison = Number(baseValueIsTruthy(a)) - Number(baseValueIsTruthy(b));
        else {
          if (a.type === 'null') return 1;
          if (b.type === 'null') return -1;
          comparison = a.type === 'number' && b.type === 'number' ? a.value - b.value
            : a.type === 'date' && b.type === 'date' ? a.timestamp - b.timestamp
            : a.type === 'duration' && b.type === 'duration' ? durationScalar(a, clock) - durationScalar(b, clock)
            : compareText(display(a, fileValues), display(b, fileValues));
        }
        if (comparison) return criterion.direction === 'ASC' ? comparison : -comparison;
      } catch { return 0; }
    }
    return 0;
  });
  if (limit > 0 && matched.length > limit) matched = matched.slice(0, Math.trunc(limit));
  const immutableFiles = new WeakMap<object, BaseExpressionValue>();
  function freezeValue(value: BaseExpressionValue, ancestors = new Set<object>()): BaseExpressionValue {
    if (value.type === 'namespace') {
      if (!fileValues.has(value)) return freezeValue(errorValue(new BaseExpressionError('unsupported', 'Only snapshot file namespaces can be exposed as result values')));
      let frozen = immutableFiles.get(value);
      if (!frozen) {
        const fields: Record<string, BaseExpressionValue> = Object.create(null);
        frozen = Object.freeze({ type: 'namespace', name: value.name, get(name: string) {
          const key = name.toLowerCase(); if (key === 'file') return frozen!;
          if (['links', 'backlinks', 'embeds'].includes(key)) throw new BaseExpressionError('unsupported', `file.${key} requires resolved-link metadata support`);
          return Object.hasOwn(fields, key) ? fields[key] : BASE_NULL;
        } });
        immutableFiles.set(value, frozen);
        for (const [key, item] of Object.entries(fileFields.get(value)!)) fields[key] = freezeValue(item);
        Object.freeze(fields);
      }
      return frozen;
    }
    if (value.type === 'list' || value.type === 'object') {
      if (ancestors.has(value) || ancestors.size >= 256) return freezeValue(errorValue(new BaseExpressionError('unsupported', 'Cyclic or excessively nested result value')));
      const nested = new Set(ancestors).add(value);
      return value.type === 'list'
        ? Object.freeze({ type: 'list', value: Object.freeze(value.value.map(item => freezeValue(item, nested))) })
        : Object.freeze({ type: 'object', value: Object.freeze(Object.fromEntries(Object.entries(value.value).map(([key, item]) => [key, freezeValue(item, nested)]))) });
    }
    if (value.type === 'regexp') return Object.freeze({ type: 'regexp', value: Object.freeze(new RegExp(value.value.source, value.value.flags)) });
    if (value.type === 'error') return Object.freeze({ type: 'error', error: Object.freeze(new BaseExpressionError(value.error.code, value.error.message, value.error.offset)) });
    return Object.freeze({ ...value });
  }
  const rowMap = new Map<Entry, BaseQueryRow>();
  const visibleValues = [...new Set([...available, ...properties, ...(groupBy ? [groupBy.property] : []), ...(typeof view.image === 'string' && view.image ? [normalizeBaseProperty(view.image)] : [])])];
  const rows = matched.map(entry => {
    const values = Object.fromEntries(visibleValues.map(property => {
      const value = entry.value(property);
      if (value.type === 'error') report('value', entry.path, value.error, property);
      return [property, freezeValue(value)];
    }));
    const row = Object.freeze({ path: entry.path, values: Object.freeze(values) }); rowMap.set(entry, row); return row;
  });
  let groups: { key: BaseExpressionValue | null; rows: BaseQueryRow[] }[] = [];
  if (!groupBy) groups = [{ key: null, rows }];
  else if (groupOrder) {
    groups = groupOrder.map(key => ({ key, rows: [] }));
    for (const entry of matched) { const index = orderIndex(entry); if (index >= 0) { if (!groups[index].rows.length) groups[index].key = keyFor(entry); groups[index].rows.push(rowMap.get(entry)!); } }
    groups = groups.filter(group => group.rows.length);
  } else {
    for (const entry of matched) {
      const key = keyFor(entry), existing = groups.find(group => equalGroup(group.key!, key));
      if (existing) existing.rows.push(rowMap.get(entry)!); else groups.push({ key, rows: [rowMap.get(entry)!] });
    }
    groups.sort((left, right) => {
      const a = left.key!, b = right.key!;
      if (a.type === 'null') return b.type === 'null' ? 0 : 1;
      if (b.type === 'null') return -1;
      try { const comparison = equalGroup(a, b) ? 0 : a.type === 'number' && b.type === 'number' ? a.value - b.value : compareText(display(a, fileValues), display(b, fileValues)); return groupBy!.direction === 'ASC' ? comparison : -comparison; }
      catch (error) { report('group', '', error, groupBy!.property); return 0; }
    });
  }
  return Object.freeze({ version, view, rows: Object.freeze(rows),
    groups: Object.freeze(groups.map(group => Object.freeze({ key: group.key === null ? null : freezeValue(group.key), rows: Object.freeze(group.rows) }))),
    groupOptions: Object.freeze(groupOptions.map(group => Object.freeze({ ...group, key: freezeValue(group.key) }))),
    properties: Object.freeze(properties), availableProperties: Object.freeze([...available]),
    counts: Object.freeze({ scanned: inputFiles.length, matched: matchedCount, afterGroupOrder, afterSearch, returned: rows.length }),
    diagnostics: Object.freeze(diagnostics),
  });
}
