import { ok, ZoridError, normalizeVaultPath, type Disposable, type JsonValue, type PluginId, type VaultPath } from '@zorid/shared';
import type { DataViewRenderOptions, DataViewRenderer, DataViewsAPI, FieldValue, FieldsAPI, FileRecord, ObjectStoreAPI, ZbaseDocument, ZbaseFilters, ZbaseView, ZtypeDocument, ZtypeField } from '@zorid/platform-api';
import type { IndexStore } from '@zorid/db';

function parsePrimitive(value: string): JsonValue {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number.parseFloat(trimmed);
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed.slice(1, -1).split(',').map((part) => part.trim()).filter(Boolean);
  return trimmed.replace(/^['"]|['"]$/g, '');
}

function parseSimpleYamlObject(contents: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const lines = contents.split(/\r?\n/);
  let currentListKey: string | undefined;
  let currentItem: Record<string, unknown> | undefined;
  let currentMapKey: string | undefined;
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    const top = /^(?<key>[A-Za-z0-9_.-]+):\s*(?<value>.*)$/.exec(line);
    if (top?.groups?.key !== undefined && top.groups.value !== undefined && !raw.startsWith(' ')) {
      const key = top.groups.key;
      const value = top.groups.value;
      if (value === '') {
        root[key] = [];
        currentListKey = key;
        currentMapKey = key;
      } else {
        root[key] = parsePrimitive(value);
        currentListKey = undefined;
        currentMapKey = undefined;
      }
      currentItem = undefined;
      continue;
    }
    const list = /^\s*-\s*(?<rest>.*)$/.exec(line);
    if (list?.groups && currentListKey) {
      const arr = root[currentListKey] as unknown[];
      currentItem = {};
      arr.push(currentItem);
      const rest = list.groups.rest ?? '';
      const inline = /^(?<key>[A-Za-z0-9_.-]+):\s*(?<value>.*)$/.exec(rest);
      if (inline?.groups?.key !== undefined && inline.groups.value !== undefined) currentItem[inline.groups.key] = parsePrimitive(inline.groups.value);
      continue;
    }
    const nested = /^\s+(?<key>[A-Za-z0-9_.-]+):\s*(?<value>.*)$/.exec(line);
    if (nested?.groups?.key !== undefined && nested.groups.value !== undefined) {
      if (currentItem) currentItem[nested.groups.key] = parsePrimitive(nested.groups.value);
      else if (currentMapKey) {
        const obj = (typeof root[currentMapKey] === 'object' && !Array.isArray(root[currentMapKey]) ? root[currentMapKey] : {}) as Record<string, unknown>;
        obj[nested.groups.key] = parsePrimitive(nested.groups.value);
        root[currentMapKey] = obj;
      }
    }
  }
  return root;
}

function parseObject(contents: string): Record<string, unknown> {
  const trimmed = contents.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed) as Record<string, unknown>;
  return parseSimpleYamlObject(contents);
}


type RenderContainer = HTMLElement & {
  textContent: string | null;
  appendChild?: (child: RenderContainer) => unknown;
  replaceChildren?: (...children: RenderContainer[]) => void;
  ownerDocument?: { createElement: (tagName: string) => RenderContainer };
  dataset?: Record<string, string | undefined>;
};

function clearContainer(container: HTMLElement): void {
  const target = container as RenderContainer;
  if (typeof target.replaceChildren === 'function') target.replaceChildren();
  else target.textContent = '';
}

function createChildContainer(parent: HTMLElement, tagName: string): RenderContainer {
  const target = parent as RenderContainer;
  const child = (target.ownerDocument?.createElement(tagName) as RenderContainer | undefined) ?? ({ textContent: '', dataset: {}, appendChild(childNode: RenderContainer) { this.textContent = `${this.textContent ?? ''}${childNode.textContent ?? ''}`; }, replaceChildren(...children: RenderContainer[]) { this.textContent = children.map((childNode) => childNode.textContent ?? '').join(''); } } as RenderContainer);
  if (typeof target.appendChild === 'function') target.appendChild(child);
  return child;
}

