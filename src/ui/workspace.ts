import { Vault } from '../core/index.ts';
import type { VaultEntry } from '../core/index.ts';
import { pickDesktopVault } from '../platform/index.ts';
import type { PlatformVault } from '../platform/index.ts';
import { el, icon, button, textButton, modal, notice, promptName } from './dom.ts';
import { renderMarkdown } from './markdown.ts';
import type { EditorHandle, EditorOptions } from './editor.ts';
import { NoteBuffer } from './note-buffer.ts';
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

type Mode = 'live' | 'reading';
interface Tab { id: string; path: string | null; mode: Mode; kind: 'note' | 'graph'; }
interface Pane { id: string; tabs: Tab[]; active: string; element: HTMLElement; editor?: EditorHandle; imageView?:ImageView; embeds?: MarkdownEmbeds; properties?: PropertiesView; propertyTimer?:ReturnType<typeof setTimeout>; refreshPreview?:()=>void; renderVersion: number; history: string[]; historyIndex: number; persisted?: Record<string, unknown>; }
interface Settings extends AttachmentImportSettings { theme: 'system' | 'dark' | 'light'; fontSize: number; readableWidth: boolean; showInlineTitle: boolean; defaultMode: 'live'; useTab: boolean; tabSize: number; smartIndentList: boolean; }
interface Command { name: string; shortcut?: string; icon?: string; action: () => void | Promise<void>; }
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
  settings: Settings = { theme: 'system', fontSize: 16, readableWidth: true, showInlineTitle: true, defaultMode: 'live', useTab:true, tabSize:4, smartIndentList:true, ...DEFAULT_ATTACHMENT_IMPORT_SETTINGS };
  private editorFactory?: EditorFactory;
  private sidebar = el('aside', 'sidebar');
  private sidebarContent = el('div', 'sidebar-content');
  private paneContainer = el('main', 'panes');
  private right = el('aside', 'right-sidebar');
  private rightContent = el('div', 'right-content');
  private status = el('footer', 'status-bar');
  private treeTab: 'files' | 'search' | 'bookmarks' = 'files';
  private rightTab: 'backlinks' | 'outline' | 'tags' = 'backlinks';
  private collapsed = new Set<string>();
  private bookmarks = new Set<string>();
  private query = '';
  private searchGeneration = 0;
  private reverseSort = false;
  private disposers: (() => void)[] = [];
  private keyListener = (event: KeyboardEvent) => this.onKey(event);
  private unloadListener = (event: BeforeUnloadEvent) => {
    if ([...this.buffers.values()].some(buffer => buffer.dirty)) { event.preventDefault(); event.returnValue = ''; }
  };
  private context?: HTMLElement;
  private reloadTimer?: ReturnType<typeof setTimeout>;
  private vaultGeneration = 0;
  private initialized = false;
  private attachments?:AttachmentResources;
  private attachmentImporter?: AttachmentImporter;
  private sessionState: Record<string, unknown> = {};

  constructor(root: HTMLElement, editorFactory?: EditorFactory) { this.root = root; this.editorFactory = editorFactory; }
  private run(operation: () => unknown | Promise<unknown>): void { Promise.resolve().then(operation).catch(error => notice(error instanceof Error ? error.message : String(error))); }
  private sessionKey(): string { return `zorid:workspace:${this.platform.id}`; }

  async start(platform: PlatformVault | null): Promise<void> {
    if (!this.initialized) {
      document.addEventListener('keydown', this.keyListener);
      window.addEventListener('beforeunload', this.unloadListener);
      this.initialized = true;
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
    this.root.replaceChildren();
    const screen = el('div', 'vault-picker'); const panel = el('div', 'vault-picker-panel');
    panel.append(el('div', 'app-symbol', '◈'), el('h1', '', 'Zorid'), el('p', 'muted', 'Your notes, on your device.'));
    const row = el('div', 'vault-picker-row');
    const description = el('div'); description.append(el('strong', '', 'Open folder as vault'), el('p', 'muted', 'Choose a folder containing your notes.'));
    row.append(description, textButton('Open', () => this.run(() => this.chooseVault()), 'mod-cta')); panel.append(row); screen.append(panel); this.root.append(screen);
  }

  async chooseVault(): Promise<void> {
    await this.flush();
    const next = await pickDesktopVault();
    if (next) await this.openVault(next);
    else if (!window.zorid) notice('This vault is stored on this device. Folder selection requires the desktop app.');
  }

  async openVault(platform: PlatformVault): Promise<void> {
    await this.flush();
    for (const buffer of this.buffers.values()) await buffer.dispose();
    for (const dispose of this.disposers) dispose(); this.disposers = [];
    clearTimeout(this.reloadTimer);
    this.panes.forEach(pane => this.disposePaneViews(pane)); this.buffers.clear();
    this.attachments?.destroy();
    this.platform = platform; this.vault = new Vault(platform.adapter); this.vaultGeneration++;
    await this.vault.initialize();
    this.attachments=new AttachmentResources(this.vault);
    this.attachmentImporter=new AttachmentImporter(this.vault);
    this.panes = []; this.collapsed.clear(); this.bookmarks.clear(); this.sessionState = {};
    this.buildShell();
    let restored = false;
    try {
      const saved = JSON.parse(localStorage.getItem(this.sessionKey()) || 'null');
      if (saved) {
        this.sessionState = saved;
        this.collapsed = new Set(saved.collapsed || []); this.bookmarks = new Set(saved.bookmarks || []);
        for (const item of (saved.panes || []).slice(0, 4)) {
          const tabs: Tab[] = (item.tabs || []).filter((tab: Tab) => tab.kind === 'graph' || !tab.path || this.vault.entries.has(tab.path)).map((tab: Tab) => ({...tab, mode:tab.mode==='reading'?'reading':'live', id:makeId()}));
          const pane = this.addPane(tabs.length ? tabs : undefined); pane.active = pane.tabs[Math.min(item.active || 0, pane.tabs.length - 1)].id; pane.persisted = item;
        }
        restored = this.panes.length > 0;
      }
    } catch { /* Malformed workspace state does not prevent opening notes. */ }
    if (!restored) this.addPane();
    this.activate(this.panes[0]);
    for (const pane of this.panes) await this.renderPane(pane);
    this.disposers.push(this.vault.on('create', () => this.renderSidebar()), this.vault.on('delete', change => {
      for (const pane of this.panes) for (const tab of [...pane.tabs]) if (tab.path === change.path || tab.path?.startsWith(change.path + '/')) {
        const buffer = this.buffers.get(tab.path);
        if (buffer?.dirty) { notice(`“${nameOf(tab.path)}” was removed outside the app. Your unsaved text is retained.`); continue; }
        tab.path = null; void this.renderPane(pane);
      }
      this.renderSidebar(); this.renderRight();
    }), this.vault.on('rename', change => {
      const oldPath = change.oldPath!;
      for (const [previous, buffer] of [...this.buffers]) if (previous === oldPath || previous.startsWith(oldPath + '/')) {
        const next = change.path + previous.slice(oldPath.length);
        this.buffers.delete(previous); this.buffers.set(next, buffer); this.run(() => buffer.relocate(next));
      }
      for (const pane of this.panes) for (const tab of pane.tabs) if (tab.path === oldPath || tab.path?.startsWith(oldPath + '/')) {
        const previous = tab.path; tab.path = change.path + previous.slice(oldPath.length);
      }
      this.renderSidebar(); this.renderRight(); this.panes.forEach(pane => void this.renderPane(pane)); this.saveSession();
    }), this.vault.on('modify', change => {
      if(!isMarkdown(change.path)){for(const pane of this.panes)if(this.current(pane)?.path===change.path)this.run(()=>this.renderPane(pane));return;}
      const buffer = this.buffers.get(change.path);
      if (buffer && !buffer.dirty) this.run(async () => { await buffer.reload(); for (const pane of this.panes) if (this.current(pane)?.path === change.path) { if (this.current(pane).mode === 'reading') await this.renderPane(pane); else pane.editor?.setValue(buffer.text); } this.renderRight(); });
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
  }

  private buildShell(): void {
    this.root.replaceChildren(); this.root.className = 'workspace';
    const ribbon = el('nav', 'ribbon'); ribbon.setAttribute('aria-label', 'Ribbon');
    const top = el('div', 'ribbon-top');
    top.append(button('search', 'Open quick switcher (⌘O)', () => this.quickSwitcher()), button('graph', 'Open graph view', () => this.openGraph()), button('calendar', "Open today's daily note", () => this.run(() => this.dailyNote())), button('terminal', 'Open command palette (⌘P)', () => this.commandPalette()));
    const bottom = el('div', 'ribbon-bottom'); bottom.append(button('folder', 'Open another vault', () => this.run(() => this.chooseVault())), button('help', 'Help', () => this.help()), button('settings', 'Settings (⌘,)', () => this.showSettings())); ribbon.append(top, bottom);
    this.sidebar = el('aside', 'sidebar'); this.sidebar.setAttribute('aria-label', 'Left sidebar');
    const title = el('div', 'titlebar'); title.append(button('sidebar', 'Toggle left sidebar', () => this.toggleLeft()));
    const tabs = el('div', 'sidebar-tabs');
    for (const [type, glyph, label] of [['files','folder','Files'],['search','search','Search'],['bookmarks','bookmark','Bookmarks']] as const) {
      const control = button(glyph, label, () => { this.treeTab = type; this.renderSidebar(); }); control.dataset.type = type; tabs.append(control);
    }
    const tools = el('div', 'sidebar-toolbar'); tools.append(button('file','New note',() => this.run(() => this.newNote())),button('folder','New folder',() => this.run(() => this.newFolder())),button('sort','Change sort order',() => {this.reverseSort = !this.reverseSort; this.renderSidebar();}),button('collapse','Collapse all folders',() => {this.collapsed = new Set([...this.vault.entries.values()].filter(e=>e.type==='folder').map(e=>e.path)); this.renderSidebar();}));
    this.sidebarContent = el('div','sidebar-content');
    const switcher = textButton(this.platform.label, () => this.run(() => this.chooseVault()), 'vault-switcher'); switcher.prepend(icon('folder')); switcher.append(icon('down',14));
    this.sidebar.append(title,tabs,tools,this.sidebarContent,switcher);
    const center = el('section','workspace-center'); this.paneContainer = el('main','panes'); center.append(this.paneContainer);
    this.right = el('aside','right-sidebar'); this.right.setAttribute('aria-label','Right sidebar');
    const rightTabs = el('div','right-tabs');
    for (const [type,glyph,label] of [['backlinks','link','Backlinks'],['outline','list','Outline'],['tags','tag','Tags']] as const) rightTabs.append(button(glyph,label,()=>{this.rightTab=type;this.renderRight();}));
    rightTabs.append(button('rightbar','Toggle right sidebar',()=>this.toggleRight())); this.rightContent=el('div','right-content'); this.right.append(rightTabs,this.rightContent);
    this.status = el('footer','status-bar'); this.status.setAttribute('aria-live','polite');
    this.root.append(ribbon,this.sidebar,center,this.right,this.status);
    this.addResizeHandle(this.sidebar,'left'); this.addResizeHandle(this.right,'right');
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
  private addPane(tabs?: Tab[]): Pane {
    const first: Tab = {id:makeId(),path:null,mode:this.settings.defaultMode,kind:'note'};
    const pane: Pane={id:makeId(),tabs:tabs||[first],active:tabs?.[0]?.id||first.id,element:el('section','pane'),renderVersion:0,history:[],historyIndex:-1};
    pane.element.addEventListener('focusin',()=>this.activate(pane)); pane.element.onpointerdown=()=>this.activate(pane);
    this.panes.push(pane); this.paneContainer.append(pane.element); return pane;
  }
  private activate(pane: Pane): void { this.activePane=pane; this.panes.forEach(p=>p.element.classList.toggle('is-active',p===pane)); this.renderRight(); this.renderStatus(); }
  async openNote(path:string,newTab=false,pane=this.activePane,recordHistory=true): Promise<void> {
    if(this.vault.entries.get(path)?.type!=='file') throw new Error(`File not found: ${path}`);
    const current=this.current(pane); if(current?.path) await this.buffers.get(current.path)?.flush();
    const existing=pane.tabs.find(tab=>tab.path===path&&tab.kind==='note');
    if(existing&&!newTab) pane.active=existing.id;
    else if(!newTab&&current){if(current.kind==='graph')current.mode=this.settings.defaultMode;current.path=path;current.kind='note';}
    else {const tab:Tab={id:makeId(),path,mode:this.settings.defaultMode,kind:'note'};pane.tabs.push(tab);pane.active=tab.id;}
    if(recordHistory&&pane.history[pane.historyIndex]!==path){pane.history=pane.history.slice(0,pane.historyIndex+1);pane.history.push(path);pane.historyIndex=pane.history.length-1;}
    this.activate(pane); await this.renderPane(pane); this.renderSidebar();this.renderRight();this.saveSession();
    if(matchMedia('(max-width: 700px)').matches)this.root.classList.add('left-hidden');
  }

  private async bufferFor(path:string):Promise<NoteBuffer>{
    let buffer=this.buffers.get(path); if(buffer){await buffer.load();return buffer;}
    buffer=new NoteBuffer(this.vault,path,{storage:localStorage,storageKey:`zorid:draft:${this.platform.id}`,onState:()=>{this.renderStatus();}});
    this.buffers.set(path,buffer);
    try{await buffer.load();return buffer;}catch(error){this.buffers.delete(path);throw error;}
  }

  async renderPane(pane:Pane):Promise<void>{
    const version=++pane.renderVersion; this.disposePaneViews(pane);pane.element.replaceChildren();
    const tab=this.current(pane); if(!tab)return;
    const bar=el('div','tab-bar'); bar.setAttribute('role','tablist');
    bar.append(button('sidebar','Toggle left sidebar',()=>this.toggleLeft(),'pane-sidebar-toggle'));
    for(const item of pane.tabs){
      const node=el('div',`tab${item.id===tab.id?' is-active':''}`);node.role='tab';node.tabIndex=item.id===tab.id?0:-1;node.setAttribute('aria-selected',String(item.id===tab.id));node.draggable=true;
      node.append(icon(item.kind==='graph'?'graph':'file',15),el('span','tab-title',item.kind==='graph'?'Graph view':item.path?nameOf(item.path):'New tab'));
      const close=button('close','Close tab',event=>{event.stopPropagation();this.run(()=>this.closeTab(pane,item));},'tab-close');node.append(close);
      const select=()=>this.run(async()=>{if(tab.path)await this.buffers.get(tab.path)?.flush();pane.active=item.id;this.activate(pane);await this.renderPane(pane);this.saveSession();});node.onclick=select;
      node.onkeydown=event=>{if(event.key==='Enter'||event.key===' ')select();if(event.key==='ArrowRight'||event.key==='ArrowLeft'){event.preventDefault();const index=pane.tabs.indexOf(item);pane.active=pane.tabs[(index+(event.key==='ArrowRight'?1:pane.tabs.length-1))%pane.tabs.length].id;this.run(()=>this.renderPane(pane));}};
      node.ondragstart=event=>event.dataTransfer?.setData('application/x-zorid-tab',JSON.stringify({pane:pane.id,tab:item.id}));
      node.ondragover=event=>event.preventDefault();node.ondrop=event=>{event.preventDefault();try{const data=JSON.parse(event.dataTransfer?.getData('application/x-zorid-tab')||'null');const from=this.panes.find(p=>p.id===data.pane);const moving=from?.tabs.find(t=>t.id===data.tab);if(!from||!moving||moving===item)return;from.tabs=from.tabs.filter(t=>t!==moving);pane.tabs.splice(pane.tabs.indexOf(item),0,moving);pane.active=moving.id;if(!from.tabs.length)from.tabs.push({id:makeId(),path:null,mode:this.settings.defaultMode,kind:'note'});if(!from.tabs.some(t=>t.id===from.active))from.active=from.tabs[0].id;this.run(async()=>{await this.renderPane(from);if(from!==pane)await this.renderPane(pane);this.saveSession();});}catch{/* Not an app tab. */}};
      bar.append(node);
    }
    bar.append(button('plus','New tab (⌘T)',()=>this.newTab(pane),'tab-add'),button('down','Tab menu',()=>this.tabMenu(pane)));
    pane.element.append(bar);
    const toolbar=el('div','pane-toolbar');
    const back=button('left','Navigate back',()=>this.run(()=>this.navigate(-1,pane)));back.disabled=pane.historyIndex<=0;
    const forward=button('right','Navigate forward',()=>this.run(()=>this.navigate(1,pane)));forward.disabled=pane.historyIndex>=pane.history.length-1;
    toolbar.append(back,forward,el('div','breadcrumbs',tab.path?tab.path.replace(/\.md$/,'').replaceAll('/',' / '):''));
    const actions=el('div','view-actions');
    if(!tab.path||isMarkdown(tab.path))actions.append(button(tab.mode==='reading'?'edit':'book',tab.mode==='reading'?'Switch to Live Edit (⌘E)':'Switch to reading view (⌘E)',()=>this.run(()=>this.toggleReading(pane))));
    actions.append(button('more','More options',()=>this.tabMenu(pane)),button('rightbar','Toggle right sidebar',()=>this.toggleRight()));toolbar.append(actions);pane.element.append(toolbar);
    if(tab.kind==='graph'){this.renderGraph(pane.element);return;}
    if(!tab.path){this.renderEmpty(pane);return;}
    const path=tab.path;
    if(!isMarkdown(path)){
      const host=el('div','attachment-view');pane.element.append(host);
      if(isImage(path))pane.imageView=createImageView(host,path,this.attachments!);
      else host.append(el('p','muted',`No viewer is available yet for ${path.split('.').at(-1)?.toUpperCase()||'this file type'}.`));
      this.renderStatus();return;
    }
    const scroll=el('div','note-scroll');scroll.classList.toggle('readable-width',this.settings.readableWidth);
    const title=el('input','note-title');title.value=nameOf(path);title.setAttribute('aria-label','Note title');title.hidden=!this.settings.showInlineTitle;
    title.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();title.blur();pane.editor?.focus();}};
    title.onblur=()=>{if(title.value.trim()&&title.value.trim()!==nameOf(path))this.run(()=>this.renamePath(path,title.value.trim()));};
    scroll.append(title);pane.element.append(scroll);
    try{
      const buffer=await this.bufferFor(path);if(version!==pane.renderVersion)return;
      {
        const host=el('div','properties-host');scroll.append(host);
        pane.properties=renderProperties(host,{getSource:()=>buffer.text,onChange:async next=>{
          buffer.update(next);
          for(const other of this.panes){other.embeds?.invalidate(path);if(this.current(other)?.path===path){other.editor?.setValue(next);other.refreshPreview?.();if(other!==pane)other.properties?.refresh();}}
          await buffer.flush();
        },openLink:target=>this.run(()=>this.followLink(path,target,pane))});
      }
      const createEmbeds=()=>new MarkdownEmbeds({vault:this.vault,resources:this.attachments,open:(source,target,kind)=>this.run(()=>this.followLink(source,target,pane,kind)),read:async target=>{const loaded=this.buffers.get(target);if(loaded){await loaded.load();if(loaded.dirty)return loaded.text;}return this.vault.cachedRead(target);},taskChange:(target,line,checked)=>this.changeTask(target,line,checked)});
      if(tab.mode==='reading'){
        const preview=el('div','markdown-preview');scroll.append(preview);
        pane.refreshPreview=()=>{
          pane.embeds?.destroy();
          const embeds=createEmbeds();
          pane.embeds=embeds;
          renderMarkdown(preview,buffer.text,(target,kind)=>this.run(()=>this.followLink(path,target,pane,kind)),(line,checked)=>this.run(()=>this.changeTask(path,line,checked)),{embed:request=>embeds.render(request,path),properties:false});
        };
        pane.refreshPreview();
      }else{
        const host=el('div','editor-host');scroll.append(host);
        const factory=this.editorFactory||(await import('./editor.ts')).createEditor;if(version!==pane.renderVersion)return;
        const embeds=createEmbeds();pane.embeds=embeds;const generation=this.vaultGeneration;
        pane.editor=factory(host,{value:buffer.text,mode:tab.mode,paths:()=>[...this.vault.entries.keys()],
          listOptions:{useTab:this.settings.useTab,tabSize:this.settings.tabSize,smartIndentList:this.settings.smartIndentList},
          renderEmbed:request=>{const dom=embeds.render(request,path);return{dom,destroy:()=>embeds.releaseEmbed(dom)};},
          transfers:{importFile:file=>this.importAttachment(file,path,generation),nativePath:file=>window.zorid?.getPathForFile?.(file)??'',onError:error=>notice(error instanceof Error?error.message:String(error))},
          onChange:value=>{buffer.update(value);this.renderStatus();for(const other of this.panes){other.embeds?.invalidate(path);if(this.current(other)?.path===path){if(other!==pane)other.editor?.setValue(value);clearTimeout(other.propertyTimer);other.propertyTimer=setTimeout(()=>{other.properties?.refresh();other.refreshPreview?.();},150);}}},open:target=>this.run(()=>this.followLink(path,target,pane))});
      }
      if(buffer.error)notice(buffer.error.message);
    }catch(error){scroll.append(el('p','error-message',error instanceof Error?error.message:String(error)));}
    this.renderStatus();
  }

  private disposePaneViews(pane:Pane):void{
    clearTimeout(pane.propertyTimer);pane.editor?.destroy();pane.editor=undefined;pane.imageView?.destroy();pane.imageView=undefined;pane.embeds?.destroy();pane.embeds=undefined;pane.properties?.destroy();pane.properties=undefined;pane.refreshPreview=undefined;
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

  private async changeTask(path:string,line:number,checked:boolean):Promise<void>{
    const buffer=await this.bufferFor(path),lines=buffer.text.split('\n');
    const marker=lines[line]?.match(/^([ \t]*(?:>[ \t]*)*(?:[-*+]|\d+[.)])[ \t]+\[)([^\]\r\n])(\])(?=[ \t]|\r?$)/);
    if(!marker)throw new Error('The task changed. Reopen the note before toggling it.');
    const at=marker[1].length;lines[line]=lines[line].slice(0,at)+(checked?'x':' ')+lines[line].slice(at+1);buffer.update(lines.join('\n'));await buffer.flush();
    for(const pane of this.panes){pane.embeds?.invalidate(path);if(this.current(pane)?.path===path){if(this.current(pane).mode==='reading')await this.renderPane(pane);else pane.editor?.setValue(buffer.text);}}
  }

  private renderEmpty(pane:Pane):void{
    const empty=el('div','empty-state');empty.append(el('h2','','No file is open'));
    const actions=el('div','empty-actions');
    for(const [label,shortcut,action]of [['Create new file','⌘ N',()=>this.run(()=>this.newNote())],['Go to file','⌘ O',()=>this.quickSwitcher()],['Open command palette','⌘ P',()=>this.commandPalette()]] as const){const row=textButton(label,action,'empty-action');row.append(el('kbd','',shortcut));actions.append(row);}empty.append(actions);pane.element.append(empty);
  }

  private renderSidebar():void{
    if(!this.vault)return;
    this.sidebar.querySelectorAll<HTMLElement>('.sidebar-tabs button').forEach(node=>node.classList.toggle('is-active',node.dataset.type===this.treeTab));
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
    const append=(parent:string,container:HTMLElement,depth:number)=>{
      for(const entry of entries.filter(entry=>parentOf(entry.path)===parent)){
        const folder=entry.type==='folder';const row=el('div',`tree-row${folder?' folder-row':''}${this.activePane&&this.current()?.path===entry.path?' is-active':''}`);
        row.style.paddingLeft=`${10+depth*16}px`;row.role='treeitem';row.tabIndex=0;row.title=entry.path;
        if(folder){row.setAttribute('aria-expanded',String(!this.collapsed.has(entry.path)));row.append(icon(this.collapsed.has(entry.path)?'right':'down',14));}
        else row.append(el('span','file-indent'));
        row.append(el('span','tree-label',folder?entry.path.split('/').at(-1):nameOf(entry.path)));
        const activate=()=>{if(folder){if(this.collapsed.has(entry.path))this.collapsed.delete(entry.path);else this.collapsed.add(entry.path);this.renderSidebar();this.saveSession();}else this.run(()=>this.openNote(entry.path));};
        row.onclick=event=>{if(!folder&&(event.metaKey||event.ctrlKey))this.run(()=>this.openNote(entry.path,true));else activate();};row.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();activate();}if(event.key==='F2')this.run(()=>this.renameDialog(entry.path));};
        row.oncontextmenu=event=>{event.preventDefault();this.fileMenu(entry,event.clientX,event.clientY);};
        row.draggable=true;row.ondragstart=event=>event.dataTransfer?.setData('application/x-zorid-file',entry.path);
        if(folder){row.ondragover=event=>event.preventDefault();row.ondrop=event=>{event.preventDefault();const path=event.dataTransfer?.getData('application/x-zorid-file');if(path)this.run(async()=>{await this.flush();await this.vault.rename(path,`${entry.path}/${path.split('/').at(-1)}`);});};}
        container.append(row);if(folder&&!this.collapsed.has(entry.path))append(entry.path,container,depth+1);
      }
    };append('',tree,0);this.sidebarContent.append(tree);
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

  private renderStatus():void{
    if(!this.activePane)return;const tab=this.current();const buffer=tab?.path?this.buffers.get(tab.path):undefined;const text=buffer?.text||'';
    this.status.replaceChildren();
    if(tab?.path&&!isMarkdown(tab.path)){this.status.append(el('span','',`${this.vault.entries.get(tab.path)?.size??0} bytes`));return;}
    this.status.append(el('span','save-state',buffer?.error?'Save failed — draft retained':buffer?.dirty?'Saving…':''));
    const mode=textButton(tab?.mode==='reading'?'Reading view':'Live Edit',()=>this.modeMenu(),'status-mode');
    this.status.append(mode,el('span','',`${text.trim()?text.trim().split(/\s+/u).length:0} words`),el('span','',`${[...text].length} characters`));
  }

  async newNote(folder=''):Promise<void>{
    let index=0,path='';do{path=`${folder?folder+'/':''}Untitled${index?' '+index:''}.md`;index++;}while(this.vault.entries.has(path));
    await this.vault.create(path,'');await this.openNote(path);const title=this.activePane.element.querySelector<HTMLInputElement>('.note-title');title?.focus();title?.select();
  }
  async newFolder(parent=''):Promise<void>{const name=await promptName('New folder','Untitled folder');if(name)await this.vault.createFolder(`${parent?parent+'/':''}${name}`);}
  private async renameDialog(path:string):Promise<void>{const name=await promptName('Rename',path.split('/').at(-1),'Rename');if(name)await this.renamePath(path,name);}
  private async renamePath(path:string,name:string):Promise<void>{
    if(/[\\/]/.test(name))throw new Error('Use the file menu to move files between folders.');const folder=parentOf(path);const suffix=this.vault.entries.get(path)?.type==='file'&&path.endsWith('.md')&&!name.endsWith('.md')?'.md':'';const next=`${folder?folder+'/':''}${name}${suffix}`;
    if(next===path)return;await this.flush();const buffer=this.buffers.get(path);if(buffer)await buffer.rename(next);else await this.vault.rename(path,next);for(const pane of this.panes)await this.renderPane(pane);
  }
  private async deletePath(path:string):Promise<void>{await this.flush();await this.vault.trash(path);this.buffers.delete(path);notice('Moved to vault trash.');}
  private newTab(pane=this.activePane):void{const tab:Tab={id:makeId(),path:null,mode:this.settings.defaultMode,kind:'note'};pane.tabs.push(tab);pane.active=tab.id;this.run(()=>this.renderPane(pane));this.saveSession();}
  private async closeTab(pane:Pane,tab:Tab):Promise<void>{if(tab.path)await this.buffers.get(tab.path)?.flush();const index=pane.tabs.indexOf(tab);if(index<0)return;pane.tabs.splice(index,1);if(!pane.tabs.length){if(this.panes.length>1){this.disposePaneViews(pane);pane.element.remove();this.panes=this.panes.filter(p=>p!==pane);this.activate(this.panes[0]);this.saveSession();return;}pane.tabs.push({id:makeId(),path:null,mode:this.settings.defaultMode,kind:'note'});}if(tab.id===pane.active)pane.active=pane.tabs[Math.min(index,pane.tabs.length-1)].id;await this.renderPane(pane);this.saveSession();this.renderRight();}
  private async navigate(delta:number,pane:Pane):Promise<void>{const index=pane.historyIndex+delta;if(index<0||index>=pane.history.length)return;pane.historyIndex=index;await this.openNote(pane.history[index],false,pane,false);}
  private async toggleReading(pane=this.activePane):Promise<void>{const tab=this.current(pane);if(tab.path&&!isMarkdown(tab.path))return;if(tab.path)await this.buffers.get(tab.path)?.flush();tab.mode=tab.mode==='reading'?this.settings.defaultMode:'reading';await this.renderPane(pane);this.saveSession();}
  private async followLink(source:string,target:string,pane:Pane,kind:'wiki'|'markdown'='wiki'):Promise<void>{const resolved=this.vault.metadata.resolveLink(source,target,kind);if(resolved){await this.openNote(resolved,false,pane);return;}const path=target.split('#')[0].replace(/\.md$/,'')+'.md';if(!path||path==='.md')return;const parent=parentOf(path);if(parent&&!this.vault.entries.has(parent))throw new Error(`Folder does not exist: ${parent}`);await this.vault.create(path,'');await this.openNote(path,false,pane);}
  private async dailyNote():Promise<void>{const now=new Date();const name=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}.md`;if(!this.vault.entries.has(name))await this.vault.create(name,'');await this.openNote(name);}
  private split():void{if(this.panes.length>=4)return;const current=this.current();const pane=this.addPane([{...current,id:makeId()}]);this.activate(pane);this.run(()=>this.renderPane(pane));this.saveSession();}
  private toggleLeft():void{this.root.classList.toggle('left-hidden');}
  private toggleRight():void{this.root.classList.toggle('right-hidden');}

  private commands():Command[]{return[
    {name:'Create new note',shortcut:'⌘ N',action:()=>this.newNote()}, {name:'Open quick switcher',shortcut:'⌘ O',action:()=>this.quickSwitcher()},
    {name:'Open command palette',shortcut:'⌘ P',action:()=>this.commandPalette()}, {name:'Open settings',shortcut:'⌘ ,',action:()=>this.showSettings()},
    {name:'Toggle reading view',shortcut:'⌘ E',action:()=>this.toggleReading()},
    {name:'Split right',action:()=>this.split()}, {name:'Toggle left sidebar',action:()=>this.toggleLeft()}, {name:'Toggle right sidebar',action:()=>this.toggleRight()},
    {name:'Search in all files',shortcut:'⌘ ⇧ F',action:()=>{this.treeTab='search';this.root.classList.remove('left-hidden');this.renderSidebar();this.sidebarContent.querySelector<HTMLInputElement>('input')?.focus();}},
    {name:"Daily notes: Open today's daily note",action:()=>this.dailyNote()}, {name:'Graph view: Open graph view',action:()=>this.openGraph()},
    {name:'Create new folder',action:()=>this.newFolder()}, {name:'Open another vault',action:()=>this.chooseVault()},
  ];}

  commandPalette():void{this.suggest('Type a command…',()=>this.commands());}
  quickSwitcher():void{this.suggest('Type a file name…',()=>[...this.vault.entries.values()].filter(entry=>entry.type==='file').map(entry=>({name:nameOf(entry.path),shortcut:parentOf(entry.path),action:()=>this.openNote(entry.path)})));}
  private suggest(placeholder:string,getCommands:()=>Command[]):void{
    const{content,close}=modal(placeholder);content.classList.add('command-modal');const input=el('input','command-input');input.placeholder=placeholder;input.setAttribute('aria-label',placeholder);input.setAttribute('role','combobox');input.setAttribute('aria-expanded','true');input.setAttribute('aria-controls','suggestion-list');
    const list=el('div','suggestion-list');list.id='suggestion-list';list.role='listbox';let selected=0,items:Command[]=[];
    const execute=()=>{const item=items[selected];if(item){close();this.run(item.action);}};
    const render=()=>{items=getCommands().filter(item=>item.name.toLocaleLowerCase().includes(input.value.toLocaleLowerCase())).slice(0,80);selected=Math.min(selected,Math.max(0,items.length-1));list.replaceChildren();items.forEach((item,index)=>{const row=el('div',`suggestion${index===selected?' is-selected':''}`);row.role='option';row.id=`suggestion-${index}`;row.setAttribute('aria-selected',String(index===selected));row.append(el('span','',item.name));if(item.shortcut)row.append(el('kbd','suggestion-shortcut',item.shortcut));row.onpointermove=()=>{selected=index;list.querySelectorAll('.suggestion').forEach((node,i)=>node.classList.toggle('is-selected',i===selected));};row.onclick=()=>{selected=index;execute();};list.append(row);});input.setAttribute('aria-activedescendant',`suggestion-${selected}`);if(!items.length)list.append(el('div','suggestion muted','No results found.'));};
    input.oninput=()=>{selected=0;render();};input.onkeydown=event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();selected=(selected+(event.key==='ArrowDown'?1:Math.max(0,items.length-1)))%Math.max(1,items.length);render();list.children[selected]?.scrollIntoView({block:'nearest'});}if(event.key==='Enter'){event.preventDefault();execute();}};
    content.append(input,list,el('div','command-footer','↑↓ to navigate  ↵ to open  esc to dismiss'));render();input.focus();
  }

  private menu(items:{name:string;action:()=>void|Promise<void>}[],x=window.innerWidth/2,y=100):void{
    this.context?.remove();const menu=el('div','context-menu');menu.role='menu';menu.style.left=`${Math.min(x,window.innerWidth-240)}px`;menu.style.top=`${Math.min(y,window.innerHeight-items.length*34-20)}px`;
    for(const item of items){const row=textButton(item.name,()=>{menu.remove();this.run(item.action);},'context-menu-item');row.role='menuitem';menu.append(row);}document.body.append(menu);this.context=menu;
    const dismiss=(event:Event)=>{if(!menu.contains(event.target as Node)){menu.remove();document.removeEventListener('pointerdown',dismiss);}};document.addEventListener('pointerdown',dismiss);
    menu.addEventListener('keydown',event=>{if(event.key==='Escape')menu.remove();});menu.querySelector('button')?.focus();
  }
  private fileMenu(entry:VaultEntry,x:number,y:number):void{const folder=entry.type==='folder';this.menu([
    ...(folder?[{name:'New note',action:()=>this.newNote(entry.path)},{name:'New folder',action:()=>this.newFolder(entry.path)}]:[{name:'Open in new tab',action:()=>this.openNote(entry.path,true)},{name:this.bookmarks.has(entry.path)?'Remove bookmark':'Bookmark',action:()=>{if(this.bookmarks.has(entry.path))this.bookmarks.delete(entry.path);else this.bookmarks.add(entry.path);this.saveSession();this.renderSidebar();}}]),
    {name:'Rename…',action:()=>this.renameDialog(entry.path)}, {name:'Move to trash',action:()=>this.deletePath(entry.path)},
  ],x,y);}
  private tabMenu(pane:Pane):void{
    this.activate(pane);const tab=this.current(pane);
    const markdown=tab.kind==='note'&&(!tab.path||isMarkdown(tab.path));
    const modes:Command[]=markdown?(['reading','live'] as const).map((mode,index)=>({
      name:['Reading view','Live Edit'][index],
      action:async()=>{tab.mode=mode;await this.renderPane(pane);this.saveSession();},
    })):[];
    this.menu([{name:'Split right',action:()=>this.split()},...modes,...(tab.path?[{name:'Rename…',action:()=>this.renameDialog(tab.path!)}]:[]),{name:'Close tab',action:()=>this.closeTab(pane,tab)}]);
  }
  private modeMenu():void{this.tabMenu(this.activePane);}

  private openGraph():void{const tab:Tab={id:makeId(),path:null,mode:'reading',kind:'graph'};this.activePane.tabs.push(tab);this.activePane.active=tab.id;this.run(()=>this.renderPane(this.activePane));this.saveSession();}
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
      nav.querySelectorAll('button').forEach(node=>node.classList.toggle('is-active',node.textContent===section));body.replaceChildren(el('h2','',section));
      const row=(name:string,description:string,control:HTMLElement)=>{const wrapper=el('div','setting-row');const info=el('div','setting-info');info.append(el('div','setting-name',name),el('div','setting-description',description));wrapper.append(info,control);body.append(wrapper);};
      const toggle=(checked:boolean,change:(value:boolean)=>void)=>{const input=el('input','toggle');input.type='checkbox';input.checked=checked;input.onchange=()=>{change(input.checked);this.saveSettings();};return input;};
      const selectControl=(name:string,value:string,choices:readonly(readonly[string,string])[],change:(value:string)=>void)=>{
        const select=el('select');select.setAttribute('aria-label',name);
        for(const[key,label]of choices){const option=el('option','',label);option.value=key;select.append(option);}
        select.value=value;select.onchange=()=>{change(select.value);this.saveSettings();};return select;
      };
      const configureLists=()=>{for(const pane of this.panes)pane.editor?.configureLists?.({useTab:this.settings.useTab,tabSize:this.settings.tabSize,smartIndentList:this.settings.smartIndentList});};
      if(section==='Appearance'){
        const select=el('select');for(const[label,value]of[['Adapt to system','system'],['Dark','dark'],['Light','light']]){const option=el('option','',label);option.value=value;select.append(option);}select.value=this.settings.theme;select.setAttribute('aria-label','Base color scheme');select.onchange=()=>{this.settings.theme=select.value as Settings['theme'];this.saveSettings();};row('Base color scheme','Choose your default color scheme.',select);
        const size=el('input');size.type='range';size.min='12';size.max='26';size.value=String(this.settings.fontSize);size.setAttribute('aria-label','Font size');size.oninput=()=>{this.settings.fontSize=Number(size.value);this.saveSettings();};row('Font size','Font size in pixels for the editor and reading view.',size);
        const title=toggle(this.settings.showInlineTitle,value=>{this.settings.showInlineTitle=value;this.panes.forEach(pane=>void this.renderPane(pane));});title.setAttribute('aria-label','Show inline title');row('Show inline title','Display the file name at the top of each note.',title);
      }else if(section==='Editor'){
        const width=toggle(this.settings.readableWidth,value=>{this.settings.readableWidth=value;this.panes.forEach(pane=>void this.renderPane(pane));});width.setAttribute('aria-label','Readable line length');row('Readable line length','Limit the maximum line length for comfortable reading.',width);
        const tabs=toggle(this.settings.useTab,value=>{this.settings.useTab=value;configureLists();});tabs.setAttribute('aria-label','Indent using tabs');row('Indent using tabs','Use tab characters for indentation. Turn off to use spaces.',tabs);
        const tabSize=el('input');tabSize.type='number';tabSize.min='1';tabSize.max='32';tabSize.value=String(this.settings.tabSize);tabSize.setAttribute('aria-label','Tab size');
        tabSize.onchange=()=>{const value=Number(tabSize.value);if(!Number.isInteger(value)||value<1||value>32){tabSize.value=String(this.settings.tabSize);return;}this.settings.tabSize=value;configureLists();this.saveSettings();};row('Tab size','Number of spaces used to display a tab.',tabSize);
        const smart=toggle(this.settings.smartIndentList,value=>{this.settings.smartIndentList=value;configureLists();});smart.setAttribute('aria-label','Smart indent lists');row('Smart indent lists','Continue list items when pressing Enter.',smart);
      }else if(section==='Hotkeys'){for(const command of this.commands())if(command.shortcut)row(command.name,'',el('kbd','',command.shortcut));}
      else if(section==='Files and links'){
        row('Vault',this.platform.label,textButton('Open another',()=>{close();this.run(()=>this.chooseVault());}));row('Deleted files','Deleted files are moved to a .trash folder in the vault.',el('span','','Vault trash'));row('Internal links','Resolved links are updated when files are renamed.',el('span','','Automatic'));
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
  private saveSession():void{if(!this.platform)return;localStorage.setItem(this.sessionKey(),JSON.stringify({...this.sessionState,panes:this.panes.map(p=>({...p.persisted,tabs:p.tabs,active:p.tabs.findIndex(t=>t.id===p.active)})),collapsed:[...this.collapsed],bookmarks:[...this.bookmarks]}));}
  private help():void{const{content}=modal('Help');content.append(el('h2','','Get started'),el('p','','Create a note with ⌘N. Link to another note with [[note name]]. Use ⌘O to find a file and ⌘P to find a command.'));
  }
  private onKey(event:KeyboardEvent):void{
    if(document.querySelector('.modal-overlay')||!this.vault)return;
    if(!(event.metaKey||event.ctrlKey))return;const key=event.key.toLowerCase();let action:(()=>unknown)|undefined;
    if(key==='n')action=()=>this.newNote();else if(key==='o')action=()=>this.quickSwitcher();else if(key==='p')action=()=>this.commandPalette();else if(key===',')action=()=>this.showSettings();else if(key==='e')action=()=>this.toggleReading();else if(key==='s')action=()=>this.flush();else if(key==='t')action=()=>this.newTab();else if(key==='w')action=()=>this.closeTab(this.activePane,this.current());else if(key==='f'&&event.shiftKey)action=()=>{this.treeTab='search';this.root.classList.remove('left-hidden');this.renderSidebar();this.sidebarContent.querySelector('input')?.focus();};
    if(action){event.preventDefault();this.run(action);}
  }
  async flush():Promise<void>{for(const buffer of this.buffers.values())await buffer.flush();}
  async destroy():Promise<void>{await this.flush();for(const buffer of this.buffers.values())await buffer.dispose();this.vaultGeneration++;this.disposers.forEach(dispose=>dispose());clearTimeout(this.reloadTimer);this.panes.forEach(pane=>this.disposePaneViews(pane));this.attachments?.destroy();document.removeEventListener('keydown',this.keyListener);window.removeEventListener('beforeunload',this.unloadListener);this.initialized=false;this.root.replaceChildren();}
}
