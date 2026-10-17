import { CanvasDocument } from './document.ts';
import type { CanvasEdge, CanvasNode, CanvasValue } from './document.ts';
import { projectCanvas } from './view.ts';
import { icon } from '../ui/dom.ts';

export interface CanvasEmbedPreviewOptions {
  path: string;
  source: string | CanvasDocument;
  /** The retained reference adds a title only for its inline embed variant. */
  inline?: boolean;
  /** Exact originating event, including modifiers/middle click. The host owns
   * destination selection and arbitration with Live source-selection handlers. */
  onOpen(event: MouseEvent | KeyboardEvent): void | Promise<void>;
  onError?(error: unknown): void;
}
export interface CanvasEmbedPreview {
  readonly element: HTMLElement;
  /** Invalid updates retain the last valid thumbnail with a visible error. */
  update(source: string | CanvasDocument): boolean;
  destroy(): void;
}

const svgNS = 'http://www.w3.org/2000/svg';
let previewSequence = 0;
type Side = 'top' | 'right' | 'bottom' | 'left';

function paint(value: CanvasValue | undefined): string | undefined {
  if (typeof value !== 'string') return;
  if (/^[1-6]$/.test(value)) {
    const [name, fallback] = [['red', '#fb464c'], ['orange', '#e9973f'], ['yellow', '#e0de71'], ['green', '#44cf6e'], ['cyan', '#53dfdd'], ['purple', '#a882ff']][Number(value) - 1];
    return `var(--canvas-color-${value}, var(--color-${name}, ${fallback}))`;
  }
  if (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) return value;
}
function endpoint(node: CanvasNode, value: CanvasValue | undefined, other: CanvasNode): { x: number; y: number; side: Side } {
  const sides = ['top', 'right', 'bottom', 'left'];
  let side: Side;
  if (typeof value === 'string' && sides.includes(value)) side = value as Side;
  else {
    const dx = other.x + other.width / 2 - node.x - node.width / 2, dy = other.y + other.height / 2 - node.y - node.height / 2;
    side = Math.abs(dx) >= Math.abs(dy) ? dx >= 0 ? 'right' : 'left' : dy >= 0 ? 'bottom' : 'top';
  }
  return { x: node.x + (side === 'left' ? 0 : side === 'right' ? node.width : node.width / 2), y: node.y + (side === 'top' ? 0 : side === 'bottom' ? node.height : node.height / 2), side };
}
function edgePath(edge: CanvasEdge, nodes: Map<string, CanvasNode>): string {
  const from = nodes.get(edge.fromNode)!, to = nodes.get(edge.toNode)!;
  const start = endpoint(from, edge.fromSide, to), end = endpoint(to, edge.toSide, from);
  const distance = Math.min(200, Math.max(40, Math.hypot(end.x - start.x, end.y - start.y) / 2));
  const control = (point: typeof start) => ({ x: point.x + (point.side === 'left' ? -distance : point.side === 'right' ? distance : 0), y: point.y + (point.side === 'top' ? -distance : point.side === 'bottom' ? distance : 0) });
  const first = control(start), second = control(end);
  return `M ${start.x} ${start.y} C ${first.x} ${first.y} ${second.x} ${second.y} ${end.x} ${end.y}`;
}

/** Original static navigation preview, never the interactive Canvas editor.
 * Evidence: docs/embed-controls-reference.md; pinned app.js SHA 958ce57f…df9,
 * character ranges 3427616–3429900. Observed: group/edge/node layering, radius20,
 * width-dependent edge strokes and 5% longest-side bounds padding. Our cubic
 * controls, supported-record projection, safe invalid-update retention and
 * keyboard link behavior are original choices; runtime size/click precedence
 * remain unverified. The caller owns file reads and visibility scheduling. */
