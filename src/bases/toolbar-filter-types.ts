/** Captured metadata for the visual filter editor. This module never samples
 * query rows, evaluates formulas or infers value kinds from property names.
 * Catalog/order source: Obsidian 1.14.4 typed registry audit, 2026-10-22,
 * ev_06ff374bf2513fad613f21d1cab41a5aaa58a2555091cad5df5b00a7da0d7a8e.
 * The registrations are static evidence, not a claim of runtime verification.
 */
export type BaseFilterLiteral = string | number | boolean | null | readonly BaseFilterLiteral[];
export type BaseFilterPropertyKind = 'string' | 'number' | 'boolean' | 'date' | 'list' | 'tagList' | 'file' | 'link' | 'tag' | 'object' | 'null' | 'unknown';
export interface BaseFilterPropertyDescriptor {
  readonly kind: BaseFilterPropertyKind;
  readonly withTime?: boolean;
  readonly comparisonWidget?: 'file' | 'folder' | 'tags';
  readonly choices?: readonly { readonly value: string; readonly label?: string; readonly color?: string }[];
  readonly metadataStatus?: 'pending' | 'current' | 'stale' | 'unavailable';
}
export type BaseFileFilterOperator = 'hasLink' | 'notHasLink' | 'inFolder' | 'notInFolder' | 'hasTag' | 'notHasTag' | 'hasProperty' | 'notHasProperty';
export type BaseFilterOperator = 'eq' | 'neq' | 'contains' | 'gt' | 'lt' | 'gte' | 'lte' | 'unset' | 'set'
  | BaseFileFilterOperator | 'startsWith' | 'notStartsWith' | 'endsWith' | 'notEndsWith'
  | 'isEmpty' | 'isNotEmpty' | 'notContains' | 'containsAny' | 'notContainsAny'
  | 'containsAll' | 'notContainsAll' | 'linksTo' | 'notLinksTo' | 'matches' | 'notMatches';
export type BaseFilterOperand = 'none' | 'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'list' | 'tokens' | 'tags' | 'file' | 'folder' | 'property' | 'readonly';
export interface BaseFilterOperatorDescriptor {
  readonly id: BaseFilterOperator;
  readonly label: string;
  readonly method?: string;
  readonly comparison?: '==' | '!=' | '<' | '<=' | '>' | '>=';
  readonly inverse?: boolean;
  readonly arity: 'none' | 'one' | 'variadic';
  readonly operand: BaseFilterOperand;
}

const methods = new Map<BaseFilterOperator, BaseFilterOperatorDescriptor>();
function methodPair(positive: BaseFilterOperator, negative: BaseFilterOperator, method: string, label: string, inverseLabel: string,
  arity: BaseFilterOperatorDescriptor['arity'], operand: BaseFilterOperand): void {
  methods.set(positive, Object.freeze({ id: positive, label, method, inverse: false, arity, operand }));
  methods.set(negative, Object.freeze({ id: negative, label: inverseLabel, method, inverse: true, arity, operand }));
}
methodPair('startsWith', 'notStartsWith', 'startsWith', 'starts with', 'does not start with', 'one', 'text');
methodPair('endsWith', 'notEndsWith', 'endsWith', 'ends with', 'does not end with', 'one', 'text');
methodPair('isEmpty', 'isNotEmpty', 'isEmpty', 'is empty', 'is not empty', 'none', 'none');
methodPair('contains', 'notContains', 'contains', 'contains', 'does not contain', 'one', 'text');
methodPair('containsAny', 'notContainsAny', 'containsAny', 'contains any of', 'does not contain any of', 'variadic', 'tokens');
methodPair('containsAll', 'notContainsAll', 'containsAll', 'contains all of', 'does not contain all of', 'variadic', 'tokens');
// The reference has no friendly label registration for Link.linksTo, including
// its inverse. Keep that literal fallback distinct from File.hasLink's label.
methodPair('linksTo', 'notLinksTo', 'linksTo', 'linksTo', 'linksTo', 'one', 'text');
methodPair('matches', 'notMatches', 'matches', 'matches', 'does not match', 'one', 'text');
methodPair('hasLink', 'notHasLink', 'hasLink', 'links to', 'does not link to', 'one', 'file');
methodPair('inFolder', 'notInFolder', 'inFolder', 'in folder', 'is not in folder', 'one', 'folder');
methodPair('hasTag', 'notHasTag', 'hasTag', 'has tag', 'does not have tag', 'variadic', 'tags');
methodPair('hasProperty', 'notHasProperty', 'hasProperty', 'has property', 'does not have property', 'one', 'property');

/** Method syntax only. Comparisons and the null-check convenience have no method. */
export function baseFilterMethod(operator: BaseFilterOperator): BaseFilterOperatorDescriptor | undefined {
  return methods.get(operator);
}

const comparisonTokens = { eq: '==', neq: '!=', lt: '<', lte: '<=', gt: '>', gte: '>=' } as const;
type ComparisonId = keyof typeof comparisonTokens;
const comparisonOrder: readonly ComparisonId[] = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte'];
const stringMethods: readonly BaseFilterOperator[] = ['startsWith', 'endsWith', 'isEmpty', 'contains', 'containsAny', 'containsAll'];
const listMethods: readonly BaseFilterOperator[] = ['isEmpty', 'contains', 'containsAny', 'containsAll'];
const fileMethods: readonly BaseFilterOperator[] = ['hasLink', 'inFolder', 'hasTag', 'hasProperty'];

