import { Document, isAlias, isMap, isScalar, isSeq, parseDocument, visit } from 'yaml';
import type { YAMLMap, YAMLSeq } from 'yaml';
import { parseBaseExpression } from './expression.ts';
import type { BaseExpression } from './expression.ts';

export const BUILTIN_BASE_VIEW_TYPES = ['table', 'cards', 'list', 'kanban'] as const;
export type BuiltinBaseViewType = typeof BUILTIN_BASE_VIEW_TYPES[number];
export type BaseValue = string | number | boolean | null | readonly BaseValue[] | { readonly [key: string]: BaseValue };
export interface BaseViewConfig {
  readonly type: string;
  readonly name: string;
  readonly [key: string]: BaseValue | undefined;
}
export type BaseViewPatch = { [key: string]: BaseValue | undefined };
export type BaseRootPatch = BaseViewPatch;

/** Each view selects one owning collection or ordinary untyped notes. Missing
 * source is the legacy untyped representation, not a mixed-source wildcard. */
export type BaseViewSource = Readonly<{ kind: 'untyped' }> | Readonly<{ kind: 'collection'; id: string }>;
const untypedSource: BaseViewSource = Object.freeze({ kind: 'untyped' });
export function baseViewSource(view: BaseViewConfig): BaseViewSource {
  const value = view.source;
  if (value === undefined) return untypedSource;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BaseDocumentError('View source must select untyped notes or one collection');
  const source = value as Readonly<Record<string, BaseValue>>;
  if (source.kind === 'untyped' && Object.keys(source).length === 1) return untypedSource;
  if (source.kind === 'collection' && Object.keys(source).length === 2 && typeof source.id === 'string' && /^[0-9a-z]{12}$/.test(source.id)) return Object.freeze({ kind: 'collection', id: source.id });
  throw new BaseDocumentError('View source must select untyped notes or one collection');
}

/** Root configuration is a compatibility fallback only for views without an
 * explicit source. A new source must not inherit another collection's fields. */
export function baseViewSetting(document: BaseDocument, viewIndex: number, key: string): BaseValue | undefined {
  const view = document.views[viewIndex];
  if (!view) throw new BaseDocumentError('The selected base view does not exist');
  return Object.hasOwn(view, key) ? view[key] : view.source === undefined ? document.getRoot(key) : undefined;
}

const sourceSpecificViewKeys = ['filters', 'sort', 'groupBy', 'groupOrder', 'order', 'properties', 'columnSize', 'summaries', 'summaryDefinitions', 'formulas', 'image', 'newItemFolder', 'newItemTemplate'];
/** Preserve layout and unfamiliar settings, while retiring field references
 * when selecting a different source. This patch edits no entry or sibling view. */
export function resetViewSourcePatch(view: BaseViewConfig, source: BaseViewSource): BaseViewPatch {
  const checked = baseViewSource({ type: view.type, name: view.name, source });
  const patch: BaseViewPatch = { source: checked };
  for (const key of sourceSpecificViewKeys) patch[key] = undefined;
  return patch;
}

