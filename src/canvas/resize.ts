/** Original Canvas resize geometry, based on the bounded 1.14.4 static audit:
 * app.js 3369861–3371692 (single), 3284297–3286789 (selection),
 * SHA958ce57f…df9. No reference code is executed or included. */
export const CANVAS_RESIZE_DIRECTIONS = ['top', 'right', 'bottom', 'left', 'top-left', 'top-right', 'bottom-right', 'bottom-left'] as const;
export type CanvasResizeDirection = typeof CANVAS_RESIZE_DIRECTIONS[number];
export interface CanvasBounds { x: number; y: number; width: number; height: number }

/** Resolve every resize target in one scan, keeping exact-record collision
 * checks without a selected-count × document-count pointerdown cost. */
export function canvasResizeRecordIndices<T extends { id: string }>(records: readonly T[], originals: readonly T[]): Map<string, number> {
  const wanted = new Map(originals.map(record => [record.id, JSON.stringify(record)])), matches = new Map<string, number>();
  for (let index = 0; index < records.length; index++) {
    const record = records[index], signature = wanted.get(record.id);
    if (signature !== undefined && JSON.stringify(record) === signature) {
      if (matches.has(record.id)) throw new Error('Canvas item changed while editing. Keep this draft or cancel and reopen the item.');
      matches.set(record.id, index);
    }
  }
  if (matches.size !== wanted.size) throw new Error('Canvas item changed while editing. Keep this draft or cancel and reopen the item.');
  return matches;
}

export function canvasBounds(items: readonly CanvasBounds[]): CanvasBounds {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const item of items) { left = Math.min(left, item.x); top = Math.min(top, item.y); right = Math.max(right, item.x + item.width); bottom = Math.max(bottom, item.y + item.height); }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function resizeCanvasBounds(initial: CanvasBounds, direction: CanvasResizeDirection, point: { x: number; y: number }, minimum = { width: 50, height: 50 }, ratio = 0): CanvasBounds {
  let left = initial.x, top = initial.y, right = left + initial.width, bottom = top + initial.height;
  const horizontal = direction.includes('left') || direction.includes('right'), vertical = direction.includes('top') || direction.includes('bottom');
  if (direction.includes('left')) left = Math.min(right - minimum.width, point.x);
  if (direction.includes('right')) right = Math.max(left + minimum.width, point.x);
  if (direction.includes('top')) top = Math.min(bottom - minimum.height, point.y);
  if (direction.includes('bottom')) bottom = Math.max(top + minimum.height, point.y);
  let width = right - left, height = bottom - top;
  if (Number.isFinite(ratio) && ratio > 0) {
    if (horizontal && vertical) { const wide = Math.max(width, height * ratio); height = Math.max(height, width / ratio); width = wide; }
    else if (horizontal) height = width / ratio;
    else if (vertical) width = height * ratio;
    if (direction.includes('left')) left = initial.x + initial.width - width;
    if (direction.includes('top')) top = initial.y + initial.height - height;
  }
  return { x: Math.round(left), y: Math.round(top), width: Math.round(width), height: Math.round(height) };
}

export function scaleCanvasBounds(item: CanvasBounds, before: CanvasBounds, after: CanvasBounds): CanvasBounds {
  return { x: Math.round(after.x + (item.x - before.x) * after.width / before.width), y: Math.round(after.y + (item.y - before.y) * after.height / before.height), width: Math.round(item.width * after.width / before.width), height: Math.round(item.height * after.height / before.height) };
}

export function canvasResizeGrid(scale: number): number {
  const level = Math.log2(scale); return level < -3.3 ? 160 : level < -2.16 ? 80 : level < -.91 ? 40 : 20;
}

/** Precompute sorted candidates once per gesture. Pointer updates use a binary
 * search, rather than scanning every node at every event. */
export function canvasSnapCoordinates(items: readonly CanvasBounds[]): { x: number[]; y: number[] } {
  const x: number[] = [], y: number[] = [];
  for (const item of items) { x.push(item.x, item.x + item.width / 2, item.x + item.width); y.push(item.y, item.y + item.height / 2, item.y + item.height); }
  return { x: [...new Set(x)].sort((a, b) => a - b), y: [...new Set(y)].sort((a, b) => a - b) };
}
export function snapCanvasCoordinate(value: number, candidates: readonly number[], distance: number, grid: number): number {
  let low = 0, high = candidates.length;
  while (low < high) { const middle = (low + high) >>> 1; if (candidates[middle] < value) low = middle + 1; else high = middle; }
  let nearest: number | undefined;
  for (const at of [low - 1, low]) if (at >= 0 && at < candidates.length && (nearest === undefined || Math.abs(candidates[at] - value) < Math.abs(nearest - value))) nearest = candidates[at];
  return nearest !== undefined && Math.abs(nearest - value) <= distance ? nearest : Math.round(value / grid) * grid;
}
