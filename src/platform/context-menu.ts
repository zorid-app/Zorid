import { icon } from '../ui/icons.ts';
export type ContextMenuRole = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'pasteAndMatchStyle' | 'selectAll';
export type ContextMenuItem =
  | { type: 'separator' }
  | { id: string; label: string; enabled?: boolean; checked?: boolean; icon?: string }
  | { label: string; submenu: ContextMenuItem[]; enabled?: boolean }
  | { role: ContextMenuRole; label?: string; enabled?: boolean };
export interface ContextMenuRequest { x: number; y: number; items: ContextMenuItem[] }
export interface ContextMenuOptions {
  document?: Document;
  /** Guarded sessions use renderer roles; raw native roles cannot validate this witness. */
  isCurrent?: () => boolean;
  signal?: AbortSignal;
}
function menuCurrent(options: ContextMenuOptions): boolean {
  try { return !options.signal?.aborted && (options.isCurrent?.() ?? true); }
  catch { return false; }
}
const openMenus = new WeakMap<Document, () => void>();
const roleLabels: Record<ContextMenuRole, string> = {
  undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste',
  pasteAndMatchStyle: 'Paste as plain text', selectAll: 'Select all',
};

/** Call on workspace teardown or vault replacement to settle pending actions. */
export async function dismissContextMenu(doc: Document = document): Promise<void> {
  openMenus.get(doc)?.();
  await doc.defaultView?.zorid?.dismissContextMenu?.();
}

/** Returns an action ID, or null for dismissal/native edit roles. Callers own
 * actions and revalidate their target after awaiting; no closures cross IPC. */
export function showContextMenu(
  event: { clientX: number; clientY: number; preventDefault?(): void; stopPropagation?(): void; target?: EventTarget | null; view?: Window | null },
  items: ContextMenuItem[], options: ContextMenuOptions = {},
): Promise<string | null> {
  event.preventDefault?.();
  event.stopPropagation?.();
  const target = event.target as Node | null | undefined;
  const doc = options.document || target?.ownerDocument || event.view?.document || document;
  if (!menuCurrent(options)) return Promise.resolve(null);
  openMenus.get(doc)?.();
  const request = { x: event.clientX, y: event.clientY, items };
  const bridge = doc.defaultView?.zorid;
  // Interaction-gated editor roles must execute only after the renderer
  // witness check. Default desktop callers retain their native menu path.
  if (bridge?.showContextMenu && !options.isCurrent) return bridge.showContextMenu(request);
  if (!items.length) return Promise.resolve(null);
  return showBrowserMenu(doc, request, options);
}

