import { HotkeyPreferences, HOTKEY_STORAGE_KEY, WORKSPACE_HOTKEY_COMMANDS, EDITOR_HOTKEY_COMMANDS } from './hotkeys.ts';
import { mountHotkeySettings } from './hotkey-settings.ts';
import {pdfMarkdownLink} from './pdf-link.ts';
import {createCanvasAttachmentCard} from '../canvas/attachment-card.ts';
import {createCanvasDocumentInput} from './canvas-document-input.ts';
import { fileTreeLabel } from './file-tree-label.ts';
import { createFolderInline, FileTreeRenameSession } from './file-tree-create.ts';
import { createFileTreeDrag, executeFileTreeMove } from './file-tree-drag.ts';
import type { FileTreeDragRow } from './file-tree-drag.ts';
import { shouldOverrideInputContextMenu } from '../platform/input-context-menu.ts';
import { bindNoteTitleFocus } from './note-title-focus.ts';
import { Vault, parseMetadata } from '../core/index.ts';
import type { VaultEntry } from '../core/index.ts';
import { pickDesktopVault, createPlatformAdapter } from '../platform/index.ts';
import type { PlatformVault } from '../platform/index.ts';
import { el, icon, button, textButton, modal, notice, promptName } from './dom.ts';
import { renderMarkdown } from './markdown.ts';
import { destroyMarkdown } from './markdown-lifecycle.ts';
import type { EditorHandle, EditorOptions, EditorViewState } from './editor.ts';
import { NoteBuffer } from './note-buffer.ts';
import { createCanvasMarkdownBufferSession, NoteBufferSubscriptions } from './canvas-markdown-session.ts';
import type { CanvasMarkdownBufferSession } from './canvas-markdown-session.ts';
import { MarkdownEmbeds } from './embeds.ts';
import { renderProperties } from './properties.ts';
import type { PropertiesView } from './properties.ts';
import { AttachmentResources, isImage } from './attachments.ts';
import { createImageView } from './image-view.ts';
import type { ImageView } from './image-view.ts';
import { isMarkdown } from '../core/types.ts';
import { AttachmentImporter, DEFAULT_ATTACHMENT_IMPORT_SETTINGS } from '../core/attachment-import.ts';
import type { AttachmentImportSettings } from '../core/attachment-import.ts';
import type { TransferFile } from '../editor/transfers.ts';
import { showContextMenu, dismissContextMenu } from '../platform/context-menu.ts';
import { createPdfView } from './pdf-view.ts';
import type { PdfView } from './pdf-view.ts';
import { createMediaView, mediaKind } from './media-view.ts';
import type { MediaView } from './media-view.ts';
import {createBaseSession, type BaseSession} from '../bases/session.ts';
import {BaseEmbedSessions} from './base-embed-sessions.ts';
import { CanvasDocument } from '../canvas/document.ts';
import { createCanvasView } from '../canvas/view.ts';
import type { CanvasView } from '../canvas/view.ts';
import { SplitLayout } from './split-layout.ts';
import { createTabViewRuntime } from './tab-view-runtime.ts';
import type { TabViewRuntime } from './tab-view-runtime.ts';
import { createTabDocking } from './tab-docking.ts';
import type { DockIntent, DockPane } from './tab-docking.ts';
import { ChangeSet, EditorSelection } from '@codemirror/state';
import { textChanges } from '../editor/text-changes.ts';
import { WorkspaceStorageScope, validateWorkspaceWindowInfo, workspaceWindowBridge } from './workspace-window.ts';
import { resolveWorkspaceShortcut } from './workspace-keymap.ts';
import { createSidebarControls } from './sidebar-controls.ts';
import { buildFileListBackgroundMenu, installFileListBackgroundMenu } from './file-list-background-menu.ts';

type Mode = 'live' | 'reading';
interface Tab {
  id:string; path:string|null; mode:Mode; kind:'note'|'graph'; subpath?:string;
  history?:string[]; historyIndex?:number;
  viewState?:{editor?:EditorViewState;scrollTop:number;scrollLeft:number};
}
// Visible panes mirror one loaded tab. A parked record keeps those resources and
// mutable callback ownership while its wrapper is detached; it is never serialized.
interface Pane {
  id:string; tabs:Tab[]; active:string; element:HTMLElement;
  content?:HTMLElement; runtime?:TabViewRuntime; rebindView?:(pane:Pane)=>void;
  viewReady?:boolean; viewMode?:Mode; viewKind?:Tab['kind']; viewSettings?:string;
  viewTabId?:string; viewPath?:string|null; renderVersion:number;
  editor?:EditorHandle; imageView?:ImageView; pdfView?:PdfView; mediaView?:MediaView; canvasView?:CanvasView; baseView?:BaseSession;
  canvasSource?:string; baseEmbeds?:BaseEmbedSessions; embeds?:MarkdownEmbeds; properties?:PropertiesView;
  propertyTimer?:ReturnType<typeof setTimeout>; refreshPreview?:()=>void;
  history:string[]; historyIndex:number; persisted?:Record<string,unknown>;
}
interface Settings extends AttachmentImportSettings { theme: 'system' | 'dark' | 'light'; fontSize: number; readableWidth: boolean; showInlineTitle: boolean; defaultMode: 'live'; useTab: boolean; tabSize: number; smartIndentList: boolean; autoConvertHtml: boolean; }
interface Command { id?: string; name: string; shortcut?: string; icon?: string; action: () => void | Promise<void>; }
export interface WorkspaceViewFactories { pdf?: typeof createPdfView; media?: typeof createMediaView; canvas?: typeof createCanvasView; base?: typeof createBaseSession }
type EditorFactory = (parent: HTMLElement, options: EditorOptions) => EditorHandle;
const nameOf = (path: string) => path.split('/').at(-1)!.replace(/\.md$/i, '');
const parentOf = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const makeId = () => crypto.randomUUID();

export class Workspace {
  root: HTMLElement;
  vault!: Vault;
  platform!: PlatformVault;
  panes: Pane[] = [];
  activePane!: Pane;
  buffers = new Map<string, NoteBuffer>();
  settings: Settings = { theme: 'system', fontSize: 16, readableWidth: true, showInlineTitle: true, defaultMode: 'live', useTab:true, tabSize:4, smartIndentList:true, autoConvertHtml:true, ...DEFAULT_ATTACHMENT_IMPORT_SETTINGS };
  private hotkeys!: HotkeyPreferences;
  private hotkeyCleanup?: () => void;
  private hotkeySettings?: ReturnType<typeof mountHotkeySettings>;
  private editorFactory?: EditorFactory;
  private noteNavigation = new WeakMap<Pane, number>();
  private viewFactories: WorkspaceViewFactories;
  private sidebar = el('aside', 'sidebar');
  private sidebarContent = el('div', 'sidebar-content');
  private paneContainer = el('main', 'panes');
  private splitLayout?: SplitLayout;
  private restoringLayout = false;
  private right = el('aside', 'right-sidebar');
  private rightContent = el('div', 'right-content');
  private status = el('footer', 'status-bar');
  private treeTab: 'files' | 'search' | 'bookmarks' = 'files';
  private rightTab: 'backlinks' | 'outline' | 'tags' = 'backlinks';
  private collapsed = new Set<string>();
  private bookmarks = new Set<string>();
  private treeRows: FileTreeDragRow[] = [];
  private treeOrder: string[] = [];
  private treeSelection = new Set<string>();
  private treeSelectionAnchor?: string;
  private entryTokens = new Map<string, symbol>();
  private treeDrag?: ReturnType<typeof createFileTreeDrag>;
  private canvasDocumentInput?:ReturnType<typeof createCanvasDocumentInput>;
  private treeRename?: { path: string; session: FileTreeRenameSession };
  private folderCreationIntent = 0;
  private query = '';
  private searchGeneration = 0;
  private reverseSort = false;
  private autoRevealFiles = false;
  private disposers: (() => void)[] = [];
  private keyListener = (event: KeyboardEvent) => this.onKey(event);
  private unloadListener = (event: BeforeUnloadEvent) => {
    try{this.saveSession();}catch{/* Storage failure must not bypass the dirty-document unload guard. */}
    if ([...this.buffers.values()].some(buffer => buffer.dirty) || [...this.panes,...this.cachedViews.values()].some(pane => pane.canvasView?.hasPendingChanges() || pane.baseView?.hasPendingChanges() || pane.baseEmbeds?.hasPendingChanges())) { event.preventDefault(); event.returnValue = ''; }
  };
  private menuSerial = 0;
  private inputContextListener=(event:MouseEvent)=>{
    if(event.defaultPrevented||!this.initialized)return;
    const target=event.target as HTMLElement|null;
    const input=target?.closest<HTMLInputElement|HTMLTextAreaElement>('input,textarea');
    if(!input||input.type==='checkbox'||input.type==='range'||!shouldOverrideInputContextMenu(input))return;
    const editable=!input.disabled&&!input.readOnly,selected=input.selectionStart!==input.selectionEnd;
    const pending=showContextMenu(event,[{role:'undo',enabled:editable},{role:'redo',enabled:editable},{type:'separator'},{role:'cut',enabled:editable&&selected},{role:'copy',enabled:selected},{role:'paste',enabled:editable},{role:'selectAll'}]);
    this.run(()=>pending);
  };
  private reloadTimer?: ReturnType<typeof setTimeout>;
  private vaultGeneration = 0;
  private vaultRequest = 0;
  private vaultTransition: Promise<void> = Promise.resolve();
  private canvasMarkdownEmbeds = new Set<MarkdownEmbeds>();
  private bufferSubscriptions = new NoteBufferSubscriptions();
  private bufferRevisions = new WeakMap<NoteBuffer,number>();
  private bufferEntries = new WeakMap<NoteBuffer,symbol>();
  private initialized = false;
  private startupFailed = false;
  private attachments?:AttachmentResources;
  private attachmentImporter?: AttachmentImporter;
  private sessionState: Record<string, unknown> = {};
  private storageScope = new WorkspaceStorageScope();
  private navigationIntent = new WeakMap<Pane, number>();
  private paneActivationRevision = 0;
  private viewSequence = 0;
  private renderRequests = new WeakMap<Pane,number>();
  private cachedViews = new Map<Tab, Pane>();
  private tabDocking?: ReturnType<typeof createTabDocking>;
  private sidebarControls?: ReturnType<typeof createSidebarControls>;
  private disposeFileListMenu?: () => void;

  constructor(root: HTMLElement, editorFactory?: EditorFactory, viewFactories: WorkspaceViewFactories = {}) { this.root = root; this.editorFactory = editorFactory; this.viewFactories = viewFactories; }
  private run(operation: () => unknown | Promise<unknown>): void { Promise.resolve().then(operation).catch(error => notice(error instanceof Error ? error.message : String(error))); }
  private sessionKey(): string { return this.storageScope.sessionKey(this.platform.id); }

  async start(platform: PlatformVault | null): Promise<void> {
    if (!this.initialized) {
      const native = workspaceWindowBridge(window.zorid);
      if (native) {
        const identity = validateWorkspaceWindowInfo(await native.getWindowInfo());
        this.storageScope = new WorkspaceStorageScope(identity);
      }
      this.hotkeys = new HotkeyPreferences(localStorage,/Mac/i.test(window.navigator.platform)?'mac':'other');
      const refreshHotkeys=()=>{this.hotkeys.reload();this.refreshHotkeyLabels();this.hotkeySettings?.refresh();this.syncNativeHotkeys();};
      const storageHotkeys=(event:StorageEvent)=>{if(event.key===HOTKEY_STORAGE_KEY||event.key===null)refreshHotkeys();};
      window.addEventListener('storage',storageHotkeys);
      const releaseCommand=window.zorid?.onCommand?.(id=>{if(id==='close-tab'&&!this.hotkeySurfaceBlocked())this.executeHotkey(id);});
      this.hotkeyCleanup=()=>{window.removeEventListener('storage',storageHotkeys);releaseCommand?.();this.hotkeySettings?.destroy();};
      this.syncNativeHotkeys();
      document.addEventListener('keydown', this.keyListener);
      document.addEventListener('contextmenu',this.inputContextListener);
      window.addEventListener('beforeunload', this.unloadListener);
      this.initialized = true;
      this.closeCleanup=window.zorid?.onBeforeClose?.(async()=>{
        if(this.closing)throw new Error('Window close already pending');
        this.closing=true;const inert=this.root.inert;this.root.inert=true;
        try{await this.destroy();}catch(error){this.closing=false;this.root.inert=inert;throw error;}
      });
    }
    try {
      const saved = JSON.parse(localStorage.getItem('zorid:settings') || '{}');
      Object.assign(this.settings, saved);
      this.settings.defaultMode = 'live';
      if (saved?.defaultMode === 'source') this.saveSettings();
    } catch { /* Defaults survive corrupt preferences. */ }
    this.applySettings();
    if (!platform) { this.showVaultPicker(); return; }
    await this.openVault(platform);
  }

  private showVaultPicker(): void {
    this.disposeShell();
    this.root.replaceChildren();
    const screen = el('div', 'vault-picker'); const panel = el('div', 'vault-picker-panel');
    panel.append(el('div', 'app-symbol', '◈'), el('h1', '', 'Zorid'), el('p', 'muted', 'Your notes, on your device.'));
    const row = el('div', 'vault-picker-row');
    const description = el('div'); description.append(el('strong', '', 'Open folder as vault'), el('p', 'muted', 'Choose a folder containing your notes.'));
    row.append(description, textButton('Open', () => this.run(() => this.chooseVault()), 'mod-cta')); panel.append(row); screen.append(panel); this.root.append(screen);
  }

  private closeCleanup?:()=>void;
  private closing=false;
  private platformReleased=false;
  private platformDrained=false;
  private async releasePlatform():Promise<void>{
    if(this.platformReleased||!this.platform?.release)return;
    if(!this.platformDrained){await this.flush();await this.clearCachedViews();for(const pane of this.panes)await this.disposePaneViews(pane);for(const buffer of this.buffers.values())await buffer.dispose();this.platformDrained=true;}
    await this.platform.release();this.platformReleased=true;
  }
  async chooseVault(): Promise<void> {
    if(this.closing)throw new Error('Window close is pending');
    await this.flush();
    const releasing=!!this.platform?.release;
    if(releasing)await this.releasePlatform();
    let next:PlatformVault|null=null,pickerError:unknown;
    try{next=await pickDesktopVault();}catch(error){pickerError=error;}
    if(releasing&&!next)next=await createPlatformAdapter();
    if(next)await this.openVault(next);
    else if(!window.zorid)notice('This vault is stored on this device. Folder selection requires the desktop app.');
    if(pickerError)throw pickerError;
  }

  private async recoverDurableBuffers(vault:Vault):Promise<Map<string,NoteBuffer>>{
    const result=new Map<string,NoteBuffer>(),checkpoints=vault.adapter.durableWrites?.checkpoints;
    if(!checkpoints)return result;
    const keys=new Set<string>();let cursor:string|undefined,highWater='0';
    do{const page=await checkpoints.list({limit:100,cursor});highWater=page.highWater;for(const row of page.items)if(!row.deleted&&row.key.startsWith('note/v1/'))keys.add(row.key);cursor=page.cursor??undefined;}while(cursor);
    do{const page=await checkpoints.changes({after:highWater,limit:100,cursor});for(const row of page.items)if(row.key.startsWith('note/v1/'))keys.add(row.key);cursor=page.cursor??undefined;}while(cursor);
    for(const key of keys){
      const head=await checkpoints.load(key);if(!head?.encodedState)continue;
      const raw=JSON.parse(head.encodedState),entryId=key.slice('note/v1/'.length);
      if(raw.version!==1||raw.base?.entryId!==entryId)throw new Error('Unsupported durable note recovery checkpoint; retained');
      const current=await vault.readDurableTextById(entryId);
      if(!current){if(raw.operation||raw.draft!==raw.base.content)throw new Error('Recovered note entry is missing; draft retained');continue;}
      let buffer:NoteBuffer;
      buffer=new NoteBuffer(vault,current.path,{onState:()=>{if(this.vault===vault){this.bufferSubscriptions.publish(buffer);this.renderStatus();}}});
      await buffer.load();result.set(current.path,buffer);
    }
    return result;
  }

  async openVault(platform: PlatformVault): Promise<void> {
    const request=++this.vaultRequest,next=new Vault(platform.adapter);
    // Initialization is read-only and can overlap; only the latest request may
    // enter the serialized teardown/install phase. Old views stay usable while
    // a new adapter initializes, and a late request cannot acquire a watcher.
    await next.initialize();
    if(request!==this.vaultRequest)return;
    const transition=this.vaultTransition.then(async()=>{if(request===this.vaultRequest){let recovered=await this.recoverDurableBuffers(next);if(await platform.recoverCommands?.()){await next.initialize();recovered=await this.recoverDurableBuffers(next);}await this.replaceVault(platform,next,recovered);}});
    this.vaultTransition=transition.catch(()=>{});
    await transition;
  }