export function createCanvasEmbedPreview(parent: HTMLElement, options: CanvasEmbedPreviewOptions): CanvasEmbedPreview {
  const document = parent.ownerDocument;
  const element = document.createElement('div'); element.className = 'zorid-canvas-embed-preview';
  element.classList.toggle('is-inline', options.inline ?? true); element.setAttribute('role', 'link'); element.tabIndex = 0;
  const basename = options.path.split(/[\\/]/).at(-1)!.replace(/\.canvas$/i, '') || options.path;
  element.setAttribute('aria-label', `Open Canvas: ${basename}`);
  if (options.inline ?? true) {
    const title = document.createElement('div'); title.className = 'zorid-canvas-embed-title';
    title.append(icon('dashboard', 16, document), document.createTextNode(basename)); element.append(title);
  }
  const content = document.createElement('div'); content.className = 'zorid-canvas-embed-thumbnail';
  const status = document.createElement('div'); status.className = 'zorid-canvas-embed-status'; status.setAttribute('role', 'status'); status.id = `zorid-canvas-embed-status-${++previewSequence}`;
  element.setAttribute('aria-describedby', status.id); element.append(content, status); parent.append(element);
  let closed = false, renderedSource: string | undefined;
  const report = (error: unknown) => { if (!closed) try { options.onError?.(error); } catch { /* Observers do not own preview disposal. */ } };
  const open = (event: MouseEvent | KeyboardEvent) => {
    if (closed || event.defaultPrevented) return;
    try { Promise.resolve(options.onOpen(event)).catch(report); } catch (error) { report(error); }
  };
  const click = (event: MouseEvent) => { if (event.button === 0) open(event); };
  const auxiliary = (event: MouseEvent) => { if (event.button === 1) open(event); };
  const key = (event: KeyboardEvent) => { if (event.key === 'Enter' && !event.repeat && !event.defaultPrevented) { open(event); if (!closed) event.preventDefault(); } };
  element.addEventListener('click', click); element.addEventListener('auxclick', auxiliary); element.addEventListener('keydown', key);

  function update(source: string | CanvasDocument): boolean {
    if (closed) return false;
    try {
      const model = typeof source === 'string' ? CanvasDocument.parse(source) : source, snapshot = model.toString();
      if (snapshot === renderedSource) { element.classList.remove('has-error'); status.textContent = ''; return true; }
      const projected = projectCanvas(model), nodes = new Map<string, CanvasNode>();
      for (const [id, node] of projected.nodes) nodes.set(id, { ...node.data, width: Math.max(1, node.data.width), height: Math.max(1, node.data.height) });
      if (!nodes.size) {
        content.replaceChildren(); renderedSource = snapshot; element.classList.remove('has-error'); status.textContent = ''; element.setAttribute('aria-label', `Open Canvas: ${basename} (empty)`); return true;
      }
      const svg = document.createElementNS(svgNS, 'svg'); svg.classList.add('zorid-canvas-minimap'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const node of nodes.values()) { minX = Math.min(minX, node.x); minY = Math.min(minY, node.y); maxX = Math.max(maxX, node.x + node.width); maxY = Math.max(maxY, node.y + node.height); }
      const width = maxX - minX, height = maxY - minY, margin = Math.max(width, height) / 20;
      const bounds = [minX - margin, minY - margin, width + 2 * margin, height + 2 * margin];
      // SVG coordinate storage may use floats even though JSON numbers use
      // doubles. Reject unrepresentable extents before replacing a valid SVG.
      const coordinates = [...bounds, minX, minY, maxX, maxY, bounds[0] + bounds[2], bounds[1] + bounds[3]];
      if (!coordinates.every(value => Number.isFinite(Math.fround(value))) || !bounds.slice(2).every(value => value > 0)) throw new Error('Canvas bounds exceed the preview coordinate range');
      svg.setAttribute('viewBox', bounds.join(' ')); svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      const style = (shape: SVGElement, value: CanvasValue | undefined) => { const color = paint(value); if (color) { shape.classList.add('is-themed'); shape.style.setProperty('--preview-shape-color', color); } };
      const rectangle = (node: CanvasNode) => {
        const rect = document.createElementNS(svgNS, 'rect'); rect.dataset.nodeId = node.id;
        for (const field of ['x', 'y', 'width', 'height'] as const) rect.setAttribute(field, String(node[field]));
        rect.setAttribute('rx', '20'); rect.setAttribute('ry', '20'); style(rect, node.color); svg.append(rect);
      };
      for (const node of nodes.values()) if (node.type === 'group') rectangle(node);
      for (const edge of projected.edges.values()) {
        const path = document.createElementNS(svgNS, 'path'); path.dataset.edgeId = edge.id; path.setAttribute('d', edgePath(edge, nodes)); path.style.strokeWidth = String(Math.sqrt(width / 10)); style(path, edge.color); svg.append(path);
      }
      for (const node of nodes.values()) if (node.type !== 'group') rectangle(node);
      content.replaceChildren(svg); renderedSource = snapshot; element.classList.remove('has-error'); status.textContent = '';
      element.setAttribute('aria-label', `Open Canvas: ${basename} (${nodes.size} cards, ${projected.edges.size} connections)`);
      return true;
    } catch (error) {
      element.classList.add('has-error'); status.textContent = renderedSource === undefined ? 'Unable to display Canvas preview.' : 'Unable to update Canvas preview. Showing the last valid preview.'; report(error); return false;
    }
  }
  update(options.source);
  return { element, update, destroy() { if (closed) return; closed = true; element.removeEventListener('click', click); element.removeEventListener('auxclick', auxiliary); element.removeEventListener('keydown', key); element.remove(); content.replaceChildren(); } };
}
