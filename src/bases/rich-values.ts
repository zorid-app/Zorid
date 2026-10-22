import { baseValueToString } from './expression.ts';
import type { BaseExpressionValue, BaseNamespaceValue } from './expression.ts';
import { icon } from '../ui/icons.ts';

/** Inert query presentation shared with the expression transport. */
export type BaseRichPresentation = NonNullable<BaseNamespaceValue['presentation']>;
export interface BaseRichValueOptions {
  readonly openFile?: (target: string, event: MouseEvent | KeyboardEvent, witness?: { readonly entryId: string; readonly revision: string }) => void;
  readonly loadImage?: (source: string, signal: AbortSignal) => Promise<{ readonly url: string; dispose(): void } | null>;
  readonly isCurrent?: () => boolean;
  readonly onError?: (error: unknown) => void;
  readonly maxNodes?: number;
  readonly maxDepth?: number;
  readonly maxTextCharacters?: number;
}
const own = (value: unknown, key: string): unknown => value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
const bounded = (value: number | undefined, fallback: number, max: number) => Number.isSafeInteger(value) && value! > 0 ? Math.min(value!, max) : fallback;
const controls = /[\u0000-\u001f\u007f-\u009f]/;
/** Vault paths are passed only to host callbacks. A raw URL never gets promoted
 * to a local file URL, and executable/unknown schemes never reach any callback. */
function destination(value: string, image = false): { value: string; external: boolean } | null {
  const text = value.trim();
  if (!text || controls.test(text) || /^[\\/]{2}/.test(text)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1].toLowerCase();
  if (scheme) {
    if (!(image ? ['http', 'https'] : ['http', 'https', 'mailto', 'tel']).includes(scheme)) return null;
    try { const url = new URL(text); if ((scheme === 'http' || scheme === 'https') && !url.hostname) return null; return { value: text, external: true }; } catch { return null; }
  }
  return { value: text, external: false };
}
export function baseRichPresentation(value: BaseExpressionValue): BaseRichPresentation | undefined {
  if (own(value, 'type') !== 'namespace') return;
  const presentation = own(value, 'presentation');
  const kind = own(presentation, 'kind'), text = own(presentation, 'value');
  if (typeof kind === 'string' && ['html', 'image', 'icon', 'link'].includes(kind) && typeof text === 'string') return presentation as BaseRichPresentation;
  // Older transported file/link values remain readable and clickable during a
  // rolling client upgrade; their getter is still never executed.
  const shared = own(value, 'sharedValue'), type = own(shared, 'type'), path = own(shared, 'path');
  if ((type === 'link' || type === 'file') && typeof path === 'string') {
    const display = own(shared, 'display');
    return { kind: 'link', value: path, ...(typeof display === 'string' ? { label: { type: 'string', value: display } as BaseExpressionValue } : {}) };
  }
}

const allowedTags = new Set(['A', 'B', 'STRONG', 'EM', 'I', 'U', 'S', 'DEL', 'MARK', 'SMALL', 'SUB', 'SUP', 'CODE', 'KBD', 'SAMP', 'VAR', 'SPAN', 'DIV', 'P', 'BR', 'HR', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'CAPTION', 'DETAILS', 'SUMMARY', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'IMG']);
const discardTags = new Set(['SCRIPT', 'STYLE', 'TITLE', 'HEAD', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'LINK', 'META', 'BASE', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'OPTION', 'SOURCE', 'VIDEO', 'AUDIO']);
const safeStyles = ['color', 'background-color', 'font-weight', 'font-style', 'font-size', 'text-decoration', 'text-align', 'white-space', 'border-radius'] as const;

/** Detached-template parsing follows clipboard-html.ts's inert ingestion. Only
 * newly constructed allowlisted elements/attributes enter the live document. */