function appendText(parent: HTMLElement, tagName: string, text: string): RenderContainer {
  const child = createChildContainer(parent, tagName);
  child.textContent = text;
  const target = parent as RenderContainer;
  if (typeof target.appendChild !== 'function') target.textContent = `${target.textContent ?? ''}${text}`;
  return child;
}

export function parseZtype(path: VaultPath, contents: string): ZtypeDocument {
  const raw = parseObject(contents) as { fields?: ZtypeField[] | Record<string, ZtypeField> };
  const seen = new Set<string>();
  const rawFields = (Array.isArray(raw.fields) ? raw.fields : Object.entries(raw.fields ?? {}).map(([key, value]) => ({ key, ...(value as object) }))) as Partial<ZtypeField>[];
  const fields = rawFields.map((field) => {
    if (!field.key || !field.type) throw new ZoridError('ztype.invalid-field', 'Field key and type are required.');
    if (seen.has(field.key)) throw new ZoridError('ztype.duplicate-field', `Duplicate field: ${field.key}`);
    seen.add(field.key);
    return field as ZtypeField;
  });
  return { path, fields };
}

export function parseZbase(path: VaultPath, contents: string): ZbaseDocument {
  const raw = parseObject(contents) as { views?: ZbaseView[] | Record<string, ZbaseView> };
  const seen = new Set<string>();
  const rawViews = Array.isArray(raw.views) ? raw.views : Object.entries(raw.views ?? {}).map(([id, value]) => ({ id, ...(value as object) }));
  const views = rawViews.map((view) => {
    const normalizedView = { ...view, renderer: (view as ZbaseView).renderer ?? (view as unknown as { type?: string }).type } as ZbaseView;
    if (!normalizedView.id || !normalizedView.renderer) throw new ZoridError('zbase.invalid-view', 'View id and renderer are required.');
    if (seen.has(normalizedView.id)) throw new ZoridError('zbase.duplicate-view', `Duplicate view: ${normalizedView.id}`);
    seen.add(normalizedView.id);
    return normalizedView;
  });
  return { path, views };
}

