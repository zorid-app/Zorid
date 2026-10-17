import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasResizeAutoPan, fitCanvasMarkdown, indexCanvasResizeSnaps, snapVisibleCanvasCoordinate } from '../src/canvas/resize-interactions.ts';

test('bottom fit converges from measured content without a drag minimum or aspect correction', () => {
  let size = { width: 200, height: 200 }, collapsed = false, reads = 0, writes = 0;
  const fitted = fitCanvasMarkdown('bottom', size, { clientHeight: () => size.height - 2, scrollHeight() { reads++; assert.equal(collapsed, true); return 20; }, collapse: value => { collapsed = value; }, apply: next => { size = next; writes++; } });
  assert.deepEqual(fitted, { width: 200, height: 23 }); assert.equal(writes, 1); assert.equal(reads, 2); assert.equal(collapsed, false);
});

test('bottom fit has a fixed ten-measure budget even when layout never converges', () => {
  let reads = 0, writes = 0, collapsed = false;
  const fitted = fitCanvasMarkdown('bottom', { width: 100, height: 100 }, { clientHeight: () => 100, scrollHeight() { reads++; return 100; }, collapse: value => { collapsed = value; }, apply() { writes++; } });
  assert.equal(reads, 10); assert.equal(writes, 10); assert.equal(fitted.height, 110); assert.equal(collapsed, false);
});

test('right fit finds the narrowest bounded candidate preserving the initial content height', () => {
  let size = { width: 400, height: 80 }, reads = 0, writes = 0, collapsed = false;
  const fitted = fitCanvasMarkdown('right', size, { clientHeight: () => 80, scrollHeight() { reads++; assert.equal(collapsed, true); return size.width >= 120 ? 80 : 160; }, collapse: value => { collapsed = value; }, apply: next => { size = next; writes++; } });
  assert.deepEqual(fitted, { width: 120, height: 80 }); assert.ok(reads <= 12); assert.ok(writes <= 11); assert.equal(collapsed, false);
});

test('right fit rejects a candidate whose content grows during final validation', () => {
  let calls = 0, size = { width: 1024, height: 80 };
  const fitted = fitCanvasMarkdown('right', size, { clientHeight: () => 80, scrollHeight() { return ++calls === 12 ? 160 : 80; }, collapse() {}, apply: next => { size = next; } });
  assert.deepEqual(fitted, { width: 1024, height: 80 }); assert.deepEqual(size, fitted);
});

test('measurement exceptions and invalid layout restore the temporary collapse state', () => {
  for (const direction of ['bottom', 'right'] as const) {
    let collapsed = false;
    assert.throws(() => fitCanvasMarkdown(direction, { width: 100, height: 100 }, { clientHeight: () => 100, scrollHeight() { throw new Error('layout failed'); }, collapse: value => { collapsed = value; }, apply() {} }), /layout failed/);
    assert.equal(collapsed, false);
  }
  assert.throws(() => fitCanvasMarkdown('bottom', { width: 100, height: 100 }, { clientHeight: () => 100, scrollHeight: () => NaN, collapse() {}, apply() {} }), /Unable to measure/);
});

test('auto-pan owns one timer, applies capped world velocity at the current scale, and cancels on exit/destruction', () => {
  const ticks = new Map<number, () => void>(), pans: number[][] = []; let next = 0, scale = 1, current = true;
  const owner = createCanvasResizeAutoPan({ bounds: { left: 10, top: 20, right: 810, bottom: 620 }, scale: () => scale, current: () => current, pan: (x, y) => pans.push([x, y]), schedule(tick, delay) { assert.equal(delay, 1000 / 60); ticks.set(++next, tick); return next; }, cancel: id => { ticks.delete(id); } });
  owner.move({ clientX: 790, clientY: 600 }); const retained = ticks.get(1)!; retained(); assert.deepEqual(pans[0], [5, 5]);
  owner.move({ clientX: 1000, clientY: -100 }); assert.equal(ticks.size, 1); retained(); assert.deepEqual(pans[1], [20, -20]);
  scale = .25; retained(); assert.deepEqual(pans[2], [40, -40]);
  owner.move({ clientX: 400, clientY: 300 }); assert.equal(ticks.size, 0);
  owner.move({ clientX: 0, clientY: 300 }); assert.equal(ticks.size, 1); retained(); assert.equal(pans.length, 3, 'a queued callback from the retired interval is inert'); current = false; ticks.get(2)!(); assert.equal(ticks.size, 0);
  current = true; owner.move({ clientX: 0, clientY: 300 }); const stale = ticks.get(3)!; owner.destroy(); owner.destroy(); stale(); owner.move({ clientX: 0, clientY: 0 }); assert.equal(ticks.size, 0); assert.equal(pans.length, 3);
});

test('snap index filters against current viewport rather than visibility at gesture start', () => {
  const index = indexCanvasResizeSnaps([{ x: 100, y: 500, width: 100, height: 100 }]);
  assert.equal(snapVisibleCanvasCoordinate(107, index.x, { x: 0, y: 0, width: 400, height: 300 }, 15, 20), 100, 'grid is the fallback before visibility');
  assert.equal(snapVisibleCanvasCoordinate(153, index.x, { x: 0, y: 0, width: 400, height: 300 }, 15, 20), 160);
  assert.equal(snapVisibleCanvasCoordinate(153, index.x, { x: 0, y: 400, width: 400, height: 300 }, 15, 20), 150);
  assert.equal(snapVisibleCanvasCoordinate(153, index.x, { x: 500, y: 400, width: 400, height: 300 }, 15, 20), 160);
});

test('moving viewport queries inspect only the indexed coordinate window, not every snap target', () => {
  const index = indexCanvasResizeSnaps(Array.from({ length: 20_000 }, (_, i) => ({ x: i * 100, y: 0, width: 20, height: 20 }))); let reads = 0;
  const counted = new Proxy(index.x, { get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver); } });
  for (let i = 0; i < 100; i++) { const x = 100_000 + i * 100; assert.equal(snapVisibleCanvasCoordinate(x + 3, counted, { x: x - 50, y: 0, width: 800, height: 600 }, 15, 20), x); }
  assert.ok(reads < 2500, `${reads} indexed coordinate reads for 100 viewport queries`);
});
