/** Link-specific menu contributions; merge sections with the owning editor menu.
 * Static evidence and intentional policy boundaries: docs/menus-links-reference.md.
 * This module does not parse Markdown, access the clipboard, or open a URL itself.
 */
export type LinkMenuSurface = 'editor' | 'reading';
export type LinkTokenKind = 'internal' | 'external' | 'external-reference' | 'tag';
export interface LinkSourceSnapshot {
  /** Unique editor/render owner. Replacing a vault/view must replace this identity. */
  readonly ownerId: object | string;
  readonly sourcePath: string;
  readonly revision: number | string;
  readonly text: string;
  readonly readOnly?: boolean;
}
export interface LinkSourceSpan { readonly from: number; readonly to: number; readonly text: string }
export interface LinkTargetInput {
  /** Supplied by the owning syntax tree/renderer, not inferred from DOM text. */
  readonly kind: LinkTokenKind;
  readonly href: string;
  readonly displayText?: string;
  /** Exact editable token span, excluding wiki delimiters; tag span includes '#'. */
  readonly span?: { readonly from: number; readonly to: number };
}
export interface LinkMenuTarget {
  readonly kind: LinkTokenKind;
  readonly href: string;
  readonly displayText: string;
  readonly sourcePath: string;
  readonly ownerId: object | string;
  readonly revision: number | string;
  readonly span?: LinkSourceSpan;
  /** Canonical allowlisted external URL. Internal/tag targets have none. */
  readonly externalUrl?: string;
}
export interface ResolvedMenuFile {
  /** Canonical vault-relative file path, with no fragment or parent segments. */
  readonly path: string;
  /** Stable file identity, distinct when a file at the same path is replaced. */
  readonly identity: object | string;
  readonly shortName?: string;
  readonly mutable?: boolean;
}
export interface LinkMenuInvocation {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly button?: number;
}
export interface OpenInternalLinkRequest {
  readonly linkText: string;
  readonly sourcePath: string;
  readonly destination: 'current' | 'tab' | 'split';
  readonly create: boolean;
  /** Current-pane/creation actions let the host interpret invocation modifiers. */
  readonly invocation?: LinkMenuInvocation;
}
export interface LinkMenuHost {
  /** Returns null after destruction. No callback may operate on a different owner. */
  readonly currentSnapshot: () => LinkSourceSnapshot | null;
  /** Check DOM/syntax ownership, connection, and the owning menu serial.
   * Return false after a newer menu opens or an embed changes owner. */
  readonly ownsTarget: (target: LinkMenuTarget) => boolean;
  readonly resolveInternal?: (linkText: string, sourcePath: string) => ResolvedMenuFile | null;
  readonly openInternal?: (request: OpenInternalLinkRequest) => unknown;
  readonly openExternal?: (url: string, destination: 'browser' | 'web-viewer', invocation?: LinkMenuInvocation) => unknown;
  readonly copyText?: (text: string) => unknown;
  readonly selectRange?: (from: number, to: number) => unknown;
  readonly renameFile?: (path: string) => unknown;
  readonly moveFile?: (path: string) => unknown;
  readonly openFileInWindow?: (path: string) => unknown;
  readonly openWithDefaultApp?: (path: string) => unknown;
  readonly revealInSystem?: (path: string) => unknown;
  readonly copyVaultPath?: (path: string) => unknown;
  readonly copySystemPath?: (path: string) => unknown;
  /** Host owns its protocol and corresponding honest product label. */
  readonly applicationUrl?: { readonly label: string; readonly copy: (path: string) => unknown };
}
export interface LinkMenuOptions {
  readonly surface: LinkMenuSurface;
  readonly host: LinkMenuHost;
  readonly phone?: boolean;
  readonly mobileApp?: boolean;
  readonly desktopApp?: boolean;
  readonly macOS?: boolean;
  readonly localFilesystem?: boolean;
  readonly canSplit?: boolean;
  readonly canPopout?: boolean;
  readonly webViewerEnabled?: boolean;
}
export interface LinkMenuEntry {
  readonly id: string;
  readonly label: string;
  readonly section: string;
  readonly enabled: boolean;
  /** A noninteractive phone title. Hosts should render as a label, not an action. */
  readonly isLabel?: boolean;
  /** Returns false for a stale/disabled target. Callback errors propagate to the host. */
  readonly run: (invocation?: LinkMenuInvocation) => Promise<boolean>;
}

export const EDITOR_LINK_SECTION_ORDER: readonly string[] = Object.freeze([
  'title', 'correction', 'spellcheck', 'open', 'selection-link', 'selection', 'selection.format',
  'selection.paragraph', 'selection.paragraph.list', 'selection.paragraph.heading', 'selection.paragraph.block',
  'selection.insert.basic', 'selection.insert.advanced', 'insert', 'clipboard', 'info', 'info.copy', 'action', 'view', '', 'danger',
]);
export const READING_INTERNAL_LINK_SECTION_ORDER: readonly string[] = Object.freeze(['title', 'open', 'action', 'clipboard', 'view', 'info', '', 'danger']);
export const READING_EXTERNAL_LINK_SECTION_ORDER: readonly string[] = Object.freeze(['title', 'open', 'selection', 'clipboard', 'info', 'action', 'view', '', 'danger']);
export const LINK_COPY_PATH_SUBMENU = Object.freeze({ section: 'info.copy', label: 'Copy path' });

