import { icon } from './dom.ts';
import { codeTokenColor, codeLanguage, defaultCodeHighlighter, validTokens } from '../editor/code-highlight.ts';
import type { CodeHighlightOptions, CodeToken } from '../editor/code-highlight.ts';

export interface CodeBlockHandle { readonly element: HTMLPreElement; readonly ready: Promise<void>; destroy(): void }
const owners = new WeakMap<Element, CodeBlockHandle>();
/** Call before a Reading container is replaced or detached, including nested code blocks. */
export function destroyCodeBlocks(container: HTMLElement): void {
  owners.get(container)?.destroy();
  for (const block of container.querySelectorAll('.zorid-code-block')) owners.get(block)?.destroy();
}
export function createCodeCopyButton(document: Document, source: () => string | null, options: CodeHighlightOptions = {}, label = ''): { element: HTMLButtonElement; destroy(): void } {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'zorid-code-copy'; button.title = 'Copy'; button.setAttribute('aria-label', 'Copy code');
  let closed = false, operation = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const restore = () => { if (closed) return; button.classList.remove('is-copied', 'is-error'); button.replaceChildren(label ? document.createTextNode(label) : icon('copy', 16, document)); button.setAttribute('aria-label', 'Copy code'); };
  restore();
  button.onmousedown = event => { if (event.button === 0) event.preventDefault(); };
  button.onclick = async event => {
    event.preventDefault(); event.stopPropagation(); if (closed) return;
    const text = source(); if (text === null) return;
    const version = ++operation;
    try {
      const copy = options.copyText ?? (document.defaultView?.navigator.clipboard ? (value: string) => document.defaultView!.navigator.clipboard.writeText(value) : undefined);
      if (!copy) throw new Error('Clipboard unavailable');
      await copy(text);
      if (closed || version !== operation) return;
      clearTimeout(timer); button.replaceChildren(icon('check', 16, document)); button.classList.add('is-copied'); button.setAttribute('aria-label', 'Copied'); timer = setTimeout(restore, 1000);
    } catch (error) {
      if (closed || version !== operation) return;
      button.classList.add('is-error'); button.setAttribute('aria-label', 'Unable to copy code');
      try { options.onError?.(error); } catch { /* Observers cannot escape DOM event handlers. */ }
    }
  };
  return { element: button, destroy() { closed = true; operation++; clearTimeout(timer); button.onclick = null; button.onmousedown = null; } };
}
function applyTokens(container: HTMLElement, source: string, tokens: readonly CodeToken[]): void {
  const document = container.ownerDocument, fragment = document.createDocumentFragment(); let offset = 0;
  for (const token of validTokens(tokens, source.length).slice().sort((a, b) => a.from - b.from)) {
    if (token.from < offset) continue;
    fragment.append(document.createTextNode(source.slice(offset, token.from)));
    const span = document.createElement('span'); span.className = ['zorid-code-token', ...token.classes.map(name => `token-${name}`)].join(' '); span.style.color = codeTokenColor(token.classes); span.textContent = source.slice(token.from, token.to); fragment.append(span); offset = token.to;
  }
  fragment.append(document.createTextNode(source.slice(offset))); container.replaceChildren(fragment);
}
/** Safe reading-mode DOM. Highlight work starts only when the block intersects the viewport. */
export function appendCodeBlock(parent: HTMLElement, source: string, info = '', options: CodeHighlightOptions = {}): CodeBlockHandle {
  const document = parent.ownerDocument, pre = document.createElement('pre'), code = document.createElement('code'), language = codeLanguage(info);
  pre.className = 'zorid-code-block'; code.textContent = source; code.dataset.language = language;
  const abort = new AbortController(), copy = createCodeCopyButton(document, () => closed ? null : source, options);
  let closed = false, started = false, settle!: () => void, observer: IntersectionObserver | undefined;
  const ready = new Promise<void>(resolve => { settle = resolve; });
  const start = () => {
    if (closed || started) return; started = true; observer?.disconnect();
    if (!language) { settle(); return; }
    void Promise.resolve().then(() => {
      if (closed) return [];
      const highlight = options.highlight ?? defaultCodeHighlighter(document); return highlight(source, language, abort.signal);
    }).then(tokens => {
      if (!closed && !abort.signal.aborted && pre.parentNode === parent) { applyTokens(code, source, tokens); code.classList.add('is-highlighted'); }
    }).catch(error => { if (!closed && !abort.signal.aborted) { try { options.onError?.(error); } catch { /* Preserve literal code on engine failure. */ } } }).finally(settle);
  };
  pre.append(code, copy.element); parent.append(pre);
  const Observer = document.defaultView?.IntersectionObserver;
  if (Observer) { observer = new Observer(entries => { if (entries.some(entry => entry.isIntersecting)) start(); }); observer.observe(pre); } else start();
  const handle = { element: pre, ready, destroy() { if (closed) return; closed = true; observer?.disconnect(); abort.abort(); copy.destroy(); owners.delete(pre); settle(); } };
  owners.set(pre, handle); return handle;
}

export interface FencedBlock { code: string; info: string; endLine: number; closed: boolean }
/** Top-level Reading adapter. Recursive list/quote renderers should pass their own parsed block content. */
export function readCodeFence(lines: readonly string[], start: number): FencedBlock | null {
  const opening = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(lines[start] ?? '');
  if (!opening || opening[2][0] === '`' && opening[3].includes('`')) return null;
  const indent = opening[1].length, marker = opening[2][0], count = opening[2].length, content: string[] = [];
  for (let line = start + 1; line < lines.length; line++) {
    const close = /^( {0,3})(`+|~+)[ \t]*$/.exec(lines[line]);
    if (close && close[2][0] === marker && close[2].length >= count) return { code: content.join('\n'), info: opening[3].trim(), endLine: line, closed: true };
    const padding = /^ */.exec(lines[line])![0].length; content.push(lines[line].slice(Math.min(indent, padding)));
  }
  return { code: content.join('\n'), info: opening[3].trim(), endLine: lines.length - 1, closed: false };
}
