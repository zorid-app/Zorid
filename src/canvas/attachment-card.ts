import { attachmentType, isImage, type AttachmentLease, type AttachmentResources } from '../ui/attachments.ts';
import { createImageView } from '../ui/image-view.ts';
import { createPdfView } from '../ui/pdf-view.ts';
import { createMediaView, mediaKind } from '../ui/media-view.ts';

export type CanvasAttachmentKind = 'image' | 'pdf' | 'audio' | 'video';
/** Receives resolved vault paths, never URLs or Markdown targets. */
export function canvasAttachmentKind(path: string): CanvasAttachmentKind | null {
  if (!path || /^(?:[a-z][\w+.-]*:|\/)/i.test(path) || /\0/.test(path)) return null;
  if (isImage(path)) return 'image';
  if (attachmentType(path) === 'application/pdf') return 'pdf';
  return mediaKind(path);
}

export interface CanvasAttachmentCardOptions {
  path: string;
  subpath?: string;
  resources: AttachmentResources;
  openFile?(path: string, subpath?: string): void | Promise<void>;
  onError?(error: unknown): void;
  mobile?: boolean;
  imageFactory?: typeof createImageView;
  pdfFactory?: typeof createPdfView;
  mediaFactory?: typeof createMediaView;
}
export interface CanvasAttachmentCard {
  element: HTMLElement;
  /** Viewer initialization, failure or disposal; not decoded pixels or playable media. */
  ready: Promise<void>;
  resize(width: number, height: number): void;
  destroy(): void;
}

/** One attachment viewer per file card. The Canvas host remounts on path/subpath changes. */
export function createCanvasAttachmentCard(parent: HTMLElement, options: CanvasAttachmentCardOptions): CanvasAttachmentCard {
  const doc = parent.ownerDocument;
  const element = doc.createElement('div'); element.className = 'canvas-attachment-card';
  const content = doc.createElement('div'); content.className = 'canvas-attachment-content';
  const status = doc.createElement('div'); status.className = 'canvas-attachment-status'; status.setAttribute('role', 'status'); status.hidden = true;
  element.append(content, status); parent.append(element);
  const kind = canvasAttachmentKind(options.path);
  if (kind) element.dataset.kind = kind;
  let closed = false, failed = false, child: { destroy(): void } | undefined;
  let settle!: () => void;
  const ready = new Promise<void>(resolve => { settle = resolve; });
  const leases = new Set<AttachmentLease>();
  const report = (error: unknown) => {
    if (closed) return;
    status.textContent = error instanceof Error ? error.message : String(error);
    status.hidden = false; element.classList.add('is-error'); settle();
    // Host diagnostics must not interrupt lease cleanup or create rejected handlers.
    try { options.onError?.(error); } catch { /* The visible error remains available. */ }
  };
  const cancelled = () => new DOMException('Canvas card is closed.', 'AbortError');
  // Do not acquire a second outer lease. This boundary also covers lightbox loads.
  const resources = { acquire: async (path: string): Promise<AttachmentLease> => {
    if (closed || failed) throw cancelled();
    let source: AttachmentLease;
    try { source = await options.resources.acquire(path); }
    catch (error) { report(error); throw error; }
    if (closed || failed) { source.release(); throw cancelled(); }
    let released = false;
    const lease: AttachmentLease = {
      url: source.url, type: source.type,
      release() { if (released) return; released = true; leases.delete(lease); source.release(); },
      ...(source.arrayBuffer ? { arrayBuffer: async () => {
        if (closed || failed || released) throw cancelled();
        const bytes = await source.arrayBuffer!();
        if (closed || failed || released) throw cancelled();
        return bytes;
      } } : {}),
    };
    leases.add(lease);
    // ImageView has no readiness promise. Settle after its acquisition handler runs.
    if (kind === 'image') queueMicrotask(() => queueMicrotask(settle));
    return lease;
  } } as AttachmentResources;
  const open = () => {
    if (closed || !options.openFile) return;
    try { void Promise.resolve(options.openFile(options.path, options.subpath)).catch(report); }
    catch (error) { report(error); }
  };
  if (options.openFile) {
    const button = doc.createElement('button'); button.type = 'button'; button.className = 'canvas-attachment-open';
    button.textContent = '↗'; button.title = 'Open file'; button.setAttribute('aria-label', 'Open file');
    button.addEventListener('click', event => { event.stopPropagation(); open(); }); element.append(button);
  }
  const imageError = (event: Event) => {
    if ((event.target as Element | null)?.tagName === 'IMG') report(new Error('Unable to display this image.'));
  };
  content.addEventListener('error', imageError, true);
  try {
    if (kind === 'image') child = (options.imageFactory ?? createImageView)(content, options.path, resources, { onError: report });
    else if (kind === 'pdf') {
      const view = (options.pdfFactory ?? createPdfView)(content, options.path, resources, {
        embed: true, height: 'auto', subpath: options.subpath, mobile: options.mobile, onError: report,
      });
      child = view; void view.ready.then(settle, report);
    } else if (kind === 'audio' || kind === 'video') {
      const view = (options.mediaFactory ?? createMediaView)(content, options.path, resources);
      child = view; void view.ready.then(settle, report);
    } else report(new Error('This file type cannot be displayed in a Canvas attachment card.'));
  } catch (error) { failed = true; report(error); for (const lease of leases) lease.release(); }
  return {
    element, ready,
    resize(width, height) {
      if (closed || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
      element.style.width = `${width}px`; element.style.height = `${height}px`;
    },
    destroy() {
      if (closed) return; closed = true; settle();
      content.removeEventListener('error', imageError, true);
      // The shared image viewer currently retains its click property after disposal.
      // Clear owned DOM callbacks so retained image nodes cannot reopen its lightbox.
      for (const image of content.querySelectorAll('img')) { image.onclick = null; image.onerror = null; }
      try { child?.destroy(); }
      finally { for (const lease of leases) lease.release(); element.remove(); }
    },
  };
}
