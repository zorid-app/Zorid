export interface ImageResizeSource { commit(width: number | null): void }
export interface ImageResizeOptions {
  image(): HTMLImageElement | undefined;
  begin(): ImageResizeSource | undefined;
  maxWidth(): number;
}

/** Pointer preview owns only a temporary width attribute; one host callback
 * commits source after a completed drag. Cancellation restores the prior DOM. */
export function createImageResizeControl(container: HTMLElement, options: ImageResizeOptions) {
  const doc = container.ownerDocument, win = doc.defaultView!;
  const corner = doc.createElement('div'); corner.className = 'zorid-image-resize-corner'; corner.title = 'Resize image';
  let closed = false;
  type Drag = { image: HTMLImageElement; pointer: number; x: number; y: number; anchor: number; top: number; ratio: number;
    original: string | null; source: ImageResizeSource; started: boolean; frame?: number; nextX: number; nextY: number };
  let drag: Drag | undefined;
  const alive = () => !closed && container.isConnected;
  const current = (item: Drag) => alive() && item.image.isConnected && item.image === options.image();
  const restore = (item: Drag) => {
    if (item.original === null) item.image.removeAttribute('width'); else item.image.setAttribute('width', item.original);
  };
  const finish = (commit: boolean) => {
    const item = drag; if (!item) return;
    drag = undefined;
    if (item.frame !== undefined) win.cancelAnimationFrame(item.frame);
    doc.removeEventListener('pointermove', move, true); doc.removeEventListener('pointerup', up, true);
    doc.removeEventListener('pointercancel', cancelPointer, true); doc.removeEventListener('keydown', key, true);
    doc.removeEventListener('contextmenu', cancel, true); doc.removeEventListener('dragstart', dropped, true); doc.removeEventListener('drop', dropped, true);
    win.removeEventListener('blur', cancel); corner.removeEventListener('lostpointercapture', cancelPointer);
    container.classList.remove('zorid-image-resizing');
    try { if (corner.hasPointerCapture?.(item.pointer)) corner.releasePointerCapture(item.pointer); } catch { /* Detached capture is already released. */ }
    const width = Math.round(item.image.clientWidth);
    restore(item);
    if (commit && item.started && current(item) && Number.isSafeInteger(width) && width > 0) item.source.commit(width);
  };
  const cancel = () => finish(false);
  const cancelPointer = (event: PointerEvent) => { if (drag?.pointer === event.pointerId) finish(false); };
  const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); } };
  const dropped = () => finish(true);
  const apply = (item: Drag) => {
    item.frame = undefined;
    if (drag !== item) return;
    if (!current(item)) { finish(false); return; }
    const limit = options.maxWidth();
    const max = Number.isFinite(limit) && limit > 0 ? Math.max(20, limit) : Math.max(20, item.image.offsetWidth);
    const width = Math.round(Math.min(max, Math.max(20, Math.abs(item.nextX - item.anchor), Math.abs(item.nextY - item.top) * item.ratio)));
    if (Number.isSafeInteger(width)) item.image.width = width;
  };
  function move(event: PointerEvent) {
    const item = drag;
    if (!item || event.pointerId !== item.pointer) return;
    if (!current(item)) { finish(false); return; }
    if (!item.started) {
      if (Math.hypot(event.clientX - item.x, event.clientY - item.y) < 5) return;
      item.started = true; container.classList.add('zorid-image-resizing');
      try { corner.setPointerCapture?.(item.pointer); } catch { /* Document listeners cover unavailable capture. */ }
    }
    event.preventDefault(); item.nextX = event.clientX; item.nextY = event.clientY;
    if (item.frame === undefined) item.frame = win.requestAnimationFrame(() => apply(item));
  }
  function up(event: PointerEvent) { if (drag?.pointer === event.pointerId && event.button === 0) finish(true); }
  const down = (event: PointerEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.isPrimary === false || !alive() || drag) return;
    const image = options.image(); if (!image) return;
    const width = image.offsetWidth, height = image.offsetHeight;
    if (!(width > 0 && height > 0 && Number.isFinite(width / height))) return;
    const source = options.begin(); if (!source) return;
    const rect = image.getBoundingClientRect();
    event.preventDefault(); event.stopPropagation();
    drag = { image, source, pointer: event.pointerId, x: event.clientX, y: event.clientY,
      anchor: win.getComputedStyle(corner).direction === 'rtl' ? rect.right : rect.left, top: rect.top, ratio: width / height,
      original: image.getAttribute('width'), started: false, nextX: event.clientX, nextY: event.clientY };
    doc.addEventListener('pointermove', move, true); doc.addEventListener('pointerup', up, true);
    doc.addEventListener('pointercancel', cancelPointer, true); doc.addEventListener('keydown', key, true);
    doc.addEventListener('contextmenu', cancel, true); doc.addEventListener('dragstart', dropped, true); doc.addEventListener('drop', dropped, true);
    win.addEventListener('blur', cancel); corner.addEventListener('lostpointercapture', cancelPointer);
  };
  const stop = (event: Event) => { event.preventDefault(); event.stopPropagation(); };
  const reset = (event: MouseEvent) => {
    if (event.defaultPrevented || !alive() || !options.image()) return;
    stop(event); finish(false); options.begin()?.commit(null);
  };
  corner.addEventListener('pointerdown', down); corner.addEventListener('click', stop); corner.addEventListener('dblclick', reset);
  const refresh = () => {
    if (closed) return;
    if (drag && !current(drag)) finish(false);
    corner.hidden = !options.image();
    if (corner.parentElement !== container) container.append(corner);
  };
  refresh();
  return { refresh, destroy() {
    if (closed) return; finish(false); closed = true;
    corner.removeEventListener('pointerdown', down); corner.removeEventListener('click', stop); corner.removeEventListener('dblclick', reset);
    corner.remove();
  } };
}
