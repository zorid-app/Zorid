import type { Vault } from '../core/vault.ts';
import type { VaultChange } from '../core/types.ts';
import { selectMarkdownSubpath } from '../core/subpath.ts';
import { el } from './dom.ts';
import { renderMarkdown } from './markdown.ts';
import { destroyMarkdown } from './markdown-lifecycle.ts';
import type { EmbedRequest } from './markdown.ts';
import { AttachmentResources, imageAlt, isImage } from './attachments.ts';
import type { AttachmentLease } from './attachments.ts';
import { openImageLightbox } from './image-view.ts';
import type { ImageView } from './image-view.ts';
import { createPdfView } from './pdf-view.ts';
import type { PdfView } from './pdf-view.ts';
import { createMediaView, mediaKind } from './media-view.ts';
import type { MediaView } from './media-view.ts';

interface EmbedOptions {
  vault: Vault;
  open: (source: string, target: string, kind: 'wiki' | 'markdown') => void;
  read?: (path: string) => Promise<string>;
  taskChange?: (path: string, line: number, checked: boolean) => Promise<void>;
  resources?: AttachmentResources;
  contextMenu?: (event: MouseEvent, request: EmbedRequest, source: string) => void;
  /** Test/host injection; the PDF view owns loading errors and its attachment lease. */
  pdfFactory?: typeof createPdfView;
  /** Local media views own their resource lease and readiness/error UI. */
  mediaFactory?: typeof createMediaView;
}
interface EmbedState {
  node: HTMLElement;
  request: EmbedRequest;
  source: string;
  ancestors: readonly string[];
  path?: string;
  version: number;
  visible: boolean;
  disposed: boolean;
  dirty: boolean;
  reconnectDocument?: Document;
  children: Set<EmbedState>;
  lease?: AttachmentLease;
  pdfView?: PdfView;
  mediaView?: MediaView;
  imageSource?: () => Promise<AttachmentLease>;
}

/** Shared embed rendering and resource ownership for Reading and Live Edit. */
export class MarkdownEmbeds {
  private options: EmbedOptions;
  private states = new Set<EmbedState>();
  private nodes = new WeakMap<HTMLElement, EmbedState>();
  private observer?: IntersectionObserver;
  private observed = new Map<Element, EmbedState>();
  private reconnectStates = new Map<Document, Set<EmbedState>>();
  private reconnectObservers = new Map<Document, MutationObserver>();
  private reads = new Map<string, Promise<string>>();
  private queue: (() => void)[] = [];
  private reading = 0;
  private disposed = false;
  private unsubscribers: (() => void)[];
  private resources:AttachmentResources;
  private ownsResources:boolean;
  private lightbox?:ImageView;

