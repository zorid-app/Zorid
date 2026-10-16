import type { BaseQueryResult, BaseQueryRow } from './query.ts';
import { createBaseVirtualSurface, createGroupUnit, emptyListValue, groupIdentity, mountBaseProperty, propertyValue } from './presentation-common.ts';
import type { BasePresentationHandle, BasePresentationOptions, VirtualUnit } from './presentation-common.ts';

export interface BaseListViewOptions extends BasePresentationOptions {
  readonly showIndentationGuides?: boolean;
}
export interface BaseListSettings { readonly markers: 'bullet' | 'number' | 'none'; readonly indentProperties: boolean; readonly separator: string }
export function baseListSettings(result: BaseQueryResult): BaseListSettings {
  const view = result.view;
  return { markers: view.markers === 'number' || view.markers === 'none' ? view.markers : 'bullet',
    indentProperties: !!view.indentProperties, separator: String(view.separator || ', ') };
}

/** List rows are variable-height measured units; only visible rows retain DOM/widgets. */
export function createBaseListView(container: HTMLElement, options: BaseListViewOptions): BasePresentationHandle {
  const document = container.ownerDocument;
  let result = options.result; let epoch = 0; let destroyed = false;
  const collapsed = new Set<string>();
  const mountRow = (row: BaseQueryRow, properties: readonly string[], index: number, settings: BaseListSettings, snapshot: BaseQueryResult) => {
    const owner = epoch; let live = true;
    const current = () => live && !destroyed && epoch === owner;
    const element = document.createElement('div'); element.className = 'bases-list-item'; element.dataset.path = row.path;
    const first = document.createElement('div'); first.className = 'bases-list-item-properties'; element.append(first);
    const nested = document.createElement('div'); nested.className = 'bases-list-item-properties nested';
    if (settings.indentProperties) element.append(nested);
    const disposers: (() => void)[] = [];
    properties.forEach((property, propertyIndex) => {
      const cell = document.createElement('span'); cell.className = 'bases-list-property';
      const markerType = propertyIndex === 0 ? settings.markers : settings.indentProperties ? 'bullet' : 'none';
      if (markerType !== 'none') {
        const marker = document.createElement('span'); marker.className = markerType === 'number' ? 'list-number' : 'list-bullet';
        marker.textContent = markerType === 'number' ? `${index}.` : '•'; marker.setAttribute('aria-hidden', 'true'); cell.append(marker);
      }
      const value = document.createElement('span'); cell.append(value);
      disposers.push(mountBaseProperty(value, row, property, snapshot, options, current));
      if (settings.indentProperties && propertyIndex > 0) nested.append(cell);
      else {
        if (propertyIndex > 0) { const separator = document.createElement('span'); separator.className = 'bases-list-separator'; separator.textContent = settings.separator; first.append(separator); }
        first.append(cell);
      }
    });
    if (options.contextMenu) element.addEventListener('contextmenu', event => {
      if (current() && !event.defaultPrevented) { event.preventDefault(); options.contextMenu!(row, event); }
    });
    if (options.hoverFile) element.addEventListener('mouseover', event => {
      if (current() && (!event.relatedTarget || !element.contains(event.relatedTarget as Node))) options.hoverFile!(row, event);
    });
    return { element, dispose() { live = false; for (const dispose of disposers) dispose(); } };
  };
  const surface = createBaseVirtualSurface(container, `bases-list-container${options.showIndentationGuides ? ' show-indentation-guide' : ''}`, () => {
    const snapshot = result; const settings = baseListSettings(snapshot); const units: VirtualUnit[] = [];
    snapshot.groups.forEach((group, groupIndex) => {
      const key = groupIdentity(group);
      if (group.key !== null) units.push(createGroupUnit(document, group, groupIndex, collapsed.has(key), () => {
        if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key); surface.refresh();
      }));
      if (collapsed.has(key)) return;
      let number = 0;
      group.rows.forEach(row => {
        // An indented row's first configured property is its parent; absent parents suppress the entire row.
        if (settings.indentProperties && (!snapshot.properties.length || emptyListValue(propertyValue(row, snapshot.properties[0])))) return;
        const properties = snapshot.properties.filter(property => !emptyListValue(propertyValue(row, property)));
        if (!properties.length) return;
        const index = ++number;
        units.push({ key: `list:${groupIndex}:${row.path}`, height: settings.indentProperties ? properties.length * 28 : 32,
          mount: () => mountRow(row, properties, index, settings, snapshot) });
      });
    });
    return units;
  });
  surface.refresh();
  return {
    update(next) { if (destroyed) return; result = next; epoch++; surface.refresh(); },
    refreshLayout() { if (!destroyed) surface.refresh(); },
    destroy() { if (destroyed) return; destroyed = true; epoch++; surface.destroy(); collapsed.clear(); },
  };
}