export function mountBaseRichValue(element: HTMLElement, value: BaseExpressionValue, options: BaseRichValueOptions = {}): () => void {
  const document = element.ownerDocument;
  const container = document.createElement('span'); container.className = 'bases-rich-value'; element.append(container);
  let disposed = false, nodes = bounded(options.maxNodes, 10000, 100000), text = bounded(options.maxTextCharacters, 200000, 1000000);
  const depthLimit = bounded(options.maxDepth, 64, 128), ancestors = new Set<object>(), cleanups: (() => void)[] = [];
  const current = () => { try { return !disposed && (options.isCurrent?.() ?? true); } catch { return false; } };
  const report = (error: unknown) => { try { options.onError?.(error); } catch { /* A reporter cannot interrupt resource cleanup. */ } };
  const cleanup = () => { for (const release of cleanups.splice(0)) { try { release(); } catch (error) { report(error); } } };
  const take = (depth: number) => { if (--nodes < 0 || depth > depthLimit) throw new Error('The rich property value is too large to display.'); };
  const appendText = (parent: HTMLElement, value: string) => { text -= value.length; if (text < 0) throw new Error('The rich property value is too large to display.'); parent.append(document.createTextNode(value)); };
  const wireLink = (anchor: HTMLAnchorElement, target: string, witness?: { readonly entryId: string; readonly revision: string; readonly subpath?: string }) => {
    const safe = destination(target);
    if (!safe) { anchor.className = 'unsupported-link'; anchor.setAttribute('aria-disabled', 'true'); }
    else if (safe.external) { anchor.className = 'external-link'; anchor.href = safe.value; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; anchor.referrerPolicy = 'no-referrer'; }
    else { anchor.className = 'internal-link'; anchor.href = '#'; anchor.dataset.href = safe.value; }
    const open = (event: MouseEvent) => {
      if ((event.button !== 0 && event.button !== 1) || event.defaultPrevented) return;
      if (!safe || !current() || options.openFile) { event.preventDefault(); event.stopPropagation(); }
      if (safe && current() && options.openFile) { try { options.openFile(safe.value, event, witness); } catch (error) { report(error); } }
    };
    anchor.addEventListener('click', open); anchor.addEventListener('auxclick', open);
    cleanups.push(() => { anchor.removeEventListener('click', open); anchor.removeEventListener('auxclick', open); });
  };
  const appendImage = (parent: HTMLElement, source: string, alt = '') => {
    const safe = destination(source, true), image = document.createElement('img');
    image.className = 'bases-rich-image'; image.alt = alt; image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer'; image.draggable = false;
    const unavailable = () => { image.classList.add('is-unavailable'); image.title = `Image unavailable: ${source}`; };
    image.addEventListener('error', unavailable); cleanups.push(() => { image.removeEventListener('error', unavailable); image.removeAttribute('src'); }); parent.append(image);
    if (!safe) { unavailable(); return; }
    if (safe.external) { image.src = safe.value; return; }
    if (!options.loadImage) { unavailable(); return; }
    const controller = new AbortController(); cleanups.push(() => controller.abort());
    Promise.resolve().then(() => current() && !controller.signal.aborted ? options.loadImage!(safe.value, controller.signal) : null).then(resource => {
      if (!resource) { if (current() && !controller.signal.aborted) unavailable(); return; }
      let released = false;
      const release = () => { if (!released) { released = true; resource.dispose(); } };
      if (!current() || controller.signal.aborted) { try { release(); } catch (error) { report(error); } return; }
      // A host lease may return only an object URL or an ordinary remote URL.
      // Raw formula data never authorizes file:, data:, or executable schemes.
      if (!/^blob:/i.test(resource.url) && !destination(resource.url, true)?.external) { try { release(); } catch (error) { report(error); } unavailable(); report(new Error('The image resource URL is unsupported.')); return; }
      cleanups.push(release); image.src = resource.url;
    }).catch(error => { if (current() && !controller.signal.aborted) { unavailable(); report(error); } });
  };
  function html(parent: HTMLElement, source: string, depth: number, insideLink: boolean) {
    text -= source.length; if (text < 0) throw new Error('The rich HTML value is too large to display.');
    const inert = document.implementation.createHTMLDocument(''), template = inert.createElement('template'); template.innerHTML = source;
    const visit = (parent: HTMLElement, node: Node, depth: number) => {
      take(depth);
      if (node.nodeType === 3) { appendText(parent, node.textContent ?? ''); return; }
      if (node.nodeType !== 1) return;
      const input = node as HTMLElement, tag = input.tagName.toUpperCase();
      if (discardTags.has(tag)) return;
      if (!allowedTags.has(tag)) { for (const child of input.childNodes) visit(parent, child, depth + 1); return; }
      if (tag === 'IMG') { appendImage(parent, input.getAttribute('src') ?? '', input.getAttribute('alt') ?? ''); return; }
      const nestedLink = insideLink || parent.closest('a') !== null;
      const output = document.createElement(tag === 'A' && nestedLink ? 'span' : tag.toLowerCase());
      const title = input.getAttribute('title'); if (title) output.title = title.slice(0, 4096);
      if (tag === 'A' && !nestedLink) wireLink(output as HTMLAnchorElement, input.getAttribute('href') ?? '');
      for (const property of safeStyles) { const value = input.style.getPropertyValue(property); if (value && value.length <= 256 && !/(?:url\s*\(|expression\s*\(|@import|javascript|[{}<>])/i.test(value)) output.style.setProperty(property, value); }
      if (tag === 'TD' || tag === 'TH') for (const name of ['colspan', 'rowspan']) { const count = Number(input.getAttribute(name)); if (Number.isInteger(count) && count > 0 && count <= 100) output.setAttribute(name, String(count)); }
      if (tag === 'OL') { const start = Number(input.getAttribute('start')); if (Number.isSafeInteger(start) && input.hasAttribute('start')) output.setAttribute('start', String(start)); }
      for (const child of input.childNodes) visit(output, child, depth + 1);
      parent.append(output);
    };
    for (const child of template.content.childNodes) visit(parent, child, depth + 1);
  }
  function render(parent: HTMLElement, value: BaseExpressionValue, depth: number, insideLink = false) {
    take(depth);
    if (!value || typeof value !== 'object' || ancestors.has(value)) throw new Error('The rich property value contains a cycle.');
    ancestors.add(value);
    try {
      const presentation = baseRichPresentation(value);
      if (presentation) {
        const kind = own(presentation, 'kind'), source = own(presentation, 'value') as string;
        if (kind !== 'html') { text -= source.length; if (text < 0) throw new Error('The rich property value is too large to display.'); }
        if (kind === 'html') html(parent, source, depth, insideLink);
        else if (kind === 'image') appendImage(parent, source);
        else if (kind === 'icon') { const name = source.replace(/^lucide-/, ''); let node = icon(name === 'book-open' ? 'book' : name, 16, document); if (name !== 'file' && node.isEqualNode(icon('file', 16, document))) node = icon('help', 16, document); node.classList.add('bases-rich-icon'); parent.append(node); }
        else if (kind === 'link') {
          const link = document.createElement(insideLink ? 'span' : 'a');
          if (!insideLink) { const target = own(presentation, 'target'), entryId = own(target, 'entryId'), revision = own(target, 'revision'), subpath=own(presentation,'subpath'); wireLink(link as HTMLAnchorElement, source, typeof entryId === 'string' && typeof revision === 'string' ? { entryId, revision,...(typeof subpath==='string'&&subpath.startsWith('#')?{subpath}:{}) } : undefined); }
          const label = own(presentation, 'label') as BaseExpressionValue | undefined;
          if (label) render(link, label, depth + 1, true); else appendText(link, typeof own(value, 'name') === 'string' ? own(value, 'name') as string : source);
          parent.append(link);
        }
      } else {
        const kind = own(value, 'type'), data = own(value, 'value');
        if (kind === 'list' && Array.isArray(data)) {
          const length = own(data, 'length'); if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > nodes + 1) throw new Error('The rich property list is too large to display.');
          for (let index = 0; index < length; index++) {
            const descriptor = Object.getOwnPropertyDescriptor(data, String(index));
            if (!descriptor || !('value' in descriptor)) throw new Error('Rich property lists must contain inert own values.');
            if (index) appendText(parent, ', '); render(parent, descriptor.value, depth + 1, insideLink);
          }
        }
        else if (kind === 'namespace') appendText(parent, typeof own(value, 'name') === 'string' ? own(value, 'name') as string : '');
        else if (kind === 'error') { const message = document.createElement('span'); message.className = 'bases-rich-error'; const text = own(own(value, 'error'), 'message'); appendText(message, typeof text === 'string' ? text : 'Property error'); parent.append(message); }
        else if (kind === 'string' && typeof data === 'string') appendText(parent, data);
        else if ((kind === 'number' && typeof data === 'number' && Number.isFinite(data)) || (kind === 'boolean' && typeof data === 'boolean')) appendText(parent, String(data));
        else if (kind === 'date') {
          const timestamp = own(value, 'timestamp'), hasTime = own(value, 'hasTime'), timezone = own(value, 'presentationTimezone');
          if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || typeof hasTime !== 'boolean') throw new Error('Invalid date presentation.');
          appendText(parent, baseValueToString({type:'date', timestamp, hasTime, ...(typeof timezone === 'string' ? {presentationTimezone:timezone} : {})}));
        } else if (kind === 'duration') {
          const parts = Object.fromEntries(['years','months','days','hours','minutes','seconds','milliseconds'].map(key=>[key,own(value,key)]));
          if (Object.values(parts).some(value=>typeof value !== 'number' || !Number.isFinite(value))) throw new Error('Invalid duration presentation.');
          appendText(parent, baseValueToString({type:'duration',...parts} as BaseExpressionValue));
        } else if (kind === 'object' && data && typeof data === 'object') {
          appendText(parent,'{'); Object.keys(data).forEach((key,index)=>{ if (index) appendText(parent,', '); appendText(parent,`${JSON.stringify(key)}: `); const child=own(data,key); if (child) render(parent,child as BaseExpressionValue,depth+1,insideLink); else appendText(parent,'null'); }); appendText(parent,'}');
        }
      }
    } finally { ancestors.delete(value); }
  }
  try { render(container, value, 0); }
  catch (error) { cleanup(); container.replaceChildren(); container.classList.add('bases-rich-error'); container.textContent = error instanceof Error ? error.message : String(error); report(error); }
  return () => { if (disposed) return; disposed = true; cleanup(); container.remove(); };
}
