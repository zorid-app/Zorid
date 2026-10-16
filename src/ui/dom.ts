import { icon } from './icons.ts';
export { icon } from './icons.ts';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
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
