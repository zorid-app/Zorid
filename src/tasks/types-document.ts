import { parseDocument, isMap, isSeq, isNode, visit } from 'yaml';
import type { Document, YAMLMap } from 'yaml';

export type TypeValue = null | boolean | number | string | readonly TypeValue[] | { readonly [key: string]: TypeValue };
export type StatusCategory = 'not_started' | 'working' | 'done';
export interface TypeOption { readonly id: string; readonly label: string; readonly category?: StatusCategory | null }
export interface TypeProperty {
  readonly id: string; readonly key: string; readonly label: string;
  readonly datatype: 'text' | 'date' | 'status' | 'select' | 'multi-select' | 'number' | 'checkbox' | 'datetime';
  readonly options?: readonly TypeOption[]; readonly default?: TypeValue;
}
export interface TaskCapability { readonly status: string; readonly plannedDay?: string | null; readonly deadline?: string | null }
export interface NoteType {
  readonly version: 1; readonly id: string; readonly label: string;
  readonly properties: readonly TypeProperty[];
  readonly capabilities?: { readonly task?: TaskCapability | null };
}
export const MAX_TYPE_SOURCE_BYTES = 256 * 1024;
export class TypesDocumentError extends Error {
  constructor(message: string) { super(message); this.name = 'TypesDocumentError'; }
}
const fail = (message: string): never => { throw new TypesDocumentError(message); };
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const label = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && new TextEncoder().encode(value).length <= 512 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const mapping = (value: unknown): value is Record<string, TypeValue> => value !== null && typeof value === 'object' && !Array.isArray(value);
function dateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y,m,d] = value.split('-').map(Number);
  const date = new Date(0); date.setUTCFullYear(y, m - 1, d); date.setUTCHours(0,0,0,0);
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
function dateTime(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !dateOnly(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return false;
  if (match[5] !== 'Z' && (Number(match[5].slice(1,3)) > 23 || Number(match[5].slice(4)) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}
/** The existing YAML parser supplies a bounded, ordered safe AST for Rust.
 * No expression evaluation or Markdown parsing occurs here. */
function rootValue(doc: Document): TypeValue {
  let nodes = 0;
  const ancestors = new Set<object>();
  function convert(value: unknown, depth: number): TypeValue {
    if (++nodes > 8192 || depth > 32) return fail('Type configuration exceeds structural limits');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) return fail('Invalid property number');
      return value;
    }
    if (!value || typeof value !== 'object' || ancestors.has(value)) return fail('Cyclic or unsupported YAML value');
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return Object.freeze(value.map(v => convert(v, depth + 1)));
      if (value instanceof Map) {
        const entries: [string, TypeValue][] = [];
        for (const [key, item] of value) {
          if (typeof key !== 'string') return fail('Type keys must be strings');
          entries.push([key, convert(item, depth + 1)]);
        }
        return Object.freeze(Object.fromEntries(entries));
      }
      return fail('Unsupported type configuration value');
    } finally { ancestors.delete(value); }
  }
  if (!isMap(doc.contents) || doc.errors.length || doc.warnings.length) return fail('Invalid or unsupported type YAML');
  visit(doc, { Alias: () => fail('YAML aliases are not supported in type definitions'), Value: (_, node) => { if (node.tag) fail('Explicit YAML tags are not supported in type definitions'); } });
  try { return convert(doc.toJS({ mapAsMap: true, maxAliasCount: 0 }), 0); }
  catch (error) { throw error instanceof TypesDocumentError ? error : new TypesDocumentError(String(error)); }
}
function validate(value: TypeValue): NoteType {
  if (!mapping(value) || value.version !== 1 || !identity(value.id) || !label(value.label) || !Array.isArray(value.properties) || value.properties.length > 64) return fail('Unsupported or invalid note type');
  const ids = new Set<string>(), keys = new Set<string>();
  for (const p of value.properties) {
    if (!mapping(p) || !identity(p.id) || ids.has(p.id) || !label(p.key) || p.key === 'type' || keys.has(p.key) || !label(p.label) || !['text','date','status','select','multi-select','number','checkbox','datetime'].includes(String(p.datatype))) return fail('Invalid type property');
    ids.add(p.id); keys.add(p.key);
    const options = p.options === undefined ? [] : p.options;
    if (!Array.isArray(options) || options.length > 128) return fail('Invalid type options');
    const optionIds = new Set<string>();
    for (const o of options) {
      if (!mapping(o) || !identity(o.id) || optionIds.has(o.id) || !label(o.label)) return fail('Invalid type option');
      optionIds.add(o.id);
      if (p.datatype === 'status' ? !['not_started','working','done'].includes(String(o.category)) : o.category !== undefined && o.category !== null) return fail('Invalid status category');
    }
    if (['status','select','multi-select'].includes(String(p.datatype)) ? options.length === 0 : options.length > 0) return fail('Options do not match datatype');
    if (Object.hasOwn(p, 'default')) {
      const d = p.default;
      const valid = d === null ? p.datatype !== 'status' : p.datatype === 'text' ? typeof d === 'string'
        : p.datatype === 'date' ? typeof d === 'string' && dateOnly(d)
        : p.datatype === 'datetime' ? typeof d === 'string' && dateTime(d)
        : p.datatype === 'number' ? typeof d === 'number'
        : p.datatype === 'checkbox' ? typeof d === 'boolean'
        : p.datatype === 'multi-select' ? Array.isArray(d) && new Set(d).size === d.length && d.every(v => typeof v === 'string' && optionIds.has(v))
        : typeof d === 'string' && optionIds.has(d);
      if (!valid) return fail('Invalid property default');
    }
  }
  const capabilities = value.capabilities;
  if (capabilities !== undefined && !mapping(capabilities)) return fail('Invalid capabilities');
  const task = mapping(capabilities) ? capabilities.task : undefined;
  if (task !== undefined && task !== null) {
    if (!mapping(task)) return fail('Invalid task capability');
    const props = value.properties as unknown as readonly TypeProperty[];
    const status = props.find(p => p.id === task.status);
    if (!status || status.datatype !== 'status' || status.default === undefined || status.default === null) return fail('Invalid task status mapping');
    const used = new Set([status.id]);
    for (const key of ['plannedDay','deadline']) {
      const id = task[key];
      if (id === undefined || id === null) continue;
      if (typeof id !== 'string' || used.has(id) || props.find(p => p.id === id)?.datatype !== 'date') return fail('Invalid task date mapping');
      used.add(id);
    }
  }
  return value as unknown as NoteType;
}
function parse(source: string): Document {
  if (new TextEncoder().encode(source).length > MAX_TYPE_SOURCE_BYTES) return fail('Type YAML exceeds byte limit');
  return parseDocument(source, { version: '1.2', schema: 'core', stringKeys: true, uniqueKeys: true, resolveKnownTags: false, logLevel: 'silent' });
}
/** Source and unknown supported keys/comments survive; failed edits never publish.
 * Rust compile_types is the authority for host-fed interpretation at query time. */
