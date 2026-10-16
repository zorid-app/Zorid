import { Document, isMap, isSeq, parseDocument, visit } from 'yaml';
import type { YAMLMap, YAMLSeq } from 'yaml';

export const BUILTIN_BASE_VIEW_TYPES = ['table', 'cards', 'list', 'kanban'] as const;
export type BuiltinBaseViewType = typeof BUILTIN_BASE_VIEW_TYPES[number];
export type BaseValue = string | number | boolean | null | readonly BaseValue[] | { readonly [key: string]: BaseValue };
export interface BaseViewConfig {
  readonly type: string;
  readonly name: string;
  readonly [key: string]: BaseValue | undefined;
}
export type BaseViewPatch = { [key: string]: BaseValue | undefined };

export class BaseDocumentError extends Error {
  constructor(message: string) { super(message); this.name = 'BaseDocumentError'; }
}

/** Freeze detached safe data; YAML mappings never assign to a JavaScript prototype. */
function valueFromYAML(value: unknown, ancestors = new Set<object>()): BaseValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (!value || typeof value !== 'object') throw new BaseDocumentError('Unsupported YAML value in base');
  if (ancestors.has(value)) throw new BaseDocumentError('Cyclic YAML aliases are not supported in bases');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(value.map(item => valueFromYAML(item, ancestors)));
    if (value instanceof Map) {
      const entries: [string, BaseValue][] = [];
      for (const [key, item] of value) {
        if (typeof key !== 'string') throw new BaseDocumentError('Base mapping keys must be strings');
        entries.push([key, valueFromYAML(item, ancestors)]);
      }
      return Object.freeze(Object.fromEntries(entries));
    }
    throw new BaseDocumentError('Unsupported YAML value in base');
  } finally { ancestors.delete(value); }
}

function rootValues(doc: Document): Readonly<Record<string, BaseValue>> {
  if (!isMap(doc.contents)) throw new BaseDocumentError('A base document must be a YAML mapping');
  let values: BaseValue;
  try { values = valueFromYAML(doc.toJS({ mapAsMap: true, maxAliasCount: 100 })); }
  catch (error) { throw new BaseDocumentError(`Cannot read base: ${error instanceof Error ? error.message : String(error)}`); }
  return values as Readonly<Record<string, BaseValue>>;
}

function validateDocument(doc: Document): Readonly<Record<string, BaseValue>> {
  if (doc.errors.length || doc.warnings.length) {
    throw new BaseDocumentError(`Invalid or unsupported base YAML: ${[...doc.errors, ...doc.warnings].map(error => error.message).join('; ')}`);
  }
  const root = rootValues(doc);
  if (Object.hasOwn(root, 'views')) {
    if (!Array.isArray(root.views)) throw new BaseDocumentError('Base views must be a list');
    for (const view of root.views) {
      if (!view || typeof view !== 'object' || Array.isArray(view)) throw new BaseDocumentError('Each base view must be a mapping');
      for (const key of ['type', 'name']) {
        if (!Object.hasOwn(view, key) || typeof (view as Record<string, BaseValue>)[key] !== 'string' || !(view as Record<string, BaseValue>)[key]) {
          throw new BaseDocumentError(`View ${key} must be a nonempty string`);
        }
      }
    }
  }
  return root;
}

function validateInput(value: unknown, ancestors = new Set<object>()): asserts value is BaseValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object' || (Array.isArray(value)
    ? Object.getPrototypeOf(value) !== Array.prototype
    : Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new BaseDocumentError('Base values must be strings, finite numbers, booleans, null, lists or plain mappings');
  }
  if (ancestors.has(value)) throw new BaseDocumentError('Cyclic base values are not supported');
  if (Object.getOwnPropertySymbols(value).length) throw new BaseDocumentError('Symbol keys are not supported in base values');
  ancestors.add(value);
  try {
    for (const key of Object.getOwnPropertyNames(value)) {
      if (Array.isArray(value) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor) || !descriptor.enumerable) throw new BaseDocumentError('Base values must contain ordinary enumerable data properties');
      if (Array.isArray(value) && !/^(?:0|[1-9]\d*)$/.test(key)) throw new BaseDocumentError('Named list properties are not supported');
      validateInput(descriptor.value, ancestors);
    }
    if (Array.isArray(value)) for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) throw new BaseDocumentError('Sparse base lists are not supported');
    }
  } finally { ancestors.delete(value); }
}

/**
 * Original .base YAML document model. Unknown configuration is retained, not executed.
 * Custom tags and cyclic/excessive aliases fail explicitly. There is no query evaluator.
 */
export class BaseDocument {
  private document: Document;
  private source: string;
  private newline: string;
  private bom: string;
  private values: Readonly<Record<string, BaseValue>>;

  private constructor(document: Document, source: string) {
    this.document = document;
    this.source = source;
    this.newline = /\r?\n/.exec(source)?.[0] ?? '\n';
    this.bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
    this.values = rootValues(document);
  }

