import {Prec} from '@codemirror/state';
import type {EditorState, Extension} from '@codemirror/state';
import {EditorView, ViewPlugin, keymap} from '@codemirror/view';
import type {ViewUpdate} from '@codemirror/view';
import {isolateHistory} from '@codemirror/commands';
import {canInsert} from './insertion-commands.ts';
import {slashCommands,filterSlashCommands,slashInsertionTransaction} from './slash-commands.ts';
import type {SlashCommand} from './slash-commands.ts';
import {icon} from '../ui/icons.ts';
import {ensureSyntaxTree} from '@codemirror/language';

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
function commandIcon(command:SlashCommand,doc:Document):SVGSVGElement{
  const names:Record<string,string>={text:'text',todo:'square-check',bullet:'list','editor-insert-callout':'info','editor-insert-table':'table','editor-insert-rule':'minus','editor-insert-link':'link','editor-insert-code-block':'code','database-inline':'table','database-page':'table'};
  const name=names[command.id];if(name)return icon(name,16,doc);
  const svg=icon('file',16,doc);svg.replaceChildren();
  if(command.id==='editor-insert-image'){
    for(const[tag,attributes]of[['rect',{x:'3',y:'3',width:'18',height:'18',rx:'2'}],['circle',{cx:'8',cy:'8',r:'1.5'}],['polyline',{points:'3,17 10,10 14,14 17,11 21,15'}]]as const){const node=doc.createElementNS(svg.namespaceURI,tag);for(const[key,value]of Object.entries(attributes))node.setAttribute(key,value);svg.append(node);}
  }else{const text=doc.createElementNS(svg.namespaceURI,'text');text.setAttribute('x','12');text.setAttribute('y','18');text.setAttribute('text-anchor','middle');text.setAttribute('stroke','none');text.setAttribute('fill','currentColor');text.setAttribute('font-size','18');text.setAttribute('font-family','Arial, sans-serif');text.textContent=command.glyph;svg.append(text);}
  return svg;
}
export interface DatabaseSlashOptions {
  inline: boolean;
  captureAuthoring(): (() => boolean) | null;
  isCurrent(): boolean;
  onCreateDatabase?: (request: DatabaseSlashPageRequest) => void | Promise<void>;
  onInlineDatabaseInserted?: (request: DatabaseSlashInlineRequest) => void | Promise<void>;
  onError?: (error: unknown) => void;
}

/** An otherwise-empty top-level block may change its type. Parser-confirmed
 * markers are consumed with the query, so a heading never becomes "## # ".
 * Nested containers need a separate container-aware insertion contract; reject
 * them here rather than flattening their hierarchy or escaping their fences. */
