import type { FileRendererContribution, FileRendererMountContext } from '@zorid/platform-api';
import { createEffect, createSignal, mountPluginUI, onCleanup } from '@zorid/plugin-ui';

function ZbaseRenderer(ctx: FileRendererMountContext): HTMLElement {
  const [content, setContent] = createSignal('Loading data view…');
  const root = document.createElement('section');
  root.className = 'z-file-renderer z-file-renderer--zbase';
  root.dataset.fileRenderer = 'zorid.core.data-views.zbase';
  root.dataset.surface = ctx.surface;

  const title = document.createElement('h2');
  title.textContent = ctx.surface === 'markdown-embed' ? 'Embedded data view' : 'Data view';
  const body = document.createElement('pre');
  body.className = 'z-file-renderer__body';
  root.append(title, body);

  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  createEffect(() => {
    void ctx
      .readText()
      .then((text) => {
        if (!disposed) setContent(text.trim() || `${ctx.path} is empty.`);
      })
      .catch((error: unknown) => {
        if (!disposed) setContent(error instanceof Error ? error.message : String(error));
      });
  });
  createEffect(() => {
    body.textContent = content();
  });
  return root;
}

export const zbaseFileRenderer: FileRendererContribution = {
  id: 'zorid.core.data-views.zbase',
  title: 'Zbase Data View',
  mount: mountPluginUI({ component: ZbaseRenderer }),
};
