import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createSidebarControls } from '../src/ui/sidebar-controls.ts';

const leaf = (id: string) => `<section class="pane"><div class="tab-bar" id="${id}"><div class="tab-strip"><div class="tab" role="tab">Note</div></div><button>New</button></div><main class="content"></main></section>`;
const group = (direction: string, ...children: string[]) => `<div class="split-layout-group" data-direction="${direction}">${children.join('<div class="split-layout-separator"></div>')}</div>`;
function fixture(markup = leaf('only')) {
  const dom = new JSDOM(`<div class="workspace right-hidden"><nav class="ribbon"></nav><aside class="sidebar"><div class="sidebar-tabs"></div></aside><section class="workspace-center"><main class="panes">${markup}</main></section><aside class="right-sidebar"><div class="right-tabs"></div></aside></div>`);
  const root = dom.window.document.querySelector<HTMLElement>('.workspace')!;
  const calls: string[] = [];
  const controls = createSidebarControls(root, {
    onToggleLeft() { calls.push('left'); root.classList.toggle('left-hidden'); },
    onToggleRight() { calls.push('right'); root.classList.toggle('right-hidden'); },
  });
  return { dom, root, calls, controls, close() { controls.destroy(); dom.window.close(); } };
}

test('one persistent pair reflects host state and toggles through host callbacks', async () => {
  const f = fixture();
  try {
    const [left, right] = [...f.controls.element.querySelectorAll('button')];
    assert.equal(left.ownerDocument, f.dom.window.document);
    assert.equal(left.title, 'Collapse left sidebar');
    assert.equal(left.getAttribute('aria-expanded'), 'true');
    assert.equal(right.title, 'Expand right sidebar');
    left.click(); right.click();
    assert.deepEqual(f.calls, ['left', 'right']);
    assert.equal(left.getAttribute('aria-expanded'), 'false');
    assert.equal(right.getAttribute('aria-expanded'), 'true');
    f.root.classList.remove('left-hidden');
    await Promise.resolve();
    assert.equal(left.title, 'Collapse left sidebar');
    assert.equal(left.getAttribute('data-window-no-drag'), '');
    assert.equal(f.controls.element.parentElement, f.root);
    assert.equal(f.root.querySelectorAll('.workspace-sidebar-toggle').length, 2);
  } finally { f.close(); }
});

test('only outer top-row headers reserve edge space through mixed nested splits', () => {
  const f = fixture(group('vertical', group('horizontal', leaf('left-top'), leaf('left-bottom')), group('horizontal', group('vertical', leaf('middle-top'), leaf('right-top')), leaf('right-bottom'))));
  try {
    const ids = (selector: string) => [...f.root.querySelectorAll(selector)].map(node => node.id);
    assert.deepEqual(ids('.tab-bar[data-window-drag-region]'), ['left-top', 'middle-top', 'right-top']);
    assert.deepEqual(ids('[data-chrome-edge-left]'), ['left-top']);
    assert.deepEqual(ids('[data-chrome-edge-right]'), ['right-top']);
    assert.equal(f.root.querySelector('.sidebar-tabs')?.hasAttribute('data-window-drag-region'), true);
    assert.equal(f.root.querySelector('.right-tabs')?.hasAttribute('data-window-drag-region'), true);
  } finally { f.close(); }
});

test('split replacement and direction changes refresh markers without recreating controls', async () => {
  const f = fixture(group('horizontal', leaf('first'), leaf('last')));
  try {
    const buttons = [...f.controls.element.children];
    const split = f.root.querySelector<HTMLElement>('.split-layout-group')!;
    split.dataset.direction = 'vertical';
    await Promise.resolve();
    assert.equal(f.root.querySelector('[data-chrome-edge-right]')?.id, 'last');
    f.root.querySelector('.panes')!.innerHTML = leaf('replacement');
    await Promise.resolve();
    assert.equal(f.root.querySelector('[data-chrome-edge-left]')?.id, 'replacement');
    assert.equal(f.root.querySelector('[data-chrome-edge-right]')?.id, 'replacement');
    assert.deepEqual([...f.controls.element.children], buttons);
  } finally { f.close(); }
});

test('destroy and detached shell prevent retained callbacks and remove owned markers', async () => {
  const f = fixture();
  try {
    const left = f.controls.element.querySelector('button')!;
    f.controls.element.remove(); left.click();
    assert.deepEqual(f.calls, []);
    f.root.append(f.controls.element);
    f.controls.destroy(); f.controls.destroy(); left.click();
    f.root.classList.add('left-hidden');
    await Promise.resolve();
    assert.deepEqual(f.calls, []);
    assert.equal(f.root.querySelector('[data-window-drag-region]'), null);
    assert.equal(f.root.classList.contains('has-sidebar-controls'), false);
  } finally { f.close(); }
});

test('desktop CSS keeps controls outside scrolling and makes only header whitespace draggable', () => {
  const dom = new JSDOM('<head></head>');
  try {
    const style = dom.window.document.createElement('style');
    style.textContent = readFileSync(new URL('../src/ui/sidebar-controls.css', import.meta.url), 'utf8');
    dom.window.document.head.append(style);
    const media = [...style.sheet!.cssRules].find(rule => rule.type === 4) as CSSMediaRule;
    assert.equal(media.conditionText, '(min-width: 701px)');
    const rules = [...media.cssRules] as CSSStyleRule[];
    const rule = (selector: string) => rules.find(rule => rule.selectorText === selector)!.style;
    assert.equal(rule('.workspace-sidebar-controls').getPropertyValue('pointer-events'), 'none');
    // A no-drag rectangle spanning the overlay would cancel native dragging.
    assert.equal(rule('.workspace-sidebar-controls').getPropertyValue('-webkit-app-region'), '');
    assert.equal(rule('.workspace-sidebar-controls > .workspace-sidebar-toggle').getPropertyValue('pointer-events'), 'auto');
    assert.equal(rule('.workspace.has-sidebar-controls .tab-bar').overflow, 'hidden');
    assert.equal(rule('.workspace.has-sidebar-controls .tab-strip').getPropertyValue('overflow-x'), 'auto');
    assert.equal(rule('.workspace-sidebar-toggle.is-left').getPropertyValue('inset-inline-start'), 'var(--sidebar-control-left-space)');
    assert.equal(rule('.workspace-sidebar-toggle.is-right').getPropertyValue('inset-inline-end'), 'var(--sidebar-control-gap)');
    assert.ok(rules.some(rule => rule.selectorText.includes('[data-window-drag-region]') && rule.style.getPropertyValue('-webkit-app-region') === 'drag'));
    assert.ok(rules.some(rule => rule.selectorText.includes('[role="tab"]') && rule.style.getPropertyValue('-webkit-app-region') === 'no-drag'));
  } finally { dom.window.close(); }
});