export class TypesDocument {
  private document: Document;
  private source: string;
  private current: NoteType;
  private constructor(source: string, document: Document) { this.source = source; this.document = document; this.current = validate(rootValue(document)); }
  static parse(source: string): TypesDocument { return new TypesDocument(source, parse(source)); }
  get model(): NoteType { return this.current; }
  /** Complete safe AST, including unknown keys, for compile_types. */
  get configuration(): TypeValue { return rootValue(this.document); }
  toString(): string { return this.source; }
  private change(start: number, end: number, replacement: string): void {
    const source = this.source.slice(0,start) + replacement + this.source.slice(end);
    const checked = parse(source); const model = validate(rootValue(checked));
    this.document = checked; this.source = source; this.current = model;
  }
  /** Replace only the owned value span; unrelated formatting/comments stay exact. */
  private patch(map: YAMLMap, key: string, value: TypeValue | undefined): void {
    const index = map.items.findIndex(pair => isNode(pair.key) && 'value' in pair.key && pair.key.value === key);
    const pair = index < 0 ? undefined : map.items[index];
    const keyNode = pair?.key;
    const node = pair?.value;
    if (pair && isNode(keyNode) && keyNode.range) {
      if (!isNode(node) || !node.range) return fail('An explicit value is required before editing');
      if (value !== undefined) { this.change(node.range[0],node.range[1],JSON.stringify(value)); return; }
      if (map.flow) {
        if (index < map.items.length - 1) {
          const next = map.items[index + 1].key;
          if (!isNode(next) || !next.range) return fail('Invalid mapping range');
          this.change(keyNode.range[0],next.range[0],'');
        } else if (index > 0) {
          const previous = map.items[index - 1].value;
          if (!isNode(previous) || !previous.range) return fail('Invalid mapping range');
          this.change(previous.range[1],node.range[1],'');
        } else this.change(keyNode.range[0],node.range[1],'');
      } else {
        const lineStart = this.source.lastIndexOf('\n',keyNode.range[0] - 1) + 1;
        if (this.source.slice(lineStart,keyNode.range[0]).trim()) return fail('Cannot remove a key sharing its container line');
        this.change(lineStart,node.range[2],'');
      }
      return;
    }
    if (value === undefined) return;
    if (!map.range) return fail('Invalid mapping range');
    if (map.flow) {
      this.change(map.range[1] - 1,map.range[1] - 1,`${map.items.length ? ', ' : ''}${key}: ${JSON.stringify(value)}`);
    } else {
      const lineStart = this.source.lastIndexOf('\n',map.range[0] - 1) + 1;
      const indent = ' '.repeat(map.range[0] - lineStart);
      const newline = /\r?\n/.exec(this.source)?.[0] ?? '\n';
      const prefix = this.source[map.range[1] - 1] === '\n' ? '' : newline;
      this.change(map.range[1],map.range[1],`${prefix}${indent}${key}: ${JSON.stringify(value)}${newline}`);
    }
  }
  private property(doc: Document, id: string): YAMLMap {
    const index = this.current.properties.findIndex(p => p.id === id);
    if (index < 0) return fail('Unknown property ID');
    const properties = doc.get('properties', true);
    if (!isSeq(properties)) return fail('Invalid properties sequence');
    const node = properties.items[index];
    if (!isMap(node)) return fail('Aliased properties cannot be edited directly');
    return node;
  }
  rename(label: string): void { if (!isMap(this.document.contents)) return fail('Invalid type root'); this.patch(this.document.contents,'label',label); }
  renameProperty(id: string, label: string): void { this.patch(this.property(this.document,id),'label',label); }
  renameOption(propertyId: string, optionId: string, label: string): void {
    const p = this.current.properties.find(p => p.id === propertyId);
    const index = p?.options?.findIndex(o => o.id === optionId) ?? -1;
    if (index < 0) return fail('Unknown option ID');
    const options = this.property(this.document,propertyId).get('options',true);
    if (!isSeq(options)) return fail('Invalid options sequence');
    const node = options.items[index];
    if (!isMap(node)) return fail('Invalid option mapping');
    this.patch(node,'label',label);
  }
  setDefault(propertyId: string, value: TypeValue | undefined): void {
    this.patch(this.property(this.document,propertyId),'default',value);
  }
}
/** Invalid/unknown-version source is returned untouched for recovery/editor UI. */
export function inspectTypeDocument(source: string): { readonly source: string; readonly document: TypesDocument | null; readonly error: string | null } {
  try { return { source, document: TypesDocument.parse(source), error: null }; }
  catch (error) { return { source, document: null, error: error instanceof Error ? error.message : String(error) }; }
}
