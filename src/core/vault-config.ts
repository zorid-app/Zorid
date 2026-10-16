import type { VaultAdapter } from './types.ts';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type VaultConfigFile = 'app' | 'appearance';
export interface AppPreferences {
  useTab: boolean; tabSize: number; smartIndentList: boolean;
  attachmentFolderPath: string; useMarkdownLinks: boolean; newLinkFormat: 'shortest' | 'relative' | 'absolute';
  newFileLocation: 'root' | 'current' | 'folder'; newFileFolderPath: string;
  alwaysUpdateLinks: boolean; promptDelete: boolean; trashOption: 'system' | 'local' | 'none';
  deleteUnlinkedAttachments: 'ask' | 'always' | 'never';
  readableLineLength: boolean; showInlineTitle: boolean; spellcheck: boolean;
  strictLineBreaks: boolean; livePreview: boolean; defaultViewMode: 'source' | 'preview';
}
export interface AppearancePreferences {
  theme: 'system' | 'obsidian' | 'moonstone'; cssTheme: string; accentColor: string;
  textFontFamily: string; interfaceFontFamily: string; monospaceFontFamily: string;
  enabledCssSnippets: string[]; translucency: boolean;
}
export interface ConfigPreferences { app: AppPreferences; appearance: AppearancePreferences }
export type ConfigPatch<K extends VaultConfigFile> = Partial<ConfigPreferences[K]> & Record<string, JsonValue | undefined>;
export interface ConfigSnapshot<K extends VaultConfigFile> {
  file: K; path: string;
  /** Exact on-disk text; null means a positively identified missing file. */
  content: string | null;
  /** Parsed values are for inspection. Unknown member text is retained separately when patching. */
  data: Record<string, JsonValue>;
  preferences: ConfigPreferences[K];
  /** Invalid known values remain in data/on disk; the typed projection uses their defaults. */
  issues: { key: string; message: string }[];
}
export interface ConfigAdapter extends VaultAdapter {
  /** Optional atomic compare-and-write. null expects no file; false must leave it unchanged.
   * Implementations must enforce their normal vault boundary and preserve errors.
   */
  writeIfUnchanged?(path: string, content: string, expectedContent: string | null): Promise<boolean>;
}
export class VaultConfigError extends Error {
  readonly path: string;
  readonly code: 'invalid-json' | 'invalid-value' | 'conflict' | 'not-file';
  constructor(message: string, path: string, code: VaultConfigError['code'], options?: ErrorOptions) {
    super(message, options); this.name = 'VaultConfigError'; this.path = path; this.code = code;
  }
}

export const APP_PREFERENCE_DEFAULTS: Readonly<AppPreferences> = Object.freeze({
  useTab: true, tabSize: 4, smartIndentList: true, attachmentFolderPath: '/', useMarkdownLinks: false,
  newLinkFormat: 'shortest', newFileLocation: 'root', newFileFolderPath: '/', alwaysUpdateLinks: false,
  promptDelete: true, trashOption: 'system', deleteUnlinkedAttachments: 'ask', readableLineLength: true,
  showInlineTitle: true, spellcheck: true, strictLineBreaks: false, livePreview: true, defaultViewMode: 'source',
});
const appearanceDefaults: AppearancePreferences = {
  theme: 'system', cssTheme: '', accentColor: '', textFontFamily: '', interfaceFontFamily: '', monospaceFontFamily: '',
  enabledCssSnippets: [], translucency: false,
};

type Validator = (value: unknown) => boolean;
const boolean: Validator = value => typeof value === 'boolean';
const string: Validator = value => typeof value === 'string';
const oneOf = (...values: string[]): Validator => value => typeof value === 'string' && values.includes(value);
const folder: Validator = value => typeof value === 'string' && !/[\u0000-\u001f\\:]/.test(value)
  && (value === '/' || (!value.startsWith('/') && !value.split('/').includes('..')));
