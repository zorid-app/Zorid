/** Prism token ranges use source offsets; no highlighted HTML crosses the boundary. */
export interface CodeToken { from: number; to: number; classes: readonly string[] }
export type CodeHighlighter = (source: string, language: string, signal?: AbortSignal) => Promise<readonly CodeToken[]>;
export interface CodeHighlightOptions { highlight?: CodeHighlighter; copyText?: (text: string) => void | Promise<void>; onError?: (error: unknown) => void }

/** The first info-string word selects a grammar. The remainder stays source metadata. */
export function codeLanguage(info: string): string { return info.trim().split(/\s/, 1)[0].toLowerCase(); }
export function codeCopyText(source: string): string { return source.endsWith('\n') ? source.slice(0, -1) : source; }
export function validTokens(tokens: readonly CodeToken[], length: number): readonly CodeToken[] {
  return tokens.filter(token => Number.isInteger(token.from) && Number.isInteger(token.to) && token.from >= 0 && token.to > token.from && token.to <= length)
    .map(token => ({ ...token, classes: token.classes.filter(name => /^[\w-]+$/.test(name)) })).sort((a, b) => a.from - b.from);
}

const tokenColors: Record<string, string> = {
  comment: 'comment', prolog: 'comment', doctype: 'comment', cdata: 'comment',
  tag: 'tag', constant: 'tag', symbol: 'tag', deleted: 'tag', punctuation: 'punctuation',
  boolean: 'value', number: 'value', selector: 'string', 'attr-name': 'string', string: 'string', char: 'string', inserted: 'string',
  operator: 'operator', entity: 'property', parameter: 'property', property: 'property', url: 'property', variable: 'property',
  atrule: 'keyword', 'attr-value': 'keyword', builtin: 'keyword', 'class-name': 'keyword', keyword: 'keyword',
  function: 'function', important: 'important', regex: 'important',
};
const codeFallbacks: Record<string, string> = {
  comment: 'var(--text-faint)', punctuation: 'var(--text-muted)', tag: 'var(--color-red, #fb464c)',
  value: 'var(--color-purple, #a882ff)', string: 'var(--color-green, #44cf6e)', operator: 'var(--color-red, #fb464c)',
  property: 'var(--color-cyan, #53dfdd)', keyword: 'var(--color-pink, #fa99cd)', function: 'var(--color-yellow, #e0de71)', important: 'var(--color-orange, #e9973f)',
};
/** Flat source runs still inherit the innermost Prism token's color, not CSS rule order. */
export function codeTokenColor(classes: readonly string[]): string {
  for (let index = classes.length - 1; index >= 0; index--) {
    const name = classes[index];
    if (Object.hasOwn(tokenColors, name)) return `var(--code-${tokenColors[name]}, ${codeFallbacks[tokenColors[name]]})`;
  }
  return '';
}

interface Job { id: number; source: string; language: string; resolve: (tokens: readonly CodeToken[]) => void; reject: (error: unknown) => void; signal?: AbortSignal; abort: () => void }
/** One lazy worker per page. An aborted active regex is terminated, not merely ignored. */
export function createCodeHighlighter(engineURL: string, createWorker: () => Worker = () => new Worker(new URL('./prism-worker.ts', import.meta.url))): CodeHighlighter & { destroy(): void } {
  let worker: Worker | undefined, active: Job | undefined, nextId = 0, timer: ReturnType<typeof setTimeout> | undefined, closed = false;
  const queue: Job[] = [];
  const reset = () => { clearTimeout(timer); worker?.terminate(); worker = undefined; };
  const complete = (error?: unknown, tokens: readonly CodeToken[] = []) => {
    const job = active; active = undefined; clearTimeout(timer);
    if (job) { job.signal?.removeEventListener('abort', job.abort); if (error) job.reject(error); else job.resolve(validTokens(tokens, job.source.length)); }
    pump();
  };
  const pump = () => {
    if (closed || active || !queue.length) return;
    active = queue.shift()!;
    try {
      if (!worker) {
        worker = createWorker(); const ownedWorker = worker;
        worker.onmessage = event => {
          const response = event.data as { id: number; tokens?: CodeToken[]; error?: string };
          if (worker !== ownedWorker || !active || response.id !== active.id) return;
          if (response.error) { reset(); complete(new Error(response.error)); } else complete(undefined, response.tokens ?? []);
        };
        worker.onerror = event => { if (worker !== ownedWorker) return; reset(); complete(new Error(event.message || 'Code highlighting failed')); };
      }
      timer = setTimeout(() => { reset(); complete(new Error('Code highlighting exceeded its time budget')); }, 5000);
      worker.postMessage({ id: active.id, source: active.source, language: active.language, engineURL });
    } catch (error) { reset(); complete(error); }
  };
  const highlight: CodeHighlighter = (source, language, signal) => new Promise((resolve, reject) => {
    if (closed || signal?.aborted) { reject(new DOMException('Highlight cancelled', 'AbortError')); return; }
    const job: Job = { id: ++nextId, source, language: codeLanguage(language), resolve, reject, signal, abort: () => {
      if (active === job) { reset(); complete(new DOMException('Highlight cancelled', 'AbortError')); }
      else { const index = queue.indexOf(job); if (index >= 0) { queue.splice(index, 1); signal?.removeEventListener('abort', job.abort); reject(new DOMException('Highlight cancelled', 'AbortError')); } }
    } };
    signal?.addEventListener('abort', job.abort, { once: true }); queue.push(job); pump();
  });
  return Object.assign(highlight, { destroy() {
    closed = true; reset(); const jobs = active ? [active, ...queue] : [...queue]; active = undefined; queue.length = 0;
    for (const job of jobs) { job.signal?.removeEventListener('abort', job.abort); job.reject(new DOMException('Highlight cancelled', 'AbortError')); }
  } });
}
const defaults = new WeakMap<Document, CodeHighlighter>();
export function defaultCodeHighlighter(document: Document): CodeHighlighter {
  let highlight = defaults.get(document);
  if (!highlight) {
    const client = createCodeHighlighter(new URL('lib/prism/prism.js', document.baseURI).href);
    document.defaultView?.addEventListener('pagehide', () => { client.destroy(); defaults.delete(document); }, { once: true });
    highlight = client; defaults.set(document, highlight);
  }
  return highlight;
}