  constructor(options: EmbedOptions) {
    this.options = options;
    this.ownsResources=!options.resources;
    this.resources=options.resources??new AttachmentResources(options.vault);
    if (typeof IntersectionObserver !== 'undefined') {
      this.observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const state = this.observed.get(entry.target);
          if (!state || state.disposed) continue;
          this.observer!.unobserve(state.node); this.observed.delete(state.node);
          state.visible = true; void this.refresh(state);
        }
      }, { rootMargin: '400px' });
    }
    this.unsubscribers = [
      options.vault.on('modify', change => this.invalidate(change.path)),
      ...(['create', 'delete', 'rename'] as const).map(event => options.vault.on(event, change => this.invalidateTopology(change))),
    ];
  }

  render(request: EmbedRequest, source: string, ancestors: readonly string[] = [], parent?: EmbedState): HTMLElement {
    const node = el('span', 'internal-embed markdown-embed');
    node.setAttribute('role', 'group'); node.setAttribute('aria-label', `Embed ${request.target}`);
    node.dataset.embedTarget = request.target;
    const state: EmbedState = { node, request, source, ancestors, version:0, visible:!this.observer, disposed:false, dirty:true, children:new Set() };
    node.addEventListener('contextmenu', event => {
      if (state.disposed || event.defaultPrevented) return;
      const target = event.target as Element | null;
      // Native media controls retain their default menu. Stop the event from
      // reaching either this attachment menu or an enclosing editor menu.
      if (target?.closest?.('audio, video')) { event.stopPropagation(); return; }
      this.options.contextMenu?.(event,request,source);
    });
    if (this.disposed) return node;
    this.states.add(state); parent?.children.add(state);
    this.nodes.set(node, state);
    node.append(el('span', 'embed-loading', 'Loading…'));
    if (this.observer) { this.observed.set(node, state); this.observer.observe(node); }
    else void this.refresh(state);
    return node;
  }

  /** Unsaved buffer updates can invalidate embeds without waiting for filesystem I/O. */
  invalidate(path?: string): void {
    if (path) this.reads.delete(path); else this.reads.clear();
    for (const state of [...this.states]) {
      if (!state.disposed && (!path || state.path === path)) this.markDirty(state);
    }
  }

  private invalidateTopology(change: VaultChange): void {
    const affected = (path: string) => [change.path, change.oldPath].some(changed =>
      changed !== undefined && (path === changed || path.startsWith(`${changed}/`)));
    for (const path of this.reads.keys()) if (affected(path)) this.reads.delete(path);
    for (const state of [...this.states]) {
      if (state.disposed) continue;
      const resolved = this.options.vault.metadata.resolveLink(state.source, state.request.target, state.request.kind) ?? undefined;
      // New competing names can change resolution even when neither changed path
      // was the previous target. Unrelated topology must preserve warm viewers.
      if (resolved !== state.path || (state.path !== undefined && affected(state.path))) this.markDirty(state);
    }
  }

  private markDirty(state: EmbedState): void {
    state.dirty = true;
    state.version++; // Suppress in-flight output from the previous dependency.
    if (!state.visible) return; // The initial intersection callback will refresh.
    if (state.node.isConnected) void this.refresh(state);
    else this.watchReconnect(state);
  }

  private watchReconnect(state: EmbedState): void {
    if (this.disposed) return;
    const document = state.node.ownerDocument;
    let pending = this.reconnectStates.get(document);
    if (!pending) this.reconnectStates.set(document, pending = new Set());
    pending.add(state); state.reconnectDocument = document;
    if (this.reconnectObservers.has(document)) return;
    const Observer = document.defaultView?.MutationObserver;
    if (!Observer) return;
    const observer = new Observer(() => {
      for (const state of [...(this.reconnectStates.get(document) ?? [])]) {
        if (state.node.isConnected) void this.refresh(state);
      }
      this.pruneReconnectObserver(document);
    });
    this.reconnectObservers.set(document, observer);
    observer.observe(document, { childList: true, subtree: true });
  }

  private stopWaiting(state: EmbedState): Document {
    const document = state.reconnectDocument ?? state.node.ownerDocument;
    this.reconnectStates.get(document)?.delete(state);
    state.reconnectDocument = undefined;
    return document;
  }

  private pruneReconnectObserver(document: Document): void {
    if (!this.reconnectObservers.has(document)) return;
    if (this.reconnectStates.get(document)?.size) return;
    this.reconnectObservers.get(document)?.disconnect();
    this.reconnectObservers.delete(document);
    this.reconnectStates.delete(document);
  }

  private read(path: string): Promise<string> {
    let result = this.reads.get(path);
    if (result) return result;
    result = new Promise<string>((resolve, reject) => {
      this.queue.push(() => {
        this.reading++;
        Promise.resolve().then(() => {
          if (this.disposed) throw new Error('Embed view closed');
          return this.options.read ? this.options.read(path) : this.options.vault.cachedRead(path);
        }).then(resolve, reject).finally(() => { this.reading--; this.drain(); });
      });
      this.drain();
    });
    this.reads.set(path, result);
    return result;
  }

  private drain(): void {
    while (this.reading < 4 && this.queue.length) this.queue.shift()!();
  }

  private clearChildren(state: EmbedState): void {
    for (const child of state.children) this.release(child, false);
    state.children.clear();
  }

  private release(state: EmbedState, prune = true): void {
    if (state.disposed) return;
    state.disposed = true; state.version++;
    const reconnectDocument = this.stopWaiting(state);
    destroyMarkdown(state.node);
    state.pdfView?.destroy();state.pdfView=undefined;
    state.mediaView?.destroy();state.mediaView=undefined;
    state.lease?.release();state.lease=undefined;
    this.observer?.unobserve(state.node); this.observed.delete(state.node);
    this.clearChildren(state); this.states.delete(state);
    this.nodes.delete(state.node);
    if (prune) this.pruneReconnectObserver(reconnectDocument);
  }

  /** A live editor can unmount one widget without disposing its other embeds. */
  releaseEmbed(node: HTMLElement): void {
    const state = this.nodes.get(node);
    if (state) this.release(state);
  }

  private async refresh(state: EmbedState): Promise<void> {
    if (this.disposed || state.disposed) return;
    const version = ++state.version;
    state.dirty = false;
    const reconnectDocument = this.stopWaiting(state);
    destroyMarkdown(state.node);
    this.clearChildren(state);
    this.pruneReconnectObserver(reconnectDocument);
    state.pdfView?.destroy();state.pdfView=undefined;
    state.mediaView?.destroy();state.mediaView=undefined;
    state.lease?.release();state.lease=undefined;state.imageSource=undefined;
    const current = () => !this.disposed && !state.disposed && state.version === version;
    const { request, source } = state;
    const external=request.kind==='markdown'&&/^https?:\/\//i.test(request.target);
    const path = this.options.vault.metadata.resolveLink(source, request.target, request.kind);
    state.path = path ?? undefined;
    const open = el('a', 'embed-open', request.label || request.target || source);
    open.href = '#'; open.setAttribute('aria-label', `Open ${request.target || source}`);
    open.onclick = event => { event.preventDefault(); this.options.open(source, request.target, request.kind); };
    state.node.className='internal-embed markdown-embed';
    for (const attribute of ['alt', 'width', 'height']) state.node.removeAttribute(attribute);
    state.node.replaceChildren(open);
    const fail = (message: string) => { if (current()) state.node.append(el('span', 'embed-error', message)); };
    if(external || (path&&isImage(path))){
      state.node.className='internal-embed image-embed';state.node.replaceChildren();
      const details=imageAlt(request.label??path?.split('/').at(-1)??''),img=el('img');
      img.alt=details.alt;img.decoding='async';img.loading='lazy';img.draggable=false;
      if(details.width!==undefined)img.width=details.width;if(details.height!==undefined)img.height=details.height;
      img.onerror=()=>fail('Unable to display this image.');state.node.append(img);
      state.imageSource=external?async()=>({url:request.target,type:'image/*',release(){}}):()=>this.resources.acquire(path!);
      img.onclick=()=>{
        const gallery=[...this.states].filter(item=>!item.disposed&&item.imageSource&&item.node.querySelector('img'));
        this.lightbox?.destroy();
        this.lightbox=openImageLightbox(gallery.map(item=>({alt:item.node.querySelector('img')!.alt,load:item.imageSource!})),gallery.indexOf(state));
      };
      try{
        const result=await state.imageSource();if(!current()){result.release();return;}state.lease=result;img.src=result.url;
      }catch(error){fail(error instanceof Error?error.message:String(error));}
      return;
    }
    if (!path) { fail('File not found'); return; }
    if (/\.pdf$/i.test(path)) {
      state.node.className='internal-embed pdf-embed';state.node.replaceChildren();
      const hash=request.target.indexOf('#');
      try {
        // The view acquires the resource itself. An outer lease would duplicate ownership.
        const view=(this.options.pdfFactory??createPdfView)(state.node,path,this.resources,{embed:true,subpath:hash<0?'':request.target.slice(hash),onOpenMenu:event=>{if(!current())return;if(this.options.contextMenu)this.options.contextMenu(event,request,source);else this.options.open(source,request.target,request.kind);}});
        state.pdfView=view;
        // PDF views render their own loading errors. Consume completion without adding
        // stale errors to a replacement widget or duplicating the viewer's status UI.
        void view.ready.catch(()=>{});
      } catch(error) { fail(error instanceof Error?error.message:String(error)); }
      return;
    }
    const media = mediaKind(path);
    if (media) {
      state.node.className=`internal-embed media-embed ${media}-embed`;
      state.node.replaceChildren();
      // The reference annotates the outer media embed, not the native player.
      const details = imageAlt(request.label ?? '');
      if (details.alt) state.node.setAttribute('alt', details.alt);
      if (details.width) state.node.setAttribute('width', String(details.width));
      if (details.height) state.node.setAttribute('height', String(details.height));
      try {
        const view = (this.options.mediaFactory ?? createMediaView)(state.node, path, this.resources);
        if (!current()) { view.destroy(); return; }
        state.mediaView = view;
        void view.ready.catch(() => {});
      } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
      return;
    }
    if (!/\.md$/i.test(path)) { fail('Attachment viewer is not implemented yet'); return; }
    const hash = request.target.indexOf('#');
    const fragment = hash < 0 ? '' : request.target.slice(hash);
    const identity = `${path}${fragment}`;
    if (state.ancestors.includes(identity)) { fail('Recursive embed'); return; }
    if (state.ancestors.length >= 5) { fail('Embed nesting limit reached'); return; }
    let content: HTMLElement | undefined;
    try {
      const sourceText = await this.read(path);
      if (!current()) return;
      const selection = selectMarkdownSubpath(sourceText, fragment);
      if (!selection) { fail('Heading or block not found'); return; }
      content = el('span', 'markdown-embed-content');
      renderMarkdown(content, selection.content,
        (target, kind = 'wiki') => this.options.open(path, target, kind),
        (line, checked) => {
          if (!this.options.taskChange) return;
          void this.options.taskChange(path, selection.startLine + line, checked)
            .then(() => { if (current()) this.invalidate(path); })
            .catch(error => fail(error instanceof Error ? error.message : String(error)));
        },
        {embed: child => this.render(child, path, [...state.ancestors, identity], state)});
      if (current()) state.node.append(content);
      else destroyMarkdown(content);
    } catch (error) {
      // Rendering may have created async math/code owners before a later block
      // failed. The detached content still needs the same teardown as a mounted view.
      if (content) destroyMarkdown(content);
      if (current()) { this.clearChildren(state); this.pruneReconnectObserver(state.node.ownerDocument); }
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  destroy(): void {
    this.disposed = true;
    this.lightbox?.destroy();
    this.observer?.disconnect(); this.observed.clear();
    for (const observer of this.reconnectObservers.values()) observer.disconnect();
    this.reconnectObservers.clear(); this.reconnectStates.clear();
    this.unsubscribers.forEach(unsubscribe => unsubscribe());
    for (const state of [...this.states]) this.release(state);
    this.reads.clear();
    if(this.ownsResources)this.resources.destroy();
    // Queued jobs reject without touching storage; their handlers still settle.
    this.drain();
  }
}