const controls = /[\u0000-\u001f\u007f]/;
const scheme = /^[a-z][a-z0-9+.-]*:/i;
/** Conservative host policy, intentionally narrower than the reference's URL parser. */
export function validatedExternalLink(raw: string): string | null {
  if (controls.test(raw)) return null;
  const value = raw.trim();
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) return null;
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.hostname) return null;
    if ((url.protocol === 'mailto:' || url.protocol === 'tel:') && !url.pathname) return null;
    return url.href;
  } catch { return null; }
}

/** Capture a token owned by this source revision. Reference links need a resolved href. */
export function classifyLinkTarget(input: LinkTargetInput, snapshot: LinkSourceSnapshot): LinkMenuTarget | null {
  if (!input.href || controls.test(input.href)) return null;
  const href = input.kind === 'external' || input.kind === 'external-reference' ? input.href : input.href.trim();
  if (!href.trim()) return null;
  let externalUrl: string | undefined;
  if (input.kind === 'external' || input.kind === 'external-reference') {
    externalUrl = validatedExternalLink(href) ?? undefined;
    if (!externalUrl) return null;
  } else if (input.kind === 'internal') {
    // A rooted vault path is allowed; network paths, OS paths and schemes are not.
    if (href.startsWith('//') || href.includes('\\') || scheme.test(href)) return null;
  } else if (input.kind === 'tag') {
    if (!/^#[\p{L}\p{N}_/-]+$/u.test(href)) return null;
  } else return null;
  let span: LinkSourceSpan | undefined;
  if (input.span) {
    const { from, to } = input.span;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to > snapshot.text.length) return null;
    const text = snapshot.text.slice(from, to);
    if (input.kind === 'tag' && text !== href) return null;
    span = Object.freeze({ from, to, text });
  }
  return Object.freeze({ kind: input.kind, href, displayText: input.displayText ?? href, sourcePath: snapshot.sourcePath, ownerId: snapshot.ownerId, revision: snapshot.revision, span, externalUrl });
}

function validResolvedFile(file: ResolvedMenuFile): boolean {
  return (typeof file.identity === 'string' || typeof file.identity === 'object' && file.identity !== null) && Boolean(file.path) && !controls.test(file.path) && !file.path.startsWith('/') && !file.path.includes('\\') && !scheme.test(file.path)
    && file.path.split('/').every(segment => Boolean(segment) && segment !== '.' && segment !== '..');
}
function sameFile(a: ResolvedMenuFile | null | undefined, b: ResolvedMenuFile | null | undefined): boolean {
  return a === null ? b === null : Boolean(a && b && a.path === b.path && a.identity === b.identity);
}

/** Preserve registration order within each section; unlisted sections follow declared ones. */
export function orderLinkMenuEntries(entries: readonly LinkMenuEntry[], sections: readonly string[]): LinkMenuEntry[] {
  const order = [...sections];
  for (const entry of entries) if (!order.includes(entry.section)) order.push(entry.section);
  return [...entries].sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section));
}

