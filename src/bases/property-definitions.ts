import { isMap, parseDocument } from 'yaml';
import type { BaseExpressionValue } from './expression.ts';

/** Ordinary visible vault file. There is no named note-Type registry. */
export const BASE_PROPERTY_DEFINITIONS_PATH = 'Properties.yaml';
export const BASE_PROPERTY_TYPES = ['text', 'number', 'checkbox', 'date', 'datetime', 'list', 'tags', 'link', 'select', 'multiselect', 'status', 'relation', 'reverseRelation', 'rollup'] as const;
export type BasePropertyType = typeof BASE_PROPERTY_TYPES[number];
export interface BasePropertyOption {
  /** Internal definition identity only; Markdown always contains value, never id. */
  readonly id?: string;
  readonly value: string;
  readonly label?: string;
  readonly color?: string;
  readonly category?: 'todo' | 'in-progress' | 'done';
}
export interface BasePropertyDefinition {
  readonly type: BasePropertyType;
  readonly options?: readonly BasePropertyOption[];
  readonly relation?: { readonly multiple?: boolean; readonly targetFilter?: string };
  readonly reverseRelation?: { readonly property: string };
  readonly rollup?: { readonly relation: string; readonly property?: string; readonly aggregation: 'count' | 'sum' | 'average' | 'min' | 'max' | 'values' | 'unique' };
}
export interface BasePropertyDefinitions {
  readonly properties: Readonly<Record<string, BasePropertyDefinition>>;
  readonly diagnostics: readonly { readonly property?: string; readonly message: string }[];
}
export class BasePropertyDefinitionError extends Error {
  constructor(message: string) { super(message); this.name = 'BasePropertyDefinitionError'; }
}
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown) => typeof v === 'string' && !!v.trim();
export const basePropertyName = (property: string): string => property.replace(/^note\./, '');

export function validateBasePropertyDefinition(value: unknown): asserts value is BasePropertyDefinition {
  if (!isRecord(value) || !BASE_PROPERTY_TYPES.includes(value.type as BasePropertyType)) throw new BasePropertyDefinitionError('Choose a supported property value type.');
  if (value.options !== undefined) {
    if (!Array.isArray(value.options)) throw new BasePropertyDefinitionError('Property options must be a list.');
    const values = new Set<string>(), ids = new Set<string>();
    for (const option of value.options) {
      if (!isRecord(option) || !text(option.value)) throw new BasePropertyDefinitionError('Each option needs a nonempty value.');
      if (values.has(option.value as string)) throw new BasePropertyDefinitionError('Option values must be unique.');
      values.add(option.value as string);
      for (const key of ['id', 'label', 'color']) if (option[key] !== undefined && !text(option[key])) throw new BasePropertyDefinitionError(`Option ${key} must be nonempty text.`);
      if (typeof option.id === 'string') { if (ids.has(option.id)) throw new BasePropertyDefinitionError('Option identities must be unique.'); ids.add(option.id); }
      if (option.category !== undefined && !['todo', 'in-progress', 'done'].includes(option.category as string)) throw new BasePropertyDefinitionError('Unknown status category.');
    }
  }
  if (value.relation !== undefined) {
    if (!isRecord(value.relation) || (value.relation.multiple !== undefined && typeof value.relation.multiple !== 'boolean') || (value.relation.targetFilter !== undefined && !text(value.relation.targetFilter))) throw new BasePropertyDefinitionError('Invalid relation settings.');
  }
  if (value.type === 'reverseRelation' && (!isRecord(value.reverseRelation) || !text(value.reverseRelation.property))) throw new BasePropertyDefinitionError('A reverse relation needs its forward property.');
  if (value.type === 'rollup') {
    const r = value.rollup;
    if (!isRecord(r) || !text(r.relation) || !['count', 'sum', 'average', 'min', 'max', 'values', 'unique'].includes(r.aggregation as string) || (r.property !== undefined && !text(r.property))) throw new BasePropertyDefinitionError('Invalid rollup settings.');
  }
}
function readDocument(source: string) {
  const document = parseDocument(source || 'properties: {}\n', { uniqueKeys: true });
  if (document.errors.length || document.warnings.length) throw new BasePropertyDefinitionError([...document.errors, ...document.warnings].map(e => e.message).join('; '));
  if (!isMap(document.contents)) throw new BasePropertyDefinitionError('Property settings must be a YAML mapping.');
  const raw = document.toJS({ maxAliasCount: 100 });
  const active = new Set<object>();
  let remaining = 100000;
  const check = (value: unknown, depth = 0): void => {
    if (--remaining < 0 || depth > 128) throw new BasePropertyDefinitionError('Property settings are too large.');
    if (!value || typeof value !== 'object') return;
    if (active.has(value)) throw new BasePropertyDefinitionError('Cyclic YAML aliases are not supported in property settings.');
    active.add(value);
    for (const child of Object.values(value)) check(child, depth + 1);
    active.delete(value);
  };
  check(raw);
  if (raw.properties !== undefined && !isRecord(raw.properties)) throw new BasePropertyDefinitionError('properties must be a mapping.');
  return { document, raw };
}
/** Invalid definitions are diagnosed individually; callers must not infer a replacement type. */
export function parseBasePropertyDefinitions(source: string): BasePropertyDefinitions {
  const { raw } = readDocument(source);
  const properties: Record<string, BasePropertyDefinition> = Object.create(null);
  const diagnostics: { property?: string; message: string }[] = [];
  for (const [property, definition] of Object.entries(raw.properties ?? {})) {
    try { validateBasePropertyDefinition(definition); properties[property] = definition; }
    catch (error) { diagnostics.push({ property, message: error instanceof Error ? error.message : String(error) }); }
  }
  return { properties, diagnostics };
}
/** Targeted YAML mutation preserves unrelated keys, unfamiliar definition fields and comments. */
export function updateBasePropertyDefinition(source: string, property: string, definition: BasePropertyDefinition | null): string {
  if (!property.trim()) throw new BasePropertyDefinitionError('Property name cannot be empty.');
  if (definition !== null) validateBasePropertyDefinition(definition);
  const { document } = readDocument(source);
  if (!document.has('properties')) document.set('properties', {});
  if (definition === null) document.deleteIn(['properties', property]);
  else {
    if (!isMap(document.getIn(['properties', property], true))) document.setIn(['properties', property], {});
    for (const key of ['type', 'options', 'relation', 'reverseRelation', 'rollup'] as const) {
      if (definition[key] === undefined) document.deleteIn(['properties', property, key]);
      else document.setIn(['properties', property, key], definition[key]);
    }
  }
  return document.toString();
}
export interface BasePropertyOptionMigration { readonly property: string; readonly from: string; readonly to: string; }
/** Renaming a stored value is explicitly a separate, identity/revision-guarded note migration.
 * Merely opening or saving settings never rewrites existing note values. */