/** Interactive names follow the reference UI; the reader accepts older/raw YAML. */
export function validateBaseViewName(name: string, views: readonly BaseViewConfig[], except = -1): string {
  if (typeof name !== 'string') throw new BaseDocumentError('View name must be a string');
  name = name.trim();
  if (!name || /[:#|^\\\r\n]|%%|\[\[|\]\]/.test(name)) throw new BaseDocumentError('The view name is empty or contains unsupported characters');
  if (views.some((view, index) => index !== except && view.name === name)) throw new BaseDocumentError('A view with this name already exists');
  return name;
}

export function uniqueBaseViewName(name: string, views: readonly BaseViewConfig[]): string {
  const names = new Set(views.map(view => view.name));
  let result = name, suffix = 2;
  while (names.has(result)) result = `${name} ${suffix++}`;
  return result;
}

function renameFormulaExpression(source: string, to: string, references: (name: string) => boolean): string {
  let changed = false;
  const render = (node: BaseExpression): string => {
    switch (node.kind) {
      case 'literal':
        if (node.value.type === 'null') return 'null';
        if (node.value.type === 'regexp') return node.value.value.toString();
        if (node.value.type === 'string' || node.value.type === 'boolean' || node.value.type === 'number') {
          if (node.value.type === 'number' && !Number.isFinite(node.value.value)) throw new BaseDocumentError('Cannot safely rewrite a nonfinite expression literal');
          return JSON.stringify(node.value.value);
        }
        throw new BaseDocumentError('Cannot safely rewrite this expression literal');
      case 'identifier': return node.name;
      case 'list': return `[${node.items.map(render).join(', ')}]`;
      case 'unary': return `(${node.operator}${render(node.operand)})`;
      case 'binary': return `(${render(node.left)} ${node.operator} ${render(node.right)})`;
      case 'call': return `${render(node.callee)}(${node.args.map(render).join(', ')})`;
      case 'member': {
        let key = node.key;
        if (node.object.kind === 'identifier' && node.object.name.toLowerCase() === 'formula' && key.kind === 'literal' && key.value.type === 'string' && references(key.value.value)) {
          changed = true; key = { kind: 'literal', value: { type: 'string', value: to } };
        }
        const object = render(node.object);
        if (!node.computed && key.kind === 'literal' && key.value.type === 'string' && /^[$_\p{L}][$_\p{L}\p{N}\p{M}]*$/u.test(key.value.value)) return `${object}.${key.value.value}`;
        return `${object}[${render(key)}]`;
      }
    }
  };
  // Parse only expressions which can possibly mention the namespace. A future
  // expression syntax we cannot safely understand rejects the atomic rename.
  if (!/formula/i.test(source)) return source;
  const result = render(parseBaseExpression(source));
  return changed ? result : source;
}

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

function equalValues(left: BaseValue, right: BaseValue): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => equalValues(item, right[index]));
  const keys = Object.keys(left), other = Object.keys(right);
  // Mapping order can affect case-insensitive first-match lookup. Preserve it.
  return keys.length === other.length && keys.every((key, index) => key === other[index] && equalValues((left as Readonly<Record<string, BaseValue>>)[key], (right as Readonly<Record<string, BaseValue>>)[key]));
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
      baseViewSource(view as BaseViewConfig);
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

function captureConfigurationPatch(patch: BaseViewPatch | undefined): BaseViewPatch {
  if (patch === undefined) return {};
  if (!patch || typeof patch !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(patch)) || Object.getOwnPropertySymbols(patch).length) throw new BaseDocumentError('Configuration patches must be plain mappings');
  const entries = Object.getOwnPropertyNames(patch).map(key => {
    const item = Object.getOwnPropertyDescriptor(patch, key)!;
    if (!('value' in item) || !item.enumerable) throw new BaseDocumentError('Configuration patches must contain ordinary enumerable data properties');
    if (item.value !== undefined) validateInput(item.value);
    return [key, item.value] as const;
  });
  return Object.fromEntries(entries);
}