const schemas: Record<VaultConfigFile, Record<string, Validator>> = {
  app: {
    useTab: boolean, tabSize: value => Number.isSafeInteger(value) && Number(value) > 0, smartIndentList: boolean,
    attachmentFolderPath: folder, useMarkdownLinks: boolean, newLinkFormat: oneOf('shortest', 'relative', 'absolute'),
    newFileLocation: oneOf('root', 'current', 'folder'), newFileFolderPath: folder,
    alwaysUpdateLinks: boolean, promptDelete: boolean, trashOption: oneOf('system', 'local', 'none'),
    deleteUnlinkedAttachments: oneOf('ask', 'always', 'never'), readableLineLength: boolean,
    showInlineTitle: boolean, spellcheck: boolean, strictLineBreaks: boolean, livePreview: boolean,
    defaultViewMode: oneOf('source', 'preview'),
  },
  appearance: {
    theme: oneOf('system', 'obsidian', 'moonstone'), cssTheme: string, accentColor: string,
    textFontFamily: string, interfaceFontFamily: string, monospaceFontFamily: string,
    enabledCssSnippets: value => Array.isArray(value) && value.every(item => typeof item === 'string'), translucency: boolean,
  },
};

/** One hidden directory name, never a nested/absolute path or the traversal segments. */
export function normalizeConfigDir(value = '.obsidian'): string {
  if (typeof value !== 'string' || !value.startsWith('.') || value === '.' || value === '..'
    || /[\u0000-\u001f\u007f\\/:*?"<>|]/.test(value) || /[. ]$/.test(value)) {
    throw new Error('Config directory must be one hidden vault-relative directory name');
  }
  return value.normalize('NFC');
}

interface Member { key: string; start: number; valueStart: number; end: number }
interface Document { content: string | null; data: Record<string, JsonValue>; members: Member[] }
function parse(content: string | null, path: string): Document {
  if (content === null) return { content, data: {}, members: [] };
  try {
    const data: unknown = JSON.parse(content);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a JSON object');
    // JSON.parse validates syntax. This scanner records only top-level member spans,
    // preserving unknown numeric/string spelling instead of serializing parsed values.
    const members: Member[] = [], seen = new Set<string>();
    const skipSpace = (index: number): number => { while (/\s/.test(content[index] ?? '') && index < content.length) index++; return index; };
    const endString = (index: number): number => {
      for (index++; index < content.length; index++) {
        if (content[index] === '\\') index++;
        else if (content[index] === '"') return index + 1;
      }
      throw new Error('Unterminated JSON string');
    };
    let cursor = skipSpace(content.indexOf('{') + 1);
    while (content[cursor] !== '}') {
      const start = cursor, keyEnd = endString(cursor), key: string = JSON.parse(content.slice(cursor, keyEnd));
      if (seen.has(key)) throw new Error(`Duplicate setting: ${key}`);
      seen.add(key);
      cursor = skipSpace(skipSpace(keyEnd) + 1);
      const valueStart = cursor;
      let depth = 0;
      while (cursor < content.length) {
        const character = content[cursor];
        if (character === '"') { cursor = endString(cursor); continue; }
        if (character === '[' || character === '{') depth++;
        else if (character === ']' || character === '}') { if (!depth) break; depth--; }
        else if (character === ',' && !depth) break;
        cursor++;
      }
      let end = cursor;
      while (/\s/.test(content[end - 1] ?? '')) end--;
      members.push({ key, start, valueStart, end });
      if (content[cursor] === '}') break;
      cursor = skipSpace(cursor + 1);
    }
    return { content, data: data as Record<string, JsonValue>, members };
  } catch (cause) {
    throw new VaultConfigError(`Cannot edit invalid config JSON: ${path}`, path, 'invalid-json', { cause });
  }
}

/** Ignore whitespace outside strings without rounding JSON numbers. */
function comparable(text: string): string {
  return text.replace(/"(?:\\.|[^"\\])*"|\s+/g, match => match.startsWith('"') ? match : '');
}
function valueText(document: Document, key: string): string | undefined {
  const member = document.members.find(member => member.key === key);
  return member ? comparable(document.content!.slice(member.valueStart, member.end)) : undefined;
}
/** Read JSON-shaped data without invoking property accessors, iterators or toJSON.
 * Return new containers so validation and serialization consume the same snapshot.
 */