  static parse(source: string): BaseDocument {
    const doc: Document = parseDocument(source, {
      version: '1.2', schema: 'core', stringKeys: true, uniqueKeys: true,
      resolveKnownTags: false, logLevel: 'silent',
    });
    if (!source.trim()) {
      doc.set('views', doc.createNode([{ type: 'table', name: 'Table' }]));
      const result = new BaseDocument(doc, source);
      result.source = result.serialize(doc);
      return result;
    }
    validateDocument(doc);
    const result = new BaseDocument(doc, source);
    if (!doc.has('views') || result.views.length === 0) {
      result.edit(next => next.set('views', next.createNode([{ type: 'table', name: 'Table' }])));
    }
    return result;
  }

  get views(): readonly BaseViewConfig[] {
    return (this.values.views ?? Object.freeze([])) as readonly BaseViewConfig[];
  }

  getRoot(key: string): BaseValue | undefined {
    return Object.hasOwn(this.values, key) ? this.values[key] : undefined;
  }

  toString(): string { return this.source; }

  private serialize(doc: Document): string {
    return this.bom + doc.toString({ lineWidth: 0 }).replace(/\r?\n/g, this.newline);
  }

  private edit(operation: (doc: Document) => void): void {
    const next = this.document.clone();
    try {
      operation(next);
      const values = validateDocument(next);
      const source = this.serialize(next); // Verify alias order before publishing any mutation.
      this.document = next; this.source = source; this.values = values;
    } catch (error) {
      throw error instanceof BaseDocumentError ? error : new BaseDocumentError(error instanceof Error ? error.message : String(error));
    }
  }

  private viewList(doc: Document, create = false): YAMLSeq {
    let views = doc.get('views', true);
    if (views === undefined && create) { doc.set('views', doc.createNode([])); views = doc.get('views', true); }
    if (!isSeq(views)) throw new BaseDocumentError('Base views must be a list');
    return views;
  }

  private viewAt(doc: Document, index: number): YAMLMap {
    const views = this.viewList(doc);
    if (!Number.isInteger(index) || index < 0 || index >= views.items.length) throw new BaseDocumentError(`View index is out of range: ${index}`);
    const view = views.items[index];
    if (!isMap(view)) throw new BaseDocumentError('Aliased view mappings cannot be edited directly');
    return view;
  }

  /** Shallow patch: undefined removes a field; unknown/plugin keys remain untouched. */
  updateView(index: number, patch: BaseViewPatch): void {
    if (!patch || typeof patch !== 'object' || (Object.getPrototypeOf(patch) !== Object.prototype && Object.getPrototypeOf(patch) !== null)) throw new BaseDocumentError('A view patch must be a plain mapping');
    if (Object.getOwnPropertySymbols(patch).length) throw new BaseDocumentError('Symbol keys are not supported in view patches');
    const entries: [string, BaseValue | undefined][] = Object.getOwnPropertyNames(patch).map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(patch, key)!;
      if (!('value' in descriptor) || !descriptor.enumerable) throw new BaseDocumentError('View patches must contain ordinary enumerable data properties');
      return [key, descriptor.value];
    });
    for (const [, value] of entries) if (value !== undefined) validateInput(value);
    this.edit(doc => {
      const view = this.viewAt(doc, index);
      for (const [key, value] of entries) {
        if (value === undefined) view.delete(key);
        else view.set(key, value !== null && typeof value === 'object' ? doc.createNode(value) : value);
      }
    });
  }

  addView(type: string, name: string): number {
    if (typeof type !== 'string' || typeof name !== 'string') throw new BaseDocumentError('View type and name must be strings');
    let index = 0;
    this.edit(doc => {
      const views = this.viewList(doc, true); index = views.items.length;
      views.add(doc.createNode({ type, name }));
    });
    return index;
  }

  duplicateView(index: number, newName: string): number {
    if (typeof newName !== 'string') throw new BaseDocumentError('View name must be a string');
    let added = 0;
    this.edit(doc => {
      const copy = this.viewAt(doc, index).clone() as YAMLMap; copy.set('name', newName);
      // Give copied anchors unique names so later existing aliases keep their targets.
      const used = new Set<string>(), replacements = new Map<string, string>();
      visit(doc, { Value: (_, node) => { if (node.anchor) used.add(node.anchor); } });
      visit(copy, { Value: (_, node) => {
        if (!node.anchor) return;
        const old = node.anchor; let name = `${old}_copy`, number = 2;
        while (used.has(name)) name = `${old}_copy${number++}`;
        used.add(name); replacements.set(old, name); node.anchor = name;
      } });
      visit(copy, { Alias: (_, node) => { if (replacements.has(node.source)) node.source = replacements.get(node.source)!; } });
      const views = this.viewList(doc); added = views.items.length; views.add(copy);
    });
    return added;
  }

  removeView(index: number): void {
    this.edit(doc => { this.viewAt(doc, index); this.viewList(doc).items.splice(index, 1); });
  }

  setRoot(key: string, value: BaseValue | undefined): void {
    if (typeof key !== 'string') throw new BaseDocumentError('Root field names must be strings');
    if (value !== undefined) validateInput(value);
    this.edit(doc => {
      if (value === undefined) doc.delete(key);
      else doc.set(key, value !== null && typeof value === 'object' ? doc.createNode(value) : value);
    });
  }
}
