import type {TasksView} from '../tasks/view.ts';
import type {TasksHost, TaskCaptureRequest} from '../tasks/controller.ts';
import type {TaskPreset} from '../tasks/presets.ts';
import {planTaskPreset} from '../tasks/presets.ts';
import {readProperties, setProperty, removeProperty} from '../core/properties.ts';
import type {CalendarView, CalendarViewState} from '../calendar/view.ts';
import { mountDocumentSearch, initialDocumentSearchSpec } from './document-search-controller.ts';
import type { DocumentSearchController } from './document-search-controller.ts';
import type { SearchLocation, SearchSpec } from '../core/document-search-types.ts';
import type { DocumentEntry } from '../core/document-semantics.ts';
import type { CommittedMetadataFrame, CommittedMetadataState } from '../core/committed-metadata-frame.ts';
import { mountDocumentBacklinks } from './document-backlinks.ts';
import { catchUpDocumentIndex, documentErrorCode, DocumentSemanticsError } from '../core/document-semantics.ts';
import type { DocumentCursor, DocumentPin, DocumentService, DocumentSnapshotId, DocumentSourceId, DocumentTaskWitness } from '../core/document-semantics.ts';
import { openVersionHistory } from './version-history.ts';
import { mountImportStatus } from './import-status.ts';
import { createReadingFind } from './reading-find.ts';
import type { ReadingFind } from './reading-find.ts';
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
import { Vault } from '../core/index.ts';
import type { VaultEntry } from '../core/index.ts';
import { pickDesktopVault, createPlatformAdapter } from '../platform/index.ts';
import type { PlatformVault } from '../platform/index.ts';
import type {NativeDocumentOpenRequest,NativeDocumentNavigation} from '../platform/mobile-native.ts';
import { el, icon, button, textButton, modal, notice, promptName } from './dom.ts';
import { renderMarkdown } from './markdown.ts';
import { destroyMarkdown } from './markdown-lifecycle.ts';
import type { EditorHandle, EditorOptions, EditorViewState, NativeEditorState } from './editor.ts';
import { NoteBuffer } from './note-buffer.ts';
import { createCanvasMarkdownBufferSession, NoteBufferSubscriptions } from './canvas-markdown-session.ts';
import type { CanvasMarkdownBufferSession } from './canvas-markdown-session.ts';
import { MarkdownEmbeds } from './embeds.ts';
import { renderProperties } from './properties.ts';
import type { PropertiesView } from './properties.ts';
import { AttachmentResources, isImage } from './attachments.ts';
import type {AttachmentLease} from './attachments.ts';
import { createImageView } from './image-view.ts';
import type { ImageView } from './image-view.ts';
import { isMarkdown, normalizePath } from '../core/types.ts';
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
import {openBaseNewItemPopover} from './base-new-item-popover.ts';
import type {BaseNewItemPopoverHandle} from './base-new-item-popover.ts';
import {createBaseFileHover} from './base-file-hover.ts';
import {baseFileHoverAnchor} from '../bases/file-hover.ts';
import type {BaseFileHoverTarget,BaseFileHoverContent} from './base-file-hover.ts';
import {createNotePropertyTargets} from './note-property-targets.ts';
import type {NotePropertyTargets} from './note-property-targets.ts';
import type {DatabaseRequest} from '../core/databases.ts';
import {collectionValue,mountCollectionBrowser} from '../databases/collection-ui.ts';
import {newBaseViewId} from '../bases/document.ts';
import {inlineBaseRequest,replaceInlineBaseSource} from '../bases/inline-base.ts';
import type {InlineBaseRequest} from '../bases/inline-base.ts';
import {sharedBaseWitness} from '../bases/shared-query.ts';
import {prepareBaseFileCreation} from '../bases/creation.ts';
import type {BaseCreationOperation} from '../bases/creation.ts';
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

interface DocumentSearchOwner {
  vault:Vault; service:DocumentService; released:boolean; runs:number;
  pins:Set<DocumentPin>; closing:Map<DocumentPin,Promise<void>>; acquisition:Promise<void>;
}
type Mode = 'live' | 'reading';
interface SidebarBaseContext { path:string|null; entryId?:string; token?:symbol }
interface SidebarBaseState {
  path:string;session:BaseSession;host:HTMLElement;context:string|null;contextEntryId?:string;
  pinned:boolean;pinnedContext?:SidebarBaseContext;pinning?:Promise<void>;closing?:Promise<void>;
  following?:{context:SidebarBaseContext;retryOnFinish:boolean};failedContext?:SidebarBaseContext;
}
interface Tab {
  id:string; path:string|null; expectedEntryId?:string; mode:Mode; kind:'note'|'graph'|'calendar'|'tasks'; subpath?:string; calendarState?:CalendarViewState;
  /** Standalone .base source editing only; never a Markdown/embedded mode. */
  baseSource?:boolean;
  history?:string[]; historyIndex?:number;
  viewState?:{editor?:EditorViewState;scrollTop:number;scrollLeft:number};
}
// Visible panes mirror one loaded tab. A parked record keeps those resources and
// mutable callback ownership while its wrapper is detached; it is never serialized.
interface Pane {
  id:string; tabs:Tab[]; active:string; element:HTMLElement;
  content?:HTMLElement; runtime?:TabViewRuntime; rebindView?:(pane:Pane)=>void;
  viewReady?:boolean; viewMode?:Mode; viewKind?:Tab['kind']; viewSettings?:string; viewBaseSource?:boolean;
  viewTabId?:string; viewPath?:string|null; renderVersion:number;
  editor?:EditorHandle; imageView?:ImageView; pdfView?:PdfView; mediaView?:MediaView; canvasView?:CanvasView; baseView?:BaseSession;
  calendarView?:CalendarView; tasksView?:TasksView;
  canvasSource?:string; baseEmbeds?:BaseEmbedSessions; embeds?:MarkdownEmbeds; properties?:PropertiesView;
  propertyTimer?:ReturnType<typeof setTimeout>; refreshPreview?:()=>void; readingFind?:ReadingFind;
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
  private collectionPropertyRequests=new WeakMap<NoteBuffer,Map<string,DatabaseRequest>>();
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
  private documentBacklinks?: ReturnType<typeof mountDocumentBacklinks>;
  private documentBacklinksGeneration = 0;
  private metadataSubscription?: {vault:Vault;stop:()=>void};
  private retiredMetadataVaults = new Set<Vault>();
  private metadataOpenings = new Set<Promise<void>>();
  private metadataGraphs = new WeakMap<HTMLElement,{vault:Vault;frame:CommittedMetadataFrame|null;container:HTMLElement;status:HTMLElement}>();
  private status = el('footer', 'status-bar');
  private nativeDocumentStatus?:HTMLElement;
  private nativeRecoveryBusy=new WeakSet<NoteBuffer>();
  private treeTab: 'files' | 'search' | 'bookmarks' = 'files';
  private rightTab: 'backlinks' | 'outline' | 'tags' | 'base' = 'backlinks';
  private sidebarBase?:SidebarBaseState;
  private sidebarBaseIntent=0;
  private sidebarBasePath?:string;
  private sidebarPinnedContext?:SidebarBaseContext;
  private sidebarBasePinButton?:HTMLButtonElement;
  private baseNewItem?:BaseNewItemPopoverHandle;
  /** Stable initiating host; popover positioning keeps its separate button anchor. */
  private baseNewItemAnchor?:HTMLElement;
  private baseNewItemOpening?:Promise<void>;
  private notePropertyQueries=new Set<{vault:Vault;session:NotePropertyTargets}>();
  private pendingBaseCreation?:{vault:Vault;generation:number;folder:string;preparing:Promise<BaseCreationOperation>;operation?:BaseCreationOperation};
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
  private documentSearchFreshness?: AbortController;
  private documentSearchSuspended = false;
  private documentSearchOwners = new Set<DocumentSearchOwner>();
  private richDocumentSearch?:{vault:Vault;service:DocumentService;controller?:DocumentSearchController};
  private richDocumentSearchOwners=new Set<{vault:Vault;controller:DocumentSearchController}>();
  private richSearchSpec:SearchSpec=initialDocumentSearchSpec;
  private reverseSort = false;
  private autoRevealFiles = false;
  private disposers: (() => void)[] = [];
  private keyListener = (event: KeyboardEvent) => this.onKey(event);
  private unloadListener = (event: BeforeUnloadEvent) => {
    try{this.saveSession();}catch{/* Storage failure must not bypass the dirty-document unload guard. */}
    if (this.hasPendingBaseCreation() || this.baseNewItemOpening || this.baseNewItem?.hasPendingChanges() || this.sidebarBase?.session.hasPendingChanges() || [...this.buffers.values()].some(buffer => buffer.dirty) || [...this.panes,...this.cachedViews.values()].some(pane => pane.properties?.hasPendingChanges() || pane.tasksView?.hasPendingChanges() || pane.calendarView?.hasPendingChanges() || pane.canvasView?.hasPendingChanges() || pane.baseView?.hasPendingChanges() || pane.baseEmbeds?.hasPendingChanges())) { event.preventDefault(); event.returnValue = ''; }
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
  private baseNewItemEmbeds?:BaseEmbedSessions;
  private baseHoverEmbeds=new Set<BaseEmbedSessions>();
  private bufferSubscriptions = new NoteBufferSubscriptions();
  // An accepted inline configuration owns publication until its exact durable
  // source has been acknowledged by the originating embedded session.
  private inlinePublications = new WeakMap<NoteBuffer,{owner:object;text:string;failed:boolean;valid:boolean;complete:()=>Promise<void>}>();
  private deferInlinePublication(buffer:NoteBuffer):boolean {
    const held=this.inlinePublications.get(buffer);
    if(!held)return false;
    if(buffer.text===held.text)return true;
    held.valid=false;this.inlinePublications.delete(buffer);return false;
  }
  private async finishInlinePublications(buffer?:NoteBuffer):Promise<void> {
    for(const target of buffer?[buffer]:this.buffers.values()){
      this.deferInlinePublication(target);
      const held=this.inlinePublications.get(target);if(held)await held.complete();
    }
  }
  private async finishInlinePublicationAt(path:string|null|undefined):Promise<void> {
    const buffer=path?this.buffers.get(path):undefined;
    if(buffer)await this.finishInlinePublications(buffer);
  }
  private metadataListeners=new Set<()=>void>();
  private subscribeDraftMetadata=(listener:()=>void):(()=>void)=>{this.metadataListeners.add(listener);return()=>this.metadataListeners.delete(listener);};
  private draftBufferStateChanged(buffer:NoteBuffer,vault:Vault):void {
    if(this.vault!==vault||this.buffers.get(buffer.path)!==buffer)return;
    if(!this.deferInlinePublication(buffer))this.bufferSubscriptions.publish(buffer);this.renderStatus();
    if(this.rightTab==='outline'&&this.current()?.path===buffer.path)this.renderRight();
  }
  private draftMetadataChanged(buffer:NoteBuffer,vault:Vault):void {
    if(this.vault!==vault||this.buffers.get(buffer.path)!==buffer||this.platformReleased||this.platformDrained)return;
    if(this.rightTab==='outline'&&this.current()?.path===buffer.path)this.renderRight();
    for(const listener of [...this.metadataListeners])listener();
  }
  private bufferRevisions = new WeakMap<NoteBuffer,number>();
  private bufferEntries = new WeakMap<NoteBuffer,symbol>();
  private recoveredBufferBindings = new WeakSet<NoteBuffer>();
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
  private tasksRetiring=false;
  private sidebarControls?: ReturnType<typeof createSidebarControls>;
  private disposeFileListMenu?: () => void;
  private importStatusCleanup?:()=>void;
  private importStatusHost?:HTMLElement;

  constructor(root: HTMLElement, editorFactory?: EditorFactory, viewFactories: WorkspaceViewFactories = {}) { this.root = root; this.editorFactory = editorFactory; this.viewFactories = viewFactories; }
  private noteStorageFailure(error:unknown,message='This note couldn’t be saved. Keep it open and try again.'):void {
    console.error('Note storage operation failed',error);notice(message);
  }
  private run(operation: () => unknown | Promise<unknown>): void { Promise.resolve().then(operation).catch(error => {
    if([...this.buffers.values()].some(buffer=>buffer.error!==null&&buffer.error===error)){this.noteStorageFailure(error);return;}
    notice(error instanceof Error ? error.message : String(error));
  }); }
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

  private nativeEditorCleanup?:()=>void;
  private sendNativeEditorState(state:NativeEditorState,platform=this.platform):void{
    // Keyboard presentation is best effort and must never interrupt durable saves.
    try{void platform?.nativeEditor?.setState(state).catch(()=>{});}catch{/* Optional native UI unavailable. */}
  }
  private hideNativeEditorToolbar():void{
    this.sendNativeEditorState({focused:false,editable:false,canUndo:false,canRedo:false,selectionCollapsed:false,composing:true,interactionActive:true,navigationRevision:0});
  }
  private bindNativeEditor():void{
    this.nativeEditorCleanup?.();this.nativeEditorCleanup=undefined;
    const platform=this.platform,generation=this.vaultGeneration;
    if(!platform.nativeEditor)return;
    this.hideNativeEditorToolbar();
    const publishCurrent=()=>{
      if(this.platform!==platform||this.vaultGeneration!==generation||this.closing||this.root.inert||this.startupFailed||this.platformReleased)return;
      const state=this.activePane?.editor?.nativeState?.();
      if(state)this.sendNativeEditorState(state,platform);
    };
    const unsubscribe=platform.nativeEditor.subscribe(action=>{
      if(this.platform!==platform||this.vaultGeneration!==generation||this.closing||this.root.inert||this.startupFailed||this.platformReleased)return;
      const pane=this.activePane,editor=pane?.editor;
      if(!editor||!pane.viewReady||pane.viewMode==='reading'&&!pane.viewBaseSource||pane.runtime?.phase==='disposed'||!pane.content?.isConnected||this.current(pane)?.id!==pane.viewTabId)return;
      editor.nativeAction?.(action);
    },publishCurrent);
    const resume=()=>{if(document.visibilityState!=='hidden')publishCurrent();};
    const appearance=window.matchMedia('(prefers-color-scheme: dark)');
    const updateAppearance=()=>{if(this.platform===platform&&this.vaultGeneration===generation&&this.settings.theme==='system')this.applySettings();};
    document.addEventListener('visibilitychange',resume);window.addEventListener('focus',resume);appearance.addEventListener('change',updateAppearance);
    this.nativeEditorCleanup=()=>{unsubscribe();document.removeEventListener('visibilitychange',resume);window.removeEventListener('focus',resume);appearance.removeEventListener('change',updateAppearance);};
  }

  private nativeDocumentCleanup?:()=>void;
  private nativeDocumentTask?:Promise<void>;
  private nativeCommandView?:{pane:Pane;tabId:string;intent:number};
  private bindNativeDocumentNavigation():void{
    this.nativeDocumentCleanup?.();this.nativeDocumentCleanup=undefined;
    const platform=this.platform,generation=this.vaultGeneration;
    if(!platform.editorOnly||!platform.nativeDocumentNavigation)return;
    this.nativeDocumentCleanup=platform.nativeDocumentNavigation.subscribe((request,control)=>{
      const task=this.openNativeDocument(request,control,platform,generation);this.nativeDocumentTask=task;
      void task.finally(()=>{if(this.nativeDocumentTask===task)this.nativeDocumentTask=undefined;}).catch(()=>{});
      return task;
    });
  }

  /** One source + one provisional target, not a retained multi-view window.
   * The source runtime stays intact until target admission and native ACK. */
  private async openNativeDocument(request:Readonly<NativeDocumentOpenRequest>,control:Parameters<Parameters<NativeDocumentNavigation['subscribe']>[0]>[1],platform:PlatformVault,generation:number):Promise<void>{
    const pane=this.activePane,vault=this.vault,source=this.current(pane);
    if(!control.isCurrent()||this.platform!==platform||generation!==this.vaultGeneration||this.closing||this.root.inert||this.startupFailed||this.platformReleased||this.platformDrained||document.visibilityState==='hidden'||!pane?.viewReady||!source||!this.panes.includes(pane))throw new Error('Native document navigation is unavailable');
    if(this.cachedViews.size)throw new Error('A previous document view still needs cleanup; return to Notes and retry');
    const sourceRuntime=pane.runtime,sourceContent=pane.content,sourcePath=source.path;
    const sourceScope=vault.adapter.durableWrites?.checkpoints.scope,sourceStore=sourceScope?.vaultId,sourceClient=sourceScope?.clientId;
    const sourceEntryId=source.expectedEntryId??(sourcePath?this.buffers.get(sourcePath)?.savedDurableWitness?.entryId??vault.entries.get(sourcePath)?.entryId:undefined);
    const tabs=[...pane.tabs],history=[...pane.history],historyIndex=pane.historyIndex;
    const intent=(this.navigationIntent.get(pane)??0)+1;this.navigationIntent.set(pane,intent);
    const owns=()=>this.platform===platform&&this.vault===vault&&generation===this.vaultGeneration&&!this.platformReleased&&!this.platformDrained&&!this.closing&&this.activePane===pane&&this.panes.includes(pane)&&this.navigationIntent.get(pane)===intent;
    const check=()=>{if(!control.isCurrent()||!owns()||document.visibilityState==='hidden')throw new Error('Native document navigation was superseded');};
    const inert=this.root.inert;this.root.inert=true;this.hideNativeEditorToolbar();
    let target:Tab|undefined,acknowledged=false,sourceRestored=false;
    try{
      await this.flushPane(pane);check();
      let observed=await vault.readDurableTextById(request.entryId);check();
      if(!observed||!isMarkdown(observed.path))throw new Error('The selected Markdown note is unavailable');
      // Refresh this projection only; never initialize/rebuild the vault here.
      await vault.reload([observed.path]);check();
      if(vault.entries.get(observed.path)?.entryId!==request.entryId)throw new Error('The selected note moved; retry navigation');
      const buffer=await this.bufferFor(observed.path,request.entryId,check);check();
      if(buffer.savedDurableWitness?.revision!==observed.revision){
        try{await buffer.reload();}catch(error){if(!buffer.hasRecoveryConflict)throw error;}
        check();await buffer.flushForNavigation();check();
      }
      observed=await vault.readDurableTextById(request.entryId);check();
      if(!observed||buffer.path!==observed.path||vault.entries.get(observed.path)?.entryId!==request.entryId||buffer.savedDurableWitness?.entryId!==request.entryId
        ||buffer.savedDurableWitness.revision!==observed.revision&&!buffer.hasRecoveryConflict)throw new Error('The selected note changed during admission');
      this.capturePaneState(pane);
      target={id:makeId(),path:observed.path,expectedEntryId:request.entryId,kind:'note',mode:this.settings.defaultMode};
      this.nativeCommandView={pane,tabId:target.id,intent};
      pane.tabs=[...tabs,target];pane.active=target.id;pane.history=[];pane.historyIndex=-1;
      this.noteNavigation.set(pane,(this.noteNavigation.get(pane)??0)+1);
      await this.renderPane(pane,{flush:false});check();
      if(this.current(pane)!==target||!pane.viewReady||!pane.runtime||pane.runtime.phase!=='active'||!this.nativeReadyViews.has(pane.runtime)
        ||pane.content?.querySelector('.error-message'))throw new Error('The selected note could not be displayed');
      const final=await vault.readDurableTextById(request.entryId);check();
      if(!final||final.path!==observed.path||final.revision!==observed.revision)throw new Error('The selected note changed before acknowledgement');
      await control.ready({path:final.path,entryId:request.entryId,revision:final.revision,recovery:buffer.dirty||buffer.hasRecoveryConflict?'retainedDraft':'none'});
      acknowledged=true; // Positive native ACK commits even if a later intent arrived.
      if(owns()&&this.current(pane)===target){
        this.nativeOpened={platform,entryId:request.entryId,tabId:target.id};
        pane.tabs=[target];this.renderRight();this.saveSession();
      }
    }catch(error){
      // Native rejection never becomes local success. Roll back only this exact
      // render; a newer link/request/lifecycle owns its own visible route.
      if(!acknowledged&&target&&owns()&&this.current(pane)===target){
        // Detach/rebind synchronously before any asynchronous destruction. A
        // newer route may run during teardown, but cannot be overwritten later.
        this.parkPaneView(pane);
        const failed=this.cachedViews.get(target);
        pane.tabs=tabs;pane.active=source.id;pane.history=history;pane.historyIndex=historyIndex;
        if(!this.restoreCachedViewNow(pane,source))throw new Error('The source view could not be restored; return to Notes');
        if(failed){await this.disposePaneViews(failed);this.cachedViews.delete(target);}
        sourceRestored=true;
      }
      // Admission/flush failure can leave the original runtime untouched.
      if(!target)sourceRestored=true;
      throw error;
    }finally{
      if(this.nativeCommandView?.tabId===target?.id)this.nativeCommandView=undefined;
      // Retire the exact provisional source only after ACK, or after a newer
      // navigation took over. Failed target admission leaves the source live.
      const cached=this.cachedViews.get(source);
      if(cached&&(acknowledged||this.current(pane)!==source)){
        try{
          await this.disposePaneViews(cached);this.cachedViews.delete(source);
          if(this.platform===platform&&generation===this.vaultGeneration&&this.current(pane)!==source)pane.tabs=pane.tabs.filter(tab=>tab!==source);
        }catch{notice('The previous view is retained for recovery. Return to Notes before opening another note.');}
      }
      if(owns()){
        this.root.inert=inert;
        const state=pane.editor?.nativeState?.();if(state)this.sendNativeEditorState(state,platform);
      }else if(this.platform===platform&&generation===this.vaultGeneration&&!this.closing&&!this.platformReleased&&this.root.inert)this.root.inert=inert;
      // Native begin invalidated its source snapshot. A terminal failed/stale
      // packet only proves this transaction drained; reattest the actual source
      // separately, after restoration/cleanup and inert restoration. Await this
      // before the adapter sends that terminal packet. Never revive a newer route.
      const restored=()=>sourceRestored&&!acknowledged&&owns()&&!this.root.inert&&!this.startupFailed
        &&document.visibilityState!=='hidden'&&!!sourcePath&&!!sourceEntryId&&this.current(pane)===source&&source.path===sourcePath
        &&pane.viewReady&&pane.viewTabId===source.id&&pane.viewPath===sourcePath&&pane.runtime===sourceRuntime
        &&pane.content===sourceContent&&!!sourceContent?.isConnected&&pane.element.contains(sourceContent)
        &&!!sourceRuntime&&sourceRuntime.phase==='active'&&this.nativeReadyViews.has(sourceRuntime)
        &&vault.adapter.durableWrites?.checkpoints.scope.vaultId===sourceStore&&vault.adapter.durableWrites?.checkpoints.scope.clientId===sourceClient
        &&!pane.content?.querySelector('.error-message')&&vault.entries.get(sourcePath)?.entryId===sourceEntryId
        &&(!isMarkdown(sourcePath)||this.buffers.get(sourcePath)?.savedDurableWitness?.entryId===sourceEntryId&&this.buffers.get(sourcePath)?.savedDurableWitness?.path===sourcePath);
      if(platform.noteOpened&&control.isCurrent()&&restored()){
        // Bypass the successful-open dedup: this is fresh restored-view proof.
        this.nativeOpened=undefined;
        try{
          await platform.noteOpened(sourcePath!,sourceEntryId!);
          // noteOpened intentionally invalidates the old command generation.
          // Its native promise validates the source; later routes keep authority.
          if(restored())this.nativeOpened={platform,entryId:sourceEntryId!,tabId:source.id};
        }catch{/* Native keeps the source snapshot fenced; terminal is no proof. */}
      }
    }
  }

  private mobileLifecycleCleanup?:()=>void;
  private bindMobileLifecycle():void {
    this.mobileLifecycleCleanup?.();this.mobileLifecycleCleanup=undefined;
    const platform=this.platform,generation=this.vaultGeneration;
    if(!platform.mobileLifecycle)return;
    let pending=false;
    this.mobileLifecycleCleanup=platform.mobileLifecycle.subscribe(async(reason,ack)=>{
      if(pending||this.closing||this.startupFailed||this.platform!==platform||this.vaultGeneration!==generation||this.platformReleased)throw new Error('Mobile lifecycle is not ready');
      pending=true;
      // Adapter invalidates the command before invoking lifecycle. Drain its
      // rollback before capturing inert state; never retain transient inert=true
      // as the background/rejected-switch restoration state.
      if(this.nativeDocumentTask)await this.nativeDocumentTask.catch(()=>{});
      if(this.platform!==platform||this.vaultGeneration!==generation||this.platformReleased){pending=false;throw new Error('Mobile vault changed during navigation');}
      this.nativePresentationEpoch++;
      const wasClosing=this.closing,wasInert=this.root.inert;
      this.closing=true;this.root.inert=true;
      this.hideNativeEditorToolbar();
      let accepted=false;
      try {
        // Use the same note/Base/canvas flush and recovery paths as navigation.
        // Native deadlines are authoritative; failed/stale ACK restores editing.
        await this.flush();this.saveSession();
        if(this.platform!==platform||this.vaultGeneration!==generation||this.platformReleased)throw new Error('Mobile vault changed during save');
        await ack();accepted=true;
        // Successful switch ACK transfers host/lease teardown to native. Never
        // destroy/release before ACK or after a timeout which retained this view.
      } finally {
        const sameOwner=this.platform===platform&&this.vaultGeneration===generation;
        if(sameOwner&&(reason==='background'||!accepted)){this.closing=wasClosing;this.root.inert=wasInert;}
        pending=false;
        if(sameOwner&&(reason==='background'||!accepted)){const state=this.activePane?.editor?.nativeState?.();if(state)this.sendNativeEditorState(state,platform);}
      }
    });
  }
  private closeCleanup?:()=>void;
  private closing=false;
  private platformReleased=false;
  private platformDrained=false;
  private async releasePlatform():Promise<void>{
    if(this.platformReleased||!this.platform?.release)return;
    const searchWasSuspended=this.documentSearchSuspended;
    this.documentSearchSuspended=true;this.clearDocumentSearch();
    let cancelTasksClose:(recover?:boolean)=>void=()=>{};
    try{
    this.vaultRequest++;await this.vaultTransition;
    if(!this.platformDrained){await this.flush();await this.closeBaseNewItem();await this.sidebarBase?.session.close();this.sidebarBase=undefined;this.sidebarBaseIntent++;cancelTasksClose=await this.prepareTasksViewsClose();await this.clearCachedViews();for(const pane of this.panes)await this.disposePaneViews(pane);for(const buffer of this.buffers.values())await buffer.dispose();this.platformDrained=true;}
    this.clearDocumentBacklinks();
    await this.closeDocumentSearchPins().catch(()=>{});
    await this.drainMetadataOpenings();
    await this.closeVaultMetadata(this.vault);
    await this.closeRetiredVaultMetadata();
    await this.platform.release();this.releaseDocumentSearchOwner(this.vault);this.platformReleased=true;cancelTasksClose(false);
    }catch(error){cancelTasksClose();this.documentSearchSuspended=searchWasSuspended;throw error;}
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
      buffer=new NoteBuffer(vault,current.path,{onMetadata:()=>this.draftMetadataChanged(buffer,vault),onState:()=>this.draftBufferStateChanged(buffer,vault)});
      await buffer.load(entryId);result.set(current.path,buffer);
    }
    return result;
  }

  // At most one pending state per live runtime. No presentation promise joins
  // admission, saving or lifecycle ACK; the native bridge owns its own delivery.
  private nativePresentationEpoch=0;
  private nativePresentations=new WeakMap<TabViewRuntime,{
    last?:'ready'|'password'|'error'; pending?:'ready'|'password'|'error'; sent?:'ready'|'password'|'error';
    current:()=>boolean; send:(state:'ready'|'password'|'error')=>void;
    receive:(state:'ready'|'password'|'error')=>void; checkError:()=>boolean; rearm:(pane:Pane)=>void; dispose:()=>void;
  }>();