export class JsonObjectStoreService implements ObjectStoreAPI {
  #files = new Map<VaultPath, string>();
  constructor(initial: Record<string, string> = {}) { for (const [path, contents] of Object.entries(initial)) this.#files.set(normalizeVaultPath(path), contents); }
  async readType(path: VaultPath): Promise<ZtypeDocument> { const contents = this.#files.get(path); if (contents === undefined) throw new ZoridError('object.missing', `Missing object: ${path}`); return parseZtype(path, contents); }
  async readBase(path: VaultPath): Promise<ZbaseDocument> { const contents = this.#files.get(path); if (contents === undefined) throw new ZoridError('object.missing', `Missing object: ${path}`); return parseZbase(path, contents); }
  async writeObject(path: VaultPath, value: JsonValue) { this.#files.set(path, JSON.stringify(value, null, 2)); return ok(undefined); }
  setRaw(path: VaultPath, contents: string): void { this.#files.set(path, contents); }
}

export class FieldsService implements FieldsAPI {
  #store: IndexStore;
  #objects: JsonObjectStoreService;
  constructor(store: IndexStore, objects = new JsonObjectStoreService()) { this.#store = store; this.#objects = objects; }
  async getFields(path: VaultPath): Promise<readonly FieldValue[]> { const record = this.#store.get(path); return Object.entries(record?.fields ?? {}).map(([key, value]) => ({ key, value, source: 'frontmatter' as const })); }
  async getType(path: VaultPath): Promise<ZtypeDocument | undefined> { const record = this.#store.get(path); const type = record?.fields['zorid.type']; if (typeof type !== 'string') return undefined; return this.#objects.readType(normalizeVaultPath(`.zorid/types/${type}.ztype`)); }
  async updateField(path: VaultPath, key: string, value: JsonValue): Promise<void> { const record = this.#store.get(path); if (!record) throw new ZoridError('fields.file-missing', `No indexed file: ${path}`); this.#store.upsert({ ...record, fields: { ...record.fields, [key]: value }, frontmatter: { ...record.frontmatter, [key]: value } }); }
  async setType(path: VaultPath, typePath: VaultPath | undefined): Promise<void> { await this.updateField(path, 'zorid.type', typePath ? String(typePath).replace(/^\.zorid\/types\//, '').replace(/\.ztype$/, '') : null); }
}

export class DataViewsService implements DataViewsAPI {
  #store: IndexStore;
  #objects: JsonObjectStoreService;
  #renderers = new Map<string, DataViewRenderer>();
  constructor(store: IndexStore, objects = new JsonObjectStoreService()) { this.#store = store; this.#objects = objects; this.registerRenderer(defaultTableRenderer); this.registerRenderer(defaultListRenderer); }
  registerRenderer(renderer: DataViewRenderer): Disposable { this.#renderers.set(renderer.type, renderer); return { dispose: () => { this.#renderers.delete(renderer.type); } }; }
  async evaluateFilters(filters: ZbaseFilters): Promise<readonly FileRecord[]> { return this.#recordsMatching(filters); }
  async openBase(path: VaultPath): Promise<void> { await this.#readBase(path); }
  async renderEmbed(container: HTMLElement, path: VaultPath, options: DataViewRenderOptions = {}): Promise<Disposable> { return this.renderEmbedForPlugin(container, path, 'zorid.host' as PluginId, options); }
  async renderEmbedForPlugin(container: HTMLElement, path: VaultPath, callerPluginId: PluginId, options: DataViewRenderOptions = {}): Promise<Disposable> {
    const base = await this.#readBase(path);
    const disposables: Disposable[] = [];
    clearContainer(container);
    for (const view of base.views) {
      const renderer = this.#renderers.get(view.renderer);
      if (!renderer) {
        const errorContainer = appendText(container, 'div', `Missing renderer: ${view.renderer}`);
        errorContainer.dataset = { ...(errorContainer.dataset ?? {}), zoridDataviewError: 'renderer-missing' };
        continue;
      }
      const viewContainer = createChildContainer(container, 'section');
      const records = view.filters ? await this.evaluateFilters(view.filters) : this.#recordsMatching({ expression: null });
      const disposable = await renderer.render(viewContainer, records, { basePath: options.basePath ?? path, callerPluginId });
      disposables.push(disposable);
    }
    return { dispose: async () => { for (const disposable of disposables.slice().reverse()) await disposable.dispose(); clearContainer(container); } };
  }
  async #readBase(path: VaultPath): Promise<ZbaseDocument> { if (!String(path).endsWith('.zbase')) throw new ZoridError('dataviews.invalid-base-path', `Expected .zbase: ${path}`); return this.#objects.readBase(path); }
  #recordsMatching(filters: ZbaseFilters): readonly FileRecord[] { return this.#store.all().filter((record) => matchesFilter(record.fields, filters.expression)).map((record) => ({ path: record.path, fields: Object.entries(record.fields).map(([key,value])=>({ key, value, source: 'frontmatter' as const })) })); }
}

function matchesFilter(fields: Readonly<Record<string, JsonValue>>, expression: JsonValue): boolean {
  if (!expression || typeof expression !== 'object' || Array.isArray(expression)) return true;
  const equals = expression.equals;
  if (Array.isArray(equals) && equals.length === 2 && typeof equals[0] === 'string') return fields[equals[0]] === equals[1];
  return true;
}

export const defaultTableRenderer: DataViewRenderer = { type: 'table', render(container, records) { clearContainer(container); for (const record of records) appendText(container, 'div', String(record.path)); return { dispose: () => { clearContainer(container); } }; } };
export const defaultListRenderer: DataViewRenderer = { type: 'list', render(container, records) { clearContainer(container); for (const record of records) appendText(container, 'li', String(record.path)); return { dispose: () => { clearContainer(container); } }; } };

export function createObjectStoreService(initial?: Record<string, string>): JsonObjectStoreService { return new JsonObjectStoreService(initial); }
export function createFieldsService(store: IndexStore, objects?: JsonObjectStoreService): FieldsService { return new FieldsService(store, objects); }
export function createDataViewsService(store: IndexStore, objects?: JsonObjectStoreService): DataViewsService { return new DataViewsService(store, objects); }
