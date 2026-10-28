import {Prec} from '@codemirror/state';
import type {EditorState, Extension} from '@codemirror/state';
import {EditorView, ViewPlugin, keymap} from '@codemirror/view';
import type {ViewUpdate} from '@codemirror/view';
import {isolateHistory} from '@codemirror/commands';
import {canInsert} from './insertion-commands.ts';

export type DatabaseSlashLayout = 'table' | 'list' | 'kanban' | 'cards';
export interface DatabaseSlashPageRequest {
  layout: DatabaseSlashLayout;
  mode: 'page';
  view: EditorView;
  from: number;
  to: number;
  /** Exact editor document/selection and authoring lease captured at acceptance. */
  isCurrent(): boolean;
}
export interface DatabaseSlashInlineRequest {
  layout: 'table';
  view: EditorView;
  /** Inserted fence range, including its final newline. */
  from: number;
  to: number;
  isCurrent(): boolean;
}
interface SlashContext {from: number; to: number; query: string}
let menuSerial=0;
export interface DatabaseSlashOptions {
  inline: boolean;
  captureAuthoring(): (() => boolean) | null;
  isCurrent(): boolean;
  onCreateDatabase?: (request: DatabaseSlashPageRequest) => void | Promise<void>;
  onInlineDatabaseInserted?: (request: DatabaseSlashInlineRequest) => void | Promise<void>;
  onError?: (error: unknown) => void;
}

/** Only a standalone prose line is a creation command. Literal code stays text. */
export function databaseSlashContext(state: EditorState): SlashContext | null {
  if (state.readOnly || state.selection.ranges.length !== 1 || !state.selection.main.empty) return null;
  const head=state.selection.main.head,line=state.doc.lineAt(head);
  const match=/^ {0,3}\/([a-z ]*)$/i.exec(state.sliceDoc(line.from,head));
  if(!match || !/^\s*$/.test(state.sliceDoc(head,line.to)) || !canInsert(state,'editor-insert-code-block'))return null;
  return {from:line.from,to:line.to,query:match[1].trim().toLowerCase()};
}

