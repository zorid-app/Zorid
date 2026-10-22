import { parentPath } from './types.ts';
import { readProperties } from './properties.ts';
import type { Backlink, NoteLink, NoteMetadata } from './types.ts';
import type { DocumentParseFacts } from './document-draft-facts.ts';
import type { DocumentMetadataRowsItem } from './document-semantics.ts';
import { isScalar, parseDocument, visit } from 'yaml';

export interface MetadataParseOptions {
  readonly frontmatterLinks?: boolean;
  /** Mutation-local callers can diagnose only an affected unsafe reference. */
  readonly onUnsafeFrontmatterLink?: (target: string) => void;
}

/** Map decoded scalar boundaries back to the original YAML token. Mutations
 * must never treat a decoded string offset as a raw source position. */
function scalarOffsets(raw: string, value: string): readonly number[] | undefined {
  const quote = raw[0], quoted = quote === '"' || quote === "'";
  if (/\r|\n/.test(raw)) return undefined;
  let decoded = '', offset = quoted ? 1 : 0;
  const end = quoted ? raw.length - 1 : raw.length, offsets: number[] = [offset];
  if (quoted && raw[end] !== quote) return undefined;
  const escapes: Readonly<Record<string, string>> = { '0': '\0', a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: '\u2028', P: '\u2029' };
  while (offset < end) {
    const start = offset; let character = raw[offset++];
    if (quote === "'" && character === "'" && raw[offset] === "'") offset++;
    else if (quote === '"' && character === '\\') {
      const code = raw[offset++];
      if (Object.hasOwn(escapes, code)) character = escapes[code];
      else {
        const count = code === 'x' ? 2 : code === 'u' ? 4 : code === 'U' ? 8 : 0;
        if (!count || offset + count > end || !/^[0-9a-f]+$/i.test(raw.slice(offset, offset + count))) return undefined;
        const point = Number.parseInt(raw.slice(offset, offset + count), 16); if (point > 0x10ffff) return undefined;
        character = String.fromCodePoint(point); offset += count;
      }
    }
    decoded += character;
    for (let part = 1; part <= character.length; part++) offsets.push(part === character.length ? offset : start);
  }
  return decoded === value ? offsets : undefined;
}

/** Whole wiki-link property values only. Aliases refer to their original scalar
 * node, so rewriting an anchored definition updates every alias without editing
 * arbitrary prose, comments, mapping keys or YAML alias tokens. */
function frontmatterLinks(source: string, yamlStart: number, yamlEnd: number, onUnsafe?: (target: string) => void): NoteLink[] {
  const yaml = source.slice(yamlStart, yamlEnd), links: NoteLink[] = [];
  const doc = parseDocument(yaml, { version: '1.2', schema: 'core', stringKeys: true, uniqueKeys: true, resolveKnownTags: false, logLevel: 'silent' });
  if (doc.errors.length || doc.warnings.length) return links;
  visit(doc, { Scalar(key, node) {
    if (key === 'key' || !isScalar(node) || typeof node.value !== 'string' || !node.range) return;
    const match = /^(\s*)(!?)\[\[([^\]\r\n]+)\]\]\s*$/.exec(node.value);
    if (!match) return;
    const destination = match[3].split('|')[0], hash = destination.indexOf('#');
    const target = hash < 0 ? destination : destination.slice(0, hash), start = match[1].length + match[2].length + 2;
    const raw = yaml.slice(node.range[0], node.range[1]), offsets = scalarOffsets(raw, node.value);
    if (!offsets) {
      if (onUnsafe) { onUnsafe(target); return; }
      throw new Error('A frontmatter wiki link uses a complex YAML scalar whose source cannot be safely rewritten');
    }
    links.push({ target, fragment: hash < 0 ? '' : destination.slice(hash), kind: 'wiki', embed: !!match[2],
      start: yamlStart + node.range[0] + offsets[start], end: yamlStart + node.range[0] + offsets[start + target.length] });
  } });
  return links;
}

function asStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return typeof value === 'string' ? value.split(',').map(item => item.trim()).filter(Boolean) : [];
}

