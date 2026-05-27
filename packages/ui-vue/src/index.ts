export interface VirtualWindow { readonly start: number; readonly end: number; readonly offsetTop: number; readonly totalHeight: number; }
export function computeVirtualWindow(options: { readonly itemCount: number; readonly itemHeight: number; readonly viewportHeight: number; readonly scrollTop: number; readonly overscan?: number }): VirtualWindow {
  const overscan = options.overscan ?? 5;
  const visible = Math.ceil(options.viewportHeight / options.itemHeight);
  const start = Math.max(0, Math.floor(options.scrollTop / options.itemHeight) - overscan);
  const end = Math.min(options.itemCount, start + visible + overscan * 2);
  return { start, end, offsetTop: start * options.itemHeight, totalHeight: options.itemCount * options.itemHeight };
}
