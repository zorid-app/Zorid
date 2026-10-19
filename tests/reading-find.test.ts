import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { SearchQuery } from '@codemirror/search';
import { createReadingFind } from '../src/ui/reading-find.ts';

class TestHighlight extends Set<Range> { priority = 0; }
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function setup(t: TestContext, html: string, supported = true) {
  const dom = new JSDOM('<!doctype html><div id="host"></div><article tabindex="-1"></article>', { pretendToBeVisual: true });
  const doc = dom.window.document, preview = doc.querySelector('article')!, host = doc.querySelector<HTMLElement>('#host')!;
  preview.innerHTML = html;
  const registry = new Map<string, TestHighlight>();
  if (supported) { Object.defineProperty(dom.window, 'CSS', { value: { highlights: registry } }); Object.defineProperty(dom.window, 'Highlight', { value: TestHighlight }); }
  let current = true, focuses = 0, scrolls = 0;
  dom.window.HTMLElement.prototype.scrollIntoView = () => { scrolls++; };
  const find = createReadingFind(host, preview, { isCurrent: () => current, returnFocus: () => { focuses++; preview.focus(); } });
  t.after(() => { find.destroy(); dom.window.close(); });
  const field = host.querySelector<HTMLInputElement>('input[name="search"]')!;
  const input = (value: string) => { field.value = value; field.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true })); };
  const count = () => host.querySelector('.zorid-find-count')!.textContent;
  const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const option = (name: string, value: boolean) => { const node = host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!; node.checked = value; node.dispatchEvent(new dom.window.Event('change', { bubbles: true })); };
  const press = (target: Element, key: string, extra: KeyboardEventInit = {}) => { const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }); target.dispatchEvent(event); return event; };
  const highlights = (active = false) => [...registry].filter(([name]) => name.endsWith('-active') === active).flatMap(([, value]) => [...value]);
  return { dom, doc, preview, host, registry, find, field, input, count, button, option, press, highlights, focuses: () => focuses, scrolls: () => scrolls, current: (value: boolean) => { current = value; } };
}

test('Reading find highlights own rendered text across inline nodes without replacing DOM, selection or links', async t => {
  const f = setup(t, '<p>al<em>ph</em>a <a href="#target">alpha</a> 😀</p><pre><code>alpha</code><button>alpha</button></pre><div class="internal-embed"><p>alpha</p></div><p hidden>alpha</p><p aria-hidden="true">alpha</p><input value="alpha"><div class="cm-editor">alpha</div>');
  const nodes = [...f.preview.querySelectorAll('*')], text = f.preview.firstChild!.firstChild!;
  const range = f.doc.createRange(); range.setStart(text, 0); range.setEnd(text, 2); f.doc.getSelection()!.addRange(range);
  f.find.open(); await settle(); f.input('alpha');
  assert.equal(f.count(), '0 / 3'); assert.deepEqual(f.highlights().map(range => range.toString()), ['al', 'ph', 'a', 'alpha', 'alpha']);
  assert.deepEqual([...f.preview.querySelectorAll('*')], nodes); assert.equal(f.preview.querySelector('mark'), null);
  assert.equal(range.startContainer, text); assert.equal(range.startOffset, 0); assert.equal(f.preview.querySelector('a')!.getAttribute('href'), '#target');
  f.button('Next match').click(); assert.equal(f.count(), '1 / 3'); assert.deepEqual(f.highlights(true).map(range => range.toString()), ['al', 'ph', 'a']);
  assert.equal(f.doc.activeElement, f.field); assert.equal(f.scrolls(), 1);
  f.find.close(); assert.equal(f.registry.size, 0); assert.equal(f.doc.querySelectorAll('style[data-reading-find]').length, 0); assert.equal(f.doc.activeElement, f.preview); assert.equal(f.doc.getSelection()!.toString(), 'al');
});

test('navigation wraps, keyboard/pointer focus is retained, and options really change results', async t => {
  const f = setup(t, '<p>cat Cat concatenate cat</p>'); f.find.open(); await settle(); f.input('cat');
  assert.equal(f.count(), '0 / 4'); f.option('word', true); assert.equal(f.count(), '0 / 3'); f.option('case', true); assert.equal(f.count(), '0 / 2');
  f.press(f.field, 'Enter'); assert.equal(f.count(), '1 / 2'); f.press(f.field, 'F3'); assert.equal(f.count(), '2 / 2');
  f.press(f.field, 'g', { ctrlKey: true }); assert.equal(f.count(), '1 / 2'); f.press(f.field, 'Enter', { shiftKey: true }); assert.equal(f.count(), '2 / 2');
  const down = new f.dom.window.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }); f.button('Next match').dispatchEvent(down); assert.equal(down.defaultPrevented, true);
  f.button('Search options').click(); assert.equal(f.button('Search options').getAttribute('aria-expanded'), 'true');
  f.option('word', false); f.option('regexp', true); f.input('C.t|cat'); assert.equal(f.count(), '0 / 4');
  f.input('['); assert.equal(f.count(), 'Invalid regex'); assert.equal(f.field.getAttribute('aria-invalid'), 'true'); assert.equal(f.button('Next match').disabled, true);
  f.input('absent'); assert.equal(f.count(), '0 / 0');
  assert.equal(f.press(f.field, 'Escape').defaultPrevented, true); assert.equal(f.doc.activeElement, f.preview);
});

