import { Document, isMap, isScalar, parseDocument } from 'yaml';

export type PropertyType = 'text' | 'list' | 'number' | 'checkbox' | 'date' | 'datetime' | 'tags' | 'unknown';
export type PropertyValue = string | number | boolean | null | PropertyValue[] | { [key: string]: PropertyValue };
export interface Property { key: string; value: PropertyValue; type: PropertyType }

export class PropertiesError extends Error {
  constructor(message: string) { super(message); this.name = 'PropertiesError'; }
}

interface Frontmatter {
  bom: string;
  opening: string;
  yaml: string;
  closing: string;
  body: string;
  newline: string;
  exists: boolean;
}

function validateKey(key: string): void {
  if (typeof key !== 'string' || !key.trim() || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new PropertiesError('A property name must be a nonempty single-line string');
  }
}

/** Delimiters belong to frontmatter; every character after the closing line belongs to the body. */
function splitFrontmatter(source: string): Frontmatter {
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  const text = source.slice(bom.length);
  const opening = /^(---[ \t]*(?:#[^\r\n]*)?)(\r?\n|$)/.exec(text);
  const newline = opening?.[2] || /\r?\n/.exec(text)?.[0] || '\n';
  if (!opening) return { bom, opening: '', yaml: '', closing: '', body: text, newline, exists: false };
  const remainder = text.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/m.exec(remainder);
  if (!opening[2] || !closing) throw new PropertiesError('Frontmatter has no closing delimiter');
  return {
    bom, opening: opening[0], yaml: remainder.slice(0, closing.index), closing: closing[0],
    body: remainder.slice(closing.index + closing[0].length), newline, exists: true,
  };
}

/** Convert YAML mappings safely without assigning magic keys to JavaScript prototypes. */
function toPropertyValue(value: unknown, ancestors = new Set<object>()): PropertyValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') throw new PropertiesError('Unsupported YAML property value');
  if (ancestors.has(value)) throw new PropertiesError('Cyclic YAML aliases are not supported in properties');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => toPropertyValue(item, ancestors));
    if (value instanceof Map) {
      const entries: [string, PropertyValue][] = [];
      for (const [key, item] of value) {
        validateKey(key);
        entries.push([key, toPropertyValue(item, ancestors)]);
      }
      return Object.fromEntries(entries);
    }
    throw new PropertiesError('Unsupported YAML property value');
  } finally { ancestors.delete(value); }
}

function parse(source: string): { front: Frontmatter; doc: Document; values: Map<string, PropertyValue> } {
  const front = splitFrontmatter(source);
  const doc: Document = parseDocument(front.yaml, {
    version: '1.2', schema: 'core', stringKeys: true, uniqueKeys: true,
    resolveKnownTags: false, logLevel: 'silent',
  });
  if (doc.errors.length || doc.warnings.length) {
    throw new PropertiesError(`Invalid or unsupported frontmatter: ${[...doc.errors, ...doc.warnings].map(error => error.message).join('; ')}`);
  }
  if (doc.contents && !isMap(doc.contents)) throw new PropertiesError('Frontmatter must be a property mapping');
  const values = new Map<string, PropertyValue>();
  if (doc.contents) {
    let data: unknown;
    try { data = doc.toJS({ mapAsMap: true, maxAliasCount: 100 }); }
    catch (error) { throw new PropertiesError(`Cannot read frontmatter: ${error instanceof Error ? error.message : String(error)}`); }
    if (!(data instanceof Map)) throw new PropertiesError('Frontmatter must be a property mapping');
    for (const [key, value] of data) {
      validateKey(key);
      values.set(key, toPropertyValue(value));
    }
  }
  return { front, doc, values };
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validDateTime(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|([+-])(\d{2}):(\d{2}))?$/.exec(value);
  return Boolean(match && validDate(match[1]) && Number(match[2]) < 24 && Number(match[3]) < 60
    && (match[4] === undefined || Number(match[4]) < 60)
    && (match[6] === undefined || (Number(match[6]) < 24 && Number(match[7]) < 60)));
}

/** Inference is a fallback for callers without a vault-wide property type registry. */
export function inferPropertyType(key: string, value: PropertyValue): PropertyType {
  if (key.toLowerCase() === 'tags' && (typeof value === 'string' || (Array.isArray(value) && value.every(item => typeof item === 'string')))) return 'tags';
  if (typeof value === 'boolean') return 'checkbox';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return validDate(value) ? 'date' : validDateTime(value) ? 'datetime' : 'text';
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return 'list';
  return 'unknown';
}

