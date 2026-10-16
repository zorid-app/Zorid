import type { AttachmentLease, AttachmentResources } from './attachments.ts';

export type MediaKind = 'audio' | 'video';
const audioExtensions = new Set(['mp3', 'wav', 'm4a', '3gp', 'flac', 'ogg', 'oga', 'opus']);
const videoExtensions = new Set(['mp4', 'webm', 'ogv', 'mov', 'mkv']);

/** Classify resolved vault paths, never remote URLs or Markdown destinations. */
export function mediaKind(path: string): MediaKind | null {
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('//')) return null;
  const filename = path.slice(path.lastIndexOf('/') + 1), dot = filename.lastIndexOf('.');
  if (dot <= 0) return null;
  const extension = filename.slice(dot + 1).toLowerCase();
  return audioExtensions.has(extension) ? 'audio' : videoExtensions.has(extension) ? 'video' : null;
}

export interface MediaView {
  /** Settles on metadata, error, timeout or destroy; settlement is not playback success. */
  ready: Promise<void>;
  destroy(): void;
}

/** Original local-media view. It owns one lease across any video/audio fallback. */
export function createMediaView(container: HTMLElement, path: string,
  resources: Pick<AttachmentResources, 'acquire'>): MediaView {
  const kind = mediaKind(path);
  if (!kind) throw new Error('Media view requires a local audio or video path');
  const doc = container.ownerDocument, win = doc.defaultView;
  if (!win) throw new Error('Media view requires an owning window');
  const root = doc.createElement('div');
  root.className = `zorid-media-view media-embed ${kind}-embed is-loading`;
  const status = doc.createElement('span');
  status.className = 'zorid-media-status'; status.setAttribute('role', 'status');
  status.textContent = 'Loading…'; root.append(status); container.append(root);
  let closed = false, settled = false, lease: AttachmentLease | undefined;
  let media: HTMLMediaElement | undefined, removeListeners: (() => void) | undefined;
  let timer: number | undefined;
  let resolveReady!: () => void;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });

  const finish = () => {
    if (timer !== undefined) win.clearTimeout(timer);
    timer = undefined;
    if (media) media.style.height = '';
    root.classList.remove('is-loading');
    if (!root.classList.contains('is-error')) status.hidden = true;
    if (!settled) { settled = true; resolveReady(); }
  };
  const fail = (message: string) => {
    if (closed) return;
    root.classList.add('is-error'); status.hidden = false; status.textContent = message;
    finish();
  };
  const resetMedia = () => {
    removeListeners?.(); removeListeners = undefined;
    const previous = media; media = undefined;
    if (!previous) return;
    // Cancel native decoding/playback before the shared object URL is released.
    previous.pause();
    previous.removeAttribute('src');
    previous.srcObject = null;
    previous.load();
    previous.remove();
  };
  const mount = (type: MediaKind) => {
    const element = doc.createElement(type);
    media = element;
    element.controls = true;
    element.setAttribute('aria-label', path.slice(path.lastIndexOf('/') + 1));
    if (type === 'audio') element.setAttribute('controlsList', 'nodownload');
    else { element.preload = 'metadata'; if (!settled) element.style.height = '0px'; }
    const current = () => !closed && media === element;
    const metadata = () => {
      if (!current()) return;
      if (type === 'video') {
        const video = element as HTMLVideoElement;
        if (video.videoWidth === 0 && video.videoHeight === 0) {
          resetMedia();
          root.classList.replace('video-embed', 'audio-embed');
          mount('audio');
          return;
        }
      }
      root.classList.remove('is-error');
      finish();
    };
    const error = () => { if (current()) fail('Unable to play this media.'); };
    element.addEventListener('loadedmetadata', metadata);
    element.addEventListener('error', error);
    removeListeners = () => {
      element.removeEventListener('loadedmetadata', metadata);
      element.removeEventListener('error', error);
    };
    root.prepend(element);
    element.src = lease!.url + (type === 'video' ? '#t=0.001' : '');
  };
  void Promise.resolve().then(() => {
    if (closed) return undefined;
    return resources.acquire(path);
  }).then(result => {
    if (!result) return;
    if (closed) { result.release(); return; }
    lease = result;
    timer = win.setTimeout(finish, 5000);
    mount(kind);
  }).catch(error => {
    if (!closed) fail(error instanceof Error ? error.message : String(error));
  });
  return {
    ready,
    destroy() {
      if (closed) return;
      closed = true;
      resetMedia();
      lease?.release(); lease = undefined;
      finish(); root.remove();
    },
  };
}
