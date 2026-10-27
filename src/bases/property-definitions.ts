import { isAlias, isMap, isScalar, parseDocument, visit } from 'yaml';
import type { BaseExpressionValue } from './expression.ts';

/** Value-control definitions supplied explicitly by a collection owner. */
export const MAX_BASE_PROPERTY_SETTINGS_BYTES = 256 * 1024;
export const MAX_BASE_PROPERTY_DEFINITIONS = 1024;
export const MAX_BASE_PROPERTY_OPTIONS = 1024;
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
const text = (v: unknown) => typeof v === 'string' && !!v.trim() && new TextEncoder().encode(v).length <= 512 && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
export const basePropertyName = (property: string): string => property.replace(/^note\./, '');

export function validateBasePropertyDefinition(value: unknown): asserts value is BasePropertyDefinition {
  if (!isRecord(value) || !BASE_PROPERTY_TYPES.includes(value.type as BasePropertyType)) throw new BasePropertyDefinitionError('Choose a supported property value type.');
  if (value.options !== undefined) {
    if (!Array.isArray(value.options)) throw new BasePropertyDefinitionError('Property options must be a list.');
    if (value.options.length > MAX_BASE_PROPERTY_OPTIONS) throw new BasePropertyDefinitionError('Too many property options.');
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
    if (!isRecord(r) || !text(r.relation) || !['count', 'sum', 'average', 'min', 'max', 'values', 'unique'].includes(r.aggregation as string) || (r.property !== undefined && !text(r.property)) || (r.aggregation !== 'count' && !text(r.property))) throw new BasePropertyDefinitionError('Invalid rollup settings.');
  }
}
function readDocument(source: string) {
  if (new TextEncoder().encode(source).length > MAX_BASE_PROPERTY_SETTINGS_BYTES) throw new BasePropertyDefinitionError('Property settings exceed source byte budget.');
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
  if (isRecord(raw.properties) && Object.keys(raw.properties).length > MAX_BASE_PROPERTY_DEFINITIONS) throw new BasePropertyDefinitionError('Too many property definitions.');
  if (raw.properties !== undefined && !isRecord(raw.properties)) throw new BasePropertyDefinitionError('properties must be a mapping.');
  return { document, raw };
}
/** Invalid definitions are diagnosed individually; callers must not infer a replacement type. */
export function parseBasePropertyDefinitions(source: string): BasePropertyDefinitions {
  const { raw } = readDocument(source);
  const properties: Record<string, BasePropertyDefinition> = Object.create(null);
  const diagnostics: { property?: string; message: string }[] = [];
  for (const [property, definition] of Object.entries(raw.properties ?? {})) {
    try { if (!text(property)) throw new BasePropertyDefinitionError('Property names must be nonempty bounded text.'); validateBasePropertyDefinition(definition); properties[property] = definition; }
    catch (error) { diagnostics.push({ property, message: error instanceof Error ? error.message : String(error) }); }
  }
  if (source.trim() && raw.properties === undefined) diagnostics.push({ message: 'Property settings require a properties mapping.' });
  for (const type of ['reverseRelation', 'rollup'] as const) for (const [property, definition] of Object.entries(properties)) {
    if (definition.type !== type) continue;
    const target = type === 'reverseRelation' ? definition.reverseRelation!.property : definition.rollup!.relation;
    const candidate = Object.hasOwn(properties, target) ? properties[target] : undefined;
    if (candidate?.type !== 'relation' && !(type === 'rollup' && candidate?.type === 'reverseRelation')) { delete properties[property]; diagnostics.push({ property, message: 'Derived property requires a configured relation property.' }); }
  }
  return { properties, diagnostics };
}
/** Targeted YAML mutation preserves unrelated keys, unfamiliar definition fields and comments. */
export function updateBasePropertyDefinition(source: string, property: string, definition: BasePropertyDefinition | null): string {
  if (!text(property)) throw new BasePropertyDefinitionError('Property name must be nonempty bounded text.');
  if (definition !== null) validateBasePropertyDefinition(definition);
  const { document, raw } = readDocument(source);
  const checkProjectedKeys = (doc: typeof document) => visit(doc, { Map(_key, map) {
    const keys = new Set<string>();
    for (const pair of map.items) {
      const node = isAlias(pair.key) ? pair.key.resolve(doc) : pair.key;
      if (node !== null && !isScalar(node)) throw new BasePropertyDefinitionError('Property configuration contains complex YAML keys. Edit the source before changing these settings.');
      const value = node === null ? null : node.value;
      if ((value !== null && typeof value === 'object') || typeof value === 'symbol' || typeof value === 'function') throw new BasePropertyDefinitionError('Property configuration contains complex YAML keys. Edit the source before changing these settings.');
      // yaml's ordinary-object projection uses an empty key for null.
      const key = value === null ? '' : String(value);
      if (keys.has(key)) throw new BasePropertyDefinitionError('Property configuration contains overlapping YAML keys. Edit the source before changing these settings.');
      keys.add(key);
    }
  } });
  checkProjectedKeys(document);
  const previous = isRecord(raw.properties) ? raw.properties[property] : undefined;
  const ownedKeys = ['type', 'options', 'relation', 'reverseRelation', 'rollup'] as const;
  const nestedKeys = { relation: ['multiple', 'targetFilter'], reverseRelation: ['property'], rollup: ['relation', 'property', 'aggregation'] };
  if (!document.has('properties')) document.set('properties', document.createNode({}));
  if (definition === null) document.deleteIn(['properties', property]);
  else {
    // A selected alias is detached; its shared template is never edited.
    if (!isMap(document.getIn(['properties', property], true))) document.setIn(['properties', property], document.createNode(isRecord(previous) ? previous : {}));
    for (const key of ownedKeys) {
      if (definition[key] === undefined) document.deleteIn(['properties', property, key]);
      else if (key === 'relation' || key === 'reverseRelation' || key === 'rollup') {
        const path = ['properties', property, key], detail = definition[key] as unknown as Record<string, unknown>;
        const fields = nestedKeys[key];
        if (!isMap(document.getIn(path, true))) document.setIn(path, document.createNode(isRecord(previous) && isRecord(previous[key]) ? previous[key] : detail));
        // Keep unfamiliar pairs and their AST nodes in place. Clearing a known
        // optional field removes only that pair, not the whole settings map.
        for (const field of fields) {
          if (detail[field] === undefined) document.deleteIn([...path, field]);
          else document.setIn([...path, field], detail[field]);
        }
      } else document.setIn(['properties', property, key], definition[key]);
    }
  }
  const output = document.toString(), checked = readDocument(output), after = checked.raw;
  checkProjectedKeys(checked.document);
  // Editing an anchored owner can also alter aliases outside the owned fields.
  // Refuse those side effects before returning any source to the save pipeline.
  const retainedData = (data: Record<string, unknown>) => {
    const properties = isRecord(data.properties) ? data.properties : {}, current = properties[property];
    const unfamiliar: Record<string, unknown> = definition && isRecord(current) ? Object.fromEntries(Object.entries(current).filter(([key]) => !(ownedKeys as readonly string[]).includes(key))) : {};
    if (definition && isRecord(previous) && isRecord(current)) for (const key of ['relation', 'reverseRelation', 'rollup'] as const) {
      if (definition[key] !== undefined && isRecord(previous[key])) {
        const detail = isRecord(current[key]) ? current[key] : {};
        unfamiliar[key] = Object.fromEntries(Object.entries(detail).filter(([field]) => !nestedKeys[key].includes(field)));
      }
    }
    return JSON.stringify([Object.entries(data).filter(([key]) => key !== 'properties'), Object.entries(properties).filter(([name]) => name !== property), unfamiliar]);
  };
  if (retainedData(raw) !== retainedData(after)) throw new BasePropertyDefinitionError('These settings share YAML values with another field. Edit the property configuration to change them together.');
  return output;
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
export function inferBasePropertyDefinition(value: BaseExpressionValue, property?: string): BasePropertyDefinition {
  if (property && basePropertyName(property).toLowerCase() === 'tags' && (value.type === 'list' || value.type === 'string' || value.type === 'null')) return { type: 'tags' };
  if (value.type === 'string') { if (validDateText(value.value, false)) return { type: 'date' }; if (validDateText(value.value, true)) return { type: 'datetime' }; }
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
  if (!new RegExp(withTime ? '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,9})?)?(Z|[+-]\\d{2}:\\d{2})?$' : '^\\d{4}-\\d{2}-\\d{2}$').test(value)) return false;
  if (withTime) {
    const time = /T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))?$/.exec(value);
    if (!time || Number(time[1]) > 23 || Number(time[2]) > 59 || Number(time[3] ?? 0) > 59 || Number(time[5] ?? 0) > 23 || Number(time[6] ?? 0) > 59) return false;
  }
  const [date] = value.split('T'); const [year, month, day] = date.split('-').map(Number);
  if (year < 1) return false;
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
