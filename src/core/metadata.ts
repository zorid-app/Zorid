import { parentPath } from './types.ts';
import { readProperties } from './properties.ts';
import type { Backlink, NoteLink, NoteMetadata } from './types.ts';

function asStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return typeof value === 'string' ? value.split(',').map(item => item.trim()).filter(Boolean) : [];
}

/** Metadata indexes valid YAML; malformed frontmatter remains untouched in the note. */
export function parseMetadata(path: string, source: string): NoteMetadata {
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
  index(path: string, content: string): NoteMetadata {
    const note = parseMetadata(path, content);
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
  get(path: string): NoteMetadata | undefined { return this.notes.get(path); }
  entries(): IterableIterator<[string, NoteMetadata]> { return this.notes.entries(); }
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
    for (const [source, note] of this.notes) for (const link of note.links) {
      if (this.resolveLink(source, link.target, link.kind) === target) result.push({ source, link });
    }
    return result;
  }
}
