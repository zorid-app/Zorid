import type { EditorEmbedMountContext } from '@zorid/editor/internal/editor-embed-lifecycle';
import type { FileRendererContribution, FileRendererMountContext } from '@zorid/platform-api';
import { zbaseFileRenderer } from '@zorid/plugin-data-views/file-renderers';
import { imageFileRenderer } from '@zorid/plugin-images/file-renderers';
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
  [
    'zorid.core.images.image',
    {
      pluginId: 'zorid.core.images',
      rendererEntry: './src/file-renderers.ts',
      rendererExport: 'imageFileRenderer',
      contribution: imageFileRenderer,
    },
  ],
]);

export class FileRendererResourceDisposedError extends Error {
  readonly code = 'resource.disposed';

  constructor() {
    super('File renderer resource is disposed.');
    this.name = 'FileRendererResourceDisposedError';
  }
}

export interface TrustedFileRendererMountOptions {
  readonly container: HTMLElement;
  readonly match: FileRendererMatchDto;
  readonly fragment?: string;
  readonly readText: (path: string) => Promise<string>;
  readonly readImageResource: (match: FileRendererMatchDto) => Promise<{ bytes: Uint8Array; mimeType: string }>;
  readonly onError?: (message: string) => void;
}

export interface TrustedFileRendererHost extends Disposable {
  readonly ready: Promise<void>;
}

function toSerializableFileRendererMatch(match: FileRendererMatchDto): FileRendererMatchDto {
  return {
    pluginId: match.pluginId,
    rendererId: match.rendererId,
    title: match.title,
    surface: match.surface,
    path: match.path,
    rendererEntry: match.rendererEntry,
    rendererExport: match.rendererExport,
  };
}

export function mountTrustedFileRenderer({
  container,
  match,
  fragment,
  readText,
  readImageResource,
  onError,
}: TrustedFileRendererMountOptions): TrustedFileRendererHost {
  const loader = trustedFileRendererLoaders.get(match.rendererId);
  const disposables: Disposable[] = [];
  const objectUrls = new Set<string>();
  let disposed = false;
  container.replaceChildren();

  const registerDisposable = (disposable: Disposable): void => {
    if (disposed) void disposable.dispose();
    else disposables.push(disposable);
  };

  const revokeObjectUrl = (url: string): void => {
    if (!objectUrls.delete(url)) return;
    URL.revokeObjectURL(url);
  };

  const imageSource = async (): Promise<string> => {
    if (disposed) throw new FileRendererResourceDisposedError();
    const resource = await readImageResource(toSerializableFileRendererMatch(match));
    if (disposed) throw new FileRendererResourceDisposedError();
    const bytes = new Uint8Array(resource.bytes);
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const url = URL.createObjectURL(new Blob([data], { type: resource.mimeType }));
    objectUrls.add(url);
    registerDisposable({ dispose: () => revokeObjectUrl(url) });
    if (disposed) {
      revokeObjectUrl(url);
      throw new FileRendererResourceDisposedError();
    }
    return url;
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const disposable of disposables.splice(0).reverse()) void disposable.dispose();
    for (const url of [...objectUrls]) revokeObjectUrl(url);
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
      resource: { imageSource },
      dispose(disposable) {
        registerDisposable(typeof disposable === 'function' ? { dispose: disposable } : disposable);
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

export interface TrustedFileRendererEmbedAdapterOptions {
  readonly rendererForTarget: (target: string) => FileRendererMatchDto | undefined;
  readonly readText: (path: string) => Promise<string>;
  readonly readImageResource: (match: FileRendererMatchDto) => Promise<{ bytes: Uint8Array; mimeType: string }>;
  readonly onError?: (message: string) => void;
}

export function trustedFileRendererIdentity(match: FileRendererMatchDto): string {
  return `${match.pluginId}:${match.rendererId}:${match.rendererEntry}:${match.rendererExport}:${match.surface}`;
}

export function createTrustedFileRendererEmbedAdapter({
  rendererForTarget,
  readText,
  readImageResource,
  onError,
}: TrustedFileRendererEmbedAdapterOptions): (context: EditorEmbedMountContext) => Disposable {
  return ({ occurrence, host }) => {
    const match = rendererForTarget(occurrence.target);
    if (!match) {
      host.replaceChildren();
      return { dispose: () => undefined };
    }
    return mountTrustedFileRenderer({
      container: host,
      match,
      ...(occurrence.fragment ? { fragment: occurrence.fragment } : {}),
      readText,
      readImageResource,
      ...(onError ? { onError } : {}),
    });
  };
}
