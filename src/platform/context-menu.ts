export type ContextMenuRole = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'pasteAndMatchStyle' | 'selectAll';
export type ContextMenuItem =
  | { type: 'separator' }
  | { id: string; label: string; enabled?: boolean; checked?: boolean }
  | { label: string; submenu: ContextMenuItem[]; enabled?: boolean }
  | { role: ContextMenuRole; label?: string; enabled?: boolean };
export interface ContextMenuRequest { x: number; y: number; items: ContextMenuItem[] }
export interface ContextMenuOptions { document?: Document }
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
  openMenus.get(doc)?.();
  const request = { x: event.clientX, y: event.clientY, items };
  const bridge = doc.defaultView?.zorid;
  if (bridge?.showContextMenu) return bridge.showContextMenu(request);
  if (!items.length) return Promise.resolve(null);
  return showBrowserMenu(doc, request);
}

function showBrowserMenu(doc: Document, request: ContextMenuRequest): Promise<string | null> {
  return new Promise(resolve => {
    const prior = doc.activeElement as HTMLElement | null;
    const selection = doc.getSelection();
    const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
    const input = prior && ('selectionStart' in prior) ? prior as HTMLInputElement : null;
    const inputSelection = input ? [input.selectionStart, input.selectionEnd, input.selectionDirection] as const : null;
    const root = doc.createElement('div');
    root.className = 'context-menu';
    root.role = 'menu';
    root.setAttribute('aria-label', 'Context menu');
    root.style.position = 'fixed';
    root.style.zIndex = '1500';
    let done = false;
    const restore = () => {
      if (!prior?.isConnected) return;
      prior.focus({ preventScroll: true });
      if (input && inputSelection && inputSelection[0] !== null && inputSelection[1] !== null) {
        try { input.setSelectionRange(inputSelection[0], inputSelection[1], inputSelection[2] || undefined); } catch { /* Non-text input. */ }
      } else if (selection && ranges.every(range => range.startContainer.isConnected && range.endContainer.isConnected)) {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
    };
    const finish = (id: string | null = null, restoreFocus = true) => {
      if (done) return;
      done = true;
      if (openMenus.get(doc) === dismiss) openMenus.delete(doc);
      if (restoreFocus) restore();
      root.remove();
      doc.removeEventListener('pointerdown', outside, true);
      doc.removeEventListener('contextmenu', outside, true);
      doc.removeEventListener('keydown', keydown, true);
      doc.defaultView?.removeEventListener('blur', dismiss);
      resolve(id);
    };
    const dismiss = () => finish();
    const outside = (event: Event) => { if (!root.contains(event.target as Node)) finish(null, false); };
    const panels: { menu: HTMLElement; buttons: HTMLButtonElement[]; parent?: HTMLButtonElement }[] = [];
    let current = 0;
    const focus = (index: number) => {
      const buttons = panels[current].buttons;
      if (buttons.length) buttons[(index + buttons.length) % buttons.length].focus({ preventScroll: true });
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
            if (row.disabled) return;
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
          row.addEventListener('pointerenter', () => { closeChildren(level); });
          row.addEventListener('click', () => {
            if (row.disabled) return;
            if ('role' in item) {
              restore();
              if (item.role === 'selectAll' && input) input.select();
              else if (item.role !== 'pasteAndMatchStyle') doc.execCommand?.(item.role);
              // Browser plain-text paste cannot be emulated synchronously without
              // privileged clipboard access; use its native paste menu instead.
              finish(null, false);
            } else finish(item.id);
          });
          if ('role' in item && item.role === 'pasteAndMatchStyle') row.disabled = true;
        }
      }
      panel.buttons = panel.buttons.filter(row => !row.disabled);
    };
    const keydown = (event: KeyboardEvent) => {
      // A menu owns keyboard context until dismissal; application shortcuts
      // must not fire behind it while focus is on a menu item.
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
    focus(0);
  });
}
