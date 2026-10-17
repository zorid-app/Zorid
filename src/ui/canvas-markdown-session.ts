import type { EditorOptions } from './editor.ts';
import type { NoteBuffer } from './note-buffer.ts';

/** Internal structural adapter for CanvasMarkdownSession. It owns subscriptions
 * and renderer resources; the workspace owns the shared buffer and its draft. */
export interface CanvasMarkdownBufferSession {
  getText():string;
  update(next:string,expected:string):void;
  subscribe(listener:(text:string)=>void):()=>void;
  flush():Promise<void>;
  hasPendingChanges():boolean;
  readonly editorOptions?:Omit<EditorOptions,'value'|'mode'|'onChange'>;
  destroy():void;
}
export interface CanvasMarkdownBufferOptions {
  buffer:NoteBuffer;
  /** Stable vault/file/buffer identity. This guard outlives the card session and
   * is retained by accepted dirty writes, including autosave and later retries. */
  validateWrite():void;
  /** Current card/view lifetime; never retained on the shared dirty buffer. */
  validateSession?():void;
  update(next:string,validateWrite:()=>void):void;
  subscribe(listener:(refresh?:boolean)=>void):()=>void;
  editorOptions?:Omit<EditorOptions,'value'|'mode'|'onChange'>;
  dispose?():void;
  onError?:(error:unknown)=>void;
}

export function createCanvasMarkdownBufferSession(options:CanvasMarkdownBufferOptions):CanvasMarkdownBufferSession {
  const {buffer}=options,listeners=new Set<(text:string)=>void>();
  let destroyed=false,updating=false,lastText=buffer.text;
  const current=()=>{
    if(destroyed)throw new Error('The Canvas file card is closed.');
    options.validateSession?.();options.validateWrite();
  };
  current();
  const unsubscribe=options.subscribe(refresh=>{
    if(destroyed||!refresh&&lastText===buffer.text)return;
    try{options.validateWrite();options.validateSession?.();}catch{return;}
    lastText=buffer.text;
    // NoteBuffer publishes synchronously. The originating CodeMirror update
    // already owns this snapshot and must not dispatch into itself recursively.
    if(updating)return;
    for(const listener of [...listeners])try{listener(lastText);}catch(error){options.onError?.(error);}
  });
  return {
    getText(){current();return buffer.text;},
    update(next,expected){
      current();
      if(buffer.text!==expected)throw new Error('The note changed in another editor. Your Canvas draft is retained.');
      updating=true;
      try{options.update(next,options.validateWrite);lastText=buffer.text;}finally{updating=false;}
    },
    subscribe(listener){current();listeners.add(listener);return()=>listeners.delete(listener);},
    async flush(){
      try{current();}catch(error){
        // A removed/renamed clean note has nothing to save. Its stale card must
        // remain closable; unaccepted local drafts are guarded by the card UI.
        if(!destroyed&&!buffer.dirty)return;
        throw error;
      }
      // A peer editor may own the latest dirty snapshot. Retain this file
      // identity guard through the buffer's actual queued write as well.
      if(buffer.dirty)buffer.update(buffer.text,{validateWrite:options.validateWrite});
      await buffer.flush();
    },
    hasPendingChanges(){return buffer.dirty;},
    get editorOptions(){return options.editorOptions;},
    destroy(){if(destroyed)return;destroyed=true;unsubscribe();listeners.clear();options.dispose?.();},
  };
}

/** Buffer notifications include local edits, external reloads and saved/recovery
 * state. Sessions filter identical text, so save acknowledgements cannot reset a
 * card editor or its history. Entries disappear with the final subscription. */
export class NoteBufferSubscriptions {
  private listeners=new Map<NoteBuffer,Set<(refresh?:boolean)=>void>>();
  subscribe(buffer:NoteBuffer,listener:(refresh?:boolean)=>void):()=>void {
    let group=this.listeners.get(buffer);if(!group){group=new Set();this.listeners.set(buffer,group);}
    group.add(listener);
    return()=>{group.delete(listener);if(!group.size&&this.listeners.get(buffer)===group)this.listeners.delete(buffer);};
  }
  publish(buffer:NoteBuffer,refresh=false):void {for(const listener of [...this.listeners.get(buffer)??[]])listener(refresh);}
}
