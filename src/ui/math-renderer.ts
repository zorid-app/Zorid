/** Shared Reading/Live Edit math rendering. All executable engine/font assets
 * come from pinned upstream MathJax packages, never from note source. */
export interface MathEngine {
  convert(source: string, display: boolean): Promise<HTMLElement>;
  stylesheet(): HTMLElement | null;
}
export interface MathRenderOptions { display?: boolean; onReady?: () => void }
export interface MathRenderHandle { readonly ready: Promise<boolean>; dispose(): void }
export type MathEngineLoader = (document: Document) => Promise<MathEngine>;
interface MathJaxRuntime {
  startup: { promise: Promise<unknown> };
  tex2chtmlPromise(source: string, options: { display: boolean }): Promise<HTMLElement>;
  chtmlStylesheet(): HTMLElement;
}

export const mathPackages = Object.freeze(['action', 'amscd', 'bbox', 'boldsymbol', 'braket', 'bussproofs',
  'cancel', 'cases', 'centernot', 'color', 'colortbl', 'empheq', 'enclose', 'extpfeil', 'gensymb',
  'html', 'mathtools', 'mhchem', 'noerrors', 'tagformat', 'textcomp', 'unicode', 'upgreek', 'verb']);
const loading = new WeakMap<Document, Promise<MathEngine>>();

/** One startup per owner document, including independent popout documents. */
export function loadMathEngine(document: Document): Promise<MathEngine> {
  const existing = loading.get(document);
  if (existing) return existing;
  const promise = new Promise<MathEngine>((resolve, reject) => {
    const window = document.defaultView;
    if (!window) { reject(new Error('Math rendering requires an owning window')); return; }
    const owner = window as unknown as { MathJax?: unknown };
    const root = new URL('lib/mathjax/', document.baseURI).href.replace(/\/$/, '');
    // Build configuration in the destination realm (also required for popouts).
    owner.MathJax = window.JSON.parse(JSON.stringify({
      loader: { paths: { mathjax: root, fonts: `${root}/fonts` },
        load: ['ui/safe', ...mathPackages.map(name => `[tex]/${name}`)] },
      output: { font: 'mathjax-tex', fontExtensions: ['mathjax-mhchem'] },
      tex: { packages: { '[+]': [...mathPackages] }, macros: { RequirePackage: ['\\require{#1}', 1], usepackage: ['\\require{#1}', 1] },
        inlineMath: [], displayMath: [], processEscapes: false, processEnvironments: false, processRefs: false },
      startup: { typeset: false },
      options: { enableMenu: false, enableEnrichment: false, enableExplorer: false,
        menuOptions: { settings: { enrich: false, speech: false, braille: false } },
        safeOptions: { safeProtocols: { http: true, https: true, file: false, javascript: false, data: false } } },
    }));
    // The bundled upstream menu reads persisted settings even when disabled.
    // Match the host's fixed desktop policy before that component initializes.
    try { window.localStorage.removeItem('MathJax-Menu-Settings'); } catch { /* Storage may be unavailable in an isolated document. */ }
    const script = document.createElement('script'); script.async = true;
    script.src = `${root}/tex-chtml-nofont.js`; script.dataset.zoridMathjax = '4.1.3';
    const cleanup = () => { script.onload = null; script.onerror = null; };
    script.onerror = () => { cleanup(); script.remove(); reject(new Error('Unable to load the local math engine')); };
    script.onload = () => {
      cleanup();
      const runtime = owner.MathJax as Partial<MathJaxRuntime> | undefined;
      if (!runtime?.startup?.promise) {
        script.remove(); reject(new Error('The math engine did not initialize')); return;
      }
      runtime.startup.promise.then(() => {
        if (typeof runtime.tex2chtmlPromise !== 'function') throw new Error('The math engine did not initialize');
        resolve({ convert: (source, display) => runtime.tex2chtmlPromise!(source, { display }),
          stylesheet: () => runtime.chtmlStylesheet?.() ?? null });
      }).catch(error => { script.remove(); reject(error); });
    };
    document.head.append(script);
  });
  loading.set(document, promise);
  promise.catch(() => { if (loading.get(document) === promise) loading.delete(document); });
  return promise;
}

interface CacheEntry { sourceLength: number; result: Promise<HTMLElement | null>; consumers: Set<object> }
interface RenderState {
  engine: Promise<MathEngine>; queue: Promise<unknown>; cache: Map<string, CacheEntry>; characters: number; style: HTMLElement | null;
}
const macroMutation = /\\(?:gdef|def|edef|xdef|let|newcommand|renewcommand|providecommand|newenvironment|renewenvironment|require|RequirePackage|usepackage)\b/;

/** A final DOM guard complements MathJax ui/safe and prevents note TeX from
 * creating executable navigation. Engine-generated layout styles are retained. */
