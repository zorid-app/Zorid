import { isMap, isScalar, parseDocument } from 'yaml';
import { readProperties, PropertiesError } from '../core/properties.ts';

interface Region { prefix: string; yaml: string; suffix: string; body: string; bom: string; newline: string }
function frontmatter(source: string): Region | null {
  // Reuse the core validation boundary before touching any YAML nodes.
  readProperties(source);
  const opening = /^\uFEFF?---[ \t]*(?:#[^\r\n]*)?\r?\n/.exec(source);
  if (!opening) return null;
  const rest = source.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/m.exec(rest)!;
  return {
    prefix: opening[0], yaml: rest.slice(0, closing.index), suffix: rest.slice(closing.index),
    body: rest.slice(closing.index + closing[0].length), bom: source.startsWith('\uFEFF') ? '\uFEFF' : '',
    newline: opening[0].endsWith('\r\n') ? '\r\n' : '\n',
  };
}

/** Reorder existing YAML nodes, retaining comments/styles and every Markdown body byte. */
export function sortProperties(source: string, descending = false): string {
  const region = frontmatter(source);
  if (!region) return source;
  const doc = parseDocument(region.yaml, { version: '1.2', schema: 'core', stringKeys: true, uniqueKeys: true, resolveKnownTags: false, logLevel: 'silent' });
  if (!isMap(doc.contents) || doc.contents.items.length < 2) return source;
  const previous = [...doc.contents.items];
  const compare = new Intl.Collator(undefined, { usage: 'sort', sensitivity: 'base', numeric: true }).compare;
  doc.contents.items.sort((a, b) => {
    if (!isScalar(a.key) || !isScalar(b.key)) throw new PropertiesError('Property names must be scalar strings');
    return compare(String(a.key.value), String(b.key.value)) * (descending ? -1 : 1);
  });
  if (doc.contents.items.every((item, index) => item === previous[index])) return source;
  const yaml = doc.toString({ directives: false, lineWidth: 0 }).replace(/\r?\n/g, region.newline);
  const next = region.prefix + yaml + region.suffix;
  // Sorting can move an alias before its anchor. Refuse an invalid result rather
  // than flattening aliases or discarding their relationship to make sorting work.
  readProperties(next);
  return next;
}

/** Clearing all properties removes the frontmatter block, retaining BOM and body. */
export function clearProperties(source: string): string {
  const region = frontmatter(source);
  return region ? region.bom + region.body : source;
}
