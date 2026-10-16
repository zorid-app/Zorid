import { isMarkdown, normalizePath, parentPath } from './types.ts';
import type { VaultEntry } from './types.ts';
import type { Vault } from './vault.ts';

export interface AttachmentImportFile {
  name: string;
  type?: string;
  /** Presence preserves native filenames; resolving native paths is a platform responsibility. */
  nativePath?: string;
  existingVaultPath?: string;
  read(): Promise<Uint8Array>;
}
export interface AttachmentImportSettings {
  attachmentFolderPath: string;
  useMarkdownLinks: boolean;
  newLinkFormat: 'shortest' | 'relative' | 'absolute';
}
export interface ImportedAttachment { path: string; embed: string }
/** A callback reads the active file when attachment bytes become available. */
export type AttachmentActivePath = string | null | (() => string | null);
export const DEFAULT_ATTACHMENT_IMPORT_SETTINGS: Readonly<AttachmentImportSettings> = Object.freeze({
  attachmentFolderPath: '/', useMarkdownLinks: false, newLinkFormat: 'shortest',
});

function settingsWithDefaults(settings: Partial<AttachmentImportSettings>): AttachmentImportSettings {
  const value = { ...DEFAULT_ATTACHMENT_IMPORT_SETTINGS, ...settings };
  if (!['shortest', 'relative', 'absolute'].includes(value.newLinkFormat)) throw new Error('Unsupported attachment link format');
  if (typeof value.attachmentFolderPath !== 'string' || typeof value.useMarkdownLinks !== 'boolean') throw new Error('Invalid attachment import settings');
  return value;
}

/**
 * Original bounded sanitizer, not a claim of the reference's exact shared helper:
 * replace controls/link/portable filename punctuation, collapse whitespace, and
 * reject empty/dot-only names. No path or native filesystem access is performed.
 */
