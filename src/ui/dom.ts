export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const paths: Record<string, string> = {
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6',
  folder: 'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  plus: 'M12 5v14 M5 12h14', close: 'M6 6l12 12 M18 6L6 18',
  left: 'M15 18l-6-6 6-6', right: 'M9 18l6-6-6-6', down: 'M6 9l6 6 6-6',
  sidebar: 'M3 3h18v18H3z M9 3v18', rightbar: 'M3 3h18v18H3z M15 3v18',
  book: 'M12 5v16 M12 5C8 2 5 3 2 3v16c4 0 6 0 10 2 4-2 6-2 10-2V3c-4 0-6 0-10 2',
  edit: 'M16 3l5 5 M4 15L17 2l5 5L9 20l-6 1z',
  code: 'M8 5l-6 7 6 7 M16 5l6 7-6 7 M14 3l-4 18',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 2h6l1 4 4 1 2 5-3 3 1 4-5 3-3-3-4 1-3-5 3-3-1-4 4-2z',
  graph: 'M5 5l14 3-7 12z M5 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4 M19 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4 M12 18a2 2 0 1 0 0 4 2 2 0 0 0 0-4',
  calendar: 'M3 5h18v16H3z M3 10h18 M7 2v6 M17 2v6',
  terminal: 'M4 5l6 7-6 7 M12 19h8',
  link: 'M10 13l4-4 M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0 M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0',
  list: 'M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01',
  tag: 'M20 13L10 3H3v7l10 10z M7 7h.01',
  bookmark: 'M5 3h14v18l-7-5-7 5z',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  sort: 'M4 5h16 M4 12h10 M4 19h4',
  collapse: 'M5 9l7-6 7 6 M5 15l7 6 7-6',
  trash: 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
  split: 'M3 3h18v18H3z M12 3v18',
  help: 'M9 9a3 3 0 1 1 5 2c-2 1-2 2-2 3 M12 17h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  check: 'M4 12l5 5L20 6',
};

export function icon(name: string, size = 18): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: String(size), height: String(size), fill: 'none', stroke: 'currentColor', 'stroke-width': '1.65', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', paths[name] ?? paths.file);
  svg.append(path);
  return svg;
}

export function button(name: string, label: string, action: (event: MouseEvent) => void, className = ''): HTMLButtonElement {
  const node = el('button', `icon-button ${className}`);
  node.type = 'button'; node.title = label; node.setAttribute('aria-label', label);
  node.append(icon(name)); node.addEventListener('click', action);
  return node;
}

export function textButton(text: string, action: () => void, className = ''): HTMLButtonElement {
  const node = el('button', className, text); node.type = 'button'; node.onclick = action; return node;
}

export function notice(message: string): void {
  const node = el('div', 'notice', message); node.setAttribute('role', 'status'); document.body.append(node);
  setTimeout(() => node.remove(), 5000);
}

export function modal(title: string): { content: HTMLDivElement; close: () => void } {
  const previouslyFocused = document.activeElement as HTMLElement | null;
  const overlay = el('div', 'modal-overlay');
  const box = el('div', 'modal'); box.role = 'dialog'; box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', title);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', keydown, true); previouslyFocused?.focus(); };
  const keydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
    if (event.key === 'Tab') {
      const items = [...box.querySelectorAll<HTMLElement>('button:not([disabled]),input,select,textarea,[tabindex="0"]')].filter(n => n.offsetParent !== null);
      const current = items.indexOf(document.activeElement as HTMLElement);
      if (!items.length) { event.preventDefault(); return; }
      if (event.shiftKey && current <= 0) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && current === items.length - 1) { event.preventDefault(); items[0].focus(); }
    }
  };
  document.addEventListener('keydown', keydown, true);
  overlay.addEventListener('mousedown', event => { if (event.target === overlay) close(); });
  overlay.append(box); document.body.append(overlay);
  return { content: box, close };
}

export function promptName(title: string, initial = '', confirm = 'Create'): Promise<string | null> {
  return new Promise(resolve => {
    const {content, close} = modal(title);
    content.classList.add('prompt-modal'); content.append(el('h2', '', title));
    const input = el('input'); input.value = initial; input.setAttribute('aria-label', title);
    const buttons = el('div','modal-buttons');
    const submit = () => { const value = input.value.trim(); if (value) { close(); resolve(value); } };
    buttons.append(textButton('Cancel', () => { close(); resolve(null); }), textButton(confirm, submit, 'mod-cta'));
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    // Resolve cancellation also when Escape/backdrop removes the modal.
    const observer = new MutationObserver(() => { if (!content.isConnected) { observer.disconnect(); resolve(null); } });
    observer.observe(document.body, {childList:true});
    content.append(input, buttons); input.focus(); input.select();
  });
}
