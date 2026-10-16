import { Bug, Check, ChevronDown, CircleCheck, CircleHelp, ClipboardList, Flame, Info, List, Pencil, Quote, TriangleAlert, X, Zap } from 'lucide';
import type { IconNode } from 'lucide';

export interface CalloutHeader { type: string; metadata: string; fold: '' | '+' | '-'; title: string }
export function parseCalloutHeader(text: string): CalloutHeader | null {
  const match = /^\[!([^\]]+)\]([+-]?)(?:[ \t]+|$)(.*)$/.exec(text);
  if (!match) return null;
  const divider = match[1].indexOf('|'), raw = divider < 0 ? match[1] : match[1].slice(0, divider);
  const type = raw.trim().toLowerCase().replace(/\s+/g, '-');
  if (!type) return null;
  return { type, metadata: divider < 0 ? '' : match[1].slice(divider + 1), fold: match[2] as CalloutHeader['fold'], title: match[3] };
}


const interactive = 'a,button,input,textarea,select,audio,video,iframe,object,embed,summary,.cm-editor,.interactive-child,[contenteditable]:not([contenteditable="false"]),[role="button"]';
export function calloutOwnsInteraction(target: EventTarget | null, boundary: HTMLElement): boolean {
  const element = target as Element | null, control = element?.closest?.(interactive);
  return !!control && boundary.contains(control) || element?.tagName === 'IMG' && typeof (element as HTMLElement).onclick === 'function';
}


const glyphs: Record<string, IconNode> = {
  note: Pencil, abstract: ClipboardList, summary: ClipboardList, tldr: ClipboardList,
  info: Info, todo: CircleCheck, important: Flame, tip: Flame, hint: Flame,
  success: Check, check: Check, done: Check, question: CircleHelp, help: CircleHelp, faq: CircleHelp,
  warning: TriangleAlert, caution: TriangleAlert, attention: TriangleAlert, failure: X, fail: X, missing: X,
  danger: Zap, error: Zap, bug: Bug, example: List, quote: Quote, cite: Quote,
};
function icon(document: Document, glyph: IconNode): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: 'svg-icon' })) svg.setAttribute(name, value);
  for (const [tag, attrs] of glyph) {
    const node = document.createElementNS(svg.namespaceURI, tag);
    for (const [key, value] of Object.entries(attrs)) if (value !== undefined) node.setAttribute(key, String(value));
    svg.append(node);
  }
  return svg;
}


export interface CalloutPresentation {
  element: HTMLDivElement;
  title: HTMLDivElement;
  titleSource: string;
  content: HTMLDivElement;
  destroy(): void;
}
const owners = new WeakMap<Element, CalloutPresentation>();

/** Shared structure and local folding for Reading and Live Edit. Content and
 * safe title Markdown remain owned by the caller's existing render pipeline. */
export function createCalloutPresentation(document: Document, header: CalloutHeader,
  options: { collapsed?: boolean; onToggle?: (collapsed: boolean) => void; onResize?: () => void } = {}): CalloutPresentation {
  const element = document.createElement('div'); element.className = 'callout zorid-callout';
  element.dataset.callout = header.type; element.dataset.calloutMetadata = header.metadata; element.dataset.calloutFold = header.fold;
  const heading = document.createElement('div'); heading.className = 'callout-title';
  const glyph = document.createElement('span'); glyph.className = 'callout-icon';
  glyph.append(icon(document, Object.hasOwn(glyphs, header.type) ? glyphs[header.type] : Pencil));
  const title = document.createElement('div'); title.className = 'callout-title-inner'; title.dir = 'auto';
  heading.append(glyph, title); element.append(heading);
  const content = document.createElement('div'); content.className = 'callout-content'; element.append(content);
  const fallback = header.type.replace(/-/g, ' '), titleSource = header.title || fallback[0].toUpperCase() + fallback.slice(1);
  const cleanup: (() => void)[] = []; let closed = false, timer: ReturnType<typeof setTimeout> | undefined;
  const listen = <K extends keyof HTMLElementEventMap>(node: HTMLElement, name: K, callback: (event: HTMLElementEventMap[K]) => void) => {
    node.addEventListener(name, callback); cleanup.push(() => node.removeEventListener(name, callback));
  };
  const presentation = { element, title, titleSource, content, destroy() {
    if (closed) return; closed = true; clearTimeout(timer);
    cleanup.splice(0).forEach(dispose => dispose()); owners.delete(element);
  } };
  owners.set(element, presentation);
  if (header.fold) {
    element.classList.add('is-collapsible');
    const button = document.createElement('button'); button.type = 'button'; button.className = 'callout-fold'; button.append(icon(document, ChevronDown)); heading.append(button);
    let collapsed = options.collapsed ?? header.fold === '-';
    const apply = () => {
      element.classList.toggle('is-collapsed', collapsed); content.hidden = collapsed;
      button.setAttribute('aria-expanded', String(!collapsed)); button.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} callout`);
      options.onResize?.();
    };
    const toggle = () => { if (closed) return; collapsed = !collapsed; options.onToggle?.(collapsed); apply(); };
    listen(button, 'mousedown', event => event.preventDefault());
    listen(button, 'click', event => { if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); toggle(); });
    listen(heading, 'click', event => {
      if (event.button !== 0 || event.defaultPrevented || calloutOwnsInteraction(event.target, heading)) return;
      clearTimeout(timer); timer = setTimeout(() => { if (!event.defaultPrevented && !closed) { event.preventDefault(); toggle(); } }, 0);
    });
    apply();
  }
  return presentation;
}

/** Explicit ownership supports detached construction and delayed title clicks. */
export function destroyCalloutPresentations(container: ParentNode): void {
  if (container.nodeType === 1) owners.get(container as Element)?.destroy();
  for (const element of container.querySelectorAll('.zorid-callout')) owners.get(element)?.destroy();
}
