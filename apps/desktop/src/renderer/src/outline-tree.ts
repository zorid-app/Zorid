import type { OutlineItemDto } from './types.js';

export interface OutlineTreeItem {
  readonly id: string;
  readonly path: string;
  readonly heading: string;
  readonly level: number;
  readonly ordinal: number;
  readonly from?: number;
  readonly to?: number;
  readonly sectionTo?: number;
  readonly children: readonly OutlineTreeItem[];
}

interface MutableOutlineTreeItem {
  id: string;
  path: string;
  heading: string;
  level: number;
  ordinal: number;
  from?: number;
  to?: number;
  sectionTo?: number;
  children: MutableOutlineTreeItem[];
}

const markdownHeadingPattern = /^(#{1,6})\s+(.+)$/gm;

function outlineId(kind: 'heading' | 'indexed', path: string | undefined, ordinal: number): string {
  return `${kind}:${encodeURIComponent(path ?? '')}:${ordinal}`;
}

function markdownBodyStartOffset(text: string): number {
  if (!text.startsWith('---\n')) return 0;
  const end = text.indexOf('\n---', 4);
  if (end === -1) return 0;
  const nextLine = text.indexOf('\n', end + 1);
  return nextLine === -1 ? text.length : nextLine + 1;
}

function cleanHeadingText(raw: string): string {
  return raw
    .trim()
    .replace(/\s+#+\s*$/, '')
    .trim();
}

function freezeOutlineItem(item: MutableOutlineTreeItem): OutlineTreeItem {
  return { ...item, children: item.children.map(freezeOutlineItem) };
}

export function buildOutlineTree(
  text: string,
  selectedPath: string | undefined,
  indexedOutline: readonly OutlineItemDto[],
): readonly OutlineTreeItem[] {
  const parsed: MutableOutlineTreeItem[] = [];
  const bodyStart = markdownBodyStartOffset(text);
  for (const match of text.matchAll(markdownHeadingPattern)) {
    if (match.index < bodyStart) continue;
    const marker = match[1] ?? '';
    const heading = cleanHeadingText(match[2] ?? '');
    if (!heading) continue;
    parsed.push({
      id: outlineId('heading', selectedPath, parsed.length + 1),
      path: selectedPath ?? '',
      heading,
      level: marker.length,
      ordinal: parsed.length + 1,
      from: match.index,
      to: match.index + match[0].length,
      sectionTo: text.length + 1,
      children: [],
    });
  }

  if (parsed.length === 0) {
    return indexedOutline.map((item) => ({
      id: outlineId('indexed', item.path, item.ordinal),
      path: item.path,
      heading: item.heading,
      level: 1,
      ordinal: item.ordinal,
      children: [],
    }));
  }

  for (let index = 0; index < parsed.length; index += 1) {
    const item = parsed[index];
    if (!item) continue;
    for (let nextIndex = index + 1; nextIndex < parsed.length; nextIndex += 1) {
      const next = parsed[nextIndex];
      if (!next) continue;
      if (next.level <= item.level) {
        item.sectionTo = next.from ?? text.length;
        break;
      }
    }
  }

  const roots: MutableOutlineTreeItem[] = [];
  const stack: MutableOutlineTreeItem[] = [];
  for (const item of parsed) {
    let last = stack.at(-1);
    while (last && last.level >= item.level) {
      stack.pop();
      last = stack.at(-1);
    }
    const parent = stack.at(-1);
    if (parent) parent.children.push(item);
    else roots.push(item);
    stack.push(item);
  }

  return roots.map(freezeOutlineItem);
}

export function findCurrentOutlineId(tree: readonly OutlineTreeItem[], cursorPosition: number): string | undefined {
  let current: OutlineTreeItem | undefined;

  function visit(item: OutlineTreeItem): void {
    if (item.from === undefined || item.sectionTo === undefined) return;
    if (cursorPosition < item.from || cursorPosition >= item.sectionTo) return;
    if (!current || item.level >= current.level) current = item;
    for (const child of item.children) visit(child);
  }

  for (const item of tree) visit(item);
  return current?.id;
}
