/** Public Mermaid boundary. The host supplies an independently acquired, local engine. */
export interface MermaidEngine {
  initialize(configuration: Record<string, unknown>): void | Promise<void>;
  render(id: string, source: string, container: HTMLElement): Promise<{ svg: string; bindFunctions?: unknown }>;
}
export interface MermaidTrust {
  /** Must read the owning vault's decision. Only boolean true allows rendering. */
  isAllowed(): boolean;
  /** Persist approval for this vault; this renderer never stores a global decision. */
  requestAllow(): void | Promise<void>;
}
export interface MermaidMountOptions {
  /** Exact fenced body; use normalizeMermaidCodeText when adapting a Reading code element. */
  source: string;
  sourcePath: string;
  trust: MermaidTrust;
  openLink?: (event: MouseEvent, target: string, sourcePath: string, kind: 'internal' | 'external') => void;
  onMeasure?: () => void;
  onError?: (error: Error) => void;
  /** Optional host visibility policy. The host must call refreshVisibility after changing it. */
  isVisible?: () => boolean;
  /** Localized guard wording belongs to the application. Defaults are original copy. */
  guardText?: { title: string; description: string; allow: string };
}
export interface MermaidMount {
  /** Current generation: resolves after guard/render/error or cancellation, not native paint. */
  readonly ready: Promise<void>;
  update(source: string): Promise<void>;
  refreshTrust(): Promise<void>;
  refreshVisibility(): void;
  destroy(): void;
}
export interface MermaidRenderer {
  mount(host: HTMLElement, options: MermaidMountOptions): MermaidMount;
  destroy(): void;
}
export function normalizeMermaidCodeText(source: string): string { return source.endsWith('\n') ? source.slice(0, -1) : source; }
export function mermaidConfiguration(): Record<string, unknown> {
  return {
    startOnLoad: false, securityLevel: 'strict',
    secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges'],
    themeVariables: { fontFamily: 'var(--font-mermaid)' },
    flowchart: { useMaxWidth: false }, sequence: { useMaxWidth: false },
    gantt: { useMaxWidth: true, axisFormatter: [['%Y-%m-%d', (date: Date) => date.getDay() === 1]] },
    journey: { useMaxWidth: true }, class: { useMaxWidth: true }, git: { useMaxWidth: false },
    state: { useMaxWidth: true }, er: { useMaxWidth: false }, pie: { useMaxWidth: true },
  };
}
interface Job { valid(): boolean; run(): Promise<void> }
interface VisibilityWatch { callbacks: Set<() => void>; observer?: MutationObserver }
let nextService = 0;

