import type { FileRendererContribution, FileRendererMountContext } from '@zorid/platform-api';
import { zbaseFileRenderer } from '@zorid/plugin-data-views/file-renderers';
import type { Disposable } from '@zorid/shared';
import type { FileRendererMatchDto } from './types.js';

interface TrustedFileRendererLoader {
  readonly pluginId: string;
  readonly rendererEntry: string;
  readonly rendererExport: string;
  readonly contribution: FileRendererContribution;
}

export const trustedFileRendererLoaders: ReadonlyMap<string, TrustedFileRendererLoader> = new Map([
  [
    'zorid.core.data-views.zbase',
    {
      pluginId: 'zorid.core.data-views',
      rendererEntry: './src/file-renderers.ts',
      rendererExport: 'zbaseFileRenderer',
      contribution: zbaseFileRenderer,
    },
  ],
]);

export interface TrustedFileRendererMountOptions {
  readonly container: HTMLElement;
  readonly match: FileRendererMatchDto;
  readonly fragment?: string;
  readonly readText: (path: string) => Promise<string>;
  readonly onError?: (message: string) => void;
}

export interface TrustedFileRendererHost extends Disposable {
  readonly ready: Promise<void>;
}

export function mountTrustedFileRenderer({
  container,
  match,
  fragment,
  readText,
  onError,
}: TrustedFileRendererMountOptions): TrustedFileRendererHost {
  const loader = trustedFileRendererLoaders.get(match.rendererId);
  const disposables: Disposable[] = [];
  let disposed = false;
  container.replaceChildren();

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const disposable of disposables.splice(0).reverse()) void disposable.dispose();
    container.replaceChildren();
  };

  const ready = Promise.resolve().then(async () => {
    if (
      !loader ||
      loader.pluginId !== match.pluginId ||
      loader.rendererEntry !== match.rendererEntry ||
      loader.rendererExport !== match.rendererExport ||
      loader.contribution.id !== match.rendererId
    ) {
      throw new Error(`Trusted file renderer is not allowlisted: ${match.rendererId}`);
    }
    const context: FileRendererMountContext = {
      pluginId: match.pluginId as FileRendererMountContext['pluginId'],
      rendererId: match.rendererId,
      surface: match.surface,
      root: container,
      path: match.path as FileRendererMountContext['path'],
      ...(fragment ? { fragment } : {}),
      readText: () => readText(match.path),
      dispose(disposable) {
        disposables.push(typeof disposable === 'function' ? { dispose: disposable } : disposable);
      },
    };
    await loader.contribution.mount(context);
  });

  ready.catch((error: unknown) => {
    if (disposed) return;
    const message = error instanceof Error ? error.message : String(error);
    container.replaceChildren();
    const element = document.createElement('p');
    element.className = 'muted';
    element.textContent = `File renderer failed to mount: ${message}`;
    container.append(element);
    onError?.(message);
  });

  return { ready, dispose };
}