/** A small creation menu; the existing Base source chooser owns database setup. */
export function databaseSlash(options: DatabaseSlashOptions): Extension {
  type Choice = {mode:'inline'|'page';label:string;detail:string};
  const plugin=ViewPlugin.fromClass(class {
    view:EditorView;menu:HTMLElement|undefined;context:SlashContext|null=null;choices:Choice[]=[];selected=0;pending=false;destroyed=false;
    dismissed:EditorState['doc']|undefined;
    readonly id=`database-slash-${++menuSerial}`;
    constructor(view:EditorView){this.view=view;this.refresh();}
    update(update:ViewUpdate){if(update.transactions.length||update.focusChanged||update.viewportChanged)this.refresh();}
    report=(error:unknown)=>{try{options.onError?.(error);}catch{/* Reporting cannot change a retained command. */}};
    current=()=>{try{return !this.destroyed&&this.view.dom.isConnected&&options.isCurrent();}catch{return false;}};
    hide(){this.menu?.remove();this.menu=undefined;if(this.view.contentDOM.getAttribute('aria-activedescendant')?.startsWith(`${this.id}-`))this.view.contentDOM.removeAttribute('aria-activedescendant');}
    refresh(){
      const context=this.current()&&this.view.hasFocus&&!this.view.compositionStarted&&!this.pending&&this.view.state.doc!==this.dismissed&&options.captureAuthoring()?databaseSlashContext(this.view.state):null;
      if(!context){this.context=null;this.hide();return;}
      const choices:Choice[]=[...(options.inline?[{mode:'inline' as const,label:'Database',detail:'Inline'}]:[]),...(options.onCreateDatabase?[{mode:'page' as const,label:'Database',detail:'Full page'}]:[])]
        .filter(choice=>`${choice.label} ${choice.detail}`.toLowerCase().includes(context.query));
      if(!choices.length){this.context=null;this.hide();return;}
      const changed=!this.context||context.from!==this.context.from||context.query!==this.context.query;
      this.context=context;this.choices=choices;if(changed)this.selected=0;
      this.selected=Math.min(this.selected,choices.length-1);
      if(!this.menu){this.menu=this.view.dom.ownerDocument.createElement('div');this.menu.className='cm-database-slash-menu';this.menu.contentEditable='false';this.menu.setAttribute('role','listbox');this.menu.setAttribute('aria-label','Insert database');this.view.dom.append(this.menu);}
      const menu=this.menu;menu.replaceChildren();
      choices.forEach((choice,index)=>{
        const row=menu.ownerDocument.createElement('div');row.className='cm-database-slash-option';row.id=`${this.id}-${index}`;row.setAttribute('role','option');row.setAttribute('aria-label',`${choice.label} ${choice.detail}`);
        const glyph=menu.ownerDocument.createElement('span');glyph.className='cm-database-slash-icon';glyph.textContent='▦';glyph.setAttribute('aria-hidden','true');
        const label=menu.ownerDocument.createElement('span');label.textContent=choice.label;const detail=menu.ownerDocument.createElement('small');detail.textContent=choice.detail;row.append(glyph,label,detail);
        row.addEventListener('pointerdown',event=>{event.preventDefault();event.stopPropagation();});
        row.addEventListener('mousedown',event=>{event.preventDefault();event.stopPropagation();});
        row.addEventListener('pointermove',()=>{if(!row.isConnected||this.menu!==menu)return;this.selected=index;this.paint();});
        row.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();if(row.isConnected&&this.menu===menu&&this.context===context)this.choose(index);});menu.append(row);
      });
      this.paint();this.view.requestMeasure({read:view=>{try{return view.coordsAtPos(context.from);}catch{return null;}},write:rect=>{
        if(!rect||this.menu!==menu||!this.current())return;const win=menu.ownerDocument.defaultView;
        menu.style.left=`${Math.max(8,Math.min(rect.left,(win?.innerWidth??800)-296))}px`;
        menu.style.top=`${Math.max(8,Math.min(rect.bottom+6,(win?.innerHeight??600)-menu.offsetHeight-8))}px`;
      }});
    }
    paint(){for(const [index,row]of [...this.menu?.children??[]].entries())row.setAttribute('aria-selected',String(index===this.selected));this.view.contentDOM.setAttribute('aria-activedescendant',`${this.id}-${this.selected}`);}
    key(key:string):boolean{
      if(!this.menu||!this.context||this.view.compositionStarted||!this.current())return false;
      if(key==='Escape'){this.dismissed=this.view.state.doc;this.hide();return true;}
      if(key==='ArrowDown'||key==='ArrowUp'){this.selected=(this.selected+(key==='ArrowDown'?1:-1)+this.choices.length)%this.choices.length;this.paint();return true;}
      if(key==='Enter'){this.choose(this.selected);return true;}
      return false;
    }
    choose(index:number){
      const choice=this.choices[index],context=this.context,view=this.view,snapshot=view.state,lease=options.captureAuthoring();
      if(!choice||!context||this.pending||!lease||!view.hasFocus||view.compositionStarted||!this.current()||!databaseSlashContext(snapshot))return;
      const isCurrent=()=>this.current()&&lease()&&!view.state.readOnly&&!view.compositionStarted&&view.state.doc===snapshot.doc&&view.state.selection.eq(snapshot.selection);
      if(!isCurrent())return;
      this.dismissed=snapshot.doc;this.hide();
      if(choice.mode==='inline'){
        const insert='```base\nviews: []\n```\n';
        try{view.dispatch({changes:{from:context.from,to:context.to,insert},selection:{anchor:context.from+insert.length},annotations:isolateHistory.of('full'),userEvent:'input.insert'});}catch(error){this.report(error);return;}
        if(view.state.doc===snapshot.doc)return;
        const inserted=view.state;
        try{void Promise.resolve(options.onInlineDatabaseInserted?.({layout:'table',view,from:context.from,to:context.from+insert.length,isCurrent:()=>this.current()&&lease()&&view.state.doc===inserted.doc&&view.state.selection.eq(inserted.selection)})).catch(this.report);}catch(error){this.report(error);}
      }else if(options.onCreateDatabase){
        this.pending=true;
        try{void Promise.resolve(options.onCreateDatabase({layout:'table',mode:'page',view,from:context.from,to:context.to,isCurrent})).catch(this.report).finally(()=>{this.pending=false;});}
        catch(error){this.pending=false;this.report(error);}
      }
    }
    destroy(){this.destroyed=true;this.hide();}
  });
  return [plugin,Prec.highest(keymap.of(['ArrowDown','ArrowUp','Enter','Escape'].map(key=>({key,run:view=>view.plugin(plugin)?.key(key)??false})))),EditorView.baseTheme({
    '.cm-database-slash-menu':{position:'fixed',zIndex:'1600',boxSizing:'border-box',width:'288px',maxWidth:'calc(100vw - 16px)',padding:'5px',border:'1px solid var(--background-modifier-border)',borderRadius:'9px',background:'var(--background-primary)',color:'var(--text-normal)',boxShadow:'0 6px 24px #0003',font:'13px var(--font-interface, sans-serif)'},
    '.cm-database-slash-option':{display:'flex',alignItems:'center',gap:'9px',padding:'8px',borderRadius:'5px',cursor:'pointer'},
    '.cm-database-slash-option[aria-selected=true]':{background:'var(--background-modifier-hover)'},
    '.cm-database-slash-icon':{fontSize:'20px',color:'var(--text-muted)'},
    '.cm-database-slash-option small':{marginLeft:'auto',color:'var(--text-muted)',fontSize:'12px'},
  })];
}
