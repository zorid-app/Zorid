function capturedKeysFor(element: HTMLElement): readonly string[] {
  const raw = element.dataset.editorContainerCapturedKeys;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : [];
  } catch {
    return [];
  }
}

export function routeEditorContainerCapturedKeydown(host: HTMLElement, event: KeyboardEvent): boolean {
  for (const container of host.querySelectorAll<HTMLElement>('[data-editor-container]')) {
    if (!capturedKeysFor(container).includes(event.key)) continue;
    const routed = new KeyboardEvent(event.type, {
      key: event.key,
      code: event.code,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      bubbles: true,
      cancelable: true,
    });
    const notCancelled = container.dispatchEvent(routed);
    if (!notCancelled || routed.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
    }
    return true;
  }
  return false;
}