test('block boundaries, closed details and hidden callouts are rendered text, not source or foreign content', async t => {
  const f = setup(t, '<p>one</p><p>two</p><details><summary>own title</summary><p>secret</p></details><div class="callout"><div role="button">own title</div><div hidden>secret</div></div>');
  f.find.open(); await settle(); f.input('onetwo'); assert.equal(f.count(), '0 / 0'); f.input('own title'); assert.equal(f.count(), '0 / 2');
  f.input('secret'); assert.equal(f.count(), '0 / 0'); f.preview.querySelector('details')!.open = true; await settle(); assert.equal(f.count(), '0 / 1');
  f.option('regexp', true); f.input('one\\ntwo'); assert.equal(f.count(), '0 / 1'); assert.deepEqual(f.highlights().map(range => range.toString()), ['one', 'two']);
});

test('rerender and async code tokenization release old ranges, preserve composition and search the replacement preview', async t => {
  const f = setup(t, '<pre><code>cat cat</code></pre>'); f.find.open(); await settle(); f.input('cat');
  const old = f.highlights()[0].startContainer;
  f.field.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart', { bubbles: true })); f.field.value = '猫';
  f.field.dispatchEvent(new f.dom.window.InputEvent('input', { bubbles: true, isComposing: true }));
  f.preview.innerHTML = '<p>猫 猫</p>'; f.find.refresh(); await settle(); assert.equal(f.field.value, '猫'); assert.equal(f.count(), '0 / 0');
  assert.ok(f.highlights().every(range => range.startContainer !== old)); f.press(f.field, 'Enter', { isComposing: true }); assert.equal(f.count(), '0 / 0');
  f.field.dispatchEvent(new f.dom.window.CompositionEvent('compositionend', { bubbles: true })); assert.equal(f.count(), '0 / 2');
  f.preview.firstChild!.firstChild!.textContent = '猫'; await settle(); assert.equal(f.count(), '0 / 1');
});

test('large supported four-MiB notes skip automatic counts but retain explicit next/previous navigation', async t => {
  const original = SearchQuery.prototype.getCursor; let scans = 0;
  SearchQuery.prototype.getCursor = function (...args) { scans++; return original.apply(this, args); };
  t.after(() => { SearchQuery.prototype.getCursor = original; });
  const f = setup(t, ''); f.preview.textContent = 'x'.repeat(4 * 1024 * 1024) + ' needle';
  f.find.open(); await settle(); f.input('needle'); assert.equal(scans, 0); assert.equal(f.count(), '0 / —'); assert.equal(f.button('Next match').disabled, false);
  f.button('Next match').click(); assert.equal(scans, 1); assert.deepEqual(f.highlights(true).map(range => range.toString()), ['needle']);
  f.button('Previous match').click(); assert.equal(scans, 2); assert.deepEqual(f.highlights(true).map(range => range.toString()), ['needle']);
  f.input('absent'); assert.equal(scans, 2); f.button('Next match').click(); assert.equal(f.count(), '0 / 0'); assert.equal(f.button('Next match').disabled, true);
});

test('occurrence limits are honest and explicit navigation still reaches matches beyond counted prefix', async t => {
  const f = setup(t, 'a '.repeat(10_002)); f.find.open(); await settle(); f.input('a'); assert.equal(f.count(), '0 / 10,000+');
  f.button('Previous match').click(); assert.equal(f.count(), '— / 10,000+'); assert.equal(f.highlights(true)[0].startOffset, 20_002);
});

test('independent panes own separate registry entries; close and destroy never clear another pane', async t => {
  const f = setup(t, '<p>cat</p>'), host = f.doc.createElement('div'), preview = f.doc.createElement('div'); preview.textContent = 'dog'; f.doc.body.append(host, preview);
  const other = createReadingFind(host, preview, { isCurrent: () => true, returnFocus() {} }); t.after(() => other.destroy());
  f.find.open(); other.open(); await settle(); f.input('cat'); const field = host.querySelector('input')!; field.value = 'dog'; field.dispatchEvent(new f.dom.window.Event('input'));
  assert.equal(f.registry.size, 4); const names = [...f.registry.keys()]; f.find.close(); assert.equal(f.registry.size, 2); assert.ok([...f.registry.keys()].every(name => names.includes(name)));
  field.focus(); other.destroy(); assert.equal(f.registry.size, 0); assert.equal(f.doc.querySelectorAll('style[data-reading-find]').length, 0); assert.equal(f.focuses(), 0);
  const retained = f.button('Next match'); f.find.destroy(); assert.doesNotThrow(() => retained.click());
});