/** Metadata indexes valid YAML; malformed frontmatter remains untouched in the note. */
export function parseMetadata(path: string, source: string, options: MetadataParseOptions = {}): NoteMetadata {
  const metadata: NoteMetadata = { path, frontmatter: {}, tags: [], aliases: [], headings: [], links: [] };
  const opening = source.match(/^\uFEFF?---[ \t]*(?:#[^\r\n]*)?\r?\n/);
  const rest = opening ? source.slice(opening[0].length) : '';
  const closing = opening ? /^(?:---|\.\.\.)[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/m.exec(rest) : null;
  const frontLength = opening && closing ? opening[0].length + closing.index + closing[0].length : 0;
  if (frontLength) {
    try { metadata.frontmatter = Object.fromEntries(readProperties(source).map(property => [property.key, property.value])); }
    catch { /* Invalid YAML must not prevent opening or saving the Markdown body. */ }
    metadata.aliases = asStrings(metadata.frontmatter.aliases ?? metadata.frontmatter.alias);
    metadata.tags = asStrings(metadata.frontmatter.tags ?? metadata.frontmatter.tag).map(tag => tag.replace(/^#/, ''));
    if (options.frontmatterLinks && closing) metadata.links.push(...frontmatterLinks(source, opening![0].length, opening![0].length + closing.index, options.onUnsafeFrontmatterLink));
  }

  // Keep every character offset stable while excluding code, comments, and YAML.
  const blank = (text: string) => text.replace(/[^\r\n]/g, ' ');
  let visible = source;
  if (frontLength) visible = blank(source.slice(0, frontLength)) + source.slice(frontLength);
  let fence: { marker: string; count: number } | undefined;
  visible = visible.split(/(?<=\n)/).map(line => {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (match && match[1][0] === fence.marker && match[1].length >= fence.count && /^\s*$/.test(line.slice(match[0].length))) fence = undefined;
      return blank(line);
    }
    if (match) { fence = { marker: match[1][0], count: match[1].length }; return blank(line); }
    return line;
  }).join('');
  visible = visible.replace(/<!--[\s\S]*?-->|%%[\s\S]*?%%/g, blank).replace(/(`+)[^\n]*?\1/g, blank);
  visible.split(/\r?\n/).forEach((line, index) => {
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) metadata.headings.push({ heading: heading[2], level: heading[1].length, line: index });
  });
  for (const tag of visible.matchAll(/(?:^|[\s(])#([\p{L}\p{N}_/-]+)/gu)) {
    if (!/^\d+$/.test(tag[1])) metadata.tags.push(tag[1]);
  }
  metadata.tags = [...new Set(metadata.tags)];
  for (const match of visible.matchAll(/(!?)\[\[([^\]\n]+)\]\]/g)) {
    if (match.index! > 0 && visible[match.index! - 1] === '\\') continue;
    const destination = match[2].split('|')[0];
    const hash = destination.indexOf('#');
    const target = hash < 0 ? destination : destination.slice(0, hash);
    const start = match.index! + match[1].length + 2;
    metadata.links.push({ target, fragment: hash < 0 ? '' : destination.slice(hash), start, end: start + target.length, kind: 'wiki', embed: Boolean(match[1]) });
  }
  // Destinations may be <angle wrapped>, contain balanced one-level parentheses, or have a title.
  for (const match of visible.matchAll(/(!?)\[[^\]\n]*\]\(\s*(<[^>\n]*>|(?:[^\s()\\]|\\.|\([^()]*\))+)(?:\s+["'][^\n]*?["'])?\s*\)/g)) {
    if (match.index! > 0 && visible[match.index! - 1] === '\\') continue;
    const wrapped = match[2].startsWith('<');
    const destination = wrapped ? match[2].slice(1, -1) : match[2];
    if (/^[a-z][\w+.-]*:/i.test(destination) || destination.startsWith('//')) continue;
    const hash = destination.indexOf('#');
    const target = hash < 0 ? destination : destination.slice(0, hash);
    const start = match.index! + match[0].indexOf(match[2], match[0].indexOf('](') + 2) + (wrapped ? 1 : 0);
    metadata.links.push({ target, fragment: hash < 0 ? '' : destination.slice(hash), start, end: start + target.length, kind: 'markdown', embed: Boolean(match[1]) });
  }
  metadata.links.sort((a, b) => a.start - b.start);
  return metadata;
}

/** Match the normalized logical names exposed by the vault while preserving native spelling. */
function linkKey(path: string): string { return path.normalize('NFC').toLowerCase(); }
function fileName(path: string): string { return path.slice(path.lastIndexOf('/') + 1); }

export class MetadataCache {
  private notes = new Map<string, NoteMetadata>();

  private readonly accepts: (path: string) => boolean;
  constructor(accepts: (path: string) => boolean = () => true) { this.accepts = accepts; }

  /** Adopt already extracted facts. This path never reads or parses source text. */
  adopt(notes: Iterable<readonly [string, NoteMetadata]>, files: Iterable<string>): void {
    this.notes = new Map(notes);
    this.setFiles(files);
  }
  private files = new Set<string>();
  private names = new Map<string, Set<string>>();

  private addFile(path: string): void {
    if (this.files.has(path)) return;
    this.files.add(path);
    const name = linkKey(fileName(path));
    let files = this.names.get(name);
    if (!files) { files = new Set(); this.names.set(name, files); }
    files.add(path);
  }
  setFiles(paths: Iterable<string>): void {
    this.files.clear(); this.names.clear();
    for (const path of paths) this.addFile(path);
  }
  index(path: string, content: string, options?: MetadataParseOptions): NoteMetadata {
    const note = parseMetadata(path, content, options);
    this.notes.set(path, note);
    this.addFile(path);
    return note;
  }
  /** Parse the whole batch before publishing any updates. Unchanged notes keep their identities. */
  indexBatch(contents: Iterable<readonly [string, string]>): void {
    const notes = [...contents].map(([path, content]) => parseMetadata(path, content));
    for (const note of notes) {
      this.notes.set(note.path, note);
      this.addFile(note.path);
    }
  }
  get(path: string): NoteMetadata | undefined { return this.accepts(path) ? this.notes.get(path) : undefined; }
  *entries(): IterableIterator<[string, NoteMetadata]> {
    for (const item of this.notes) if (this.accepts(item[0])) yield item;
  }
  remove(path: string): void {
    this.notes.delete(path); this.files.delete(path);
    const name = linkKey(fileName(path)), files = this.names.get(name);
    files?.delete(path);
    if (!files?.size) this.names.delete(name);
  }
  clear(): void { this.notes.clear(); this.files.clear(); this.names.clear(); }

  resolveLink(source: string, rawTarget: string, kind: NoteLink['kind'] = 'wiki'): string | null {
    return this.resolveLinkCandidates(source, rawTarget, kind)[0] ?? null;
  }

  /** Ordered internal destinations; generators require one result for a shortest link.
   * Both Markdown and wiki destinations share the same vault lookup policy.
   * See docs/file-operations-reference.md for the inspected priority and boundaries.
   */
  resolveLinkCandidates(source: string, rawTarget: string, _kind: NoteLink['kind'] = 'wiki'): string[] {
    let target = rawTarget.split('#')[0].trim();
    try { target = decodeURIComponent(target); } catch { /* A literal percent is a valid filename. */ }
    if (!target) return this.files.has(source) ? [source] : [];
    if (/^[a-z][\w+.-]*:/i.test(target) || target.startsWith('//')) return [];
    target = linkKey(target);
    const rooted = target.startsWith('/');
    let candidates = fileName(target).includes('.') ? this.names.get(fileName(target)) : undefined;
    if (!candidates?.size) {
      target += '.md';
      candidates = this.names.get(fileName(target));
    }
    if (!candidates?.size) return [];
    const matches = [...candidates];
    if (!target.includes('/') && matches.length === 1) return matches;
    const findExact = (path: string): string | undefined => matches.find(candidate => linkKey(candidate) === path);
    let directory = linkKey(parentPath(source));
    if (target.startsWith('./') || target.startsWith('../')) {
      if (target.startsWith('./../')) target = target.slice(2);
      if (target.startsWith('./')) target = target.slice(2);
      else while (target.startsWith('../')) {
        target = target.slice(3);
        directory = parentPath(directory);
      }
      target = directory ? `${directory}/${target}` : target;
      const relative = findExact(target);
      if (relative) return [relative];
    }
    if (target.startsWith('/')) target = target.slice(1);
    const direct = findExact(target);
    if (direct) return [direct];
    if (rooted) return [];
    const local: string[] = [], other: string[] = [];
    for (const candidate of matches) {
      const path = linkKey(candidate);
      if (path.endsWith(target)) (path.startsWith(directory) ? local : other).push(candidate);
    }
    // Stable sort preserves index order for equal lengths; it does not reject ties.
    const shortest = (a: string, b: string): number => a.length - b.length;
    return [...local.sort(shortest), ...other.sort(shortest)];
  }

  backlinks(target: string): Backlink[] {
    const result: Backlink[] = [];
    for (const [source, note] of this.entries()) for (const link of note.links) {
      if (this.resolveLink(source, link.target, link.kind) === target) result.push({ source, link });
    }
    return result;
  }
}

/** Compatibility display projection of the full admitted Rust DTO. Source-range
 * rewriting does not use this projection; rename builds a fresh local context. */
export function admittedNote(item: DocumentMetadataRowsItem): NoteMetadata | undefined {
  if (item.kind !== 'file' || !item.value.metadata) return undefined;
  return noteFromFacts(item.value.entry.path,item.value.metadata);
}

/** Display-only view of exact-source facts; never a committed witness. */
export function noteFromFacts(path:string,facts:DocumentParseFacts):NoteMetadata {
  const note: NoteMetadata = {
    path,
    frontmatter: Object.fromEntries(facts.properties.map(property => [property.key, property.value])),
    tags: [...facts.tags], aliases: [...facts.aliases],
    headings: facts.headings.map(heading => Object.freeze({heading: heading.text, level: heading.level, line: heading.line})),
    links: facts.links.map(link => Object.freeze({target: link.target, fragment: link.fragment, kind: link.kind, embed: link.embed, start: link.targetRange.utf16[0], end: link.targetRange.utf16[1]})),
  };
  Object.freeze(note.frontmatter);Object.freeze(note.tags);Object.freeze(note.aliases);Object.freeze(note.headings);Object.freeze(note.links);
  return Object.freeze(note);
}

export type ReadonlyMetadataCache = Pick<MetadataCache, 'get' | 'entries' | 'resolveLink' | 'resolveLinkCandidates' | 'backlinks'>;
/** Do not expose the mutable cache behind a committed frame. */
export function readonlyMetadata(cache: MetadataCache): ReadonlyMetadataCache {
  return Object.freeze({get: cache.get.bind(cache), entries: cache.entries.bind(cache), resolveLink: cache.resolveLink.bind(cache), resolveLinkCandidates: cache.resolveLinkCandidates.bind(cache), backlinks: cache.backlinks.bind(cache)});
}