export function buildLinkMenu(target: LinkMenuTarget, options: LinkMenuOptions): LinkMenuEntry[] {
  const { host, surface } = options;
  const entries: LinkMenuEntry[] = [];
  function current(): LinkSourceSnapshot | null {
    const snapshot = host.currentSnapshot();
    if (!snapshot || snapshot.ownerId !== target.ownerId || snapshot.sourcePath !== target.sourcePath || snapshot.revision !== target.revision || !host.ownsTarget(target)) return null;
    const span = target.span;
    return span && snapshot.text.slice(span.from, span.to) !== span.text ? null : snapshot;
  }
  function resolve(): ResolvedMenuFile | null | undefined {
    if (!host.resolveInternal) return undefined;
    const file = host.resolveInternal(target.href, target.sourcePath);
    return file && !validResolvedFile(file) ? undefined : file;
  }
  const snapshot = current();
  if (!snapshot) return [];
  const initialFile = target.kind === 'internal' ? resolve() : undefined;
  const resolved = initialFile ? Object.freeze({ ...initialFile }) : initialFile;
  function add(id: string, label: string, section: string, callback: ((invocation?: LinkMenuInvocation) => unknown) | undefined, settings: { mutates?: boolean; resolveAgain?: boolean; mutableFile?: boolean; enabled?: boolean; isLabel?: boolean } = {}): void {
    if (!callback && !settings.isLabel) return;
    const enabled = Boolean(callback) && !settings.isLabel && settings.enabled !== false && !(settings.mutates && snapshot!.readOnly);
    entries.push(Object.freeze({
      id: `link-${id}`, label, section, enabled, ...(settings.isLabel ? { isLabel: true } : {}),
      async run(invocation?: LinkMenuInvocation): Promise<boolean> {
        const state = current();
        if (!enabled || !state || (settings.mutates && state.readOnly)) return false;
        if (settings.resolveAgain) {
          const fresh = resolve();
          if (!sameFile(resolved, fresh) || settings.mutableFile && fresh?.mutable === false) return false;
        }
        const event = invocation && Object.freeze({ altKey: invocation.altKey, ctrlKey: invocation.ctrlKey, metaKey: invocation.metaKey, shiftKey: invocation.shiftKey, ...(invocation.button === undefined ? {} : { button: invocation.button }) });
        await callback!(event);
        return true;
      },
    }));
  }
  if (surface === 'editor' && target.span && host.selectRange) {
    const span = target.span;
    if (target.kind === 'internal' || target.kind === 'external') add('edit', 'Edit link', 'selection', () => host.selectRange!(span.from, span.to));
    else if (target.kind === 'tag') add('edit-tag', 'Edit tag', 'selection', () => host.selectRange!(span.from + 1, span.to));
  }
  if (surface === 'reading' && target.kind !== 'tag') add('copy-text', 'Copy', 'clipboard', host.copyText && (() => host.copyText!(target.displayText)));
  if (target.kind === 'internal' && resolved !== undefined) {
    const open = (destination: OpenInternalLinkRequest['destination']) => host.openInternal && ((invocation?: LinkMenuInvocation) => host.openInternal!({ linkText: target.href, sourcePath: target.sourcePath, destination, create: resolved === null, ...(destination === 'current' && invocation ? { invocation } : {}) }));
    if (options.phone) add('title', resolved?.shortName ?? target.href.split('#')[0], 'title', undefined, { isLabel: true });
    if (!resolved) add('create', 'Create this file', 'open', open('current'), { mutates: true, resolveAgain: true });
    else {
      if (options.phone) add('open', 'Open link', 'open', open('current'), { resolveAgain: true });
      add('new-tab', 'Open in new tab', 'open', open('tab'), { resolveAgain: true });
      if (options.canSplit) add('split', 'Open to the right', 'open', open('split'), { resolveAgain: true });
      add('rename', 'Rename...', 'action', host.renameFile && (() => host.renameFile!(resolved.path)), { mutates: true, resolveAgain: true });
      // Common workspace file-menu contribution order is independently verified.
      add('copy-app-url', host.applicationUrl?.label ?? '', 'info.copy', host.applicationUrl && (() => host.applicationUrl!.copy(resolved.path)), { resolveAgain: true });
      add('open-default', options.mobileApp ? 'Share' : 'Open in default app', 'system', host.openWithDefaultApp && (() => host.openWithDefaultApp!(resolved.path)), { resolveAgain: true });
      if (resolved.mutable !== false) add('move', 'Move file to...', 'action', host.moveFile && (() => host.moveFile!(resolved.path)), { mutates: true, resolveAgain: true, mutableFile: true });
      add('copy-vault-path', 'from vault folder', 'info.copy', host.copyVaultPath && (() => host.copyVaultPath!(resolved.path)), { resolveAgain: true });
      if (options.desktopApp && options.localFilesystem) {
        add('copy-system-path', 'from system root', 'info.copy', host.copySystemPath && (() => host.copySystemPath!(resolved.path)), { resolveAgain: true });
        add('reveal-system', options.macOS ? 'Reveal in Finder' : 'Show in system explorer', 'system', host.revealInSystem && (() => host.revealInSystem!(resolved.path)), { resolveAgain: true });
      }
      // The reference opens the file itself here, without the original link subpath.
      if (options.canPopout) add('new-window', 'Open in new window', 'open', host.openFileInWindow && (() => host.openFileInWindow!(resolved.path)), { resolveAgain: true });
    }
  } else if ((target.kind === 'external' || target.kind === 'external-reference') && target.externalUrl) {
    add('copy-url', 'Copy URL', 'info', host.copyText && (() => host.copyText!(target.href)));
    add('open-browser', 'Open link in default browser', 'open', host.openExternal && (() => host.openExternal!(target.externalUrl!, 'browser')));
    if (options.webViewerEnabled) add('open-web-viewer', 'Open link in web viewer', 'open', host.openExternal && ((invocation?: LinkMenuInvocation) => host.openExternal!(target.externalUrl!, 'web-viewer', invocation)));
  }
  const order = surface === 'editor' ? EDITOR_LINK_SECTION_ORDER : target.kind === 'internal' ? READING_INTERNAL_LINK_SECTION_ORDER : READING_EXTERNAL_LINK_SECTION_ORDER;
  return orderLinkMenuEntries(entries, order);
}
