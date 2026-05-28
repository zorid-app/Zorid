import { createMobileShellState } from '@zorid/mobile-shell';
export const capacitorAppId = 'app.zorid.mobile';
export function mountMobilePlaceholder(root: HTMLElement): void {
  const state = createMobileShellState();
  root.innerHTML = `<main data-zorid-mobile-shell data-primary="${state.primarySurface}">Mobile shell placeholder</main>`;
}