function comparisonOperand(descriptor: BaseFilterPropertyDescriptor): BaseFilterOperand {
  if (descriptor.comparisonWidget) return descriptor.comparisonWidget;
  switch (descriptor.kind) {
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'date': return descriptor.withTime ? 'datetime' : 'date';
    case 'list': return 'list';
    case 'tagList': return 'tags';
    case 'object': return 'readonly';
    default: return 'text';
  }
}

/** Audited comparison order, then every positive method, then every inverse.
 * set/unset test missing OR explicit null; they are not isEmpty/isNotEmpty and
 * appear only to retain a selected, already-loaded non-File null-check filter.
 */
export function baseFilterOperators(descriptor: BaseFilterPropertyDescriptor, selectedOperator?: BaseFilterOperator): readonly BaseFilterOperatorDescriptor[] {
  const output: BaseFilterOperatorDescriptor[] = [];
  if (descriptor.kind !== 'file') {
    const ordered = descriptor.kind === 'number' || descriptor.kind === 'date'
      || selectedOperator === 'lt' || selectedOperator === 'lte' || selectedOperator === 'gt' || selectedOperator === 'gte';
    const ids = ordered ? comparisonOrder : comparisonOrder.slice(0, 2);
    const labels = descriptor.kind === 'number' ? ['=', '≠', '<', '≤', '>', '≥']
      : descriptor.kind === 'date' ? ['on', 'not on', 'before', 'on or before', 'after', 'on or after']
      : descriptor.kind === 'list' || descriptor.kind === 'tagList' ? ['is exactly', 'is not exactly', '<', '≤', '>', '≥']
      : ['is', 'is not', '<', '≤', '>', '≥'];
    for (const [index, id] of ids.entries()) output.push(Object.freeze({ id, label: labels[index], comparison: comparisonTokens[id], arity: 'one', operand: comparisonOperand(descriptor) }));
  }
  const positive = descriptor.kind === 'file' ? fileMethods
    : descriptor.kind === 'string' ? stringMethods
    : descriptor.kind === 'link' ? [...stringMethods, 'linksTo' as const]
    : descriptor.kind === 'tag' ? [...stringMethods, 'matches' as const]
    : descriptor.kind === 'list' || descriptor.kind === 'tagList' ? listMethods
    : descriptor.kind === 'boolean' ? [] : ['isEmpty' as const];
  for (const id of positive) output.push(methods.get(id)!);
  for (const id of positive) {
    const method = methods.get(id)!;
    output.push(Array.from(methods.values()).find(candidate => candidate.inverse && candidate.method === method.method)!);
  }
  if (descriptor.kind !== 'file' && (selectedOperator === 'set' || selectedOperator === 'unset')) {
    output.push(Object.freeze({ id: selectedOperator, label: selectedOperator === 'set' ? 'is set' : 'is not set', comparison: selectedOperator === 'set' ? '!=' : '==', arity: 'none', operand: 'none' }));
  }
  return Object.freeze(output);
}

const builtins: Readonly<Record<string, BaseFilterPropertyDescriptor>> = Object.freeze({
  file: Object.freeze({ kind: 'file' }),
  'file.file': Object.freeze({ kind: 'file' }),
  ...Object.fromEntries(['name', 'basename', 'fullname', 'ext'].map(name => [`file.${name}`, Object.freeze({ kind: 'string' as const })])),
  'file.path': Object.freeze({ kind: 'string', comparisonWidget: 'file' }),
  'file.folder': Object.freeze({ kind: 'string', comparisonWidget: 'folder' }),
  'file.size': Object.freeze({ kind: 'number' }),
  'file.ctime': Object.freeze({ kind: 'date', withTime: false }),
  'file.mtime': Object.freeze({ kind: 'date', withTime: false }),
  'file.links': Object.freeze({ kind: 'list' }),
  'file.embeds': Object.freeze({ kind: 'list' }),
  'file.tags': Object.freeze({ kind: 'tagList', comparisonWidget: 'tags' }),
  'file.properties': Object.freeze({ kind: 'object' }),
});
const declaredTypes: Readonly<Record<string, BaseFilterPropertyDescriptor>> = Object.freeze({
  text: Object.freeze({ kind: 'string' }),
  string: Object.freeze({ kind: 'string' }),
  select: Object.freeze({ kind: 'string' }),
  status: Object.freeze({ kind: 'string' }),
  number: Object.freeze({ kind: 'number' }),
  checkbox: Object.freeze({ kind: 'boolean' }),
  boolean: Object.freeze({ kind: 'boolean' }),
  date: Object.freeze({ kind: 'date', withTime: false }),
  datetime: Object.freeze({ kind: 'date', withTime: true }),
  list: Object.freeze({ kind: 'list' }),
  aliases: Object.freeze({ kind: 'list' }),
  multitext: Object.freeze({ kind: 'list' }),
  multiselect: Object.freeze({ kind: 'list' }),
  tags: Object.freeze({ kind: 'tagList', comparisonWidget: 'tags' }),
  link: Object.freeze({ kind: 'link' }),
});
const unknown: BaseFilterPropertyDescriptor = Object.freeze({ kind: 'unknown', metadataStatus: 'unavailable' });

/** Built-in identifiers have audited static kinds/widgets. Other identifiers
 * use captured metadata first, then a known declared schema. Relation/rollup
 * names alone cannot establish cardinality/output type and remain unknown.
 */
export function baseFilterProperty(property: string, supplied?: BaseFilterPropertyDescriptor, declaredType?: string): BaseFilterPropertyDescriptor {
  return (Object.hasOwn(builtins, property) ? builtins[property] : undefined)
    ?? supplied
    ?? (declaredType && Object.hasOwn(declaredTypes, declaredType) ? declaredTypes[declaredType] : undefined)
    ?? unknown;
}
