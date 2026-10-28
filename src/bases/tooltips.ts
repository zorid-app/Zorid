/** Delegated hints for supported database controls. Callers own command labels
 * and shortcuts, and remove native title attributes when adding these markers. */
export interface BaseTooltipOptions { readonly hoverDelayMs?: number }
const owners = new WeakMap<Document, () => void>();
let sequence = 0;

export function mountBaseTooltips(host: HTMLElement, options: BaseTooltipOptions = {}): { destroy(): void } {
  const doc = host.ownerDocument, win = doc.defaultView;
  if (!win) return { destroy() {} };
  const delay = Math.max(0, options.hoverDelayMs ?? 400);
  let destroyed = false, hovered: HTMLElement | undefined, focused: HTMLElement | undefined;
  let preferred: 'hover' | 'focus' = 'hover', dismissed: HTMLElement | undefined;
  let anchor: HTMLElement | undefined, tip: HTMLElement | undefined, timer: number | undefined;
  let description: string | undefined, observer: MutationObserver | undefined;
  const eligible = (node: HTMLElement | undefined): node is HTMLElement => !!node && host.isConnected && node.isConnected
    && host.contains(node) && !!node.dataset.baseTooltip?.trim() && !node.closest('[hidden],[inert],[aria-hidden="true"]');
  const target = (node: EventTarget | null): HTMLElement | undefined => {
    const found = node instanceof win.Element ? node.closest<HTMLElement>('[data-base-tooltip]') ?? undefined : undefined;
    return eligible(found) ? found : undefined;
  };
  const position = () => {
    if (!tip || !anchor) return;
    const rect = anchor.getBoundingClientRect(), bounds = tip.getBoundingClientRect(), margin = 8, gap = 7;
    const left = rect.left + rect.width / 2 - bounds.width / 2;
    const below = rect.bottom + gap, above = rect.top - bounds.height - gap;
    tip.style.left = `${Math.max(margin, Math.min(left, win.innerWidth - bounds.width - margin))}px`;
    tip.style.top = `${Math.max(margin, below + bounds.height <= win.innerHeight - margin ? below : above)}px`;
  };
  const hide = () => {
    if (timer !== undefined) win.clearTimeout(timer); timer = undefined;
    observer?.disconnect(); observer = undefined;
    if (anchor && description) {
      const ids = (anchor.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(id => id && id !== description);
      if (ids.length) anchor.setAttribute('aria-describedby', ids.join(' ')); else anchor.removeAttribute('aria-describedby');
    }
    tip?.remove(); tip = undefined; anchor = undefined; description = undefined;
    doc.removeEventListener('keydown', key, true); doc.removeEventListener('pointerdown', dismiss, true);
    win.removeEventListener('scroll', dismiss, true); win.removeEventListener('resize', dismiss);
    if (owners.get(doc) === hide) owners.delete(doc);
  };
  const dismiss = () => { dismissed = anchor; hide(); };
  const key = (event: KeyboardEvent) => {
    if (!event.isComposing && (event.key === 'Escape' || ['Enter', ' '].includes(event.key)
      && event.target instanceof win.Node && anchor?.contains(event.target))) dismiss();
  };
  const show = () => {
    timer = undefined;
    if (!eligible(anchor)) { hide(); return; }
    tip = doc.createElement('div'); tip.className = 'bases-tooltip'; tip.setAttribute('role', 'tooltip');
    do { description = `zorid-base-tooltip-${++sequence}`; } while (doc.getElementById(description));
    tip.id = description;
    const label = doc.createElement('span'); label.className = 'bases-tooltip-label'; label.textContent = anchor.dataset.baseTooltip!.trim(); tip.append(label);
    const shortcut = anchor.dataset.baseTooltipShortcut?.trim();
    if (shortcut) { const keys = doc.createElement('span'); keys.className = 'bases-tooltip-shortcut'; keys.textContent = ` ${shortcut}`; tip.append(keys); }
    doc.body.append(tip);
    const ids = (anchor.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    anchor.setAttribute('aria-describedby', [...ids, description].join(' ')); position();
  };
  const reconcile = () => {
    const next = preferred === 'focus' ? focused ?? hovered : hovered ?? focused;
    if (!eligible(next) || next === dismissed) { hide(); return; }
    if (next === anchor) {
      if (preferred === 'focus' && timer !== undefined) { win.clearTimeout(timer); show(); }
      return;
    }
    hide(); owners.get(doc)?.(); anchor = next; owners.set(doc, hide);
    // Observe only while a hint is pending/visible. One active observer per
    // document catches removal of the anchor or its entire host, never per cell.
    observer = new win.MutationObserver(() => {
      if (!eligible(anchor) || tip && (tip.querySelector('.bases-tooltip-label')?.textContent !== anchor.dataset.baseTooltip!.trim()
        || tip.querySelector('.bases-tooltip-shortcut')?.textContent?.trim() !== (anchor.dataset.baseTooltipShortcut?.trim() || undefined))) hide();
    });
    observer.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'inert', 'aria-hidden', 'data-base-tooltip', 'data-base-tooltip-shortcut'] });
    doc.addEventListener('keydown', key, true); doc.addEventListener('pointerdown', dismiss, true);
    win.addEventListener('scroll', dismiss, true); win.addEventListener('resize', dismiss);
    if (preferred === 'focus') show(); else timer = win.setTimeout(show, delay);
  };
  const releaseDismissed = () => { if (dismissed && dismissed !== hovered && dismissed !== focused) dismissed = undefined; };
  const over = (event: MouseEvent) => {
    const next = target(event.target); if (next === hovered) return;
    hovered = next; preferred = 'hover'; releaseDismissed(); reconcile();
  };
  const out = (event: MouseEvent) => {
    const next = target(event.relatedTarget); if (next === hovered) return;
    hovered = next; preferred = 'hover'; releaseDismissed(); reconcile();
  };
  const focusIn = (event: FocusEvent) => { focused = target(event.target); preferred = 'focus'; releaseDismissed(); reconcile(); };
  const focusOut = (event: FocusEvent) => { focused = target(event.relatedTarget); preferred = 'focus'; releaseDismissed(); reconcile(); };
  host.addEventListener('pointerover', over); host.addEventListener('pointerout', out);
  host.addEventListener('focusin', focusIn); host.addEventListener('focusout', focusOut);
  return { destroy() {
    if (destroyed) return; destroyed = true; hide();
    host.removeEventListener('pointerover', over); host.removeEventListener('pointerout', out);
    host.removeEventListener('focusin', focusIn); host.removeEventListener('focusout', focusOut);
    hovered = focused = dismissed = undefined;
  } };
}
