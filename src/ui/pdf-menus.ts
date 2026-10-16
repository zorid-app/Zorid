import type { ContextMenuItem } from '../platform/context-menu.ts';

type Action = (isCurrent: () => boolean) => void | Promise<void>;
export interface PdfMenuLifetime { /** Revalidate the document, selection and viewer after the menu closes. */ isCurrent?: () => boolean }
export interface PdfMenuSession {
  items: ContextMenuItem[];
  /** Runs a known enabled action once. False means dismissed, disabled or stale. Errors propagate. */
  run(id: string | null): Promise<boolean>;
  dispose(): void;
}
function session(lifetime: PdfMenuLifetime, groups: { items: ContextMenuItem[]; actions: Map<string, Action> }[]): PdfMenuSession {
  const actions = new Map<string, Action>(), items: ContextMenuItem[] = [];
  for (const group of groups) {
    if (!group.items.length) continue;
    if (items.length) items.push({ type: 'separator' });
    items.push(...group.items);
    for (const [id, action] of group.actions) actions.set(id, action);
  }
  let finished = false, disposed = false;
  const isCurrent = lifetime.isCurrent;
  const current = () => !disposed && (!isCurrent || isCurrent());
  return {
    items,
    async run(id) {
      if (finished || !id) { if (!id) finished = true; return false; }
      const action = actions.get(id);
      if (!action) return false;
      finished = true;
      if (!current()) return false;
      await action(current);
      return true;
    },
    dispose() { disposed = true; finished = true; },
  };
}
function group() {
  const items: ContextMenuItem[] = [], actions = new Map<string, Action>();
  return { items, actions, add(id: string, label: string, action: Action, state: { enabled?: boolean; checked?: boolean } = {}) {
    items.push({ id, label, ...state });
    if (state.enabled !== false) actions.set(id, action);
  } };
}
export interface PdfDisplayState { scale: string; spread: 0 | 1 | 2; adaptToTheme?: boolean }
export interface PdfDisplayCapabilities extends PdfMenuLifetime {
  setScale?: (scale: 'page-width' | 'page-height') => void | Promise<void>;
  setSpread?: (spread: 0 | 1 | 2) => void | Promise<void>;
  setAdaptToTheme?: (enabled: boolean) => void | Promise<void>;
}
export function createPdfDisplayMenu(state: PdfDisplayState, capabilities: PdfDisplayCapabilities): PdfMenuSession {
  const host = { ...capabilities }, zoom = group(), spread = group(), appearance = group();
  if (host.setScale) {
    zoom.add('pdf-fit-width', 'Fit width', () => host.setScale!('page-width'), { checked: state.scale === 'page-width' });
    zoom.add('pdf-fit-height', 'Fit height', () => host.setScale!('page-height'), { checked: state.scale === 'page-height' });
  }
  if (host.setSpread) {
    for (const [value, id, label] of [[0, 'single', 'Single page'], [1, 'odd', 'Two-page (odd)'], [2, 'even', 'Two-page (even)']] as const)
      spread.add(`pdf-spread-${id}`, label, () => host.setSpread!(value), { checked: state.spread === value });
  }
  if (host.setAdaptToTheme && typeof state.adaptToTheme === 'boolean') {
    const enabled = state.adaptToTheme;
    appearance.add('pdf-adapt-theme', 'Adapt to theme', () => host.setAdaptToTheme!(!enabled), { checked: enabled });
  }
  return session(host, [zoom, spread, appearance]);
}
export interface PdfSidebarState { open: boolean; active: 0 | 1 | 2; hasOutline: boolean }
export interface PdfSidebarCapabilities extends PdfMenuLifetime {
  switchSidebar?: (view: 0 | 1 | 2) => void | Promise<void>;
  revealCurrentOutlineItem?: () => void | Promise<void>;
}
export function createPdfSidebarMenu(state: PdfSidebarState, capabilities: PdfSidebarCapabilities): PdfMenuSession {
  const host = { ...capabilities }, view = group(), action = group();
  const thumbnails = state.open && state.active === 1, outline = state.open && state.active === 2;
  if (host.switchSidebar) {
    view.add('pdf-sidebar-thumbnails', 'Thumbnails', () => host.switchSidebar!(thumbnails ? 0 : 1), { checked: thumbnails });
    view.add('pdf-sidebar-outline', 'Table of contents', () => host.switchSidebar!(outline ? 0 : 2), { checked: outline, enabled: state.hasOutline });
    if (host.revealCurrentOutlineItem) action.add('pdf-reveal-outline', 'Reveal page in table of contents', async current => {
      if (!outline) await host.switchSidebar!(2);
      if (current()) await host.revealCurrentOutlineItem!();
    }, { enabled: state.hasOutline });
  }
  return session(host, [view, action]);
}
export interface PdfLinkRequest { page: number; subpath: string; alias: string }
export interface PdfClipboardCapabilities extends PdfMenuLifetime {
  writeClipboard?: (text: string) => void | Promise<void>;
  /** Use the real vault link formatter; no guessed wiki-link settings. Called while building the menu. */
  generateMarkdownLink?: (request: PdfLinkRequest) => string | null;
}
export interface PdfPageMenuContext {
  desktop: boolean;
  page: number;
  basename: string;
  selectionText?: string;
  /** Same-page text item index/character offset endpoints, already validated by the viewer. */
  selection?: readonly [number, number, number, number] | null;
  canCopy?: boolean;
  macOS?: boolean;
  annotation?: { id: string; subtype: string; text?: string | null } | null;
}
export interface PdfPageCapabilities extends PdfClipboardCapabilities {
  /** Optional PDF.js normalization; basic newline/null cleanup is always applied. */
  normalizeUnicode?: (text: string) => string;
  copyNativeSelection?: () => void | Promise<void>;
  lookupSelection?: () => void | Promise<void>;
}
export function normalizePdfMenuText(text: string, normalizeUnicode: (text: string) => string = value => value): string {
  return normalizeUnicode(text.replace(/[\n\r]+/g, ' ')).replace(/\0/g, '');
}
const shorten = (text: string, length: number) => text.length <= length ? text : `${text.slice(0, length - 1).trim()}…`;
const validPage = (page: number) => Number.isSafeInteger(page) && page > 0;
function link(host: PdfClipboardCapabilities, page: number, basename: string, subpath: string): string | null {
  return host.generateMarkdownLink?.({ page, subpath, alias: `${basename}, page ${page}` }) || null;
}
export function createPdfPageMenu(context: PdfPageMenuContext, capabilities: PdfPageCapabilities): PdfMenuSession {
  const host = { ...capabilities }, action = group(), selection = group(), annotation = group();
  if (!context.desktop || !validPage(context.page)) return session(host, []);
  const text = normalizePdfMenuText(context.selectionText ?? '', host.normalizeUnicode);
  if (context.macOS && text && host.lookupSelection) action.add('pdf-lookup-selection', `Look up “${shorten(text, 25)}”`, host.lookupSelection);
  const copy = host.copyNativeSelection || (host.writeClipboard ? () => host.writeClipboard!(text) : undefined);
  if (text && copy) selection.add('pdf-copy', 'Copy', copy, { enabled: context.canCopy !== false });
  const range = context.selection;
  if (host.writeClipboard && range?.length === 4 && range.every(value => Number.isSafeInteger(value) && value >= 0)) {
    const markdown = link(host, context.page, context.basename, `#page=${context.page}&selection=${range.join(',')}`);
    if (markdown) {
      selection.add('pdf-copy-quote', 'Copy as quote', () => host.writeClipboard!(`> ${text.replace(/[\r\n]+/g, ' ')}\n\n${markdown}`));
      selection.add('pdf-copy-selection-link', 'Copy link to selection', () => host.writeClipboard!(markdown));
    }
  }
  const target = context.annotation;
  if (host.writeClipboard && target?.id && target.subtype !== 'Widget') {
    const markdown = link(host, context.page, context.basename, `#page=${context.page}&annotation=${encodeURIComponent(target.id)}`);
    if (markdown) {
      const quote = target.text;
      if (quote) annotation.add('pdf-copy-annotation', 'Copy annotation', () => host.writeClipboard!(`> ${quote}\n\n${markdown}`));
      annotation.add('pdf-copy-annotation-link', 'Copy link to annotation', () => host.writeClipboard!(markdown));
    }
  }
  return session(host, [action, selection, annotation]);
}
export function createPdfThumbnailMenu(context: { page: number; basename: string }, capabilities: PdfClipboardCapabilities): PdfMenuSession {
  const host = { ...capabilities }, action = group();
  if (validPage(context.page) && host.writeClipboard) {
    const markdown = link(host, context.page, context.basename, `#page=${context.page}`);
    if (markdown) action.add('pdf-copy-page-link', `Copy link to page ${context.page}`, () => host.writeClipboard!(markdown));
  }
  return session(host, [action]);
}
/** Resolve the outline destination with the viewer first; null means no menu. */
export function createPdfOutlineMenu(context: { title?: string; markdownLink: string | null }, capabilities: Pick<PdfClipboardCapabilities, 'writeClipboard' | 'isCurrent'>): PdfMenuSession {
  const host = { ...capabilities }, action = group(), markdown = context.markdownLink;
  if (markdown && host.writeClipboard) {
    const title = (context.title ?? '').replace(/[\s\n\r]+/g, ' ');
    action.add('pdf-copy-section-link', title ? `Copy link to “${shorten(title, 40)}”` : 'Copy link to section', () => host.writeClipboard!(markdown));
  }
  return session(host, [action]);
}
