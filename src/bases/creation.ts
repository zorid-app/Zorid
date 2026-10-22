import { BaseDocument } from './document.ts';
import type { BaseValue } from './document.ts';
import { parseBaseExpression } from './expression.ts';
import type { BaseExpression } from './expression.ts';
import { normalizeBaseProperty } from './query.ts';
import { setProperty } from '../core/properties.ts';
import type { PropertyValue } from '../core/properties.ts';
import { isMarkdown, normalizePath, parentPath } from '../core/types.ts';
import type { VaultEntry } from '../core/types.ts';
import type { Vault, VaultCreateOperation } from '../core/vault.ts';

export interface BaseCreationDefaults {
  readonly properties: Readonly<Record<string, BaseValue>>;
  readonly folder?: string;
  readonly warnings: readonly string[];
}
export interface BaseItemCreationOptions {
  readonly vault: Vault;
  readonly document: BaseDocument | string;
  readonly basePath: string;
  readonly viewIndex?: number;
  /** Filename stem, not a path; collision suffixes start at 1, like normal notes. */
  readonly name?: string;
  readonly fallbackFolder?: string;
  readonly defaults?: Readonly<Record<string, BaseValue>>;
  readonly group?: Readonly<{ property: string; value: BaseValue }>;
  readonly validate?: () => void;
}
export interface BaseCreationPlan {
  readonly path: string;
  readonly text: string;
  readonly templatePath?: string;
  readonly warnings: readonly string[];
}
export interface BaseCreationOperation extends VaultCreateOperation {
  readonly plan: BaseCreationPlan;
}

function literal(node: BaseExpression): { value: BaseValue } | undefined {
  if (node.kind === 'literal' && ['null', 'string', 'boolean', 'number'].includes(node.value.type)) {
    const value = node.value.type === 'null' ? null : (node.value as { value: string | boolean | number }).value;
    if (typeof value === 'number' && !Number.isFinite(value)) return undefined;
    return { value };
  }
  if (node.kind === 'unary' && node.operator === '-' && node.operand.kind === 'literal' && node.operand.value.type === 'number') return { value: -node.operand.value.value };
  if (node.kind === 'list') {
    const values = node.items.map(literal);
    if (values.every(value => value !== undefined)) return { value: values.map(value => value!.value) };
  }
  return undefined;
}
function property(node: BaseExpression): string | undefined {
  if (node.kind === 'identifier' && !['file', 'formula', 'this'].includes(node.name)) return normalizeBaseProperty(node.name);
  if (node.kind === 'member' && node.object.kind === 'identifier' && ['note', 'file'].includes(node.object.name)) {
    const key = literal(node.key)?.value;
    if (typeof key === 'string') return `${node.object.name}.${key}`;
  }
  return undefined;
}
function folderPath(value: string): string { return value === '' || value === '/' ? '' : normalizePath(value); }

/** Creation hints only, never a second query evaluator. Unsupported predicates
 * remain constraints on membership and never manufacture arbitrary values. */