  private async replaceVault(platform:PlatformVault,next:Vault,recovered=new Map<string,NoteBuffer>()):Promise<void>{
    // Migration failures must abort before teardown/save can replace legacy recovery.
    this.storageScope.migrateLegacy(localStorage, platform.id);
    this.menuSerial++; await dismissContextMenu(this.root.ownerDocument);
    if(!this.platformReleased)await this.flush();
    this.saveSession();
    for (const dispose of this.disposers) dispose(); this.disposers = [];
    clearTimeout(this.reloadTimer);
    this.tabDocking?.destroy();this.tabDocking=undefined;await this.clearCachedViews();
    for(const pane of this.panes)await this.disposePaneViews(pane);if(!this.platformReleased)for(const buffer of this.buffers.values())await buffer.dispose(); this.buffers.clear();
    if(!this.platformReleased&&this.platform?.release)await this.platform.release();
    this.attachments?.destroy();
    this.canvasDocumentInput?.destroy();this.canvasDocumentInput=undefined;
    this.treeDrag?.destroy(); this.treeDrag=undefined; this.treeRename?.session.dispose(); this.treeRename=undefined; this.folderCreationIntent++;
    this.treeRows=[]; this.treeSelection.clear(); this.treeSelectionAnchor=undefined; this.entryTokens.clear();
    this.platform = platform; this.vault = next; this.platformReleased=false;this.platformDrained=false;this.buffers=recovered; this.vaultGeneration++;
    this.attachments=new AttachmentResources(this.vault);
    this.attachmentImporter=new AttachmentImporter(this.vault);
    this.splitLayout?.destroy(); this.splitLayout=undefined; this.restoringLayout=true;
    this.panes = []; this.autoRevealFiles=false; this.collapsed.clear(); this.bookmarks.clear(); this.sessionState = {};
    this.buildShell();
    this.mountFileTreeDrag();
    let restored = false;
    try {
      const saved = JSON.parse(localStorage.getItem(this.sessionKey()) || 'null');
      if (saved) {
        this.sessionState = saved;this.autoRevealFiles=saved.autoRevealFiles===true;
        this.root.classList.toggle('right-hidden', saved.rightHidden !== false);
        this.root.classList.toggle('left-hidden', saved.leftHidden === true);
        this.collapsed = new Set(saved.collapsed || []); this.bookmarks = new Set(saved.bookmarks || []);
        for (const item of (Array.isArray(saved.panes) ? saved.panes : []).slice(0, 100)) {
          const tabs: Tab[] = (item.tabs || []).filter((tab: Tab) => tab.kind === 'graph' || !tab.path || this.vault.entries.has(tab.path)).map((tab: Tab) => {const history=Array.isArray(tab.history)?tab.history.filter(path=>typeof path==='string'):[];return{...tab,history,historyIndex:Number.isInteger(tab.historyIndex)?Math.max(-1,Math.min(tab.historyIndex!,history.length-1)):history.length-1,mode:tab.mode==='reading'?'reading' as const:'live' as const,id:makeId()};});
          const pane = this.addPane(tabs.length ? tabs : undefined, typeof item.id === 'string' && item.id && !this.panes.some(p=>p.id===item.id) ? item.id : undefined); pane.active = pane.tabs[Math.max(0,Math.min(Number.isInteger(item.active) ? item.active : 0, pane.tabs.length - 1))].id; pane.persisted = item;
        }
        restored = this.panes.length > 0;
      }
    } catch { /* Malformed workspace state does not prevent opening notes. */ }
    if (!restored) this.addPane();
    this.splitLayout!.setPanes(new Map(this.panes.map(pane=>[pane.id,pane.element])),this.sessionState.layout);
    this.activate(this.panes.find(pane=>pane.id===this.sessionState.activePaneId)??this.panes[0]);
    this.restoringLayout=false;
    for (const pane of this.panes) await this.renderPane(pane,{flush:false});
    this.tabDocking=createTabDocking({root:this.root,getPanes:()=>this.dockPanes(),dock:intent=>this.dockTab(intent),enabled:()=>!matchMedia('(max-width: 700px)').matches,onError:error=>notice(error instanceof Error?error.message:String(error))});
    this.disposers.push(this.vault.on('create', change => { this.invalidateTreeTokens(change.path); this.renderSidebar(); }), this.vault.on('delete', change => {
      this.invalidateTreeTokens(change.path);
      const removed=(path:string)=>path===change.path||path.startsWith(change.path+'/');
      this.treeSelection=new Set([...this.treeSelection].filter(path=>!removed(path)));
      if(this.treeSelectionAnchor&&removed(this.treeSelectionAnchor))this.treeSelectionAnchor=undefined;
      if(this.treeRename&&(this.treeRename.path===change.path||this.treeRename.path.startsWith(change.path+'/')))this.treeRename.session.dispose();
      for (const pane of this.panes) for (const tab of [...pane.tabs]) if (tab.path === change.path || tab.path?.startsWith(change.path + '/')) {
        const buffer = this.buffers.get(tab.path);
        if (buffer?.dirty || (pane.active === tab.id ? pane.canvasView : this.cachedViews.get(tab)?.canvasView)?.hasPendingChanges() || (pane.active === tab.id ? pane.baseView : this.cachedViews.get(tab)?.baseView)?.hasPendingChanges() || (pane.active === tab.id ? pane.baseEmbeds : this.cachedViews.get(tab)?.baseEmbeds)?.hasPendingChanges()) { notice(`“${nameOf(tab.path)}” was removed outside the app. Your unsaved text is retained.`); continue; }
        const cached=this.cachedViews.get(tab);
        if(cached){
          const path=tab.path,generation=this.vaultGeneration;
          this.run(async()=>{
            if(generation!==this.vaultGeneration||this.cachedViews.get(tab)!==cached||tab.path!==path||buffer?.dirty||cached.canvasView?.hasPendingChanges()||cached.baseView?.hasPendingChanges()||cached.baseEmbeds?.hasPendingChanges())return;
            // Keep the original path until the runtime's flush gate succeeds.
            // A rejected write must leave the recoverable tab and owner intact.
            await this.disposePaneViews(cached);
            if(this.cachedViews.get(tab)===cached)this.cachedViews.delete(tab);
            if(generation!==this.vaultGeneration||!this.panes.includes(pane)||!pane.tabs.includes(tab)||tab.path!==path||this.vault.entries.has(path))return;
            tab.path=null;
            if(pane.active===tab.id)await this.renderPane(pane);else this.renderTabBar(pane);
            this.saveSession();
          });
        }else{tab.path = null; this.run(()=>this.renderPane(pane));}
      }
      this.renderSidebar(); this.renderRight();
    }), this.vault.on('rename', change => {
      const oldPath = change.oldPath!;
      const movedBuffers=new Set([...this.buffers].filter(([path,buffer])=>this.bufferEntries.has(buffer)&&this.bufferEntries.get(buffer)===this.entryTokens.get(path)).map(([,buffer])=>buffer));
      this.invalidateTreeTokens(oldPath); this.invalidateTreeTokens(change.path);
      const relocate=(path:string)=>path===oldPath||path.startsWith(oldPath+'/')?change.path+path.slice(oldPath.length):path;
      this.bookmarks=new Set([...this.bookmarks].map(relocate));
      this.collapsed=new Set([...this.collapsed].map(relocate));
      this.treeSelection=new Set([...this.treeSelection].map(relocate));
      if(this.treeSelectionAnchor)this.treeSelectionAnchor=relocate(this.treeSelectionAnchor);
      if(this.treeRename)this.treeRename.path=relocate(this.treeRename.path);
      for(const pane of this.loadedViews())pane.history=pane.history.map(relocate);
      for(const pane of this.panes)for(const tab of pane.tabs)if(tab.history)tab.history=tab.history.map(relocate);
      for (const [previous, buffer] of [...this.buffers]) if (previous === oldPath || previous.startsWith(oldPath + '/')) {
        const next = change.path + previous.slice(oldPath.length);
        this.buffers.delete(previous); this.buffers.set(next, buffer);if(movedBuffers.has(buffer)){const token=this.treeEntryToken(next);if(token)this.bufferEntries.set(buffer,token);} this.run(() => buffer.relocate(next));
      }
      for (const pane of this.panes) for (const tab of pane.tabs) if (tab.path === oldPath || tab.path?.startsWith(oldPath + '/')) {
        const previous = tab.path; tab.path = change.path + previous.slice(oldPath.length);
      }
      this.renderSidebar(); this.renderRight(); this.panes.forEach(pane => this.run(()=>this.renderPane(pane))); this.saveSession();
    }), this.vault.on('modify', change => {
      if(/\.base$/i.test(change.path)){
        // The session observes query/config events itself. Keep its active property
        // draft and cached DOM; only reconcile the shared clean config buffer.
        const buffer=this.buffers.get(change.path),generation=this.vaultGeneration;
        if(buffer&&!buffer.dirty)this.run(async()=>{await buffer.reload();if(generation===this.vaultGeneration&&this.buffers.get(change.path)===buffer)this.renderStatus();});
        return;
      }
      if(/\.canvas$/i.test(change.path)){
        const buffer=this.buffers.get(change.path),generation=this.vaultGeneration;
        const targets=this.loadedViews().filter(pane=>this.current(pane)?.path===change.path&&pane.canvasView).map(pane=>({pane,view:pane.canvasView!}));
        if(buffer&&!buffer.dirty)this.run(async()=>{
          for(const {view} of targets)await view.flush();
          if(generation!==this.vaultGeneration)return;
          await buffer.reload();
          if(generation!==this.vaultGeneration||this.buffers.get(change.path)!==buffer)return;
          for(const {view} of targets){const owner=this.loadedViews().find(pane=>pane.canvasView===view);if(owner&&!view.hasPendingChanges()){
            owner.canvasSource=buffer.text;view.setDocument(CanvasDocument.parse(buffer.text));
          }}
        });return;
      }
      if(!isMarkdown(change.path)){for(const pane of this.panes)if(this.current(pane)?.path===change.path)this.run(()=>this.renderPane(pane,{refresh:true}));for(const [tab,pane] of this.cachedViews)if(pane.viewPath===change.path)this.run(async()=>{await this.disposePaneViews(pane);if(this.cachedViews.get(tab)===pane)this.cachedViews.delete(tab);});return;}
      const buffer = this.buffers.get(change.path);
      if (buffer && !buffer.dirty) this.run(async () => {
        const previous=buffer.text,revision=this.bufferRevisions.get(buffer)??0,generation=this.vaultGeneration;
        await buffer.reload();if(generation!==this.vaultGeneration||this.buffers.get(change.path)!==buffer)return;
        if((this.bufferRevisions.get(buffer)??0)===revision)this.mapInactiveSelections(change.path,previous,buffer.text);
        for (const pane of this.loadedViews()) if (pane.viewPath === change.path) { if (pane.viewMode === 'reading') pane.refreshPreview?.(); else pane.editor?.setValue(buffer.text); } this.renderRight();
      });
    }));
    for(const event of ['create','delete','rename','modify'] as const)this.disposers.push(this.vault.on(event,()=>{for(const pane of this.loadedViews())pane.editor?.refreshLinks?.();}));
    const generation = this.vaultGeneration;
    const changedPaths = new Set<string>();
    let needsFullReload = false;
    const vault = this.vault;
    const unsubscribe = platform.adapter.subscribe?.(paths => {
      if (generation !== this.vaultGeneration) return;
      if (paths === undefined) needsFullReload = true;
      else for (const path of paths) changedPaths.add(path);
      clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => {
        const batch = needsFullReload ? undefined : [...changedPaths];
        needsFullReload = false; changedPaths.clear();
        if (generation === this.vaultGeneration) this.run(() => vault.reload(batch));
      }, 250);
    });
    if (unsubscribe) this.disposers.push(unsubscribe);
    this.renderSidebar(); this.renderRight(); this.saveSession();
  }

  private disposeShell(): void {
    this.disposeFileListMenu?.(); this.disposeFileListMenu=undefined;
    this.sidebarControls?.destroy(); this.sidebarControls=undefined;
  }

  private buildShell(): void {
    this.disposeShell();
    this.root.replaceChildren(); this.root.className = 'workspace right-hidden';
    this.root.classList.toggle('is-macos-desktop',!!window.zorid&&/Mac/i.test(window.navigator.platform));
    const ribbon = el('nav', 'ribbon'); ribbon.setAttribute('aria-label', 'Ribbon');
    const top = el('div', 'ribbon-top');
    top.append(this.hotkeyButton('search','quick-switcher', 'Open quick switcher', () => this.quickSwitcher()), button('graph', 'Open graph view', () => this.run(() => this.openGraph())), button('calendar', "Open today's daily note", () => this.run(() => this.dailyNote())), this.hotkeyButton('terminal','command-palette', 'Open command palette', () => this.commandPalette()));
    const bottom = el('div', 'ribbon-bottom'); bottom.append(button('folder', 'Open another vault', () => this.run(() => this.chooseVault())), button('help', 'Help', () => this.help()), this.hotkeyButton('settings','settings', 'Settings', () => this.showSettings())); ribbon.append(top, bottom);
    this.sidebar = el('aside', 'sidebar'); this.sidebar.setAttribute('aria-label', 'Left sidebar');
    const title = el('div', 'titlebar'); title.append(button('sidebar', 'Toggle left sidebar', () => this.toggleLeft()));
    const tabs = el('div', 'sidebar-tabs');
    for (const [type, glyph, label] of [['files','folder','Files'],['search','search','Search'],['bookmarks','bookmark','Bookmarks']] as const) {
      const control = button(glyph, label, () => { this.treeTab = type; this.renderSidebar(); }); control.dataset.type = type; tabs.append(control);
    }
    const tools = el('div', 'sidebar-toolbar');
    const autoReveal=button('gallery-vertical','Auto-reveal active file',()=>{this.autoRevealFiles=!this.autoRevealFiles;this.renderSidebar();this.saveSession();});autoReveal.dataset.action='auto-reveal';
    const collapse=button('chevrons-down-up','Collapse all folders',()=>{const folders=[...this.vault.entries.values()].filter(entry=>entry.type==='folder').map(entry=>entry.path);if(folders.every(path=>this.collapsed.has(path)))this.collapsed.clear();else this.collapsed=new Set(folders);this.renderSidebar();this.saveSession();});collapse.dataset.action='collapse-all';
    tools.append(button('square-pen','New note',() => this.run(() => this.newNote())),button('folder-plus','New folder',() => this.run(() => this.newFolder())),button('arrow-up-narrow-wide','Change sort order',() => {this.reverseSort = !this.reverseSort; this.renderSidebar();}),autoReveal,collapse);
    this.sidebarContent = el('div','sidebar-content');
    const switcher = textButton(this.platform.label, () => this.run(() => this.chooseVault()), 'vault-switcher'); switcher.prepend(icon('folder')); switcher.append(icon('down',14));
    this.sidebar.append(title,tabs,tools,this.sidebarContent,switcher);
    const center = el('section','workspace-center'); this.paneContainer = el('main','panes'); center.append(this.paneContainer);
    this.splitLayout=new SplitLayout(this.paneContainer,{onChange:()=>this.saveSession()});
    this.right = el('aside','right-sidebar'); this.right.setAttribute('aria-label','Right sidebar');
    const rightTabs = el('div','right-tabs');
    for (const [type,glyph,label] of [['backlinks','link','Backlinks'],['outline','list','Outline'],['tags','tag','Tags']] as const) rightTabs.append(button(glyph,label,()=>{this.rightTab=type;this.renderRight();}));
    rightTabs.append(button('rightbar','Toggle right sidebar',()=>this.toggleRight(),'pane-sidebar-toggle')); this.rightContent=el('div','right-content'); this.right.append(rightTabs,this.rightContent);
    this.status = el('footer','status-bar'); this.status.setAttribute('aria-live','polite');
    this.root.append(ribbon,this.sidebar,center,this.right,this.status);
    this.addResizeHandle(this.sidebar,'left'); this.addResizeHandle(this.right,'right');
    this.sidebarControls=createSidebarControls(this.root,{onToggleLeft:()=>this.toggleLeft(),onToggleRight:()=>this.toggleRight()});
    const surface=this.sidebarContent;
    this.disposeFileListMenu=installFileListBackgroundMenu(surface,{
      isAvailable:()=>this.initialized&&!!this.vault&&this.treeTab==='files',
      getTree:()=>surface.querySelector<HTMLElement>(':scope > .file-tree'),
      buildMenu:()=>{
        const generation=this.vaultGeneration,serial=++this.menuSerial;
        return buildFileListBackgroundMenu({hasVault:!!this.vault,
          isValid:()=>this.initialized&&generation===this.vaultGeneration&&serial===this.menuSerial,
          actions:{newNote:()=>this.newNote(''),newFolder:()=>this.newFolder(''),newCanvas:()=>this.newCanvas('')},
        });
      },
      clearSelection:()=>{this.treeSelection.clear();this.treeSelectionAnchor=undefined;this.paintTreeSelection();const focused=surface.ownerDocument.activeElement;if(focused instanceof HTMLElement&&surface.contains(focused)&&focused.matches('[role="treeitem"]'))focused.blur();},
      onError:error=>notice(error instanceof Error?error.message:String(error)),
    });
  }

  private addResizeHandle(sidebar: HTMLElement, side: 'left'|'right'): void {
    const handle = el('div','sidebar-resize'); handle.setAttribute('role','separator'); handle.setAttribute('aria-orientation','vertical'); handle.setAttribute('aria-label',`Resize ${side} sidebar`); handle.tabIndex=0;
    handle.onpointerdown = event => { handle.setPointerCapture(event.pointerId); const initial=event.clientX,width=sidebar.getBoundingClientRect().width;
      handle.onpointermove=e=>sidebar.style.width=`${Math.min(500,Math.max(180,width+(e.clientX-initial)*(side==='left'?1:-1)))}px`;
      handle.onpointerup=()=>{handle.onpointermove=null;handle.onpointerup=null;};
    };
    handle.onkeydown=event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();sidebar.style.width=`${Math.min(500,Math.max(180,sidebar.getBoundingClientRect().width+(event.key==='ArrowRight'?10:-10)*(side==='left'?1:-1)))}px`;}};
    sidebar.append(handle);
  }

  private current(pane=this.activePane): Tab { return pane.tabs.find(tab=>tab.id===pane.active)!; }
  private addPane(tabs?: Tab[], id=makeId()): Pane {
    const first: Tab = {id:makeId(),path:null,mode:this.settings.defaultMode,kind:'note'};
    const pane: Pane={id,tabs:tabs||[first],active:tabs?.[0]?.id||first.id,element:el('section','pane'),renderVersion:0,history:[],historyIndex:-1};
    pane.element.tabIndex=-1;
    pane.element.addEventListener('focusin',()=>this.activate(pane)); pane.element.onpointerdown=()=>this.activate(pane);
    this.panes.push(pane); this.paneContainer.append(pane.element); return pane;
  }
  private focusPane(pane:Pane):void{if(pane.editor)pane.editor.focus();else pane.element.focus({preventScroll:true});}
  private activate(pane: Pane): void { const changed=this.activePane!==pane;if(changed)this.paneActivationRevision++;this.activePane=pane; this.panes.forEach(p=>p.element.classList.toggle('is-active',p===pane));if(changed&&this.sidebar.isConnected)this.renderSidebar(); this.renderRight(); this.renderStatus(); }
  async openNote(path:string,newTab=false,pane=this.activePane,recordHistory=true,subpath='',expectedActivation?:number): Promise<void> {
    if(this.vault.entries.get(path)?.type!=='file') throw new Error(`File not found: ${path}`);
    const intent=(this.navigationIntent.get(pane)??0)+1,generation=this.vaultGeneration,version=pane.renderVersion;this.navigationIntent.set(pane,intent);
    await this.flushPane(pane);
    if(/\.base$/i.test(path))await this.prepareBase(path,generation);
    if(this.navigationIntent.get(pane)!==intent||generation!==this.vaultGeneration||pane.renderVersion!==version||!this.panes.includes(pane)||(expectedActivation!==undefined&&expectedActivation!==this.paneActivationRevision))return;
    this.noteNavigation.set(pane,(this.noteNavigation.get(pane)??0)+1);
    this.capturePaneState(pane);const current=this.current(pane);
    const existing=pane.tabs.find(tab=>tab.path===path&&tab.kind==='note');
    if(existing&&!newTab) pane.active=existing.id;
    else if(!newTab&&current){if(current.path!==path)current.viewState=undefined;if(current.kind==='graph')current.mode=this.settings.defaultMode;current.path=path;current.kind='note';}
    else {const tab:Tab={id:makeId(),path,mode:this.settings.defaultMode,kind:'note'};pane.tabs.push(tab);pane.active=tab.id;}
    this.current(pane).subpath=subpath;
    pane.history=this.current(pane).history??[];pane.historyIndex=this.current(pane).historyIndex??-1;
    if(recordHistory&&pane.history[pane.historyIndex]!==path){pane.history=pane.history.slice(0,pane.historyIndex+1);pane.history.push(path);pane.historyIndex=pane.history.length-1;}
    this.current(pane).history=pane.history;this.current(pane).historyIndex=pane.historyIndex;
    this.activate(pane); await this.renderPane(pane); this.renderSidebar();this.renderRight();this.saveSession();
    if(matchMedia('(max-width: 700px)').matches)this.root.classList.add('left-hidden');
  }

  private async prepareBase(path:string,generation=this.vaultGeneration):Promise<void>{
    const vault=this.vault,token=this.treeEntryToken(path);
    const validate=()=>{if(generation!==this.vaultGeneration||vault!==this.vault||!token||this.treeEntryToken(path)!==token)throw new Error('The Base file is no longer current.');};
    const buffer=await this.baseBufferFor(path,validate);
    validate();if(buffer.dirty)buffer.update(buffer.text,{validateWrite:()=>{validate();if(this.buffers.get(path)!==buffer||buffer.path!==path)throw new Error('The Base buffer was replaced.');}});await buffer.flush();validate();
  }

  private async baseBufferFor(path:string,validateOwner:()=>void):Promise<NoteBuffer>{
    validateOwner();const token=this.treeEntryToken(path),buffer=await this.bufferFor(path);
    const validate=()=>{validateOwner();if(!token||this.treeEntryToken(path)!==token||this.buffers.get(path)!==buffer||buffer.path!==path)throw new Error('The Base target file is no longer current.');};
    validate();
    if(this.bufferEntries.get(buffer)!==token){
      if(buffer.dirty||buffer.error)throw new Error('This file was replaced; its previous recovery draft is retained.');
      await buffer.reload();validate();
      if(buffer.dirty||buffer.error)throw new Error('This file changed while reconnecting its Base buffer.');
      this.bufferEntries.set(buffer,token!);
    }
    return buffer;
  }

  private async bufferFor(path:string):Promise<NoteBuffer>{
    let buffer=this.buffers.get(path); if(buffer){await buffer.load();return buffer;}
    buffer=new NoteBuffer(this.vault,path,{storage:localStorage,storageKey:this.storageScope.draftPrefix(this.platform.id),onState:()=>{if(buffer)this.bufferSubscriptions.publish(buffer);this.renderStatus();}});
    this.buffers.set(path,buffer);const token=this.treeEntryToken(path);if(token)this.bufferEntries.set(buffer,token);
    try{await buffer.load();return buffer;}catch(error){this.buffers.delete(path);throw error;}
  }

  private renderTabBar(pane:Pane):void{
    const tab=this.current(pane);if(!tab)return;
    const bar=el('div','tab-bar'); bar.setAttribute('role','tablist');
    bar.append(button('sidebar','Toggle left sidebar',()=>this.toggleLeft(),'pane-sidebar-toggle'));
    const strip=el('div','tab-strip');bar.append(strip);
    for(const item of pane.tabs){
      const node=el('div',`tab${item.id===tab.id?' is-active':''}`);node.role='tab';node.tabIndex=item.id===tab.id?0:-1;node.setAttribute('aria-selected',String(item.id===tab.id));node.draggable=true;node.dataset.tabId=item.id;
      node.append(icon(item.kind==='graph'?'graph':'file',15),el('span','tab-title',item.kind==='graph'?'Graph view':item.path?nameOf(item.path):'New tab'));
      const close=button('close','Close tab',event=>{event.stopPropagation();this.run(()=>this.closeTab(pane,item));},'tab-close');node.append(close);
      const select=()=>this.run(()=>this.selectTab(pane,item));node.onclick=select;
      node.oncontextmenu=event=>{event.preventDefault();event.stopPropagation();this.tabMenu(pane,item,event.clientX,event.clientY);};
      node.onkeydown=event=>{if(event.key==='Enter'||event.key===' ')select();if(event.key==='ArrowRight'||event.key==='ArrowLeft'){event.preventDefault();const index=pane.tabs.indexOf(item);const next=pane.tabs[(index+(event.key==='ArrowRight'?1:pane.tabs.length-1))%pane.tabs.length].id;this.run(()=>this.selectTab(pane,pane.tabs.find(tab=>tab.id===next)!));}};
      strip.append(node);
    }
    bar.append(this.hotkeyButton('plus','new-tab','New tab',()=>this.run(()=>this.newTab(pane)),'tab-add'),button('down','Tab menu',event=>this.tabMenuAt(pane,event.currentTarget as HTMLElement)));
    pane.element.querySelector(':scope > .tab-bar')?.remove();pane.element.prepend(bar);
  }

  private async selectTab(pane:Pane,tab:Tab):Promise<void>{
    const intent=(this.navigationIntent.get(pane)??0)+1,generation=this.vaultGeneration;this.navigationIntent.set(pane,intent);
    if(pane.active===tab.id){this.activate(pane);this.focusPane(pane);return;}
    await this.flushPane(pane);
    if(intent!==this.navigationIntent.get(pane)||generation!==this.vaultGeneration||!this.panes.includes(pane)||!pane.tabs.includes(tab))return;
    pane.active=tab.id;this.activate(pane);await this.renderPane(pane);this.saveSession();
  }

  async renderPane(initialPane:Pane,options:{flush?:boolean;refresh?:boolean}={}):Promise<void>{
    let pane=initialPane;
    const request=(this.renderRequests.get(initialPane)??0)+1,generation=this.vaultGeneration;this.renderRequests.set(initialPane,request);
    const current=()=>generation===this.vaultGeneration&&this.panes.includes(initialPane)&&this.renderRequests.get(initialPane)===request;
    if(options.flush!==false)await this.flushPane(pane);
    if(!current())return;
    const wanted=this.current(pane);
    if(!options.refresh&&pane.viewReady&&pane.viewTabId===wanted?.id&&pane.viewPath===wanted.path&&pane.viewMode===wanted.mode&&pane.viewKind===wanted.kind ){
      this.applyViewSettings(pane);this.renderTabBar(pane);pane.refreshPreview?.();return;
    }
    if(pane.viewTabId&&pane.viewTabId!==pane.active&&pane.tabs.some(tab=>tab.id===pane.viewTabId))this.parkPaneView(pane);else await this.disposePaneViews(pane);
    if(!current())return;
    const tab=this.current(pane);if(!tab)return;
    this.renderTabBar(pane);
    if(await this.restoreCachedView(pane,tab)){this.renderStatus();return;}
    if(!current())return;
    const version=++this.viewSequence;pane.renderVersion=version;pane.viewTabId=tab.id;pane.viewPath=tab.path;pane.viewMode=tab.mode;pane.viewKind=tab.kind;pane.viewSettings=this.viewSettings();
    pane.history=tab.history??[];pane.historyIndex=tab.historyIndex??-1;
    const content=el('div','tab-view-content');Object.assign(content.style,{display:'flex',flexDirection:'column',flex:'1',minHeight:'0',minWidth:'0',overflow:'hidden'});pane.element.append(content);pane.content=content;
    let recoveryCleanup:(()=>void)|undefined;
    const runtime=createTabViewRuntime({id:tab.id,element:content,owner:this.viewOwner(pane),
      flush:async()=>{await pane.canvasView?.flush();if(pane.viewPath)await this.buffers.get(pane.viewPath)?.flushForNavigation();await pane.baseView?.close();await pane.baseEmbeds?.flush();},
      dispose:async()=>{await pane.baseEmbeds?.close();recoveryCleanup?.();this.releasePaneView(pane,content);},focus:()=>this.focusPane(pane)});pane.runtime=runtime;
    let ownerChanged=()=>{};pane.rebindView=owner=>{pane=owner;ownerChanged();};
    const toolbar=el('div','pane-toolbar');
    const back=button('left','Navigate back',()=>this.run(()=>this.navigate(-1,pane)));back.disabled=pane.historyIndex<=0;
    const forward=button('right','Navigate forward',()=>this.run(()=>this.navigate(1,pane)));forward.disabled=pane.historyIndex>=pane.history.length-1;
    toolbar.append(back,forward,el('div','breadcrumbs',tab.path?tab.path.replace(/\.md$/,'').replaceAll('/',' / '):''));
    const actions=el('div','view-actions');
    if(!tab.path||isMarkdown(tab.path))actions.append(this.hotkeyButton(tab.mode==='reading'?'edit':'book','toggle-reading',tab.mode==='reading'?'Switch to Live Edit':'Switch to reading view',()=>this.run(()=>this.toggleReading(pane))));
    actions.append(button('more','More options',event=>this.tabMenuAt(pane,event.currentTarget as HTMLElement)),button('rightbar','Toggle right sidebar',()=>this.toggleRight(),'pane-sidebar-toggle'));toolbar.append(actions);content.append(toolbar);
    if(tab.kind==='graph'){this.renderGraph(content);pane.viewReady=true;return;}
    if(!tab.path){this.renderEmpty(pane,content);pane.viewReady=true;return;}
    const path=tab.path;
    if(!isMarkdown(path)){
      const host=el('div','attachment-view');content.append(host);
      host.oncontextmenu=event=>{
        // Preserve the browser's playback menu on native controls.
        if((event.target as Element|null)?.closest?.('audio, video')){event.stopPropagation();return;}
        event.preventDefault();const entry=this.vault.entries.get(path);if(entry)this.fileMenu(entry,event.clientX,event.clientY);
      };
      if(/\.base$/i.test(path)){
        host.classList.add('base-attachment-view');Object.assign(host.style,{display:'flex',flexDirection:'column',minHeight:'0',overflow:'hidden',padding:'0'});
        try{
          await this.prepareBase(path,generation);if(version!==pane.renderVersion||!current())return;
          const vault=this.vault,fileToken=this.treeEntryToken(path),resources=this.attachments!;
          const validate=()=>{
            if(generation!==this.vaultGeneration||vault!==this.vault||pane.runtime!==runtime||runtime.phase==='disposed')throw new Error('The Base view is no longer open.');
            if(!fileToken||this.treeEntryToken(path)!==fileToken||vault.entries.get(path)?.type!=='file')throw new Error('The Base file is no longer current.');
          };
          const session=this.createWorkspaceBaseSession(host,path,()=>pane,validate);
          pane.baseView=session;await session.ready;
        }catch(error){if(version===pane.renderVersion)host.append(el('p','error-message',error instanceof Error?error.message:String(error)));}
      }
      else if(isImage(path))pane.imageView=createImageView(host,path,this.attachments!);
      else if(mediaKind(path)){
        host.classList.add('media-attachment-view');
        const view=(this.viewFactories.media??createMediaView)(host,path,this.attachments!);
        pane.mediaView=view;void view.ready.catch(error=>{if(pane.mediaView===view&&version===pane.renderVersion)notice(error instanceof Error?error.message:String(error));});
      }
      else if(/\.pdf$/i.test(path)){
        host.classList.add('pdf-attachment-view');
        const vault=this.vault,fileToken=this.treeEntryToken(path);
        const view=(this.viewFactories.pdf??createPdfView)(host,path,this.attachments!,{generateMarkdownLink:(subpath:string,alias:string)=>this.vault===vault&&pane.runtime===runtime&&runtime.phase!=='disposed'&&this.treeEntryToken(path)===fileToken?pdfMarkdownLink(vault,path,subpath,alias,this.settings):null,subpath:tab.subpath,mobile:matchMedia('(max-width: 700px)').matches,onOpenMenu:event=>{const entry=this.vault.entries.get(path);if(entry){const point=this.menuPoint(event);this.fileMenu(entry,point.x,point.y);}}});
        pane.pdfView=view;void view.ready.catch(error=>{if(pane.pdfView===view&&version===pane.renderVersion)notice(error instanceof Error?error.message:String(error));});
      }else if(/\.canvas$/i.test(path)){
        host.classList.add('canvas-attachment-view');
        try{
          const buffer=await this.bufferFor(path);if(version!==pane.renderVersion)return;
          const generation=this.vaultGeneration,vault=this.vault,fileToken=this.treeEntryToken(path);pane.canvasSource=buffer.text;
          const services=this.canvasEditorServices(path,()=>pane,()=>{
            if(generation!==this.vaultGeneration||vault!==this.vault||pane.runtime!==runtime||runtime.phase==='disposed'||pane.embeds!==services.embeds)throw new Error('The Canvas view is closed.');
            if(!fileToken||this.treeEntryToken(path)!==fileToken||vault.entries.get(path)?.type!=='file'||this.buffers.get(path)!==buffer||buffer.path!==path)throw new Error('The Canvas file is no longer current.');
          });
          pane.embeds=services.embeds;
          pane.canvasView=(this.viewFactories.canvas??createCanvasView)(host,{...{openMarkdownFile:(target:string)=>this.openCanvasMarkdownSession(target,()=>pane,runtime),
            chooseFile:(kind?:'note'|'media')=>this.canvasDocumentInput?.chooseFile(()=>generation===this.vaultGeneration&&pane.runtime===runtime&&runtime.phase==='active'&&pane.content?.isConnected===true,kind)??Promise.resolve(null),
            textEditorOptions:services.options,
            textEmbedLifecycle:services.baseSessions,
            renderFile:(target:string,subpath?:string)=>{
              const parent=el('div'),token=this.treeEntryToken(target),available=()=>generation===this.vaultGeneration&&pane.runtime===runtime&&runtime.phase!=='disposed'&&token!==undefined&&this.treeEntryToken(target)===token&&this.vault.entries.get(target)?.type==='file';
              if(!available()){const element=el('p','error-message',`File not found: ${target}`);return{element,destroy(){element.remove();}};}
              const view=createCanvasAttachmentCard(parent,{path:target,subpath,resources:this.attachments!,generateMarkdownLink:(fragment,alias)=>available()?pdfMarkdownLink(this.vault,target,fragment,alias,this.settings):null,pdfFactory:this.viewFactories.pdf,mediaFactory:this.viewFactories.media,mobile:matchMedia('(max-width: 700px)').matches,
                openFile:(file,fragment)=>available()?this.openNote(file,false,pane,true,fragment??''):Promise.resolve(),onError:error=>{if(available())notice(error instanceof Error?error.message:String(error));}});
              return{element:view.element,destroy:()=>view.destroy()};
            },
            filePathsFromDrop:(transfer:DataTransfer)=>generation===this.vaultGeneration&&pane.runtime===runtime&&runtime.phase==='active'?this.canvasDocumentInput?.filePathsFromDrop(transfer)??[]:[]},document:CanvasDocument.parse(buffer.text),onChange:async source=>{
            if(generation!==this.vaultGeneration||version!==pane.renderVersion)throw new Error('The Canvas is no longer open.');
            if(buffer.text!==pane.canvasSource)throw new Error('The Canvas changed in another pane. Save or reload before editing it again.');
            buffer.update(source);runtime.touch();pane.canvasSource=source;await buffer.flush();
            for(const other of this.loadedViews())if(other!==pane&&this.current(other)?.path===path&&other.canvasView&&!other.canvasView.hasPendingChanges()){
              other.canvasSource=source;other.canvasView.setDocument(CanvasDocument.parse(source));
            }
          },openFile:(target,fragment)=>this.vault.entries.has(target)?this.openNote(target,false,pane,true,fragment??''):this.followLink(path,target+(fragment??''),pane,'markdown'),
          openFileInNewTab:target=>this.vault.entries.has(target)?this.openNote(target,true,pane):Promise.resolve(),openLink:target=>{if(/^(?:https?:\/\/|mailto:)/i.test(target))window.open(target,'_blank','noopener,noreferrer');},onError:error=>notice(error instanceof Error?error.message:String(error))});
        }catch(error){pane.embeds?.destroy();pane.embeds=undefined;host.append(el('p','error-message',error instanceof Error?error.message:String(error)));}
      }
      else host.append(el('p','muted',`No viewer is available yet for ${path.split('.').at(-1)?.toUpperCase()||'this file type'}.`));
      pane.viewReady=true;this.renderStatus();return;
    }
    const scroll=el('div','note-scroll');scroll.classList.toggle('readable-width',this.settings.readableWidth);
    const title=el('input','note-title');title.value=nameOf(path);title.setAttribute('aria-label','Note title');title.hidden=!this.settings.showInlineTitle;
    const titleGeneration=this.vaultGeneration;let titleNavigation=this.noteNavigation.get(pane),titlePath=path;ownerChanged=()=>{titleNavigation=this.noteNavigation.get(pane);};
    bindNoteTitleFocus(title,{
      save:async name=>{if(titleGeneration!==this.vaultGeneration||!this.panes.includes(pane)||this.current(pane)!==tab||tab.path!==titlePath)return;if(name!==nameOf(titlePath))titlePath=await this.renamePath(titlePath,name);},
      isCurrent:()=>this.initialized&&titleGeneration===this.vaultGeneration&&this.activePane===pane&&this.current(pane)===tab&&tab.path===titlePath&&this.noteNavigation.get(pane)===titleNavigation&&pane.element.isConnected,
      focusBody:()=>pane.editor?.focus(),onError:error=>notice(error instanceof Error?error.message:String(error)),
    });
    scroll.append(title);content.append(scroll);
    try{
      const buffer=await this.bufferFor(path);if(version!==pane.renderVersion)return;
      recoveryCleanup=this.mountNoteRecovery(content,buffer);
      {
        const host=el('div','properties-host');scroll.append(host);
        pane.properties=renderProperties(host,{isCurrent:()=>pane.viewPath===path&&pane.renderVersion===version&&this.buffers.get(path)===buffer,onError:error=>notice(error instanceof Error?error.message:String(error)),getSource:()=>buffer.text,onChange:async next=>{
          this.updateMarkdownBuffer(buffer,next);runtime.touch();
          for(const other of this.loadedViews()){if(this.current(other)?.path===path){other.editor?.setValue(next);other.refreshPreview?.();if(other!==pane)other.properties?.refresh();}}
          await buffer.flush();
        },openLink:target=>this.run(()=>this.followLink(path,target,pane))});
      }
      const baseSessions=this.embeddedBases(()=>pane,()=>{if(generation!==this.vaultGeneration||pane.runtime!==runtime||runtime.phase==='disposed')throw new Error('The source note is closed.');});
      const createEmbeds=()=>new MarkdownEmbeds({bases:{sessions:baseSessions,identity:target=>this.treeEntryToken(target)},vault:this.vault,resources:this.attachments,pdfFactory:this.viewFactories.pdf,generatePdfLink:(target,fragment,alias)=>generation===this.vaultGeneration&&pane.runtime===runtime&&runtime.phase!=='disposed'?pdfMarkdownLink(this.vault,target,fragment,alias,this.settings):null,contextMenu:(event,request,source)=>{const target=this.vault.metadata.resolveLink(source,request.target,request.kind);const entry=target?this.vault.entries.get(target):undefined;if(entry){const point=this.menuPoint(event);event.preventDefault();event.stopPropagation();this.fileMenu(entry,point.x,point.y);}},open:(source,target,kind)=>this.run(()=>this.followLink(source,target,pane,kind)),read:async target=>{const loaded=this.buffers.get(target);if(loaded){await loaded.load();if(loaded.dirty)return loaded.text;}return this.vault.cachedRead(target);},taskChange:(target,line,checked)=>this.changeTask(target,line,checked)});
      if(tab.mode==='reading'){
        const preview=el('div','markdown-preview');scroll.append(preview);
        pane.refreshPreview=()=>{
          if(version!==pane.renderVersion||pane.viewPath!==path||!pane.runtime||pane.runtime.phase==='disposed')return;
          destroyMarkdown(preview);
          pane.embeds?.destroy();
          const embeds=createEmbeds();
          pane.embeds=embeds;
          try{
            renderMarkdown(preview,buffer.text,(target,kind)=>this.run(()=>this.followLink(path,target,pane,kind)),(line,checked)=>this.run(()=>this.changeTask(path,line,checked)),{embed:request=>embeds.render(request,path),properties:false});
          }catch(error){destroyMarkdown(preview);embeds.destroy();if(pane.embeds===embeds)pane.embeds=undefined;throw error;}
        };
        pane.refreshPreview();
      }else{
        const host=el('div','editor-host');scroll.append(host);
        const factory=this.editorFactory||(await import('./editor.ts')).createEditor;if(version!==pane.renderVersion)return;
        const embeds=createEmbeds();pane.embeds=embeds;const generation=this.vaultGeneration;
        const ownsEditor=()=>generation===this.vaultGeneration&&pane.renderVersion===version&&pane.viewPath===path;
        pane.editor=factory(host,{hotkeys:this.hotkeys,value:buffer.text,mode:tab.mode,paths:()=>ownsEditor()?[...this.vault.entries.keys()]:[],
          wiki:{sourcePath:()=>ownsEditor()?path:null,
            metadata:target=>{if(!ownsEditor())return;const dirty=this.buffers.get(target),metadata=dirty?.dirty?parseMetadata(target,dirty.text):this.vault.metadata.get(target);return{aliases:metadata?.aliases,headings:metadata?.headings,mtime:this.vault.entries.get(target)?.mtime};},
            resolvePath:(target,source)=>ownsEditor()?this.vault.metadata.resolveLink(source,target):null,
            linkText:(target,source)=>{
              if(!ownsEditor())return target.replace(/\.md$/i,'');
              let result=target;const filename=target.split('/').at(-1)!;
              if(this.settings.newLinkFormat==='shortest'){const matches=this.vault.metadata.resolveLinkCandidates(source,filename);if(matches.length===1&&matches[0]===target)result=filename;}
              else if(this.settings.newLinkFormat==='relative'){const from=parentOf(source).split('/').filter(Boolean),to=target.split('/');while(from.length&&to.length&&from[0]===to[0]){from.shift();to.shift();}result=from.length?[...from.map(()=>'..'),...to].join('/'):'./'+to.join('/');}
              return result.replace(/\.md$/i,'');
            }},
          isUnresolved:(target,kind)=>generation!==this.vaultGeneration||!this.vault.metadata.resolveLink(path,target,kind),
          listOptions:{useTab:this.settings.useTab,tabSize:this.settings.tabSize,smartIndentList:this.settings.smartIndentList},
          renderEmbed:(request,context)=>{const dom=embeds.render(request,path,[],undefined,context);return{dom,destroy:()=>embeds.releaseEmbed(dom)};},
          transfers:{autoConvertHtml:()=>this.settings.autoConvertHtml,importFile:file=>this.importAttachment(file,path,generation),nativePath:file=>window.zorid?.getPathForFile?.(file)??'',onError:error=>notice(error instanceof Error?error.message:String(error))},
          onChange:value=>{this.updateMarkdownBuffer(buffer,value);runtime.touch();this.renderStatus();for(const other of this.loadedViews()){if(this.current(other)?.path===path){if(other!==pane)other.editor?.setValue(value);clearTimeout(other.propertyTimer);const properties=other.properties,preview=other.refreshPreview;other.propertyTimer=setTimeout(()=>{properties?.refresh();preview?.();},150);}}},open:(target,kind)=>{if(generation===this.vaultGeneration&&pane.renderVersion===version&&pane.viewPath===path)this.run(()=>this.followLink(path,target,pane,kind));}});
      }
      if(tab.viewState){if(tab.viewState.editor)pane.editor?.restoreViewState?.(tab.viewState.editor);if(Number.isFinite(tab.viewState.scrollTop))scroll.scrollTop=Math.max(0,tab.viewState.scrollTop);if(Number.isFinite(tab.viewState.scrollLeft))scroll.scrollLeft=Math.max(0,tab.viewState.scrollLeft);}
      if(buffer.error)notice(buffer.error.message);
    }catch(error){
      if(version!==pane.renderVersion)return;
      destroyMarkdown(scroll);pane.embeds?.destroy();pane.embeds=undefined;pane.refreshPreview=undefined;
      scroll.append(el('p','error-message',error instanceof Error?error.message:String(error)));
    }
    if(version===pane.renderVersion)pane.viewReady=true;this.renderStatus();
  }

  private createWorkspaceBaseSession(host:HTMLElement,path:string,owner:()=>Pane,validate:()=>void,sourcePath?:string,viewName?:string):BaseSession{
    const vault=this.vault,resources=this.attachments!;
    return (this.viewFactories.base??createBaseSession)(host,{vault,basePath:path,validate,viewName,query:{currentFilePath:sourcePath??path},
            buffers:{getBuffer:target=>this.baseBufferFor(target,validate),validate,
              onBufferChange:(target,buffer,previous)=>{
                this.mapInactiveSelections(target,previous,buffer.text);
                for(const embeds of new Set([...this.canvasMarkdownEmbeds,...this.loadedViews().flatMap(owner=>owner.embeds?[owner.embeds]:[])]))embeds.invalidate(target);
                for(const owner of this.loadedViews())if(owner.viewPath===target){owner.editor?.setValue(buffer.text);owner.properties?.refresh();owner.refreshPreview?.();}
              },
              rename:async(source,destination,validateResult)=>{
                validate();validateResult();const token=this.treeEntryToken(source);
                // Calling Workspace.flush here would await this accepted Base
                // operation itself. Flush the shared buffers before Vault's queue.
                for(const buffer of this.buffers.values())await buffer.flush();
                await vault.rename(source,destination,()=>{validate();validateResult();if(!token||this.treeEntryToken(source)!==token)throw new Error('The moved file is no longer current.');this.requireAvailableTreePath(vault,destination,source);});
              }},
            openFile:(target,event)=>this.run(()=>{validate();return this.openNote(target,('button'in event&&event.button===1)||event.metaKey||event.ctrlKey,owner());}),
            loadThumbnail:async request=>{
              validate();if(request.signal.aborted)return null;
              const raw=request.property==='file.file'?request.row.path:request.value.type==='string'?request.value.value:'';
              const wiki=/^!?\[\[([^\r\n]*?)\]\]$/.exec(raw),link=wiki?wiki[1].split('|')[0]:raw;
              const target=vault.entries.has(raw)?raw:vault.metadata.resolveLink(request.row.path,link,'wiki');
              if(!target||!isImage(target))return null;
              const token=this.treeEntryToken(target),lease=await resources.acquire(target);
              try{validate();if(request.signal.aborted||!token||this.treeEntryToken(target)!==token){lease.release();return null;}return{url:lease.url,dispose:()=>lease.release()};}catch(error){lease.release();throw error;}
            },onError:error=>notice(error instanceof Error?error.message:String(error))});
  }

  private embeddedBases(owner:()=>Pane,validateOwner:()=>void):BaseEmbedSessions{
    const pane=owner();if(pane.baseEmbeds)return pane.baseEmbeds;
    const vault=this.vault,generation=this.vaultGeneration;
    const sessions=new BaseEmbedSessions({recoveryHost:pane.content!,create:async(container,target)=>{
      const sourceIdentity=target.sourceIdentity;
      const validate=()=>{
        validateOwner();
        if(vault!==this.vault||generation!==this.vaultGeneration)throw new Error('The embedded Base vault is closed.');
        if(!sourceIdentity||this.treeEntryToken(target.sourcePath)!==sourceIdentity)throw new Error('The source document changed. Your embedded Base edits are retained.');
        if(!target.targetIdentity||this.treeEntryToken(target.targetPath)!==target.targetIdentity||vault.entries.get(target.targetPath)?.type!=='file')throw new Error('The embedded Base file changed. Your edits are retained.');
      };
      validate();await this.prepareBase(target.targetPath,generation);validate();
      return this.createWorkspaceBaseSession(container,target.targetPath,owner,validate,target.sourcePath,target.viewName||undefined);
    }});
    pane.baseEmbeds=sessions;return sessions;
  }

  /** Both Canvas text and linked-note cards use the existing Markdown services.
   * The caller owns the manager and supplies its current source/view guard. */
  private canvasEditorServices(path:string,owner:()=>Pane,validate:()=>void):{embeds:MarkdownEmbeds;baseSessions:BaseEmbedSessions;options:Omit<EditorOptions,'value'|'mode'|'onChange'>}{
    const vault=this.vault,generation=this.vaultGeneration,workspace=this;
    const available=()=>{try{validate();return true;}catch{return false;}};
    const open=(target:string,kind:'wiki'|'markdown'='wiki')=>{if(available())this.run(()=>{if(available())return this.followLink(path,target,owner(),kind);});};
    const runtime=owner().runtime;
    const baseSessions=this.embeddedBases(owner,()=>{if(vault!==this.vault||generation!==this.vaultGeneration||owner().runtime!==runtime||runtime?.phase==='disposed')throw new Error('The Canvas source is closed.');});
    const embeds=new MarkdownEmbeds({bases:{sessions:baseSessions,identity:target=>this.treeEntryToken(target)},vault,resources:this.attachments,pdfFactory:this.viewFactories.pdf,generatePdfLink:(target,fragment,alias)=>available()?pdfMarkdownLink(vault,target,fragment,alias,this.settings):null,
      open:(source,target,kind)=>{if(available())this.run(()=>{if(available())return this.followLink(source,target,owner(),kind);});},
      read:async target=>{validate();const loaded=this.buffers.get(target);if(loaded){await loaded.load();validate();if(loaded.dirty)return loaded.text;}return vault.cachedRead(target);},
      taskChange:(target,line,checked)=>{validate();return this.changeTask(target,line,checked,validate);},
      contextMenu:(event,request,source)=>{if(!available())return;const target=vault.metadata.resolveLink(source,request.target,request.kind),entry=target?vault.entries.get(target):undefined;if(entry){const point=this.menuPoint(event);event.preventDefault();event.stopPropagation();this.fileMenu(entry,point.x,point.y);}},
    });
    const options:Omit<EditorOptions,'value'|'mode'|'onChange'>={hotkeys:this.hotkeys,paths:()=>available()?[...vault.entries.keys()]:[],open,
        get listOptions(){return{useTab:workspace.settings.useTab,tabSize:workspace.settings.tabSize,smartIndentList:workspace.settings.smartIndentList};},
        isUnresolved:(target,kind)=>!available()||!vault.metadata.resolveLink(path,target,kind),
        wiki:{sourcePath:()=>available()?path:null,
          metadata:target=>{if(!available())return;const dirty=this.buffers.get(target),metadata=dirty?.dirty?parseMetadata(target,dirty.text):vault.metadata.get(target);return{aliases:metadata?.aliases,headings:metadata?.headings,mtime:vault.entries.get(target)?.mtime};},
          resolvePath:(target,source)=>available()?vault.metadata.resolveLink(source,target):null,
          linkText:(target,source)=>{
            if(!available())return target.replace(/\.md$/i,'');
            let result=target;const filename=target.split('/').at(-1)!;
            if(this.settings.newLinkFormat==='shortest'){const matches=vault.metadata.resolveLinkCandidates(source,filename);if(matches.length===1&&matches[0]===target)result=filename;}
            else if(this.settings.newLinkFormat==='relative'){const from=parentOf(source).split('/').filter(Boolean),to=target.split('/');while(from.length&&to.length&&from[0]===to[0]){from.shift();to.shift();}result=from.length?[...from.map(()=>'..'),...to].join('/'):'./'+to.join('/');}
            return result.replace(/\.md$/i,'');
          }},
        renderEmbed:(request,context)=>{validate();const dom=embeds.render(request,path,[],undefined,context);return{dom,destroy:()=>embeds.releaseEmbed(dom)};},
        transfers:{autoConvertHtml:()=>this.settings.autoConvertHtml,importFile:async file=>{validate();const result=await this.importAttachment(file,path,generation);validate();return result;},nativePath:file=>window.zorid?.getPathForFile?.(file)??'',onError:error=>notice(error instanceof Error?error.message:String(error))},
      };
    return{embeds,options,baseSessions};
  }

  private async openCanvasMarkdownSession(path:string,owner:()=>Pane,runtime:TabViewRuntime):Promise<CanvasMarkdownBufferSession>{
    const vault=this.vault,generation=this.vaultGeneration,token=this.treeEntryToken(path);
    if(!isMarkdown(path)||vault.entries.get(path)?.type!=='file'||!token)throw new Error(`Markdown file not found: ${path}`);
    const validateFile=()=>{
      if(this.vault!==vault||this.vaultGeneration!==generation||this.treeEntryToken(path)!==token||vault.entries.get(path)?.type!=='file')throw new Error('The Canvas note file is no longer current. Your draft is retained.');
    };
    const validateSession=()=>{
      if(owner().runtime!==runtime||runtime.phase==='disposed')throw new Error('The Canvas view is closed.');
    };
    validateSession();
    const buffer=await this.bufferFor(path);validateFile();validateSession();
    const validateWrite=()=>{validateFile();if(this.buffers.get(path)!==buffer||buffer.path!==path)throw new Error('The Canvas note buffer was replaced. Your draft is retained.');};
    let disposed=false;
    const services=this.canvasEditorServices(path,owner,()=>{if(disposed)throw new Error('The Canvas file card is closed.');validateWrite();validateSession();});
    const embeds=services.embeds;
    this.canvasMarkdownEmbeds.add(embeds);
    const session=createCanvasMarkdownBufferSession({buffer,validateWrite,validateSession,
      subscribe:listener=>this.bufferSubscriptions.subscribe(buffer,listener),
      update:(next,guard)=>{
        this.updateMarkdownBuffer(buffer,next,guard);runtime.touch();
        for(const pane of this.loadedViews()){
          if(pane.viewPath===path){pane.editor?.setValue(next);pane.properties?.refresh();pane.refreshPreview?.();}
        }
      },
      editorOptions:services.options,
      dispose:()=>{disposed=true;embeds.destroy();this.canvasMarkdownEmbeds.delete(embeds);},
      onError:error=>notice(error instanceof Error?error.message:String(error)),
    });
    return{...session,flush:async()=>{await services.baseSessions.flush();await session.flush();},hasPendingChanges:()=>services.baseSessions.hasPendingChanges()||session.hasPendingChanges()};
  }

  private updateMarkdownBuffer(buffer:NoteBuffer,next:string,validateWrite?:()=>void):void{
    const previous=buffer.text;buffer.update(next,{validateWrite});this.mapInactiveSelections(buffer.path,previous,next);
    for(const embeds of new Set([...this.canvasMarkdownEmbeds,...this.loadedViews().flatMap(pane=>pane.embeds?[pane.embeds]:[])]))embeds.invalidate(buffer.path);
  }

  private mapInactiveSelections(path:string,previous:string,next:string):void{
    if(previous===next)return;
    const buffer=this.buffers.get(path);if(buffer)this.bufferRevisions.set(buffer,(this.bufferRevisions.get(buffer)??0)+1);
    const states=this.panes.flatMap(pane=>pane.tabs.filter(tab=>tab.path===path&&(tab.id!==pane.viewTabId||!pane.editor)).map(tab=>tab.viewState?.editor)).filter(state=>state&&Array.isArray(state.selection?.ranges));
    if(!states.length)return;
    const changes=ChangeSet.of(textChanges(previous,next),previous.length);
    for(const state of states){
      const saved=state!,ranges=saved.selection.ranges;
      if(!ranges.length||ranges.length>1000||!ranges.every(range=>Number.isFinite(range?.anchor)&&Number.isFinite(range?.head)))continue;
      const clamp=(position:number)=>Math.max(0,Math.min(previous.length,Math.trunc(position)));
      const main=Number.isInteger(saved.selection.mainIndex)?Math.max(0,Math.min(ranges.length-1,saved.selection.mainIndex)):0;
      const mapped=EditorSelection.create(ranges.map(range=>EditorSelection.range(clamp(range.anchor),clamp(range.head))),main).map(changes);
      saved.selection={ranges:mapped.ranges.map(range=>({anchor:range.anchor,head:range.head})),mainIndex:mapped.mainIndex};
    }
  }

  private capturePaneState(pane:Pane):void{
    const tab=pane.tabs.find(item=>item.id===pane.viewTabId);
    if(!tab||tab.path!==pane.viewPath)return;
    if(tab.id===pane.active){tab.history=[...pane.history];tab.historyIndex=pane.historyIndex;}
    const scroll=pane.element.querySelector<HTMLElement>('.note-scroll');
    if(!scroll)return;
    tab.viewState={editor:pane.editor?.getViewState?.()??tab.viewState?.editor,scrollTop:scroll.scrollTop,scrollLeft:scroll.scrollLeft};
  }

  private dockPanes():DockPane[]{
    return this.panes.flatMap(pane=>{const tabBar=pane.element.querySelector<HTMLElement>(':scope > .tab-bar');if(!tabBar)return[];
      const nodes=[...tabBar.querySelectorAll<HTMLElement>(':scope > .tab-strip > .tab')];
      return[{id:pane.id,element:pane.element,tabBar,tabs:pane.tabs.flatMap(tab=>{const element=nodes.find(node=>node.dataset.tabId===tab.id);return element?[{id:tab.id,element}]:[];})}];});
  }

  /** Model/topology and live ownership commit synchronously, before loading the
   * source's next tab. Moving content never requires writing a dirty buffer. */
  private async dockTab(intent:DockIntent):Promise<void>{
    const source=this.panes.find(pane=>pane.id===intent.sourcePaneId),target=this.panes.find(pane=>pane.id===intent.targetPaneId);
    const tab=source?.tabs.find(tab=>tab.id===intent.tabId),layout=this.splitLayout;
    if(!source||!target||!tab||!layout||!['center','left','right','top','bottom'].includes(intent.edge))return;
    const cached=this.cachedViews.get(tab);
    if(cached&&(cached.viewPath!==tab.path||cached.viewMode!==tab.mode||cached.viewKind!==tab.kind)){
      await this.disposePaneViews(cached);if(this.cachedViews.get(tab)===cached)this.cachedViews.delete(tab);
      if(!this.panes.includes(source)||!this.panes.includes(target)||!source.tabs.includes(tab))return;
    }
    if(source.runtime&&(!source.viewReady||source.runtime.phase!=='active')||target.runtime&&(!target.viewReady||target.runtime.phase!=='active'))return;
    const generation=this.vaultGeneration;
    this.navigationIntent.set(source,(this.navigationIntent.get(source)??0)+1);this.navigationIntent.set(target,(this.navigationIntent.get(target)??0)+1);
    if(intent.edge==='center'&&source===target){
      const from=source.tabs.indexOf(tab),index=Math.max(0,Math.min(source.tabs.length-1,Math.trunc(intent.index)));
      if(!Number.isFinite(index)||from===index)return;
      source.tabs.splice(from,1);source.tabs.splice(index,0,tab);this.renderTabBar(source);this.saveSession();return;
    }
    const tree=layout.serialize(),panes=[...this.panes],active=this.activePane;
    const snapshots=panes.map(pane=>({pane,tabs:[...pane.tabs],active:pane.active,viewTabId:pane.viewTabId}));
    const restoring=this.restoringLayout;this.restoringLayout=true;
    let destination=target,moved=false;
    try{
      // A whole group can move without changing any content ownership.
      if(intent.edge!=='center'&&source.tabs.length===1){
        if(source===target)return;
        if(layout.move(source.id,target.id,intent.edge)){this.activate(source);moved=true;}return;
      }
      if(intent.edge!=='center'){
        destination=this.addPane([tab]);
        const edge=intent.edge==='left'?'right':intent.edge==='top'?'bottom':intent.edge;
        if(!layout.split(target.id,destination.id,destination.element,edge))throw new Error('Could not split the destination pane.');
        if(intent.edge==='left'||intent.edge==='top')if(!layout.move(destination.id,target.id,intent.edge))throw new Error('Could not position the destination pane.');
      }
      const wasActive=source.active===tab.id,sourceIndex=source.tabs.indexOf(tab);
      // Keep the moving wrapper connected until runtime.attach has captured child
      // focus. The target's prior view remains cached with its own resources.
      if(wasActive)this.parkPaneView(source,true);
      if(destination===target)this.parkPaneView(destination);
      source.tabs.splice(sourceIndex,1);
      if(destination===target){const index=Number.isFinite(intent.index)?Math.max(0,Math.min(destination.tabs.length,Math.trunc(intent.index))):destination.tabs.length;destination.tabs.splice(index,0,tab);}
      destination.active=tab.id;
      if(wasActive&&source.tabs.length)source.active=source.tabs[Math.min(sourceIndex,source.tabs.length-1)].id;
      this.restoreCachedViewNow(destination,tab);
      if(!source.tabs.length){this.panes=this.panes.filter(pane=>pane!==source);layout.remove(source.id);}
      this.renderTabBar(destination);if(source.tabs.length)this.renderTabBar(source);
      this.activate(destination);if(destination.runtime&&!destination.content?.contains(document.activeElement))this.focusPane(destination);moved=true;
    }catch(error){
      // No resources are destroyed during this transaction. Recover the former
      // tab owners and topology before exposing the failure to the caller.
      for(const pane of this.panes){const original=snapshots.find(snapshot=>snapshot.pane===pane);if(pane.runtime&&pane.viewTabId!==original?.viewTabId)this.parkPaneView(pane,true);}
      this.panes=panes;
      for(const snapshot of snapshots){
        const pane=snapshot.pane;pane.tabs=snapshot.tabs;pane.active=snapshot.active;
        if(!pane.element.isConnected)this.paneContainer.append(pane.element);
        if(!pane.runtime)this.restoreCachedViewNow(pane,this.current(pane));this.renderTabBar(pane);
      }
      if(destination!==target)destination.element.remove();
      layout.setPanes(new Map(panes.map(pane=>[pane.id,pane.element])),tree);
      this.activate(active);throw error;
    }finally{this.restoringLayout=restoring;this.saveSession();}
    if(!moved||generation!==this.vaultGeneration)return;
    // Existing views restore synchronously; only never-loaded fallback tabs await.
    if(source.tabs.length&&!source.runtime)await this.renderPane(source,{flush:false});
    if(generation!==this.vaultGeneration||!this.panes.includes(destination))return;
    if(!destination.runtime){await this.renderPane(destination,{flush:false});if(generation===this.vaultGeneration&&this.activePane===destination)this.focusPane(destination);}
    this.renderRight();this.saveSession();
  }

  private loadedViews():Pane[]{return[...this.panes,...this.cachedViews.values()];}
  private viewOwner(pane:Pane){return{paneId:pane.id,vaultId:this.platform.id,vaultGeneration:this.vaultGeneration};}
  private applyViewSettings(pane:Pane):void{
    pane.content?.querySelector('.note-scroll')?.classList.toggle('readable-width',this.settings.readableWidth);
    const title=pane.content?.querySelector<HTMLInputElement>('.note-title');if(title)title.hidden=!this.settings.showInlineTitle;
    if(pane.viewSettings!==this.viewSettings())pane.editor?.configureLists?.({useTab:this.settings.useTab,tabSize:this.settings.tabSize,smartIndentList:this.settings.smartIndentList});
    pane.viewSettings=this.viewSettings();
  }
  private viewSettings():string{return JSON.stringify([this.settings.readableWidth,this.settings.showInlineTitle,this.settings.useTab,this.settings.tabSize,this.settings.smartIndentList]);}
  private clearPaneViewFields(pane:Pane):void{
    pane.viewTabId=undefined;pane.viewPath=undefined;pane.viewMode=undefined;pane.viewKind=undefined;pane.viewReady=false;pane.rebindView=undefined;pane.content=undefined;pane.runtime=undefined;
    pane.editor=undefined;pane.imageView=undefined;pane.pdfView=undefined;pane.mediaView=undefined;pane.canvasView=undefined;pane.baseView=undefined;pane.canvasSource=undefined;pane.baseEmbeds=undefined;pane.embeds=undefined;pane.properties=undefined;pane.refreshPreview=undefined;pane.propertyTimer=undefined;
    pane.renderVersion=++this.viewSequence;
  }
  private parkPaneView(pane:Pane,keepConnected=false):void{
    const tab=pane.tabs.find(tab=>tab.id===pane.viewTabId);
    if(!tab||!pane.content||!pane.runtime)return;
    this.capturePaneState(pane);
    const parked:Pane={...pane,tabs:[tab],active:tab.id,history:[...pane.history],element:pane.content};
    pane.rebindView?.(parked);this.cachedViews.set(tab,parked);
    if(!keepConnected)pane.runtime.detach();
    this.clearPaneViewFields(pane);
  }
  /** No await between attachment and owner rebinding. Failed attach leaves the
   * cached owner/resources intact so the caller can roll back its tab model. */
  private restoreCachedViewNow(pane:Pane,tab:Tab):boolean{
    const cached=this.cachedViews.get(tab);if(!cached?.runtime||!cached.content)return false;
    const connected=cached.content.isConnected;
    cached.runtime.attach(pane.element,this.viewOwner(pane));
    const fields=['viewTabId','viewPath','viewMode','viewKind','viewReady','viewSettings','rebindView','editor','imageView','pdfView','mediaView','canvasView','baseView','canvasSource','baseEmbeds','embeds','properties','refreshPreview','propertyTimer','renderVersion','runtime','content'] as const;
    for(const key of fields)(pane as unknown as Record<string,unknown>)[key]=cached[key];
    pane.history=tab.history??cached.history;pane.historyIndex=tab.historyIndex??cached.historyIndex;
    pane.rebindView?.(pane);this.cachedViews.delete(tab);this.applyViewSettings(pane);
    const saved=tab.viewState?.editor,current=pane.editor?.getViewState?.();
    if(!connected&&saved&&current&&JSON.stringify(saved.selection)!==JSON.stringify(current.selection))pane.editor?.restoreViewState?.({...current,selection:saved.selection});
    return true;
  }
  private async restoreCachedView(pane:Pane,tab:Tab):Promise<boolean>{
    const cached=this.cachedViews.get(tab);if(!cached)return false;
    if(cached.viewPath!==tab.path||cached.viewMode!==tab.mode||cached.viewKind!==tab.kind){
      await this.disposePaneViews(cached);this.cachedViews.delete(tab);return false;
    }
    return this.restoreCachedViewNow(pane,tab);
  }
  private async clearCachedViews():Promise<void>{for(const [tab,pane] of this.cachedViews){await this.disposePaneViews(pane);this.cachedViews.delete(tab);}}
  private releasePaneView(pane:Pane,content:HTMLElement):void{
    this.capturePaneState(pane);destroyMarkdown(content);
    clearTimeout(pane.propertyTimer);pane.editor?.destroy();pane.imageView?.destroy();pane.pdfView?.destroy();pane.mediaView?.destroy();pane.canvasView?.destroy();pane.embeds?.destroy();pane.properties?.destroy();this.clearPaneViewFields(pane);
  }
  private async disposePaneViews(pane:Pane):Promise<void>{
    if(pane.runtime){await pane.canvasView?.flush();await pane.runtime.destroy();}
  }

  private async importAttachment(file:TransferFile,ownerPath:string,generation:number):Promise<string>{
    if(generation!==this.vaultGeneration||!this.attachmentImporter)throw new Error('The destination vault is no longer open.');
    let existingVaultPath:string|undefined;
    if(file.nativePath&&this.platform.id.startsWith('desktop:')){
      const root=this.platform.id.slice(8).replace(/\\/g,'/').replace(/\/$/,''),native=file.nativePath.replace(/\\/g,'/');
      if(native.startsWith(root+'/')){const relative=native.slice(root.length+1);if(this.vault.entries.get(relative)?.type==='file')existingVaultPath=relative;}
    }
    const result=await this.attachmentImporter.import({...file,existingVaultPath},ownerPath,()=>{
      // Reading a pasted file can outlive this vault. Validate ownership before
      // sampling the active note and allocating any attachment directories.
      if(generation!==this.vaultGeneration)throw new Error('The destination vault is no longer open.');
      return this.current()?.path??null;
    },this.settings);
    return result.embed;
  }

  private async changeTask(path:string,line:number,checked:boolean,validate?:()=>void):Promise<void>{
    validate?.();const buffer=await this.bufferFor(path);validate?.();const lines=buffer.text.split('\n');
    const marker=lines[line]?.match(/^([ \t]*(?:>[ \t]*)*(?:[-*+]|\d+[.)])[ \t]+\[)([^\]\r\n])(\])(?=[ \t]|\r?$)/);
    if(!marker)throw new Error('The task changed. Reopen the note before toggling it.');
    const at=marker[1].length;lines[line]=lines[line].slice(0,at)+(checked?'x':' ')+lines[line].slice(at+1);this.updateMarkdownBuffer(buffer,lines.join('\n'));await buffer.flush();
    for(const pane of this.loadedViews()){if(pane.viewPath===path){if(pane.viewMode==='reading')pane.refreshPreview?.();else pane.editor?.setValue(buffer.text);}}
  }

  private renderEmpty(pane:Pane,host=pane.element):void{
    const empty=el('div','empty-state');
    const actions=el('div','empty-actions');
    for(const [label,shortcut,action]of [['Create new file','new-note',()=>this.run(()=>this.newNote())],['Go to file','quick-switcher',()=>this.quickSwitcher()],['Open command palette','command-palette',()=>this.commandPalette()]] as const){const row=textButton(label,action,'empty-action');const hint=el('kbd','',this.hotkeys.label(shortcut));hint.dataset.hotkeyCommand=shortcut;hint.hidden=!hint.textContent;row.append(hint);actions.append(row);}empty.append(actions);host.append(empty);
  }

  private renderSidebar():void{
    if(!this.vault)return;
    const activePath=this.activePane&&this.current()?.path;
    if(this.autoRevealFiles&&activePath){let folder=parentOf(activePath);while(folder){this.collapsed.delete(folder);folder=parentOf(folder);}}
    const autoReveal=this.sidebar.querySelector<HTMLButtonElement>('[data-action="auto-reveal"]');autoReveal?.classList.toggle('is-active',this.autoRevealFiles);autoReveal?.setAttribute('aria-pressed',String(this.autoRevealFiles));
    const folders=[...this.vault.entries.values()].filter(entry=>entry.type==='folder'),allCollapsed=folders.length>0&&folders.every(entry=>this.collapsed.has(entry.path));
    const collapse=this.sidebar.querySelector<HTMLButtonElement>('[data-action="collapse-all"]');
    if(collapse){const label=allCollapsed?'Expand all folders':'Collapse all folders';collapse.title=label;collapse.setAttribute('aria-label',label);collapse.replaceChildren(icon(allCollapsed?'chevrons-up-down':'chevrons-down-up'));}
    this.sidebar.querySelectorAll<HTMLElement>('.sidebar-tabs button').forEach(node=>node.classList.toggle('is-active',node.dataset.type===this.treeTab));
    const renameHadFocus=!!this.treeRename&&this.sidebarContent.contains(this.root.ownerDocument.activeElement)&&this.root.ownerDocument.activeElement?.getAttribute('contenteditable')==='true';
    this.treeRows=[];
    this.sidebarContent.replaceChildren();
    if(this.treeTab==='search'){
      const input=el('input','search-box');input.placeholder='Search…';input.value=this.query;input.type='search';input.setAttribute('aria-label','Search all files');input.oninput=()=>{this.query=input.value;this.run(()=>this.search());};this.sidebarContent.append(input,el('div','search-results'));this.run(()=>this.search());return;
    }
    if(this.treeTab==='bookmarks'){
      if(!this.bookmarks.size)this.sidebarContent.append(el('p','sidebar-empty','No bookmarks yet. Use the note menu to bookmark a file.'));
      for(const path of this.bookmarks)if(this.vault.entries.has(path)){const row=textButton(nameOf(path),()=>this.run(()=>this.openNote(path)),'tree-row');row.prepend(icon('bookmark',15));this.sidebarContent.append(row);}return;
    }
    const tree=el('div','file-tree');tree.role='tree';tree.setAttribute('aria-label','Files');
    const entries=[...this.vault.entries.values()].sort((a,b)=>(a.type===b.type?0:a.type==='folder'?-1:1)||a.path.localeCompare(b.path,undefined,{numeric:true})*(this.reverseSort?-1:1));
    const children=new Map<string,VaultEntry[]>();for(const entry of entries){const parent=parentOf(entry.path);let items=children.get(parent);if(!items){items=[];children.set(parent,items);}items.push(entry);}
    this.treeOrder=[];const order=(parent:string)=>{for(const entry of children.get(parent)??[]){this.treeOrder.push(entry.path);if(entry.type==='folder')order(entry.path);}};order('');
    const append=(parent:string,container:HTMLElement,depth:number)=>{
      for(const entry of children.get(parent)??[]){
        const folder=entry.type==='folder';const row=el('div',`tree-row${folder?' folder-row':''}${this.activePane&&this.current()?.path===entry.path?' is-active':''}`);
        row.style.paddingLeft=`${10+depth*16}px`;row.role='treeitem';row.tabIndex=0;row.title=entry.path;row.setAttribute('aria-label',entry.path);row.dataset.path=entry.path;row.setAttribute('aria-selected',String(this.treeSelection.has(entry.path)));row.classList.toggle('is-selected',this.treeSelection.has(entry.path));
        if(folder){row.setAttribute('aria-expanded',String(!this.collapsed.has(entry.path)));row.append(icon(this.collapsed.has(entry.path)?'right':'down',14));}
        else row.append(el('span','file-indent'));
        const label=el('span','tree-label',fileTreeLabel(entry));row.append(label);
        const activate=()=>{
          if(folder){
            if(this.collapsed.has(entry.path))this.collapsed.delete(entry.path);else this.collapsed.add(entry.path);
            this.renderSidebar();
            // A toggle replaces this row. Keep keyboard commands on the folder
            // activated by the user; unrelated sidebar rebuilds do not restore focus.
            this.treeRows.find(item=>item.path===entry.path)?.element.focus({preventScroll:true});
            this.saveSession();
          }else{const opening=this.openTreeFile(entry.path,row);this.run(()=>opening);}
        };
        row.onclick=event=>{
          if(event.button!==0)return;
          const mod=/Mac/i.test(window.navigator.platform)?event.metaKey:event.ctrlKey;
          if(!mod&&(event.altKey||event.shiftKey)){
            if(event.shiftKey)this.selectTreeRange(entry.path);
            else{if(this.treeSelection.has(entry.path))this.treeSelection.delete(entry.path);else this.treeSelection.add(entry.path);this.treeSelectionAnchor=entry.path;this.paintTreeSelection();}
            row.focus();return;
          }
          this.treeSelection.clear();this.treeSelectionAnchor=entry.path;this.paintTreeSelection();
          if(!folder&&mod)this.run(()=>this.openNote(entry.path,true));else activate();
        };
        row.onauxclick=event=>{if(!folder&&event.button===1){event.preventDefault();this.run(()=>this.openNote(entry.path,true));}};
        row.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();activate();}if(event.key==='F2'){event.preventDefault();this.run(()=>this.beginTreeRename(entry.path));}};
        row.oncontextmenu=event=>{event.preventDefault();this.fileMenu(entry,event.clientX,event.clientY,true);};
        row.draggable=true;
        this.treeRows.push({path:entry.path,element:row,collapsed:folder&&this.collapsed.has(entry.path)});
        if(this.treeRename?.path===entry.path)this.treeRename.session.attach(row,label,{focus:renameHadFocus});
        container.append(row);if(folder&&!this.collapsed.has(entry.path))append(entry.path,container,depth+1);
      }
    };append('',tree,0);this.sidebarContent.append(tree);if(this.autoRevealFiles)tree.querySelector<HTMLElement>('.tree-row.is-active')?.scrollIntoView({block:'nearest'});
  }

  private async openTreeFile(path:string,row:HTMLElement):Promise<void>{
    if(!row.isConnected||this.treeTab!=='files')return;
    const doc=this.root.ownerDocument,win=doc.defaultView,vault=this.vault,pane=this.activePane;
    const generation=this.vaultGeneration,activation=this.paneActivationRevision,token=this.treeEntryToken(path),navigation=(this.navigationIntent.get(pane)??0)+1;
    row.focus({preventScroll:true});
    let relinquished=false;
    const focus=(event:FocusEvent)=>{if(event.target!==row&&event.target!==doc.body&&event.target!==doc.documentElement)relinquished=true;};
    const pointer=(event:PointerEvent)=>{if(event.target&&!row.contains(event.target as Node))relinquished=true;};
    const blur=()=>{relinquished=true;};
    doc.addEventListener('focusin',focus,true);doc.addEventListener('pointerdown',pointer,true);win?.addEventListener('blur',blur);
    try{
      await this.openNote(path,false,pane,true,'',activation);
      // Opening a file replaces its explorer row. Restore only the originating
      // action's focus, never a newer editor/control/window/navigation intent.
      if(relinquished||vault!==this.vault||generation!==this.vaultGeneration||this.activePane!==pane||this.paneActivationRevision!==activation||this.navigationIntent.get(pane)!==navigation
        ||this.current(pane).path!==path||this.treeEntryToken(path)!==token||this.treeTab!=='files'||this.root.classList.contains('left-hidden'))return;
      const active=doc.activeElement;
      if(active!==row&&active!==doc.body&&active!==doc.documentElement)return;
      this.treeRows.find(item=>item.path===path)?.element.focus({preventScroll:true});
    }finally{
      doc.removeEventListener('focusin',focus,true);doc.removeEventListener('pointerdown',pointer,true);win?.removeEventListener('blur',blur);
    }
  }

  private async search():Promise<void>{
    const generation=++this.searchGeneration;const results=this.sidebarContent.querySelector('.search-results');if(!results)return;
    results.replaceChildren();if(!this.query.trim()){results.append(el('p','sidebar-empty','Type to search your vault.'));return;}
    const query=this.query.toLocaleLowerCase();let count=0;
    for(const entry of this.vault.entries.values()){
      if(entry.type!=='file'||!entry.path.endsWith('.md'))continue;
      const text=await this.vault.read(entry.path);if(generation!==this.searchGeneration)return;
      const lines=text.split('\n');const matching=lines.map((line,index)=>({line,index})).filter(item=>item.line.toLocaleLowerCase().includes(query));
      if(!entry.path.toLocaleLowerCase().includes(query)&&!matching.length)continue;
      count++;const item=el('div','search-result');item.append(textButton(nameOf(entry.path),()=>this.run(()=>this.openNote(entry.path)),'search-result-title'));
      for(const match of matching.slice(0,4)){const snippet=textButton(match.line.trim().slice(0,180),()=>this.run(()=>this.openNote(entry.path)),'search-snippet');snippet.title=`Line ${match.index+1}`;item.append(snippet);}results.append(item);
    }
    if(!count)results.append(el('p','sidebar-empty','No results found.'));
  }

  private renderRight():void{
    if(!this.vault||!this.activePane)return;this.rightContent.replaceChildren();const path=this.current()?.path;
    if(this.rightTab==='backlinks'){
      this.rightContent.append(el('h3','right-heading','Linked mentions'));const links=path?this.vault.metadata.backlinks(path):[];
      const unique=[...new Set(links.map(link=>link.source))];for(const source of unique){const row=textButton(nameOf(source),()=>this.run(()=>this.openNote(source)),'backlink-row');row.prepend(icon('file',14));this.rightContent.append(row);}if(!unique.length)this.rightContent.append(el('p','sidebar-empty','No backlinks found.'));
    }else if(this.rightTab==='outline'){
      const headings=path?this.vault.metadata.get(path)?.headings||[]:[];this.rightContent.append(el('h3','right-heading','Outline'));
      for(const heading of headings){const row=textButton(heading.heading,()=>{const target=this.activePane.element.querySelector(`#heading-${heading.line}`);target?.scrollIntoView({block:'start',behavior:'smooth'});},'outline-row');row.style.paddingLeft=`${12+(heading.level-1)*12}px`;this.rightContent.append(row);}if(!headings.length)this.rightContent.append(el('p','sidebar-empty','No headings found.'));
    }else{
      this.rightContent.append(el('h3','right-heading','Tags'));const tags=new Map<string,number>();for(const entry of this.vault.entries.values())for(const tag of this.vault.metadata.get(entry.path)?.tags||[])tags.set(tag,(tags.get(tag)||0)+1);
      for(const[tag,count]of[...tags].sort((a,b)=>a[0].localeCompare(b[0]))){const row=textButton(tag,()=>{this.treeTab='search';this.query=tag.startsWith('#')?tag:`#${tag}`;this.renderSidebar();},'tag-row');row.append(el('span','tag-count',String(count)));this.rightContent.append(row);}if(!tags.size)this.rightContent.append(el('p','sidebar-empty','No tags found.'));
    }
  }

  private mountNoteRecovery(content:HTMLElement,buffer:NoteBuffer):()=>void{
    const banner=el('section','note-recovery');banner.setAttribute('aria-label','Retained note draft');
    const message=el('p','','This note changed elsewhere. Your draft is shown below and is safely retained. Save a recovery copy to keep both versions.');
    const actions=el('div','note-recovery-actions');
    const copy=textButton('Copy draft',()=>this.run(async()=>{await navigator.clipboard.writeText(buffer.text);notice('Draft copied.');}));
    let busy=false;
    const save=textButton('Save recovery copy',()=>this.run(async()=>{
      if(busy)return;busy=true;save.disabled=true;
      try{
        const result=await buffer.saveRecoveryCopy();
        notice(result.resolved?`Draft saved to “${result.path}”. The original now shows its latest version.`:`Draft saved to “${result.path}”. Newer edits are still retained here.`);
        // Every pane sharing this buffer must follow its newly adopted text.
        if(result.resolved)for(const view of this.loadedViews())if(view.viewPath===buffer.path){view.editor?.setValue(buffer.text);view.refreshPreview?.();view.properties?.refresh();}
      }finally{busy=false;save.disabled=false;refresh();}
    }),'mod-cta');
    actions.append(copy,save);banner.append(message,actions);content.insertBefore(banner,content.querySelector('.note-scroll'));
    const refresh=()=>{banner.hidden=!buffer.hasRecoveryConflict;};refresh();
    return this.bufferSubscriptions.subscribe(buffer,refresh);
  }

  /** A failed admission can offer another folder only before any vault/buffer
   * was installed, and after its platform lease has been released successfully. */
  async cleanupFailedStartup(platform:PlatformVault|null):Promise<boolean>{
    if(this.platform||this.buffers.size||this.panes.length){this.startupFailed=true;return false;}
    await platform?.release?.();await this.destroy();return true;
  }

  private renderStatus():void{
    if(!this.activePane)return;const tab=this.current();const buffer=tab?.path?this.buffers.get(tab.path):undefined;const text=buffer?.text||'';
    this.status.replaceChildren();
    if(tab?.path&&!isMarkdown(tab.path)){this.status.append(el('span','',`${this.vault.entries.get(tab.path)?.size??0} bytes`));return;}
    this.status.append(el('span','save-state',buffer?.error?'Save failed — draft retained':buffer?.dirty?'Saving…':''));
    const mode=textButton(tab?.mode==='reading'?'Reading view':'Live Edit',()=>this.modeMenu(mode),'status-mode');
    this.status.append(mode,el('span','',`${text.trim()?text.trim().split(/\s+/u).length:0} words`),el('span','',`${[...text].length} characters`));
  }

  async newNote(folder=''):Promise<void>{
    let index=0,path='';do{path=`${folder?folder+'/':''}Untitled${index?' '+index:''}.md`;index++;}while(this.vault.entries.has(path));
    const generation=this.vaultGeneration,pane=this.activePane,version=pane.renderVersion,intent=(this.navigationIntent.get(pane)??0)+1,activation=this.paneActivationRevision;
    this.navigationIntent.set(pane,intent);
    await this.vault.create(path,'');if(generation!==this.vaultGeneration||!this.panes.includes(pane)||pane.renderVersion!==version||this.navigationIntent.get(pane)!==intent||activation!==this.paneActivationRevision)return;
    await this.openNote(path,false,pane,true,'',activation);if(generation!==this.vaultGeneration||this.activePane!==pane||this.current(pane)?.path!==path||this.navigationIntent.get(pane)!==intent+1)return;
    const title=pane.element.querySelector<HTMLInputElement>('.note-title');
    if(title&&!title.hidden){title.focus();title.select();}else pane.editor?.focus();
  }
  private async newCanvas(folder=''):Promise<void>{
    let index=0,path='';do{path=`${folder?folder+'/':''}Untitled${index?' '+index:''}.canvas`;index++;}while(this.vault.entries.has(path));
    const vault=this.vault,generation=this.vaultGeneration,pane=this.activePane,version=pane.renderVersion,intent=(this.navigationIntent.get(pane)??0)+1,activation=this.paneActivationRevision;
    this.navigationIntent.set(pane,intent);
    await vault.create(path,JSON.stringify({nodes:[],edges:[]}));
    if(generation!==this.vaultGeneration||!this.panes.includes(pane)||pane.renderVersion!==version||this.navigationIntent.get(pane)!==intent||activation!==this.paneActivationRevision)return;
    await this.openNote(path,false,pane,true,'',activation);
  }
  async newFolder(parent=''):Promise<void>{
    const vault=this.vault,generation=this.vaultGeneration,intent=++this.folderCreationIntent;
    const pane=this.activePane,navigation=this.navigationIntent.get(pane),activation=this.paneActivationRevision,treeTab=this.treeTab,parentToken=parent?this.treeEntryToken(parent):undefined;
    await this.treeRename?.session.commit('blur');
    await createFolderInline({owner:vault,paths:()=>vault.entries.keys(),createFolder:path=>vault.createFolder(path,()=>{
        this.requireAvailableTreePath(vault,path);
        if(parent&&this.vault===vault&&this.treeEntryToken(parent)!==parentToken)throw new Error('The destination folder has changed.');
      }),
      isCurrent:()=>this.vault===vault&&this.vaultGeneration===generation,
      revealAndEdit:path=>{if(intent!==this.folderCreationIntent||this.activePane!==pane||this.navigationIntent.get(pane)!==navigation||this.paneActivationRevision!==activation||this.treeTab!==treeTab)return;this.treeTab='files';let ancestor=parentOf(path);while(ancestor){this.collapsed.delete(ancestor);ancestor=parentOf(ancestor);}this.root.classList.remove('left-hidden');this.renderSidebar();this.saveSession();return this.beginTreeRename(path);}},parent);
  }

  private async beginTreeRename(path:string):Promise<void>{
    const vault=this.vault,generation=this.vaultGeneration;
    await this.treeRename?.session.commit('blur');
    if(this.vault!==vault||generation!==this.vaultGeneration||!vault.entries.has(path))return;
    const current=()=>this.vault===vault&&generation===this.vaultGeneration&&this.treeRename?.session===session;
    const session=new FileTreeRenameSession({name:path.split('/').at(-1)!,isCurrent:current,
      save:async name=>{
        if(!current())return;
        const previous=this.treeRename!.path,token=this.treeEntryToken(previous);
        await this.flush();
        if(!current()||this.treeRename!.path!==previous||this.treeEntryToken(previous)!==token)throw new Error('The item being renamed has changed.');
        const suffix=vault.entries.get(previous)?.type==='file'&&previous.endsWith('.md')&&!name.endsWith('.md')?'.md':'';
        const destination=(parentOf(previous)?parentOf(previous)+'/':'')+name+suffix;
        await vault.rename(previous,destination,()=>{
          if(!current()||this.treeRename!.path!==previous||this.treeEntryToken(previous)!==token)throw new Error('The item being renamed has changed.');
          this.requireAvailableTreePath(vault,destination,previous);
        });
        return destination.split('/').at(-1)!;
      },
      onFinish:reason=>{if(this.treeRename?.session===session){
        const finalPath=this.treeRename.path,ownedFocus=this.treeRows.find(row=>row.path===finalPath)?.element.contains(this.root.ownerDocument.activeElement);
        this.treeRename=undefined;this.renderSidebar();
        if(ownedFocus&&(reason==='enter'||reason==='escape'))this.treeRows.find(row=>row.path===finalPath)?.element.focus();
      }},
      onError:error=>notice(error instanceof Error?error.message:String(error))});
    this.treeRename={path,session};
    const row=this.treeRows.find(row=>row.path===path)?.element,label=row?.querySelector<HTMLElement>('.tree-label');
    if(row&&label)session.attach(row,label);
  }

  private selectTreeRange(path:string):void{
    const paths=this.treeOrder,end=paths.indexOf(path),savedAnchor=paths.indexOf(this.treeSelectionAnchor??path),anchor=savedAnchor<0?end:savedAnchor;
    for(const selected of paths.slice(Math.min(anchor,end),Math.max(anchor,end)+1))this.treeSelection.add(selected);
    if(!this.treeSelectionAnchor)this.treeSelectionAnchor=path;
    this.paintTreeSelection();
  }

  private paintTreeSelection():void{
    for(const row of this.treeRows){const selected=this.treeSelection.has(row.path);row.element.classList.toggle('is-selected',selected);row.element.setAttribute('aria-selected',String(selected));}
  }

  private requireAvailableTreePath(vault:Vault,destination:string,source?:string):void{
    const normalized=destination.normalize('NFC').toLowerCase();
    if([...vault.entries.keys()].some(path=>path!==source&&path.normalize('NFC').toLowerCase()===normalized))throw new Error(`Path already exists: ${destination}`);
  }

  private treeEntryToken(path:string):symbol|undefined{
    if(!this.vault.entries.has(path))return;
    let token=this.entryTokens.get(path);
    if(!token){token=Symbol(path);this.entryTokens.set(path,token);}
    return token;
  }

  private invalidateTreeTokens(path:string):void{
    for(const key of this.entryTokens.keys())if(key===path||key.startsWith(path+'/'))this.entryTokens.delete(key);
  }

  private mountFileTreeDrag():void{
    this.canvasDocumentInput?.destroy();
    this.treeDrag?.destroy();
    this.treeDrag=createFileTreeDrag({root:this.sidebarContent,getEntries:()=>[...this.vault.entries.values()],getRows:()=>this.treeRows,
      getSelectedPaths:()=>[...this.treeSelection],getVaultToken:()=>this.vault,
      getEntryToken:path=>this.treeEntryToken(path),
      enabled:()=>this.treeTab==='files'&&!this.treeRename,
      expandFolder:path=>{this.collapsed.delete(path);this.renderSidebar();this.saveSession();},
      move:async(intent,context)=>{const vault=this.vault;await this.flush();await executeFileTreeMove(intent,{getEntries:()=>[...vault.entries.values()],isCurrent:context.isCurrent,isSourceCurrent:context.isSourceCurrent,
        rename:async(source,destination)=>{if(!context.isCurrent()||!context.isSourceCurrent(source))throw new Error('The file move is no longer current');await vault.rename(source,destination,()=>{
          if(!context.isCurrent()||!context.isSourceCurrent(source))throw new Error('The file move is no longer current');
          this.requireAvailableTreePath(vault,destination,source);
        });}});},
      rootLabel:this.platform.label,onError:error=>notice(error instanceof Error?error.message:String(error))});
    this.canvasDocumentInput=createCanvasDocumentInput({root:this.sidebarContent,getRows:()=>this.treeRows,getEntries:()=>[...this.vault.entries.values()],getSelectedPaths:()=>[...this.treeSelection],getVaultToken:()=>this.vault,getEntryToken:path=>this.treeEntryToken(path),enabled:()=>this.treeTab==='files'&&!this.treeRename});
  }
  private async renameDialog(path:string):Promise<void>{const name=await promptName('Rename',path.split('/').at(-1),'Rename');if(name)await this.renamePath(path,name);}
  private async renamePath(path:string,name:string):Promise<string>{
    if(/[\\/]/.test(name))throw new Error('Use the file menu to move files between folders.');const folder=parentOf(path);const suffix=this.vault.entries.get(path)?.type==='file'&&path.endsWith('.md')&&!name.endsWith('.md')?'.md':'';const next=`${folder?folder+'/':''}${name}${suffix}`;
    if(next===path)return next;await this.flush();const buffer=this.buffers.get(path);if(buffer)await buffer.rename(next);else await this.vault.rename(path,next);for(const pane of this.panes)await this.renderPane(pane);return next;
  }
  private async deletePath(path:string):Promise<void>{await this.flush();await this.vault.trash(path);this.buffers.delete(path);notice('Moved to vault trash.');}
  private async newTab(pane=this.activePane):Promise<void>{await this.flushPane(pane);const tab:Tab={id:makeId(),path:null,mode:this.settings.defaultMode,kind:'note'};pane.tabs.push(tab);pane.active=tab.id;this.run(()=>this.renderPane(pane));this.saveSession();}
  private async closeTab(pane:Pane,tab:Tab):Promise<void>{
    if(!pane.tabs.includes(tab))return;
    const owner=pane.viewTabId===tab.id?pane:this.cachedViews.get(tab);
    if(owner)await this.disposePaneViews(owner);else if(tab.path)await this.buffers.get(tab.path)?.flush();
    if(!this.panes.includes(pane))return;
    const index=pane.tabs.indexOf(tab);if(index<0)return;
    this.cachedViews.delete(tab);pane.tabs.splice(index,1);
    if(!pane.tabs.length){
      if(this.panes.length>1){this.panes=this.panes.filter(p=>p!==pane);this.splitLayout?.remove(pane.id);if(this.activePane===pane){this.activate(this.panes[0]);this.focusPane(this.panes[0]);}this.saveSession();return;}
      pane.tabs.push({id:makeId(),path:null,mode:this.settings.defaultMode,kind:'note'});
    }
    if(tab.id===pane.active)pane.active=pane.tabs[Math.min(index,pane.tabs.length-1)].id;
    await this.renderPane(pane);this.saveSession();this.renderRight();
  }
  private async navigate(delta:number,pane:Pane):Promise<void>{const index=pane.historyIndex+delta;if(index<0||index>=pane.history.length)return;pane.historyIndex=index;this.current(pane).historyIndex=index;await this.openNote(pane.history[index],false,pane,false);}
  private async toggleReading(pane=this.activePane):Promise<void>{const tab=this.current(pane);if(tab.path&&!isMarkdown(tab.path))return;await this.flushPane(pane);tab.mode=tab.mode==='reading'?this.settings.defaultMode:'reading';await this.renderPane(pane);this.saveSession();}
  private async followLink(source:string,target:string,pane:Pane,kind:'wiki'|'markdown'='wiki'):Promise<void>{if(/^[a-z][\w+.-]*:/i.test(target)||target.startsWith('//')){if(/^(?:https?:\/\/|mailto:)/i.test(target))window.open(target,'_blank','noopener,noreferrer');return;}const resolved=this.vault.metadata.resolveLink(source,target,kind);if(resolved){await this.openNote(resolved,false,pane,true,target.includes('#')?target.slice(target.indexOf('#')):'');return;}const path=target.split('#')[0].replace(/\.md$/,'')+'.md';if(!path||path==='.md')return;const parent=parentOf(path);if(parent&&!this.vault.entries.has(parent))throw new Error(`Folder does not exist: ${parent}`);await this.vault.create(path,'');await this.openNote(path,false,pane);}
  private async dailyNote():Promise<void>{const now=new Date();const name=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}.md`;if(!this.vault.entries.has(name))await this.vault.create(name,'');await this.openNote(name);}
  private async split(edge:'right'|'bottom'='right',source=this.activePane,tab=this.current(source)):Promise<void>{
    const generation=this.vaultGeneration;
    await this.flushPane(source);
    if(generation!==this.vaultGeneration||!this.panes.includes(source)||!source.tabs.includes(tab))return;
    this.capturePaneState(source);
    const pane=this.addPane([{...tab,id:makeId(),viewState:tab.viewState?structuredClone(tab.viewState):undefined}]);
    if(!this.splitLayout?.split(source.id,pane.id,pane.element,edge)){this.panes=this.panes.filter(item=>item!==pane);pane.element.remove();return;}
    this.activate(pane);await this.renderPane(pane);if(generation!==this.vaultGeneration||!this.panes.includes(pane))return;this.focusPane(pane);this.saveSession();
  }
  private toggleLeft():void{this.root.classList.toggle('left-hidden');this.saveSession();}
  private toggleRight():void{this.root.classList.toggle('right-hidden');this.saveSession();}

  private async newWindow():Promise<void>{
    const native=workspaceWindowBridge(window.zorid);
    if(!native)throw new Error('Additional windows require the desktop app.');
    await native.newWindow();
  }

  private commands():Command[]{
    return WORKSPACE_HOTKEY_COMMANDS.filter(command=>command.id!=='new-window'||workspaceWindowBridge(window.zorid)).map(command=>({
      id:command.id,name:command.name,shortcut:this.hotkeys.label(command.id),action:()=>this.executeHotkey(command.id),
    }));
  }
  private syncNativeHotkeys():void{
    void window.zorid?.setMenuHotkeys?.(['new-window','close-tab'].map(id=>({id:id as 'new-window'|'close-tab',shortcut:this.hotkeys.label(id)}))).catch(error=>notice(error instanceof Error?error.message:String(error)));
  }
  private hotkeyButton(glyph:string,id:string,label:string,action:(event:MouseEvent)=>void,className=''):HTMLButtonElement{
    const node=button(glyph,label,action,className);
    // Keep the originating note/table selection alive until the palette captures it.
    if(id==='command-palette')node.addEventListener('pointerdown',event=>{if(event.button===0)event.preventDefault();});
    node.dataset.hotkeyCommand=id;node.dataset.hotkeyName=label;this.updateHotkeyLabel(node);return node;
  }
  private updateHotkeyLabel(node:HTMLElement):void{
    const hint=this.hotkeys.label(node.dataset.hotkeyCommand!);
    if(node.tagName==='KBD'){node.textContent=hint;node.hidden=!hint;return;}
    const label=node.dataset.hotkeyName!+(hint?` (${this.hotkeys.platform==='mac'?hint.replaceAll(' ',''):hint})`:'');node.title=label;node.setAttribute('aria-label',label);
  }
  private refreshHotkeyLabels():void{
    const roots=new Set<HTMLElement>([this.root,...this.loadedViews().flatMap(pane=>pane.content?[pane.content]:[])]);
    for(const root of roots)for(const node of root.querySelectorAll<HTMLElement>('[data-hotkey-command]'))this.updateHotkeyLabel(node);
  }
  private executeHotkey(id:string):void{
    if(this.closing)return;
    if(id==='new-window'){if(workspaceWindowBridge(window.zorid))this.run(()=>this.newWindow());return;}
    if(!this.vault)return;
    if(id.startsWith('tab-')){
      const number=Number(id.slice(4));if(number!==9&&matchMedia('(max-width: 700px)').matches)return;
      const pane=this.activePane,tab=pane.tabs[number===9?pane.tabs.length-1:number-1],generation=this.vaultGeneration,previousActive=pane.active,previousPath=this.current(pane)?.path,version=pane.renderVersion,activation=this.paneActivationRevision;
      const request=(this.navigationIntent.get(pane)??0)+1;this.navigationIntent.set(pane,request);
      if(tab)this.run(async()=>{
        if(request!==this.navigationIntent.get(pane)||activation!==this.paneActivationRevision)return;
        if(pane.active===tab.id){this.focusPane(pane);return;}
        await this.flushPane(pane);
        if(request!==this.navigationIntent.get(pane)||generation!==this.vaultGeneration||!this.panes.includes(pane)||!pane.tabs.includes(tab)||pane.active!==previousActive||this.current(pane)?.path!==previousPath||pane.renderVersion!==version||activation!==this.paneActivationRevision)return;
        pane.active=tab.id;this.activate(pane);await this.renderPane(pane);
        if(request===this.navigationIntent.get(pane)&&pane.active===tab.id&&activation===this.paneActivationRevision)this.focusPane(pane);this.saveSession();
      });return;
    }
    const actions:Record<string,()=>unknown|Promise<unknown>>={
      'new-note':()=>this.newNote(),'new-tab':()=>this.newTab(),'close-tab':()=>this.closeTab(this.activePane,this.current()),save:()=>this.flush(),
      'quick-switcher':()=>this.quickSwitcher(),'command-palette':()=>this.commandPalette(),settings:()=>this.showSettings(),'toggle-reading':()=>this.toggleReading(),
      'split-right':()=>this.split(),'split-down':()=>this.split('bottom'),'toggle-left':()=>this.toggleLeft(),'toggle-right':()=>this.toggleRight(),
      'search-all':()=>{this.treeTab='search';this.root.classList.remove('left-hidden');this.renderSidebar();this.sidebarContent.querySelector<HTMLInputElement>('input')?.focus();},
      'daily-note':()=>this.dailyNote(),graph:()=>this.openGraph(),'new-folder':()=>this.newFolder(),'open-vault':()=>this.chooseVault(),
    };
    if(actions[id])this.run(actions[id]);
  }

  commandPalette():void{
    const pane=this.activePane,tab=pane&&this.current(pane),editor=pane?.editor;
    const generation=this.vaultGeneration,activation=this.paneActivationRevision,version=pane?.renderVersion;
    const runtime=pane?.runtime,path=tab?.path,navigation=pane&&this.navigationIntent.get(pane),entry=path?this.treeEntryToken(path):undefined;
    const ownership=runtime?.captureOwnership();
    const valid=()=>this.initialized&&generation===this.vaultGeneration&&activation===this.paneActivationRevision
      &&this.activePane===pane&&this.panes.includes(pane)&&this.current(pane)===tab&&pane.editor===editor
      &&pane.renderVersion===version&&pane.runtime===runtime&&runtime?.phase==='active'&&!!ownership&&runtime.isCurrent(ownership)&&pane.content?.isConnected===true
      &&tab?.path===path&&tab?.mode==='live'&&tab?.kind==='note'&&!!path&&isMarkdown(path)
      &&this.navigationIntent.get(pane)===navigation&&entry!==undefined&&this.treeEntryToken(path)===entry&&this.vault.entries.get(path)?.type==='file';
    const target=valid()?editor?.captureCommandTarget?.(valid):null;
    this.suggest('Type a command…',()=>[
      ...this.commands(),
      ...(target?EDITOR_HOTKEY_COMMANDS.map(command=>({id:command.id,name:command.name,shortcut:this.hotkeys.label(command.id),action:()=>{target.run(command.id);}})):[]),
    ],()=>target?.dispose());
  }
  quickSwitcher():void{this.suggest('Type a file name…',()=>[...this.vault.entries.values()].filter(entry=>entry.type==='file').map(entry=>({name:nameOf(entry.path),shortcut:parentOf(entry.path),action:()=>this.openNote(entry.path)})));}
  private suggest(placeholder:string,getCommands:()=>Command[],onDismiss?:()=>void):void{
    const{content,close}=modal(placeholder);content.classList.add('command-modal');const input=el('input','command-input');input.placeholder=placeholder;input.setAttribute('aria-label',placeholder);input.setAttribute('role','combobox');input.setAttribute('aria-expanded','true');input.setAttribute('aria-controls','suggestion-list');
    const list=el('div','suggestion-list');list.id='suggestion-list';list.role='listbox';let selected=0,items:Command[]=[];
    let executing=false,finished=false;
    const finish=()=>{if(finished)return;finished=true;observer.disconnect();onDismiss?.();};
    const observer=new MutationObserver(()=>{if(!content.isConnected&&!executing)finish();});
    observer.observe(content.ownerDocument.body,{childList:true,subtree:true});
    const execute=()=>{const item=items[selected];if(item&&!executing&&!finished){executing=true;close();this.run(async()=>{try{await item.action();}finally{finish();}});}};
    const render=()=>{items=getCommands().filter(item=>item.name.toLocaleLowerCase().includes(input.value.toLocaleLowerCase())).slice(0,80);selected=Math.min(selected,Math.max(0,items.length-1));list.replaceChildren();items.forEach((item,index)=>{const row=el('div',`suggestion${index===selected?' is-selected':''}`);row.role='option';row.id=`suggestion-${index}`;row.setAttribute('aria-selected',String(index===selected));row.append(el('span','',item.name));if(item.shortcut)row.append(el('kbd','suggestion-shortcut',item.shortcut));row.onpointermove=()=>{selected=index;list.querySelectorAll('.suggestion').forEach((node,i)=>node.classList.toggle('is-selected',i===selected));};row.onclick=()=>{selected=index;execute();};list.append(row);});input.setAttribute('aria-activedescendant',`suggestion-${selected}`);if(!items.length)list.append(el('div','suggestion muted','No results found.'));};
    input.oninput=()=>{selected=0;render();};input.onkeydown=event=>{if(event.isComposing||event.keyCode===229)return;if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();selected=(selected+(event.key==='ArrowDown'?1:Math.max(0,items.length-1)))%Math.max(1,items.length);render();list.children[selected]?.scrollIntoView({block:'nearest'});}if(event.key==='Enter'){event.preventDefault();execute();}};
    content.append(input,list,el('div','command-footer','↑↓ to navigate  ↵ to open  esc to dismiss'));render();input.focus();
  }

  private menu(items:{name:string;action:()=>void|Promise<void>}[],x=window.innerWidth/2,y=100,valid=()=>true):void{
    const generation=this.vaultGeneration,serial=++this.menuSerial;
    const pending=showContextMenu({clientX:x,clientY:y},items.map((item,index)=>({id:`action-${index}`,label:item.name})),{document:this.root.ownerDocument});
    this.run(async()=>{
      const id=await pending;
      if(!id||generation!==this.vaultGeneration||serial!==this.menuSerial||!this.initialized||!valid())return;
      const match=/^action-(\d+)$/.exec(id);if(match)await items[Number(match[1])]?.action();
    });
  }
  private fileMenu(entry:VaultEntry,x:number,y:number,inlineRename=false):void{const folder=entry.type==='folder';this.menu([
    ...(folder?[{name:'New note',action:()=>this.newNote(entry.path)},{name:'New folder',action:()=>this.newFolder(entry.path)}]:[{name:'Open in new tab',action:()=>this.openNote(entry.path,true)},{name:this.bookmarks.has(entry.path)?'Remove bookmark':'Bookmark',action:()=>{if(this.bookmarks.has(entry.path))this.bookmarks.delete(entry.path);else this.bookmarks.add(entry.path);this.saveSession();this.renderSidebar();}}]),
    {name:'Rename…',action:()=>inlineRename?this.beginTreeRename(entry.path):this.renameDialog(entry.path)}, {name:'Move to trash',action:()=>this.deletePath(entry.path)},
  ],x,y,()=>this.vault.entries.get(entry.path)===entry);}
  private tabMenu(pane:Pane,tab=this.current(pane),x?:number,y?:number):void{
    this.activate(pane);
    const markdown=tab.kind==='note'&&(!tab.path||isMarkdown(tab.path));
    const modes:Command[]=markdown?(['reading','live'] as const).map((mode,index)=>({
      name:['Reading view','Live Edit'][index],
      action:async()=>{tab.mode=mode;pane.active=tab.id;await this.renderPane(pane);this.saveSession();},
    })):[];
    const path=tab.path;
    this.menu([{name:'Split right',action:()=>this.split('right',pane,tab)},{name:'Split down',action:()=>this.split('bottom',pane,tab)},...modes,...(path?[{name:'Rename…',action:()=>this.renameDialog(path)}]:[]),{name:'Close tab',action:()=>this.closeTab(pane,tab)}],x,y,()=>this.panes.includes(pane)&&pane.tabs.includes(tab)&&tab.path===path);
  }
  private menuPoint(event:MouseEvent):{x:number;y:number}{
    if(event.type!=='contextmenu'&&event.currentTarget instanceof HTMLElement){const bounds=event.currentTarget.getBoundingClientRect();return{x:bounds.left,y:bounds.bottom};}
    return{x:event.clientX,y:event.clientY};
  }
  private tabMenuAt(pane:Pane,anchor:HTMLElement):void{
    const bounds=anchor.getBoundingClientRect();this.tabMenu(pane,this.current(pane),bounds.left,bounds.bottom);
  }
  private modeMenu(anchor:HTMLElement):void{this.tabMenuAt(this.activePane,anchor);}

  private async openGraph():Promise<void>{await this.flushPane(this.activePane);const tab:Tab={id:makeId(),path:null,mode:'reading',kind:'graph'};this.activePane.tabs.push(tab);this.activePane.active=tab.id;this.run(()=>this.renderPane(this.activePane));this.saveSession();}
  private renderGraph(parent:HTMLElement):void{
    const container=el('div','graph-view');const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 800 600');svg.setAttribute('aria-label','Graph of linked notes');
    const files=[...this.vault.entries.values()].filter(e=>e.type==='file'&&e.path.endsWith('.md'));
    const points=new Map(files.map((entry,index)=>[entry.path,{x:400+Math.cos(index/Math.max(1,files.length)*Math.PI*2)*Math.min(260,60+files.length*12),y:300+Math.sin(index/Math.max(1,files.length)*Math.PI*2)*Math.min(220,60+files.length*10)}]));
    for(const entry of files){const from=points.get(entry.path)!;for(const link of this.vault.metadata.get(entry.path)?.links||[]){const resolved=this.vault.metadata.resolveLink(entry.path,link.target,link.kind);const to=resolved?points.get(resolved):null;if(!to)continue;const line=document.createElementNS(svg.namespaceURI,'line');for(const[k,v]of Object.entries({x1:from.x,y1:from.y,x2:to.x,y2:to.y}))line.setAttribute(k,String(v));svg.append(line);}}
    for(const entry of files){const point=points.get(entry.path)!;const group=document.createElementNS(svg.namespaceURI,'g');group.setAttribute('tabindex','0');group.setAttribute('role','link');group.setAttribute('aria-label',nameOf(entry.path));const circle=document.createElementNS(svg.namespaceURI,'circle');circle.setAttribute('cx',String(point.x));circle.setAttribute('cy',String(point.y));circle.setAttribute('r','6');const label=document.createElementNS(svg.namespaceURI,'text');label.setAttribute('x',String(point.x));label.setAttribute('y',String(point.y+23));label.textContent=nameOf(entry.path);group.append(circle,label);group.addEventListener('click',()=>this.run(()=>this.openNote(entry.path)));group.addEventListener('keydown',event=>{if((event as KeyboardEvent).key==='Enter')this.run(()=>this.openNote(entry.path));});svg.append(group);}container.append(svg);if(!files.length)container.append(el('p','graph-empty','Create notes and links to see them here.'));parent.append(container);
  }

  showSettings():void{
    const{content,close}=modal('Settings');content.classList.add('settings-modal');const nav=el('nav','settings-nav');const body=el('div','settings-content');const closeButton=button('close','Close settings',close,'settings-close');content.append(nav,body,closeButton);
    const render=(section:string)=>{
      this.hotkeySettings?.destroy();this.hotkeySettings=undefined;nav.querySelectorAll('button').forEach(node=>node.classList.toggle('is-active',node.textContent===section));body.replaceChildren(el('h2','',section));
      const row=(name:string,description:string,control:HTMLElement)=>{const wrapper=el('div','setting-row');const info=el('div','setting-info');info.append(el('div','setting-name',name),el('div','setting-description',description));wrapper.append(info,control);body.append(wrapper);};
      const toggle=(checked:boolean,change:(value:boolean)=>void)=>{const input=el('input','toggle');input.type='checkbox';input.checked=checked;input.onchange=()=>{change(input.checked);this.saveSettings();};return input;};
      const selectControl=(name:string,value:string,choices:readonly(readonly[string,string])[],change:(value:string)=>void)=>{
        const select=el('select');select.setAttribute('aria-label',name);
        for(const[key,label]of choices){const option=el('option','',label);option.value=key;select.append(option);}
        select.value=value;select.onchange=()=>{change(select.value);this.saveSettings();};return select;
      };
      const configureLists=()=>{for(const pane of this.loadedViews())pane.editor?.configureLists?.({useTab:this.settings.useTab,tabSize:this.settings.tabSize,smartIndentList:this.settings.smartIndentList});for(const buffer of this.buffers.values())this.bufferSubscriptions.publish(buffer,true);};
      if(section==='Appearance'){
        const select=el('select');for(const[label,value]of[['Adapt to system','system'],['Dark','dark'],['Light','light']]){const option=el('option','',label);option.value=value;select.append(option);}select.value=this.settings.theme;select.setAttribute('aria-label','Base color scheme');select.onchange=()=>{this.settings.theme=select.value as Settings['theme'];this.saveSettings();};row('Base color scheme','Choose your default color scheme.',select);
        const size=el('input');size.type='range';size.min='12';size.max='26';size.value=String(this.settings.fontSize);size.setAttribute('aria-label','Font size');size.oninput=()=>{this.settings.fontSize=Number(size.value);this.saveSettings();};row('Font size','Font size in pixels for the editor and reading view.',size);
        const title=toggle(this.settings.showInlineTitle,value=>{this.settings.showInlineTitle=value;this.panes.forEach(pane=>this.run(()=>this.renderPane(pane)));});title.setAttribute('aria-label','Show inline title');row('Show inline title','Display the file name at the top of each note.',title);
      }else if(section==='Editor'){
        const width=toggle(this.settings.readableWidth,value=>{this.settings.readableWidth=value;this.panes.forEach(pane=>this.run(()=>this.renderPane(pane)));});width.setAttribute('aria-label','Readable line length');row('Readable line length','Limit the maximum line length for comfortable reading.',width);
        const html=toggle(this.settings.autoConvertHtml,value=>{this.settings.autoConvertHtml=value;});html.setAttribute('aria-label','Auto convert HTML');row('Auto convert HTML','Convert pasted HTML into Markdown.',html);
        const tabs=toggle(this.settings.useTab,value=>{this.settings.useTab=value;configureLists();});tabs.setAttribute('aria-label','Indent using tabs');row('Indent using tabs','Use tab characters for indentation. Turn off to use spaces.',tabs);
        const tabSize=el('input');tabSize.type='number';tabSize.min='1';tabSize.max='32';tabSize.value=String(this.settings.tabSize);tabSize.setAttribute('aria-label','Tab size');
        tabSize.onchange=()=>{const value=Number(tabSize.value);if(!Number.isInteger(value)||value<1||value>32){tabSize.value=String(this.settings.tabSize);return;}this.settings.tabSize=value;configureLists();this.saveSettings();};row('Tab size','Number of spaces used to display a tab.',tabSize);
        const smart=toggle(this.settings.smartIndentList,value=>{this.settings.smartIndentList=value;configureLists();});smart.setAttribute('aria-label','Smart indent lists');row('Smart indent lists','Continue list items when pressing Enter.',smart);
      }else if(section==='Hotkeys'){this.hotkeySettings=mountHotkeySettings(body,this.hotkeys,()=>{this.refreshHotkeyLabels();this.syncNativeHotkeys();});}
      else if(section==='Files and links'){
        row('Vault',this.platform.label,textButton('Open another',()=>{close();this.run(()=>this.chooseVault());}));if(this.platform.legacyExport)row('Previous browser vault','Download the original preview vault and retained drafts. The originals stay on this device.',textButton('Export previous browser vault',()=>this.platform.legacyExport!()));row('Deleted files','Deleted files are moved to a .trash folder in the vault.',el('span','','Vault trash'));row('Internal links','Resolved links are updated when files are renamed.',el('span','','Automatic'));
        const wiki=toggle(!this.settings.useMarkdownLinks,value=>{this.settings.useMarkdownLinks=!value;});wiki.setAttribute('aria-label','Use Wikilinks');row('Use Wikilinks','Use [[links]] for imported attachments.',wiki);
        row('New link format','Choose how paths are written for imported attachments.',selectControl('New link format',this.settings.newLinkFormat,[['shortest','Shortest path when possible'],['relative','Relative path to file'],['absolute','Absolute path in vault']],value=>{this.settings.newLinkFormat=value as Settings['newLinkFormat'];}));
        const folder=this.settings.attachmentFolderPath;
        const location=folder==='/'?'root':folder==='.'||folder==='./'?'current':folder.startsWith('./')?'subfolder':'folder';
        row('Default location for new attachments','Choose where pasted and dropped files are saved.',selectControl('Default location for new attachments',location,[['root','Vault folder'],['folder','In the folder specified below'],['current','Same folder as current file'],['subfolder','In subfolder under current folder']],value=>{
          this.settings.attachmentFolderPath=value==='root'?'/':value==='current'?'.':value==='subfolder'?'./attachments':'attachments';render(section);
        }));
        if(location==='folder'||location==='subfolder'){
          const path=el('input');path.value=location==='subfolder'?folder.slice(2):folder;path.setAttribute('aria-label','Attachment folder path');
          path.onchange=()=>{this.settings.attachmentFolderPath=location==='subfolder'?'./'+path.value:path.value;this.saveSettings();};row('Attachment folder path','A folder will be created if it does not exist.',path);
        }
      }
      else{body.append(el('p','','Zorid'),el('p','muted','Version 0.1.0'),el('p','','An open-source Markdown workspace.'));}
    };
    nav.append(el('div','settings-nav-label','Options'));for(const name of['Editor','Files and links','Appearance','Hotkeys','About'])nav.append(textButton(name,()=>render(name),'settings-nav-item'));render('Editor');
  }
  private applySettings():void{const theme=this.settings.theme==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):this.settings.theme;document.documentElement.dataset.theme=theme;document.documentElement.style.setProperty('--font-text-size',`${this.settings.fontSize}px`);}
  private saveSettings():void{localStorage.setItem('zorid:settings',JSON.stringify(this.settings));this.applySettings();}
  private saveSession():void{if(!this.platform||this.restoringLayout)return;this.panes.forEach(pane=>this.capturePaneState(pane));localStorage.setItem(this.sessionKey(),JSON.stringify({...this.sessionState,rightHidden:this.root.classList.contains('right-hidden'),leftHidden:this.root.classList.contains('left-hidden'),autoRevealFiles:this.autoRevealFiles,layout:this.splitLayout?.serialize(),activePaneId:this.activePane?.id,panes:this.panes.map(p=>({...p.persisted,id:p.id,tabs:p.tabs,active:p.tabs.findIndex(t=>t.id===p.active)})),collapsed:[...this.collapsed],bookmarks:[...this.bookmarks]}));}
  private help():void{const{content}=modal('Help');content.append(el('h2','','Get started'),el('p','',`Link to another note with [[note name]]. Customize workspace shortcuts in Settings → Hotkeys. Create note: ${this.hotkeys.label('new-note')||'not assigned'}. Find file: ${this.hotkeys.label('quick-switcher')||'not assigned'}. Command palette: ${this.hotkeys.label('command-palette')||'not assigned'}.`));
  }
  private hotkeySurfaceBlocked(): boolean {
    return this.startupFailed||this.closing||!!document.querySelector('.modal-overlay,[aria-modal="true"],[role="menu"]');
  }
  private onKey(event:KeyboardEvent):void{
    if(event.defaultPrevented||event.isComposing||event.getModifierState('AltGraph')||this.hotkeySurfaceBlocked())return;
    let id=this.hotkeys.resolve(event);
    // Retain legacy virtual-key defaults for non-US numbered keys, without
    // reviving a command whose default binding was explicitly changed/removed.
    if(!id){
      const legacy=resolveWorkspaceShortcut(event,{platform:this.hotkeys.platform,tabCount:this.activePane?.tabs.length??0,canOpenWindow:!!workspaceWindowBridge(window.zorid)});
      if(legacy.handled){
        const logical=/^[1-9]$/.test(event.key)?Number(event.key):0,code=event.which||event.keyCode||0,virtual=Number.isInteger(code)&&code>=49&&code<=57?code-48:0;
        const digit=logical&&virtual?Math.min(logical,virtual):logical||virtual;
        const candidate=digit?`tab-${digit}`:legacy.action?.type==='new-file'?'new-note':legacy.action?.type==='new-tab'?'new-tab':legacy.action?.type==='new-window'?'new-window':null;
        if(candidate&&!this.hotkeys.customized(candidate)&&this.hotkeys.bindings(candidate).every(binding=>!this.hotkeys.conflicts(candidate,binding).length))id=candidate;
      }
    }
    if(id){event.preventDefault();event.stopPropagation();this.executeHotkey(id);return;}
    // PDF search remains a focused-view command, sharing the editor's reserved
    // primary-F chord rather than becoming a global configurable command.
    const primary=this.hotkeys.platform==='mac'?event.metaKey&&!event.ctrlKey:event.ctrlKey&&!event.metaKey;
    if(primary&&!event.shiftKey&&!event.altKey&&!event.repeat&&event.key.toLowerCase()==='f'&&this.activePane?.pdfView){event.preventDefault();this.activePane.pdfView.showSearch();}
  }
  private async flushPane(pane:Pane):Promise<void>{await pane.baseEmbeds?.flush();await pane.baseView?.flush();await pane.canvasView?.flush();const path=this.current(pane)?.path;if(path)await this.buffers.get(path)?.flushForNavigation();}
  async flush():Promise<void>{if(this.platformReleased||this.platformDrained)return;for(const pane of [...this.panes,...this.cachedViews.values()]){await pane.baseEmbeds?.flush();await pane.baseView?.flush();await pane.canvasView?.flush();}for(const buffer of this.buffers.values())await buffer.flush();}
  async destroy():Promise<void>{this.vaultRequest++;await this.vaultTransition;this.menuSerial++;await dismissContextMenu(this.root.ownerDocument);await this.flush();this.saveSession();this.disposers.forEach(dispose=>dispose());clearTimeout(this.reloadTimer);this.tabDocking?.destroy();this.tabDocking=undefined;await this.clearCachedViews();for(const pane of this.panes)await this.disposePaneViews(pane);for(const buffer of this.buffers.values())await buffer.dispose();if(!this.platformReleased)await this.platform?.release?.();this.platformReleased=true;this.vaultGeneration++;this.splitLayout?.destroy();this.splitLayout=undefined;this.attachments?.destroy();this.canvasDocumentInput?.destroy();this.canvasDocumentInput=undefined;this.treeDrag?.destroy();this.treeDrag=undefined;this.treeRename?.session.dispose();this.treeRename=undefined;this.hotkeyCleanup?.();this.hotkeyCleanup=undefined;document.removeEventListener('keydown',this.keyListener);document.removeEventListener('contextmenu',this.inputContextListener);window.removeEventListener('beforeunload',this.unloadListener);this.initialized=false;this.closeCleanup?.();this.closeCleanup=undefined;this.disposeShell();this.root.replaceChildren();}
}