export function databaseSlashContext(state: EditorState): SlashContext | null {
  if (state.readOnly || state.selection.ranges.length !== 1 || !state.selection.main.empty) return null;
  const head=state.selection.main.head,line=state.doc.lineAt(head);
  const before=state.sliceDoc(line.from,head),match=/^( {0,3})(?:(#{1,6})[ \t]+|([-+*]|\d{1,9}[.)])[ \t]+(?:\[([ xX])\][ \t]+)?|(>)[ \t]*)?\/([\p{L}\p{N} _-]*)$/u.exec(before);
  if(!match || !/^\s*$/.test(state.sliceDoc(head,line.to)) || !canInsert(state,'editor-insert-code-block'))return null;
  const tree=ensureSyntaxTree(state,head,20);if(!tree)return null;
  const slash=line.from+before.lastIndexOf('/'),markFrom=line.from+match[1].length;
  let lists=0,quotes=0,heading=false;
  for(let node=tree.resolveInner(slash,1);node;node=node.parent!){
    if(node.name==='ListItem'||node.name==='Blockquote'){
      // An empty first line can still own following children or lazy content.
      // Changing only that line would detach their hierarchy from its marker.
      if(node.to>line.to)return null;
      if(node.name==='ListItem')lists++;else quotes++;
    }
    if(/Heading[1-6]$/.test(node.name))heading=true;
  }
  if(match[3]?lists!==1||quotes!==0:match[5]?quotes!==1||lists!==0:lists!==0||quotes!==0)return null;
  const required=match[2]?'HeaderMark':match[3]?'ListMark':match[5]?'QuoteMark':undefined;
  if(!required&&heading)return null;
  if(required){
    let marker=false,task=match[4]===undefined;
    tree.iterate({from:markFrom,to:slash,enter(node){if(node.name===required&&node.from===markFrom&&state.sliceDoc(node.from,node.to)===(match[2]??match[3]??match[5]))marker=true;if(node.name==='TaskMarker'&&state.sliceDoc(node.from,node.to)===`[${match[4]}]`)task=true;}});
    if(!marker||!task)return null;
  }
  return {from:line.from,to:line.to,query:match[6].trim().toLowerCase()};
}

/** The editor owns slash authoring; the Base source chooser owns database setup. */
export function databaseSlash(options: DatabaseSlashOptions): Extension {
  const plugin=ViewPlugin.fromClass(class {
    view:EditorView;menu:HTMLElement|undefined;context:SlashContext|null=null;choices:readonly SlashCommand[]=[];rows:HTMLElement[]=[];selected=0;pending=false;destroyed=false;observing=false;
    dismissed:EditorState['doc']|undefined;
    readonly id=`database-slash-${++menuSerial}`;
    constructor(view:EditorView){this.view=view;this.refresh();}
    update(update:ViewUpdate){if(update.transactions.length||update.focusChanged||update.viewportChanged)this.refresh();}
    report=(error:unknown)=>{try{options.onError?.(error);}catch{/* Reporting cannot change a retained command. */}};
    current=()=>{try{return !this.destroyed&&this.view.dom.isConnected&&options.isCurrent();}catch{return false;}};
    outside=(event:PointerEvent)=>{const target=event.target as Node|null;if(!this.menu||!target||this.menu.contains(target)||this.view.contentDOM.contains(target))return;this.dismissed=this.view.state.doc;this.context=null;this.hide();};
    observe(){if(this.observing)return;this.observing=true;const doc=this.view.dom.ownerDocument;doc.addEventListener('pointerdown',this.outside,true);doc.addEventListener('scroll',this.place,true);doc.defaultView?.addEventListener('resize',this.place);}
    place=()=>{const context=this.context,menu=this.menu;if(!context||!menu)return;this.view.requestMeasure({key:this,read:view=>{try{return view.coordsAtPos(context.from);}catch{return null;}},write:rect=>{
      if(this.menu!==menu||this.context!==context||!this.current())return;
      const win=menu.ownerDocument.defaultView,width=menu.offsetWidth||324,height=menu.offsetHeight||380,viewportWidth=win?.innerWidth??800,viewportHeight=win?.innerHeight??600;
      if(!rect||rect.bottom<0||rect.top>viewportHeight||rect.right<0||rect.left>viewportWidth){this.dismissed=this.view.state.doc;this.context=null;this.hide();return;}
      const above=viewportHeight-rect.bottom-8<height&&rect.top>viewportHeight-rect.bottom;
      menu.dataset.placement=above?'above':'below';menu.style.left=`${Math.max(8,Math.min(rect.left,viewportWidth-width-8))}px`;
      menu.style.top=`${Math.max(8,above?rect.top-height-6:Math.min(rect.bottom+6,viewportHeight-height-8))}px`;
    }});};
    hide(){if(this.observing){this.observing=false;const doc=this.view.dom.ownerDocument;doc.removeEventListener('pointerdown',this.outside,true);doc.removeEventListener('scroll',this.place,true);doc.defaultView?.removeEventListener('resize',this.place);}this.menu?.remove();this.menu=undefined;this.rows=[];if(this.view.contentDOM.getAttribute('aria-activedescendant')?.startsWith(`${this.id}-`))this.view.contentDOM.removeAttribute('aria-activedescendant');const controls=this.view.contentDOM.getAttribute('aria-controls')?.split(/\s+/).filter(id=>id!==`${this.id}-list`);if(controls?.length)this.view.contentDOM.setAttribute('aria-controls',controls.join(' '));else this.view.contentDOM.removeAttribute('aria-controls');}

    refresh(){
      const context=this.current()&&this.view.hasFocus&&!this.view.compositionStarted&&!this.pending&&this.view.state.doc!==this.dismissed&&options.captureAuthoring()?databaseSlashContext(this.view.state):null;
      if(!context){this.context=null;this.hide();return;}
      const choices=filterSlashCommands(slashCommands({inline:options.inline,page:!!options.onCreateDatabase}),context.query)
        .filter(choice=>choice.kind!=='insert'||choice.command!=='editor-insert-footnote'||canInsert(this.view.state,choice.command));
      const changed=!this.context||context.from!==this.context.from||context.query!==this.context.query;
      this.context=context;this.choices=choices;if(changed)this.selected=0;
      this.selected=Math.max(0,Math.min(this.selected,choices.length-1));
      if(!this.menu){this.menu=this.view.dom.ownerDocument.createElement('div');this.menu.className='cm-database-slash-menu';this.menu.contentEditable='false';this.menu.setAttribute('role','dialog');this.menu.setAttribute('aria-label','Insert block');this.view.dom.append(this.menu);this.observe();}
      const menu=this.menu;menu.replaceChildren();this.rows=[];
      const list=menu.ownerDocument.createElement('div');list.className='cm-slash-command-list';list.id=`${this.id}-list`;list.setAttribute('role','listbox');list.setAttribute('aria-label','Commands');menu.append(list);
      const controls=new Set(this.view.contentDOM.getAttribute('aria-controls')?.split(/\s+/).filter(Boolean)??[]);controls.add(list.id);this.view.contentDOM.setAttribute('aria-controls',[...controls].join(' '));
      let group:HTMLElement|undefined,groupName='';
      choices.forEach((choice,index)=>{
        const nextGroup=context.query?'Filtered results':choice.group;
        if(nextGroup!==groupName){groupName=nextGroup;group=menu.ownerDocument.createElement('div');group.className='cm-slash-command-group';group.setAttribute('role','group');group.setAttribute('aria-label',groupName);const heading=menu.ownerDocument.createElement('div');heading.className='cm-slash-command-heading';heading.textContent=groupName;heading.setAttribute('aria-hidden','true');group.append(heading);list.append(group);}
        const row=menu.ownerDocument.createElement('div');row.className='cm-database-slash-option';row.id=`${this.id}-${index}`;row.dataset.command=choice.id;row.setAttribute('role','option');row.setAttribute('aria-label',choice.kind==='database'?`Database ${choice.mode==='inline'?'Inline':'Full page'}`:choice.label);
        const glyph=menu.ownerDocument.createElement('span');glyph.className='cm-database-slash-icon';glyph.append(commandIcon(choice,menu.ownerDocument));glyph.setAttribute('aria-hidden','true');
        const text=menu.ownerDocument.createElement('span');text.className='cm-slash-command-text';const label=menu.ownerDocument.createElement('span');label.className='cm-slash-command-title';label.textContent=choice.label;const detail=menu.ownerDocument.createElement('small');detail.textContent=choice.description;detail.hidden=true;detail.className='cm-slash-command-description';detail.id=`row-description-${this.id}-${index}`;row.setAttribute('aria-describedby',detail.id);text.append(label,detail);row.append(glyph,text);if(choice.hint){const hint=menu.ownerDocument.createElement('span');hint.className='cm-slash-command-hint';hint.textContent=choice.hint;hint.setAttribute('aria-hidden','true');row.append(hint);}
        row.addEventListener('pointerdown',event=>{event.preventDefault();event.stopPropagation();});row.addEventListener('mousedown',event=>{event.preventDefault();event.stopPropagation();});
        row.addEventListener('pointermove',()=>{if(!row.isConnected||this.menu!==menu||this.selected===index)return;this.selected=index;this.paint();});
        row.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();if(row.isConnected&&this.menu===menu&&this.context===context)this.choose(index);});group!.append(row);this.rows.push(row);
      });
      if(!choices.length){const empty=menu.ownerDocument.createElement('div');empty.className='cm-slash-command-empty';empty.textContent='No results';empty.setAttribute('role','status');list.append(empty);}
      const footer=menu.ownerDocument.createElement('div');footer.className='cm-slash-command-footer';const close=menu.ownerDocument.createElement('button');close.type='button';close.textContent='Close menu';close.addEventListener('mousedown',event=>event.preventDefault());close.addEventListener('click',()=>{this.dismissed=this.view.state.doc;this.context=null;this.hide();if(this.current())this.view.focus();});const escape=menu.ownerDocument.createElement('kbd');escape.textContent='esc';footer.append(close,escape);menu.append(footer);
      this.paint();this.place();
    }
    paint(scroll=false){this.rows.forEach((row,index)=>row.setAttribute('aria-selected',String(index===this.selected)));const row=this.rows[this.selected];if(row){this.view.contentDOM.setAttribute('aria-activedescendant',row.id);if(scroll)row.scrollIntoView?.({block:'nearest'});}else this.view.contentDOM.removeAttribute('aria-activedescendant');}
    key(key:string):boolean{
      if(!this.menu||!this.context||this.view.compositionStarted||!this.current())return false;
      if(key==='Escape'){this.dismissed=this.view.state.doc;this.hide();return true;}
      if(key==='Tab'){this.dismissed=this.view.state.doc;this.context=null;this.hide();return false;}
      if(key==='ArrowDown'||key==='ArrowUp'||key==='Home'||key==='End'){if(this.choices.length){this.selected=key==='Home'?0:key==='End'?this.choices.length-1:(this.selected+(key==='ArrowDown'?1:-1)+this.choices.length)%this.choices.length;this.paint(true);}return true;}
      if(key==='Enter'&&this.choices.length){this.choose(this.selected);return true;}
      return false;
    }
    choose(index:number){
      const choice=this.choices[index],context=this.context,view=this.view,snapshot=view.state,lease=options.captureAuthoring();
      if(!choice||!context||this.pending||!lease||!view.hasFocus||view.compositionStarted||!this.current()||!databaseSlashContext(snapshot))return;
      const isCurrent=()=>this.current()&&lease()&&!view.state.readOnly&&!view.compositionStarted&&view.state.doc===snapshot.doc&&view.state.selection.eq(snapshot.selection);
      if(!isCurrent())return;
      this.dismissed=snapshot.doc;this.hide();
      if(choice.kind!=='database'){
        try{const transaction=slashInsertionTransaction(snapshot,context.from,context.to,choice);if(transaction&&isCurrent()){view.dispatch(transaction);view.focus();}}catch(error){this.report(error);}
      }else if(choice.mode==='inline'){
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
  return [plugin,
    // The generic keymap dispatcher runs at default DOM-handler precedence.
    // An earlier autocomplete's highest Escape binding can consume a pending
    // invisible result before the visible slash menu. Claim only its plain
    // Escape at the supported DOM boundary; all other key ordering is retained.
    Prec.highest(EditorView.domEventHandlers({keydown(event,view){
      if(event.key!=='Escape'||event.defaultPrevented||event.isComposing||view.composing||view.compositionStarted||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey||event.getModifierState('AltGraph')||(event.target as Element|null)?.closest('.cm-editor')!==view.dom)return false;
      const handled=view.plugin(plugin)?.key('Escape')??false;if(handled)event.stopPropagation();return handled;
    }})),
    Prec.highest(keymap.of(['ArrowDown','ArrowUp','Home','End','Enter','Tab'].map(key=>({key,run:view=>view.plugin(plugin)?.key(key)??false})))),EditorView.baseTheme({
    '.cm-database-slash-menu':{position:'fixed',visibility:'hidden',opacity:'0',transform:'translate(0)',transition:'opacity 1ms ease, transform 1ms ease',zIndex:'1600',boxSizing:'border-box',width:'324px',maxWidth:'calc(100vw - 16px)',padding:'4px 0 0',border:'0',borderRadius:'10px',overflow:'hidden',background:'var(--background-primary)',color:'var(--text-normal)',boxShadow:'0 20px 24px rgba(25,25,25,.05), 0 5px 8px rgba(25,25,25,.027), 0 0 0 1px rgba(42,28,0,.07)',font:'14px var(--font-interface, sans-serif)'},
    '.cm-database-slash-menu[data-placement]':{visibility:'visible',opacity:'1',transform:'translate(0)'},
    '.cm-slash-command-list':{maxHeight:'min(360px, calc(100vh - 72px))',overflowY:'auto',overscrollBehavior:'contain',padding:'0 4px'},
    '.cm-slash-command-heading':{padding:'8px 8px 4px',fontSize:'12px',fontWeight:'500',lineHeight:'16px',color:'var(--text-muted)'},
    '.cm-database-slash-option':{display:'flex',alignItems:'center',gap:'8px',height:'32px',boxSizing:'border-box',padding:'0 8px',borderRadius:'6px',cursor:'pointer',transition:'background 20ms ease-in'},
    '.cm-database-slash-option[aria-selected=true]':{background:'color-mix(in srgb, var(--text-normal) 5.1%, transparent)'},
    '.cm-database-slash-icon':{display:'flex',alignItems:'center',justifyContent:'center',width:'20px',height:'20px',flex:'0 0 20px',fontSize:'16px',lineHeight:'20px',color:'var(--text-normal)'},
    '.cm-slash-command-text':{display:'flex',minWidth:'0'},
    '.cm-slash-command-title':{fontWeight:'400',lineHeight:'16.8px'},
    '.cm-slash-command-description':{display:'none'},
    '.cm-slash-command-hint':{marginLeft:'auto',paddingLeft:'12px',color:'var(--text-faint)',fontSize:'13px',lineHeight:'20px'},
    '.cm-slash-command-footer':{display:'flex',alignItems:'center',justifyContent:'space-between',height:'42px',boxSizing:'border-box',padding:'0 12px',borderTop:'1px solid var(--background-modifier-border)',marginTop:'4px',color:'var(--text-normal)',fontSize:'14px',lineHeight:'16.8px'},
    '.cm-slash-command-footer button':{border:'0',padding:'0',boxShadow:'none',background:'transparent',font:'inherit',color:'inherit',cursor:'pointer'},
    '.cm-slash-command-footer kbd':{padding:'0',border:'0',borderRadius:'0',background:'transparent',boxShadow:'none',color:'var(--text-faint)',font:'12px var(--font-interface, sans-serif)',lineHeight:'16.8px'},
    '.cm-slash-command-empty':{padding:'16px 8px',color:'var(--text-muted)',fontSize:'13px'},
    '@media (prefers-reduced-motion: reduce)':{'.cm-database-slash-menu':{transition:'none'},'.cm-database-slash-option':{transition:'none'}},
  })];
}