export function inferBaseCreationDefaults(document: BaseDocument, viewIndex = 0): BaseCreationDefaults {
  const view = document.views[viewIndex];
  if (!view) throw new Error('The selected base view does not exist');
  const fields = new Map<string, BaseValue>(), conflicts = new Set<string>(), warnings = new Set<string>();
  let folder: string | undefined, folderConflict = false;
  const assign = (id: string, value: BaseValue) => {
    if (id === 'file.folder' && typeof value === 'string') {
      const next = folderPath(value);
      if (folder !== undefined && folder !== next) { folder = undefined; folderConflict = true; warnings.add('Folder filters conflict; no destination was inferred.'); }
      else if (!folderConflict) folder = next;
    } else if (id.startsWith('note.')) {
      const key = id.slice(5);
      if (fields.has(key) && JSON.stringify(fields.get(key)) !== JSON.stringify(value)) { fields.delete(key); conflicts.add(key); warnings.add(`Conflicting filters did not initialize ${key}.`); }
      else if (!conflicts.has(key)) fields.set(key, value);
    }
  };
  const expression = (node: BaseExpression): void => {
    if (node.kind === 'binary' && node.operator === '&&') { expression(node.left); expression(node.right); return; }
    if (node.kind === 'binary' && ['==', '>=', '<='].includes(node.operator)) {
      const id = property(node.left), value = literal(node.right);
      if (id && value && (node.operator === '==' || typeof value.value === 'number')) { assign(id, value.value); return; }
    }
    if (node.kind === 'call' && node.callee.kind === 'member' && node.callee.object.kind === 'identifier' && node.callee.object.name === 'file') {
      const method = literal(node.callee.key)?.value, value = node.args.length === 1 ? literal(node.args[0])?.value : undefined;
      if (typeof value === 'string') {
        if (method === 'inFolder') { assign('file.folder', value); return; }
        if (method === 'hasProperty') { if (!fields.has(value)) fields.set(value, null); return; }
        if (method === 'hasTag') {
          const tag = value.replace(/^#/, ''), previous = fields.get('tags');
          if (!previous || Array.isArray(previous)) { fields.set('tags', [...new Set([...(previous as readonly BaseValue[] | undefined ?? []), tag])]); return; }
        }
      }
    }
    warnings.add('Some filters cannot safely initialize a new note; the new file may be outside this view.');
  };
  const filter = (value: BaseValue | undefined): void => {
    if (value === undefined) return;
    if (typeof value === 'string') { try { expression(parseBaseExpression(value)); } catch { warnings.add('An advanced filter could not supply creation defaults.'); } return; }
    if (value && !Array.isArray(value) && typeof value === 'object' && Object.keys(value).length === 1 && Object.hasOwn(value, 'and')) {
      const children = (value as Readonly<Record<string, BaseValue>>).and;
      if (Array.isArray(children)) { children.forEach(filter); return; }
    }
    warnings.add('Alternative or negated filters do not supply creation defaults.');
  };
  filter(document.getRoot('filters')); filter(view.filters);
  // Reference New exposes visible note fields as initially empty properties.
  if (Array.isArray(view.order)) for (const id of view.order) {
    if (typeof id !== 'string') continue;
    const key = normalizeBaseProperty(id);
    if (key.startsWith('note.') && !fields.has(key.slice(5)) && !conflicts.has(key.slice(5))) fields.set(key.slice(5), null);
  }
  return Object.freeze({ properties: Object.freeze(Object.fromEntries(fields)), folder, warnings: Object.freeze([...warnings]) });
}

function fileStem(name: string, extension: 'md' | 'base'): string {
  if (typeof name !== 'string') throw new Error('A filename is required');
  name = name.trim().replace(new RegExp(`\\.${extension}$`, 'i'), '');
  if (!name || /[\\/:\u0000-\u001f]/.test(name) || name === '.' || name === '..') throw new Error('The filename must be a nonempty name without path separators');
  return name;
}
function availablePath(entries: readonly VaultEntry[], folder: string, stem: string, extension: string): string {
  const paths = new Set(entries.map(entry => normalizePath(entry.path)));
  const candidate = (suffix: string) => `${folder ? folder + '/' : ''}${stem}${suffix}.${extension}`;
  let path = candidate(''), suffix = 1;
  while (paths.has(path)) path = candidate(` ${suffix++}`);
  return path;
}
function configuredPath(document: BaseDocument, key: string): string | undefined {
  const value = document.getRoot(key);
  if (!value) return undefined;
  if (typeof value !== 'string') throw new Error(`${key} must be a path string`);
  return key === 'newItemFolder' ? folderPath(value) : normalizePath(value);
}

export async function planBaseItemCreation(options: BaseItemCreationOptions): Promise<BaseCreationPlan> {
  const { vault, validate } = options, adapter = vault.adapter;
  const document = typeof options.document === 'string' ? BaseDocument.parse(options.document) : BaseDocument.parse(options.document.toString());
  const defaults = options.defaults === undefined ? undefined : structuredClone(options.defaults);
  const group = options.group === undefined ? undefined : structuredClone(options.group);
  const viewIndex = options.viewIndex ?? 0;
  if (!document.views[viewIndex]) throw new Error('The selected base view does not exist');
  const templatePath = configuredPath(document, 'newItemTemplate'), explicitFolder = configuredPath(document, 'newItemFolder');
  const check = () => { validate?.(); if (vault.adapter !== adapter) throw new Error('The vault changed while preparing the new note'); };
  check();
  const entries = await adapter.list(); check();
  let text = '', inferred: BaseCreationDefaults | undefined;
  const warnings: string[] = [];
  if (templatePath !== undefined) {
    if (!isMarkdown(templatePath) || !entries.some(entry => normalizePath(entry.path) === templatePath && entry.type === 'file')) throw new Error(`The configured template is unavailable: ${templatePath}`);
    text = await vault.read(templatePath); check();
    if (defaults && Object.keys(defaults).length || group && normalizeBaseProperty(group.property).startsWith('note.')) warnings.push('The complete template was copied unchanged; property defaults and group values were not applied. The new note may be outside this view.');
  } else {
    inferred = inferBaseCreationDefaults(document, viewIndex); warnings.push(...inferred.warnings);
    const properties = new Map(Object.entries(inferred.properties));
    for (const [key, value] of Object.entries(defaults ?? {})) properties.set(key, value);
    if (group) {
      const id = normalizeBaseProperty(group.property);
      if (id.startsWith('note.')) { if (group.value === null) properties.delete(id.slice(5)); else properties.set(id.slice(5), group.value); }
      else if (id !== 'file.folder') throw new Error('New notes cannot initialize a computed grouping property');
    }
    for (const [key, value] of properties) text = setProperty(text, key, value as PropertyValue);
  }
  let folder = explicitFolder ?? (templatePath === undefined ? inferred?.folder : parentPath(templatePath)) ?? options.fallbackFolder ?? parentPath(normalizePath(options.basePath));
  if (group && normalizeBaseProperty(group.property) === 'file.folder') {
    if (typeof group.value !== 'string') throw new Error('A folder group must be a folder path');
    folder = group.value;
  }
  folder = folderPath(folder);
  for (let path = folder; path; path = parentPath(path)) {
    const entry = entries.find(entry => normalizePath(entry.path) === path);
    if (entry && entry.type !== 'folder') throw new Error(`The destination contains a file instead of a folder: ${path}`);
  }
  return Object.freeze({ path: availablePath(entries, folder, fileStem(options.name ?? 'Untitled', 'md'), 'md'), text, templatePath, warnings: Object.freeze(warnings) });
}

function operation(vault: Vault, plan: BaseCreationPlan, validate?: () => void): BaseCreationOperation {
  const capturedAdapter = vault.adapter, created = vault.createOperation(plan.path, plan.text, validate);
  let pending: Promise<VaultEntry> | undefined;
  const check = () => { validate?.(); if (vault.adapter !== capturedAdapter) throw new Error('The vault changed before creating the file'); };
  return Object.freeze({ plan, path: plan.path, text: plan.text, get status() { return created.status; }, run() {
    if (pending) return pending;
    const run = async () => {
      const folders: string[] = [];
      for (let path = parentPath(plan.path); path; path = parentPath(path)) folders.unshift(path);
      for (const path of folders) {
        check();
        const entry = capturedAdapter.stat ? await capturedAdapter.stat(path) : (await capturedAdapter.list()).find(entry => normalizePath(entry.path) === path);
        check();
        if (entry) { if (entry.type !== 'folder') throw new Error(`The destination is not a folder: ${path}`); }
        else await vault.createFolder(path, check);
      }
      check(); return created.run();
    };
    const tracked = run().finally(() => { if (pending === tracked) pending = undefined; });
    pending = tracked; return tracked;
  } });
}

/** Keep this handle after failures; a fresh plan would choose a second filename. */
export async function prepareBaseItemCreation(options: BaseItemCreationOptions): Promise<BaseCreationOperation> {
  const plan = await planBaseItemCreation(options);
  return operation(options.vault, plan, options.validate);
}

export async function prepareBaseFileCreation(options: { vault: Vault; folder?: string; name?: string; validate?: () => void }): Promise<BaseCreationOperation> {
  const adapter = options.vault.adapter;
  options.validate?.(); const entries = await adapter.list(); options.validate?.();
  if (options.vault.adapter !== adapter) throw new Error('The vault changed while preparing the new Base');
  const folder = folderPath(options.folder ?? '');
  const plan = Object.freeze({ path: availablePath(entries, folder, fileStem(options.name ?? 'Untitled', 'base'), 'base'), text: BaseDocument.parse('').toString(), warnings: Object.freeze([]) });
  return operation(options.vault, plan, options.validate);
}
