import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createImageResizeControl } from '../src/editor/image-resize-control.ts';

function fixture() {
  const dom = new JSDOM('<main><img></main>', { pretendToBeVisual: true });
  const win = dom.window, doc = win.document, root = doc.querySelector('main')!, image = doc.querySelector('img')!;
  let current: HTMLImageElement | undefined = image, max = 300, begins = 0, nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>(), commits: (number | null)[] = [], captured = new Set<number>();
  win.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
  win.cancelAnimationFrame = id => { frames.delete(id); };
  Object.defineProperties(image, { offsetWidth: { get: () => Number(image.getAttribute('width') ?? 120) },
    offsetHeight: { get: () => Number(image.getAttribute('height') ?? Number(image.getAttribute('width') ?? 120) / 2) },
    clientWidth: { get: () => Math.min(max, Number(image.getAttribute('width') ?? 120)) } });
  image.getBoundingClientRect = () => ({ left: 10, top: 20, right: 130, bottom: 80, width: 120, height: 60, x: 10, y: 20, toJSON() {} });
  const controls = createImageResizeControl(root, { image: () => current, maxWidth: () => max,
    begin: () => { begins++; return { commit: value => commits.push(value) }; } });
  const corner = root.querySelector<HTMLElement>('.zorid-image-resize-corner')!;
  corner.setPointerCapture = id => { captured.add(id); }; corner.hasPointerCapture = id => captured.has(id); corner.releasePointerCapture = id => { captured.delete(id); };
  const pointer = (type: string, x = 130, y = 80, id = 1, button = 0, primary = true) => {
    const event = new win.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button });
    Object.defineProperties(event, { pointerId: { value: id }, isPrimary: { value: primary } });
    (type === 'pointerdown' ? corner : doc).dispatchEvent(event); return event;
  };
  const flush = () => { const work = [...frames.values()]; frames.clear(); work.forEach(callback => callback(0)); };
  return { dom, win, doc, root, image, corner, controls, commits, frames, captured, pointer, flush,
    begins: () => begins, max: (value: number) => { max = value; }, replace: () => { current = undefined; controls.refresh(); },
    close: () => { controls.destroy(); dom.window.close(); } };
}

test('resize threshold, one RAF preview and one last-applied width commit preserve source callback ownership', () => {
  const f = fixture(); try {
    f.pointer('pointerdown'); f.pointer('pointermove', 133, 82); assert.equal(f.frames.size, 0); assert.equal(f.captured.size, 0);
    f.pointer('pointermove', 180, 90); f.pointer('pointermove', 210, 120); assert.equal(f.frames.size, 1); assert.equal(f.commits.length, 0);
    f.flush(); assert.equal(f.image.width, 200); assert.equal(f.captured.has(1), true);
    f.pointer('pointermove', 260, 140); f.pointer('pointerup', 900, 900);
    assert.deepEqual(f.commits, [200], 'terminal coordinates and pending RAF do not replace last applied width');
    assert.equal(f.image.hasAttribute('width'), false); assert.equal(f.frames.size, 0); assert.equal(f.captured.size, 0);
    f.pointer('pointermove', 250, 130); f.flush(); assert.deepEqual(f.commits, [200]);
  } finally { f.close(); }
});

test('resize honors initial aspect, minimum, editor maximum, RTL and pointer identity', () => {
  const f = fixture(); try {
    f.pointer('pointerdown'); f.pointer('pointermove', 11, 21); f.flush(); assert.equal(f.image.width, 20);
    f.pointer('pointermove', 20, 220); f.flush(); assert.equal(f.image.width, 300);
    f.pointer('pointerup', 20, 220, 2); assert.equal(f.commits.length, 0);
    f.pointer('pointerup', 20, 220, 1, 1); assert.equal(f.commits.length, 0);
    f.pointer('pointerup'); assert.deepEqual(f.commits, [300]);
    f.corner.style.direction = 'rtl'; f.pointer('pointerdown'); f.pointer('pointermove', -70, 100); f.flush(); assert.equal(f.image.width, 200);
    f.pointer('pointerup'); assert.deepEqual(f.commits, [300, 200]);
    f.pointer('pointerdown', 130, 80, 4, 0, false); assert.equal(f.begins(), 2);
  } finally { f.close(); }
});

for (const reason of ['pointercancel', 'escape', 'contextmenu', 'blur', 'destroy', 'replacement', 'detach']) {
  test(`resize ${reason} restores original width and leaves no source write or queued frame`, () => {
    const f = fixture(); try {
      f.image.width = 100; f.image.height = 50;
      f.pointer('pointerdown'); f.pointer('pointermove', 210, 120); f.flush(); assert.equal(f.image.width, 200);
      f.pointer('pointermove', 240, 140); assert.equal(f.frames.size, 1);
      if (reason === 'pointercancel') f.pointer('pointercancel');
      else if (reason === 'escape') f.doc.dispatchEvent(new f.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      else if (reason === 'contextmenu') f.doc.dispatchEvent(new f.win.MouseEvent('contextmenu', { bubbles: true }));
      else if (reason === 'blur') f.win.dispatchEvent(new f.win.Event('blur'));
      else if (reason === 'destroy') f.controls.destroy();
      else if (reason === 'replacement') f.replace();
      else { f.root.remove(); f.pointer('pointerup'); }
      assert.equal(f.image.width, 100); assert.equal(f.image.height, 50);
      assert.equal(f.frames.size, 0); assert.equal(f.captured.size, 0); assert.deepEqual(f.commits, []);
      f.pointer('pointerup'); f.flush(); assert.deepEqual(f.commits, []);
    } finally { f.close(); }
  });
}

test('double click delegates reset only while current and a no-drag click does not write width', () => {
  const f = fixture(); try {
    f.pointer('pointerdown'); f.pointer('pointerup'); assert.deepEqual(f.commits, []);
    const double = () => f.corner.dispatchEvent(new f.win.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    double(); assert.deepEqual(f.commits, [null]);
    f.root.remove(); double(); assert.deepEqual(f.commits, [null]);
    f.controls.destroy(); double(); assert.deepEqual(f.commits, [null]);
  } finally { f.close(); }
});