function showBrowserMenu(doc: Document, request: ContextMenuRequest, options: ContextMenuOptions): Promise<string | null> {
  return new Promise(resolve => {
    const prior = doc.activeElement as HTMLElement | null;
    const selection = doc.getSelection();
    // DOM Ranges are live: cloning one does not freeze its endpoints through a
    // render. Keep node/offset values, and never guess where detached text moved.
    const point = (node: Node | null, offset: number) => node ? {
      node, offset, parent: node.parentNode, text: node.textContent,
    } : null;
    const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => {
      const range = selection.getRangeAt(index);
      return { start: point(range.startContainer, range.startOffset)!, end: point(range.endContainer, range.endOffset)! };
    }) : [];
    const anchor = point(selection?.anchorNode ?? null, selection?.anchorOffset ?? 0);
    const focusPoint = point(selection?.focusNode ?? null, selection?.focusOffset ?? 0);
    const input = prior && ('selectionStart' in prior) ? prior as HTMLInputElement : null;
    const inputSelection = input ? [input.selectionStart, input.selectionEnd, input.selectionDirection] as const : null;
    const inputState = input ? { value: input.value, type: input.type, disabled: input.disabled, readOnly: input.readOnly } : null;
    const owner = prior;
    const ownerParent = prior?.parentNode;
    const editable = prior?.contentEditable;
    const root = doc.createElement('div');
    const ownerText = () => owner ? Array.from(owner.childNodes).filter(node => node !== root).map(node => node.textContent ?? '').join('') : '';
    const originalText = ownerText();
    const validPoint = (value: NonNullable<ReturnType<typeof point>>) => value.node.isConnected &&
      value.node.ownerDocument === doc && value.node.parentNode === value.parent && value.node.textContent === value.text &&
      value.offset <= (value.node.nodeValue !== null ? value.node.nodeValue.length : value.node.childNodes.length);
    const ownsState = () => menuCurrent(options) && !!prior?.isConnected && prior.ownerDocument === doc &&
      prior.parentNode === ownerParent && prior.contentEditable === editable &&
      (input && inputState ? input.value === inputState.value && input.type === inputState.type &&
        input.disabled === inputState.disabled && input.readOnly === inputState.readOnly :
        ownerText() === originalText && ranges.every(range => validPoint(range.start) && validPoint(range.end)));
    root.className = 'context-menu';
    root.role = 'menu';
    root.setAttribute('aria-label', 'Context menu');
    root.style.position = 'fixed';
    root.style.zIndex = '1500';
    let done = false;
    const restoreSelection = () => {
      if ((!root.contains(doc.activeElement) && doc.activeElement !== prior) || !ownsState()) return false;
      // Reconstruct before changing focus/selection so invalid endpoints cannot
      // partially clear a newer selection.
      const restored = input ? [] : ranges.map(({ start, end }) => {
        const range = doc.createRange();
        range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
        return range;
      });
      prior!.focus({ preventScroll: true });
      // A Reading selection can have BODY as its owner; BODY is normally not
      // focusable, so release the menu button rather than requiring a tabindex.
      if (prior === doc.body && root.contains(doc.activeElement)) (doc.activeElement as HTMLElement).blur();
      // Focus handlers can synchronously replace a document or input value.
      if (doc.activeElement !== prior || !ownsState()) return false;
      if (input && inputSelection && inputSelection[0] !== null && inputSelection[1] !== null) {
        try { input.setSelectionRange(inputSelection[0], inputSelection[1], inputSelection[2] || undefined); } catch { /* Non-text input. */ }
      } else if (selection && restored.length) {
        selection.removeAllRanges();
        for (const range of restored) selection.addRange(range);
        if (restored.length === 1 && anchor && focusPoint && validPoint(anchor) && validPoint(focusPoint)) {
          selection.setBaseAndExtent(anchor.node, anchor.offset, focusPoint.node, focusPoint.offset);
        }
      }
      return true;
    };
    const restore = () => {
      try { return restoreSelection(); } catch { return false; }
    };
    const finish = (id: string | null = null, restoreFocus = true) => {
      if (done) return;
      done = true;
      if (openMenus.get(doc) === dismiss) openMenus.delete(doc);
      try { if (restoreFocus) restore(); }
      finally {
        root.remove();
        doc.removeEventListener('pointerdown', outside, true);
        doc.removeEventListener('contextmenu', outside, true);
        doc.removeEventListener('keydown', keydown, true);
        doc.defaultView?.removeEventListener('blur', dismiss);
        options.signal?.removeEventListener('abort', abort);
        resolve(menuCurrent(options) ? id : null);
      }
    };
    const dismiss = () => finish();
    const abort = () => finish(null, false);
    const outside = (event: Event) => { if (!root.contains(event.target as Node)) finish(null, false); };
    const panels: { menu: HTMLElement; buttons: HTMLButtonElement[]; parent?: HTMLButtonElement }[] = [];
    let current = 0;
    const focus = (index: number) => {
      const buttons = panels[current].buttons;
      if (buttons.length) buttons[(index + buttons.length) % buttons.length].focus({ preventScroll: true });
      else panels[current].menu.focus({ preventScroll: true });
    };
    const closeChildren = (index: number) => {
      while (panels.length > index + 1) {
        const panel = panels.pop()!;
        panel.parent?.setAttribute('aria-expanded', 'false');
        panel.menu.remove();
      }
      current = index;
    };
    const position = (menu: HTMLElement, x: number, y: number) => {
      const width = menu.offsetWidth || 230, height = menu.offsetHeight || menu.children.length * 34 + 12;
      menu.style.left = `${Math.max(4, Math.min(x, (doc.defaultView?.innerWidth || 1024) - width - 4))}px`;
      menu.style.top = `${Math.max(4, Math.min(y, (doc.defaultView?.innerHeight || 768) - height - 4))}px`;
      menu.style.maxHeight = 'calc(100vh - 8px)';
      menu.style.overflowY = 'auto';
    };
    const fill = (menu: HTMLElement, entries: ContextMenuItem[], parent?: HTMLButtonElement) => {
      menu.tabIndex = -1;
      const panel = { menu, buttons: [] as HTMLButtonElement[], parent };
      const level = panels.push(panel) - 1;
      for (const item of entries) {
        if ('type' in item) {
          const separator = doc.createElement('hr'); separator.role = 'separator'; menu.append(separator); continue;
        }
        const row = doc.createElement('button');
        row.type = 'button'; row.className = 'context-menu-item'; row.tabIndex = -1;
        row.role = 'checked' in item ? 'menuitemcheckbox' : 'menuitem';
        if ('checked' in item) row.setAttribute('aria-checked', String(item.checked));
        row.textContent = item.label ?? ('role' in item ? roleLabels[item.role] : '');
        if ('icon' in item && item.icon) { const glyph = icon(item.icon, 16, doc); glyph.classList.add('context-menu-icon'); row.prepend(glyph); }
        row.disabled = item.enabled === false;
        if ('role' in item && item.role !== 'selectAll' && typeof doc.execCommand !== 'function') row.disabled = true;
        if ('role' in item && item.role === 'paste') {
          try { if (!doc.queryCommandEnabled?.('paste')) row.disabled = true; } catch { row.disabled = true; }
        }
        menu.append(row);
        if (!row.disabled) panel.buttons.push(row);
        row.addEventListener('pointerdown', event => event.preventDefault());
        if ('submenu' in item) {
          row.setAttribute('aria-haspopup', 'menu'); row.setAttribute('aria-expanded', 'false');
          const open = () => {
            if (done || row.disabled) return;
            if (!menuCurrent(options)) { finish(null, false); return; }
            closeChildren(level);
            const sub = doc.createElement('div'); sub.className = 'context-menu'; sub.role = 'menu';
            sub.setAttribute('aria-label', item.label); sub.style.position = 'fixed';
            root.append(sub); fill(sub, item.submenu, row);
            const rect = row.getBoundingClientRect(); position(sub, rect.right, rect.top);
            row.setAttribute('aria-expanded', 'true'); current = panels.length - 1; focus(0);
          };
          row.addEventListener('click', open);
          row.addEventListener('pointerenter', open);
        } else {
          row.addEventListener('pointerenter', () => {
            if (done) return;
            if (!menuCurrent(options)) { finish(null, false); return; }
            // Move focus before removing a focused descendant submenu.
            if (!row.disabled) row.focus({ preventScroll: true });
            else menu.focus({ preventScroll: true });
            closeChildren(level);
          });
          row.addEventListener('click', () => {
            if (done || row.disabled) return;
            if (!menuCurrent(options)) { finish(null, false); return; }
            if ('role' in item) {
              if (!root.contains(doc.activeElement) || !restore()) { finish(null, false); return; }
              try {
                if (!menuCurrent(options)) return;
                if (item.role === 'selectAll' && input) input.select();
                else if (item.role !== 'pasteAndMatchStyle') doc.execCommand?.(item.role);
                // Browser plain-text paste cannot be emulated synchronously without
                // privileged clipboard access; use its native paste menu instead.
              } catch { /* Unsupported or denied browser commands dismiss normally. */ }
              finally { finish(null, false); }
            } else finish(item.id);
          });
          if ('role' in item && item.role === 'pasteAndMatchStyle') row.disabled = true;
        }
      }
      panel.buttons = panel.buttons.filter(row => !row.disabled);
    };
    const keydown = (event: KeyboardEvent) => {
      // Programmatic focus changes also end menu ownership; do not swallow a
      // key now intended for another control or restore the previous editor.
      if (!menuCurrent(options) || !root.contains(doc.activeElement)) { finish(null, false); return; }
      // A menu owns keyboard context until dismissal; application shortcuts
      // must not fire behind it while focus is on a menu item.
      event.preventDefault();
      event.stopPropagation();
      const panelIndex = panels.findIndex(panel => panel.buttons.includes(doc.activeElement as HTMLButtonElement));
      if (panelIndex >= 0) current = panelIndex;
      const panel = panels[current], index = panel.buttons.indexOf(doc.activeElement as HTMLButtonElement);
      if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); finish(); return; }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight', 'ArrowLeft', 'Enter', ' '].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'ArrowDown') focus(index + 1);
        else if (event.key === 'ArrowUp') focus(index - 1);
        else if (event.key === 'Home') focus(0);
        else if (event.key === 'End') focus(panel.buttons.length - 1);
        else if (event.key === 'ArrowLeft' && current > 0) { const parent = panel.parent; closeChildren(current - 1); parent?.focus(); }
        else if (event.key !== 'ArrowLeft' && (event.key !== 'ArrowRight' || panel.buttons[index]?.hasAttribute('aria-haspopup'))) panel.buttons[index]?.click();
      }
    };
    fill(root, request.items);
    doc.body.append(root); position(root, request.x, request.y);
    openMenus.set(doc, dismiss);
    doc.addEventListener('pointerdown', outside, true);
    doc.addEventListener('contextmenu', outside, true);
    doc.addEventListener('keydown', keydown, true);
    doc.defaultView?.addEventListener('blur', dismiss);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (!menuCurrent(options)) abort(); else focus(0);
  });
}
