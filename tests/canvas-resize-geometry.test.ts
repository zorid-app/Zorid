import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasBounds, canvasResizeGrid, canvasResizeRecordIndices, canvasSnapCoordinates, resizeCanvasBounds, scaleCanvasBounds, snapCanvasCoordinate } from '../src/canvas/resize.ts';

test('edge geometry anchors the opposite edge and clamps without flipping', () => {
  const box = { x: 100, y: -20, width: 200, height: 100 };
  assert.deepEqual(resizeCanvasBounds(box, 'left', { x: 500, y: 999 }), { x: 250, y: -20, width: 50, height: 100 });
  assert.deepEqual(resizeCanvasBounds(box, 'top', { x: -999, y: 500 }), { x: 100, y: 30, width: 200, height: 50 });
  assert.deepEqual(resizeCanvasBounds(box, 'bottom-right', { x: 350.4, y: 149.6 }), { x: 100, y: -20, width: 250, height: 170 });
});

test('media ratio correction follows the dragged axes and initial anchored corner', () => {
  const box = { x: 20, y: 30, width: 200, height: 100 };
  assert.deepEqual(resizeCanvasBounds(box, 'left', { x: 120, y: 999 }, undefined, 2), { x: 120, y: 30, width: 100, height: 50 });
  assert.deepEqual(resizeCanvasBounds(box, 'top-left', { x: 10, y: -20 }, undefined, 2), { x: -80, y: -20, width: 300, height: 150 });
  // The retained reference applies ratio correction after its base minimum;
  // an extreme aspect ratio can therefore make the perpendicular side <50.
  assert.deepEqual(resizeCanvasBounds(box, 'right', { x: 30, y: 0 }, undefined, 10), { x: 20, y: 30, width: 50, height: 5 });
});

test('selection geometry preserves relative gaps and rounds individual nodes', () => {
  const a = { x: -100, y: -50, width: 100, height: 50 }, b = { x: 100, y: 50, width: 200, height: 100 };
  const initial = canvasBounds([a, b]);
  assert.deepEqual(initial, { x: -100, y: -50, width: 400, height: 200 });
  const next = { x: -200, y: -100, width: 800, height: 400 };
  assert.deepEqual(scaleCanvasBounds(a, initial, next), { x: -200, y: -100, width: 200, height: 100 });
  assert.deepEqual(scaleCanvasBounds(b, initial, next), { x: 200, y: 100, width: 400, height: 200 });
});

test('nearest object coordinates take priority over grid, independently of perpendicular overlap', () => {
  const coordinates = canvasSnapCoordinates([{ x: 113, y: -500, width: 100, height: 40 }, { x: 113, y: 500, width: 100, height: 40 }]);
  assert.deepEqual(coordinates.x, [113, 163, 213]);
  assert.equal(snapCanvasCoordinate(120, coordinates.x, 15, 20), 113);
  assert.equal(snapCanvasCoordinate(143, coordinates.x, 15, 20), 140);
  assert.deepEqual([1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2].map(canvasResizeGrid), [160, 80, 40, 40, 20, 20]);
});

test('large snap indexes use logarithmic coordinate reads on repeated pointer updates', () => {
  const values = Array.from({ length: 100_000 }, (_, index) => index * 100); let reads = 0;
  const indexed = new Proxy(values, { get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver); } });
  for (let query = 0; query < 100; query++) assert.equal(snapCanvasCoordinate(1_234_500 + query * 100 + 4, indexed, 15, 20), 1_234_500 + query * 100);
  assert.ok(reads < 2500, `expected indexed work, observed ${reads} coordinate reads`);
});

test('large multi-selection resolves each raw record once while retaining exact collision checks', () => {
  const records = Array.from({ length: 10_000 }, (_, index) => ({ id: String(index), text: `Card ${index}`, x: index })); let reads = 0;
  const indexed = new Proxy(records, { get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver); } });
  const matches = canvasResizeRecordIndices(indexed, records);
  assert.equal(matches.size, records.length); assert.equal(matches.get('9999'), 9999); assert.equal(reads, records.length);
  assert.equal(canvasResizeRecordIndices([{ id: 'a', text: 'first' }, { id: 'a', text: 'last' }], [{ id: 'a', text: 'last' }]).get('a'), 1);
  assert.throws(() => canvasResizeRecordIndices([{ id: 'a', text: 'same' }, { id: 'a', text: 'same' }], [{ id: 'a', text: 'same' }]), /changed/);
  assert.throws(() => canvasResizeRecordIndices([{ id: 'a', text: 'new' }], [{ id: 'a', text: 'old' }]), /changed/);
});
