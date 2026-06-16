import type { FileRendererContribution, FileRendererMountContext } from '@zorid/platform-api';

function mountImageRenderer(ctx: FileRendererMountContext): void {
  const root = document.createElement('figure');
  root.className = 'z-file-renderer z-file-renderer--image';
  root.dataset.fileRenderer = 'zorid.core.images.image';
  root.dataset.surface = ctx.surface;

  const status = document.createElement('figcaption');
  status.className = 'muted';
  status.textContent = 'Loading image…';
  root.append(status);
  ctx.root.append(root);

  let disposed = false;
  ctx.dispose(() => {
    disposed = true;
  });

  void ctx.resource
    .imageSource()
    .then((source) => {
      if (disposed) return;
      const image = document.createElement('img');
      image.src = source;
      image.alt = ctx.path;
      image.loading = 'lazy';
      image.decoding = 'async';
      root.replaceChildren(image);
    })
    .catch((error: unknown) => {
      if (disposed) return;
      status.textContent = error instanceof Error ? error.message : String(error);
    });
}

export const imageFileRenderer: FileRendererContribution = {
  id: 'zorid.core.images.image',
  title: 'Image Viewer',
  mount: mountImageRenderer,
};
