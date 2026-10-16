import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { startCompletion } from '@codemirror/autocomplete';
import { wikiCompletion } from '../src/editor/wiki-completion.ts';
import type { WikiCompletionOptions } from '../src/editor/wiki-completion.ts';

async function setup(t: TestContext, query: string, options: WikiCompletionOptions) {
  const dom = new JSDOM('<!doctype html><head></head><body><main class="editor-host"></main></body>', { pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, Text: dom.window.Text, Window: dom.window.Window,
    MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) };
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const doc = dom.window.document;
  let wikiStyle!: HTMLStyleElement;
  for (const file of ['../src/ui/styles.css', '../src/ui/reference-defaults.css', '../src/editor/wiki-completion.css']) {
    const style = doc.createElement('style'); style.textContent = readFileSync(new URL(file, import.meta.url), 'utf8'); doc.head.append(style); wikiStyle = style;
  }
  dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} });
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const text = `[[${query}`;
  const view = new EditorView({ parent: doc.querySelector('main')!, state: EditorState.create({ doc: text, selection: { anchor: text.length }, extensions: [markdown(), wikiCompletion(options)] }) });
  t.after(() => { view.destroy(); dom.window.close(); for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  view.focus(); startCompletion(view);
  const deadline = Date.now() + 2000;
  while (!doc.querySelector('.wiki-suggestion-instructions')) { assert.ok(Date.now() < deadline, 'popup timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
  return { dom, doc, view, wikiStyle, popup: doc.querySelector<HTMLElement>('.cm-wiki-completion')! };
}

// jsdom does not implement the full CSS specificity/important cascade. Compare
// matching flat selectors from the actual generated CM and application sheets,
// then use computed metrics with the application sheet last. These selectors
// have no :is/:where/nesting; reject unsupported syntax rather than mis-rank it.
function winner(doc: Document, element: Element, property: string): string {
  const declarations: { value: string; rank: number[] }[] = [];
  let order = 0;
  for (const sheet of doc.styleSheets) for (const rule of sheet.cssRules) {
    const styleRule = rule as CSSStyleRule;
    if (!styleRule.selectorText || !element.matches(styleRule.selectorText)) continue;
    for (const selector of styleRule.selectorText.split(',')) {
      order++;
      let matches: boolean;
      try { matches = element.matches(selector); } catch (error) { throw new Error(`Unsupported matcher selector ${selector}: ${error}`); }
      if (!matches) continue;
      const value = styleRule.style.getPropertyValue(property); if (!value) continue;
      assert.ok(!selector.includes(':'), `unsupported specificity selector: ${selector}`);
      const withoutAttributes = selector.replace(/\[[^\]]*\]/g, '');
      const rank = [styleRule.style.getPropertyPriority(property) === 'important' ? 1 : 0,
        (withoutAttributes.match(/#[^\s.#>+~]+/g) ?? []).length,
        (withoutAttributes.match(/\.[^\s.#>+~]+/gu) ?? []).length + (selector.match(/\[/g) ?? []).length,
        (withoutAttributes.replace(/[.#][^\s.#>+~]+/gu, '').match(/[a-z][\w-]*/gi) ?? []).length, order];
      declarations.push({ value, rank });
    }
  }
  declarations.sort((a, b) => { for (let i = 0; i < a.rank.length; i++) if (a.rank[i] !== b.rank[i]) return b.rank[i] - a.rank[i]; return 0; });
  assert.ok(declarations.length, `no declaration for ${property}`); return declarations[0].value;
}

test('wiki styles beat actual generated CM list/row rules and retain the intended dimensions', async t => {
  const { doc, popup, wikiStyle } = await setup(t, 'Al', { paths: () => ['Folder/Alpha.md'] });
  const list = popup.querySelector('ul')!, row = list.querySelector('li')!;
  for (const [element, property, expected] of [
    [list, 'font-family', 'inherit'], [list, 'padding', '6px'], [list, 'min-width', '0'],
    [list, 'max-height', 'none'], [list, 'height', 'auto'], [row, 'padding', '6px 12px'],
    [row, 'line-height', '1.3'], [row, 'cursor', 'default'],
    [row, 'background', 'var(--background-modifier-hover)'], [row, 'color', 'var(--text-normal)'],
  ] as const) assert.equal(winner(doc, element, property), expected, property);
  // Move our stylesheet ahead of every generated rule: precedence must survive.
  doc.head.prepend(wikiStyle);
  assert.equal(winner(doc, row, 'padding'), '6px 12px'); assert.equal(winner(doc, list, 'font-family'), 'inherit');
  doc.head.append(wikiStyle);
  assert.equal(doc.defaultView!.getComputedStyle(list).padding, '6px');
  assert.equal(doc.defaultView!.getComputedStyle(row).padding, '6px 12px');
  assert.equal(doc.defaultView!.getComputedStyle(row).lineHeight, '1.3');
  assert.equal(doc.defaultView!.getComputedStyle(list).maxHeight, 'none');
  assert.equal(doc.defaultView!.getComputedStyle(popup).maxHeight, '300px');
  assert.equal(popup.querySelector('input'), null, 'wiki popup has no search header');
  assert.equal(popup.querySelectorAll('.wiki-suggestion-instructions > span').length, 3);
  const command = popup.querySelector('.wiki-suggestion-instructions b')!;
  assert.equal(winner(doc, command, 'margin-inline-end'), '4px');
});

test('folder and title highlights split correctly at Unicode path boundaries without interpreting markup', async t => {
  const { popup } = await setup(t, '😀/Al', { paths: () => ['研究/😀/Alpha<img>.md'] });
  assert.equal(popup.querySelector('.wiki-suggestion-note')!.textContent, '研究/😀/');
  assert.equal(popup.querySelector('.wiki-suggestion-note strong')!.textContent, '😀/');
  assert.equal(popup.querySelector('.wiki-suggestion-title')!.textContent, 'Alpha<img>');
  assert.equal(popup.querySelector('.wiki-suggestion-title strong')!.textContent, 'Al');
  assert.equal(popup.querySelector('img'), null);
});

test('aliases use a document-owned SVG auxiliary flair and keep selected ignored rows muted', async t => {
  const { doc, popup } = await setup(t, 'First', { paths: () => ['Folder/Alpha.md'], metadata: () => ({ aliases: ['First'], ignored: true }) });
  assert.equal(popup.querySelector('.wiki-suggestion-note')!.textContent, 'Folder/Alpha');
  const flair = popup.querySelector('.wiki-suggestion-aux .wiki-suggestion-flair')!;
  assert.equal(flair.getAttribute('aria-label'), 'Alias'); assert.equal(flair.textContent, '');
  const svg = flair.querySelector('svg')!;
  assert.equal(svg.ownerDocument, doc); assert.equal(svg.getAttribute('width'), '16'); assert.equal(svg.getAttribute('stroke-width'), '2');
  assert.ok(svg.children.length); assert.equal(winner(doc, popup.querySelector('li')!, 'color'), 'var(--text-muted)');
});

test('empty display labels use the faint placeholder and only the accept instruction', async t => {
  const { popup } = await setup(t, 'Alpha|', { paths: () => ['Alpha.md'] });
  assert.equal(popup.querySelector('.wiki-suggestion-placeholder')!.textContent, 'Display text');
  assert.equal(popup.querySelector('.wiki-suggestion-instructions')!.textContent, '↵to accept');
  assert.equal(popup.querySelectorAll('.wiki-suggestion-instructions > span').length, 1);
});

test('global heading rows retain file context and level flair without an alias icon', async t => {
  const { popup } = await setup(t, '##Over', { paths: () => ['Folder/Alpha.md'], metadata: () => ({ headings: [{ heading: 'Overview', level: 2 }] }) });
  assert.equal(popup.querySelector('.wiki-suggestion-title')!.textContent, 'Overview');
  assert.equal(popup.querySelector('.wiki-suggestion-title strong')!.textContent, 'Over');
  assert.equal(popup.querySelector('.wiki-suggestion-note')!.textContent, 'Folder/Alpha');
  assert.equal(popup.querySelector('.wiki-suggestion-aux')!.textContent, 'H2');
  assert.equal(popup.querySelector('svg'), null);
  assert.equal(popup.querySelectorAll('.wiki-suggestion-instructions > span').length, 1);
});

test('empty heading fallback uses the faint heading placeholder', async t => {
  const { popup } = await setup(t, 'Alpha#', { paths: () => ['Alpha.md'] });
  assert.equal(popup.querySelector('.wiki-suggestion-placeholder')!.textContent, 'Heading');
});

test('case-fold expansion preserves original UTF-16 folder and title highlight offsets', async t => {
  const { popup } = await setup(t, '/Al', { paths: () => ['İ/Alpha.md'] });
  assert.equal(popup.querySelector('.wiki-suggestion-note')!.textContent, 'İ/');
  assert.equal(popup.querySelector('.wiki-suggestion-note strong')!.textContent, '/');
  assert.equal(popup.querySelector('.wiki-suggestion-title strong')!.textContent, 'Al');
});

test('case-fold expansion also preserves title-only and noncontiguous matches', async t => {
  const { popup } = await setup(t, 'itl', { paths: () => ['İstanbul.md'] });
  assert.equal(popup.querySelector('.wiki-suggestion-title')!.textContent, 'İstanbul');
  assert.deepEqual([...popup.querySelectorAll('.wiki-suggestion-title strong')].map(node => node.textContent), ['İ', 't', 'l']);
});
