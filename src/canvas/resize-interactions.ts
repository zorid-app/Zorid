/** Original bounded layout helpers. Static reference: pinned 1.14.4 app.js
 * 3378158–3378950 (Markdown fit), 3347224–3348100 (drag pan), SHA958ce57f…df9.
 * Measurement adapters and atomic publication are Zorid implementation choices. */
import type { CanvasBounds } from './resize.ts';

interface CanvasSnapEntry { coordinate: number; bounds: CanvasBounds }
export interface CanvasResizeSnapIndex { x: readonly CanvasSnapEntry[]; y: readonly CanvasSnapEntry[] }

/** Index all non-selected geometry once. Visibility is evaluated at query time
 * so auto-pan can reveal or hide snap targets without rebuilding the index. */
export function indexCanvasResizeSnaps(items: readonly CanvasBounds[]): CanvasResizeSnapIndex {
  const x: CanvasSnapEntry[] = [], y: CanvasSnapEntry[] = [];
  for (const item of items) {
    const bounds = { x: item.x, y: item.y, width: item.width, height: item.height };
    for (const coordinate of [bounds.x, bounds.x + bounds.width / 2, bounds.x + bounds.width]) x.push({ coordinate, bounds });
    for (const coordinate of [bounds.y, bounds.y + bounds.height / 2, bounds.y + bounds.height]) y.push({ coordinate, bounds });
  }
  x.sort((a, b) => a.coordinate - b.coordinate); y.sort((a, b) => a.coordinate - b.coordinate);
  return { x, y };
}
export function snapVisibleCanvasCoordinate(value: number, index: readonly CanvasSnapEntry[], viewport: CanvasBounds, distance: number, grid: number): number {
  let low = 0, high = index.length;
  while (low < high) { const middle = (low + high) >>> 1; if (index[middle].coordinate < value - distance) low = middle + 1; else high = middle; }
  let nearest: number | undefined;
  for (let at = low; at < index.length; at++) {
    const { coordinate, bounds } = index[at]; if (coordinate > value + distance) break;
    if (bounds.x <= viewport.x + viewport.width && bounds.x + bounds.width >= viewport.x && bounds.y <= viewport.y + viewport.height && bounds.y + bounds.height >= viewport.y && (nearest === undefined || Math.abs(coordinate - value) < Math.abs(nearest - value))) nearest = coordinate;
  }
  return nearest ?? Math.round(value / grid) * grid;
}
export interface CanvasFitSize { width: number; height: number }
export interface CanvasFitMeasurement {
  clientHeight(): number;
  scrollHeight(): number;
  collapse(collapsed: boolean): void;
  apply(size: CanvasFitSize): void;
}

/** Returns the fitted dimensions without publishing source changes. The caller
 * owns restoring the DOM if a measurement fails or its source becomes stale. */
export function fitCanvasMarkdown(direction: 'bottom' | 'right', initial: CanvasFitSize, measurement: CanvasFitMeasurement): CanvasFitSize {
  let size = { ...initial };
  const measured = (value: number) => { if (!Number.isFinite(value) || value < 0) throw new Error('Unable to measure Canvas Markdown content'); return value; };
  try {
    if (direction === 'bottom') {
      for (let iteration = 0; iteration < 10; iteration++) {
        const currentHeight = measured(measurement.clientHeight());
        measurement.collapse(true); const contentHeight = measured(measurement.scrollHeight()); measurement.collapse(false);
        const delta = contentHeight - currentHeight + 1;
        if (Math.abs(delta) < .5) break;
        size = { width: initial.width, height: measured(Math.round(size.height + delta)) };
        measurement.apply(size);
      }
    } else {
      measurement.collapse(true);
      const contentHeight = measured(measurement.scrollHeight()) + .1;
      let lower = 0, upper = initial.width;
      for (let iteration = 0; iteration < 10; iteration++) {
        const width = Math.round((lower + upper) / 2);
        measurement.apply({ width, height: initial.height });
        if (measured(measurement.scrollHeight()) > contentHeight) lower = width; else upper = width;
        if (upper - lower < 1) break;
      }
      size = { width: upper, height: initial.height }; measurement.apply(size);
      if (measured(measurement.scrollHeight()) > contentHeight) { size = { ...initial }; measurement.apply(size); }
    }
    return size;
  } finally { measurement.collapse(false); }
}

export interface CanvasAutoPanRect { left: number; top: number; right: number; bottom: number }
export interface CanvasResizeAutoPan { move(point: { clientX: number; clientY: number }): void; destroy(): void }
export function createCanvasResizeAutoPan(options: {
  bounds: CanvasAutoPanRect;
  scale(): number;
  pan(x: number, y: number): void;
  current(): boolean;
  schedule(tick: () => void, delay: number): number;
  cancel(timer: number): void;
}): CanvasResizeAutoPan {
  let timer: number | undefined, closed = false, x = 0, y = 0, generation = 0;
  const stop = () => { generation++; if (timer !== undefined) options.cancel(timer); timer = undefined; };
  const distance = (value: number, low: number, high: number) => Math.max(-40, Math.min(40, value < low ? value - low : value > high ? value - high : 0));
  return {
    move(point) {
      if (closed || !options.current()) return;
      const rect = options.bounds;
      if (rect.right <= rect.left || rect.bottom <= rect.top) return;
      x = distance(point.clientX, rect.left + 30, rect.right - 30); y = distance(point.clientY, rect.top + 30, rect.bottom - 30);
      if (!x && !y) { stop(); return; }
      if (timer === undefined) {
        const token = ++generation;
        timer = options.schedule(() => {
          if (token !== generation) return;
          if (closed || !options.current()) { stop(); return; }
          const factor = .5 / Math.sqrt(options.scale());
          if (Number.isFinite(factor) && factor > 0) options.pan(x * factor, y * factor);
        }, 1000 / 60);
      }
    },
    destroy() { if (closed) return; closed = true; stop(); },
  };
}
