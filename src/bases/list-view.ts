import type { BaseQueryResult, BaseQueryRow } from './query.ts';
import { basePresentationProperties, baseRowOpenWitness, createBaseVirtualSurface, createGroupUnit, disposePresentationResources, emptyListValue, groupIdentity, mountBaseProperty, propertyValue, reportPresentationError } from './presentation-common.ts';
import type { BasePresentationHandle, BasePresentationOptions, VirtualUnit } from './presentation-common.ts';
import { icon } from '../ui/icons.ts';

export interface BaseListViewOptions extends BasePresentationOptions {
  readonly showIndentationGuides?: boolean;
  readonly onNew?: (anchor: HTMLElement) => void | Promise<void>;
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
  const win = document.defaultView;
  let result = options.result; let epoch = 0; let destroyed = false;
  let pendingResult: BaseQueryResult | undefined;
  let activePath: string | undefined, activePosition = 0, restorePath: string | undefined, navigationFrame: number | undefined, creating = false;
  let rowTargets: { path: string; offset: number }[] = [];
  const collapsed = new Set<string>();
  const focusRow = (index: number) => {
    const target = rowTargets[index]; if (!target || destroyed) return;
    if (navigationFrame !== undefined) { win?.cancelAnimationFrame(navigationFrame); navigationFrame = undefined; }
    activePath = target.path; activePosition = index;
    const find = () => Array.from(surface.element.querySelectorAll<HTMLElement>('.bases-list-item')).find(node => node.dataset.listPosition === String(index));
    const focus = () => { if (destroyed) return; const node = find(); if (node) { for (const other of surface.element.querySelectorAll<HTMLElement>('.bases-list-item')) other.tabIndex = other === node ? 0 : -1; node.focus(); } };
    if (find()) {
      const top = surface.element.scrollTop, height = surface.element.clientHeight || 600;
      if (target.offset < top) surface.element.scrollTop = target.offset;
      else if (target.offset + 32 > top + height) surface.element.scrollTop = target.offset + 32 - height;
      if (win && top !== surface.element.scrollTop) surface.element.dispatchEvent(new win.Event('scroll'));
      focus(); return;
    }
    const owner = epoch;
    surface.element.scrollTop = target.offset;
    if (win) {
      surface.element.dispatchEvent(new win.Event('scroll'));
      navigationFrame = win.requestAnimationFrame(() => { navigationFrame = undefined; if (epoch === owner) focus(); });
    }
  };
  const mountRow = (row: BaseQueryRow, properties: readonly string[], index: number, position: number, settings: BaseListSettings, snapshot: BaseQueryResult) => {
    const owner = epoch; let live = true;
    const element = document.createElement('div'); element.className = 'bases-list-item'; element.dataset.path = row.path; element.dataset.listPosition = String(position);
    const current = () => live && !destroyed && epoch === owner && element.isConnected && container.contains(element);
    const pageRow = !settings.indentProperties && !['bullet','number','none'].includes(String(snapshot.view.markers)) && snapshot.view.separator === undefined;
    element.classList.toggle('is-page-row', pageRow); element.setAttribute('role', 'listitem'); element.setAttribute('aria-label', row.path.replace(/\.md$/i, ''));
    element.tabIndex = activePath ? activePosition === position ? 0 : -1 : position === 0 ? 0 : -1;
    const first = document.createElement('div'); first.className = 'bases-list-item-properties'; element.append(first);
    const details = document.createElement('div'); details.className = 'bases-list-item-details';
    const nested = document.createElement('div'); nested.className = 'bases-list-item-properties nested';
    if (settings.indentProperties) element.append(nested);
    const disposers: (() => void)[] = [];
    properties.forEach((property, propertyIndex) => {
      const cell = document.createElement('span'); cell.className = 'bases-list-property'; cell.classList.toggle('is-title', pageRow && propertyIndex === 0);
      const markerType = propertyIndex === 0 ? settings.markers : settings.indentProperties ? 'bullet' : 'none';
      if (markerType !== 'none') {
        const marker = document.createElement('span'); marker.className = markerType === 'number' ? 'list-number' : 'list-bullet';
        if (pageRow && propertyIndex === 0) { marker.className = 'bases-list-page-icon'; marker.append(icon('file', 16, document)); }
        else marker.textContent = markerType === 'number' ? `${index}.` : '•';
        marker.setAttribute('aria-hidden', 'true'); cell.append(marker);
      }
      const value = document.createElement('span'); value.className = 'bases-list-property-value'; cell.append(value);
      disposers.push(mountBaseProperty(value, row, property, snapshot, options, current));
      if (options.dragFile && (property === 'file.name' || property === 'file.file')) {
        value.draggable = true;
        value.addEventListener('dragstart', event => {
          if (!current() || !value.isConnected || !container.contains(value)) { event.preventDefault(); return; }
          if (event.defaultPrevented || (event.target as Element | null)?.closest('input,textarea,select,button,[contenteditable="true"]')) return;
          const selection = document.defaultView?.getSelection();
          if (selection && !selection.isCollapsed) for (let index = 0; index < selection.rangeCount; index++) {
            const range = selection.getRangeAt(index);
            if (range.intersectsNode(value)) return;
          }
          options.dragFile!(row, event);
        });
      }
      if (pageRow && propertyIndex > 0) details.append(cell);
      else if (settings.indentProperties && propertyIndex > 0) nested.append(cell);
      else {
        if (propertyIndex > 0) { const separator = document.createElement('span'); separator.className = 'bases-list-separator'; separator.textContent = settings.separator; first.append(separator); }
        first.append(cell);
      }
    });
    if (pageRow && details.childNodes.length) first.append(details);
    const open = (event: MouseEvent) => {
      if (!current() || event.defaultPrevented || ![0,1].includes(event.button)) return;
      if ((event.target as Element | null)?.closest('a,input,textarea,select,button,[contenteditable="true"],[data-base-editing]')) return;
      const selection = document.getSelection();
      if (selection && !selection.isCollapsed) for (let i = 0; i < selection.rangeCount; i++) if (selection.getRangeAt(i).intersectsNode(element)) return;
      if (element.contains(document.activeElement) && document.activeElement !== element) return;
      event.preventDefault(); options.openFile(row.path, event, baseRowOpenWitness(row));
    };
    element.addEventListener('click', open); element.addEventListener('auxclick', open);
    element.addEventListener('focus', () => { if (!current()) return; activePath = row.path; activePosition = position; for (const other of surface.element.querySelectorAll<HTMLElement>('.bases-list-item')) other.tabIndex = other === element ? 0 : -1; });
    element.addEventListener('keydown', event => {
      if (!current() || event.defaultPrevented || event.isComposing || event.target !== element) return;
      if (event.key === 'Enter') { event.preventDefault(); options.openFile(row.path, event, baseRowOpenWitness(row)); }
      else if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && ['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
        event.preventDefault(); focusRow(event.key === 'Home' ? 0 : event.key === 'End' ? rowTargets.length - 1 : Math.max(0, Math.min(rowTargets.length - 1, position + (event.key === 'ArrowDown' ? 1 : -1))));
      }
    });
    if (options.contextMenu) element.addEventListener('contextmenu', event => {
      if (current() && !event.defaultPrevented) { event.preventDefault(); options.contextMenu!(row, event); }
    });
    if (options.hoverFile) element.addEventListener('mouseover', event => {
      if (current() && (!event.relatedTarget || !element.contains(event.relatedTarget as Node))) options.hoverFile!(row, event);
    });
    return { element, dispose() { live = false; disposePresentationResources(disposers, options); } };
  };
  const surface = createBaseVirtualSurface(container, `bases-list-container${options.showIndentationGuides ? ' show-indentation-guide' : ''}`, () => {
    const snapshot = result; const settings = baseListSettings(snapshot); const units: VirtualUnit[] = [];
    const orderedProperties = settings.indentProperties ? snapshot.properties : basePresentationProperties(snapshot.properties, options.pageTitleProperty);
    rowTargets = []; let offset = 0;
    const append = (unit: VirtualUnit) => { units.push(unit); offset += unit.height; };
    snapshot.groups.forEach((group, groupIndex) => {
      const key = groupIdentity(group);
      if (group.key !== null) append(createGroupUnit(document, group, groupIndex, collapsed.has(key), () => {
        if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key); surface.refresh();
      }));
      if (collapsed.has(key)) return;
      let number = 0;
      group.rows.forEach(row => {
        // An indented row's first configured property is its parent; absent parents suppress the entire row.
        if (settings.indentProperties && (!orderedProperties.length || emptyListValue(propertyValue(row, orderedProperties[0])))) return;
        const properties = orderedProperties.filter(property => !emptyListValue(propertyValue(row, property)));
        if (!properties.length) return;
        const index = ++number, position = rowTargets.length; rowTargets.push({ path: row.path, offset });
        append({ key: `list:${groupIndex}:${row.path}`, height: settings.indentProperties ? properties.length * 28 : 32,
          mount: () => mountRow(row, properties, index, position, settings, snapshot) });
      });
    });
    const activeIndex = rowTargets.findIndex(target => target.path === activePath);
    if (activeIndex < 0) { activePath = undefined; activePosition = 0; } else activePosition = activeIndex;
    if (options.onNew) append({ key: 'list:new', height: 32, mount() {
      const owner = epoch, button = document.createElement('button'), item = document.createElement('div'); let live = true;
      item.setAttribute('role','listitem'); item.append(button);
      button.type = 'button'; button.className = 'bases-list-new'; button.append(icon('plus',16,document), document.createTextNode('New page')); button.disabled = creating;
      button.addEventListener('click', () => {
        if (!live || destroyed || epoch !== owner || !button.isConnected || creating || surface.hasActiveEdits()) return;
        creating = true; button.disabled = true;
        void Promise.resolve().then(() => { if (live && !destroyed && epoch === owner && button.isConnected) return options.onNew!(button); }).catch(error => reportPresentationError(options,error)).finally(() => { creating = false; if (!destroyed) for (const current of surface.element.querySelectorAll<HTMLButtonElement>('.bases-list-new')) current.disabled = false; });
      });
      return { element: item, dispose() { live = false; } };
    } });
    if (restorePath) { const path = restorePath, owner = epoch; restorePath = undefined; queueMicrotask(() => { if (!destroyed && epoch === owner && document.activeElement === document.body) focusRow(rowTargets.findIndex(target => target.path === path)); }); }
    return units;
  }, error => reportPresentationError(options, error), {
    beforeRefresh() {
      const focused = document.activeElement as HTMLElement | null;
      if (focused?.classList.contains('bases-list-item') && container.contains(focused)) restorePath = focused.dataset.path;
      if (pendingResult) { result = pendingResult; pendingResult = undefined; epoch++; }
    },
    onEditStateChange: options.onEditStateChange,
  });
  surface.element.setAttribute('role','list'); surface.element.setAttribute('aria-label', result.view.name);
  surface.refresh();
  return {
    update(next) { if (destroyed) return; pendingResult = next; surface.element.setAttribute('aria-label',next.view.name); surface.refresh(); },
    hasActiveEdits() { return surface.hasActiveEdits(); },
    refreshLayout() { if (!destroyed) surface.refresh(); },
    destroy() { if (destroyed) return; destroyed = true; pendingResult = undefined; epoch++; if (navigationFrame !== undefined) win?.cancelAnimationFrame(navigationFrame); surface.destroy(); collapsed.clear(); },
  };
}
