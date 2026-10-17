/** Canvas input ownership helpers. Native content scrolls while it can consume
 * the gesture; exhausted content hands the gesture to the Canvas viewport. */
export function canScrollCanvasContent(target: Element, viewport: HTMLElement, dx: number, dy: number): boolean {
  const win = viewport.ownerDocument.defaultView!;
  const consumes = (delta: number, position: number, low: number, high: number) => {
    position = Math.max(low, Math.min(high, position)); // Ignore native elastic overscroll.
    return delta < 0 ? position > low + .5 : delta > 0 && position < high - .5;
  };
  let horizontal = !!dx, vertical = !!dy;
  for (let item: Element | null = target; item && item !== viewport; item = item.parentElement) {
    const style = win.getComputedStyle(item);
    const scrollY = vertical && /^(auto|scroll|overlay)$/.test(style.overflowY || style.overflow);
    const scrollX = horizontal && /^(auto|scroll|overlay)$/.test(style.overflowX || style.overflow);
    if (scrollY && consumes(dy, item.scrollTop, 0, Math.max(0, item.scrollHeight - item.clientHeight))) return true;
    if (scrollX) {
      const extent = Math.max(0, item.scrollWidth - item.clientWidth), rtl = style.direction === 'rtl';
      if (consumes(dx, item.scrollLeft, rtl ? -extent : 0, rtl ? 0 : extent)) return true;
    }
    // A contained inner scroller cannot hand native scrolling to an ancestor.
    // Once it is exhausted, Canvas must own that axis rather than silently drop it.
    if (scrollY && /^(contain|none)$/.test(style.overscrollBehaviorY || style.overscrollBehavior)) vertical = false;
    if (scrollX && /^(contain|none)$/.test(style.overscrollBehaviorX || style.overscrollBehavior)) horizontal = false;
    if (!horizontal && !vertical) break;
  }
  return false;
}

/** At most one pending frame and one latest input. Flush before committing a
 * gesture; discard before cancellation, replacement or destruction. Retired
 * callbacks cannot consume a newer gesture's input. */
export function createCanvasFrameQueue<T>(options: {
  request(callback: FrameRequestCallback): number;
  cancel(id: number): void;
  apply(value: T): void;
}) {
  let frame: number | undefined, latest: { value: T } | undefined, generation = 0;
  const discard = () => { generation++; if (frame !== undefined) options.cancel(frame); frame = undefined; latest = undefined; };
  const flush = () => { const pending = latest; discard(); if (pending) options.apply(pending.value); };
  return {
    push(value: T) {
      latest = { value };
      if (frame !== undefined) return;
      const token = generation;
      frame = options.request(() => { if (token === generation) flush(); });
    },
    flush, discard,
  };
}