export function sanitizeAttachmentName(name: string): string {
  const result = name.replace(/[\u0000-\u001f\u007f\\/:*?"<>|#^\[\]]/g, ' ').replace(/%%/g, ' ').replace(/\s+/g, ' ').trim();
  return !result || /^\.+$/.test(result) ? 'attachment' : result;
}

function localTimestamp(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid attachment timestamp');
  const two = (number: number) => String(number).padStart(2, '0');
  return String(date.getFullYear()).padStart(4, '0') + two(date.getMonth() + 1) + two(date.getDate())
    + two(date.getHours()) + two(date.getMinutes()) + two(date.getSeconds());
}

function fileName(file: AttachmentImportFile, now: () => Date): { stem: string; extension: string } {
  const mime = file.type?.split(';')[0].trim().toLowerCase();
  let name = file.name;
  if (!file.nativePath && (mime === 'image/png' || mime === 'image/jpeg')) name = `Pasted image.${mime === 'image/png' ? 'png' : 'jpg'}`;
  name = sanitizeAttachmentName(name);
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && dot < name.length - 1 ? name.slice(dot) : '';
  let stem = extension ? name.slice(0, dot) : name;
  if (stem === 'Pasted image') stem += ` ${localTimestamp(now())}`;
  // UTF-16 string units, matching the observed allocator's basename bound.
  stem = stem.slice(0, 250);
  // Avoid emitting an unmatched surrogate when truncating an astral filename.
  if (/[\uD800-\uDBFF]$/.test(stem)) stem = stem.slice(0, -1);
  return { stem, extension };
}

function relativeTarget(owner: string, path: string): string {
  const from = parentPath(owner).split('/').filter(Boolean), to = path.split('/');
  while (from.length && to.length && from[0] === to[0]) { from.shift(); to.shift(); }
  const target = [...from.map(() => '..'), ...to].join('/');
  // Explicitly mark paths within the owner's folder as relative. Bare wiki
  // targets prefer the vault root, which can otherwise select a different file.
  return from.length ? target : `./${target}`;
}

/** Import links always embed, including Markdown and unregistered file types. */
export function attachmentEmbed(vault: Vault, rawPath: string, ownerPath: string, settings: Partial<AttachmentImportSettings> = {}): string {
  const path = normalizePath(rawPath), owner = ownerPath ? normalizePath(ownerPath) : '';
  const options = settingsWithDefaults(settings), filename = path.slice(path.lastIndexOf('/') + 1);
  let target = options.newLinkFormat === 'relative' ? relativeTarget(owner, path) : path;
  if (options.newLinkFormat === 'shortest') {
    const candidates = vault.metadata.resolveLinkCandidates(owner, filename);
    if (candidates.length === 1 && candidates[0] === path) target = filename;
  }
  if (!options.useMarkdownLinks) return `![[${target.replace(/\.md$/i, '')}]]`;
  // Original conservative destination escaping: retain Unicode and path slashes,
  // escape characters that can change Markdown parsing or URI interpretation.
  const encoded = target.replace(/[\u0000-\u0020\u007f\\()%#<>]/g, character => encodeURIComponent(character).replace(/[()]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`));
  const label = isMarkdown(path) ? filename.replace(/\.md$/i, '').replace(/[\\\[\]]/g, '\\$&') : '';
  return `![${label}](${encoded})`;
}

function destinationFolder(activePath: string | null, setting: string): string {
  const parent = activePath ? parentPath(normalizePath(activePath)) : '';
  if (setting === '/' || !setting) return '';
  if (setting === '.' || setting === './') return parent;
  const path = setting.startsWith('./') ? [parent, setting.slice(2)].filter(Boolean).join('/') : setting;
  return normalizePath(path);
}

// Sharing the queue by Vault prevents two importer instances allocating one name.
// It does not claim a cross-process reservation against external filesystem writes.
const queues = new WeakMap<Vault, Promise<unknown>>();

export class AttachmentImporter {
  private readonly vault: Vault;
  private readonly now: () => Date;
  constructor(vault: Vault, options: { now?: () => Date } = {}) { this.vault = vault; this.now = options.now ?? (() => new Date()); }

  import(file: AttachmentImportFile, ownerPath: string, activePath: AttachmentActivePath, settings: Partial<AttachmentImportSettings> = {}): Promise<ImportedAttachment> {
    const options = { ...settings }, input = { ...file, read: file.read.bind(file) };
    const result = (queues.get(this.vault) ?? Promise.resolve()).then(() => this.perform(input, ownerPath, activePath, options));
    queues.set(this.vault, result.catch(() => undefined));
    return result;
  }

  private async perform(file: AttachmentImportFile, ownerPath: string, activePath: AttachmentActivePath, settings: Partial<AttachmentImportSettings>): Promise<ImportedAttachment> {
    const options = settingsWithDefaults(settings);
    if (ownerPath) normalizePath(ownerPath);
    if (file.existingVaultPath) {
      const path = normalizePath(file.existingVaultPath);
      const entry = this.vault.adapter.stat ? await this.vault.adapter.stat(path) : (await this.vault.adapter.list()).find(entry => entry.path === path);
      if (!entry || entry.type !== 'file') throw new Error(`Existing attachment does not exist: ${path}`);
      if (!this.vault.entries.has(path)) await this.vault.reload([path]);
      return { path, embed: attachmentEmbed(this.vault, path, ownerPath, options) };
    }
    // Validate the configured path before reading, without sampling live focus.
    destinationFolder(null, options.attachmentFolderPath);
    const bytes = new Uint8Array(await file.read());
    const folder = destinationFolder(typeof activePath === 'function' ? activePath() : activePath, options.attachmentFolderPath);
    const name = fileName(file, this.now);
    const inventory = new Map<string, VaultEntry>((await this.vault.adapter.list()).map(entry => [normalizePath(entry.path).toLowerCase(), entry]));
    const actualFolder = await this.ensureFolder(folder, inventory);
    const prefix = actualFolder ? actualFolder + '/' : '';
    let path = prefix + name.stem + name.extension, suffix = 0;
    while (inventory.has(path.toLowerCase())) path = prefix + name.stem + ` ${++suffix}` + name.extension;
    await this.vault.createBinary(path, bytes);
    return { path, embed: attachmentEmbed(this.vault, path, ownerPath, options) };
  }

  private async ensureFolder(folder: string, inventory: Map<string, VaultEntry>): Promise<string> {
    if (!folder) return '';
    const parts = folder.split('/');
    // A conflicting ancestor cannot contain the requested destination either.
    for (let index = 1; index <= parts.length; index++) {
      if (inventory.get(parts.slice(0, index).join('/').toLowerCase())?.type === 'file') return '';
    }
    let actual = '';
    for (const part of parts) {
      const candidate = actual ? `${actual}/${part}` : part;
      const existing = inventory.get(candidate.toLowerCase());
      if (existing) actual = existing.path;
      else {
        const entry = await this.vault.createFolder(candidate);
        inventory.set(candidate.toLowerCase(), entry);
        actual = entry.path;
      }
    }
    return actual;
  }
}
