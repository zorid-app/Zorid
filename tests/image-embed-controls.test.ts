import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createImageEmbedControls } from '../src/editor/image-embed-controls.ts';

function setup(mobile = false, resizable = false) {
  const dom = new JSDOM('<main class="image-embed"><img src="data:image/png,original"></main>');
  const doc = dom.window.document, container = doc.querySelector('main')!, image = doc.querySelector('img')!;
  const style = doc.createElement('style'); style.textContent = readFileSync(new URL('../src/editor/image-embed-controls.css', import.meta.url), 'utf8'); doc.head.append(style);
  let width = 240, selected = 0, edited = 0, zoomed = 0, oldClicks = 0, disconnects = 0;
  let resize!: () => void;
  const observed = new Set<Element>();
  Object.defineProperty(image, 'offsetWidth', { get: () => width });
  Object.defineProperty(dom.window, 'ResizeObserver', { value: class {
    constructor(callback: () => void) { resize = callback; }
    observe(element: Element) { observed.add(element); }
    unobserve(element: Element) { observed.delete(element); }
    disconnect() { observed.clear(); disconnects++; }
  } });
  image.onclick = () => { oldClicks++; };
  const controls = createImageEmbedControls(container, {
    isMobile: mobile, ...(resizable ? { onResizeStart: () => ({ commit() {} }) } : {}), onSelect: () => { selected++; controls.setSelected(true); },
    onEditSource: () => { edited++; }, onZoom: (current, event) => { zoomed++; current.onclick?.call(current, event); },
  });
  const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const click = (target: Element) => { const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }); target.dispatchEvent(event); return event; };
  return { dom, doc, container, image, controls, button, click, observed,
    width(value: number) { width = value; resize(); }, resize: () => resize(),
    counts: () => ({ selected, edited, zoomed, oldClicks, disconnects }),
    close() { controls.destroy(); dom.window.close(); } };
}

test('image selection precedes zoom and source action delegates without owning the renderer', () => {
  const f = setup();
  try {
    assert.equal(f.button('Zoom in').type, 'button'); assert.ok(f.button('Zoom in').querySelector('svg.lucide'));
    assert.equal(f.click(f.image).defaultPrevented, true);
    assert.deepEqual(f.counts(), { selected: 1, edited: 0, zoomed: 0, oldClicks: 0, disconnects: 0 });
    f.click(f.image);
    assert.equal(f.counts().zoomed, 1); assert.equal(f.counts().oldClicks, 1);
    f.click(f.button('Zoom in')); f.click(f.button('Edit image source'));
    assert.equal(f.counts().zoomed, 2); assert.equal(f.counts().edited, 1);
    assert.equal(f.image.getAttribute('src'), 'data:image/png,original'); assert.equal(f.image.parentElement, f.container);
    f.controls.setSelected(false); f.click(f.image); assert.equal(f.counts().selected, 2);
  } finally { f.close(); }
});

test('eight pixel toolbar placement and narrow-image gating follow displayed width and selection', () => {
  const f = setup();
  try {
    const toolbar = f.container.querySelector<HTMLElement>('.zorid-image-embed-actions')!;
    const style = () => f.dom.window.getComputedStyle(toolbar);
    assert.equal(style().top, '8px'); assert.equal(style().insetInlineEnd, '8px');
    f.width(79); assert.ok(f.container.classList.contains('zorid-image-no-hover-actions'));
    assert.equal(style().opacity, '0'); assert.equal(style().pointerEvents, 'none'); assert.equal(f.button('Edit image source').tabIndex, -1);
    f.controls.setSelected(true); assert.equal(style().opacity, '1'); assert.equal(f.button('Edit image source').tabIndex, 0);
    f.controls.setSelected(false); f.width(80); assert.equal(f.container.classList.contains('zorid-image-no-hover-actions'), false);
    assert.equal(f.button('Edit image source').tabIndex, 0);
    assert.equal(f.dom.window.getComputedStyle(f.button('Edit image source')).padding, '4px 6px');
  } finally { f.close(); }
});