/** Share one service per workspace; engine loading is cached per owner document. */
export function createMermaidRenderer(configuration: { loadEngine: (document: Document) => Promise<MermaidEngine> }): MermaidRenderer {
  const serviceId = `${Date.now().toString(36)}-${++nextService}`;
  const engines = new WeakMap<Document, Promise<MermaidEngine>>(), initialized = new WeakSet<MermaidEngine>();
  const watchers = new Map<Document, VisibilityWatch>(), mounts = new Set<MermaidMount>(), queue: Job[] = [];
  let disposed = false, running = false, nextRender = 0;
  async function engineFor(doc: Document): Promise<MermaidEngine> {
    let pending = engines.get(doc);
    if (!pending) {
      pending = Promise.resolve().then(() => configuration.loadEngine(doc)).then(async engine => {
        if (!disposed && !initialized.has(engine)) { await engine.initialize(mermaidConfiguration()); initialized.add(engine); }
        return engine;
      });
      engines.set(doc, pending);
      void pending.catch(() => { if (engines.get(doc) === pending) engines.delete(doc); });
    }
    return pending;
  }
  async function pump(): Promise<void> {
    if (running || disposed) return;
    running = true;
    try { while (!disposed && queue.length) { const job = queue.shift()!; if (job.valid()) await job.run(); } }
    finally { running = false; }
  }
  function pruneQueue(): void { for (let i = queue.length - 1; i >= 0; i--) if (!queue[i].valid()) queue.splice(i, 1); }
  function enqueue(job: Job): void {
    if (disposed) return;
    // Remove superseded jobs before adding another edit; one pending job per current mount generation.
    pruneQueue();
    queue.push(job); void pump();
  }
  function watch(doc: Document, callback: () => void): () => void {
    let entry = watchers.get(doc);
    if (!entry) {
      entry = { callbacks: new Set() };
      const current = entry;
      const Observer = doc.defaultView?.MutationObserver;
      if (Observer) {
        entry.observer = new Observer(() => { for (const notify of Array.from(current.callbacks)) notify(); });
        entry.observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
      }
      watchers.set(doc, entry);
    }
    entry.callbacks.add(callback);
    return () => {
      entry!.callbacks.delete(callback);
      if (!entry!.callbacks.size) { entry!.observer?.disconnect(); if (watchers.get(doc) === entry) watchers.delete(doc); }
    };
  }
  function mount(host: HTMLElement, supplied: MermaidMountOptions): MermaidMount {
    if (disposed) throw new Error('Mermaid renderer is closed');
    const options = { ...supplied }, doc = host.ownerDocument, win = doc.defaultView!;
    const root = doc.createElement('div'); root.className = 'zorid-mermaid-renderer'; host.append(root);
    let source = options.source, closed = false, generation = 0, resolveReady: () => void = () => {}, ready = Promise.resolve();
    let stopWatching: (() => void) | undefined, scheduled = false, allowing = false;
    const temporary = new Set<HTMLElement>();
    const report = (cause: unknown) => { if (!closed) { try { options.onError?.(cause instanceof Error ? cause : new Error(String(cause))); } catch { /* Host error reporting must not strand the queue. */ } } };
    const measure = () => { if (!closed) { try { options.onMeasure?.(); } catch (cause) { report(cause); } } };
    const allowed = () => { try { return options.trust.isAllowed() === true; } catch (cause) { report(cause); return false; } };
    const isCurrent = (version: number) => !closed && !disposed && generation === version;
    const code = (text: string) => { const pre = doc.createElement('pre'), node = doc.createElement('code'); node.className = 'language-mermaid'; node.textContent = text; pre.append(node); return pre; };
    function visible(): boolean {
      if (!host.isConnected) return false;
      try { if (options.isVisible && !options.isVisible()) return false; } catch (cause) { report(cause); return false; }
      for (let node: HTMLElement | null = host; node; node = node.parentElement) {
        const style = win.getComputedStyle(node);
        if (node.hidden || style.display === 'none' || style.visibility === 'hidden') return false;
      }
      return true;
    }
    function showError(cause: unknown, version: number): void {
      if (!isCurrent(version)) return;
      const error = cause as { str?: unknown; message?: unknown } | null;
      const description = String(error?.str || error?.message || cause);
      const message = doc.createElement('div'); message.className = 'zorid-mermaid-error'; message.setAttribute('role', 'status');
      message.textContent = `Error parsing Mermaid diagram!\n\n${description}`;
      root.replaceChildren(message, code(source)); root.classList.remove('is-loading'); report(cause); measure();
    }
    function showGuard(version: number): void {
      if (!isCurrent(version)) return;
      const text = options.guardText ?? { title: 'Mermaid diagrams', description: 'Allow diagrams from this vault to render.', allow: 'Allow' };
      const wrapper = doc.createElement('div'); wrapper.className = 'mermaid-wrapper is-guarded';
      const header = doc.createElement('div'); header.className = 'mermaid-guard-header';
      const words = doc.createElement('div'); words.className = 'mermaid-guard-text';
      const title = doc.createElement('div'); title.className = 'mermaid-guard-title'; title.textContent = text.title;
      const description = doc.createElement('div'); description.className = 'mermaid-guard-description'; description.textContent = text.description;
      const actions = doc.createElement('div'); actions.className = 'mermaid-guard-actions';
      const button = doc.createElement('button'); button.type = 'button'; button.textContent = text.allow;
      button.onclick = () => {
        if (!isCurrent(version) || allowing) return;
        allowing = true; button.disabled = true;
        void Promise.resolve().then(() => { if (isCurrent(version)) return options.trust.requestAllow(); }).then(() => {
          if (isCurrent(version)) refreshTrust();
        }, cause => { if (isCurrent(version)) { report(cause); button.disabled = false; } }).finally(() => { allowing = false; });
      };
      words.append(title, description); actions.append(button); header.append(words, actions);
      const body = doc.createElement('div'); body.className = 'mermaid-guard-source'; body.append(code(source)); wrapper.append(header, body);
      root.replaceChildren(wrapper); root.classList.remove('is-loading'); measure(); resolveReady();
    }
    function refreshVisibility(): void {
      if (closed || disposed || scheduled) return;
      const version = generation;
      if (!allowed()) { stopWatching?.(); stopWatching = undefined; showGuard(version); return; }
      if (!visible()) { stopWatching ??= watch(doc, refreshVisibility); return; }
      stopWatching?.(); stopWatching = undefined; scheduled = true;
      const snapshot = source;
      enqueue({ valid: () => isCurrent(version), run: async () => {
        let container: HTMLElement | undefined, id: string | undefined, deferred = false;
        try {
          if (!isCurrent(version)) return;
          if (!allowed()) { showGuard(version); return; }
          if (!visible()) { deferred = true; scheduled = false; refreshVisibility(); return; }
          const engine = await engineFor(doc);
          if (!isCurrent(version)) return;
          if (!allowed()) { showGuard(version); return; }
          if (!visible()) { deferred = true; scheduled = false; refreshVisibility(); return; }
          id = `m-zorid-${serviceId}-${++nextRender}`;
          container = doc.createElement('div'); container.className = 'mermaid zorid-mermaid-measure'; container.dataset.mermaidOwner = id;
          container.style.position = 'absolute'; container.style.visibility = 'hidden';
          container.style.width = `${host.clientWidth || host.parentElement?.clientWidth || win.innerWidth}px`;
          doc.body.append(container); temporary.add(container);
          const result = await engine.render(id, snapshot, container);
          if (!isCurrent(version)) return;
          if (!allowed()) { showGuard(version); return; }
          const diagram = doc.createElement('div'); diagram.className = 'mermaid'; diagram.append(prepareSvg(doc, result.svg, id));
          root.replaceChildren(diagram); root.classList.remove('is-loading'); measure();
        } catch (cause) { showError(cause, version); }
        finally {
          if (container) { container.remove(); temporary.delete(container); }
          if (id) doc.getElementById(`d${id}`)?.remove();
          if (isCurrent(version) && !deferred) resolveReady();
        }
      } });
    }
    function begin(): Promise<void> {
      resolveReady(); generation++; pruneQueue(); scheduled = false; stopWatching?.(); stopWatching = undefined;
      ready = new Promise(resolve => { resolveReady = resolve; });
      root.replaceChildren(code(source)); root.classList.add('is-loading');
      refreshVisibility(); return ready;
    }
    function refreshTrust(): Promise<void> { return closed || disposed ? Promise.resolve() : begin(); }
    const clicked = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const anchor = target?.closest?.('a');
      if (!anchor || !root.contains(anchor)) return;
      event.preventDefault();
      if (closed || !allowed()) return;
      const internal = anchor.classList.contains('internal-link');
      const href = (internal ? anchor.getAttribute('data-mermaid-target') : null) || anchor.getAttribute('href') || anchor.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      if (!href) return;
      try { options.openLink?.(event, href, options.sourcePath, internal ? 'internal' : 'external'); } catch (cause) { report(cause); }
    };
    root.addEventListener('click', clicked);
    const resize = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(measure) : undefined; resize?.observe(root, { box: 'border-box' });
    const handle: MermaidMount = {
      get ready() { return ready; },
      update(value) { if (closed || disposed) return Promise.resolve(); if (value === source) return ready; source = value; return begin(); },
      refreshTrust, refreshVisibility,
      destroy() {
        if (closed) return; closed = true; generation++; pruneQueue(); resolveReady(); stopWatching?.(); stopWatching = undefined; resize?.disconnect();
        for (const node of temporary) { const id = node.dataset.mermaidOwner; node.remove(); if (id) doc.getElementById(`d${id}`)?.remove(); } temporary.clear(); root.removeEventListener('click', clicked); root.remove(); mounts.delete(handle);
      },
    };
    mounts.add(handle); begin(); return handle;
  }
  return { mount, destroy() { if (disposed) return; disposed = true; for (const handle of Array.from(mounts)) handle.destroy(); queue.length = 0; for (const entry of watchers.values()) entry.observer?.disconnect(); watchers.clear(); } };
}

