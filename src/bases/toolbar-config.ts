import { BUILTIN_BASE_VIEW_TYPES } from './document.ts';
import type { BaseValue, BaseViewPatch } from './document.ts';
import { parseBaseExpression } from './expression.ts';
import { normalizeBaseProperty } from './query.ts';
import type { BaseQueryResult } from './query.ts';

export type BaseToolbarPatch = BaseViewPatch;
export type BaseFilterOperator = 'eq' | 'neq' | 'contains' | 'gt' | 'lt' | 'unset' | 'set';
export type BaseFilterValueType = 'text' | 'number' | 'boolean';
const allowedKeys = new Set(['filters', 'sort', 'order', 'groupBy', 'groupOrder', 'name', 'type', 'limit', 'rowHeight', 'cardSize', 'columnWidth', 'image', 'imageFit', 'imageAspectRatio', 'markers', 'indentProperties', 'separator']);
const fail = (message: string): never => { throw new Error(message); };
const mapping = (value: unknown): value is Record<string, BaseValue> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Reject executable/object-identity inputs before inspecting staged configuration. */
function detach(value: unknown, ancestors = new Set<object>(), budget = { remaining: 10000 }, depth = 0): BaseValue {
  if (--budget.remaining < 0 || depth > 64) return fail('Toolbar configuration is too large or deeply nested');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object') return fail('Toolbar configuration contains an unsupported value');
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return fail('Toolbar configuration must use plain mappings and lists');
  if (ancestors.has(value)) return fail('Toolbar configuration cannot be cyclic');
  if (Object.getOwnPropertySymbols(value).length) return fail('Toolbar configuration cannot contain symbol keys');
  ancestors.add(value);
  try {
    const entries: [string, BaseValue][] = [];
    for (const key of Object.getOwnPropertyNames(value)) {
      if (array && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor) || !descriptor.enumerable) return fail('Toolbar configuration must contain enumerable data properties');
      if (array && (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) return fail('Toolbar lists cannot have named properties');
      entries.push([key, detach(descriptor.value, ancestors, budget, depth + 1)]);
    }
    if (!array) return Object.fromEntries(entries);
    if (entries.length !== value.length) return fail('Toolbar lists cannot be sparse');
    return entries.map(([, item]) => item);
  } finally { ancestors.delete(value); }
}
function propertyId(value: unknown): string {
  if (typeof value !== 'string' || !value.length) return fail('Property IDs must be nonempty strings');
  const normalized = normalizeBaseProperty(value);
  if (!normalized.slice(normalized.indexOf('.') + 1).length) return fail('Property IDs must include a property name');
  return normalized;
}
function existingProperty(value: BaseValue | undefined): string | undefined {
  if (!mapping(value)) return undefined;
  const property = value.column || value.property;
  return typeof property === 'string' && property.length ? normalizeBaseProperty(property) : undefined;
}
function criterion(value: BaseValue, known: ReadonlySet<string>): BaseValue {
  if (!mapping(value)) return fail('Sort and group criteria must be mappings');
  const property = propertyId(value.column || value.property);
  if (!known.has(property)) return fail(`Unknown property: ${property}`);
  if (value.direction !== 'ASC' && value.direction !== 'DESC') return fail('Sort and group directions must be ASC or DESC');
  if (Object.hasOwn(value, 'column') && Object.hasOwn(value, 'property') && propertyId(value.column) !== propertyId(value.property)) return fail('A criterion cannot refer to two different properties');
  // Preserve extensions and the existing criterion spelling (column/property).
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, key === 'property' || key === 'column' ? property : entry]));
}
function validateFilter(value: BaseValue, budget = { remaining: 1000 }, depth = 0): void {
  if (--budget.remaining < 0 || depth > 32) return fail('Filters exceed the depth or node limit');
  if (typeof value === 'string') { parseBaseExpression(value); return; }
  if (!mapping(value)) return fail('A filter must be an expression or an and/or/not group');
  const keys = Object.keys(value), kind = keys[0];
  if (keys.length !== 1 || !['and', 'or', 'not'].includes(kind) || !Array.isArray(value[kind])) return fail('A filter group must contain only an and/or/not list');
  for (const child of value[kind]) validateFilter(child, budget, depth + 1);
}

