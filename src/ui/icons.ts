import {
  ArrowUpNarrowWide, BookOpen, Bookmark, Calendar, Check, ChevronDown,
  ChevronLeft, ChevronRight, ChevronsDownUp, ChevronsUpDown, CircleHelp,
  CodeXml, Columns2, Ellipsis, File, FileSearch, FolderClosed, FolderPlus, GalleryVertical,
  GitFork, House, Link, List, Maximize, Minus, PanelLeft, PanelRight, PanelTop,
  Plus, Redo2, RotateCw, Search, Settings, SquarePen, StickyNote, Tag, Terminal, Trash2, Undo2, X,
} from 'lucide';
import type { IconNode } from 'lucide';

// Explicit imports retain only the icons the UI uses. Legacy names stay stable
// for existing buttons; canonical aliases let chrome use the intended glyph.
const glyphs: Record<string, IconNode> = {
  file: File, folder: FolderClosed, search: Search, plus: Plus, close: X,
  left: ChevronLeft, right: ChevronRight, down: ChevronDown,
  sidebar: PanelLeft, rightbar: PanelRight, book: BookOpen, edit: SquarePen,
  code: CodeXml, settings: Settings, graph: GitFork, calendar: Calendar,
  terminal: Terminal, link: Link, list: List, tag: Tag, bookmark: Bookmark,
  more: Ellipsis, sort: ArrowUpNarrowWide, collapse: ChevronsDownUp,
  trash: Trash2, split: Columns2, help: CircleHelp, check: Check,
  home: House, 'file-search': FileSearch, 'square-pen': SquarePen,
  'folder-plus': FolderPlus, 'arrow-up-narrow-wide': ArrowUpNarrowWide,
  'panel-top': PanelTop, 'gallery-vertical': GalleryVertical,
  'chevrons-up-down': ChevronsUpDown, 'chevrons-down-up': ChevronsDownUp,
  'sticky-note': StickyNote, minus: Minus, 'rotate-cw': RotateCw,
  maximize: Maximize, 'undo-2': Undo2, 'redo-2': Redo2,
};

/** Fresh, decorative SVG; the containing button supplies the accessible name. */
export function icon(name: string, size = 18, ownerDocument: Document = document): SVGSVGElement {
  const glyph = Object.hasOwn(glyphs, name) ? glyphs[name] : File;
  const svg = ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    width: String(size), height: String(size),
    'stroke-width': size >= 18 ? '1.75' : '2',
    class: 'svg-icon lucide', 'aria-hidden': 'true', focusable: 'false',
  })) svg.setAttribute(key, value);
  for (const [tag, attributes] of glyph) {
    const child = ownerDocument.createElementNS(svg.namespaceURI, tag);
    for (const [key, value] of Object.entries(attributes)) if (value !== undefined) child.setAttribute(key, String(value));
    svg.append(child);
  }
  return svg;
}
