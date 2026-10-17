import { icon } from '../ui/icons.ts';
import { createImageResizeControl } from './image-resize-control.ts';

export interface ImageEmbedControlOptions {
  /** The host owns the selected image identity and maps it through edits. */
  onSelect(): void;
  /** Select the mapped URL segment and retain the host's existing renderer. */
  onEditSource(): void;
  /** Invoke the current image viewer capability directly, not image.click(). */
  onZoom(image: HTMLImageElement, event: MouseEvent): void;
  /** A gesture captures its current source owner; commit may reject stale source. */
  onResizeStart?(): { commit(width: number | null): void } | undefined;
  resizeMaxWidth?(): number;
  isMobile?: boolean;
}
export interface ImageEmbedControls {
  setSelected(selected: boolean): void;
  /** Recheck the direct image after a host updates its resolved content. */
  refresh(): void;
  destroy(): void;
}

/** Image-only Live controls. Owns no image bytes, renderer, source offsets or
 * lightbox. The caller destroys this handle before destroying its embed. */
export function createImageEmbedControls(container: HTMLElement, options: ImageEmbedControlOptions): ImageEmbedControls {
  const doc = container.ownerDocument, win = doc.defaultView;
  if (!win) throw new Error('Image controls require an owning window');
  const ownerClass = 'zorid-image-embed-controls-owner', selectedClass = 'zorid-image-selected', narrowClass = 'zorid-image-no-hover-actions';
  const toolbar = doc.createElement('div');
  toolbar.className = 'zorid-image-embed-actions'; toolbar.setAttribute('role', 'group'); toolbar.setAttribute('aria-label', 'Image actions');
  const action = (glyph: string, label: string) => {
    const node = doc.createElement('button');
    node.type = 'button'; node.className = 'zorid-image-embed-action'; node.title = label; node.setAttribute('aria-label', label);
    node.append(icon(glyph, options.isMobile ? 20 : 16, doc)); return node;
  };
  const zoom = options.isMobile ? undefined : action('zoom-in', 'Zoom in');
  const source = action('code', 'Edit image source');
  if (zoom) toolbar.append(zoom);
  toolbar.append(source); container.classList.add(ownerClass); container.append(toolbar);
  toolbar.classList.toggle('is-mobile', !!options.isMobile);
  let closed = false, selected = false, image: HTMLImageElement | undefined;
  const alive = () => !closed && container.isConnected;
  const updateWidth = () => {
    if (closed) return;
    const narrow = !!image && image.offsetWidth < 80;
    container.classList.toggle(narrowClass, narrow);
    for (const button of [source, zoom]) if (button) button.tabIndex = narrow && !selected ? -1 : 0;
  };
  const observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(updateWidth) : undefined;
  const resize = !options.isMobile && options.onResizeStart ? createImageResizeControl(container, {
    image: () => image, begin: options.onResizeStart, maxWidth: () => options.resizeMaxWidth?.() ?? container.parentElement?.clientWidth ?? 0,
  }) : undefined;
  const refresh = () => {
    if (closed) return;
    const next = [...container.children].find(child => child instanceof win.HTMLImageElement) as HTMLImageElement | undefined;
    if (next !== image) {
      if (image) { observer?.unobserve(image); image.removeEventListener('load', updateWidth); }
      image = next;
      if (image) { observer?.observe(image); image.addEventListener('load', updateWidth); }
    }
    if (zoom) zoom.hidden = !image;
    // Renderer refreshes may replace the root's children. The same handle keeps
    // its toolbar beside the new direct image, never inside nested embeds.
    if (toolbar.parentElement !== container) container.append(toolbar);
    resize?.refresh(); updateWidth();
  };
  const mutation = typeof win.MutationObserver === 'function' ? new win.MutationObserver(refresh) : undefined;
  mutation?.observe(container, { childList: true });
  const ownImageEvent = (event: MouseEvent) => event.button === 0 && event.target === image;
  const down = (event: MouseEvent) => {
    if (alive() && ownImageEvent(event)) event.preventDefault();
  };
  const click = (event: MouseEvent) => {
    if (closed || event.defaultPrevented || !ownImageEvent(event)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (!alive()) return;
    if (options.isMobile) {
      // A native viewing tap must complete before text focus/keyboard layout can
      // move this target. Keep source selection, but open in the same event.
      const target = image!;
      if (!selected) options.onSelect();
      if (alive() && image === target && target.parentElement === container) options.onZoom(target, event);
    } else if (selected) options.onZoom(image!, event); else options.onSelect();
  };
  const edit = (event: MouseEvent) => {
    event.preventDefault(); event.stopPropagation();
    if (alive()) options.onEditSource();
  };
  const show = (event: MouseEvent) => {
    event.preventDefault(); event.stopPropagation();
    if (alive() && image) options.onZoom(image, event);
  };
  // Capture runs before the shared renderer's image.onclick lightbox handler.
  // Reading mode never mounts this helper and keeps its existing click behavior.
  container.addEventListener('mousedown', down, true); container.addEventListener('click', click, true);
  source.addEventListener('click', edit); zoom?.addEventListener('click', show);
  refresh();
  return {
    setSelected(value) { if (closed) return; selected = value; container.classList.toggle(selectedClass, value); updateWidth(); },
    refresh,
    destroy() {
      if (closed) return; closed = true;
      resize?.destroy(); observer?.disconnect(); mutation?.disconnect(); image?.removeEventListener('load', updateWidth);
      container.removeEventListener('mousedown', down, true); container.removeEventListener('click', click, true);
      source.removeEventListener('click', edit); zoom?.removeEventListener('click', show);
      toolbar.remove(); container.classList.remove(ownerClass, selectedClass, narrowClass); image = undefined;
    },
  };
}