function ownData(value: object, array = false): Record<string, PropertyDescriptor> {
  if (Object.getOwnPropertySymbols(value).length) throw new Error('Settings cannot contain symbol keys');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!Object.hasOwn(descriptor, 'value') || (!descriptor.enumerable && !(array && key === 'length'))) {
      throw new Error('Settings must contain enumerable data properties');
    }
  }
  return descriptors;
}
function jsonSnapshot(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (!value || typeof value !== 'object' || ancestors.has(value)) throw new Error('Settings must contain finite JSON values');
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Settings must contain plain JSON objects');
  const descriptors = ownData(value, array);
  ancestors.add(value);
  let result: JsonValue;
  if (array) {
    const length: number = descriptors.length.value;
    if (Object.keys(descriptors).length !== length + 1) throw new Error('Settings arrays must have only contiguous indexed elements');
    const copy: JsonValue[] = [];
    for (let index = 0; index < length; index++) {
      if (!Object.hasOwn(descriptors, index)) throw new Error('Settings arrays cannot contain holes or extra properties');
      copy.push(jsonSnapshot(descriptors[index].value, ancestors));
    }
    result = copy;
  } else {
    const copy: { [key: string]: JsonValue } = Object.create(null);
    for (const [key, descriptor] of Object.entries(descriptors)) copy[key] = jsonSnapshot(descriptor.value, ancestors);
    result = copy;
  }
  ancestors.delete(value);
  return result;
}

function render(document: Document, changes: Map<string, string | undefined>): string | null {
  const effective = new Map([...changes].filter(([key, value]) => valueText(document, key) !== (value === undefined ? undefined : comparable(value))));
  if (!effective.size) return document.content;
  const source = document.content ?? '{}', members = document.members;
  const fragments: string[] = [];
  for (const member of members) {
    if (!effective.has(member.key)) fragments.push(source.slice(member.start, member.end));
    else {
      const replacement = effective.get(member.key);
      if (replacement !== undefined) fragments.push(source.slice(member.start, member.valueStart) + replacement);
      effective.delete(member.key);
    }
  }
  for (const [key, value] of effective) if (value !== undefined) fragments.push(`${JSON.stringify(key)}: ${value}`);
  if (!members.length) return fragments.length ? `{\n  ${fragments.join(',\n  ')}\n}\n` : document.content;
  const prefix = source.slice(0, members[0].start), suffix = source.slice(members[members.length - 1].end);
  const lineEnding = source.includes('\r\n') ? '\r\n' : '\n';
  const indent = /(?:\r?\n)([\t ]*)$/.exec(prefix)?.[1] ?? '  ';
  const separator = source.includes('\n') ? `,${lineEnding}${indent}` : ', ';
  return prefix + fragments.join(separator) + suffix;
}

const queues = new WeakMap<VaultAdapter, Promise<unknown>>();
/** Per-file patches preserve unrelated members and merge independent external edits.
 * Shared queues cover this adapter object only. Atomic cross-process protection
 * requires writeIfUnchanged; the ordinary adapter fallback has a final I/O race.
 */
