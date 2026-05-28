import type { IndexEngine, IndexedFileRecord, IndexFilesInput, IndexFilesOutput } from '@zorid/index-api';
import { type JsonValue, normalizeVaultPath } from '@zorid/shared';

function parseScalar(value: string): JsonValue {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number.parseFloat(trimmed);
  if (trimmed.startsWith('[') && trimmed.endsWith(']'))
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  return trimmed.replace(/^['"]|['"]$/g, '');
}

export function parseFrontmatter(contents: string): { frontmatter: Record<string, JsonValue>; body: string } {
  if (!contents.startsWith('---\n')) return { frontmatter: {}, body: contents };
  const end = contents.indexOf('\n---', 4);
  if (end === -1) return { frontmatter: {}, body: contents };
  const raw = contents.slice(4, end);
  const frontmatter: Record<string, JsonValue> = {};
  let currentMap: string | undefined;
  for (const line of raw.split('\n')) {
    const top = /^(?<key>[A-Za-z0-9_.-]+):\s*(?<value>.*)$/.exec(line);
    if (top?.groups?.key !== undefined && top.groups.value !== undefined && !line.startsWith(' ')) {
      if (top.groups.value === '') {
        currentMap = top.groups.key;
        frontmatter[currentMap] = {};
      } else {
        currentMap = undefined;
        frontmatter[top.groups.key] = parseScalar(top.groups.value);
      }
      continue;
    }
    const nested = /^\s+(?<key>[A-Za-z0-9_.-]+):\s*(?<value>.*)$/.exec(line);
    if (nested?.groups?.key !== undefined && nested.groups.value !== undefined && currentMap) {
      const obj = (
        typeof frontmatter[currentMap] === 'object' &&
        !Array.isArray(frontmatter[currentMap]) &&
        frontmatter[currentMap] !== null
          ? frontmatter[currentMap]
          : {}
      ) as Record<string, JsonValue>;
      obj[nested.groups.key] = parseScalar(nested.groups.value);
      frontmatter[currentMap] = obj;
      if (currentMap === 'zorid' && nested.groups.key === 'type')
        frontmatter['zorid.type'] = parseScalar(nested.groups.value);
    }
  }
  return { frontmatter, body: contents.slice(contents.indexOf('\n', end + 1) + 1) };
}

export class JsIndexEngine implements IndexEngine {
  async indexFiles(input: IndexFilesInput): Promise<IndexFilesOutput> {
    const records: IndexedFileRecord[] = [];
    for (const file of input.files) {
      const { frontmatter, body } = parseFrontmatter(file.contents);
      const headings = [...body.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => m[1] ?? '');
      const links = [...body.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => normalizeVaultPath(m[1] ?? ''));
      const inlineTags = [...body.matchAll(/(^|\s)#([A-Za-z0-9_/-]+)/g)].map((m) => m[2] ?? '').filter(Boolean);
      const fmTags = Array.isArray(frontmatter.tags)
        ? frontmatter.tags.map(String)
        : typeof frontmatter.tags === 'string'
          ? [frontmatter.tags]
          : [];
      records.push({
        path: file.path,
        text: body,
        frontmatter,
        fields: frontmatter,
        headings,
        links,
        tags: [...new Set([...fmTags, ...inlineTags])],
      });
    }
    return { records, diagnostics: [] };
  }
}

export function createJsIndexEngine(): JsIndexEngine {
  return new JsIndexEngine();
}