test('mobile omits toolbar zoom while retaining image selection, viewing and source action', () => {
  const f = setup(true);
  try {
    assert.equal(f.container.querySelector('[aria-label="Zoom in"]'), null);
    assert.equal(f.dom.window.getComputedStyle(f.button('Edit image source')).padding, '8px');
    f.click(f.image); f.click(f.image); f.click(f.button('Edit image source'));
    assert.equal(f.counts().zoomed, 1); assert.equal(f.counts().edited, 1);
  } finally { f.close(); }
});

test('replaced direct images are adopted without taking ownership of nested images or bytes', async () => {
  const f = setup();
  try {
    const replacement = f.doc.createElement('img'); Object.defineProperty(replacement, 'offsetWidth', { value: 50 });
    const nested = f.doc.createElement('div'); nested.innerHTML = '<img>';
    f.container.replaceChildren(nested, replacement); await Promise.resolve();
    assert.equal(f.observed.has(f.image), false); assert.equal(f.observed.has(replacement), true);
    assert.equal(f.container.querySelectorAll('.zorid-image-embed-actions').length, 1);
    f.click(nested.querySelector('img')!); assert.equal(f.counts().selected, 0);
    f.click(replacement); assert.equal(f.counts().selected, 1);
    replacement.remove(); await Promise.resolve();
    assert.equal(f.button('Zoom in').hidden, true);
    assert.equal(f.observed.size, 0);
  } finally { f.close(); }
});

test('detached and destroyed controls are inert; queued observations cannot recreate their toolbar', async () => {
  const f = setup();
  try {
    const source = f.button('Edit image source'), zoom = f.button('Zoom in');
    f.container.remove(); f.click(f.image); f.click(source); assert.equal(f.counts().selected + f.counts().edited, 0);
    f.doc.body.append(f.container); f.click(f.image); assert.equal(f.counts().selected, 1);
    const nativeHandler = f.image.onclick;
    f.container.append(f.doc.createElement('span')); f.controls.destroy(); f.controls.destroy();
    f.resize(); f.controls.refresh(); f.controls.setSelected(true); await Promise.resolve();
    f.click(source); f.click(zoom); assert.equal(f.counts().edited + f.counts().zoomed, 0);
    assert.equal(f.counts().disconnects, 1); assert.equal(f.container.querySelector('.zorid-image-embed-actions'), null);
    assert.equal(f.container.classList.contains('zorid-image-selected'), false);
    assert.equal(f.image.onclick, nativeHandler); assert.equal(f.image.parentElement, f.container);
    f.click(f.image); assert.equal(f.counts().oldClicks, 1, 'shared renderer behavior is restored after helper release');
  } finally { f.close(); }
});

test('controls use the destination document without globals and preserve other event handlers', () => {
  const first = setup(), second = setup();
  try {
    assert.equal(first.button('Zoom in').ownerDocument, first.doc);
    assert.equal(second.button('Edit image source').querySelector('svg')!.ownerDocument, second.doc);
    const context = new first.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }); first.image.dispatchEvent(context);
    assert.equal(context.defaultPrevented, false);
    const prevented = new first.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }); prevented.preventDefault(); first.image.dispatchEvent(prevented);
    assert.equal(first.counts().selected, 0);
    first.click(first.image); assert.equal(first.counts().selected, 1); assert.equal(second.counts().selected, 0);
  } finally { first.close(); second.close(); }
});


test('resize capability is desktop-only and small-image corner remains reachable independently of toolbar gating', () => {
  const desktop = setup(false, true), mobile = setup(true, true);
  try {
    assert.equal(mobile.container.querySelector('.zorid-image-resize-corner'), null);
    const corner = desktop.container.querySelector<HTMLElement>('.zorid-image-resize-corner')!;
    assert.ok(corner); assert.equal(desktop.dom.window.getComputedStyle(corner).width, '30px');
    assert.equal(desktop.dom.window.getComputedStyle(corner).height, '30px');
    desktop.width(40); assert.notEqual(desktop.dom.window.getComputedStyle(corner).pointerEvents, 'none');
    assert.equal(desktop.dom.window.getComputedStyle(desktop.container.querySelector('.zorid-image-embed-actions')!).pointerEvents, 'none');
    desktop.controls.setSelected(true); assert.notEqual(desktop.dom.window.getComputedStyle(corner).pointerEvents, 'none');
    assert.equal(desktop.dom.window.getComputedStyle(corner).opacity, '1');
  } finally { desktop.close(); mobile.close(); }
});
