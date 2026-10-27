import {
  ArrowUpDown, ArrowUpNarrowWide, BookOpen, Bookmark, Binary, Calendar, Check, ChevronDown,
  ChevronLeft, ChevronRight, ChevronsDownUp, ChevronsUpDown, CircleHelp,
  CodeXml, Columns2, Columns3, Copy, Ellipsis, EllipsisVertical, Eye, EyeOff, File, FileDown, FileQuestion, FileSearch, Filter, FolderClosed, FolderPlus, GalleryVertical,
  GitFork, Group, GripHorizontal, GripVertical, House, Info, LayoutDashboard, LayoutGrid, Link, List, ListFilter, Maximize, Minus, PanelLeft, PanelRight, PanelTop, StretchHorizontal,
  Pin, PinOff, Plus, Redo2, RotateCcw, RotateCw, Search, Settings, SlidersHorizontal, SquareCheck, SquareFunction, SquarePen, StickyNote, Table, Tag, Terminal, Text, TextAlignStart, Trash2, Undo2, X, ZoomIn,
} from 'lucide';
import type { IconNode } from 'lucide';

// Explicit imports retain only the icons the UI uses. Legacy names stay stable
// for existing buttons; canonical aliases let chrome use the intended glyph.
const glyphs: Record<string, IconNode> = {
  file: File, folder: FolderClosed, search: Search, plus: Plus, close: X,
  'sliders-horizontal': SlidersHorizontal,
  left: ChevronLeft, right: ChevronRight, down: ChevronDown,
  sidebar: PanelLeft, rightbar: PanelRight, book: BookOpen, edit: SquarePen,
  code: CodeXml, copy: Copy, settings: Settings, graph: GitFork, calendar: Calendar,
  terminal: Terminal, link: Link, list: List, tag: Tag, bookmark: Bookmark,
  'stretch-horizontal': StretchHorizontal, eye: Eye, 'eye-off': EyeOff,
  filter: Filter, group: Group, 'columns-3': Columns3, 'arrow-up-down': ArrowUpDown,
  more: Ellipsis, sort: ArrowUpNarrowWide, collapse: ChevronsDownUp,
  trash: Trash2, split: Columns2, help: CircleHelp, check: Check,
  home: House, 'file-search': FileSearch, 'square-pen': SquarePen,
  'folder-plus': FolderPlus, 'arrow-up-narrow-wide': ArrowUpNarrowWide,
  'panel-top': PanelTop, 'gallery-vertical': GalleryVertical,
  'chevrons-up-down': ChevronsUpDown, 'chevrons-down-up': ChevronsDownUp,
  'sticky-note': StickyNote, minus: Minus, 'rotate-cw': RotateCw,
  'grip-horizontal': GripHorizontal, 'grip-vertical': GripVertical,
  info: Info, binary: Binary, 'square-check': SquareCheck, 'square-function': SquareFunction, text: Text,
  'file-down': FileDown, 'rotate-ccw': RotateCcw,
  table: Table, 'layout-grid': LayoutGrid, 'list-filter': ListFilter, 'text-align-start': TextAlignStart,
  'ellipsis-vertical': EllipsisVertical, 'chevron-right': ChevronRight, 'chevron-left': ChevronLeft, 'file-question': FileQuestion,
  maximize: Maximize, 'undo-2': Undo2, 'redo-2': Redo2, dashboard: LayoutDashboard, 'zoom-in': ZoomIn,
  pin: Pin, 'pin-off': PinOff,
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