function validateValue(value: unknown, ancestors = new Set<object>()): asserts value is PropertyValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object' || (Array.isArray(value)
    ? Object.getPrototypeOf(value) !== Array.prototype
    : Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new PropertiesError('Property values must contain only strings, finite numbers, booleans, null, lists or plain mappings');
  }
  if (ancestors.has(value)) throw new PropertiesError('Cyclic property values are not supported');
  ancestors.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length) throw new PropertiesError('Symbol property keys are not supported');
    for (const key of Object.getOwnPropertyNames(value)) {
      if (Array.isArray(value) && key === 'length') continue;
      validateKey(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor)) throw new PropertiesError('Property accessors are not supported');
      if (!descriptor.enumerable) throw new PropertiesError('Nonenumerable property values are not supported');
      if (Array.isArray(value) && !/^(?:0|[1-9]\d*)$/.test(key)) throw new PropertiesError('Named list properties are not supported');
      validateValue(descriptor.value, ancestors);
    }
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) throw new PropertiesError('Sparse property lists are not supported');
      }
    }
  } finally { ancestors.delete(value); }
}

/** Throws before serialization; null is the empty value for all property types. */
export function validatePropertyValue(type: PropertyType, value: unknown): asserts value is PropertyValue {
  if (!['text', 'list', 'number', 'checkbox', 'date', 'datetime', 'tags', 'unknown'].includes(type)) {
    throw new PropertiesError(`Unsupported property type: ${String(type)}`);
  }
  validateValue(value);
  if (value === null || type === 'unknown') return;
  const strings = Array.isArray(value) && value.every(item => typeof item === 'string');
  const valid = type === 'text' ? typeof value === 'string'
    : type === 'list' ? strings
    : type === 'tags' ? typeof value === 'string' || strings
    : type === 'number' ? typeof value === 'number'
    : type === 'checkbox' ? typeof value === 'boolean'
    : type === 'date' ? typeof value === 'string' && validDate(value)
    : typeof value === 'string' && validDateTime(value);
  if (!valid) throw new PropertiesError(`Invalid value for property type ${type}`);
}

/**
 * Ordered top-level properties. YAML dates are strings; nested structures remain intact.
 * Custom tags and cyclic/excessively expanded aliases are unsupported and fail explicitly.
 * Prototype-like mapping keys remain ordinary own data properties, never prototype assignments.
 */
export function readProperties(source: string): Property[] {
  return [...parse(source).values].map(([key, value]) => ({ key, value, type: inferPropertyType(key, value) }));
}

function serialize(front: Frontmatter, doc: Document): string {
  let yaml: string;
  try { yaml = doc.toString({ directives: false, lineWidth: 0 }).replace(/\r?\n/g, front.newline); }
  catch (error) { throw new PropertiesError(`Cannot update frontmatter: ${error instanceof Error ? error.message : String(error)}`); }
  return front.bom + (front.exists ? front.opening : `---${front.newline}`) + yaml
    + (front.exists ? front.closing : `---${front.newline}`) + front.body;
}

/** Existing YAML nodes retain comments/quote/collection styles; the Markdown body is copied exactly. */
export function setProperty(source: string, key: string, value: unknown, type: PropertyType = 'unknown'): string {
  validateKey(key);
  validatePropertyValue(type, value);
  const { front, doc } = parse(source);
  doc.set(key, value);
  return serialize(front, doc);
}

export function removeProperty(source: string, key: string): string {
  validateKey(key);
  const { front, doc } = parse(source);
  return doc.delete(key) ? serialize(front, doc) : source;
}

export function renameProperty(source: string, oldKey: string, newKey: string): string {
  validateKey(oldKey);
  validateKey(newKey);
  const { front, doc } = parse(source);
  if (!doc.has(oldKey)) throw new PropertiesError(`Property does not exist: ${oldKey}`);
  if (oldKey === newKey) return source;
  if (doc.has(newKey)) throw new PropertiesError(`Property already exists: ${newKey}`);
  if (!isMap(doc.contents)) throw new PropertiesError('Frontmatter must be a property mapping');
  const pair = doc.contents.items.find(item => isScalar(item.key) && item.key.value === oldKey)!;
  // Renaming the existing scalar keeps this property's position, value and key comments.
  if (!isScalar(pair.key)) throw new PropertiesError('Property names must be scalar strings');
  pair.key.value = newKey;
  return serialize(front, doc);
}
