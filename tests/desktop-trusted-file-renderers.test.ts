// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import { mountTrustedFileRenderer } from '../apps/desktop/src/renderer/src/trusted-file-renderers';
import type { FileRendererMatchDto } from '../apps/desktop/src/renderer/src/types';

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

const zbaseMatch: FileRendererMatchDto = {
  pluginId: 'zorid.core.data-views',
  rendererId: 'zorid.core.data-views.zbase',
  title: 'Zbase Data View',
  surface: 'full-page',
  path: '.zorid/views/tasks.zbase',
  rendererEntry: './src/file-renderers.ts',
  rendererExport: 'zbaseFileRenderer',
};

describe('desktop trusted file renderer loader', () => {
  it('mounts the allowlisted .zbase renderer through @zorid/plugin-ui and disposes it', async () => {
    const container = document.createElement('main');
    const host = mountTrustedFileRenderer({
      container,
      match: zbaseMatch,
      readText: vi.fn().mockResolvedValue('{"views":[]}'),
    });

    await host.ready;

    expect(container.querySelector('[data-file-renderer="zorid.core.data-views.zbase"]')).toBeTruthy();
    await waitFor(() => expect(container.textContent).toContain('{"views":[]}'));

    host.dispose();
    expect(container.childElementCount).toBe(0);
  });

  it('rejects renderer metadata that does not match the trusted import map', async () => {
    const container = document.createElement('main');
    const host = mountTrustedFileRenderer({
      container,
      match: { ...zbaseMatch, rendererExport: 'otherExport' },
      readText: vi.fn().mockResolvedValue(''),
    });

    await expect(host.ready).rejects.toThrow(/not allowlisted/);
    expect(container.textContent).toContain('not allowlisted');
  });
});
