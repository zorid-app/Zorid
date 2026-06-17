// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import {
  createTrustedFileRendererEmbedAdapter,
  FileRendererResourceDisposedError,
  mountTrustedFileRenderer,
  trustedFileRendererIdentity,
} from '../apps/desktop/src/renderer/src/trusted-file-renderers';
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

const imageMatch: FileRendererMatchDto = {
  pluginId: 'zorid.core.images',
  rendererId: 'zorid.core.images.image',
  title: 'Image Viewer',
  surface: 'markdown-embed',
  path: 'image.png',
  rendererEntry: './src/file-renderers.ts',
  rendererExport: 'imageFileRenderer',
};

describe('desktop trusted file renderer loader', () => {
  it('mounts the allowlisted .zbase renderer through @zorid/plugin-ui and disposes it', async () => {
    const container = document.createElement('main');
    const host = mountTrustedFileRenderer({
      container,
      match: zbaseMatch,
      readText: vi.fn().mockResolvedValue('{"views":[]}'),
      readImageResource: vi.fn(),
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
      readImageResource: vi.fn(),
    });

    await expect(host.ready).rejects.toThrow(/not allowlisted/);
    expect(container.textContent).toContain('not allowlisted');
  });

  it('mounts the allowlisted image renderer and revokes object URLs exactly once on dispose', async () => {
    const container = document.createElement('main');
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:zorid-image');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const host = mountTrustedFileRenderer({
      container,
      match: imageMatch,
      readText: vi.fn(),
      readImageResource: vi.fn().mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }),
    });

    await host.ready;
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:zorid-image'));
    host.dispose();
    host.dispose();

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  });

  it('passes a plain serializable match to image resource reads when the renderer match is reactive', async () => {
    const container = document.createElement('main');
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:reactive-image');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const reactiveMatch = reactive({ ...imageMatch });
    const readImageResource = vi.fn().mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' });
    const host = mountTrustedFileRenderer({
      container,
      match: reactiveMatch,
      readText: vi.fn(),
      readImageResource,
    });

    await host.ready;
    await waitFor(() => expect(readImageResource).toHaveBeenCalledTimes(1));

    const receivedMatch = readImageResource.mock.calls[0]?.[0];
    expect(receivedMatch).not.toBe(reactiveMatch);
    expect(structuredClone(receivedMatch)).toEqual(imageMatch);
    expect(receivedMatch).toEqual(imageMatch);

    host.dispose();
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  });

  it('rejects imageSource if disposed while the async resource read is in flight and revokes late URLs', async () => {
    const container = document.createElement('main');
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:late-image');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    let release!: (value: { bytes: Uint8Array; mimeType: string }) => void;
    const readImageResource = vi.fn(
      () => new Promise<{ bytes: Uint8Array; mimeType: string }>((resolve) => (release = resolve)),
    );
    const host = mountTrustedFileRenderer({
      container,
      match: {
        pluginId: 'zorid.core.images',
        rendererId: 'zorid.core.images.image',
        title: 'Image Viewer',
        surface: 'full-page',
        path: 'image.png',
        rendererEntry: './src/file-renderers.ts',
        rendererExport: 'imageFileRenderer',
      },
      readText: vi.fn(),
      readImageResource,
    });

    await host.ready;
    host.dispose();
    release({ bytes: new Uint8Array([1]), mimeType: 'image/png' });

    await waitFor(() => expect(readImageResource).toHaveBeenCalledTimes(1));
    await expect(host.ready).resolves.toBeUndefined();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(new FileRendererResourceDisposedError().code).toBe('resource.disposed');
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  });

  it('adapts editor embed lifecycle mounts to trusted markdown file renderer mounts', async () => {
    const container = document.createElement('main');
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:embed-image');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const adapter = createTrustedFileRendererEmbedAdapter({
      rendererForTarget: (target) => (target === imageMatch.path ? imageMatch : undefined),
      readText: vi.fn(),
      readImageResource: vi.fn().mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }),
    });

    const disposable = adapter({
      host: container,
      occurrence: {
        documentSessionKey: 'doc.md',
        kind: 'embed-reference',
        referenceSyntax: 'wikilink-embed',
        target: imageMatch.path,
        fragment: 'hero',
        rendererIdentity: trustedFileRendererIdentity(imageMatch),
        sourceFrom: 0,
        sourceTo: 16,
        sourceText: '![[image.png#hero]]',
      },
    });

    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:embed-image'));
    disposable.dispose();

    expect(container.childElementCount).toBe(0);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  });
});