export function renameBasePropertyOption(source: string, property: string, from: string, to: string): { source: string; migration: BasePropertyOptionMigration } {
  if (!to.trim()) throw new BasePropertyDefinitionError('Option value cannot be empty.');
  const definition = parseBasePropertyDefinitions(source).properties[property];
  if (!definition?.options?.some(option => option.value === from)) throw new BasePropertyDefinitionError('Option no longer exists.');
  if (from !== to && definition.options.some(option => option.value === to)) throw new BasePropertyDefinitionError('Option value already exists.');
  return { source: updateBasePropertyDefinition(source, property, { ...definition, options: definition.options.map(option => option.value === from ? { ...option, value: to } : option) }), migration: { property, from, to } };
}
export function inferBasePropertyDefinition(value: BaseExpressionValue): BasePropertyDefinition {
  return { type: value.type === 'number' ? 'number' : value.type === 'boolean' ? 'checkbox' : value.type === 'date' ? value.hasTime ? 'datetime' : 'date' : value.type === 'list' ? 'list' : 'text' };
}
export function basePropertyValueDiagnostic(value: BaseExpressionValue, definition: BasePropertyDefinition): string | undefined {
  if (value.type === 'null' || definition.type === 'reverseRelation' || definition.type === 'rollup') return;
  const t = definition.type;
  if (t === 'number' && (value.type !== 'number' || !Number.isFinite(value.value))) return 'Expected a number; the original value is preserved.';
  if (t === 'checkbox' && value.type !== 'boolean') return 'Expected a checkbox value; the original value is preserved.';
  if (['list', 'tags', 'multiselect'].includes(t) || (t === 'relation' && definition.relation?.multiple)) {
    if (value.type !== 'list' || value.value.some(item => item.type !== 'string')) return 'Expected a list of text values; the original value is preserved.';
  } else if (['text', 'select', 'status', 'link', 'relation'].includes(t) && value.type !== 'string') return 'Expected text; the original value is preserved.';
  if ((t === 'date' || t === 'datetime') && value.type !== 'date' && (value.type !== 'string' || !validDateText(value.value, t === 'datetime'))) return 'Expected a valid date; the original value is preserved.';
}
export function validDateText(value: string, withTime: boolean): boolean {
  if (!new RegExp(withTime ? '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,3})?)?$' : '^\\d{4}-\\d{2}-\\d{2}$').test(value)) return false;
  const [date] = value.split('T'); const [year, month, day] = date.split('-').map(Number);
  const d = new Date(0); d.setUTCFullYear(year, month - 1, day); d.setUTCHours(0, 0, 0, 0);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day && (!withTime || Number.isFinite(Date.parse(value)));
}
/** Strict user-input conversion only. Never used to evaluate Base expressions. Lists
 * accept JSON arrays or one item per line, preserving commas in individual values. */
export function parseBasePropertyInput(raw: string, definition: BasePropertyDefinition, current?: BaseExpressionValue): BaseExpressionValue {
  const t = definition.type;
  if (t === 'rollup' || t === 'reverseRelation') throw new BasePropertyDefinitionError('Derived properties cannot be edited.');
  if (!raw) return { type: 'null' };
  if (t === 'number') {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw.trim()) || !Number.isFinite(Number(raw))) throw new BasePropertyDefinitionError('Enter a valid number.');
    return { type: 'number', value: Number(raw) };
  }
  if (t === 'checkbox') {
    if (raw !== 'true' && raw !== 'false') throw new BasePropertyDefinitionError('Enter true or false.');
    return { type: 'boolean', value: raw === 'true' };
  }
  if (t === 'date' || t === 'datetime') {
    if (!validDateText(raw, t === 'datetime')) throw new BasePropertyDefinitionError('Enter a valid date.');
    return { type: 'string', value: raw };
  }
  if (['list', 'tags', 'multiselect'].includes(t) || (t === 'relation' && definition.relation?.multiple)) {
    let items: unknown = raw.startsWith('[') && !raw.startsWith('[[') ? JSON.parse(raw) : raw.split(/\r?\n/).filter(Boolean);
    if (!Array.isArray(items) || items.some(item => typeof item !== 'string')) throw new BasePropertyDefinitionError('Enter a list of text values.');
    return { type: 'list', value: items.map(value => ({ type: 'string', value })) };
  }
  void current;
  return { type: 'string', value: raw };
}