  private nativePresentationCallback(pane:Pane,rearm=false):((state:'ready'|'password'|'error')=>void)|undefined{
    const platform=this.platform,runtime=pane.runtime,content=pane.content,path=pane.viewPath;
    if(!platform?.presentationSettled||!runtime||!content||!path)return;
    const existing=this.nativePresentations.get(runtime);
    if(existing){if(rearm)existing.rearm(pane);return existing.receive;}
    const vault=this.vault,generation=this.vaultGeneration,tabId=pane.viewTabId,entryId=vault.entries.get(path)?.entryId;
    let navigation=this.navigationIntent.get(pane),request=this.vaultRequest,epoch=this.nativePresentationEpoch;
    if(!entryId)return;
    const owns=()=>this.platform===platform&&this.vault===vault&&this.vaultGeneration===generation
      &&!this.closing&&!this.root.inert&&!this.startupFailed&&!this.platformReleased&&!this.platformDrained
      &&this.activePane===pane&&this.panes.includes(pane)&&pane.runtime===runtime&&runtime.phase==='active'
      &&pane.content===content&&content.isConnected&&pane.viewTabId===tabId&&pane.viewPath===path
      &&this.current(pane)?.id===tabId&&this.current(pane)?.path===path
      &&vault.entries.get(path)?.type==='file'&&vault.entries.get(path)?.entryId===entryId;
    const current=()=>owns()&&this.vaultRequest===request&&this.navigationIntent.get(pane)===navigation&&this.nativePresentationEpoch===epoch;
    const receive=(state:'ready'|'password'|'error')=>{
      if(!['ready','password','error'].includes(state)||!current())return;
      record.last=state;record.pending=state;this.flushNativePresentation(pane);
    };
    const checkError=()=>{
      if(!current())return false;
      const password=content.querySelector<HTMLElement>('.zorid-pdf-password');
      if(password&&!password.closest('[hidden]')){receive('password');return true;}
      const pdfError=[...content.querySelectorAll<HTMLElement>('.zorid-pdf-status')].some(node=>!node.closest('[hidden]')&&node.textContent?.startsWith('Unable to display PDF:'));
      const errors=content.querySelectorAll<HTMLElement>('.error-message,.embed-error,.native-unavailable-view,.zorid-media-view.is-error .zorid-media-status');
      const visible=pdfError||[...errors].some(node=>!!node.textContent?.trim()&&!node.closest('[hidden]'))
        ||!!pane.baseView?.state.error&&!!content.querySelector('.bases-session-status')?.textContent?.trim();
      if(visible)receive('error');return visible;
    };
    const Observer=content.ownerDocument.defaultView?.MutationObserver;
    let observing=true;
    const stopObserving=()=>{observing=false;observer?.disconnect();};
    const observer=Observer?new Observer(()=>{if(observing)checkError();}):undefined;
    const record={current,send:(state:'ready'|'password'|'error')=>{
      // Settlement ends subtree watching; explicit PDF callbacks and retained
      // activation checks still report subsequent current presentation states.
      if(state!=='password')stopObserving();
      try{void Promise.resolve(platform.presentationSettled!({path,entryId,state})).catch(()=>{});}catch{/* UI-only host failures cannot fail editing. */}
    },receive,checkError,rearm:(owner:Pane)=>{
      // Only an explicit render/activation can rebind the same retained runtime.
      // Never retarget a callback to a replacement document, entry or content node.
      const previous=pane;pane=owner;if(!owns()){pane=previous;return;}
      const next=this.navigationIntent.get(pane);
      if(next!==navigation||request!==this.vaultRequest||epoch!==this.nativePresentationEpoch||previous!==pane){
        navigation=next;request=this.vaultRequest;epoch=this.nativePresentationEpoch;record.pending=record.last;record.sent=undefined;
      }
    },dispose:stopObserving,last:undefined as 'ready'|'password'|'error'|undefined,pending:undefined as 'ready'|'password'|'error'|undefined,sent:undefined as 'ready'|'password'|'error'|undefined};
    this.nativePresentations.set(runtime,record);
    observer?.observe(content,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','hidden']});
    return receive;
  }

  private flushNativePresentation(pane:Pane):void{
    const record=pane.runtime&&this.nativePresentations.get(pane.runtime);
    if(!record)return;
    if(!record.current()){record.pending=undefined;return;}
    if(this.nativeOpening===this.platform||!pane.viewReady||!record.pending)return;
    const state=record.pending;record.pending=undefined;
    if(record.sent===state)return;
    record.sent=state;record.send(state);
  }

  private nativeReadyViews=new WeakSet<TabViewRuntime>();
  private nativeObservedViews=new WeakSet<TabViewRuntime>();

  private observeNativeNoteView(pane:Pane):void{
    if((!this.platform?.noteOpened&&!this.platform?.presentationSettled)||!pane.runtime||!pane.viewReady)return;
    const presentation=this.nativePresentationCallback(pane,true);
    const presentationRecord=this.nativePresentations.get(pane.runtime);
    const visibleError=presentationRecord?.checkError();
    if(!visibleError&&this.nativeReadyViews.has(pane.runtime))presentation?.('ready');
    const runtime=pane.runtime,generation=this.vaultGeneration,path=pane.viewPath,content=pane.content;
    if(this.nativeObservedViews.has(runtime))return;
    this.nativeObservedViews.add(runtime);
    const ready=()=>{
      if(generation!==this.vaultGeneration||runtime.phase==='disposed')return;
      this.nativeReadyViews.add(runtime);
      presentation?.('ready');
      const owner=this.panes.find(candidate=>candidate.runtime===runtime);
      if(owner)this.notifyNativeNoteOpened(owner);
    };
    if(!path)return;
    if(isMarkdown(path)){if(pane.editor||pane.refreshPreview)ready();return;}
    const base=pane.baseView;
    if(base){void base.ready.then(()=>{if(!base.state.error&&base.state.result)ready();},()=>{});return;}
    if(pane.pdfView){void pane.pdfView.ready.then(ready,()=>{});return;}
    if(pane.canvasView){ready();return;}
    // ImageView has no success promise; use the actual image's load result.
    const image=pane.imageView?content?.querySelector('img'):null;
    if(image){if(image.complete&&image.naturalWidth>0)ready();else image.addEventListener('load',()=>{if(image.naturalWidth>0)ready();},{once:true});return;}
    // MediaView.ready also settles on errors/timeouts. Only metadata is success.
    if(pane.mediaView){
      const check=()=>{const media=content?.querySelector('audio,video') as HTMLMediaElement|null;if(media&&media.readyState>=1&&!media.error)ready();};
      check();content?.addEventListener('loadedmetadata',check,{capture:true,once:true});
      void pane.mediaView.ready.then(check,()=>{});
    }
  }

  private nativeOpening?:PlatformVault;
  private nativeOpened?:{platform:PlatformVault;entryId:string;tabId:string};

  private notifyNativeNoteOpened(pane:Pane):void {
    const platform=this.platform;
    if(!platform?.noteOpened||this.nativeOpening===platform||this.closing||this.startupFailed||this.platformReleased||this.activePane!==pane||!this.panes.includes(pane))return;
    const tab=this.current(pane);
    if(!tab?.path||tab.kind!=='note'){this.nativeOpened=undefined;return;}
    if(!pane.viewReady||pane.viewTabId!==tab.id||pane.viewPath!==tab.path||pane.runtime?.phase!=='active')return;
    if(!this.nativeReadyViews.has(pane.runtime))return;
    const entry=this.vault.entries.get(tab.path);
    if(entry?.type!=='file'||!entry.entryId||tab.expectedEntryId!==undefined&&entry.entryId!==tab.expectedEntryId)return;
    if(this.nativeCommandView?.pane===pane&&this.nativeCommandView.tabId===tab.id&&this.navigationIntent.get(pane)===this.nativeCommandView.intent)return;
    const previous=this.nativeOpened;
    if(previous?.platform===platform&&previous.entryId===entry.entryId&&previous.tabId===tab.id)return;
    this.nativeOpened={platform,entryId:entry.entryId,tabId:tab.id};
    // Recents is presentation state. Never make a rejected/stale notification
    // fail the shared editor's activation, durable checkpoint or save path.
    try{void platform.noteOpened(tab.path,entry.entryId).catch(()=>{});}catch{/* Optional native history is nonfatal. */}
  }

  private async openNativeInitialNote(platform:PlatformVault):Promise<void>{
    if(platform.createNoteOnOpen){await this.newNote();return;}
    if(platform.initialPath===undefined)return;
    const entry=this.vault.entries.get(platform.initialPath);
    if(!platform.initialEntryId||entry?.type!=='file'||entry.entryId!==platform.initialEntryId){
      notice('The selected note changed or is no longer available. Return to Files and select it again.');
      // This error has no document runtime. Reveal its visible notice using only
      // the admitted launch identity; never acknowledge the replacement file.
      if(platform.initialEntryId&&this.platform===platform&&this.nativeOpening===platform&&!this.closing&&!this.root.inert&&!this.startupFailed&&!this.platformReleased){
        try{void Promise.resolve(platform.presentationSettled?.({path:platform.initialPath,entryId:platform.initialEntryId,state:'error'})).catch(()=>{});}catch{/* Optional UI delivery cannot fail admission. */}
      }
      return;
    }
    await this.openNote(platform.initialPath,false,this.activePane,true,'',undefined,undefined,platform.adapter.durableWrites?platform.initialEntryId:undefined);
  }

  async openVault(platform: PlatformVault): Promise<void> {
    const request=++this.vaultRequest,next=new Vault(platform.adapter);
    let settled!:()=>void;const opening=new Promise<void>(resolve=>{settled=resolve;});this.metadataOpenings.add(opening);
    // Initialization is read-only and can overlap; only the latest request may
    // enter the serialized teardown/install phase. Old views stay usable while
    // a new adapter initializes, and a late request cannot acquire a watcher.
    try{
    await next.initialize();
    if(request!==this.vaultRequest)return;
    const transition=this.vaultTransition.then(async()=>{if(request===this.vaultRequest){
      this.nativeOpening=platform;
      try{
        let recovered=await this.recoverDurableBuffers(next);
        if(await platform.recoverCommands?.()){await next.initialize();recovered=await this.recoverDurableBuffers(next);}
        await this.replaceVault(platform,next,recovered);
        if(request===this.vaultRequest&&this.platform===platform)await this.openNativeInitialNote(platform);
      }finally{if(this.nativeOpening===platform){this.nativeOpening=undefined;if(request===this.vaultRequest&&this.platform===platform)this.flushNativePresentation(this.activePane);}}
      if(request===this.vaultRequest&&this.platform===platform)this.notifyNativeNoteOpened(this.activePane);
    }});
    this.vaultTransition=transition.catch(()=>{});
    await transition;
    }finally{
      try{if(this.vault!==next)await this.closeVaultMetadata(next);}
      finally{this.metadataOpenings.delete(opening);settled();}
    }
  }

  private async drainMetadataOpenings():Promise<void>{
    // Teardown invalidates opening requests and joins the serialized install
    // first. Its remaining openings can only retire their own projection.
    while(this.metadataOpenings.size)await Promise.all([...this.metadataOpenings]);
  }

  private async closeRetiredVaultMetadata():Promise<void>{
    for(const retired of [...this.retiredMetadataVaults])await this.closeVaultMetadata(retired);
  }

  private async closeVaultMetadata(vault:Vault|undefined):Promise<void>{
    if(!vault)return;
    for(const query of [...this.notePropertyQueries])if(query.vault===vault){await query.session.close();this.notePropertyQueries.delete(query);}
    if(this.metadataSubscription?.vault===vault){this.metadataSubscription.stop();this.metadataSubscription=undefined;}
    this.retiredMetadataVaults.add(vault);
    // A failed close retains this exact retired owner for a later retry.
    await vault.closeMetadataProjection();this.retiredMetadataVaults.delete(vault);
  }

  private subscribeVaultMetadata(vault:Vault):void{
    this.metadataSubscription?.stop();
    const owner={vault,stop:()=>{}};this.metadataSubscription=owner;
    const generation=this.vaultGeneration;let previous:CommittedMetadataFrame|null|undefined;
    const receive=(state:CommittedMetadataState)=>{
      if(this.metadataSubscription!==owner||this.vault!==vault||this.vaultGeneration!==generation||this.platformReleased||this.platformDrained)return;
      const changed=state.frame!==previous;previous=state.frame;
      if(this.rightTab==='tags'){
        const status=this.rightContent.querySelector<HTMLElement>(':scope > .metadata-projection-status');
        if(!changed&&status){this.rightContent.dataset.metadataStatus=state.status;status.textContent=this.metadataDisplayMessage(state)??'';status.hidden=!status.textContent;const empty=this.rightContent.querySelector('.metadata-projection-empty');if(empty)empty.textContent=state.status!=='current'||!state.frame?.coverageComplete?'No tags in this saved snapshot.':'No tags found.';}
        else this.renderRight();
      }else if(this.rightTab==='outline')this.renderRight();
      for(const pane of this.loadedViews()){
        if(pane.viewKind==='graph'&&pane.content)this.renderGraph(pane.content);
        if(changed)pane.editor?.refreshLinks?.();
      }
    };
    let unsubscribe:()=>void;
    try{unsubscribe=vault.onMetadata(receive);}catch(error){if(this.metadataSubscription===owner)this.metadataSubscription=undefined;throw error;}
    owner.stop=()=>{if(this.metadataSubscription===owner)this.metadataSubscription=undefined;unsubscribe();};this.disposers.push(owner.stop);
    const state=vault.metadataFrame;if(state)receive(state);
  }

  private async replaceVault(platform:PlatformVault,next:Vault,recovered=new Map<string,NoteBuffer>()):Promise<void>{
    // Migration failures must abort before teardown/save can replace legacy recovery.
    this.storageScope.migrateLegacy(localStorage, platform.id);
    const searchVault=this.vault,searchWasSuspended=this.documentSearchSuspended;
    this.documentSearchSuspended=true;this.clearDocumentSearch();
    let cancelTasksClose:(recover?:boolean)=>void=()=>{};
    try{
    this.menuSerial++; await dismissContextMenu(this.root.ownerDocument);
    if(!this.platformReleased)await this.flush();
    await this.closeBaseNewItem();
    await this.sidebarBase?.session.close();this.sidebarBase=undefined;this.sidebarBaseIntent++;
    cancelTasksClose=await this.prepareTasksViewsClose();
    this.saveSession();
    for (const dispose of this.disposers) dispose(); this.disposers = [];
    clearTimeout(this.reloadTimer);
    this.tabDocking?.destroy();this.tabDocking=undefined;await this.clearCachedViews();
    for(const pane of this.panes)await this.disposePaneViews(pane);if(!this.platformReleased)for(const buffer of this.buffers.values())await buffer.dispose(); this.buffers.clear();
    await this.closeVaultMetadata(searchVault);
    await this.closeRetiredVaultMetadata();
    if(!this.platformReleased&&this.platform?.release){await this.platform.release();this.releaseDocumentSearchOwner(this.vault);}
    this.attachments?.destroy();
    this.canvasDocumentInput?.destroy();this.canvasDocumentInput=undefined;
    this.treeDrag?.destroy(); this.treeDrag=undefined; this.treeRename?.session.dispose(); this.treeRename=undefined; this.folderCreationIntent++;
    this.treeRows=[]; this.treeSelection.clear(); this.treeSelectionAnchor=undefined; this.entryTokens.clear();
    this.mobileLifecycleCleanup?.();this.mobileLifecycleCleanup=undefined;
    this.hideNativeEditorToolbar();this.nativeEditorCleanup?.();this.nativeEditorCleanup=undefined;
    cancelTasksClose(false);cancelTasksClose=()=>{};
    this.nativeDocumentCleanup?.();this.nativeDocumentCleanup=undefined;
    this.platform = platform; this.vault = next; this.platformReleased=false;this.platformDrained=false;this.buffers=recovered; this.recoveredBufferBindings=new WeakSet(recovered.values()); this.vaultGeneration++;
    this.attachments=new AttachmentResources(this.vault);
    this.attachmentImporter=new AttachmentImporter(this.vault);
    this.splitLayout?.destroy(); this.splitLayout=undefined; this.restoringLayout=true;
    this.panes = []; this.autoRevealFiles=false; this.collapsed.clear(); this.bookmarks.clear(); this.sessionState = {};this.rightTab='backlinks';this.sidebarBasePath=undefined;this.sidebarPinnedContext=undefined;
    this.buildShell();
    if(!platform.editorOnly)this.mountFileTreeDrag();
    let restored = false;
    try {
      const saved = JSON.parse(localStorage.getItem(this.sessionKey()) || 'null');
      if (saved && !platform.editorOnly) {
        this.sessionState = saved;this.autoRevealFiles=saved.autoRevealFiles===true;
        if(['backlinks','outline','tags'].includes(saved.rightTab))this.rightTab=saved.rightTab;
        if(typeof saved.sidebarBasePath==='string'&&/\.base$/i.test(saved.sidebarBasePath)&&next.entries.get(saved.sidebarBasePath)?.type==='file')this.sidebarBasePath=saved.sidebarBasePath;
        if(this.sidebarBasePath&&saved.sidebarBasePinned===true){
          const identityValid=saved.sidebarBaseContextEntryId===undefined||typeof saved.sidebarBaseContextEntryId==='string';
          this.sidebarPinnedContext=this.captureSidebarPinContext({path:identityValid&&typeof saved.sidebarBaseContext==='string'?saved.sidebarBaseContext:null,...(typeof saved.sidebarBaseContextEntryId==='string'?{entryId:saved.sidebarBaseContextEntryId}:{})});
        }
        this.root.classList.toggle('right-hidden', saved.rightHidden !== false);
        this.root.classList.toggle('left-hidden', saved.leftHidden === true);
        this.collapsed = new Set(saved.collapsed || []); this.bookmarks = new Set(saved.bookmarks || []);
        for (const item of (Array.isArray(saved.panes) ? saved.panes : []).slice(0, 100)) {
          const tabs: Tab[] = (item.tabs || []).filter((tab: Tab) => tab.kind === 'graph' || tab.kind === 'calendar' || tab.kind === 'tasks' || !tab.path || this.vault.entries.has(tab.path)).map((tab: Tab) => {const history=Array.isArray(tab.history)?tab.history.filter(path=>typeof path==='string'):[];return{...tab,baseSource:tab.kind==='note'&&typeof tab.path==='string'&&/\.base$/i.test(tab.path)&&tab.baseSource===true,history,historyIndex:Number.isInteger(tab.historyIndex)?Math.max(-1,Math.min(tab.historyIndex!,history.length-1)):history.length-1,mode:tab.mode==='reading'?'reading' as const:'live' as const,id:makeId()};});
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
    if(!platform.editorOnly&&this.sessionState.rightTab==='base'&&this.sidebarBasePath)await this.openBaseSidebar(this.sidebarBasePath,{reveal:false,persist:false});
    this.subscribeVaultMetadata(next);
    if(!platform.editorOnly)this.tabDocking=createTabDocking({root:this.root,getPanes:()=>this.dockPanes(),dock:intent=>this.dockTab(intent),enabled:()=>!matchMedia('(max-width: 700px)').matches,onError:error=>notice(error instanceof Error?error.message:String(error))});
    this.disposers.push(this.vault.on('create', change => { this.invalidateTreeTokens(change.path); this.renderSidebar(); }), this.vault.on('delete', change => {
      this.invalidateTreeTokens(change.path);
      const removed=(path:string)=>path===change.path||path.startsWith(change.path+'/');
      this.treeSelection=new Set([...this.treeSelection].filter(path=>!removed(path)));
      if(this.treeSelectionAnchor&&removed(this.treeSelectionAnchor))this.treeSelectionAnchor=undefined;
      if(this.treeRename&&(this.treeRename.path===change.path||this.treeRename.path.startsWith(change.path+'/')))this.treeRename.session.dispose();
      for (const pane of this.panes) for (const tab of [...pane.tabs]) if (tab.path === change.path || tab.path?.startsWith(change.path + '/')) {
        const buffer = this.buffers.get(tab.path);
        if (buffer?.dirty || (pane.active === tab.id ? pane.properties : this.cachedViews.get(tab)?.properties)?.hasPendingChanges() || (pane.active === tab.id ? pane.canvasView : this.cachedViews.get(tab)?.canvasView)?.hasPendingChanges() || (pane.active === tab.id ? pane.baseView : this.cachedViews.get(tab)?.baseView)?.hasPendingChanges() || (pane.active === tab.id ? pane.baseEmbeds : this.cachedViews.get(tab)?.baseEmbeds)?.hasPendingChanges()) { notice(`“${nameOf(tab.path)}” was removed outside the app. Your unsaved text is retained.`); continue; }
        const cached=this.cachedViews.get(tab);
        if(cached){
          const path=tab.path,generation=this.vaultGeneration;
          this.run(async()=>{
            if(generation!==this.vaultGeneration||this.cachedViews.get(tab)!==cached||tab.path!==path||buffer?.dirty||cached.properties?.hasPendingChanges()||cached.canvasView?.hasPendingChanges()||cached.baseView?.hasPendingChanges()||cached.baseEmbeds?.hasPendingChanges())return;
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
      const sidebar=this.sidebarBase,generation=this.vaultGeneration,sidebarIntent=this.sidebarBaseIntent;
      const movedSidebar=sidebar&&(sidebar.path===oldPath||sidebar.path.startsWith(oldPath+'/'))?change.path+sidebar.path.slice(oldPath.length):undefined;
      const pinned=sidebar?.pinnedContext??this.sidebarPinnedContext,movedPin=pinned?.path&&(pinned.path===oldPath||pinned.path.startsWith(oldPath+'/'))?change.path+pinned.path.slice(oldPath.length):undefined;
      const ownedPin=!!(pinned&&movedPin&&(pinned.entryId?this.vault.entries.get(movedPin)?.entryId===pinned.entryId:pinned.token&&this.entryTokens.get(pinned.path!)===pinned.token));
      const movedBuffers=new Set([...this.buffers].filter(([path,buffer])=>this.bufferEntries.has(buffer)&&this.bufferEntries.get(buffer)===this.entryTokens.get(path)).map(([,buffer])=>buffer));
      this.invalidateTreeTokens(oldPath); this.invalidateTreeTokens(change.path);
      const relocate=(path:string)=>path===oldPath||path.startsWith(oldPath+'/')?change.path+path.slice(oldPath.length):path;
      if(this.sidebarBasePath)this.sidebarBasePath=relocate(this.sidebarBasePath);
      if(pinned&&movedPin&&ownedPin){const next={...pinned,path:movedPin,token:this.treeEntryToken(movedPin)};if(sidebar?.pinnedContext===pinned)sidebar.pinnedContext=next;if(this.sidebarPinnedContext===pinned)this.sidebarPinnedContext=next;}
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
      if(sidebar&&movedSidebar&&!sidebar.session.hasPendingChanges()){
        const token=this.treeEntryToken(movedSidebar);
        this.run(async()=>{
          // A move is a new source binding. Never retarget retained drafts or a
          // newer sidebar request, nor adopt a replacement at the destination.
          if(generation!==this.vaultGeneration||sidebarIntent!==this.sidebarBaseIntent||this.sidebarBase!==sidebar||this.sidebarBasePath!==movedSidebar||!token||this.treeEntryToken(movedSidebar)!==token||sidebar.session.hasPendingChanges())return;
          await this.openBaseSidebar(movedSidebar,{activate:false,reveal:false,...(sidebar.pinned&&sidebar.pinnedContext?{pinnedContext:sidebar.pinnedContext}:{})});
        });
      }
      this.renderSidebar(); this.renderRight(); this.panes.forEach(pane => this.run(()=>this.renderPane(pane))); this.saveSession();
    }), this.vault.on('modify', change => {
      if(/\.base$/i.test(change.path)){
        // The session observes query/config events itself. Keep its active property
        // draft and cached DOM; only reconcile the shared clean config buffer.
        const buffer=this.buffers.get(change.path),generation=this.vaultGeneration;
        if(buffer&&!buffer.dirty)this.run(async()=>{const previous=buffer.text;await buffer.reload();if(generation===this.vaultGeneration&&this.buffers.get(change.path)===buffer){this.mapInactiveSelections(change.path,previous,buffer.text);for(const pane of this.loadedViews())if(pane.viewPath===change.path&&pane.viewBaseSource)pane.editor?.setValue(buffer.text);this.renderStatus();}});
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
    for(const event of ['create','delete','rename','modify'] as const)this.disposers.push(this.vault.on(event,()=>{
      if(this.richDocumentSearch)this.richDocumentSearch.controller?.invalidateSource();
      else if(this.treeTab==='search'&&this.documentSearchFreshness){this.clearDocumentSearch();this.run(()=>this.search());}
      for(const pane of this.loadedViews())pane.editor?.refreshLinks?.();
    }));
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
    this.bindMobileLifecycle();this.bindNativeEditor();this.bindNativeDocumentNavigation();
    }catch(error){cancelTasksClose();if(this.vault===searchVault)this.documentSearchSuspended=searchWasSuspended;throw error;}
  }

  private disposeShell(): void {
    this.nativeDocumentStatus=undefined;
    this.clearDocumentBacklinks();
    this.documentSearchSuspended=true;this.clearDocumentSearch();
    this.importStatusCleanup?.();this.importStatusCleanup=undefined;
    this.disposeFileListMenu?.(); this.disposeFileListMenu=undefined;
    this.sidebarControls?.destroy(); this.sidebarControls=undefined;
  }

  private buildShell(): void {
    this.disposeShell();
    this.documentSearchSuspended=false;
    this.root.replaceChildren(); this.root.className = 'workspace right-hidden';
    this.root.classList.toggle('native-editor-only',this.platform.editorOnly===true);
    this.root.classList.toggle('is-macos-desktop',!!window.zorid&&/Mac/i.test(window.navigator.platform));
    const ribbon = el('nav', 'ribbon'); ribbon.setAttribute('aria-label', 'Ribbon');
    const top = el('div', 'ribbon-top');
    top.append(this.hotkeyButton('search','quick-switcher', 'Open quick switcher', () => this.quickSwitcher()), button('graph', 'Open graph view', () => this.run(() => this.openGraph())), button('list', 'Open Tasks', () => this.run(() => this.openTasks())), button('calendar', 'Open Calendar', () => this.run(() => this.openCalendar())), button('calendar', "Open today's daily note", () => this.run(() => this.dailyNote())), this.hotkeyButton('terminal','command-palette', 'Open command palette', () => this.commandPalette()));
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
    const center = el('section','workspace-center');
    this.status = el('footer','status-bar'); this.status.setAttribute('aria-live','polite');
    this.importStatusHost=undefined;
    const reconciliation=this.platform.reconciliation;
    if(reconciliation){
      if(!this.platform.editorOnly){this.importStatusHost=el('div','import-status-host');this.status.append(this.importStatusHost);}
      const vault=this.vault,generation=this.vaultGeneration;
      const count=()=>[...vault.entries.values()].filter(entry=>entry.type==='file').length;
      const view=mountImportStatus(center,{status:reconciliation.getStatus(),entryCount:count(),statusHost:this.importStatusHost,retry:async()=>{
        await reconciliation.retry();if(this.vault!==vault||this.vaultGeneration!==generation)return;
        await vault.reload();update();
      }});
      const update=()=>{if(this.vault===vault&&this.vaultGeneration===generation)view.update(reconciliation.getStatus(),count());};
      const stop=reconciliation.subscribe(update),created=vault.on('create',update),deleted=vault.on('delete',update);
      this.importStatusCleanup=()=>{stop();created();deleted();view.destroy();};
    }
    this.paneContainer = el('main','panes'); center.append(this.paneContainer);
    this.splitLayout=new SplitLayout(this.paneContainer,{onChange:()=>this.saveSession()});
    this.right = el('aside','right-sidebar'); this.right.setAttribute('aria-label','Right sidebar');
    const rightTabs = el('div','right-tabs');
    for (const [type,glyph,label] of [['backlinks','link','Backlinks'],['outline','list','Outline'],['tags','tag','Tags']] as const) rightTabs.append(button(glyph,label,()=>{this.run(async()=>{await this.sidebarBase?.session.flush();this.rightTab=type;this.renderRight();});}));
    rightTabs.append(button('table','Bases',()=>this.run(async()=>{await this.sidebarBase?.session.flush();const path=this.sidebarBasePath??this.sidebarBase?.path??this.current()?.path;if(this.sidebarBase&&this.sidebarBase.path===path){this.rightTab='base';this.renderRight();this.saveSession();}else if(path&&/\.base$/i.test(path))await this.openBaseSidebar(path);else notice('Open a Base first.');})));
    this.sidebarBasePinButton=button('pin','Pin sidebar Base',()=>this.run(()=>this.toggleSidebarBasePin()),'sidebar-base-pin');this.sidebarBasePinButton.hidden=true;rightTabs.append(this.sidebarBasePinButton);
    rightTabs.append(button('rightbar','Toggle right sidebar',()=>this.toggleRight(),'pane-sidebar-toggle')); this.rightContent=el('div','right-content'); this.right.append(rightTabs,this.rightContent);
    const status=el('section','native-document-status');status.setAttribute('aria-label','Save and recovery notices');status.setAttribute('aria-live','polite');
    this.nativeDocumentStatus=status;
    if(this.platform.editorOnly){
      center.prepend(status);this.root.append(center);return;
    }
    center.append(status);
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
          actions:{newNote:()=>this.newNote(''),newFolder:()=>this.newFolder(''),newCanvas:()=>this.newCanvas(''),newBase:()=>this.newBase('')},
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
  private activate(pane: Pane): void { const changed=this.activePane!==pane;if(changed)this.paneActivationRevision++;this.activePane=pane; this.panes.forEach(p=>p.element.classList.toggle('is-active',p===pane));if(changed&&this.sidebar.isConnected)this.renderSidebar(); this.renderRight(); this.renderStatus(); if(changed)this.notifyNativeNoteOpened(pane); }
  async openNote(path:string,newTab=false,pane=this.activePane,recordHistory=true,subpath='',expectedActivation?:number,commitGuard?:()=>boolean,expectedEntryId?:string): Promise<void> {
    if(this.platform.editorOnly)newTab=false;
    if(this.vault.entries.get(path)?.type!=='file') throw new Error(`File not found: ${path}`);
    const intent=(this.navigationIntent.get(pane)??0)+1,generation=this.vaultGeneration,version=pane.renderVersion;this.navigationIntent.set(pane,intent);
    // A split activates its destination before its first view is mounted. That
    // older render may assign the first version while this newer open flushes.
    // Admit only the same untouched initial tab; established views keep their
    // existing render-version fence.
    const initialTab=version===0?this.current(pane):undefined;
    const initialOrigin=initialTab?{tab:initialTab,id:initialTab.id,path:initialTab.path,kind:initialTab.kind,mode:initialTab.mode}:undefined;
    await this.flushPane(pane);
    if(/\.base$/i.test(path))await this.prepareBase(path,generation);
    if(expectedEntryId!==undefined){
      const validate=()=>{if(generation!==this.vaultGeneration||this.navigationIntent.get(pane)!==intent||!this.panes.includes(pane)||this.vault.entries.get(path)?.entryId!==expectedEntryId||(commitGuard&&!commitGuard()))throw new Error('The selected note changed before admission');};
      if(isMarkdown(path))await this.bufferFor(path,expectedEntryId,validate);validate();
    }
    const initialCurrent=initialOrigin&&this.current(pane)===initialOrigin.tab&&pane.active===initialOrigin.id&&initialOrigin.tab.path===initialOrigin.path&&initialOrigin.tab.kind===initialOrigin.kind&&initialOrigin.tab.mode===initialOrigin.mode;
    if(this.navigationIntent.get(pane)!==intent||generation!==this.vaultGeneration||(initialOrigin?!initialCurrent:pane.renderVersion!==version)||!this.panes.includes(pane)||(expectedActivation!==undefined&&expectedActivation!==this.paneActivationRevision)||(commitGuard&&!commitGuard()))return;
    this.noteNavigation.set(pane,(this.noteNavigation.get(pane)??0)+1);
    this.capturePaneState(pane);const current=this.current(pane);
    const existing=pane.tabs.find(tab=>tab.path===path&&tab.kind==='note');
    if(existing&&!newTab) pane.active=existing.id;
    else if(!newTab&&current){if(current.path!==path){current.viewState=undefined;current.baseSource=undefined;}if(current.kind!=='note')current.mode=this.settings.defaultMode;current.path=path;current.kind='note';}
    else {const tab:Tab={id:makeId(),path,mode:this.settings.defaultMode,kind:'note'};pane.tabs.push(tab);pane.active=tab.id;}
    this.current(pane).expectedEntryId=expectedEntryId;
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

  /** Recovery loads before vault installation, so its buffers have no tree
   * token yet. Admit that first binding using the saved actor, never path alone;
   * an existing invalidated binding remains a retained replacement draft. */
  private async bindRecoveredBuffer(path:string,buffer:NoteBuffer,validate:()=>void):Promise<void>{
    if(this.bufferEntries.has(buffer))return;
    const vault=this.vault,generation=this.vaultGeneration,adapter=vault.adapter,durable=adapter.durableWrites;
    const witness=buffer.savedDurableWitness,token=this.treeEntryToken(path),scope=durable?.checkpoints.scope,vaultId=scope?.vaultId,clientId=scope?.clientId;
    const changed=()=>new Error('This recovered note changed or was replaced; its draft is retained.');
    const check=()=>{
      validate();const current=buffer.savedDurableWitness,entry=vault.entries.get(path);
      if(this.vault!==vault||this.vaultGeneration!==generation||vault.adapter!==adapter||adapter.durableWrites!==durable||durable?.checkpoints.scope.vaultId!==vaultId||durable?.checkpoints.scope.clientId!==clientId
        ||!this.recoveredBufferBindings.has(buffer)&&this.bufferEntries.get(buffer)!==token||!witness||witness.path!==path||!token||this.treeEntryToken(path)!==token||this.buffers.get(path)!==buffer||buffer.path!==path||entry?.type!=='file'
        ||entry.entryId&&entry.entryId!==witness.entryId||!current||current.entryId!==witness.entryId||current.path!==witness.path||current.revision!==witness.revision)throw changed();
    };
    check();
    const observed=await vault.readDurableTextById(witness!.entryId);
    check();
    if(!observed||observed.entryId!==witness!.entryId||observed.path!==path||observed.revision!==witness!.revision)throw changed();
    // Another simultaneous admission may have bound the same exact actor while
    // the read was pending. It may never replace a previously owned token.
    const bound=this.bufferEntries.get(buffer);if(bound&&bound!==token)throw changed();
    this.bufferEntries.set(buffer,token!);
    this.recoveredBufferBindings.delete(buffer);
  }

  private async bufferFor(path:string,expectedEntryId?:string,validate:()=>void=()=>{}):Promise<NoteBuffer>{
    validate();
    if(expectedEntryId!==undefined){
      if(this.vault.entries.get(path)?.entryId!==expectedEntryId)throw new Error('The selected note identity changed');
      for(const [key,other] of this.buffers)if(key!==path&&other.savedDurableWitness?.entryId===expectedEntryId)throw new Error('The selected note moved; its existing draft is retained');
    }
    let buffer=this.buffers.get(path); if(buffer){
      if(expectedEntryId!==undefined&&!buffer.savedDurableWitness)throw new Error('The selected note is still loading; retry navigation');
      await buffer.load(expectedEntryId,validate);validate();await this.bindRecoveredBuffer(path,buffer,validate);validate();return buffer;
    }
    const vault=this.vault;
    buffer=new NoteBuffer(vault,path,{onMetadata:()=>this.draftMetadataChanged(buffer!,vault),storage:localStorage,storageKey:this.storageScope.draftPrefix(this.platform.id),onState:()=>{if(buffer)this.draftBufferStateChanged(buffer,vault);}});
    this.buffers.set(path,buffer);const token=this.treeEntryToken(path);if(token)this.bufferEntries.set(buffer,token);
    try{await buffer.load(expectedEntryId,validate);validate();return buffer;}catch(error){if(this.buffers.get(path)===buffer&&!buffer.savedDurableWitness){await buffer.closeMetadataProjection();this.buffers.delete(path);}throw error;}
  }

  private renderTabBar(pane:Pane):void{
    if(this.platform.editorOnly){pane.element.querySelector(':scope > .tab-bar')?.remove();return;}
    const tab=this.current(pane);if(!tab)return;
    const bar=el('div','tab-bar'); bar.setAttribute('role','tablist');
    bar.append(button('sidebar','Toggle left sidebar',()=>this.toggleLeft(),'pane-sidebar-toggle'));
    const strip=el('div','tab-strip');bar.append(strip);
    for(const item of pane.tabs){
      const node=el('div',`tab${item.id===tab.id?' is-active':''}`);node.role='tab';node.tabIndex=item.id===tab.id?0:-1;node.setAttribute('aria-selected',String(item.id===tab.id));node.draggable=true;node.dataset.tabId=item.id;
      node.append(icon(item.kind==='tasks'?'list':item.kind==='calendar'?'calendar':item.kind==='graph'?'graph':item.path&&/\.base$/i.test(item.path)?'table':'file',15),el('span','tab-title',item.kind==='tasks'?'Tasks':item.kind==='calendar'?'Calendar':item.kind==='graph'?'Graph view':item.path?nameOf(item.path).replace(/\.base$/i,''):'New tab'));
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
    if(this.tasksRetiring)return;
    const intent=(this.navigationIntent.get(pane)??0)+1,generation=this.vaultGeneration;this.navigationIntent.set(pane,intent);
    if(pane.active===tab.id){this.activate(pane);this.observeNativeNoteView(pane);this.flushNativePresentation(pane);this.focusPane(pane);return;}
    await this.flushPane(pane);
    if(this.tasksRetiring||intent!==this.navigationIntent.get(pane)||generation!==this.vaultGeneration||!this.panes.includes(pane)||!pane.tabs.includes(tab))return;
    pane.active=tab.id;this.activate(pane);await this.renderPane(pane);this.saveSession();
  }

  async renderPane(initialPane:Pane,options:{flush?:boolean;refresh?:boolean}={}):Promise<void>{
    await this.renderPaneContent(initialPane,options);
    this.observeNativeNoteView(initialPane);
    this.notifyNativeNoteOpened(initialPane);
    this.flushNativePresentation(initialPane);
  }

  private async renderPaneContent(initialPane:Pane,options:{flush?:boolean;refresh?:boolean}={}):Promise<void>{
    let pane=initialPane;
    const request=(this.renderRequests.get(initialPane)??0)+1,generation=this.vaultGeneration;this.renderRequests.set(initialPane,request);
    const current=()=>generation===this.vaultGeneration&&this.panes.includes(initialPane)&&this.renderRequests.get(initialPane)===request;
    if(options.flush!==false)await this.flushPane(pane);
    if(!current())return;
    const wanted=this.current(pane);
    if(!options.refresh&&pane.viewReady&&pane.viewTabId===wanted?.id&&pane.viewPath===wanted.path&&pane.viewMode===wanted.mode&&pane.viewKind===wanted.kind&&!!pane.viewBaseSource===!!wanted.baseSource ){
      this.applyViewSettings(pane);this.renderTabBar(pane);pane.refreshPreview?.();return;
    }
    if(this.platform.nativeEditor&&pane===this.activePane)this.hideNativeEditorToolbar();
    if(pane.viewTabId&&pane.viewTabId!==pane.active&&pane.tabs.some(tab=>tab.id===pane.viewTabId))this.parkPaneView(pane);else await this.disposePaneViews(pane);
    if(!current())return;
    const tab=this.current(pane);if(!tab)return;
    this.renderTabBar(pane);
    if(await this.restoreCachedView(pane,tab)){this.renderStatus();return;}
    if(!current())return;
    const version=++this.viewSequence;pane.renderVersion=version;pane.viewTabId=tab.id;pane.viewPath=tab.path;pane.viewMode=tab.mode;pane.viewKind=tab.kind;pane.viewBaseSource=!!tab.baseSource;pane.viewSettings=this.viewSettings();
    pane.history=tab.history??[];pane.historyIndex=tab.historyIndex??-1;
    const content=el('div','tab-view-content');Object.assign(content.style,{display:'flex',flexDirection:'column',flex:'1',minHeight:'0',minWidth:'0',overflow:'hidden'});pane.element.append(content);pane.content=content;
    let recoveryCleanup:(()=>void)|undefined;
    const runtime=createTabViewRuntime({id:tab.id,element:content,owner:this.viewOwner(pane),
      flush:async()=>{await pane.properties?.flush();await pane.calendarView?.flush();await pane.canvasView?.flush();if(pane.viewPath)await this.buffers.get(pane.viewPath)?.flushForNavigation();await pane.baseView?.close();await pane.baseEmbeds?.flush();await pane.tasksView?.prepareClose();},
      dispose:async()=>{await pane.baseEmbeds?.close();pane.tasksView?.destroy();recoveryCleanup?.();this.releasePaneView(pane,content);},focus:()=>this.focusPane(pane)});pane.runtime=runtime;
    const nativePresentation=this.nativePresentationCallback(pane);
    let ownerChanged=()=>{};pane.rebindView=owner=>{pane=owner;ownerChanged();};
    const toolbar=el('div','pane-toolbar');
    const back=button('left','Navigate back',()=>this.run(()=>this.navigate(-1,pane)));back.disabled=pane.historyIndex<=0;
    const forward=button('right','Navigate forward',()=>this.run(()=>this.navigate(1,pane)));forward.disabled=pane.historyIndex>=pane.history.length-1;
    toolbar.append(back,forward,el('div','breadcrumbs',tab.path?tab.path.replace(/\.(?:md|base)$/i,'').replaceAll('/',' / '):''));
    const actions=el('div','view-actions');
    const baseSourcePath=tab.path;
    const changeBaseSource=(source:boolean)=>{if(generation!==this.vaultGeneration||pane.runtime!==runtime||pane.renderVersion!==version||this.current(pane)!==tab||tab.path!==baseSourcePath)return Promise.resolve();return this.setBaseSource(pane,source);};
    if(tab.kind==='note'&&(!tab.path||isMarkdown(tab.path)))actions.append(this.hotkeyButton(tab.mode==='reading'?'edit':'book','toggle-reading',tab.mode==='reading'?'Switch to Live Edit':'Switch to reading view',()=>this.run(()=>this.toggleReading(pane))));
    if(tab.kind==='note'&&tab.path&&/\.base$/i.test(tab.path))actions.append(button(tab.baseSource?'table':'edit',tab.baseSource?'Return to Base':'Edit source',()=>this.run(()=>changeBaseSource(!tab.baseSource)),'base-source-toggle'));
    actions.append(button('more','More options',event=>this.tabMenuAt(pane,event.currentTarget as HTMLElement)),button('rightbar','Toggle right sidebar',()=>this.toggleRight(),'pane-sidebar-toggle'));toolbar.append(actions);if(!this.platform.editorOnly)content.append(toolbar);
    if(tab.kind==='tasks'){
      if(this.tasksRetiring)return;
      const documents=this.platform.documentSemantics;
      if(!documents||!this.vault.adapter.durableWrites){content.append(el('p','muted','Tasks is not available for this vault on this platform.'));pane.viewReady=true;return;}
      const {createTasksView}=await import('../tasks/view.ts');
      await import('../tasks/styles.ts');
      if(this.tasksRetiring)return;
      if(!current()||version!==pane.renderVersion)return;
      const validate=()=>{if(generation!==this.vaultGeneration||this.platformReleased||pane.runtime!==runtime||runtime.phase==='disposed')throw new Error('The Tasks vault is no longer available.');};
      pane.tasksView=createTasksView(content,this.createTasksHost(documents,()=>pane,validate));
      await pane.tasksView.ready;if(!current()||version!==pane.renderVersion)return;
      pane.viewReady=true;this.renderStatus();return;
    }
    if(tab.kind==='calendar'){
      const {createCalendarView}=await import('../calendar/view.ts');
      await import('../calendar/styles.ts');
      if(!current()||version!==pane.renderVersion)return;
      pane.calendarView=createCalendarView(content,this.platform.workBlocks,tab.calendarState,state=>{tab.calendarState=state;if(current())this.saveSession();});
      pane.viewReady=true;return;
    }
    if(tab.kind==='graph'){this.renderGraph(content);pane.viewReady=true;return;}
    if(!tab.path){this.renderEmpty(pane,content);pane.viewReady=true;return;}
    const path=tab.path;
    if(!isMarkdown(path)){
      const host=el('div','attachment-view');content.append(host);
      host.oncontextmenu=event=>{
        // Child viewers own handled menus (for example a Base row's file).
        if(event.defaultPrevented)return;
        // Preserve the browser's playback menu on native controls.
        if((event.target as Element|null)?.closest?.('audio, video')){event.stopPropagation();return;}
        event.preventDefault();const entry=this.vault.entries.get(path);if(entry)this.fileMenu(entry,event.clientX,event.clientY);
      };
      if(/\.base$/i.test(path)){
        host.classList.add('base-attachment-view');Object.assign(host.style,{display:'flex',flexDirection:'column',minHeight:'0',overflow:'hidden',padding:'0'});
        try{
          await this.prepareBase(path,generation);if(version!==pane.renderVersion||!current())return;
          const vault=this.vault,fileToken=this.treeEntryToken(path),entryId=vault.entries.get(path)?.entryId,resources=this.attachments!;
          const validate=()=>{
            if(generation!==this.vaultGeneration||vault!==this.vault||pane.runtime!==runtime||runtime.phase==='disposed')throw new Error('The Base view is no longer open.');
            if(!fileToken||this.treeEntryToken(path)!==fileToken||vault.entries.get(path)?.type!=='file'||entryId&&vault.entries.get(path)?.entryId!==entryId)throw new Error('The Base file is no longer current.');
          };
          if(tab.baseSource){
            const buffer=await this.baseBufferFor(path,validate);validate();
            if(entryId&&buffer.savedDurableWitness&&buffer.savedDurableWitness.entryId!==entryId)throw new Error('The Base source belongs to a previous file. Its recovery draft is retained.');
            const findHost=el('div','note-find-host'),scroll=el('div','note-scroll base-source-view'),editorHost=el('div','editor-host');
            scroll.setAttribute('role','region');scroll.setAttribute('aria-label','Base source');scroll.append(editorHost);host.append(findHost,scroll);
            recoveryCleanup=this.mountNoteRecovery(host,buffer);
            const factory=this.editorFactory||(await import('./editor.ts')).createEditor;validate();
            const owns=()=>{validate();if(this.current(pane)!==tab||pane.renderVersion!==version||!pane.viewBaseSource||this.buffers.get(path)!==buffer||buffer.path!==path)throw new Error('The Base source editor changed.');};
            const canMutate=()=>{try{owns();return runtime.phase==='active'&&!!pane.content?.isConnected;}catch{return false;}};
            const nativeCurrent=()=>canMutate()&&this.activePane===pane&&!this.closing&&!this.root.inert&&!this.platformReleased;
            pane.editor=factory(editorHost,{value:buffer.text,mode:'source',paths:()=>[],open:()=>{},hotkeys:this.hotkeys,findPanelHost:findHost,canMutate,
              validateChange:next=>{owns();buffer.validateTextChange(next);},onChangeRejected:error=>notice(error instanceof Error?error.message:String(error)),
              ...(this.platform.nativeEditor?{isCurrent:nativeCurrent,onNativeEditorState:(state:NativeEditorState)=>{if(nativeCurrent())this.sendNativeEditorState(state);}}:{}),
              onChange:value=>{owns();this.updateMarkdownBuffer(buffer,value,owns);runtime.touch();for(const other of this.loadedViews())if(other!==pane&&other.viewPath===path&&other.viewBaseSource)other.editor?.setValue(value);this.renderStatus();}});
            editorHost.querySelector('.cm-content')?.setAttribute('aria-label','Base source');
            if(tab.viewState?.editor)pane.editor.restoreViewState?.(tab.viewState.editor);
            if(Number.isFinite(tab.viewState?.scrollTop))scroll.scrollTop=Math.max(0,tab.viewState!.scrollTop);
            if(Number.isFinite(tab.viewState?.scrollLeft))scroll.scrollLeft=Math.max(0,tab.viewState!.scrollLeft);
          }else{
            const recovery=el('div','base-source-recovery');recovery.hidden=true;
            recovery.append(el('p','','Edit this Base’s source to repair the configuration.'),textButton('Edit source',()=>this.run(()=>changeBaseSource(true)),'mod-cta'));host.append(recovery);
            const session=this.createWorkspaceBaseSession(host,path,()=>pane,validate,undefined,undefined,undefined,error=>{recovery.hidden=!error;});
            pane.baseView=session;await session.ready;
          }
        }catch(error){if(version===pane.renderVersion){host.append(el('p','error-message',error instanceof Error?error.message:String(error)));if(!tab.baseSource)host.append(textButton('Edit source',()=>this.run(()=>changeBaseSource(true))));}}
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
        const view=(this.viewFactories.pdf??createPdfView)(host,path,this.attachments!,{generateMarkdownLink:(subpath:string,alias:string)=>this.vault===vault&&pane.runtime===runtime&&runtime.phase!=='disposed'&&this.treeEntryToken(path)===fileToken?pdfMarkdownLink(vault,path,subpath,alias,this.settings):null,subpath:tab.subpath,mobile:matchMedia('(max-width: 700px)').matches,onPresentationSettled:nativePresentation,onOpenMenu:event=>{const entry=this.vault.entries.get(path);if(entry){const point=this.menuPoint(event);this.fileMenu(entry,point.x,point.y);}}});
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
      else host.append(el('p','muted native-unavailable-view',`No viewer is available yet for ${path.split('.').at(-1)?.toUpperCase()||'this file type'}.`));
      pane.viewReady=true;this.renderStatus();return;
    }
    const findHost=el('div','note-find-host');content.append(findHost);
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
      const buffer=await this.bufferFor(path,tab.expectedEntryId,()=>{if(!current()||version!==pane.renderVersion||this.current(pane)!==tab)throw new Error('The note render was superseded');});if(version!==pane.renderVersion)return;
      recoveryCleanup=this.mountNoteRecovery(content,buffer);
      {
        const host=el('div','properties-host');scroll.append(host);
        const vault=this.vault,fileToken=this.bufferEntries.get(buffer);
        const validateFile=()=>{if(vault!==this.vault||generation!==this.vaultGeneration||!fileToken||this.treeEntryToken(path)!==fileToken||this.buffers.get(path)!==buffer||buffer.path!==path)throw new Error('The property note was replaced or removed. Its draft is retained.');};
        const validateProperties=()=>{validateFile();if(pane.viewPath!==path||pane.renderVersion!==version||pane.runtime!==runtime||runtime.phase==='disposed')throw new Error('The property panel changed.');};
        const propertyCurrent=()=>{try{validateProperties();return true;}catch{return false;}};
        const targets=this.notePropertyTargets(()=>path,propertyCurrent,()=>pane.properties?.refresh());
        const properties=renderProperties(host,{vault:this.vault,path,getDefinitions:()=>targets.getDefinitions(),isManaged:()=>!!targets.getCollection(),collectionName:()=>targets.getCollection()?.collection.name,getRelationTargets:property=>targets.get(property),getDisplayValue:(property,raw)=>targets.getDisplayValue(property,raw),isCurrent:propertyCurrent,onError:error=>notice(error instanceof Error?error.message:String(error)),getSource:()=>buffer.text,onChange:async next=>{
          validateProperties();
          if(await this.changeManagedNoteProperties(buffer,next,targets,validateProperties)){for(const other of this.loadedViews())if(this.current(other)?.path===path){other.editor?.setValue(buffer.text);other.properties?.refresh();other.refreshPreview?.();}return;}
          this.updateMarkdownBuffer(buffer,next,validateFile);runtime.touch();
          for(const other of this.loadedViews()){if(this.current(other)?.path===path){other.editor?.setValue(next);other.refreshPreview?.();if(other!==pane)other.properties?.refresh();}}
          await buffer.flush();
        },openLink:(target,witness)=>this.run(()=>this.openPropertyLink(path,target,pane,witness))});
        pane.properties={...properties,refresh:()=>properties.refresh(),destroy:()=>{targets.destroy();properties.destroy();}};
      }
      const baseSessions=this.embeddedBases(()=>pane,()=>{if(generation!==this.vaultGeneration||pane.runtime!==runtime||runtime.phase==='disposed')throw new Error('The source note is closed.');});
      const createEmbeds=()=>new MarkdownEmbeds({bases:{sessions:baseSessions,identity:target=>this.treeEntryToken(target)},vault:this.vault,resources:this.attachments,pdfFactory:this.viewFactories.pdf,generatePdfLink:(target,fragment,alias)=>generation===this.vaultGeneration&&pane.runtime===runtime&&runtime.phase!=='disposed'?pdfMarkdownLink(this.vault,target,fragment,alias,this.settings):null,contextMenu:(event,request,source)=>{const target=this.vault.metadata.resolveLink(source,request.target,request.kind);const entry=target?this.vault.entries.get(target):undefined;if(entry){const point=this.menuPoint(event);event.preventDefault();event.stopPropagation();this.fileMenu(entry,point.x,point.y);}},open:(source,target,kind)=>this.run(()=>this.followLink(source,target,pane,kind)),read:async target=>{const loaded=this.buffers.get(target);if(loaded){await loaded.load();if(loaded.dirty)return loaded.text;}return this.vault.cachedRead(target);},taskChange:(target,line,checked)=>this.changeTask(target,line,checked)});
      if(tab.mode==='reading'){
        const preview=el('div','markdown-preview');preview.tabIndex=-1;scroll.append(preview);
        findHost.classList.add('zorid-reading-find-host');
        pane.readingFind=createReadingFind(findHost,preview,{isCurrent:()=>generation===this.vaultGeneration&&pane.renderVersion===version&&pane.viewPath===path&&pane.runtime===runtime&&runtime.phase!=='disposed'&&this.panes.includes(pane)&&this.current(pane)?.id===tab.id&&!this.closing&&!this.root.inert&&!this.platformReleased,returnFocus:()=>{if(this.activePane===pane)preview.focus({preventScroll:true});}});
        pane.refreshPreview=()=>{
          if(version!==pane.renderVersion||pane.viewPath!==path||!pane.runtime||pane.runtime.phase==='disposed')return;
          destroyMarkdown(preview);
          pane.embeds?.destroy();
          const embeds=createEmbeds();
          pane.embeds=embeds;
          try{
            renderMarkdown(preview,buffer.text,(target,kind)=>this.run(()=>this.followLink(path,target,pane,kind)),(line,checked)=>this.run(()=>this.changeTask(path,line,checked)),{embed:request=>embeds.render(request,path),base:request=>embeds.renderBase(request,path),properties:false});
          }catch(error){pane.readingFind?.close();destroyMarkdown(preview);embeds.destroy();if(pane.embeds===embeds)pane.embeds=undefined;throw error;}
          pane.readingFind?.refresh();
        };
        pane.refreshPreview();
      }else{
        const host=el('div','editor-host');scroll.append(host);
        const factory=this.editorFactory||(await import('./editor.ts')).createEditor;if(version!==pane.renderVersion)return;
        const embeds=createEmbeds();pane.embeds=embeds;const generation=this.vaultGeneration;
        const ownsEditor=()=>generation===this.vaultGeneration&&pane.renderVersion===version&&pane.viewPath===path;
        const nativeCurrent=()=>ownsEditor()&&this.activePane===pane&&pane.runtime===runtime&&runtime.phase!=='disposed'&&this.current(pane)?.id===tab.id&&!this.closing&&!this.root.inert&&!this.startupFailed&&!this.platformReleased;
        pane.editor=factory(host,{validateChange:next=>buffer.validateTextChange(next),onChangeRejected:error=>notice(error instanceof Error?error.message:String(error)),subscribeMetadata:this.subscribeDraftMetadata,findPanelHost:findHost,...(this.platform.nativeEditor?{isCurrent:nativeCurrent,onNativeEditorState:(state:NativeEditorState)=>{if(nativeCurrent())this.sendNativeEditorState(state);}}:{}),hotkeys:this.hotkeys,value:buffer.text,mode:tab.mode,paths:()=>ownsEditor()?[...this.vault.entries.keys()]:[],
          wiki:{sourcePath:()=>ownsEditor()?path:null,
            metadata:target=>{if(!ownsEditor())return;const metadata=this.buffers.get(target)?.getMetadata()??(this.buffers.has(target)?undefined:this.vault.metadata.get(target));return{aliases:metadata?.aliases,headings:metadata?.headings,mtime:this.vault.entries.get(target)?.mtime};},
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
          renderBase:(request,context)=>{const dom=embeds.renderBase(request,path,context);return{dom,destroy:()=>embeds.releaseEmbed(dom)};},
          transfers:{autoConvertHtml:()=>this.settings.autoConvertHtml,importFile:file=>this.importAttachment(file,path,generation),nativePath:file=>window.zorid?.getPathForFile?.(file)??'',onError:error=>notice(error instanceof Error?error.message:String(error))},
          onChange:value=>{this.updateMarkdownBuffer(buffer,value);runtime.touch();this.renderStatus();for(const other of this.loadedViews()){if(this.current(other)?.path===path){if(other!==pane)other.editor?.setValue(value);clearTimeout(other.propertyTimer);const properties=other.properties,preview=other.refreshPreview;other.propertyTimer=setTimeout(()=>{properties?.refresh();preview?.();},150);}}},open:(target,kind)=>{if(generation===this.vaultGeneration&&pane.renderVersion===version&&pane.viewPath===path)this.run(()=>this.followLink(path,target,pane,kind));}});
      }
      if(tab.viewState){if(tab.viewState.editor)pane.editor?.restoreViewState?.(tab.viewState.editor);if(Number.isFinite(tab.viewState.scrollTop))scroll.scrollTop=Math.max(0,tab.viewState.scrollTop);if(Number.isFinite(tab.viewState.scrollLeft))scroll.scrollLeft=Math.max(0,tab.viewState.scrollLeft);}
      if(buffer.error)this.noteStorageFailure(buffer.error);
    }catch(error){
      if(version!==pane.renderVersion)return;
      pane.readingFind?.destroy();pane.readingFind=undefined;destroyMarkdown(scroll);pane.embeds?.destroy();pane.embeds=undefined;pane.refreshPreview=undefined;
      console.error('Note could not be opened',error);
      scroll.append(el('p','error-message','This note couldn’t be opened. Please try opening it again.'));
    }
    if(version===pane.renderVersion)pane.viewReady=true;this.renderStatus();
  }

  private createWorkspaceBaseSession(host:HTMLElement,path:string,owner:()=>Pane,validate:()=>void,sourcePath?:string|SidebarBaseContext,viewName?:string,inline?:InlineBaseRequest,onSourceError?:(error:Error|null)=>void,onInlineSourceSaved?:(next:InlineBaseRequest)=>boolean,viewId?:string):BaseSession{
    const vault=this.vault,resources=this.attachments!;
    const sourceContext=typeof sourcePath==='object'?sourcePath:{path:sourcePath??path};
    const hover=createBaseFileHover({parent:host,isMac:this.hotkeys.platform==='mac',
      isCurrent:target=>{try{validate();const entry=vault.entries.get(target.path);return entry?.type==='file'&&entry.entryId===target.entryId&&entry.revision===target.revision;}catch{return false;}},
      getBuffer:async(target,admit)=>{validate();admit();if(!isMarkdown(target.path))return undefined;const buffer=await this.baseBufferFor(target.path,()=>{validate();admit();});admit();return buffer;},
      mount:(content,context)=>this.mountBaseFileHover(content,context,owner,validate),
      onError:error=>notice(error instanceof Error?error.message:String(error))});
    let captured=inline;const inlineOwner={};
    let inlineRetry:(()=>Promise<void>)|undefined,inlineRetryAvailable=()=>false;
    const inlineSource=inline?{
      captureSaveRetry:()=>inlineRetryAvailable()?inlineRetry:undefined,
      read:async()=>{validate();const request=captured!;const source=await vault.read(path);validate();if(source!==request.documentText)throw new Error('The containing note changed. Refresh this embedded Base.');return{source:request.source,startByte:new TextEncoder().encode(source.slice(0,request.from)).length,endByte:new TextEncoder().encode(source.slice(0,request.to)).length};},
      transform:async(expected:string,next:string,validateSelection:()=>void)=>{
        validate();validateSelection();const request=captured!;
        if(expected!==request.source&&next!==request.source)throw new Error('The fenced Base configuration changed.');
        const buffer=await this.baseBufferFor(path,validate);validateSelection();
        const desired=expected===request.source?replaceInlineBaseSource(request.documentText,request,next):request.documentText;
        const fresh=inlineBaseRequest(desired,request.from,request.to+desired.length-request.documentText.length);
        if(!fresh)throw new Error('The updated Base fence could not be retained.');
        this.deferInlinePublication(buffer);
        const existing=this.inlinePublications.get(buffer);
        if(existing){
          if(existing.owner!==inlineOwner||existing.text!==desired)throw new Error('Another embedded Base configuration owns the containing note save.');
          await existing.complete();return;
        }
        // The occurrence belongs to the complete latest draft, while physical
        // CAS belongs to its ORIGINAL saved baseline. A dirty body is allowed:
        // it is saved together with this exact fence edit, never used as proof
        // that an unseen external physical edit can be overwritten.
        const previous=buffer.text,savedText=buffer.savedText,witness=buffer.savedDurableWitness;
        const admitCapture=()=>{
          validate();validateSelection();
          const current=buffer.savedDurableWitness;
          if(captured!==request||this.buffers.get(path)!==buffer||buffer.path!==path||buffer.text!==request.documentText||buffer.savedText!==savedText||this.inlinePublications.has(buffer)||
            (witness? !current||current.entryId!==witness.entryId||current.revision!==witness.revision||current.path!==witness.path:!!current))throw new Error('The containing note changed before its Base configuration could be saved.');
        };
        admitCapture();
        const sourceCapture=witness?await buffer.captureConditionalSavedSource(witness,admitCapture):undefined;
        try{
          admitCapture();
          if(sourceCapture&&(sourceCapture.source!==savedText||sourceCapture.logicalWitness.entryId!==witness!.entryId||sourceCapture.logicalWitness.revision!==witness!.revision||sourceCapture.logicalWitness.path!==witness!.path))throw new Error('The saved containing note changed outside this editor. Refresh before editing its Base configuration.');
          // An already durable exact source needs no new intent or publication.
          if(desired===buffer.text&&!buffer.dirty&&!buffer.error)return;
          let completion:Promise<void>|undefined;
          const held={owner:inlineOwner,text:desired,failed:false,valid:true,complete:():Promise<void>=>{
            if(completion)return completion;
            held.failed=false;
            const operation=(async()=>{
              const admit=()=>{validate();if(!held.valid||this.inlinePublications.get(buffer)!==held||this.buffers.get(path)!==buffer||buffer.text!==desired||captured!==fresh)throw new Error('The containing note changed while its Base configuration was saved.');};
              try{
                admit();await buffer.flush();admit();
                if(buffer.savedText!==desired||buffer.dirty||buffer.error)throw new Error('The containing note changed while its Base configuration was saved.');
                if(onInlineSourceSaved&& !onInlineSourceSaved(fresh))throw new Error('The saved Base session is no longer current.');
                this.inlinePublications.delete(buffer);held.valid=false;
                this.bufferSubscriptions.publish(buffer);
                for(const pane of this.loadedViews())if(pane.viewPath===path){pane.editor?.setValue(desired);pane.properties?.refresh();pane.refreshPreview?.();}
              }catch(error){
                held.failed=true;
                // Release an obsolete clean hold without publishing from the
                // rejected actor. Independent validated readers can refresh later.
                if(this.inlinePublications.get(buffer)===held&&!buffer.dirty&&!buffer.error){this.inlinePublications.delete(buffer);held.valid=false;}
                throw error;
              }
            })();
            completion=operation;void operation.finally(()=>{if(completion===operation)completion=undefined;}).catch(()=>{});return operation;
          }};
          inlineRetryAvailable=()=>held.failed&&held.valid&&this.inlinePublications.get(buffer)===held;
          inlineRetry=async()=>{
            if((!held.failed&&!completion)||!held.valid||this.inlinePublications.get(buffer)!==held)throw new Error('The retained inline configuration changed. Refresh this embedded Base.');
            return held.complete();
          };
          this.inlinePublications.set(buffer,held);
          try{buffer.update(desired,{validateWrite:()=>{validate();validateSelection();},...(sourceCapture?{conditionalSavedSource:sourceCapture}:{})});}
          catch(error){if(this.inlinePublications.get(buffer)===held)this.inlinePublications.delete(buffer);held.valid=false;throw error;}
          captured=fresh;this.mapInactiveSelections(path,previous,desired);
          await held.complete();
        }finally{
          // Accepted captures belong to the exact retained NoteBuffer intent,
          // including uncertain replies. Only unused proofs remain ours.
          if(sourceCapture&&buffer.conditionalSavedSourceStatus(sourceCapture)==='unattached')await buffer.releaseConditionalSavedSource(sourceCapture);
        }
      }
    }:undefined;
    let session:BaseSession,composed:BaseSession|undefined;
    try{session=(this.viewFactories.base??createBaseSession)(host,{vault,basePath:path,validate,viewName,viewId,inlineSource,query:{currentFilePath:sourceContext.path,...(sourceContext.entryId?{currentFileEntryId:sourceContext.entryId}:{})},
            hoverFile:(row,event)=>{try{validate();const anchor=baseFileHoverAnchor(row,event);if(anchor)hover.hover(row,event,anchor);}catch(error){notice(error instanceof Error?error.message:String(error));}},
            ...(onSourceError?{onState:state=>onSourceError(state.error)}:{}),
            onEditsSettled:()=>{const sidebar=this.sidebarBase;if(sidebar&&sidebar.session===composed)this.retrySidebarFollowingContext(sidebar);},
            onViewRenamed:event=>{validate();const identity=this.treeEntryToken(event.basePath);if(!identity)return;for(const sessions of new Set([this.baseNewItemEmbeds,...this.baseHoverEmbeds,...this.loadedViews().map(pane=>pane.baseEmbeds)].filter((sessions):sessions is BaseEmbedSessions=>!!sessions)))sessions.renameViewBinding(event.basePath,event.from,event.to,identity,event.viewId);},
            closeCreatedFile:()=>this.baseNewItem?.element.contains(host)?false:this.closeBaseNewItem(),
            openCreatedFile:async(target,_event,anchor)=>{
              validate();
              // A nested Base's own New operation is still tracked by its
              // session. Release that operation before draining its parent.
              if(this.baseNewItem?.element.contains(host)){this.run(async()=>{await this.closeBaseNewItem();await this.openBaseNewItem(target,this.root);});return;}
              await this.openBaseNewItem(target,anchor??host,host);
            },
            buffers:{getBuffer:target=>this.baseBufferFor(target,validate),validate,
              onBufferChange:(target,buffer,previous)=>{
                this.mapInactiveSelections(target,previous,buffer.text);
                for(const embeds of new Set([...this.canvasMarkdownEmbeds,...this.loadedViews().flatMap(owner=>owner.embeds?[owner.embeds]:[])]))embeds.invalidate(target);
                for(const owner of this.loadedViews())if(owner.viewPath===target){owner.editor?.setValue(buffer.text);owner.properties?.refresh();owner.refreshPreview?.();}
              },
              rename:async(source,destination,validateResult,expectedWitness)=>{
                validate();validateResult();const token=this.treeEntryToken(source);
                // Calling Workspace.flush here would await this accepted Base
                // operation itself. Flush the shared buffers before Vault's queue.
                for(const buffer of this.buffers.values())await buffer.flush();
                await vault.rename(source,destination,()=>{validate();validateResult();if(!token||this.treeEntryToken(source)!==token)throw new Error('The moved file is no longer current.');this.requireAvailableTreePath(vault,destination,source);},expectedWitness);
              }},
            contextMenu:(row,event)=>{validate();const entry=vault.entries.get(row.path);if(row.entryId&&(entry?.entryId!==row.entryId||entry.revision!==row.revision))throw new Error('The selected file changed. Refresh before opening its menu.');if(entry){const point=this.menuPoint(event);this.fileMenu(entry,point.x,point.y);}},
            dragFile:(row,event)=>{validate();event.dataTransfer?.setData('text/plain',`[[${row.path.replace(/\.md$/i,'')}]]`);},
            deleteFiles:async(rows,result)=>{validate();const expected=rows.map(row=>({path:row.path,witness:sharedBaseWitness(result,row.path)}));if(!window.confirm(`Move ${rows.length} ${rows.length===1?'file':'files'} to trash?`))return;for(const item of expected){validate();const entry=vault.entries.get(item.path);if(!entry||item.witness&&(entry.entryId!==item.witness.entryId||entry.revision!==item.witness.revision))throw new Error('A selected file changed. Refresh before deleting.');}for(const item of expected){await this.buffers.get(item.path)?.flush();validate();const current=vault.entries.get(item.path);if(item.witness&&(current?.entryId!==item.witness.entryId||current?.revision!==item.witness.revision))throw new Error('A selected file changed before deletion.');await vault.trash(item.path);}},
            openFile:(target,event,witness)=>this.run(()=>{
              validate();
              if(/^[a-z][\w+.-]*:/i.test(target)||target.startsWith('//')){if(/^(?:https?:\/\/|mailto:|tel:)/i.test(target))window.open(target,'_blank','noopener,noreferrer');return;}
              const newTab=('button'in event&&event.button===1)||event.metaKey||event.ctrlKey;
              if(witness)return this.openPropertyLink(sourceContext.path??path,target,owner(),witness,newTab);
              return this.openNote(target,newTab,owner(),true,target.includes('#')?target.slice(target.indexOf('#')):'');
            }),
            loadThumbnail:async request=>{
              validate();if(request.signal.aborted)return null;
              const raw=request.property==='file.file'?request.row.path:request.value.type==='string'?request.value.value:request.value.type==='namespace'?request.value.presentation?.value??'':'';
              if(/^https?:\/\//i.test(raw)){try{const url=new URL(raw);if(url.hostname)return{url:url.href,dispose(){}};}catch{return null;}}
              const wiki=/^!?\[\[([^\r\n]*?)\]\]$/.exec(raw),link=wiki?wiki[1].split('|')[0]:raw;
              const witness=(request.value.type==='namespace'?request.value.presentation?.target:undefined)??(request.property==='file.file'&&request.row.entryId&&request.row.revision?{entryId:request.row.entryId,revision:request.row.revision}:undefined);
              const witnessed=witness?[...vault.entries.values()].find(entry=>entry.entryId===witness.entryId&&entry.revision===witness.revision&&entry.type==='file'):undefined;
              if(witness&&!witnessed)return null;
              const target=witnessed?.path??(vault.entries.has(raw)?raw:vault.metadata.resolveLink(request.row.path,link,'wiki'));
              if(!target||!isImage(target))return null;
              const token=this.treeEntryToken(target),lease=await resources.acquire(target);
              try{validate();if(request.signal.aborted||!token||this.treeEntryToken(target)!==token||witness&&(vault.entries.get(target)?.entryId!==witness.entryId||vault.entries.get(target)?.revision!==witness.revision)){lease.release();return null;}return{url:lease.url,dispose:()=>lease.release()};}catch(error){lease.release();throw error;}
            },onError:error=>notice(error instanceof Error?error.message:String(error))});}
    catch(error){void hover.destroy().catch(()=>{});throw error;}
    let flushing:Promise<void>|undefined,closing:Promise<void>|undefined,closed=false;
    const flush=(options?:Parameters<BaseSession['flush']>[0]):Promise<void>=>{if(closed)return Promise.resolve();if(closing)return closing;if(flushing)return options?.dismissCleanPanels?flushing.then(()=>flush(options)):flushing;const pending=Promise.resolve().then(async()=>{await this.finishInlinePublicationAt(path);await hover.flush();await session.flush(options);});flushing=pending;const clear=()=>{if(flushing===pending)flushing=undefined;};void pending.then(clear,clear);return pending;};
    const close=()=>{if(closed)return Promise.resolve();if(closing)return closing;const pending=Promise.resolve().then(async()=>{await flushing;await this.finishInlinePublicationAt(path);await hover.close();await session.close();await hover.destroy();closed=true;});closing=pending;const clear=()=>{if(closing===pending)closing=undefined;};void pending.then(clear,clear);return pending;};
    return composed={get ready(){return session.ready;},get state(){return session.state;},refresh:()=>session.refresh(),selectView:index=>session.selectView(index),setCurrentFile:(target,expectedEntryId)=>session.setCurrentFile(target,expectedEntryId),get selectedViewIdentity(){return session.selectedViewIdentity;},rebindViewName:(from,to,viewId)=>session.rebindViewName(from,to,viewId),flush,close,owns:node=>!closed&&!closing&&session.owns?.(node)===true,hasPendingChanges:()=>hover.hasPendingChanges()||session.hasPendingChanges()};
  }

  /** Base hover uses the ordinary shared draft, editor and embed save boundary. */
  private async mountBaseFileHover(host:HTMLElement,context:{target:BaseFileHoverTarget;buffer?:NoteBuffer;signal:AbortSignal;validate:()=>void;onStateChange:()=>void},owner:()=>Pane,validateOwner:()=>void):Promise<BaseFileHoverContent>{
    const {target,buffer,validate:validatePopup,onStateChange}=context;
    if(!buffer)return this.mountBaseFileHoverAttachment(host,context);
    const vault=this.vault,generation=this.vaultGeneration,path=target.path,token=this.treeEntryToken(path);
    let disposed=false,closing=false,editor:EditorHandle|undefined,loading:Promise<void>|undefined,snapshot=buffer.text,updating=false;
    const pending=new Set<Promise<unknown>>();
    const validateFile=()=>{if(vault!==this.vault||generation!==this.vaultGeneration||this.platformReleased||this.platformDrained||!token||this.treeEntryToken(path)!==token||vault.entries.get(path)?.entryId!==target.entryId||this.buffers.get(path)!==buffer||this.bufferEntries.get(buffer)!==token||buffer.path!==path||buffer.savedDurableWitness?.entryId!==target.entryId)throw new Error('The previewed note was replaced. Its draft is retained.');};
    const current=()=>{try{validateFile();return !disposed;}catch{return false;}};
    const admit=()=>{validateOwner();validatePopup();validateFile();if(disposed||closing||context.signal.aborted||!host.isConnected)throw new Error('The file preview is closing.');};
    const report=(error:unknown)=>notice(error instanceof Error?error.message:String(error));
    const track=<T>(operation:Promise<T>):Promise<T>=>{pending.add(operation);onStateChange();void operation.catch(report).finally(()=>{pending.delete(operation);onStateChange();});return operation;};
    admit();
    Object.assign(host.style,{position:'relative',padding:'32px'});
    const open=button('maximize','Open link',event=>this.run(async()=>{admit();await this.openNote(path,event.metaKey||event.ctrlKey,owner(),true,'',undefined,()=>{try{validateFile();return true;}catch{return false;}},target.entryId); }),'bases-file-hover-open');Object.assign(open.style,{position:'absolute',top:'8px',right:'8px'});host.append(open);
    const scroll=el('div','note-scroll'),preview=el('div','markdown-preview bases-file-hover-preview'),editorHost=el('div','editor-host bases-file-hover-editor'),propertiesHost=el('div','properties-host bases-file-hover-properties');
    Object.assign(scroll.style,{padding:'0',overflow:'visible',flex:'none'});propertiesHost.style.marginBottom='32px';
    scroll.classList.toggle('readable-width',this.settings.readableWidth);editorHost.hidden=true;scroll.append(preview,editorHost);host.append(scroll);
    host.insertBefore(propertiesHost,scroll);
    let properties:PropertiesView|undefined,propertyInputGeneration=0,expanded=false;
    const targets=this.notePropertyTargets(()=>path,()=>current()&&!disposed,()=>properties?.refresh());
    const syncPeers=()=>{for(const pane of this.loadedViews())if(pane.viewPath===path){pane.editor?.setValue(buffer.text);pane.properties?.refresh();pane.refreshPreview?.();}};
    properties=renderProperties(propertiesHost,{vault,path,getSource:()=>buffer.text,getDefinitions:()=>targets.getDefinitions(),isManaged:()=>!!targets.getCollection(),collectionName:()=>targets.getCollection()?.collection.name,isCurrent:()=>{try{admit();return true;}catch{return false;}},getRelationTargets:property=>targets.get(property),getDisplayValue:(property,raw)=>targets.getDisplayValue(property,raw),
      onChange:next=>{admit();return track((async()=>{if(await this.changeManagedNoteProperties(buffer,next,targets,admit)){syncPeers();properties?.refresh();return;}this.updateMarkdownBuffer(buffer,next,validateFile);syncPeers();await buffer.flush();})());},
      openLink:(target,witness)=>this.run(async()=>{admit();await this.openPropertyLink(path,target,owner(),witness);}),onError:report});
    const heading=propertiesHost.querySelector<HTMLElement>('.metadata-properties-heading')!,propertiesRoot=propertiesHost.querySelector<HTMLElement>('.metadata-container')!;
    const drawProperties=()=>{heading.replaceChildren(icon(expanded?'down':'right',16,host.ownerDocument),el('span','metadata-properties-title','Properties'));heading.setAttribute('role','button');heading.setAttribute('aria-expanded',String(expanded));propertiesRoot.classList.toggle('is-collapsed',!expanded);for(const node of propertiesRoot.querySelectorAll<HTMLElement>(':scope > .metadata-content,:scope > .metadata-add-button'))node.style.display=expanded?'':'none';onStateChange();};
    const toggleProperties=()=>{expanded=!expanded;drawProperties();};
    const propertiesKey=(event:KeyboardEvent)=>{if(!event.isComposing&&(event.key==='Enter'||event.key===' ')){event.preventDefault();toggleProperties();}};
    const propertyInput=()=>{propertyInputGeneration++;onStateChange();};heading.addEventListener('click',toggleProperties);heading.addEventListener('keydown',propertiesKey);propertiesHost.addEventListener('input',propertyInput);drawProperties();
    const propertyDraft=()=>properties?.hasPendingChanges()??false;
    const ownsPropertyPopover=(node:Node)=>properties?.owns(node)??false;
    const recoveryCleanup=this.mountNoteRecovery(host,buffer);
    const sessions=new BaseEmbedSessions({recoveryHost:host,create:async(container,nested)=>{
      const validate=()=>{validateFile();if(disposed||!nested.sourceIdentity||this.treeEntryToken(nested.sourcePath)!==nested.sourceIdentity||!nested.targetIdentity||this.treeEntryToken(nested.targetPath)!==nested.targetIdentity)throw new Error('The preview embedded Base changed. Its draft is retained.');};
      validate();await this.prepareBase(nested.targetPath,generation);validate();return this.createWorkspaceBaseSession(container,nested.targetPath,owner,validate,nested.sourcePath,nested.viewName||undefined,nested.inline,undefined,nested.onInlineSourceSaved,nested.viewId);
    }});this.baseHoverEmbeds.add(sessions);
    const task=(target:string,line:number,checked:boolean)=>{admit();const identity=this.treeEntryToken(target);const operation=this.changeTask(target,line,checked,()=>{validateFile();if(!identity||this.treeEntryToken(target)!==identity)throw new Error('The preview task changed.');});track(operation);return operation;};
    const embeds=new MarkdownEmbeds({vault,resources:this.attachments,bases:{sessions,identity:target=>this.treeEntryToken(target)},pdfFactory:this.viewFactories.pdf,
      read:async target=>{validateFile();const loaded=this.buffers.get(target);if(loaded){await loaded.load();validateFile();if(loaded.dirty)return loaded.text;}return vault.cachedRead(target);},
      open:(source,target,kind)=>this.run(async()=>{admit();await this.followLink(source,target,owner(),kind);}),
      taskChange:task,
      generatePdfLink:(target,fragment,alias)=>{validateFile();return pdfMarkdownLink(vault,target,fragment,alias,this.settings);},
      contextMenu:(event,request,source)=>{admit();const target=vault.metadata.resolveLink(source,request.target,request.kind),entry=target?vault.entries.get(target):undefined;if(entry){event.preventDefault();event.stopPropagation();const point=this.menuPoint(event);this.fileMenu(entry,point.x,point.y);}},
    });this.canvasMarkdownEmbeds.add(embeds);
    const previewChildren=new Set<HTMLElement>();
    const releasePreview=()=>{for(const child of previewChildren)embeds.releaseEmbed(child);previewChildren.clear();destroyMarkdown(preview);};
    const remember=(child:HTMLElement)=>{previewChildren.add(child);return child;};
    const render=()=>{releasePreview();renderMarkdown(preview,buffer.text,(target,kind)=>this.run(async()=>{admit();await this.followLink(path,target,owner(),kind);}), (line,checked)=>{task(path,line,checked);}, {properties:false,embed:request=>remember(embeds.render(request,path)),base:request=>remember(embeds.renderBase(request,path))});};
    const refresh=()=>{if(disposed||!current())return;if(!updating&&!this.deferInlinePublication(buffer)&&snapshot!==buffer.text){snapshot=buffer.text;if(editor)editor.setValue(snapshot);else render();}properties?.refresh();onStateChange();};
    const unsubscribe=this.bufferSubscriptions.subscribe(buffer,refresh);
    const openEditor=(event:MouseEvent)=>{
      if(event.button!==0||event.defaultPrevented||event.metaKey||event.ctrlKey||event.altKey||loading||editor)return;
      const node=event.target instanceof host.ownerDocument.defaultView!.Element?event.target:null;
      if(node?.closest('a,button,input,textarea,select,summary,[contenteditable],.internal-embed,.base-embed-session,.interactive-child'))return;
      if(host.ownerDocument.getSelection()?.isCollapsed===false)return;
      try{admit();}catch(error){report(error);return;}
      const point={x:event.clientX,y:event.clientY};
      loading=Promise.resolve().then(async()=>{
        const factory=this.editorFactory??(await import('./editor.ts')).createEditor;admit();snapshot=buffer.text;
        const handle=factory(editorHost,{value:snapshot,mode:'live',hotkeys:this.hotkeys,subscribeMetadata:this.subscribeDraftMetadata,paths:()=>current()?[...vault.entries.keys()]:[],
          canMutate:()=>{try{admit();return true;}catch{return false;}},validateChange:next=>{admit();if(buffer.text!==snapshot)throw new Error('The preview changed in another editor.');buffer.validateTextChange(next);},onChangeRejected:report,
          onChange:next=>{admit();if(buffer.text!==snapshot)throw new Error('The preview changed in another editor.');updating=true;try{this.updateMarkdownBuffer(buffer,next,validateFile);snapshot=buffer.text;syncPeers();}finally{updating=false;}properties?.refresh();onStateChange();},
          open:(target,kind)=>this.run(async()=>{admit();await this.followLink(path,target,owner(),kind);}),isUnresolved:(target,kind)=>!vault.metadata.resolveLink(path,target,kind),
          wiki:{sourcePath:()=>path,metadata:target=>{validateFile();const metadata=this.buffers.get(target)?.getMetadata()??vault.metadata.get(target);return{aliases:metadata?.aliases,headings:metadata?.headings,mtime:vault.entries.get(target)?.mtime};},resolvePath:(target,source)=>vault.metadata.resolveLink(source,target)},
          listOptions:{useTab:this.settings.useTab,tabSize:this.settings.tabSize,smartIndentList:this.settings.smartIndentList},
          renderEmbed:(request,context)=>{admit();const dom=embeds.render(request,path,[],undefined,context);return{dom,destroy:()=>embeds.releaseEmbed(dom)};},renderBase:(request,context)=>{admit();const dom=embeds.renderBase(request,path,context);return{dom,destroy:()=>embeds.releaseEmbed(dom)};},
          transfers:{autoConvertHtml:()=>this.settings.autoConvertHtml,importFile:async file=>{admit();const result=await this.importAttachment(file,path,generation);admit();return result;},nativePath:file=>window.zorid?.getPathForFile?.(file)??'',onError:report},
        });
        editor=handle;releasePreview();preview.hidden=true;editorHost.hidden=false;
        const {EditorView}=await import('@codemirror/view');admit();const element=editorHost.querySelector<HTMLElement>('.cm-editor'),view=element?EditorView.findFromDOM(element):null;
        if(view){let position:number|null=null;try{position=view.posAtCoords(point);}catch{/* Native/injected editors may not expose layout coordinates. */}if(position!==null)view.dispatch({selection:EditorSelection.single(position)});}
        handle.focus();onStateChange();
      }).catch(report).finally(()=>{loading=undefined;onStateChange();});
    };
    preview.addEventListener('click',openEditor);
    try{render();}catch(error){unsubscribe();recoveryCleanup();properties.destroy();targets.destroy();embeds.destroy();this.canvasMarkdownEmbeds.delete(embeds);this.baseHoverEmbeds.delete(sessions);await sessions.close();throw error;}
    return{isCurrent:current,owns:node=>host.contains(node)||sessions.owns(node)||ownsPropertyPopover(node)||!!this.baseNewItemAnchor?.isConnected&&host.contains(this.baseNewItemAnchor)&&!!this.baseNewItem?.element.isConnected&&(this.baseNewItem.element.contains(node)||this.baseNewItemEmbeds?.owns(node)===true),hasPendingChanges:()=>!!loading||!!pending.size||buffer.dirty||!!buffer.error||buffer.hasRecoveryConflict||sessions.hasPendingChanges()||propertyDraft(),
      flush:async()=>{await loading;const focused=host.ownerDocument.activeElement as HTMLElement|null;if(focused&&(host.contains(focused)||ownsPropertyPopover(focused)))focused.blur();await Promise.resolve();await Promise.resolve();const inputGeneration=propertyInputGeneration;await properties?.flush();while(pending.size)await Promise.all([...pending]);await sessions.flush();if(buffer.dirty){validateFile();buffer.update(buffer.text,{validateWrite:validateFile});}await buffer.flush();if(inputGeneration!==propertyInputGeneration)throw new Error('Property input changed while saving; finish the edit before closing.');},
      dispose:async()=>{if(disposed)return;closing=true;try{await sessions.close();await targets.close();}catch(error){closing=false;throw error;}disposed=true;preview.removeEventListener('click',openEditor);heading.removeEventListener('click',toggleProperties);heading.removeEventListener('keydown',propertiesKey);propertiesHost.removeEventListener('input',propertyInput);properties?.destroy();targets.destroy();unsubscribe();recoveryCleanup();editor?.destroy();destroyMarkdown(preview);embeds.destroy();this.canvasMarkdownEmbeds.delete(embeds);this.baseHoverEmbeds.delete(sessions);},
    };
  }

  private mountBaseFileHoverAttachment(host:HTMLElement,{target,signal,validate}:{target:BaseFileHoverTarget;signal:AbortSignal;validate:()=>void}):BaseFileHoverContent{
    const vault=this.vault,generation=this.vaultGeneration,path=target.path,token=this.treeEntryToken(path),resources=this.attachments!;
    let disposed=false,child:{destroy():void}|undefined;const leases=new Set<AttachmentLease>(),layers=new Set<Element>();
    const check=()=>{const entry=vault.entries.get(path);if(disposed||signal.aborted||vault!==this.vault||generation!==this.vaultGeneration||this.platformReleased||!token||this.treeEntryToken(path)!==token||entry?.entryId!==target.entryId||entry.revision!==target.revision)throw new Error('The preview attachment changed.');};
    const available=()=>{try{check();return true;}catch{return false;}};
    const report=(error:unknown)=>{if(!disposed&&!signal.aborted)notice(error instanceof Error?error.message:String(error));};
    const guarded={acquire:async(requested:string)=>{check();validate();if(requested!==path)throw new Error('The preview attachment target changed.');const source=await resources.acquire(path);try{check();validate();}catch(error){source.release();throw error;}let released=false;const lease:AttachmentLease={url:source.url,type:source.type,release:()=>{if(released)return;released=true;leases.delete(lease);source.release();},...(source.arrayBuffer?{arrayBuffer:async()=>{check();if(released)throw new Error('The preview attachment was released.');const bytes=await source.arrayBuffer!();check();if(released)throw new Error('The preview attachment was released.');return bytes;}}:{})};leases.add(lease);return lease;}} as AttachmentResources;
    const release=()=>{for(const lease of [...leases])lease.release();};signal.addEventListener('abort',release,{once:true});
    try{
      check();
      if(isImage(path)){
        child=createImageView(host,path,guarded,{onError:report,isMac:this.hotkeys.platform==='mac'});
        const image=host.querySelector('img'),open=image?.onclick;if(image&&open)image.onclick=function(event){const previous=new Set(host.ownerDocument.querySelectorAll('.image-lightbox'));open.call(this,event);for(const layer of host.ownerDocument.querySelectorAll('.image-lightbox'))if(!previous.has(layer))layers.add(layer);};
      }else if(/\.pdf$/i.test(path)){
        const view=(this.viewFactories.pdf??createPdfView)(host,path,guarded,{embed:true,height:'auto',generateMarkdownLink:(fragment,alias)=>available()?pdfMarkdownLink(vault,path,fragment,alias,this.settings):null,onError:report});child=view;void view.ready.catch(report);
      }else if(mediaKind(path)){
        const view=(this.viewFactories.media??createMediaView)(host,path,guarded);child=view;void view.ready.catch(report);
      }else host.append(el('p','muted bases-file-hover-unavailable','Preview is unavailable for this file type.'));
    }catch(error){child?.destroy();release();signal.removeEventListener('abort',release);throw error;}
    return{isCurrent:available,hasPendingChanges:()=>false,flush:async()=>{},owns:node=>host.contains(node)||[...layers].some(layer=>layer.isConnected&&layer.contains(node)),dispose:()=>{if(disposed)return;disposed=true;signal.removeEventListener('abort',release);child?.destroy();release();for(const layer of layers)layer.remove();layers.clear();}};
  }

  private async flushBaseNewItem():Promise<void>{await this.baseNewItemOpening;await this.finishInlinePublicationAt(this.baseNewItem?.path);await this.baseNewItem?.flush();}
  private notePropertyTargets(getPath:()=>string,isCurrent:()=>boolean,onChange:()=>void):NotePropertyTargets{
    const vault=this.vault,session=createNotePropertyTargets({vault,getPath,isCurrent,onChange}),owner={vault,session};this.notePropertyQueries.add(owner);
    return{...session,destroy:()=>{session.destroy();void session.close().then(()=>this.notePropertyQueries.delete(owner),()=>{});},close:async()=>{await session.close();this.notePropertyQueries.delete(owner);}};
  }
  private async closeBaseNewItem():Promise<boolean>{
    await this.baseNewItemOpening;
    const current=this.baseNewItem;if(!current)return false;
    await current.close();return true;
  }
  private openBaseNewItem(path:string,anchor:HTMLElement,ownershipHost:HTMLElement=anchor):Promise<void>{
    if(this.baseNewItemOpening)return this.baseNewItemOpening.then(()=>this.openBaseNewItem(path,anchor,ownershipHost));
    const vault=this.vault,generation=this.vaultGeneration;
    const opening=Promise.resolve().then(async()=>{
      await this.baseNewItem?.close();
      let disposed=false,buffer:NoteBuffer|undefined;
      const validate=()=>{
        if(disposed||vault!==this.vault||generation!==this.vaultGeneration||this.platformReleased||this.platformDrained)throw new Error('The new-item vault is no longer available.');
        if(buffer&&(this.buffers.get(buffer.path)!==buffer||vault.entries.get(buffer.path)?.type!=='file'))throw new Error('The new-item note changed. Its draft is retained.');
      };
      buffer=await this.baseBufferFor(path,validate);validate();
      const shared=buffer,entryId=shared.savedDurableWitness?.entryId??vault.entries.get(path)?.entryId;
      const validateFile=()=>{validate();const token=this.treeEntryToken(shared.path);if(!token||this.bufferEntries.get(shared)!==token||entryId&&vault.entries.get(shared.path)?.entryId!==entryId)throw new Error('The new-item note was replaced. Its draft is retained.');};
      const recovery=el('div','bases-new-item-embed-recovery');
      const sessions=new BaseEmbedSessions({recoveryHost:recovery,create:async(container,target)=>{
        const validateEmbed=()=>{validateFile();if(!target.sourceIdentity||this.treeEntryToken(target.sourcePath)!==target.sourceIdentity||!target.targetIdentity||this.treeEntryToken(target.targetPath)!==target.targetIdentity)throw new Error('The embedded Base source changed. Its draft is retained.');};
        validateEmbed();await this.prepareBase(target.targetPath,generation);validateEmbed();
        return this.createWorkspaceBaseSession(container,target.targetPath,()=>this.activePane,validateEmbed,target.sourcePath,target.viewName||undefined,target.inline,undefined,target.onInlineSourceSaved,target.viewId);
      }});
      this.baseNewItemEmbeds=sessions;
      const embeds=new MarkdownEmbeds({vault,resources:this.attachments,bases:{sessions,identity:target=>this.treeEntryToken(target)},
        open:(source,target,kind)=>this.run(async()=>{validateFile();await this.followLink(source,target,this.activePane,kind);}),
        read:async target=>{validateFile();const loaded=this.buffers.get(target);if(loaded){await loaded.load();validateFile();if(loaded.dirty)return loaded.text;}return vault.cachedRead(target);},
        taskChange:(target,line,checked)=>this.changeTask(target,line,checked,validateFile),
        pdfFactory:this.viewFactories.pdf,generatePdfLink:(target,fragment,alias)=>{validateFile();return pdfMarkdownLink(vault,target,fragment,alias,this.settings);},
        contextMenu:(event,request,source)=>{validateFile();const target=vault.metadata.resolveLink(source,request.target,request.kind),entry=target?vault.entries.get(target):undefined;if(entry){const point=this.menuPoint(event);event.preventDefault();event.stopPropagation();this.fileMenu(entry,point.x,point.y);}},
      });
      this.canvasMarkdownEmbeds.add(embeds);
      let popup:BaseNewItemPopoverHandle|undefined,observedPath=shared.path;
      const targets=this.notePropertyTargets(()=>shared.path,()=>{try{validateFile();return true;}catch{return false;}},()=>popup?.refresh());
      const remounts=new Set<()=>void>();
      const renderChild=(create:()=>HTMLElement)=>{
        const host=el('div','bases-new-item-editor-embed');let node:HTMLElement|undefined,closed=false;
        const mount=()=>{if(closed)return;if(node)embeds.releaseEmbed(node);node=create();host.replaceChildren(node);};
        mount();remounts.add(mount);
        return{dom:host,destroy:()=>{if(closed)return;closed=true;remounts.delete(mount);if(node)embeds.releaseEmbed(node);}};
      };
      const cleanup=()=>{disposed=true;if(this.baseNewItemEmbeds===sessions)this.baseNewItemEmbeds=undefined;targets.destroy();embeds.destroy();this.canvasMarkdownEmbeds.delete(embeds);remounts.clear();if(this.baseNewItem===popup){this.baseNewItem=undefined;this.baseNewItemAnchor=undefined;}};
      try{
        popup=await openBaseNewItemPopover({anchor,vault,path,getBuffer:async target=>{validateFile();if(target!==shared.path)throw new Error('The new note moved before opening.');return shared;},validate:validateFile,
          rename:async(source,destination,validateSelection,witness)=>{
            validateFile();validateSelection();await sessions.flush();const token=this.treeEntryToken(source);await shared.flush();
            await vault.rename(source,destination,()=>{validateFile();validateSelection();if(!token||this.treeEntryToken(source)!==token||shared.path!==source)throw new Error('The renamed note is no longer current.');this.requireAvailableTreePath(vault,destination,source);},witness);
            await shared.relocate(destination);
          },
          deferSourceUpdate:()=>this.deferInlinePublication(shared),
          ownsEditorPortal:node=>sessions.owns(node),
          subscribeBuffer:(target,listener)=>this.bufferSubscriptions.subscribe(target,()=>{
            if(shared.path!==observedPath){observedPath=shared.path;for(const remount of [...remounts])remount();}
            listener();
            for(const pane of this.loadedViews())if(pane.viewPath===shared.path){pane.editor?.setValue(shared.text);pane.properties?.refresh();pane.refreshPreview?.();}
          }),
          changeProperties:(next,buffer)=>this.changeManagedNoteProperties(buffer,next,targets,validateFile),
          properties:{getDefinitions:()=>targets.getDefinitions(),isManaged:()=>!!targets.getCollection(),collectionName:()=>targets.getCollection()?.collection.name,getRelationTargets:property=>targets.get(property),getDisplayValue:(property,raw)=>targets.getDisplayValue(property,raw)},
          flushEditor:()=>sessions.flush(),hasPendingEditorChanges:()=>sessions.hasPendingChanges(),closeEditor:async()=>{await sessions.close();await targets.close();},
          openFile:async(target,event,witness)=>{validateFile();const newTab=('button'in event&&event.button===1)||event.metaKey||event.ctrlKey;if(witness){await this.openPropertyLink(shared.path,target,this.activePane,witness,newTab);return;}const resolved=vault.entries.has(target)?target:vault.metadata.resolveLink(shared.path,target,'wiki');if(!resolved)throw new Error('The linked note is unavailable.');await this.openNote(resolved,newTab,this.activePane);},
          editorFactory:(parent,options)=>this.editorFactory?this.editorFactory(parent,options):import('./editor.ts').then(module=>module.createEditor(parent,options)),
          editorOptions:{hotkeys:this.hotkeys,subscribeMetadata:this.subscribeDraftMetadata,paths:()=>{validateFile();return[...vault.entries.keys()];},
            listOptions:{useTab:this.settings.useTab,tabSize:this.settings.tabSize,smartIndentList:this.settings.smartIndentList},
            open:(target,kind='wiki')=>this.run(async()=>{validateFile();await this.followLink(shared.path,target,this.activePane,kind);}),
            isUnresolved:(target,kind)=>!vault.metadata.resolveLink(shared.path,target,kind),
            wiki:{sourcePath:()=>shared.path,metadata:target=>{validateFile();const metadata=this.buffers.get(target)?.getMetadata()??vault.metadata.get(target);return{aliases:metadata?.aliases,headings:metadata?.headings,mtime:vault.entries.get(target)?.mtime};},resolvePath:(target,source)=>vault.metadata.resolveLink(source,target)},
            renderEmbed:(request,context)=>renderChild(()=>{validateFile();return embeds.render(request,shared.path,[],undefined,context);}),
            renderBase:(request,context)=>renderChild(()=>{validateFile();return embeds.renderBase(request,shared.path,context);}),
            transfers:{autoConvertHtml:()=>this.settings.autoConvertHtml,importFile:async file=>{validateFile();const result=await this.importAttachment(file,shared.path,generation);validateFile();return result;},nativePath:file=>window.zorid?.getPathForFile?.(file)??'',onError:error=>notice(error instanceof Error?error.message:String(error))},
          },onError:error=>notice(error instanceof Error?error.message:String(error)),onClose:cleanup,
        });
        validateFile();popup.element.append(recovery);this.baseNewItem=popup;this.baseNewItemAnchor=ownershipHost;
      }catch(error){if(popup?.element.isConnected){this.baseNewItem=popup;this.baseNewItemAnchor=ownershipHost;throw error;}cleanup();await sessions.close();throw error;}
    });
    this.baseNewItemOpening=opening;
    const clear=()=>{if(this.baseNewItemOpening===opening)this.baseNewItemOpening=undefined;};void opening.then(clear,clear);
    return opening;
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
      return this.createWorkspaceBaseSession(container,target.targetPath,owner,validate,target.sourcePath,target.viewName||undefined,target.inline,undefined,target.onInlineSourceSaved,target.viewId);
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
    const options:Omit<EditorOptions,'value'|'mode'|'onChange'>={onChangeRejected:error=>notice(error instanceof Error?error.message:String(error)),subscribeMetadata:this.subscribeDraftMetadata,hotkeys:this.hotkeys,paths:()=>available()?[...vault.entries.keys()]:[],open,
        get listOptions(){return{useTab:workspace.settings.useTab,tabSize:workspace.settings.tabSize,smartIndentList:workspace.settings.smartIndentList};},
        isUnresolved:(target,kind)=>!available()||!vault.metadata.resolveLink(path,target,kind),
        wiki:{sourcePath:()=>available()?path:null,
          metadata:target=>{if(!available())return;const metadata=this.buffers.get(target)?.getMetadata()??(this.buffers.has(target)?undefined:vault.metadata.get(target));return{aliases:metadata?.aliases,headings:metadata?.headings,mtime:vault.entries.get(target)?.mtime};},
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
    if(this.tasksRetiring)return;
    const source=this.panes.find(pane=>pane.id===intent.sourcePaneId),target=this.panes.find(pane=>pane.id===intent.targetPaneId);
    const tab=source?.tabs.find(tab=>tab.id===intent.tabId),layout=this.splitLayout;
    if(!source||!target||!tab||!layout||!['center','left','right','top','bottom'].includes(intent.edge))return;
    const cached=this.cachedViews.get(tab);
    if(cached&&(cached.viewPath!==tab.path||cached.viewMode!==tab.mode||cached.viewKind!==tab.kind||!!cached.viewBaseSource!==!!tab.baseSource)){
      await this.disposePaneViews(cached);if(this.cachedViews.get(tab)===cached)this.cachedViews.delete(tab);
      if(!this.panes.includes(source)||!this.panes.includes(target)||!source.tabs.includes(tab))return;
    }
    if(this.tasksRetiring)return;
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
    pane.viewTabId=undefined;pane.viewPath=undefined;pane.viewMode=undefined;pane.viewKind=undefined;pane.viewBaseSource=undefined;pane.viewReady=false;pane.rebindView=undefined;pane.content=undefined;pane.runtime=undefined;
    pane.editor=undefined;pane.imageView=undefined;pane.pdfView=undefined;pane.mediaView=undefined;pane.canvasView=undefined;pane.baseView=undefined;pane.calendarView=undefined;pane.tasksView=undefined;pane.canvasSource=undefined;pane.baseEmbeds=undefined;pane.embeds=undefined;pane.properties=undefined;pane.refreshPreview=undefined;pane.readingFind=undefined;pane.propertyTimer=undefined;
    pane.renderVersion=++this.viewSequence;
  }
  private parkPaneView(pane:Pane,keepConnected=false):void{
    const tab=pane.tabs.find(tab=>tab.id===pane.viewTabId);
    if(!tab||!pane.content||!pane.runtime)return;
    this.capturePaneState(pane);
    const parked:Pane={...pane,tabs:[tab],active:tab.id,history:[...pane.history],element:pane.content};
    pane.rebindView?.(parked);parked.readingFind?.refresh();this.cachedViews.set(tab,parked);
    if(!keepConnected)pane.runtime.detach();
    this.clearPaneViewFields(pane);
  }
  /** No await between attachment and owner rebinding. Failed attach leaves the
   * cached owner/resources intact so the caller can roll back its tab model. */
  private restoreCachedViewNow(pane:Pane,tab:Tab):boolean{
    const cached=this.cachedViews.get(tab);if(!cached?.runtime||!cached.content)return false;
    const connected=cached.content.isConnected;
    cached.runtime.attach(pane.element,this.viewOwner(pane));
    const fields=['viewTabId','viewPath','viewMode','viewKind','viewBaseSource','viewReady','viewSettings','rebindView','editor','imageView','pdfView','mediaView','canvasView','baseView','calendarView','tasksView','canvasSource','baseEmbeds','embeds','properties','refreshPreview','readingFind','propertyTimer','renderVersion','runtime','content'] as const;
    for(const key of fields)(pane as unknown as Record<string,unknown>)[key]=cached[key];
    pane.history=tab.history??cached.history;pane.historyIndex=tab.historyIndex??cached.historyIndex;
    pane.rebindView?.(pane);this.cachedViews.delete(tab);this.applyViewSettings(pane);pane.readingFind?.refresh();
    const saved=tab.viewState?.editor,current=pane.editor?.getViewState?.();
    if(!connected&&saved&&current&&JSON.stringify(saved.selection)!==JSON.stringify(current.selection))pane.editor?.restoreViewState?.({...current,selection:saved.selection});
    return true;
  }
  private async restoreCachedView(pane:Pane,tab:Tab):Promise<boolean>{
    const cached=this.cachedViews.get(tab);if(!cached)return false;
    if(cached.viewPath!==tab.path||cached.viewMode!==tab.mode||cached.viewKind!==tab.kind||!!cached.viewBaseSource!==!!tab.baseSource){
      await this.disposePaneViews(cached);this.cachedViews.delete(tab);return false;
    }
    return this.restoreCachedViewNow(pane,tab);
  }
  private async prepareTasksViewsClose():Promise<(recover?:boolean)=>void>{
    if(this.tasksRetiring)throw new Error('Tasks retirement is already in progress.');
    const wasInert=this.root.inert;this.tasksRetiring=true;this.root.inert=true;
    const views=[...new Set(this.loadedViews().flatMap(pane=>pane.tasksView?[pane.tasksView]:[]))];let finished=false;
    const cancel=(recover=true)=>{
      if(finished)return;finished=true;
      for(const view of views)if(this.loadedViews().some(pane=>pane.tasksView===view))view.cancelClose();
      this.tasksRetiring=false;this.root.inert=wasInert;
      if(recover&&this.initialized&&!this.platformReleased)for(const pane of this.panes)if(this.current(pane)?.kind==='tasks'&&!pane.tasksView)this.run(()=>this.renderPane(pane,{flush:false,refresh:true}));
    };
    try{for(const view of views)await view.prepareClose();return cancel;}catch(error){cancel();throw error;}
  }
  private async clearCachedViews():Promise<void>{for(const [tab,pane] of this.cachedViews){await this.disposePaneViews(pane);this.cachedViews.delete(tab);}}
  private releasePaneView(pane:Pane,content:HTMLElement):void{
    if(pane.runtime){this.nativePresentations.get(pane.runtime)?.dispose();this.nativePresentations.delete(pane.runtime);}
    this.capturePaneState(pane);pane.readingFind?.destroy();destroyMarkdown(content);
    clearTimeout(pane.propertyTimer);pane.editor?.destroy();pane.imageView?.destroy();pane.pdfView?.destroy();pane.mediaView?.destroy();pane.canvasView?.destroy();pane.calendarView?.destroy();pane.embeds?.destroy();pane.properties?.destroy();this.clearPaneViewFields(pane);
  }
  private async disposePaneViews(pane:Pane):Promise<void>{
    if(pane.runtime){await pane.canvasView?.flush();try{await pane.runtime.destroy();}catch(error){pane.tasksView?.cancelClose();throw error;}}
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
    const at=marker[1].length;lines[line]=lines[line].slice(0,at)+(checked?'x':' ')+lines[line].slice(at+1);this.updateMarkdownBuffer(buffer,lines.join('\n'),validate);await buffer.flush();
    for(const pane of this.loadedViews()){if(pane.viewPath===path){if(pane.viewMode==='reading')pane.refreshPreview?.();else pane.editor?.setValue(buffer.text);}}
  }

  private renderEmpty(pane:Pane,host=pane.element):void{
    const empty=el('div','empty-state');
    const actions=el('div','empty-actions');
    for(const [label,shortcut,action]of [['Create new file','new-note',()=>this.run(()=>this.newNote())],['Go to file','quick-switcher',()=>this.quickSwitcher()],['Open command palette','command-palette',()=>this.commandPalette()]] as const){const row=textButton(label,action,'empty-action');const hint=el('kbd','',this.hotkeys.label(shortcut));hint.dataset.hotkeyCommand=shortcut;hint.hidden=!hint.textContent;row.append(hint);actions.append(row);}empty.append(actions);host.append(empty);
  }

  private renderSidebar():void{
    const retained=this.treeTab==='search'&&!this.documentSearchSuspended&&this.richDocumentSearch?.vault===this.vault
      &&this.richDocumentSearch.service===this.vault?.adapter.documentSemantics?this.richDocumentSearch:undefined;
    this.clearDocumentSearch(!!retained);
    if(!this.vault)return;
    const fileTools=this.sidebar.querySelector<HTMLElement>(':scope > .sidebar-toolbar');if(fileTools)fileTools.hidden=this.treeTab==='search';
    this.sidebarContent.classList.toggle('is-document-search',this.treeTab==='search'&&this.vault.adapter.documentSemantics?.richSearchAvailable===true);
    const activePath=this.activePane&&this.current()?.path;
    if(this.autoRevealFiles&&activePath){let folder=parentOf(activePath);while(folder){this.collapsed.delete(folder);folder=parentOf(folder);}}
    const autoReveal=this.sidebar.querySelector<HTMLButtonElement>('[data-action="auto-reveal"]');autoReveal?.classList.toggle('is-active',this.autoRevealFiles);autoReveal?.setAttribute('aria-pressed',String(this.autoRevealFiles));
    const folders=[...this.vault.entries.values()].filter(entry=>entry.type==='folder'),allCollapsed=folders.length>0&&folders.every(entry=>this.collapsed.has(entry.path));
    const collapse=this.sidebar.querySelector<HTMLButtonElement>('[data-action="collapse-all"]');
    if(collapse){const label=allCollapsed?'Expand all folders':'Collapse all folders';collapse.title=label;collapse.setAttribute('aria-label',label);collapse.replaceChildren(icon(allCollapsed?'chevrons-up-down':'chevrons-down-up'));}
    this.sidebar.querySelectorAll<HTMLElement>('.sidebar-tabs button').forEach(node=>node.classList.toggle('is-active',node.dataset.type===this.treeTab));
    const renameHadFocus=!!this.treeRename&&this.sidebarContent.contains(this.root.ownerDocument.activeElement)&&this.root.ownerDocument.activeElement?.getAttribute('contenteditable')==='true';
    this.treeRows=[];
    if(retained){retained.controller?.setSpec({...this.richSearchSpec,query:this.query});return;}
    this.sidebarContent.replaceChildren();
    if(this.treeTab==='search'){
      const service=this.vault.adapter.documentSemantics;
      if(service?.richSearchAvailable){
        const vault=this.vault,scope=String(++this.searchGeneration),mount={vault,service} as NonNullable<Workspace['richDocumentSearch']>;
        this.richDocumentSearch=mount;
        const current=()=>this.richDocumentSearch===mount&&this.vault===vault&&this.treeTab==='search'&&!this.documentSearchSuspended&&!this.platformReleased&&!this.closing;
        const controller=mountDocumentSearch(this.sidebarContent,{service,scopeId:scope,spec:{...this.richSearchSpec,query:this.query},isCurrent:current,
          acquireFresh:async(isCurrent,rebuild,signal)=>{const value=await catchUpDocumentIndex(service,{isCurrent,rebuild,signal});if(value.rebuildRequired)throw new DocumentSemanticsError('rebuild_required');return !!value.snapshot;},
          beforeOpen:async()=>{for(const owner of this.richDocumentSearchOwners)if(owner.vault===vault&&owner.controller!==mount.controller&&owner.controller.service===service){await owner.controller.close();this.richDocumentSearchOwners.delete(owner);}},
          onSpec:spec=>{if(current()){this.richSearchSpec=spec;this.query=spec.query;}},
          onOpen:(entry,location,modifiers,isCurrent)=>this.openRichDocumentSearchEntry(entry,location,modifiers.primary,isCurrent),
        });
        mount.controller=controller;this.richDocumentSearchOwners.add({vault,controller});return;
      }
      const input=el('input','search-box');input.placeholder='Search…';input.value=this.query;input.type='search';input.setAttribute('aria-label',this.vault.adapter.documentSemantics?'Search text (case-sensitive)':'Search all files');if(this.vault.adapter.documentSemantics)input.placeholder='Search text (case-sensitive)';input.oninput=()=>{this.query=input.value;this.run(()=>this.search());};this.sidebarContent.append(input,el('div','search-results'));this.run(()=>this.search());return;
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

  private clearDocumentSearch(keepRich=false):void {
    this.documentSearchFreshness?.abort();this.documentSearchFreshness=undefined;
    if(!keepRich&&this.richDocumentSearch){const retired=this.richDocumentSearch;this.richDocumentSearch=undefined;void retired.controller?.close().then(()=>{for(const owner of this.richDocumentSearchOwners)if(owner.controller===retired.controller)this.richDocumentSearchOwners.delete(owner);}).catch(()=>{});}
    this.searchGeneration++;
    void this.closeDocumentSearchPins().catch(()=>{});
  }

  private releaseDocumentSearchOwner(vault:Vault):void {
    for(const owner of this.richDocumentSearchOwners)if(owner.vault===vault){owner.controller.release();this.richDocumentSearchOwners.delete(owner);}
    // Successful platform release is the final backend cleanup acknowledgment,
    // including opens whose transport responses have not reached the renderer.
    for(const owner of this.documentSearchOwners)if(owner.vault===vault){
      owner.released=true;owner.pins.clear();this.documentSearchOwners.delete(owner);
    }
  }

  private closeDocumentSearchPin(owner:DocumentSearchOwner,pin:DocumentPin):Promise<void> {
    if(owner.released)return Promise.resolve();
    const pending=owner.closing.get(pin);if(pending)return pending;
    if(!owner.pins.has(pin))return Promise.resolve();
    const closing=Promise.resolve().then(()=>owner.released?undefined:pin.close()).then(()=>{owner.pins.delete(pin);})
      .finally(()=>{owner.closing.delete(pin);if(!owner.runs&&!owner.pins.size)this.documentSearchOwners.delete(owner);});
    // Failed acknowledgments retain ownership for the same service's next query
    // or teardown. They can never block an unrelated vault's acquisition.
    owner.closing.set(pin,closing);return closing;
  }

  private closeDocumentSearchPins(owner?:DocumentSearchOwner):Promise<void> {
    const owners=owner?[owner]:[...this.documentSearchOwners];
    return Promise.all(owners.flatMap(item=>[...item.pins].map(pin=>this.closeDocumentSearchPin(item,pin)))).then(()=>{});
  }

  private async openDocumentSearchEntry(id:string,query:string):Promise<void> {
    const vault=this.vault,pane=this.activePane,tab=this.current(pane),path=tab?.path,activation=this.paneActivationRevision;
    const current=()=>this.vault===vault&&this.activePane===pane&&this.current(pane)===tab&&tab?.path===path
      &&this.treeTab==='search'&&this.query===query&&!this.documentSearchSuspended&&!this.platformReleased&&!this.closing;
    if(!current())return;
    const writes=vault.adapter.durableWrites;if(!writes)throw new Error('Stable search navigation is unavailable.');
    const observed=await writes.readTextById(id);if(!current())return;
    if(!observed||observed.entryId!==id||vault.entries.get(observed.path)?.entryId!==id)throw new Error('The result moved or changed. Refresh search.');
    // A save can rerender the sidebar. Keep guarding the actual pane, query and
    // current ID mapping through openNote's post-flush commit gate.
    await this.openNote(observed.path,false,pane,true,'',activation,()=>current()&&vault.entries.get(observed.path)?.entryId===id);
  }

  private async openRichDocumentSearchEntry(entry:DocumentEntry,location:SearchLocation|undefined,newTab:boolean,admit:()=>boolean):Promise<void>{
    const vault=this.vault,pane=this.activePane,activation=this.paneActivationRevision,generation=this.vaultGeneration;
    const active=()=>admit()&&this.vault===vault&&generation===this.vaultGeneration&&this.activePane===pane&&this.paneActivationRevision===activation&&this.panes.includes(pane);
    if(!active())return;
    const navigation=(this.navigationIntent.get(pane)??0)+1;this.navigationIntent.set(pane,navigation);
    const before=()=>active()&&this.navigationIntent.get(pane)===navigation;
    // entries is only a cached path hint. Admit identity using the existing
    // adapter stat/source protocol before opening, never text-decode a binary.
    const hinted=[...vault.entries.values()].find(value=>value.type==='file'&&value.entryId===entry.id);
    if(!hinted){notice('This result moved or was removed. Refresh search.');return;}
    const observed=vault.adapter.stat?await vault.adapter.stat(hinted.path):undefined;if(!before())return;
    if(!observed||observed.type!=='file'||observed.entryId!==entry.id){notice('This result moved or changed. Refresh search.');return;}
    const path=observed.path,token=this.treeEntryToken(path);
    const guarded=()=>active()&&this.treeEntryToken(path)===token&&vault.entries.get(path)?.entryId===entry.id;
    await this.openNote(path,newTab,pane,true,'',activation,guarded,entry.id);
    const expectedNavigation=navigation+1;
    if(!guarded()||this.navigationIntent.get(pane)!==expectedNavigation||this.current(pane)?.path!==path)return;
    const editor=pane.editor;
    if(location?.locator.origin!=='source'||!editor||!isMarkdown(path))return;
    const source=await vault.readDurableTextById(entry.id);
    if(!guarded()||this.navigationIntent.get(pane)!==expectedNavigation||this.current(pane)?.path!==path)return;
    if(pane.editor!==editor)return;
    const buffer=this.buffers.get(path),saved=buffer?.savedDurableWitness;
    const range=location.locator.range.utf16;
    if(!source||source.path!==path||source.entryId!==entry.id||source.revision!==entry.revision||!buffer||buffer.dirty||buffer.error||saved?.entryId!==entry.id||saved.revision!==entry.revision
      ||saved.path!==path||buffer.savedText!==source.content||buffer.text!==source.content||editor.getValue()!==source.content||range[1]>source.content.length){
      notice('The note changed since this result. Refresh search to select its current match.');return;
    }
    const state=editor.getViewState?.();
    if(state)editor.restoreViewState?.({...state,selection:{ranges:[{anchor:range[0],head:range[1]}],mainIndex:0}});
  }

  private async search(rebuild=false):Promise<void>{
    if(this.documentSearchSuspended)return;
    if(this.vault.adapter.documentSemantics?.richSearchAvailable){
      if(!this.richDocumentSearch)this.renderSidebar();
      this.richDocumentSearch?.controller?.setSpec({...this.richSearchSpec,query:this.query});return;
    }
    this.clearDocumentSearch();
    const generation=this.searchGeneration,vault=this.vault,query=this.query,freshness=new AbortController();
    const results=this.sidebarContent.querySelector<HTMLElement>('.search-results');if(!results)return;
    const current=()=>generation===this.searchGeneration&&this.vault===vault&&this.query===query&&this.treeTab==='search'
      &&this.sidebarContent.contains(results)&&!freshness.signal.aborted&&!this.documentSearchSuspended&&!this.platformReleased&&!this.closing;
    results.replaceChildren();
    const service=vault.adapter.documentSemantics;
    if(service?!query.length:!query.trim()){results.append(el('p','sidebar-empty','Type to search your vault.'));return;}
    if(!service){
      // Adapters without the shared capability retain their existing search.
      const lower=query.toLocaleLowerCase();let count=0;
      for(const entry of vault.entries.values()){
        if(entry.type!=='file'||!entry.path.endsWith('.md'))continue;
        const text=await vault.read(entry.path);if(!current())return;
        const lines=text.split('\n');const matching=lines.map((line,index)=>({line,index})).filter(item=>item.line.toLocaleLowerCase().includes(lower));
        if(!entry.path.toLocaleLowerCase().includes(lower)&&!matching.length)continue;
        count++;const item=el('div','search-result');item.append(textButton(nameOf(entry.path),()=>this.run(()=>this.openNote(entry.path)),'search-result-title'));
        for(const match of matching.slice(0,4)){const snippet=textButton(match.line.trim().slice(0,180),()=>this.run(()=>this.openNote(entry.path)),'search-snippet');snippet.title=`Line ${match.index+1}`;item.append(snippet);}results.append(item);
      }
      if(!count)results.append(el('p','sidebar-empty','No results found.'));return;
    }
    this.documentSearchFreshness=freshness;
    const status=el('p','sidebar-empty','Updating the saved-text index…'),rows=el('div'),actions=el('div');
    status.setAttribute('role','status');status.setAttribute('aria-live','polite');results.append(status,rows,actions);
    const show=(state:string,message:string)=>{if(!current())return;results.dataset.state=state;status.textContent=message;actions.replaceChildren();};
    const retry=(label:string,reset=false)=>{if(current())actions.append(textButton(label,()=>{if(current())this.run(()=>this.search(reset));},'search-result-title'));};
    const sameSource=(a:DocumentSourceId,b:DocumentSourceId)=>a.localStoreId===b.localStoreId&&a.watermark===b.watermark;
    const sameSnapshot=(a:DocumentSnapshotId,b:DocumentSnapshotId)=>a.localStoreId===b.localStoreId&&a.generationEpoch===b.generationEpoch&&a.generation===b.generation
      &&a.versions.schema===b.versions.schema&&a.versions.extraction===b.versions.extraction&&a.versions.resolver===b.versions.resolver&&a.versions.query===b.versions.query;
    let owner=[...this.documentSearchOwners].find(item=>item.vault===vault&&item.service===service&&!item.released);
    if(!owner){owner={vault,service,released:false,runs:0,pins:new Set(),closing:new Map(),acquisition:Promise.resolve()};this.documentSearchOwners.add(owner);}
    owner.runs++;
    let pin:DocumentPin|undefined;
    try{
      const maintained=await catchUpDocumentIndex(service,{isCurrent:current,rebuild,signal:freshness.signal,onProgress:progress=>{
        show('indexing',progress.phase==='indexing'&&progress.prepared!==undefined&&progress.total!==undefined
          ?`Indexing saved text… ${progress.prepared} of ${progress.total}`:'Updating the saved-text index…');
      }});
      if(!current())return;
      if(maintained.rebuildRequired)throw new DocumentSemanticsError('rebuild_required');
      if(!maintained.snapshot){show('indexing','The saved-text index is still updating.');retry('Continue indexing');return;}
      // Serialize pending opens. Rapid typing cannot consume all four shared
      // pin slots with requests that are already obsolete when they resolve.
      const previous=owner.acquisition;let release!:()=>void;
      owner.acquisition=new Promise<void>(resolve=>{release=resolve;});
      try{
        await previous;if(!current())return;
        await this.closeDocumentSearchPins(owner);if(!current()||owner.released)return;
        pin=await service.open();if(!owner.released)owner.pins.add(pin);
      }finally{release();}
      if(!current()||owner.released)return;
      if(pin.snapshot.localStoreId!==maintained.source.localStoreId||pin.source.localStoreId!==pin.snapshot.localStoreId)throw new DocumentSemanticsError('invalid_document_response');
      show('loading','Searching saved text…');
      const groups=new Map<string,{element:HTMLElement;path:string;revision:string;snippets:number}>(),cursors=new Set<DocumentCursor>();
      let cursor:DocumentCursor|null=null,scanComplete=false,coverageComplete=pin.coverageComplete,hits=0,sourceBytes=0,truncated=false;
      // Each Rust page reads at most 16 MiB/32 documents. Reserve a full page
      // before continuing so one UI operation never scans more than 64 MiB.
      for(let pageIndex=0;pageIndex<64&&hits<1000&&sourceBytes<=48*1024*1024;pageIndex++){
        const page=await pin.search({query,cursor,limit:Math.min(100,1000-hits)});if(!current())return;
        const value=page.result.value;
        if(!sameSnapshot(page.result.snapshot,pin.snapshot)||!sameSnapshot(value.snapshot,pin.snapshot)||!sameSource(page.result.source,pin.source)
          ||page.result.coverageComplete!==pin.coverageComplete||value.coverageComplete!==pin.coverageComplete
          ||(page.cursor===null)!==value.scanComplete||value.next!==null||value.complete!==(value.scanComplete&&value.coverageComplete)
          ||value.hits.length>Math.min(100,1000-hits)||!Number.isSafeInteger(value.sourceBytes)||value.sourceBytes<0||value.sourceBytes>16*1024*1024
          ||!Number.isSafeInteger(value.documents)||value.documents<0||value.documents>32)throw new DocumentSemanticsError('invalid_document_response');
        hits+=value.hits.length;sourceBytes+=value.sourceBytes;coverageComplete=coverageComplete&&value.coverageComplete;
        for(const hit of value.hits){
          if(hit.entry.kind!=='file'||hit.entry.deleted)throw new DocumentSemanticsError('invalid_document_response');
          let group=groups.get(hit.entry.id);
          if(!group){
            if(groups.size>=200){truncated=true;break;}
            const item=el('div','search-result');
            const title=textButton(nameOf(hit.entry.path),()=>{if(current())this.run(()=>this.openDocumentSearchEntry(hit.entry.id,query));},'search-result-title');
            title.dataset.entryId=hit.entry.id;title.title=hit.entry.path;item.append(title);rows.append(item);
            group={element:item,path:hit.entry.path,revision:hit.entry.revision,snippets:0};groups.set(hit.entry.id,group);
          }else if(group.path!==hit.entry.path||group.revision!==hit.entry.revision)throw new DocumentSemanticsError('invalid_document_response');
          if(group.snippets<4){
            const snippet=textButton(hit.snippet.trim().slice(0,180),()=>{if(current())this.run(()=>this.openDocumentSearchEntry(hit.entry.id,query));},'search-snippet');
            snippet.title=`Line ${hit.line+1}`;group.element.append(snippet);group.snippets++;
          }
        }
        cursor=page.cursor;scanComplete=value.scanComplete;
        if(scanComplete||truncated)break;
        if(cursor===null||cursors.has(cursor))throw new DocumentSemanticsError('invalid_document_response');cursors.add(cursor);
      }
      if(!current())return;
      const observed=await service.status();if(!current())return;
      if(observed.source.localStoreId!==pin.source.localStoreId)throw new DocumentSemanticsError('invalid_document_response');
      if(observed.rebuildRequired)throw new DocumentSemanticsError('rebuild_required');
      const lagged=!observed.current||!sameSource(observed.source,pin.source)||!observed.snapshot||!sameSnapshot(observed.snapshot,pin.snapshot);
      const incomplete=truncated||!scanComplete||!coverageComplete;
      const messages=[groups.size?`${groups.size} ${groups.size===1?'file':'files'} found.`:incomplete||lagged?'No matches in the searched saved text.':'No results found.'];
      if(!scanComplete||truncated)messages.push('Search limit reached; refine your query.');
      if(!coverageComplete)messages.push('Some files could not be indexed.');
      if(lagged)messages.push('Results are from an older saved snapshot.');
      show(incomplete?'incomplete':lagged?'lagged':groups.size?'ready':'empty',messages.join(' '));
      if(lagged)retry('Refresh search');
    }catch(error){
      if(!current())return;
      const code=documentErrorCode(error),needsRebuild=code==='rebuild_required'||code==='index_rebuild_required';
      show('unavailable',needsRebuild?'The saved-text index needs to be rebuilt.':code==='snapshot_expired'
        ?'The saved snapshot expired. Refresh search to try again.':'Saved-text search is unavailable. Refresh to try again.');
      retry(needsRebuild?'Rebuild index':'Refresh search',needsRebuild);
    }finally{
      if(this.documentSearchFreshness===freshness)this.documentSearchFreshness=undefined;
      if(pin){
        // Retire only this operation's pin; another search may already own one.
        try{await this.closeDocumentSearchPin(owner,pin);}catch{
          // A late open after shell disposal has no future refresh to retry it.
          if(!current())try{await this.closeDocumentSearchPin(owner,pin);}catch{}
          else{show('unavailable','Search could not release its saved snapshot. Refresh to try again.');retry('Refresh search');}
        }
      }
      owner.runs--;if(!owner.runs&&!owner.pins.size)this.documentSearchOwners.delete(owner);
    }
  }

  private clearDocumentBacklinks():void {
    this.documentBacklinksGeneration++;
    this.documentBacklinks?.dispose();this.documentBacklinks=undefined;
  }

  private async renderSharedBacklinks(path:string|null|undefined):Promise<void> {
    const vault=this.vault,pane=this.activePane,tab=this.current(pane),generation=this.documentBacklinksGeneration;
    const service=vault.adapter.documentSemantics;
    const current=()=>this.vault===vault&&this.activePane===pane&&this.current(pane)===tab
      &&this.current(pane)?.path===path&&this.rightTab==='backlinks'
      &&this.documentBacklinksGeneration===generation&&!this.platformReleased&&!this.closing
      &&!this.root.classList.contains('right-hidden');
    if(!service||!current())return;
    try {
      let entry=path?vault.entries.get(path):undefined;
      if(path&&!entry?.entryId&&vault.adapter.stat)entry=await vault.adapter.stat(path)??undefined;
      if(!current())return;
      if(path&&(!entry?.entryId||entry.type!=='file')) {
        this.rightContent.append(el('h3','right-heading','Linked mentions'),el('p','sidebar-empty','Linked mentions are waiting for this file’s identity.'));
        return;
      }
      const target=path&&entry?.entryId?{id:entry.entryId,path}:null;
      this.documentBacklinks=mountDocumentBacklinks(this.rightContent,{
        service,target,vaultIdentity:vault,
        isCurrent:(owner,selected)=>current()&&owner===vault&&(!selected||!vault.entries.get(selected.path)?.entryId||vault.entries.get(selected.path)?.entryId===selected.id),
        onOpenStableEntry:async(id)=>{
          if(!current())return;
          const writes=vault.adapter.durableWrites;
          if(!writes)throw new Error('Stable note navigation is unavailable.');
          const observed=await writes.readTextById(id);
          if(!current())return;
          if(!observed||observed.entryId!==id||vault.entries.get(observed.path)?.entryId!==id)throw new Error('The linked note moved or changed. Refresh linked mentions.');
          // Saving the current note may rerender backlinks while navigation
          // waits. Guard the actual pane/tab/identity, not that transient view.
          const activation=this.paneActivationRevision;
          const canNavigate=()=>this.vault===vault&&this.activePane===pane&&this.current(pane)===tab
            &&this.current(pane)?.path===path&&!this.platformReleased&&!this.closing
            &&vault.entries.get(observed.path)?.entryId===id;
          await this.openNote(observed.path,false,pane,true,'',activation,canNavigate);
        },
      });
    } catch {
      if(current())this.rightContent.append(el('h3','right-heading','Linked mentions'),el('p','sidebar-empty','Linked mentions are unavailable.'));
    }
  }

  private sidebarMainContext():SidebarBaseContext{
    const tab=this.current(),path=tab?.kind==='note'?tab.path:null;
    const entry=path?this.vault.entries.get(path):undefined;
    return entry?.type==='file'?{path:entry.path,entryId:entry.entryId,token:this.treeEntryToken(entry.path)}:{path:null};
  }

  private captureSidebarPinContext(input:SidebarBaseContext):SidebarBaseContext{
    if(input.path===null)return{path:null};
    try{if(normalizePath(input.path)!==input.path)return{path:null};}catch{return{path:null};}
    if(input.entryId!==undefined&&(typeof input.entryId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(input.entryId)))return{path:null};
    const atPath=this.vault.entries.get(input.path),entry=input.entryId&&atPath?.entryId!==input.entryId?[...this.vault.entries.values()].find(entry=>entry.type==='file'&&entry.entryId===input.entryId):atPath;
    const owned=entry?.type==='file'&&(!input.token||input.token===this.treeEntryToken(entry.path));
    return{path:owned?entry.path:input.path,entryId:input.entryId??(owned?entry.entryId:undefined),token:owned?this.treeEntryToken(entry.path):input.token};
  }

  private resolveSidebarPinContext(target:SidebarBaseContext):SidebarBaseContext{
    if(target.path===null)return{path:null};
    const atPath=this.vault.entries.get(target.path),entry=target.entryId&&atPath?.entryId!==target.entryId?[...this.vault.entries.values()].find(entry=>entry.type==='file'&&entry.entryId===target.entryId):atPath;
    if(entry?.type!=='file'||(!target.entryId&&(!target.token||target.token!==this.treeEntryToken(entry.path))))return{path:null};
    return{path:entry.path,entryId:target.entryId??entry.entryId,token:this.treeEntryToken(entry.path)};
  }

  private sidebarContextsEqual(a:SidebarBaseContext,b:SidebarBaseContext):boolean{return a.path===b.path&&a.entryId===b.entryId&&a.token===b.token;}

  private retrySidebarFollowingContext(saved:SidebarBaseState):void{
    if(this.sidebarBase!==saved||saved.pinned||saved.pinning||saved.closing||saved.session.hasPendingChanges())return;
    if(saved.following){saved.following.retryOnFinish=true;return;}
    if(saved.failedContext){saved.failedContext=undefined;this.renderRight();}
  }

  private followSidebarContext(saved:SidebarBaseState,context:SidebarBaseContext):void{
    if(saved.following&&this.sidebarContextsEqual(saved.following.context,context)||saved.failedContext&&this.sidebarContextsEqual(saved.failedContext,context))return;
    const vault=this.vault,generation=this.vaultGeneration,intent=this.sidebarBaseIntent,token=this.treeEntryToken(saved.path),request={context,retryOnFinish:false};
    saved.following=request;saved.failedContext=undefined;
    const owned=()=>this.vault===vault&&this.vaultGeneration===generation&&this.sidebarBase===saved&&saved.following===request&&this.sidebarBaseIntent===intent&&!saved.pinned&&!saved.closing&&!!token&&this.treeEntryToken(saved.path)===token&&this.sidebarContextsEqual(context,this.sidebarMainContext());
    const current=()=>owned()&&!saved.pinning;
    let retry=false;
    void Promise.resolve().then(()=>{if(current())return saved.session.setCurrentFile(context.path,context.entryId);}).then(()=>{
      if(current()){saved.context=context.path;saved.contextEntryId=context.entryId;}
    }).catch(error=>{
      if(owned()){saved.failedContext=context;if(!saved.pinning)notice(error instanceof Error?error.message:String(error));retry=request.retryOnFinish&&!saved.pinning&&!saved.session.hasPendingChanges();}
    }).finally(()=>{
      const retryCurrent=retry&&current();if(saved.following===request)saved.following=undefined;
      if(retryCurrent){saved.failedContext=undefined;this.renderRight();}
    });
  }

  private renderSidebarPinControl():void{
    const control=this.sidebarBasePinButton,saved=this.sidebarBase;if(!control)return;
    control.hidden=this.rightTab!=='base'||!saved;
    control.disabled=!saved||!!saved.closing||!!saved.pinning;
    const pinned=saved?.pinned===true,label=pinned?'Unpin sidebar Base':'Pin sidebar Base';
    control.setAttribute('aria-label',label);control.setAttribute('aria-pressed',String(pinned));control.setAttribute('aria-busy',String(!!saved?.pinning));control.classList.toggle('is-active',pinned);
    control.title=pinned?`${label} (${saved?.context??'no current note'})`:label;
    control.replaceChildren(icon(pinned?'pin-off':'pin'));
  }

  private changeSidebarBaseContext(saved:SidebarBaseState,update:(validate:()=>void)=>Promise<{pinned:boolean;context:SidebarBaseContext;target?:SidebarBaseContext}>):Promise<void>{
    if(saved.pinning)return saved.pinning;
    const vault=this.vault,generation=this.vaultGeneration,intent=this.sidebarBaseIntent,token=this.treeEntryToken(saved.path),wasInert=saved.host.hasAttribute('inert');
    const validate=()=>{if(this.vault!==vault||this.vaultGeneration!==generation||this.sidebarBase!==saved||this.sidebarBaseIntent!==intent||saved.closing||!token||this.treeEntryToken(saved.path)!==token)throw new Error('The sidebar Base changed before its context could be updated.');};
    let retargeted=false;
    const operation=Promise.resolve().then(async()=>{
      validate();await saved.session.flush({dismissCleanPanels:true});validate();retargeted=true;
      const next=await update(validate);validate();
      const previous={pinned:saved.pinned,target:saved.pinnedContext,context:saved.context,entryId:saved.contextEntryId};
      saved.pinned=next.pinned;saved.pinnedContext=next.target;saved.context=next.context.path;saved.contextEntryId=next.context.entryId;
      try{this.saveSession();}catch(error){saved.pinned=previous.pinned;saved.pinnedContext=previous.target;saved.context=previous.context;saved.contextEntryId=previous.entryId;throw error;}
      saved.failedContext=undefined;
    }).catch(async error=>{
      // A failed identity-bound setter must not leave an unacknowledged query
      // selector under the old pin flag. Only this same local owner may roll back.
      if(retargeted&&this.vault===vault&&this.vaultGeneration===generation&&this.sidebarBase===saved&&this.sidebarBaseIntent===intent&&!saved.closing){
        const restore=saved.pinned&&saved.pinnedContext?this.resolveSidebarPinContext(saved.pinnedContext):this.sidebarMainContext();
        try{await saved.session.setCurrentFile(restore.path,restore.entryId);validate();saved.context=restore.path;saved.contextEntryId=restore.entryId;}catch{ /* Preserve the original actionable failure; no local pin acknowledgement follows. */ }
      }
      throw error;
    }).finally(()=>{if(saved.pinning===operation)saved.pinning=undefined;if(!wasInert)saved.host.removeAttribute('inert');this.renderSidebarPinControl();});
    saved.pinning=operation;saved.host.setAttribute('inert','');this.renderSidebarPinControl();return operation;
  }

  private toggleSidebarBasePin():Promise<void>{
    const saved=this.sidebarBase;if(!saved)return Promise.resolve();
    const pin=!saved.pinned,target=pin?this.sidebarMainContext():undefined;
    return this.changeSidebarBaseContext(saved,async validate=>{
      if(pin){
        const desired=this.resolveSidebarPinContext(target!);
        if(!this.sidebarContextsEqual(target!,desired))throw new Error('The selected note changed before it could be pinned.');
        await saved.session.setCurrentFile(desired.path,desired.entryId);validate();
        if(!this.sidebarContextsEqual(desired,this.resolveSidebarPinContext(target!)))throw new Error('The selected note changed before it could be pinned.');
        return{pinned:true,context:desired,target};
      }
      // A main-pane change during the saved-query acknowledgement belongs to
      // the same unpin intent. Publish only the latest stable active context.
      for(;;){const desired=this.sidebarMainContext();await saved.session.setCurrentFile(desired.path,desired.entryId);validate();if(this.sidebarContextsEqual(desired,this.sidebarMainContext()))return{pinned:false,context:desired};}
    });
  }

  private refreshPinnedSidebarContext(saved:SidebarBaseState):Promise<void>{
    return this.changeSidebarBaseContext(saved,async validate=>{
      for(;;){const target=saved.pinnedContext??{path:null},desired=this.resolveSidebarPinContext(target);await saved.session.setCurrentFile(desired.path,desired.entryId);validate();if(target===saved.pinnedContext&&this.sidebarContextsEqual(desired,this.resolveSidebarPinContext(target)))return{pinned:true,context:desired,target};}
    });
  }

  private async openBaseSidebar(path:string,options:{reveal?:boolean;persist?:boolean;activate?:boolean;pinnedContext?:SidebarBaseContext}={}):Promise<void>{
    const vault=this.vault,generation=this.vaultGeneration,intent=++this.sidebarBaseIntent;
    const token=this.treeEntryToken(path);
    if(!token||vault.entries.get(path)?.type!=='file')throw new Error('The selected sidebar Base is unavailable.');
    const previous=this.sidebarBase,pinnedContext=options.pinnedContext??(!previous&&path===this.sidebarBasePath?this.sidebarPinnedContext:undefined);
    if(previous){
      // Register before invoking close so a newer request joins this teardown,
      // including requests made synchronously by the closing session itself.
      const closing=previous.closing??=Promise.resolve().then(()=>previous.session.close());
      this.renderSidebarPinControl();
      try{await closing;}catch(error){if(previous.closing===closing){previous.closing=undefined;this.renderSidebarPinControl();}throw error;}
    }
    if(vault!==this.vault||generation!==this.vaultGeneration||intent!==this.sidebarBaseIntent||this.sidebarBase!==previous)return;
    if(this.treeEntryToken(path)!==token)throw new Error('The selected sidebar Base changed while closing the previous view.');
    this.sidebarBase=undefined;
    await this.prepareBase(path,generation);
    if(vault!==this.vault||generation!==this.vaultGeneration||intent!==this.sidebarBaseIntent)return;
    if(this.treeEntryToken(path)!==token)throw new Error('The selected sidebar Base changed before opening.');
    const host=el('div','sidebar-base-host');
    // New selection intents choose the next mount; the current session still
    // owns its accepted work while close drains it. Retire that authority only
    // when the actual mounted session changes, keeping file/vault guards live.
    let session:BaseSession|undefined;
    const validate=()=>{if(vault!==this.vault||generation!==this.vaultGeneration||!token||this.treeEntryToken(path)!==token||(session?this.sidebarBase?.session!==session:intent!==this.sidebarBaseIntent))throw new Error('The sidebar Base changed.');};
    const target=pinnedContext?this.captureSidebarPinContext(pinnedContext):undefined,context=target?this.resolveSidebarPinContext(target):this.sidebarMainContext();
    session=this.createWorkspaceBaseSession(host,path,()=>this.activePane,validate,context);
    this.sidebarBase={path,session,host,context:context.path,contextEntryId:context.entryId,pinned:!!target,pinnedContext:target};this.sidebarPinnedContext=target;this.sidebarBasePath=path;if(options.activate!==false)this.rightTab='base';if(options.reveal!==false)this.root.classList.remove('right-hidden');this.renderRight();await session.ready;if(options.persist!==false)this.saveSession();
  }

  /** Collection values use the same typed operation as a Base cell. The note
   * buffer owns composing the returned projection with any newer body draft. */
  private async changeManagedNoteProperties(buffer:NoteBuffer,next:string,targets:NotePropertyTargets,validate:()=>void):Promise<boolean>{
    const before=buffer.text,vault=this.vault,generation=this.vaultGeneration;validate();
    const selected=await targets.prepareCollection();validate();
    if(!selected)return false;
    if(vault!==this.vault||generation!==this.vaultGeneration||buffer.text!==before)throw new Error('This note changed while the property was being prepared. Its draft is retained.');
    const previousProperties=readProperties(before),proposedProperties=readProperties(next);
    const previous=new Map(previousProperties.map(property=>[property.key,property.value])),proposed=new Map(proposedProperties.map(property=>[property.key,property.value]));
    for(const key of ['_id','_type'])if(JSON.stringify(previous.get(key))!==JSON.stringify(proposed.get(key)))throw new Error('Collection identity is managed by Zorid.');
    const databases=vault.adapter.databases;if(!databases)throw new Error('Collections are unavailable in this vault.');
    const signature=JSON.stringify([selected.entry.entryId,previousProperties,proposedProperties]);
    let requests=this.collectionPropertyRequests.get(buffer);if(!requests){requests=new Map();this.collectionPropertyRequests.set(buffer,requests);}
    let request=requests.get(signature);
    if(!request){
      if(previous.get('_id')!==selected.entry.entryId||previous.get('_type')!==selected.collection.name)throw new Error('This collection’s readable properties changed. Refresh the note before editing; the draft is retained.');
      for(const field of selected.collection.properties)if(!previous.has(field.name))throw new Error('The collection schema changed. Refresh the note before editing; the draft is retained.');
      const values:Record<string,string|number|boolean|null|readonly string[]>={};
      const typed=(field:typeof selected.collection.properties[number],input:unknown)=>{
        let value=input??null;
        if(value!==null&&(field.datatype==='select'||field.datatype==='status')){
          const option=field.options.find(option=>option.name===value);if(!option)throw new Error(`The ${field.name} options changed. Refresh the note before editing; the draft is retained.`);value=option.id;
        }else if(value!==null&&field.datatype==='multi-select'){
          if(!Array.isArray(value))throw new Error(`${field.name} needs a list of options.`);
          value=value.map(label=>{const option=field.options.find(option=>option.name===label);if(!option)throw new Error(`The ${field.name} options changed. Refresh the note before editing; the draft is retained.`);return option.id;});
        }
        return collectionValue(value);
      };
      const changedFields=selected.collection.properties.filter(field=>JSON.stringify(previous.get(field.name))!==JSON.stringify(proposed.get(field.name)));
      const preservedFields=changedFields.filter(field=>Object.hasOwn(selected.entry.problems??{},field.id));
      let canonicalPreserved:Map<string,unknown>|undefined;
      if(preservedFields.length){
        // A datatype change may retain its old readable projection while values
        // still contains the earlier datatype's payload (such as an option ID).
        // Prove the displayed baseline against the exact saved file and the
        // core's revision-bound canonical projection; never retype that payload.
        const savedText=buffer.savedText,witness=buffer.savedDurableWitness;
        if(!witness||selected.entry.deleted||selected.entry.pendingProjection||!selected.entry.fileRevision||witness.entryId!==selected.entry.entryId||witness.path!==selected.entry.path||witness.path!==buffer.path||witness.revision!==selected.entry.fileRevision)throw new Error('The saved collection projection changed. Reopen the note before correcting this value; the draft is retained.');
        const savedWitness={entryId:witness.entryId,path:witness.path,revision:witness.revision};
        const savedProperties=new Map(readProperties(savedText).map(property=>[property.key,property.value]));
        for(const field of preservedFields)if(!savedProperties.has(field.name)||JSON.stringify(previous.get(field.name)??null)!==JSON.stringify(savedProperties.get(field.name)??null))throw new Error(`The saved ${field.name} value changed. Reopen the note before correcting it; the draft is retained.`);
        const reply=await databases.request({op:'compose',entryId:selected.entry.entryId,expectedRevision:savedWitness.revision,baseline:savedText,proposed:savedText});validate();
        const currentWitness=buffer.savedDurableWitness,composition=reply.composition;
        if(vault!==this.vault||generation!==this.vaultGeneration||buffer.text!==before||buffer.savedText!==savedText||!currentWitness||currentWitness.entryId!==savedWitness.entryId||currentWitness.path!==savedWitness.path||currentWitness.revision!==savedWitness.revision||!composition||composition.currentFileRevision!==savedWitness.revision||composition.currentFileRevision!==selected.entry.fileRevision||composition.entryRevision!==selected.entry.revision||composition.collectionRevision!==selected.collection.revision)throw new Error('The saved collection projection changed. Reopen the note before correcting this value; the draft is retained.');
        canonicalPreserved=new Map(readProperties(composition.content).map(property=>[property.key,property.value]));
        if(canonicalPreserved.get('_id')!==selected.entry.entryId||canonicalPreserved.get('_type')!==selected.collection.name)throw new Error('The canonical collection projection has a different identity. The draft is retained.');
      }
      for(const field of changedFields){
        const authoritative=selected.entry.values[field.id]??null;
        const rendered=preservedFields.includes(field)?canonicalPreserved?.get(field.name):(field.datatype==='select'||field.datatype==='status')&&typeof authoritative==='string'?field.options.find(option=>option.id===authoritative)?.name??authoritative:field.datatype==='multi-select'&&Array.isArray(authoritative)?authoritative.map(id=>field.options.find(option=>option.id===id)?.name??id):authoritative;
        if(JSON.stringify(previous.get(field.name)??null)!==JSON.stringify(rendered))throw new Error(`The saved ${field.name} value changed in another view. Refresh the note before editing; the draft is retained.`);
        values[field.id]=typed(field,proposed.get(field.name));
      }
      if(!Object.keys(values).length)return false;
      request={op:'set_entry',operationId:crypto.randomUUID(),entryId:selected.entry.entryId,expectedRevision:selected.entry.revision,expectedCollectionRevision:selected.collection.revision,values};requests.set(signature,request);
    }
    await buffer.flush();validate();
    const response=await databases.request(request);validate();
    const saved=response.entries.find(entry=>entry.entryId===selected.entry.entryId);
    if(!saved||saved.pendingProjection)throw new Error('The property is committed locally but its note still needs publication. Retry this edit.');
    await buffer.refreshManagedProjection(validate);validate();requests.delete(signature);
    await targets.prepareCollection();return true;
  }

  private renderRight():void{
    this.clearDocumentBacklinks();
    if(!this.vault||!this.activePane)return;
    this.renderSidebarPinControl();
    if(this.rightTab==='base'&&this.sidebarBase){
      const saved=this.sidebarBase;if(!this.rightContent.contains(saved.host))this.rightContent.replaceChildren(saved.host);
      if(!saved.closing&&!saved.pinning){
        const context=saved.pinned&&saved.pinnedContext?this.resolveSidebarPinContext(saved.pinnedContext):this.sidebarMainContext();
        if(context.path!==saved.context||context.entryId!==saved.contextEntryId||saved.following&&!this.sidebarContextsEqual(saved.following.context,context)){
          if(saved.pinned)this.run(()=>this.refreshPinnedSidebarContext(saved));
          else this.followSidebarContext(saved,context);
        }
      }
      return;
    }
    this.rightContent.replaceChildren();delete this.rightContent.dataset.metadataStatus;const path=this.current()?.path;
    if(this.rightTab==='backlinks'){
      if(this.vault.adapter.documentSemantics){
        if(!this.root.classList.contains('right-hidden'))void this.renderSharedBacklinks(path);
        return;
      }
      this.rightContent.append(el('h3','right-heading','Linked mentions'));const links=path?this.vault.metadata.backlinks(path):[];
      const unique=[...new Set(links.map(link=>link.source))];for(const source of unique){const row=textButton(nameOf(source),()=>this.run(()=>this.openNote(source)),'backlink-row');row.prepend(icon('file',14));this.rightContent.append(row);}if(!unique.length)this.rightContent.append(el('p','sidebar-empty','No backlinks found.'));
    }else if(this.rightTab==='outline'){
      const buffer=path?this.buffers.get(path):undefined,metadata=path?(buffer?buffer.getMetadata():this.vault.metadata.get(path)):undefined;
      const state=buffer&&buffer.text!==buffer.savedText?buffer.metadataState:undefined,headings=metadata?.headings??[];
      this.rightContent.append(el('h3','right-heading','Outline'));
      if(state&&state.status!=='current'){this.rightContent.dataset.metadataStatus=state.status;const message=state.status==='pending'?'Updating outline…':state.code==='resource'?'Outline exceeds available resources.':'Outline is unavailable for these edits.';const status=el('p','sidebar-empty metadata-projection-status',message);status.setAttribute('role','status');this.rightContent.append(status);return;}
      const source=buffer?.text,pane=this.activePane;
      for(const heading of headings){const row=textButton(heading.heading,()=>{if(this.activePane!==pane||this.current()?.path!==path||buffer&&(this.buffers.get(path!)!==buffer||buffer.text!==source||buffer.getMetadata()!==metadata))return;const target=pane.element.querySelector(`#heading-${heading.line}`);target?.scrollIntoView({block:'start',behavior:'smooth'});},'outline-row');row.style.paddingLeft=`${12+(heading.level-1)*12}px`;this.rightContent.append(row);}if(!headings.length)this.rightContent.append(el('p','sidebar-empty','No headings found.'));
    }else{
      this.rightContent.append(el('h3','right-heading','Tags'));
      const state=this.vault.metadataFrame,frame=state?.frame,metadata=state?frame?.metadata:this.vault.metadata;
      if(state){this.rightContent.dataset.metadataStatus=state.status;const message=this.metadataDisplayMessage(state),status=el('p','sidebar-empty metadata-projection-status',message??'');status.hidden=!message;status.setAttribute('role','status');this.rightContent.append(status);if(!frame)return;}
      const namespace=state?frame!.entries():this.vault.entries.entries(),tags=new Map<string,number>();
      for(const[path]of namespace)for(const tag of metadata?.get(path)?.tags||[])tags.set(tag,(tags.get(tag)||0)+1);
      for(const[tag,count]of[...tags].sort((a,b)=>a[0].localeCompare(b[0]))){const row=textButton(tag,()=>{this.treeTab='search';this.query=tag.startsWith('#')?tag:`#${tag}`;this.renderSidebar();},'tag-row');row.append(el('span','tag-count',String(count)));this.rightContent.append(row);}
      if(!tags.size)this.rightContent.append(el('p','sidebar-empty metadata-projection-empty',state&&(state.status!=='current'||!frame!.coverageComplete)?'No tags in this saved snapshot.':'No tags found.'));
    }
  }

  private metadataDisplayMessage(state:CommittedMetadataState):string|undefined{
    if(!state.frame)return state.status==='unavailable'?'Saved note information is unavailable.':'Saved note information is updating.';
    if(state.status==='unavailable')return 'Showing the last indexed notes. Saved note information is unavailable.';
    if(state.status!=='current')return 'Showing the last indexed notes while updates finish.';
    if(!state.frame.coverageComplete)return 'Some saved notes could not be indexed.';
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
      }catch(error){this.noteStorageFailure(error,'Your draft couldn’t be saved as a separate note. Keep this note open and try again.');}
      finally{busy=false;save.disabled=false;refresh();}
    }),'mod-cta');
    actions.append(copy,save);banner.append(message,actions);content.insertBefore(banner,content.querySelector('.note-scroll'));
    const refresh=()=>{banner.hidden=!buffer.hasRecoveryConflict;};refresh();
    return this.bufferSubscriptions.subscribe(buffer,refresh);
  }

  /** A failed admission can offer another folder only before any vault/buffer
   * was installed, and after its platform lease has been released successfully. */
  async cleanupFailedStartup(platform:PlatformVault|null):Promise<boolean>{
    this.mobileLifecycleCleanup?.();this.mobileLifecycleCleanup=undefined;
    if(this.platform||this.buffers.size||this.panes.length){this.startupFailed=true;return false;}
    await platform?.release?.();await this.destroy();return true;
  }

  private renderNativeDocumentStatus():void{
    const status=this.nativeDocumentStatus;if(!status)return;
    status.replaceChildren();
    const generation=this.vaultGeneration;
    for(const [path,buffer] of this.buffers){
      const conflict=buffer.hasRecoveryConflict;
      // Current-note conflicts already have the full shared recovery banner.
      if(conflict&&this.activePane?.viewPath===path)continue;
      if(!buffer.error&&!conflict)continue;
      const row=el('div','native-document-notice');
      row.append(el('p','',conflict?`Retained draft for “${nameOf(path)}” needs attention.`:`Could not save “${nameOf(path)}”. Keep this note open and try again.`));
      const current=()=>generation===this.vaultGeneration&&this.buffers.get(path)===buffer&&!this.platformReleased;
      const actions=el('div','note-recovery-actions');
      if(conflict&&this.vault.entries.get(path)?.type==='file')actions.append(textButton('Review draft',()=>{if(current())this.run(()=>this.openNote(path));}));
      const save=textButton(conflict?'Save recovery copy':'Retry save',()=>this.run(async()=>{
        if(!current()||this.nativeRecoveryBusy.has(buffer))return;
        this.nativeRecoveryBusy.add(buffer);this.renderStatus();
        try{
          if(conflict){
            const result=await buffer.saveRecoveryCopy();
            if(current()&&result.resolved)for(const view of this.loadedViews())if(view.viewPath===path){view.editor?.setValue(buffer.text);view.refreshPreview?.();view.properties?.refresh();}
            notice(`Draft saved to “${result.path}”.`);
          }else await buffer.flush();
        }catch(error){this.noteStorageFailure(error);}
        finally{this.nativeRecoveryBusy.delete(buffer);if(current())this.renderStatus();}
      }));
      save.disabled=this.nativeRecoveryBusy.has(buffer);actions.append(save);row.append(actions);status.append(row);
    }
    status.hidden=!status.childElementCount;
  }

  private renderStatus():void{
    this.renderNativeDocumentStatus();
    if(!this.activePane)return;const tab=this.current();const buffer=tab?.path?this.buffers.get(tab.path):undefined;const text=buffer?.text||'';
    this.status.replaceChildren(...(this.importStatusHost?[this.importStatusHost]:[]));
    if(tab?.kind!=='note')return;
    if(tab?.path&&!isMarkdown(tab.path)){if(/\.base$/i.test(tab.path))this.status.append(el('span','save-state',buffer?.error?'Couldn’t save — keep this Base open':buffer?.dirty?'Saving…':''));this.status.append(el('span','',`${this.vault.entries.get(tab.path)?.size??0} bytes`));return;}
    this.status.append(el('span','save-state',buffer?.error?'Couldn’t save — keep this note open':buffer?.dirty?'Saving…':''));
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
  private openCollections():void{
    const vault=this.vault,generation=this.vaultGeneration,service=vault.adapter.databases;if(!service)throw new Error('Collections are unavailable in this vault.');
    const {content,close}=modal('Collections');content.classList.add('collections-modal');
    const current=()=>vault===this.vault&&generation===this.vaultGeneration&&content.isConnected&&!this.platformReleased;
    const browser=mountCollectionBrowser(content,{service,isCurrent:current,
      open:async collection=>{if(!current())return;const stem=collection.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g,' ').trim()||'Collection';let path='',index=0;do{path=`${stem}${index?' '+index:''}.base`;index++;}while(vault.entries.has(path));await vault.create(path,JSON.stringify({views:[{id:newBaseViewId(),type:'table',name:collection.name,source:{kind:'collection',id:collection.id}}]},null,2)+'\n');if(!current())return;close();await this.openNote(path);},
      openEntry:async entry=>{if(!current())return;close();await this.openNote(entry.path,false,this.activePane,true,'',undefined,undefined,entry.entryId);},
      duplicatePath:entry=>{const stem=entry.path.replace(/\.md$/i,'');let path='',index=1;do{path=`${stem} copy${index>1?' '+index:''}.md`;index++;}while(vault.entries.has(path));return path;},
      onMutation:async()=>{if(current())await vault.reload();},
    });
    const observer=new MutationObserver(()=>{if(!content.isConnected){browser.destroy();observer.disconnect();}});observer.observe(document.body,{childList:true});
  }
  private hasPendingBaseCreation():boolean{return !!this.pendingBaseCreation&&this.pendingBaseCreation.operation?.status!=='committed';}
  private async newBase(folder=''):Promise<void>{
    const vault=this.vault,generation=this.vaultGeneration,pane=this.activePane,version=pane.renderVersion,activation=this.paneActivationRevision;
    const intent=(this.navigationIntent.get(pane)??0)+1;this.navigationIntent.set(pane,intent);
    let retained=this.pendingBaseCreation;
    if(retained&&(retained.vault!==vault||retained.generation!==generation)){this.pendingBaseCreation=undefined;retained=undefined;}
    if(retained&&retained.operation?.status!=='committed'&&retained.folder!==folder)throw new Error('Retry the unfinished Base creation in its original folder before creating another Base.');
    if(!retained||retained.operation?.status==='committed'){
      const preparing=prepareBaseFileCreation({vault,folder,validate:()=>{if(vault!==this.vault||generation!==this.vaultGeneration)throw new Error('The Base vault changed.');}});
      retained={vault,generation,folder,preparing};this.pendingBaseCreation=retained;
    }
    let operation:BaseCreationOperation;
    try{operation=await retained.preparing;retained.operation=operation;}
    catch(error){if(this.pendingBaseCreation===retained)this.pendingBaseCreation=undefined;throw error;}
    const path=operation.path;await operation.run();
    if(vault!==this.vault||generation!==this.vaultGeneration||!this.panes.includes(pane)||pane.renderVersion!==version||this.navigationIntent.get(pane)!==intent||activation!==this.paneActivationRevision)return;
    await this.openNote(path,false,pane,true,'',activation);
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
  private async deletePath(path:string):Promise<void>{await this.flush();await this.vault.trash(path);await this.buffers.get(path)?.closeMetadataProjection();this.buffers.delete(path);notice('Moved to vault trash.');}
  private async newTab(pane=this.activePane):Promise<void>{await this.flushPane(pane);const tab:Tab={id:makeId(),path:null,mode:this.settings.defaultMode,kind:'note'};pane.tabs.push(tab);pane.active=tab.id;this.renderRight();this.run(()=>this.renderPane(pane));this.saveSession();}
  private async closeTab(pane:Pane,tab:Tab):Promise<void>{
    if(this.tasksRetiring)return;
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
  private async toggleReading(pane=this.activePane):Promise<void>{const tab=this.current(pane);if(tab.kind!=='note')return;if(tab.path&&!isMarkdown(tab.path))return;await this.flushPane(pane);tab.mode=tab.mode==='reading'?this.settings.defaultMode:'reading';await this.renderPane(pane);this.saveSession();}
  private async setBaseSource(pane:Pane,source:boolean,tab=this.current(pane)):Promise<void>{
    const path=tab?.path;if(tab?.kind!=='note'||!path||!/\.base$/i.test(path)||!!tab.baseSource===source)return;
    const generation=this.vaultGeneration,vault=this.vault,token=this.treeEntryToken(path);
    if(this.current(pane)!==tab){await this.selectTab(pane,tab);if(this.current(pane)!==tab||generation!==this.vaultGeneration||vault!==this.vault||tab.path!==path||this.treeEntryToken(path)!==token)return;}
    const runtime=pane.runtime,version=pane.renderVersion,previous=tab.baseSource;
    const validate=()=>{if(generation!==this.vaultGeneration||vault!==this.vault||this.current(pane)!==tab||pane.runtime!==runtime||!this.panes.includes(pane)||!token||this.treeEntryToken(path)!==token)throw new Error('The Base source request changed.');};
    const buffer=await this.baseBufferFor(path,validate);validate();await this.flushPane(pane);validate();
    // Unlike navigation, a mode switch must save before retiring this editor.
    // Retained durable conflicts deliberately make flushForNavigation preserve-only.
    await buffer.flush();validate();
    this.capturePaneState(pane);tab.baseSource=source;
    const rendering=this.renderPane(pane,{flush:false}),request=this.renderRequests.get(pane);
    try{await rendering;}
    catch(error){if(generation===this.vaultGeneration&&vault===this.vault&&this.current(pane)===tab&&pane.runtime===runtime&&pane.renderVersion===version&&this.renderRequests.get(pane)===request)tab.baseSource=previous;throw error;}
    this.saveSession();if(this.activePane===pane)this.focusPane(pane);
  }
  private async openPropertyLink(source:string,target:string,pane:Pane,witness?:{readonly entryId:string;readonly revision:string;readonly subpath?:string},newTab=false):Promise<void>{
    if(!witness){await this.followLink(source,target,pane);return;}
    const vault=this.vault,generation=this.vaultGeneration;
    const saved=[...vault.entries.values()].find(entry=>entry.type==='file'&&entry.entryId===witness.entryId&&entry.revision===witness.revision);
    if(!saved)throw new Error('The related note changed. Refresh the property before opening it.');
    const current=()=>this.vault===vault&&this.vaultGeneration===generation&&vault.entries.get(saved.path)?.entryId===witness.entryId&&vault.entries.get(saved.path)?.revision===witness.revision;
    // Core distinguishes a heading from a literal # in a captured filename.
    // Older DTOs remain safe file opens without inferring a fragment locally.
    const subpath=typeof witness.subpath==='string'&&witness.subpath.startsWith('#')?witness.subpath:'';
    await this.openNote(saved.path,newTab,pane,true,subpath,undefined,current,witness.entryId);
  }
  private async followLink(source:string,target:string,pane:Pane,kind:'wiki'|'markdown'='wiki'):Promise<void>{if(/^[a-z][\w+.-]*:/i.test(target)||target.startsWith('//')){if(/^(?:https?:\/\/|mailto:)/i.test(target))window.open(target,'_blank','noopener,noreferrer');return;}const resolved=this.vault.metadata.resolveLink(source,target,kind);if(resolved){await this.openNote(resolved,false,pane,true,target.includes('#')?target.slice(target.indexOf('#')):'');return;}const path=target.split('#')[0].replace(/\.md$/,'')+'.md';if(!path||path==='.md')return;const parent=parentOf(path);if(parent&&!this.vault.entries.has(parent))throw new Error(`Folder does not exist: ${parent}`);await this.vault.create(path,'');await this.openNote(path,false,pane);}
  private async dailyNote():Promise<void>{const now=new Date();const name=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}.md`;if(!this.vault.entries.has(name))await this.vault.create(name,'');await this.openNote(name);}
  private async split(edge:'right'|'bottom'='right',source=this.activePane,tab=this.current(source)):Promise<void>{
    if(this.tasksRetiring)return;
    const vault=this.vault,generation=this.vaultGeneration,activation=this.paneActivationRevision;
    const navigation=this.navigationIntent.get(source),active=source.active,path=tab.path,kind=tab.kind;
    await this.flushPane(source);
    if(this.tasksRetiring||vault!==this.vault||generation!==this.vaultGeneration||activation!==this.paneActivationRevision
      ||this.navigationIntent.get(source)!==navigation||!this.panes.includes(source)||!source.tabs.includes(tab)||source.active!==active||tab.path!==path||tab.kind!==kind)return;
    this.capturePaneState(source);
    const clone={...tab,id:makeId(),viewState:tab.viewState?structuredClone(tab.viewState):undefined};
    const pane=this.addPane([clone]);
    if(!this.splitLayout?.split(source.id,pane.id,pane.element,edge)){this.panes=this.panes.filter(item=>item!==pane);pane.element.remove();return;}
    this.activate(pane);
    const destinationActivation=this.paneActivationRevision,destinationNavigation=this.navigationIntent.get(pane);
    await this.renderPane(pane);
    if(this.tasksRetiring||vault!==this.vault||generation!==this.vaultGeneration||!this.panes.includes(pane))return;
    if(this.activePane===pane&&this.paneActivationRevision===destinationActivation&&this.navigationIntent.get(pane)===destinationNavigation
      &&this.current(pane)===clone&&clone.path===path&&clone.kind===kind)this.focusPane(pane);
    this.saveSession();
  }
  private toggleLeft():void{this.root.classList.toggle('left-hidden');this.saveSession();}
  private toggleRight():void{this.root.classList.toggle('right-hidden');this.renderRight();this.saveSession();}

  private async newWindow():Promise<void>{
    const native=workspaceWindowBridge(window.zorid);
    if(!native)throw new Error('Additional windows require the desktop app.');
    await native.newWindow();
  }

  private commands():Command[]{
    const pane=this.activePane,tab=pane&&this.current(pane),path=tab?.path,vault=this.vault,generation=this.vaultGeneration;
    const entryId=path?vault.entries.get(path)?.entryId:undefined;
    const history:Command[]=tab?.kind==='note'&&path&&isMarkdown(path)&&entryId&&this.platform.recoveryHistory?[{
      id:'version-history',name:'Version history',action:async()=>{
        if(this.vault!==vault||generation!==this.vaultGeneration||this.activePane!==pane||this.current(pane)!==tab||tab.path!==path||vault.entries.get(path)?.entryId!==entryId||this.platformReleased)return;
        await this.showVersionHistory(path);
      },
    }]:[];
    return [...WORKSPACE_HOTKEY_COMMANDS.filter(command=>command.id!=='new-window'||workspaceWindowBridge(window.zorid)).map(command=>({
      id:command.id,name:command.name,shortcut:this.hotkeys.label(command.id),action:()=>this.executeHotkey(command.id),
    })),{id:'new-base',name:'Bases: Create new base',action:()=>this.newBase()},...(this.vault.adapter.databases?[{id:'collections',name:'Collections: Browse collections',action:()=>this.openCollections()}]:[]),...(path&&/\.base$/i.test(path)?[{id:'base-sidebar',name:'Bases: Open in right sidebar',action:()=>this.openBaseSidebar(path)}]:[]),...history];
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
    if(this.closing||this.tasksRetiring)return;
    if(this.platform?.editorOnly&&(id.startsWith('tab-')||['new-window','new-tab','close-tab','split-right','split-down','toggle-left','toggle-right','search-all','graph','calendar','tasks','open-vault'].includes(id)))return;
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
      'daily-note':()=>this.dailyNote(),graph:()=>this.openGraph(),calendar:()=>this.openCalendar(),tasks:()=>this.openTasks(),'new-folder':()=>this.newFolder(),'open-vault':()=>this.chooseVault(),
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
  private async showVersionHistory(path:string):Promise<void>{
    const vault=this.vault,generation=this.vaultGeneration,history=this.platform.recoveryHistory,entry=vault.entries.get(path);
    if(!history||!entry?.entryId||!isMarkdown(path))return;
    const entryId=entry.entryId,revision=entry.revision;
    const current=()=>this.vault===vault&&generation===this.vaultGeneration&&!this.platformReleased&&vault.entries.get(path)?.entryId===entryId;
    let buffer:NoteBuffer;
    try{buffer=await this.bufferFor(path,vault.adapter.durableWrites?entryId:undefined,()=>{if(!current())throw new Error('Note changed');});}
    catch(error){this.noteStorageFailure(error,'Version history couldn’t be opened. Please try again.');return;}
    if(!current())return;
    const original=buffer.text;
    openVersionHistory({history,entryId,isCurrent:current,restore:async text=>{
      if(buffer.dirty||buffer.error||buffer.hasRecoveryConflict)return'save_changes';
      if(!current()||this.buffers.get(path)!==buffer||vault.entries.get(path)?.revision!==revision||buffer.text!==original)return'changed';
      const validate=()=>{if(!current()||vault.entries.get(path)?.revision!==revision)throw new Error('The note changed before restoration');};
      this.updateMarkdownBuffer(buffer,text,validate);
      for(const view of this.loadedViews())if(view.viewPath===path){view.editor?.setValue(buffer.text);view.refreshPreview?.();view.properties?.refresh();}
      await buffer.flush();this.renderStatus();return'restored';
    }});
  }

  private fileMenu(entry:VaultEntry,x:number,y:number,inlineRename=false):void{
    // Explorer rows survive harmless snapshot refreshes. Capture the current
    // observation and stable path token rather than the row's old entry object.
    const vault=this.vault,path=entry.path,current=vault.entries.get(path);
    if(!current)return;
    const token=this.treeEntryToken(path),type=current.type,revision=current.revision,folder=type==='folder';
    this.menu([
      ...(folder?[{name:'New note',action:()=>this.newNote(path)},{name:'New folder',action:()=>this.newFolder(path)},{name:'New base',action:()=>this.newBase(path)}]:[{name:'Open in new tab',action:()=>this.openNote(path,true)},{name:this.bookmarks.has(path)?'Remove bookmark':'Bookmark',action:()=>{if(this.bookmarks.has(path))this.bookmarks.delete(path);else this.bookmarks.add(path);this.saveSession();this.renderSidebar();}}]),
      ...(!folder&&isMarkdown(path)&&current.entryId&&this.platform.recoveryHistory?[{name:'Version history',action:()=>this.showVersionHistory(path)}]:[]),
      {name:'Rename…',action:()=>inlineRename?this.beginTreeRename(path):this.renameDialog(path)}, {name:'Move to trash',action:()=>this.deletePath(path)},
    ],x,y,()=>{
      const latest=vault.entries.get(path);
      return this.vault===vault&&token!==undefined&&this.treeEntryToken(path)===token
        &&latest?.path===path&&latest.type===type&&latest.revision===revision;
    });
  }
  private tabMenu(pane:Pane,tab=this.current(pane),x?:number,y?:number):void{
    this.activate(pane);
    const markdown=tab.kind==='note'&&(!tab.path||isMarkdown(tab.path));
    const modes:Command[]=markdown?(['reading','live'] as const).map((mode,index)=>({
      name:['Reading view','Live Edit'][index],
      action:async()=>{tab.mode=mode;pane.active=tab.id;await this.renderPane(pane);this.saveSession();},
    })):[];
    const path=tab.path;
    if(tab.kind==='note'&&path&&/\.base$/i.test(path)){const source=!tab.baseSource;modes.push({name:source?'Edit source':'Return to Base',action:()=>this.setBaseSource(pane,source,tab)});}
    this.menu([...(path&&isMarkdown(path)&&this.platform.recoveryHistory?[{name:'Version history',action:()=>this.showVersionHistory(path)}]:[]),{name:'Split right',action:()=>this.split('right',pane,tab)},{name:'Split down',action:()=>this.split('bottom',pane,tab)},...modes,...(path?[{name:'Rename…',action:()=>this.renameDialog(path)}]:[]),{name:'Close tab',action:()=>this.closeTab(pane,tab)}],x,y,()=>this.panes.includes(pane)&&pane.tabs.includes(tab)&&tab.path===path);
  }
  private menuPoint(event:MouseEvent):{x:number;y:number}{
    if(event.type!=='contextmenu'&&event.currentTarget instanceof HTMLElement){const bounds=event.currentTarget.getBoundingClientRect();return{x:bounds.left,y:bounds.bottom};}
    return{x:event.clientX,y:event.clientY};
  }
  private tabMenuAt(pane:Pane,anchor:HTMLElement):void{
    const bounds=anchor.getBoundingClientRect();this.tabMenu(pane,this.current(pane),bounds.left,bounds.bottom);
  }
  private modeMenu(anchor:HTMLElement):void{this.tabMenuAt(this.activePane,anchor);}

  /** Ordinary note mutations only: the Rust query supplies saved witnesses and
   * mappings; Tasks never maintains a second task store or rewrites checkboxes. */
  private createTasksHost(documents:DocumentService,getPane:()=>Pane,validateOwner:()=>void):TasksHost{
    const vault=this.vault;
    const definite=(message:string)=>Object.assign(new Error(message),{commitUncertain:false});
    const admit=()=>{validateOwner();if(getPane().runtime?.phase!=='active')throw definite('The Tasks view is closing.');};
    const checkClean=(path:string)=>{const buffer=this.buffers.get(path);if(buffer?.dirty||buffer?.error)throw definite('This note has unsaved or failed changes. Save or resolve its draft before editing it from Tasks.');};
    const checkWitnessClean=(witness:DocumentTaskWitness)=>{const entry=[...vault.entries.values()].find(entry=>entry.entryId===witness.entryId);if(entry)checkClean(entry.path);};
    const canonical=(value:string,allowEmpty=false)=>{
      if(allowEmpty&&value==='')return value;
      if(!value||value!==value.trim()||value.startsWith('/')||value.includes('\\')||/[\u0000-\u001f\u007f-\u009f]/.test(value)||/^[A-Za-z]:/.test(value)||value.split('/').some(part=>!part||part==='.'||part==='..')||value.split('/')[0].toLowerCase()==='.zorid')throw definite('Choose a valid relative folder or file path inside this vault.');
      return value;
    };
    const readWitness=async(witness:DocumentTaskWitness)=>{
      validateOwner();checkWitnessClean(witness);
      const read=await vault.readDurableTextById(witness.entryId);validateOwner();
      if(!read||read.entryId!==witness.entryId||read.revision!==witness.revision||vault.entries.get(read.path)?.entryId!==witness.entryId)throw definite('The saved note or Type definition changed. Refresh Tasks before applying this draft.');
      checkClean(read.path);return read;
    };
    const folders=async(folder:string)=>{
      canonical(folder,true);let current='';
      for(const part of folder?folder.split('/'):[]){
        validateOwner();current=current?current+'/'+part:part;
        const entry=vault.entries.get(current);if(entry){if(entry.type!=='folder')throw definite('A file occupies the requested task folder.');continue;}
        this.requireAvailableTreePath(vault,current);await vault.createFolder(current,validateOwner);validateOwner();
      }
    };
    const captures=new Map<string,{encoded:string;path:string;attempted:boolean;committed:boolean}>();
    return{
      documents,
      typeDefinitionIds:()=>{
        validateOwner();const entries=[...vault.entries.values()].filter(entry=>entry.type==='file'&&/^Types\/.+\.ya?ml$/i.test(entry.path)).sort((a,b)=>a.path.localeCompare(b.path));
        if(entries.length>128)throw definite('Tasks supports up to 128 Type definition files in Types/. Remove unused definitions or choose a smaller inventory.');
        if(entries.some(entry=>!entry.entryId))throw definite('Some Type definitions are still loading. Refresh Tasks to retry.');
        return entries.map(entry=>entry.entryId!);
      },
      createTask:async(request:TaskCaptureRequest)=>{
        const input=structuredClone(request),encoded=JSON.stringify(input);
        let capture=captures.get(input.captureId);
        if(capture){if(capture.encoded!==encoded)throw definite('This capture identity belongs to different task content.');if(capture.committed)return;if(capture.attempted)throw Object.assign(new Error('The earlier task create is unconfirmed. Inspect the vault before resolving it; a new create has not been sent.'),{commitUncertain:true});}
        try{
          admit();canonical(input.destination,true);
          const title=input.title.trim();
          if(!title||title!==input.title||/[\\/\u0000-\u001f\u007f-\u009f]/.test(title)||title==='.'||title==='..'||new TextEncoder().encode(title).length>200)throw definite('Use a task title of at most 200 bytes without slashes or control characters.');
          checkWitnessClean(input.typeWitness);await readWitness(input.typeWitness);
          await folders(input.destination);const type=await readWitness(input.typeWitness);validateOwner();
          let source='# '+title+'\n';for(const[key,value]of Object.entries(input.properties))source=setProperty(source,key,value);
          if(typeof input.properties.type!=='string'||!input.properties.type)throw definite('The task Type has no saved capture defaults. Refresh Tasks.');
          if(!capture){let index=0,path='';do{path=(input.destination?input.destination+'/':'')+title+(index?' '+index:'')+'.md';index++;}while(vault.entries.has(path));this.requireAvailableTreePath(vault,path);capture={encoded,path,attempted:false,committed:false};captures.set(input.captureId,capture);}
          validateOwner();capture.attempted=true;
          const validateCreate=()=>{
            try{validateOwner();checkClean(type.path);const entry=vault.entries.get(type.path);if(entry?.entryId!==input.typeWitness.entryId||entry.revision!==input.typeWitness.revision)throw definite('The Type definition changed before task creation. Refresh Tasks.');}
            catch(error){throw Object.assign(error instanceof Error?error:new Error('Task creation is no longer admitted.'),{commitUncertain:false});}
          };
          await vault.create(capture.path,source,validateCreate);capture.committed=true;
        }catch(error){
          if(!capture?.attempted)throw Object.assign(error instanceof Error?error:new Error('Task could not be created.'),{commitUncertain:false});
          // Once ordinary create was invoked, unknown results stay unconfirmed.
          // Never allocate another filename or operation as an automatic retry.
          if((error as {commitUncertain?:unknown})?.commitUncertain===false)captures.delete(input.captureId);
          throw error;
        }
      },
      editTask:async(request)=>{
        const input=structuredClone(request);admit();checkWitnessClean(input.witness);checkWitnessClean(input.typeWitness);
        await readWitness(input.typeWitness);const note=await readWitness(input.witness);
        const buffer=await this.bufferFor(note.path);validateOwner();checkClean(note.path);
        const witness=buffer.savedDurableWitness;
        if(!witness||witness.entryId!==input.witness.entryId||witness.revision!==input.witness.revision||buffer.text!==note.content)throw definite('The note buffer has a different saved revision. Open the note and resolve its draft before editing it from Tasks.');
        if(readProperties(buffer.text).find(property=>property.key==='type')?.value!==input.expectedTypeId)throw definite('This note uses a different Type. Refresh Tasks before editing its properties.');
        let source=buffer.text;for(const[key,value]of Object.entries(input.properties))source=value===null?removeProperty(source,key):setProperty(source,key,value,'text');
        // Recheck the Type immediately before synchronous draft admission.
        // The ordinary durable NoteBuffer owns the note's expected-revision CAS.
        // Do not retain a Type-file lifetime validator on the note: a later Type
        // edit must not permanently poison unrelated future note saves/recovery.
        await readWitness(input.typeWitness);validateOwner();checkClean(note.path);
        const saved=buffer.savedDurableWitness;
        if(this.buffers.get(note.path)!==buffer||buffer.path!==note.path||saved?.entryId!==input.witness.entryId||saved.revision!==input.witness.revision||buffer.text!==note.content)throw definite('The task changed before saving. Refresh Tasks before applying this draft.');
        this.updateMarkdownBuffer(buffer,source);
        for(const pane of this.loadedViews())if(pane.viewPath===note.path){pane.editor?.setValue(source);pane.refreshPreview?.();pane.properties?.refresh();if(pane.runtime?.phase==='active')pane.runtime.touch();}
        await buffer.flush();
      },
      openTask:async(witness)=>{
        admit();const pane=getPane(),activation=this.paneActivationRevision,tab=this.current(pane);
        const read=await vault.readDurableTextById(witness.entryId);validateOwner();
        if(!read||read.revision!==witness.revision||this.activePane!==pane||this.current(pane)!==tab||vault.entries.get(read.path)?.entryId!==witness.entryId)throw definite('This saved task changed or moved. Refresh Tasks before opening it.');
        // The controller owns this callback's running promise. Dispatch after
        // returning so openNote's normal pane flush cannot await itself.
        this.run(async()=>{validateOwner();if(this.tasksRetiring||this.activePane!==pane||this.current(pane)!==tab)throw definite('The Tasks selection changed before opening.');await this.openNote(read.path,true,pane,true,'',activation,()=>!this.tasksRetiring&&this.vault===vault&&this.activePane===pane&&this.current(pane)===tab&&vault.entries.get(read.path)?.entryId===witness.entryId&&vault.entries.get(read.path)?.revision===witness.revision,witness.entryId);});
      },
      installPreset:async(request:TaskPreset)=>{
        const preset=structuredClone(request);admit();canonical(preset.type.path);canonical(preset.base.path);canonical(preset.destination);
        if(!/^Types\/.+\.ya?ml$/i.test(preset.type.path))throw definite('Place the Type definition inside Types/ so Tasks can discover it.');
        await vault.reload();validateOwner();
        const plan=planTaskPreset(preset,[...vault.entries.values()].map(entry=>({path:entry.path,kind:entry.type})));
        if(!plan.ready)throw definite('Preset destinations already exist. Choose unused Type and Base file paths.');
        let created=0,typeEntry:VaultEntry|undefined;
        const validateCreate=()=>{validateOwner();if(typeEntry){checkClean(typeEntry.path);const current=vault.entries.get(typeEntry.path);if(current?.entryId!==typeEntry.entryId||current?.revision!==typeEntry.revision)throw definite('The newly created Type changed before its Base could be created.');}};
        try{for(const file of plan.files){await folders(parentOf(file.path));validateCreate();this.requireAvailableTreePath(vault,file.path);const entry=await vault.create(file.path,file.source,validateCreate);if(file.path===preset.type.path)typeEntry=entry;created++;}await folders(preset.destination);}
        catch(error){throw new Error(created?'The preset was only partly created. Existing files were preserved; inspect the vault and choose unused paths before retrying.':error instanceof Error?error.message:'The preset could not be created.');}
      },
      subscribe:listener=>{const stops=[vault.on('create',listener),vault.on('modify',listener),vault.on('delete',listener),vault.on('rename',listener)];return()=>stops.forEach(stop=>stop());},
    };
  }

  private async openTasks():Promise<void>{
    if(this.platform.editorOnly||this.tasksRetiring)return;
    const pane=this.activePane,generation=this.vaultGeneration,version=pane.renderVersion;
    const intent=(this.navigationIntent.get(pane)??0)+1;this.navigationIntent.set(pane,intent);
    await this.flushPane(pane);if(this.tasksRetiring||generation!==this.vaultGeneration||intent!==this.navigationIntent.get(pane)||version!==pane.renderVersion||!this.panes.includes(pane))return;
    const existing=pane.tabs.find(tab=>tab.kind==='tasks');
    if(existing)pane.active=existing.id;
    else{const tab:Tab={id:makeId(),path:null,mode:'reading',kind:'tasks'};pane.tabs.push(tab);pane.active=tab.id;}
    this.activate(pane);await this.renderPane(pane);this.saveSession();
  }
  private async openCalendar():Promise<void>{
    if(this.platform.editorOnly)return;
    const pane=this.activePane,generation=this.vaultGeneration,version=pane.renderVersion;
    const intent=(this.navigationIntent.get(pane)??0)+1;this.navigationIntent.set(pane,intent);
    await this.flushPane(pane);if(generation!==this.vaultGeneration||intent!==this.navigationIntent.get(pane)||version!==pane.renderVersion||!this.panes.includes(pane))return;
    const existing=pane.tabs.find(tab=>tab.kind==='calendar');
    if(existing)pane.active=existing.id;
    else{const tab:Tab={id:makeId(),path:null,mode:'reading',kind:'calendar'};pane.tabs.push(tab);pane.active=tab.id;}
    this.activate(pane);await this.renderPane(pane);this.saveSession();
  }
  private async openGraph():Promise<void>{await this.flushPane(this.activePane);const tab:Tab={id:makeId(),path:null,mode:'reading',kind:'graph'};this.activePane.tabs.push(tab);this.activePane.active=tab.id;this.renderRight();this.run(()=>this.renderPane(this.activePane));this.saveSession();}
  private renderGraph(parent:HTMLElement):void{
    const vault=this.vault,state=vault.metadataFrame,frame=state?.frame??null,previous=this.metadataGraphs.get(parent);
    const updateStatus=(container:HTMLElement,status:HTMLElement)=>{
      if(state)container.dataset.metadataStatus=state.status;else delete container.dataset.metadataStatus;
      status.textContent=state?this.metadataDisplayMessage(state)??'':'';status.hidden=!status.textContent;
      const empty=container.querySelector('.metadata-projection-empty');if(empty)empty.textContent=state&&(state.status!=='current'||!frame!.coverageComplete)?'No notes in this saved snapshot.':'Create notes and links to see them here.';
    };
    if(state&&previous?.vault===vault&&previous.frame===frame&&previous.container.parentNode===parent){updateStatus(previous.container,previous.status);return;}
    parent.querySelector(':scope > .graph-view')?.remove();
    const container=el('div','graph-view');const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 800 600');svg.setAttribute('aria-label','Graph of linked notes');
    const metadata=state?frame?.metadata:vault.metadata;
    const files=state?(frame?[...frame.entries()].flatMap(([,entry])=>entry.kind==='file'&&entry.path.endsWith('.md')?[entry]:[]):[]):[...vault.entries.values()].filter(entry=>entry.type==='file'&&entry.path.endsWith('.md'));
    const points=new Map(files.map((entry,index)=>[entry.path,{x:400+Math.cos(index/Math.max(1,files.length)*Math.PI*2)*Math.min(260,60+files.length*12),y:300+Math.sin(index/Math.max(1,files.length)*Math.PI*2)*Math.min(220,60+files.length*10)}]));
    for(const entry of files){const from=points.get(entry.path)!;for(const link of metadata?.get(entry.path)?.links||[]){const resolved=metadata?.resolveLink(entry.path,link.target,link.kind);const to=resolved?points.get(resolved):null;if(!to)continue;const line=document.createElementNS(svg.namespaceURI,'line');for(const[k,v]of Object.entries({x1:from.x,y1:from.y,x2:to.x,y2:to.y}))line.setAttribute(k,String(v));svg.append(line);}}
    for(const entry of files){const point=points.get(entry.path)!;const group=document.createElementNS(svg.namespaceURI,'g');group.setAttribute('tabindex','0');group.setAttribute('role','link');group.setAttribute('aria-label',nameOf(entry.path));const circle=document.createElementNS(svg.namespaceURI,'circle');circle.setAttribute('cx',String(point.x));circle.setAttribute('cy',String(point.y));circle.setAttribute('r','6');const label=document.createElementNS(svg.namespaceURI,'text');label.setAttribute('x',String(point.x));label.setAttribute('y',String(point.y+23));label.textContent=nameOf(entry.path);group.append(circle,label);
      const row=frame?.row(entry.path),saved=row?.kind==='file'?row.value.entry:undefined;
      const open=()=>{
        const pane=this.activePane,activation=this.paneActivationRevision;
        const current=()=>this.vault===vault&&this.activePane===pane&&this.paneActivationRevision===activation&&!this.platformReleased&&!this.closing&&pane.content===parent&&container.isConnected;
        if(current())this.run(()=>current()?this.openNote(entry.path,false,pane,true,'',activation,current,saved?.id):undefined);
      };
      group.addEventListener('click',open);group.addEventListener('keydown',event=>{if((event as KeyboardEvent).key==='Enter')open();});svg.append(group);
    }
    const status=el('p','graph-empty metadata-projection-status');status.setAttribute('role','status');updateStatus(container,status);container.append(status,svg);
    if(!files.length&&(!state||frame))container.append(el('p','graph-empty metadata-projection-empty',state&&(state.status!=='current'||!frame!.coverageComplete)?'No notes in this saved snapshot.':'Create notes and links to see them here.'));
    parent.append(container);this.metadataGraphs.set(parent,{vault,frame,container,status});
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
  private saveSession():void{if(!this.platform||this.restoringLayout)return;const pin=this.sidebarBase?this.sidebarBase.pinned?this.sidebarBase.pinnedContext:undefined:this.sidebarPinnedContext;this.panes.forEach(pane=>this.capturePaneState(pane));localStorage.setItem(this.sessionKey(),JSON.stringify({...this.sessionState,rightTab:this.rightTab,sidebarBasePath:this.sidebarBasePath,sidebarBasePinned:!!pin,sidebarBaseContext:pin?.path,sidebarBaseContextEntryId:pin?.entryId,rightHidden:this.root.classList.contains('right-hidden'),leftHidden:this.root.classList.contains('left-hidden'),autoRevealFiles:this.autoRevealFiles,layout:this.splitLayout?.serialize(),activePaneId:this.activePane?.id,panes:this.panes.map(p=>({...p.persisted,id:p.id,tabs:p.tabs,active:p.tabs.findIndex(t=>t.id===p.active)})),collapsed:[...this.collapsed],bookmarks:[...this.bookmarks]}));this.sidebarPinnedContext=pin;}
  private help():void{const{content}=modal('Help');content.append(el('h2','','Get started'),el('p','',`Link to another note with [[note name]]. Customize workspace shortcuts in Settings → Hotkeys. Create note: ${this.hotkeys.label('new-note')||'not assigned'}. Find file: ${this.hotkeys.label('quick-switcher')||'not assigned'}. Command palette: ${this.hotkeys.label('command-palette')||'not assigned'}.`));
  }
  private hotkeySurfaceBlocked(): boolean {
    return this.startupFailed||this.closing||this.tasksRetiring||!!document.querySelector('.modal-overlay,[aria-modal="true"],[role="menu"]');
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
    // Reading and PDF search remain focused-view commands, sharing the editor's reserved
    // primary-F chord rather than becoming a global configurable command.
    const primary=this.hotkeys.platform==='mac'?event.metaKey&&!event.ctrlKey:event.ctrlKey&&!event.metaKey;
    if(primary&&!event.shiftKey&&!event.altKey&&!event.repeat&&event.key.toLowerCase()==='f'){
      if(this.activePane?.readingFind){event.preventDefault();this.activePane.readingFind.open();}
      else if(this.activePane?.pdfView){event.preventDefault();this.activePane.pdfView.showSearch();}
    }
  }
  private async flushPane(pane:Pane):Promise<void>{await this.finishInlinePublicationAt(this.current(pane)?.path);await pane.properties?.flush();await pane.tasksView?.flush();await pane.calendarView?.flush();await pane.baseEmbeds?.flush();await pane.baseView?.flush();await pane.canvasView?.flush();const path=this.current(pane)?.path;if(path)await this.buffers.get(path)?.flushForNavigation();}
  async flush():Promise<void>{if(this.platformReleased||this.platformDrained)return;if(this.hasPendingBaseCreation())throw new Error('Base creation is unconfirmed. Retry New base in its original folder before closing or switching vaults.');await this.finishInlinePublications();await this.flushBaseNewItem();await this.sidebarBase?.session.flush();for(const pane of [...this.panes,...this.cachedViews.values()]){await pane.properties?.flush();await pane.tasksView?.flush();if(pane.tasksView?.hasPendingChanges())throw new Error('Tasks has unsaved or unconfirmed changes. Save, discard, or resolve them before closing.');await pane.calendarView?.flush();await pane.baseEmbeds?.flush();await pane.baseView?.flush();await pane.canvasView?.flush();}await this.flushBaseNewItem();for(const buffer of this.buffers.values())await buffer.flush();}
  async destroy():Promise<void>{let cancelTasksClose:(recover?:boolean)=>void=()=>{};const searchWasSuspended=this.documentSearchSuspended;this.documentSearchSuspended=true;this.clearDocumentSearch();try{this.hideNativeEditorToolbar();this.nativeEditorCleanup?.();this.nativeEditorCleanup=undefined;this.nativeDocumentCleanup?.();this.nativeDocumentCleanup=undefined;this.mobileLifecycleCleanup?.();this.mobileLifecycleCleanup=undefined;this.vaultRequest++;await this.vaultTransition;this.menuSerial++;await dismissContextMenu(this.root.ownerDocument);await this.flush();await this.closeBaseNewItem();await this.sidebarBase?.session.close();this.sidebarBase=undefined;this.sidebarBaseIntent++;cancelTasksClose=await this.prepareTasksViewsClose();this.saveSession();this.disposers.forEach(dispose=>dispose());clearTimeout(this.reloadTimer);this.tabDocking?.destroy();this.tabDocking=undefined;await this.clearCachedViews();for(const pane of this.panes)await this.disposePaneViews(pane);for(const buffer of this.buffers.values())await buffer.dispose();await this.drainMetadataOpenings();await this.closeVaultMetadata(this.vault);await this.closeRetiredVaultMetadata();if(!this.platformReleased&&this.platform?.release){await this.platform.release();this.releaseDocumentSearchOwner(this.vault);}this.platformReleased=true;this.vaultGeneration++;this.splitLayout?.destroy();this.splitLayout=undefined;this.attachments?.destroy();this.canvasDocumentInput?.destroy();this.canvasDocumentInput=undefined;this.treeDrag?.destroy();this.treeDrag=undefined;this.treeRename?.session.dispose();this.treeRename=undefined;this.hotkeyCleanup?.();this.hotkeyCleanup=undefined;document.removeEventListener('keydown',this.keyListener);document.removeEventListener('contextmenu',this.inputContextListener);window.removeEventListener('beforeunload',this.unloadListener);this.initialized=false;this.closeCleanup?.();this.closeCleanup=undefined;this.disposeShell();this.root.replaceChildren();cancelTasksClose(false);}catch(error){cancelTasksClose();if(!this.platformReleased)this.documentSearchSuspended=searchWasSuspended;throw error;}}
}