function parseBaseYAML(source: string): Document {
  return parseDocument(source, {
    version: '1.2', schema: 'core', stringKeys: true, uniqueKeys: true,
    resolveKnownTags: false, logLevel: 'silent',
  });
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
    const doc = parseBaseYAML(source);
    if (!source.trim()) {
      doc.set('views', doc.createNode([{ type: 'table', name: 'Table' }]));
      const result = new BaseDocument(doc, source);
      result.source = result.serialize(doc);
      return result;
    }
    validateDocument(doc);
    const result = new BaseDocument(doc, source);
    if (!doc.has('views')) {
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

  private edit(operation: (doc: Document) => void, renamedView?: number): void {
    const next = this.document.clone();
    try {
      operation(next);
      const values = validateDocument(next);
      if (equalValues(values, this.values)) return;
      // A view rename must not rewrite unrelated configuration bytes. Other
      // mutations retain the normal serializer and its alias-order validation.
      const result = renamedView === undefined
        ? { document: next, source: this.serialize(next) }
        : this.renamedViewSource(renamedView, values);
      this.document = result.document; this.source = result.source; this.values = values;
    } catch (error) {
      throw error instanceof BaseDocumentError ? error : new BaseDocumentError(error instanceof Error ? error.message : String(error));
    }
  }

  private renamedViewSource(index: number, expected: Readonly<Record<string, BaseValue>>): { document: Document; source: string } {
    // Generic edits can leave the cloned AST's ranges referring to older text.
    // Always locate the name in the current published source instead.
    const current = parseBaseYAML(this.source);
    const node = this.viewAt(current, index).get('name', true);
    if ((!isScalar(node) && !isAlias(node)) || !node.range) throw new BaseDocumentError('Cannot locate the view name in the base source');
    const [start, end] = node.range;
    const name = (expected.views as readonly BaseViewConfig[])[index].name;
    const quoted = JSON.stringify(name);
    let replacement = quoted, suffix = '';
    if (isScalar(node) && (node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED')) {
      // The header comment belongs to the name, but is not part of its value.
      // Keep it byte-exact when replacing a block with an escaped inline string.
      const raw = this.source.slice(start, end);
      const header = /^[|>][1-9+-]*([^\r\n]*)\r?\n/.exec(raw);
      if (!header) throw new BaseDocumentError('Cannot locate the block view name header');
      suffix = header[1] + (raw.endsWith('\r\n') ? '\r\n' : raw.endsWith('\n') ? '\n' : '');
    } else if (!/[\u0000-\u001f\u007f-\u009f]/.test(name)) {
      if (isScalar(node) && node.type === 'QUOTE_SINGLE') replacement = `'${name.replace(/'/g, "''")}'`;
      else if (!isScalar(node) || node.type === 'PLAIN') replacement = name;
    }
    // Plain scalars have different restrictions in flow/block contexts. Accept
    // an encoding only if the entire parsed configuration exactly matches the
    // normal mutation, including anchored-name alias effects and mapping order.
    for (const value of new Set([replacement, quoted])) {
      const source = this.source.slice(0, start) + value + suffix + this.source.slice(end);
      const document = parseBaseYAML(source);
      try {
        if (equalValues(validateDocument(document), expected)) return { document, source };
      } catch { /* Try the unambiguous quoted representation before rejecting. */ }
    }
    throw new BaseDocumentError('Cannot safely preserve the base source while renaming this view');
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
    const previous = this.views[index];
    const nameOnly = previous && entries.some(([key, value]) => key === 'name' && typeof value === 'string')
      && entries.every(([key, value]) => key === 'name' || (value === undefined
        ? !Object.hasOwn(previous, key)
        : Object.hasOwn(previous, key) && equalValues(previous[key]!, value)));
    this.edit(doc => {
      const view = this.viewAt(doc, index);
      for (const [key, value] of entries) {
        if (value === undefined) view.delete(key);
        else view.set(key, value !== null && typeof value === 'object' ? doc.createNode(value) : value);
      }
    }, nameOnly ? index : undefined);
  }

  changeViewSource(index: number, source: BaseViewSource): void {
    const view = this.views[index];
    if (!view) throw new BaseDocumentError('The selected base view does not exist');
    const next = baseViewSource({ type: view.type, name: view.name, source });
    const previous = baseViewSource(view);
    if (view.source !== undefined && previous.kind === next.kind && (previous.kind === 'untyped' || next.kind === 'collection' && previous.id === next.id)) return;
    this.updateView(index, resetViewSourcePatch(view, next));
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

  /** Move the original YAML node, retaining its comments and custom settings. */
  moveView(from: number, to: number): void {
    this.edit(doc => {
      this.viewAt(doc, from); this.viewAt(doc, to);
      const views = this.viewList(doc);
      const [view] = views.items.splice(from, 1); views.items.splice(to, 0, view);
    });
  }

  /** The first view is the default; no competing default-name field is persisted. */
  setDefaultView(index: number): void { this.moveView(index, 0); }

  /** Apply a root patch atomically so malformed settings cannot leave a prefix. */
  updateRoot(patch: BaseRootPatch): void {
    if (!patch || typeof patch !== 'object' || (Object.getPrototypeOf(patch) !== Object.prototype && Object.getPrototypeOf(patch) !== null)) throw new BaseDocumentError('A root patch must be a plain mapping');
    if (Object.getOwnPropertySymbols(patch).length) throw new BaseDocumentError('Symbol keys are not supported in root patches');
    const entries = Object.getOwnPropertyNames(patch).map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(patch, key)!;
      if (!('value' in descriptor) || !descriptor.enumerable) throw new BaseDocumentError('Root patches must contain ordinary enumerable data properties');
      const value = descriptor.value as BaseValue | undefined;
      if (value !== undefined) validateInput(value);
      return [key, value] as const;
    });
    this.edit(doc => {
      for (const [key, value] of entries) {
        if (value === undefined) doc.delete(key);
        else doc.set(key, value !== null && typeof value === 'object' ? doc.createNode(value) : value);
      }
    });
  }

  /** Route former root controls to the selected explicit-source view. Legacy
   * files retain root semantics until their source is deliberately selected. */
  updateViewConfiguration(index: number, patch: { root?: BaseRootPatch; view?: BaseViewPatch }): void {
    const view = this.views[index];
    if (!view) throw new BaseDocumentError('The selected base view does not exist');
    const root = captureConfigurationPatch(patch.root), local = captureConfigurationPatch(patch.view);
    if (view.source !== undefined) for (const key of sourceSpecificViewKeys) {
      if (!Object.hasOwn(root, key)) continue;
      const target = key === 'summaries' ? 'summaryDefinitions' : key;
      if (!Object.hasOwn(local, target)) local[target] = root[key];
      delete root[key];
    }
    // Validate the complete operation on a detached document first. Publishing
    // root then view cannot leave a valid prefix when the second patch fails.
    const next = BaseDocument.parse(this.toString());
    if (Object.keys(root).length) next.updateRoot(root);
    if (Object.keys(local).length) next.updateView(index, local);
    const checked = parseBaseYAML(next.toString());
    const values = validateDocument(checked);
    this.document = checked; this.source = next.toString(); this.values = values;
  }

  private scopedViewDocument(index: number): BaseDocument {
    const view = this.views[index];
    if (!view) throw new BaseDocumentError('The selected base view does not exist');
    return BaseDocument.parse(JSON.stringify({ formulas: view.formulas ?? {}, summaries: view.summaryDefinitions ?? {}, views: [view] }));
  }

  setViewFormula(index: number, name: string, expression: string | undefined): void {
    const view = this.views[index];
    if (!view) throw new BaseDocumentError('The selected base view does not exist');
    if (view.source === undefined) { this.setFormula(name, expression); return; }
    const next = this.scopedViewDocument(index); next.setFormula(name, expression);
    this.updateView(index, { formulas: next.getRoot('formulas') });
  }

  renameViewFormula(index: number, from: string, to: string): void {
    const view = this.views[index];
    if (!view) throw new BaseDocumentError('The selected base view does not exist');
    if (view.source === undefined) { this.renameFormula(from, to); return; }
    const next = this.scopedViewDocument(index); next.renameFormula(from, to);
    this.updateView(index, { ...next.views[0], formulas: next.getRoot('formulas') });
  }

  editViewSummary(index: number, originalName: string | undefined, name: string, expression: string): void {
    const view = this.views[index];
    if (!view) throw new BaseDocumentError('The selected base view does not exist');
    if (view.source === undefined) { this.editSummary(originalName, name, expression); return; }
    const next = this.scopedViewDocument(index); next.editSummary(originalName, name, expression);
    this.updateView(index, { ...next.views[0], summaryDefinitions: next.getRoot('summaries') });
  }

  removeViewSummary(index: number, name: string): void {
    const view = this.views[index];
    if (!view) throw new BaseDocumentError('The selected base view does not exist');
    if (view.source === undefined) { this.removeSummary(name); return; }
    const next = this.scopedViewDocument(index); next.removeSummary(name);
    this.updateView(index, { ...next.views[0], summaryDefinitions: next.getRoot('summaries') });
  }

  setFormula(name: string, expression: string | undefined): void {
    if (typeof name !== 'string' || !name.trim()) throw new BaseDocumentError('Formula name must be nonempty');
    if (expression !== undefined && typeof expression !== 'string') throw new BaseDocumentError('Formula expression must be a string');
    this.edit(doc => {
      if (!doc.has('formulas')) {
        if (expression === undefined) return;
        doc.set('formulas', doc.createNode({}));
      }
      const formulas = doc.get('formulas', true);
      if (!isMap(formulas)) throw new BaseDocumentError('Base formulas must be a mapping');
      if (expression === undefined) formulas.delete(name); else formulas.set(name, expression);
    });
  }

  /** Summary names are referenced by view values, not property keys. A new
   * summary may already be selected before its first definition is persisted. */
  editSummary(originalName: string | undefined, name: string, expression: string): void {
    if (typeof name !== 'string' || !name.trim()) throw new BaseDocumentError('Summary name must be nonempty');
    if (originalName !== undefined && (typeof originalName !== 'string' || !originalName.trim())) throw new BaseDocumentError('Original summary name must be nonempty');
    if (typeof expression !== 'string') throw new BaseDocumentError('Summary expression must be a string');
    this.edit(doc => {
      if (!doc.has('summaries')) doc.set('summaries', doc.createNode({}));
      const summaries = doc.get('summaries', true);
      if (!isMap(summaries)) throw new BaseDocumentError('Base summaries must be a mapping');
      if (originalName !== name && summaries.has(name)) throw new BaseDocumentError('A summary with this name already exists');
      if (originalName !== undefined && originalName !== name) {
        const pair = summaries.items.find(item => isScalar(item.key) && item.key.value === originalName);
        if (pair && isScalar(pair.key)) pair.key.value = name;
        for (let index = 0; index < this.viewList(doc).items.length; index++) {
          const selections = this.viewAt(doc, index).get('summaries', true);
          if (selections === undefined) continue;
          if (!isMap(selections)) throw new BaseDocumentError('View summaries must be an editable mapping');
          for (const selection of selections.items) if (isScalar(selection.value) && selection.value.value === originalName) selection.value.value = name;
        }
      }
      summaries.set(name, expression);
    });
  }

  /** Remove matching selections across every view even for an undefined draft. */
  removeSummary(name: string): void {
    if (typeof name !== 'string' || !name.trim()) throw new BaseDocumentError('Summary name must be nonempty');
    this.edit(doc => {
      const summaries = doc.get('summaries', true);
      if (summaries !== undefined) {
        if (!isMap(summaries)) throw new BaseDocumentError('Base summaries must be a mapping');
        summaries.delete(name);
      }
      for (let index = 0; index < this.viewList(doc).items.length; index++) {
        const selections = this.viewAt(doc, index).get('summaries', true);
        if (selections === undefined) continue;
        if (!isMap(selections)) throw new BaseDocumentError('View summaries must be an editable mapping');
        selections.items = selections.items.filter(selection => !isScalar(selection.value) || selection.value.value !== name);
      }
    });
  }

  /** Rename stored formula identity and its statically addressable references. */
  renameFormula(from: string, to: string): void {
    if (typeof from !== 'string' || typeof to !== 'string' || !to.trim()) throw new BaseDocumentError('Formula names must be nonempty strings');
    this.edit(doc => {
      const formulas = doc.get('formulas', true);
      if (!isMap(formulas) || !formulas.has(from)) throw new BaseDocumentError(`Formula not found: ${from}`);
      if (from === to) return;
      if (formulas.has(to)) throw new BaseDocumentError('A formula with this name already exists');
      const names = formulas.items.map(item => isScalar(item.key) ? String(item.key.value) : '');
      const references = (name: string) => (names.includes(name) ? name : names.find(key => key.toLowerCase() === name.toLowerCase())) === from;
      const pair = formulas.items.find(item => isScalar(item.key) && item.key.value === from)!;
      if (!pair || !isScalar(pair.key)) throw new BaseDocumentError('The formula key cannot be renamed safely');
      pair.key.value = to;
      const expression = (node: unknown) => {
        if (isScalar(node) && typeof node.value === 'string') node.value = renameFormulaExpression(node.value, to, references);
      };
      const expressionMap = (node: unknown) => { if (isMap(node)) for (const item of node.items) expression(item.value); };
      const filter = (node: unknown): void => {
        if (isScalar(node)) expression(node);
        else if (isMap(node)) for (const item of node.items) if (isScalar(item.key) && ['and', 'or', 'not'].includes(String(item.key.value)) && isSeq(item.value)) item.value.items.forEach(filter);
      };
      const id = (node: unknown) => { if (isScalar(node) && typeof node.value === 'string' && node.value.startsWith('formula.') && references(node.value.slice(8))) node.value = `formula.${to}`; };
      const propertyMap = (node: unknown) => { if (isMap(node)) for (const item of node.items) id(item.key); };
      expressionMap(formulas); expressionMap(doc.get('summaries', true));
      filter(doc.get('filters', true)); propertyMap(doc.get('properties', true));
      const views = this.viewList(doc);
      for (const view of views.items) {
        if (!isMap(view)) throw new BaseDocumentError('Aliased view mappings cannot be edited directly');
        filter(view.get('filters', true)); propertyMap(view.get('summaries', true));
        // Cards and Kanban persist their cover's property ID separately from
        // the visible property list.
        id(view.get('image', true));
        const order = view.get('order', true); if (isSeq(order)) order.items.forEach(id);
        const group = view.get('groupBy', true); if (isMap(group)) id(group.get('property', true));
        const sort = view.get('sort', true); if (isSeq(sort)) for (const item of sort.items) if (isMap(item)) { id(item.get('property', true)); id(item.get('column', true)); }
      }
    });
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