/** Engine SVG must already be sanitized by its strict renderer; these are scoped host repairs, not a general SVG sanitizer. */
function prepareSvg(doc: Document, source: string, id: string): SVGElement {
  const parsed = new doc.defaultView!.DOMParser().parseFromString(source, 'image/svg+xml');
  if (parsed.querySelector('parsererror') || parsed.documentElement.localName !== 'svg' || parsed.documentElement.namespaceURI !== 'http://www.w3.org/2000/svg') throw new Error('Mermaid returned invalid SVG');
  const svg = doc.importNode(parsed.documentElement, true) as unknown as SVGElement;
  // Defense in depth against active output; preserve SVG styles and foreignObject labels needed by Mermaid.
  svg.querySelectorAll('script,iframe,object,embed,base,form').forEach(node => node.remove());
  for (const node of [svg, ...Array.from(svg.querySelectorAll('*'))]) {
    for (const attribute of Array.from(node.attributes)) if (/^on/i.test(attribute.name)) node.removeAttributeNode(attribute);
  }
  for (const owner of svg.querySelectorAll('.internal-link')) {
    const label = owner.querySelector('g.label foreignObject div');
    if (!label?.textContent) continue;
    const anchor = doc.createElementNS('http://www.w3.org/1999/xhtml', 'a'), target = label.textContent;
    anchor.setAttribute('class', 'internal-link'); anchor.setAttribute('href', '#'); anchor.setAttribute('data-mermaid-target', target); anchor.textContent = target; label.replaceChildren(anchor);
  }
  for (const anchor of svg.querySelectorAll('a')) {
    const href = anchor.getAttribute('href') || anchor.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
    if (href && /^(?:javascript|vbscript|data):/i.test(href.replace(/[\u0000-\u0020]/g, ''))) { anchor.removeAttribute('href'); anchor.removeAttributeNS('http://www.w3.org/1999/xlink', 'href'); }
    else if (href) anchor.setAttribute('href', href);
    anchor.setAttribute('rel', 'noopener noreferrer');
  }
  for (const marker of svg.querySelectorAll('marker[id]')) {
    const previous = marker.id, next = `${id}-${previous}`; marker.id = next;
    for (const node of svg.querySelectorAll('[marker-start],[marker-end],[marker-mid]')) {
      for (const attribute of ['marker-start', 'marker-end', 'marker-mid']) if (node.getAttribute(attribute) === `url(#${previous})`) node.setAttribute(attribute, `url(#${next})`);
    }
    const escaped = previous.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const style of svg.querySelectorAll('style')) style.textContent = (style.textContent ?? '').replace(new RegExp(`#${escaped}(?![\\w-])`, 'g'), () => `#${next}`);
  }
  return svg;
}