/** Validate one staged view patch without changing either the query or caller data. */
export function validateToolbarPatch(result: BaseQueryResult, patch: BaseViewPatch): BaseViewPatch {
  if (!mapping(patch) || ![Object.prototype, null].includes(Object.getPrototypeOf(patch))) return fail('A toolbar patch must be a plain mapping');
  if (Object.getOwnPropertySymbols(patch).length) return fail('Toolbar patches cannot contain symbol keys');
  const output: BaseViewPatch = {}, budget = { remaining: 10000 };
  for (const key of Object.getOwnPropertyNames(patch)) {
    if (!allowedKeys.has(key)) return fail(`Unsupported toolbar option: ${key}`);
    const descriptor = Object.getOwnPropertyDescriptor(patch, key)!;
    if (!('value' in descriptor) || !descriptor.enumerable) return fail('Toolbar patches must contain enumerable data properties');
    output[key] = descriptor.value === undefined ? undefined : detach(descriptor.value, new Set(), budget);
  }
  const available = new Set(result.availableProperties.map(propertyId));
  for (const [key, value] of Object.entries(output)) {
    switch (key) {
      case 'name':
        if (typeof value !== 'string' || !value.trim()) return fail('View name must not be empty');
        output.name = value.trim(); break;
      case 'type':
        if (typeof value !== 'string' || !(BUILTIN_BASE_VIEW_TYPES as readonly string[]).includes(value)) return fail('Unknown built-in view type');
        break;
      case 'order': {
        if (!Array.isArray(value)) return fail('Property order must be a list');
        const known = new Set(available);
        if (Array.isArray(result.view.order)) for (const property of result.view.order) if (typeof property === 'string') known.add(normalizeBaseProperty(property));
        const normalized = value.map(propertyId);
        if (new Set(normalized).size !== normalized.length) return fail('Property order cannot contain duplicates');
        for (const property of normalized) if (!known.has(property)) return fail(`Unknown property: ${property}`);
        output.order = normalized; break;
      }
      case 'sort': {
        if (!Array.isArray(value)) return fail('Sort criteria must be a list');
        const known = new Set(available), seen = new Set<string>();
        if (Array.isArray(result.view.sort)) for (const previous of result.view.sort) { const property = existingProperty(previous); if (property) known.add(property); }
        output.sort = value.map(entry => {
          const validated = criterion(entry, known), property = existingProperty(validated)!;
          if (seen.has(property)) return fail('Sort criteria cannot contain duplicate properties');
          seen.add(property); return validated;
        }); break;
      }
      case 'groupBy': {
        if (value === undefined) break;
        if (!mapping(value) || !Object.hasOwn(value, 'property')) return fail('Grouping requires a property and direction');
        const known = new Set(available), previous = existingProperty(result.view.groupBy);
        if (previous) known.add(previous);
        output.groupBy = criterion(value, known); break;
      }
      case 'groupOrder':
        if (value !== undefined || !Object.hasOwn(output, 'groupBy')) return fail('Group order can only be reset with a grouping change');
        break;
      case 'filters': if (value !== undefined) validateFilter(value); break;
      case 'limit': if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) return fail('Limit must be a nonnegative whole number'); break;
      case 'rowHeight': if (value !== undefined && !['', 'short', 'medium', 'tall', 'extra'].includes(String(value))) return fail('Unknown row height'); break;
      case 'imageFit': if (value !== undefined && value !== '' && value !== 'cover' && value !== 'contain') return fail('Unknown image fit'); break;
      case 'markers': if (value !== undefined && !['bullet', 'number', 'none'].includes(String(value))) return fail('Unknown list marker'); break;
      case 'indentProperties': if (value !== undefined && typeof value !== 'boolean') return fail('Indent properties must be a checkbox'); break;
      case 'separator': if (value !== undefined && typeof value !== 'string') return fail('Property separator must be text'); break;
      case 'image': if (value !== undefined && (typeof value !== 'string' || !value)) return fail('Image property must be a property name'); break;
      case 'cardSize': case 'columnWidth': case 'imageAspectRatio': {
        const [min,max] = key === 'cardSize' ? [50,800] : key === 'columnWidth' ? [200,500] : [.25,2.5];
        if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)) return fail(`${key} must be between ${min} and ${max}`);
        break;
      }
    }
  }
  return output;
}

/** Quote the complete property key so spaces, punctuation and quotes remain data. */
export function propertyExpression(property: string): string {
  const normalized = propertyId(property), split = normalized.indexOf('.');
  return `${normalized.slice(0, split)}[${JSON.stringify(normalized.slice(split + 1))}]`;
}

/** Construct only supported expression syntax, never interpolate user text as code. */
export function buildFilterCondition(property: string, operator: BaseFilterOperator, value: string, valueType: BaseFilterValueType): string {
  const expression = propertyExpression(property);
  if (!['eq', 'neq', 'contains', 'gt', 'lt', 'unset', 'set'].includes(operator)) return fail('Unknown filter operator');
  if (!['text', 'number', 'boolean'].includes(valueType) || typeof value !== 'string') return fail('Unknown filter value type');
  if (operator === 'unset' || operator === 'set') return `${expression} ${operator === 'unset' ? '==' : '!='} null`;
  let literal: string | number | boolean = value;
  if (valueType === 'number') {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value))) return fail('Enter a finite decimal number');
    literal = Number(value);
  } else if (valueType === 'boolean') {
    if (value !== 'true' && value !== 'false') return fail('Boolean values must be true or false');
    literal = value === 'true';
  }
  const encoded = JSON.stringify(literal);
  return operator === 'contains' ? `${expression}.contains(${encoded})` : `${expression} ${{ eq: '==', neq: '!=', gt: '>', lt: '<' }[operator]} ${encoded}`;
}