function constrainOutput(node: HTMLElement): void {
  if (node.matches('script,iframe,object,embed,link,meta,base')) throw new Error('Invalid math output root');
  for (const unsafe of node.querySelectorAll('script,iframe,object,embed,link,meta,base')) unsafe.remove();
  for (const element of [node, ...node.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
      if (/^(?:href|xlink:href|src)$/i.test(attribute.name)) {
        const value = attribute.value.trim(), compact = value.replace(/[\s\u0000-\u001f\u007f]/gu, '');
        if (!value.startsWith('#') && !/^https?:\/\//i.test(compact) && !/^mailto:/i.test(compact)) element.removeAttribute(attribute.name);
      }
    }
    if (element.tagName.toLowerCase() === 'a') element.setAttribute('rel', 'noopener noreferrer');
  }
}

/** Factory permits an isolated engine in tests/alternate document hosts. The
 * default exported renderer shares a bounded cache within each document. */
export function createMathRenderer(load: MathEngineLoader = loadMathEngine) {
  const states = new WeakMap<Document, RenderState>();
  const owners = new WeakMap<HTMLElement, { cancel(): void }>();
  return function renderMath(parent: HTMLElement, source: string, options: MathRenderOptions = {}): MathRenderHandle {
    const document = parent.ownerDocument, display = options.display ?? false;
    let disposed = false, interested: CacheEntry | undefined;
    let cancelReady!: (value: false) => void;
    const cancelled = new Promise<false>(resolve => { cancelReady = resolve; });
    const identity = { cancel() {
      if (disposed) return;
      disposed = true; interested?.consumers.delete(identity); cancelReady(false);
      if (owners.get(parent) === identity) owners.delete(parent);
    } };
    owners.get(parent)?.cancel(); owners.set(parent, identity);
    parent.classList.add('math'); parent.classList.toggle('math-block', display); parent.classList.toggle('math-inline', !display);
    parent.classList.remove('is-loaded', 'math-error'); parent.textContent = source;
    const current = () => !disposed && owners.get(parent) === identity;
    const notify = () => { try { options.onReady?.(); } catch { /* A host measurement failure must not invalidate math output. */ } };
    const operation = Promise.resolve().then(async () => {
      if (!current()) return false;
      let state = states.get(document);
      if (!state) {
        state = { engine: load(document), queue: Promise.resolve(), cache: new Map(), characters: 0, style: null };
        states.set(document, state);
        const captured = state;
        state.engine.catch(() => { if (states.get(document) === captured) states.delete(document); });
      }
      const entryKey = `${display ? 'D' : 'I'}:${source}`;
      const mutation = macroMutation.test(source);
      if (mutation) { state.cache.clear(); state.characters = 0; }
      let entry = state.cache.get(entryKey);
      if (entry) { state.cache.delete(entryKey); state.cache.set(entryKey, entry); }
      if (!entry) {
        const captured = state;
        const created: CacheEntry = { sourceLength: source.length, result: Promise.resolve(null), consumers: new Set() };
        const forget = () => {
          if (captured.cache.get(entryKey) === created) { captured.cache.delete(entryKey); captured.characters -= created.sourceLength; }
        };
        const abandoned = () => {
          if (created.consumers.size) return false;
          forget(); return true;
        };
        const result = state.queue.then(async () => {
          // Disposal may happen while waiting for either the preceding formula
          // or lazy engine startup. Shared work survives any live consumer.
          if (abandoned()) return null;
          const engine = await captured.engine;
          if (abandoned()) return null;
          const output = await engine.convert(source, display);
          const node = document.importNode(output, true); constrainOutput(node);
          const style = engine.stylesheet();
          if (style && style !== captured.style) {
            captured.style?.remove(); captured.style = style; document.head.append(style);
          }
          return node;
        });
        state.queue = result.catch(() => undefined);
        created.result = result; entry = created;
        if (!mutation && source.length <= 32768) {
          state.cache.set(entryKey, entry); state.characters += source.length;
          while (state.cache.size > 128 || state.characters > 262144) {
            const oldest = state.cache.keys().next().value!;
            state.characters -= state.cache.get(oldest)!.sourceLength; state.cache.delete(oldest);
          }
          result.catch(forget);
        }
      }
      interested = entry; entry.consumers.add(identity);
      let rendered: HTMLElement | null;
      try { rendered = await entry.result; }
      finally { entry.consumers.delete(identity); interested = undefined; }
      if (!rendered || !current()) return false;
      parent.replaceChildren(rendered.cloneNode(true)); parent.classList.add('is-loaded'); notify();
      return true;
    }).catch(() => {
      if (current()) { parent.textContent = source; parent.classList.add('math-error'); notify(); }
      return false;
    });
    return { ready: Promise.race([operation, cancelled]), dispose: identity.cancel };
  };
}

export const renderMath = createMathRenderer();