export class VaultConfig {
  readonly configDir: string;
  readonly atomicCompareAndWrite: boolean;
  private readonly adapter: ConfigAdapter;
  constructor(adapter: ConfigAdapter, options: { configDir?: string } = {}) {
    this.adapter = adapter; this.configDir = normalizeConfigDir(options.configDir);
    this.atomicCompareAndWrite = typeof adapter.writeIfUnchanged === 'function';
  }
  private path(file: VaultConfigFile): string {
    if (file !== 'app' && file !== 'appearance') throw new Error('Unsupported vault config file');
    return `${this.configDir}/${file}.json`;
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = (queues.get(this.adapter) ?? Promise.resolve()).then(operation);
    queues.set(this.adapter, result.catch(() => undefined));
    return result;
  }
  private async content(path: string): Promise<string | null> {
    if (this.adapter.stat) {
      const entry = await this.adapter.stat(path);
      if (!entry) return null;
      if (entry.type !== 'file') throw new VaultConfigError(`Config path is not a file: ${path}`, path, 'not-file');
    }
    try { return await this.adapter.read(path); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }
  private snapshot<K extends VaultConfigFile>(file: K, document: Document): ConfigSnapshot<K> {
    const preferences = JSON.parse(JSON.stringify(file === 'app' ? APP_PREFERENCE_DEFAULTS : appearanceDefaults));
    const issues: ConfigSnapshot<K>['issues'] = [];
    for (const key of Object.keys(schemas[file])) if (Object.hasOwn(document.data, key)) {
      if (schemas[file][key](document.data[key])) preferences[key] = document.data[key];
      else issues.push({ key, message: `Invalid ${file} preference: ${key}` });
    }
    return { file, path: this.path(file), content: document.content, data: document.data, preferences, issues };
  }
  read<K extends VaultConfigFile>(file: K): Promise<ConfigSnapshot<K>> {
    const path = this.path(file);
    return this.enqueue(async () => this.snapshot(file, parse(await this.content(path), path)));
  }
  private async ensureDirectory(): Promise<void> {
    if (this.adapter.stat) {
      const entry = await this.adapter.stat(this.configDir);
      if (entry?.type === 'folder') return;
      if (entry) throw new VaultConfigError('Config directory path is a file', this.configDir, 'not-file');
    }
    try { await this.adapter.mkdir(this.configDir); }
    catch (error) {
      if (this.adapter.stat && (await this.adapter.stat(this.configDir))?.type === 'folder') return;
      // Without stat, only an explicit already-exists error is recognized.
      if (!this.adapter.stat && error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') return;
      throw error;
    }
  }
  /** undefined deletes a key. expectedContent is an earlier snapshot, not permission
   * to replace it wholesale: conflicting edits to a requested key reject the patch.
   */
  patch<K extends VaultConfigFile>(file: K, values: ConfigPatch<K>, options: { expectedContent?: string | null } = {}): Promise<ConfigSnapshot<K>> {
    const path = this.path(file), changes = new Map<string, string | undefined>();
    if (!values || typeof values !== 'object' || Array.isArray(values)
      || (Object.getPrototypeOf(values) !== Object.prototype && Object.getPrototypeOf(values) !== null)
      || Object.getOwnPropertySymbols(values).length) throw new VaultConfigError('Expected a settings patch object', path, 'invalid-value');
    let descriptors: Record<string, PropertyDescriptor>;
    try { descriptors = ownData(values); }
    catch (cause) { throw new VaultConfigError('Expected inert settings patch data', path, 'invalid-value', { cause }); }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      try {
        const value = descriptor.value === undefined ? undefined : jsonSnapshot(descriptor.value);
        if (value !== undefined && Object.hasOwn(schemas[file], key) && !schemas[file][key](value)) throw new Error(`Invalid preference: ${key}`);
        changes.set(key, value === undefined ? undefined : JSON.stringify(value));
      } catch (cause) { throw new VaultConfigError(`Invalid config value: ${key}`, path, 'invalid-value', { cause }); }
    }
    const expected = options.expectedContent;
    if (expected !== undefined && expected !== null && typeof expected !== 'string') throw new VaultConfigError('Expected config content must be text or null', path, 'invalid-value');
    return this.enqueue(async () => {
      let current = parse(await this.content(path), path);
      const base = expected === undefined ? current : parse(expected, path);
      for (let attempt = 0; attempt < 4; attempt++) {
        for (const [key, replacement] of changes) {
          const value = valueText(current, key), desired = replacement === undefined ? undefined : comparable(replacement);
          if (value !== valueText(base, key) && value !== desired) throw new VaultConfigError(`Config changed outside this editor: ${key}`, path, 'conflict');
        }
        const next = render(current, changes);
        if (next === current.content) return this.snapshot(file, current);
        await this.ensureDirectory();
        if (this.adapter.writeIfUnchanged) {
          if (await this.adapter.writeIfUnchanged(path, next!, current.content)) return this.snapshot(file, parse(next, path));
        } else {
          const checked = await this.content(path);
          if (checked === current.content) {
            await this.adapter.write(path, next!);
            // Report the actual file after I/O. Do not retry/overwrite if another
            // writer changes it after our write, or claim a write silently failed.
            const observed = await this.content(path);
            if (observed !== next) throw new VaultConfigError('Config changed while saving', path, 'conflict');
            return this.snapshot(file, parse(observed, path));
          }
        }
        current = parse(await this.content(path), path);
      }
      throw new VaultConfigError('Config kept changing while saving', path, 'conflict');
    });
  }
}
