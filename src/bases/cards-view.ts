import type { BaseExpressionValue } from './expression.ts';
import type { BaseQueryResult, BaseQueryRow } from './query.ts';
import { createBaseVirtualSurface, createGroupUnit, disposePresentationResources, groupIdentity, mountBaseProperty, propertyValue, reportPresentationError } from './presentation-common.ts';
import type { BasePresentationHandle, BasePresentationOptions, VirtualUnit } from './presentation-common.ts';

export interface BaseCardsViewOptions extends BasePresentationOptions {
  /** The host resolves only permitted vault/remote resources and owns URL revocation. */
  readonly loadThumbnail?: (request: {
    readonly row: BaseQueryRow; readonly property: string; readonly value: BaseExpressionValue;
    readonly version: BaseQueryResult['version']; readonly signal: AbortSignal;
  }) => Promise<{ readonly url: string; dispose(): void } | null>;
}
export interface BaseCardsSettings { readonly cardSize: number; readonly image: string | null; readonly imageFit: 'cover' | 'contain'; readonly imageAspectRatio: number }
export function baseCardsSettings(result: BaseQueryResult): BaseCardsSettings {
  const view = result.view;
  return {
    cardSize: typeof view.cardSize === 'number' && Number.isFinite(view.cardSize) && view.cardSize > 0 ? view.cardSize : 200,
    image: typeof view.image === 'string' && view.image ? (view.image === 'file' ? 'file.file' : /^(?:note|file|formula)\./.test(view.image) ? view.image : `note.${view.image}`) : null,
    imageFit: view.imageFit === 'contain' ? 'contain' : 'cover',
    imageAspectRatio: typeof view.imageAspectRatio === 'number' && Number.isFinite(view.imageAspectRatio) && view.imageAspectRatio > 0 ? view.imageAspectRatio : 1,
  };
}

export function createBaseCardsView(container: HTMLElement, options: BaseCardsViewOptions): BasePresentationHandle {
  const document = container.ownerDocument;
  let result = options.result; let epoch = 0; let destroyed = false;
  const collapsed = new Set<string>();
  const mountCard = (row: BaseQueryRow, settings: BaseCardsSettings, snapshot: BaseQueryResult, height: number) => {
    const owner = epoch; let live = true;
    const current = () => live && !destroyed && owner === epoch;
    const card = document.createElement('div'); card.className = 'bases-cards-item'; card.tabIndex = 0;
    card.dataset.path = row.path; card.style.height = `${height}px`;
    const cleanups: (() => void)[] = [];
    if (settings.image) {
      const cover = document.createElement('div'); cover.className = 'bases-cards-cover';
      cover.style.aspectRatio = String(1 / settings.imageAspectRatio); card.append(cover);
      if (options.loadThumbnail) {
        const controller = new AbortController(); cleanups.push(() => controller.abort());
        const property = settings.image;
        // A later update/scroll can retire this owner before even a synchronous host throw.
        Promise.resolve().then(() => current() ? options.loadThumbnail!({ row, property,
          value: propertyValue(row, property), version: snapshot.version, signal: controller.signal }) : null).then(resource => {
          if (!resource) return;
          if (!current()) { disposePresentationResources([() => resource.dispose()], options); return; }
          cleanups.push(() => resource.dispose());
          const image = document.createElement('img'); image.alt = ''; image.draggable = false;
          image.style.objectFit = settings.imageFit; image.src = resource.url; cover.append(image);
        }).catch(error => { if (current() && !controller.signal.aborted) reportPresentationError(options, error); });
      }
    }
    const properties = document.createElement('div'); properties.className = 'bases-cards-properties'; card.append(properties);
    snapshot.properties.forEach((property, index) => {
      const cell = document.createElement('div'); cell.className = `bases-cards-property${index === 0 ? ' mod-title' : ''}`;
      const label = document.createElement('div'); label.className = 'bases-cards-label';
      label.textContent = options.getPropertyLabel?.(property) ?? property.replace(/^(?:note|file|formula)\./, '');
      const line = document.createElement('div'); line.className = 'bases-cards-line'; cell.append(label, line); properties.append(cell);
      cleanups.push(mountBaseProperty(line, row, property, snapshot, options, current));
    });
    const activate = (event: MouseEvent) => {
      if (!current() || event.defaultPrevented || (event.button !== 0 && event.button !== 1)) return;
      const target = event.target as Element | null;
      if (target?.closest('a,input,textarea,select,button,[contenteditable="true"]')) return;
      const selection = document.defaultView?.getSelection();
      if (selection && !selection.isCollapsed) for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        if (card.contains(range.startContainer) || card.contains(range.endContainer)) return;
      }
      const active = document.activeElement;
      if (active !== card && active && card.contains(active)) return;
      event.preventDefault(); options.openFile(row.path, event);
    };
    card.addEventListener('click', activate); card.addEventListener('auxclick', activate);
    card.addEventListener('keydown', event => {
      if (current() && !event.isComposing && !event.defaultPrevented && event.target === card && event.key === 'Enter') {
        event.preventDefault(); options.openFile(row.path, event);
      }
    });
    if (options.contextMenu) card.addEventListener('contextmenu', event => {
      if (current() && !event.defaultPrevented) { event.preventDefault(); options.contextMenu!(row, event); }
    });
    if (options.hoverFile) card.addEventListener('mouseover', event => {
      if (current() && (!event.relatedTarget || !card.contains(event.relatedTarget as Node))) options.hoverFile!(row, event);
    });
    if (options.dragFile) { card.draggable = true; card.addEventListener('dragstart', event => { if (current()) options.dragFile!(row, event); }); }
    return { element: card, dispose() { live = false; disposePresentationResources(cleanups, options); } };
  };
  const surface = createBaseVirtualSurface(container, 'bases-cards-container', width => {
    const snapshot = result; const settings = baseCardsSettings(snapshot);
    const columns = Math.max(1, Math.floor(width / settings.cardSize));
    const cardWidth = Math.max(1, (width - (columns - 1) * 12) / columns);
    const count = snapshot.properties.length;
    const cardHeight = (settings.image ? cardWidth * settings.imageAspectRatio : 0) + (count ? 38 + Math.max(0, count - 1) * 50 : 0);
    const units: VirtualUnit[] = [];
    snapshot.groups.forEach((group, groupIndex) => {
      const key = groupIdentity(group);
      if (group.key !== null) units.push(createGroupUnit(document, group, groupIndex, collapsed.has(key), () => {
        if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key); surface.refresh();
      }));
      if (collapsed.has(key)) return;
      for (let index = 0; index < group.rows.length; index += columns) {
        const rows = group.rows.slice(index, index + columns);
        units.push({ key: `cards:${groupIndex}:${index}`, height: Math.max(1, cardHeight) + 12, mount() {
          const strip = document.createElement('div'); strip.className = 'bases-cards-row';
          strip.style.gridTemplateColumns = `repeat(${columns},minmax(0,1fr))`;
          const cards = rows.map(row => mountCard(row, settings, snapshot, cardHeight));
          strip.append(...cards.map(card => card.element));
          return { element: strip, dispose() { disposePresentationResources(cards.map(card => () => card.dispose()), options); } };
        } });
      }
    });
    return units;
  }, error => reportPresentationError(options, error));
  surface.refresh();
  return {
    update(next) { if (destroyed) return; result = next; epoch++; surface.refresh(); },
    refreshLayout() { if (!destroyed) surface.refresh(); },
    destroy() { if (destroyed) return; destroyed = true; epoch++; surface.destroy(); collapsed.clear(); },
  };
}