test('yielded projection is fenced after rerender/destroy and never repaints detached old nodes', async t => {
  const f = setup(t, '<span>old</span>'.repeat(1500)), pending: (() => void)[] = [];
  f.dom.window.setTimeout = ((callback: () => void) => { pending.push(callback); return pending.length; }) as typeof f.dom.window.setTimeout;
  f.find.open(); assert.equal(f.count(), 'Searching…'); assert.equal(pending.length, 1);
  f.preview.textContent = 'new'; f.find.refresh(); await settle(); f.input('new'); assert.equal(f.count(), '0 / 1');
  pending.shift()!(); await settle(); assert.equal(f.count(), '0 / 1'); assert.equal(f.highlights()[0].toString(), 'new');
  f.preview.innerHTML = '<span>late</span>'.repeat(1500); f.find.refresh(); assert.ok(pending.length); f.find.destroy(); while (pending.length) pending.shift()!(); await settle();
  assert.equal(f.registry.size, 0); assert.equal(f.doc.querySelectorAll('style[data-reading-find]').length, 0); assert.equal(f.focuses(), 0);
});

test('unsupported highlighting and over-budget projection fail plainly without false EOF or DOM mutation', async t => {
  const f = setup(t, '<p>own text</p>', false), html = f.preview.innerHTML; f.find.open(); await settle(); f.input('text');
  assert.equal(f.count(), 'Find unavailable'); assert.match(f.host.querySelector('.zorid-find-count')!.getAttribute('aria-label')!, /this browser/); assert.equal(f.preview.innerHTML, html);
  const large = setup(t, ''); large.preview.textContent = 'x'.repeat(16 * 1024 * 1024 + 250_001); large.find.open(); await settle(); large.input('x');
  assert.equal(large.count(), 'Find unavailable'); assert.equal(large.button('Next match').disabled, true); assert.match(large.host.querySelector('.zorid-find-count')!.getAttribute('aria-label')!, /very large note/);
});

test('parked/stale ownership clears ranges and refuses retained controls, then reprojects on reattachment', async t => {
  const f = setup(t, '<p>cat</p>'); f.find.open(); await settle(); f.input('cat'); const retained = f.button('Next match');
  f.current(false); f.find.refresh(); assert.equal(f.registry.size, 0); retained.click(); assert.equal(f.registry.size, 0);
  f.current(true); f.find.refresh(); await settle(); assert.equal(f.count(), '0 / 1'); retained.click(); assert.equal(f.count(), '1 / 1');
});

test('counted navigation and options disclosure reuse cached matches and base DOM ranges', async t => {
  const original = SearchQuery.prototype.getCursor; let scans = 0;
  SearchQuery.prototype.getCursor = function (...args) { scans++; return original.apply(this, args); };
  t.after(() => { SearchQuery.prototype.getCursor = original; });
  const f = setup(t, '<p>cat cat cat</p>'); f.find.open(); await settle(); f.input('cat'); assert.equal(scans, 1);
  const base = [...f.registry].find(([name]) => !name.endsWith('-active'))![1];
  f.button('Next match').click(); f.button('Previous match').click(); f.button('Search options').click();
  assert.equal(scans, 1); assert.equal([...f.registry].find(([name]) => !name.endsWith('-active'))![1], base);
  assert.equal(f.count(), '3 / 3'); f.input('dog'); assert.equal(scans, 2);
});

test('navigation reveals the actual DOM Range inside a long block, rather than centering the whole block', async t => {
  const f = setup(t, '<p>start needle end</p>'), scroller = f.doc.createElement('div'); scroller.className = 'note-scroll'; f.doc.body.append(scroller); scroller.append(f.preview);
  const rect = { top: 300, left: 0, right: 20, bottom: 320, height: 20, width: 20, x: 0, y: 300, toJSON() {} };
  f.dom.window.Range.prototype.getBoundingClientRect = () => rect;
  scroller.getBoundingClientRect = () => ({ ...rect, top: 0, bottom: 100, height: 100 });
  f.find.open(); await settle(); f.input('needle'); f.button('Next match').click(); assert.equal(scroller.scrollTop, 260); assert.equal(f.scrolls(), 0);
});


test('unexpected projection failure settles to plain retry guidance without exposing technical errors', async t => {
  const f = setup(t, '<p>text</p>'), original = f.preview.matches, errors: unknown[][] = [], log = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); }; t.after(() => { console.error = log; });
  f.preview.matches = () => { throw new Error('secret engine stack'); };
  // The projection does not filter its own root, so fail an owned child instead.
  const child = f.preview.firstElementChild!; child.matches = f.preview.matches;
  f.find.open(); await settle(); assert.equal(f.count(), 'Find unavailable'); assert.match(f.host.querySelector('.zorid-find-count')!.getAttribute('aria-label')!, /Close and reopen/);
  assert.doesNotMatch(f.host.textContent!, /secret engine/); assert.equal(errors.length, 1); assert.equal(f.registry.size, 0);
  child.matches = original; f.find.close(); f.find.open(); await settle(); f.input('text'); assert.equal(f.count(), '0 / 1');
});
