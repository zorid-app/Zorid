import { INSERTION_COMMANDS } from '../editor/insertion-catalogue.ts';
/** First-party shortcuts. Each command executes only in its owning scope. */
export type HotkeyPlatform = 'mac' | 'other';
export type HotkeyModifier = 'Mod' | 'Ctrl' | 'Meta' | 'Alt' | 'Shift';
export interface Hotkey { key: string; modifiers: HotkeyModifier[] }
export type HotkeyScope = 'workspace' | 'editor';
export interface HotkeyCommand { id: string; name: string; defaults: readonly Hotkey[]; scope: HotkeyScope }
/** Internal source shared by parent and nested editors; unsubscribe on view destruction. */
export interface EditorHotkeySource {
  readonly platform: HotkeyPlatform;
  effectiveBindings(id: string): Hotkey[];
  subscribe(listener: () => void): () => void;
}
export type HotkeyOverrides = Record<string, Hotkey[]>;
export const HOTKEY_STORAGE_KEY = 'zorid:hotkeys:v1';
const chord = (key: string, ...modifiers: HotkeyModifier[]): Hotkey => ({ key, modifiers });
const workspaceCommands: readonly Omit<HotkeyCommand,'scope'>[] = [
  { id:'new-window',name:'Open new window',defaults:[chord('n','Mod','Shift')] },
  { id:'new-note',name:'Create new note',defaults:[chord('n','Mod')] },
  { id:'new-tab',name:'Open new tab',defaults:[chord('t','Mod')] },
  { id:'close-tab',name:'Close current tab',defaults:[chord('w','Mod')] },
  { id:'save',name:'Save current changes',defaults:[chord('s','Mod')] },
  { id:'quick-switcher',name:'Open quick switcher',defaults:[chord('o','Mod')] },
  { id:'command-palette',name:'Open command palette',defaults:[chord('p','Mod')] },
  { id:'settings',name:'Open settings',defaults:[chord(',','Mod')] },
  { id:'toggle-reading',name:'Toggle reading view',defaults:[chord('e','Mod')] },
  { id:'search-all',name:'Search in all files',defaults:[chord('f','Mod','Shift')] },
  { id:'split-right',name:'Split right',defaults:[] }, { id:'split-down',name:'Split down',defaults:[] },
  { id:'toggle-left',name:'Toggle left sidebar',defaults:[] }, { id:'toggle-right',name:'Toggle right sidebar',defaults:[] },
  { id:'tasks',name:'Tasks: Open Tasks',defaults:[] },
  { id:'calendar',name:'Calendar: Open Calendar',defaults:[] },
  { id:'daily-note',name:"Daily notes: Open today's daily note",defaults:[] }, { id:'graph',name:'Graph view: Open graph view',defaults:[] },
  { id:'new-folder',name:'Create new folder',defaults:[] }, { id:'open-vault',name:'Open another vault',defaults:[] },
  ...Array.from({length:9},(_,index)=>({id:`tab-${index+1}`,name:index===8?'Go to last tab':`Go to tab ${index+1}`,defaults:[chord(String(index+1),'Mod')]})),
];
export const WORKSPACE_HOTKEY_COMMANDS: readonly HotkeyCommand[] = workspaceCommands.map(command=>({...command,scope:'workspace'}));
export const EDITOR_HOTKEY_COMMANDS: readonly HotkeyCommand[] = [
  ['bold','Toggle bold'], ['italic','Toggle italic'], ['strikethrough','Toggle strikethrough'],
  ['code','Toggle inline code'], ['math','Toggle inline math'], ['comment','Toggle comment'],
  ['highlight','Toggle highlight'], ['clear-formatting','Clear formatting'],
  ['toggle-fold','Toggle fold'], ['fold','Fold current'], ['unfold','Unfold current'],
  ['fold-all','Fold all'], ['unfold-all','Unfold all'],
  ['select-parent-syntax','Select parent syntax'],
].map(([id,name])=>({id:`editor-${id}`,name:`Editor: ${name}`,defaults:id==='bold'?[chord('b','Mod')]:id==='italic'?[chord('i','Mod')]:[],scope:'editor' as const})).concat(INSERTION_COMMANDS.map(command=>({id:command.id,name:`Editor: ${command.name}`,defaults:[],scope:'editor' as const})));
export const HOTKEY_COMMANDS: readonly HotkeyCommand[] = [...WORKSPACE_HOTKEY_COMMANDS,...EDITOR_HOTKEY_COMMANDS];
const ids = new Set(HOTKEY_COMMANDS.map(command=>command.id));
const modifierOrder: HotkeyModifier[] = ['Mod','Ctrl','Meta','Alt','Shift'];
const shifted: Record<string,string> = {'!':'1','@':'2','#':'3','$':'4','%':'5','^':'6','&':'7','*':'8','(':'9',')':'0','_':'-','+':'=','{':'[','}':']','|':'\\',':':';','"':"'",'<':',','>':'.','?':'/','~':'`'};
const aliases: Record<string,string> = {Esc:'Escape',Spacebar:'Space',' ':'Space',Left:'ArrowLeft',Right:'ArrowRight',Up:'ArrowUp',Down:'ArrowDown',Del:'Delete'};
export function normalizeHotkey(value: unknown): Hotkey | null {
  if (!value || typeof value!=='object') return null;
  const input=value as Hotkey;
  if(typeof input.key!=='string'||!Array.isArray(input.modifiers)||input.modifiers.some(mod=>!modifierOrder.includes(mod))||new Set(input.modifiers).size!==input.modifiers.length)return null;
  let key=aliases[input.key]??input.key;
  if(input.modifiers.includes('Shift'))key=shifted[key]??key;
  if(key.length===1)key=key.toLowerCase();
  if(!key||key.length>24||/[\x00-\x1f\x7f]/.test(key)||['Dead','Process','Unidentified','AltGraph','Control','Shift','Meta','Alt','CapsLock'].includes(key))return null;
  if(key.length>1&&!/^(?:F(?:[1-9]|1\d|2[0-4])|Arrow(?:Left|Right|Up|Down)|Home|End|PageUp|PageDown|Enter|Escape|Tab|Backspace|Delete|Insert|Space)$/.test(key))return null;
  return {key,modifiers:modifierOrder.filter(mod=>input.modifiers.includes(mod))};
}
export function eventHotkey(event: Pick<KeyboardEvent,'key'|'metaKey'|'ctrlKey'|'altKey'|'shiftKey'|'isComposing'|'repeat'> & { getModifierState?(key:string):boolean; keyCode?:number; which?:number }, platform:HotkeyPlatform):Hotkey|null {
  if(event.isComposing||event.repeat||event.getModifierState?.('AltGraph'))return null;
  const modifiers:HotkeyModifier[]=[];
  if(platform==='mac'?event.metaKey:event.ctrlKey)modifiers.push('Mod');
  if(platform==='mac'?event.ctrlKey:event.metaKey)modifiers.push(platform==='mac'?'Ctrl':'Meta');
  if(event.altKey)modifiers.push('Alt');if(event.shiftKey)modifiers.push('Shift');
  // macOS Option can turn a shortcut letter into a symbol (e.g. T → †).
  // Use its layout-aware legacy virtual letter, also used by CodeMirror's
  // modified-character fallback. event.code describes a physical US key and
  // would mislabel layouts such as AZERTY. Never reinterpret text-only Option,
  // dead/composing keys, or an ASCII logical letter supplied by the layout.
  let key=event.key;
  const virtual=event.keyCode||event.which||0;
  if(platform==='mac'&&event.metaKey&&event.altKey&&!event.ctrlKey&&
    [...key].length===1&&!/^[\x00-\x7f]$/.test(key)&&Number.isInteger(virtual)&&virtual>=65&&virtual<=90)
    key=String.fromCharCode(virtual).toLowerCase();
  return normalizeHotkey({key,modifiers});
}
export function hotkeyIdentity(binding:Hotkey,platform:HotkeyPlatform):string {
  const modifiers=new Set<string>(binding.modifiers.map(mod=>mod==='Mod'?(platform==='mac'?'Meta':'Ctrl'):mod));
  return ['Ctrl','Meta','Alt','Shift'].filter(mod=>modifiers.has(mod)).join('+')+'+'+binding.key;
}
export function formatHotkey(binding:Hotkey,platform:HotkeyPlatform):string {
  const name=binding.key.length===1?binding.key.toUpperCase():binding.key;
  const labels:Record<string,string>=platform==='mac'?{Mod:'⌘',Ctrl:'⌃',Meta:'⌘',Alt:'⌥',Shift:'⇧'}:{Mod:'Ctrl',Ctrl:'Ctrl',Meta:'Meta',Alt:'Alt',Shift:'Shift'};
  return [...new Set(binding.modifiers.map(mod=>labels[mod])),name].join(platform==='mac'?' ':'+');
}
/** These commands are intentionally not rebound at the document/workspace layer. */
export function reservedHotkey(binding:Hotkey,platform:HotkeyPlatform,scope:HotkeyScope='workspace'):string|null {
  const mods=binding.modifiers,key=binding.key,id=hotkeyIdentity(binding,platform);
  if(!mods.some(mod=>['Mod','Ctrl','Meta','Alt'].includes(mod))&&!/^F\d+$/.test(key))return 'Text entry and navigation keys are reserved for the focused control.';
  if(mods.includes('Mod')&&mods.includes(platform==='mac'?'Meta':'Ctrl'))return 'Duplicate primary modifiers are not supported.';
  if(mods.includes('Meta')&&platform!=='mac')return 'The system Meta key is reserved.';
  if(platform==='mac'&&mods.includes('Ctrl'))return 'Control shortcuts are reserved for editor navigation and suggestions on macOS.';
  if(mods.includes('Alt')&&!mods.includes('Mod'))return 'Alt shortcuts are reserved for text input and editor navigation.';
  if(/^Arrow|^(Home|End|PageUp|PageDown|Backspace|Delete|Tab|Escape|Space)$/.test(key))return 'This key is reserved for editor, window or system navigation.';
  if(key==='F2')return 'F2 is reserved for file-tree rename.';
  // Formatting owns these chords in configured Markdown editors. Once freed,
  // they may be assigned to another editor action; workspace commands cannot
  // claim them in text fields or other controls. The consumer removes CM's
  // built-in Mod-I fallback so unbinding Italic does not select syntax instead.
  if(['b','i'].some(key=>hotkeyIdentity(chord(key,'Mod'),platform)===id))
    return scope==='editor'?null:'Reserved for editor formatting commands.';
  const reserved=[
    ...['a','b','c','d','f','g','h','i','j','k','l','m','q','r','u','v','x','y','z','[',']','/','-','='].map(key=>chord(key,'Mod')),
    ...['g','z','u','k','\\','l','i','j','c','r','v','h','-','='].map(key=>chord(key,'Mod','Shift')),
    ...['\\','g','i','j','c','f','h'].map(key=>chord(key,'Mod','Alt')),
    chord('v','Mod','Alt','Shift'),chord('Enter','Mod'),chord('f','Mod','Ctrl'),chord('0','Mod'),chord('F4','Alt'),chord('F4','Mod'),
    ...['F1','F3','F5','F6','F10','F11','F12'].map(key=>chord(key)),chord('F5','Mod'),chord('F5','Shift'),chord('F3','Shift'),chord('F10','Shift'),
  ];
  return reserved.some(item=>hotkeyIdentity(item,platform)===id)?'Reserved for editor, browser or native application commands.':null;
}
export function parseHotkeyOverrides(raw:string|null):HotkeyOverrides {
  try {
    const value=JSON.parse(raw??'{}'),out:HotkeyOverrides=Object.create(null);
    if(!value||typeof value!=='object'||Array.isArray(value))return out;
    for(const [id,bindings]of Object.entries(value))if(ids.has(id)&&Array.isArray(bindings)&&bindings.length<=8){
      const normalized=bindings.map(normalizeHotkey);if(normalized.every(Boolean))out[id]=normalized as Hotkey[];
    }
    return out;
  }catch{return Object.create(null);}
}
export class HotkeyPreferences implements EditorHotkeySource {
  private listeners=new Set<()=>void>();
  private overrides:HotkeyOverrides;
  private storage:Pick<Storage,'getItem'|'setItem'>;
  readonly platform:HotkeyPlatform;
  constructor(storage:Pick<Storage,'getItem'|'setItem'>,platform:HotkeyPlatform){this.storage=storage;this.platform=platform;this.overrides=this.read();}
  private read(){try{return parseHotkeyOverrides(this.storage.getItem(HOTKEY_STORAGE_KEY));}catch{return Object.create(null) as HotkeyOverrides;}}
  reload():void{const next=this.read();if(JSON.stringify(next)===JSON.stringify(this.overrides))return;this.overrides=next;this.changed();}
  subscribe(listener:()=>void):()=>void{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  private changed():void{for(const listener of [...this.listeners]){try{listener();}catch(error){console.error('Hotkey subscriber failed',error);}}}
  effectiveBindings(id:string):Hotkey[]{const scope=HOTKEY_COMMANDS.find(command=>command.id===id)?.scope??'workspace';return this.bindings(id).filter(binding=>!reservedHotkey(binding,this.platform,scope)&&!this.conflicts(id,binding).length); }
  bindings(id:string):Hotkey[]{const defaults=HOTKEY_COMMANDS.find(command=>command.id===id)?.defaults??[];return (Object.hasOwn(this.overrides,id)?this.overrides[id]:defaults).map(binding=>({key:binding.key,modifiers:[...binding.modifiers]}));}
  customized(id:string):boolean{return Object.hasOwn(this.overrides,id);}
  label(id:string):string{return this.bindings(id).map(binding=>formatHotkey(binding,this.platform)).join(' / ');}
  conflicts(id:string,binding:Hotkey):HotkeyCommand[]{return HOTKEY_COMMANDS.filter(command=>command.id!==id&&this.bindings(command.id).some(other=>hotkeyIdentity(other,this.platform)===hotkeyIdentity(binding,this.platform)));}
  set(id:string,bindings:readonly Hotkey[]|null):void {
    if(!ids.has(id))throw new Error('Unknown command.');
    const next={...this.overrides};
    if(bindings===null)delete next[id];
    else {if(bindings.length>8)throw new Error('Use at most eight shortcuts per command.');next[id]=bindings.map(binding=>{const normalized=normalizeHotkey(binding);if(!normalized)throw new Error('Invalid shortcut.');const reserved=reservedHotkey(normalized,this.platform,HOTKEY_COMMANDS.find(command=>command.id===id)!.scope);if(reserved)throw new Error(reserved);return normalized;});}
    const candidate=bindings===null?HOTKEY_COMMANDS.find(command=>command.id===id)!.defaults:next[id];
    for(const binding of candidate){const conflicts=this.conflicts(id,binding);if(conflicts.length)throw new Error(`Already assigned to ${conflicts.map(command=>command.name).join(', ')}. Remove that binding first.`);}
    if(new Set(candidate.map(binding=>hotkeyIdentity(binding,this.platform))).size!==candidate.length)throw new Error('This shortcut is already assigned to this command.');
    this.storage.setItem(HOTKEY_STORAGE_KEY,JSON.stringify(next));this.overrides=next;this.changed();
  }
  resolve(event:KeyboardEvent,scope:HotkeyScope='workspace'):string|null {
    if(event.defaultPrevented)return null;
    const binding=eventHotkey(event,this.platform);if(!binding)return null;
    // Corrupt/foreign-platform preferences never override editor/system behavior.
    if(reservedHotkey(binding,this.platform,scope))return null;
    const matches=HOTKEY_COMMANDS.filter(command=>this.bindings(command.id).some(other=>hotkeyIdentity(other,this.platform)===hotkeyIdentity(binding,this.platform)));
    return matches.length===1&&matches[0].scope===scope?matches[0].id:null;
  }
}
