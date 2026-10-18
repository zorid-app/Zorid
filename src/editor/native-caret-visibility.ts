import {EditorView, ViewPlugin, type ViewUpdate} from '@codemirror/view';

/** Native keyboard/layout changes can settle after WebKit's selection reveal.
 * Add an explicit CM scroll target without changing selection, focus or insets.
 */
export function nativeCaretVisibility(isCurrent?:()=>boolean) {
  return ViewPlugin.fromClass(class {
    private dead=false;
    private epoch=0;
    private frame:number|undefined;
    private manual=false;
    private composing=false;
    private pointer:{id:number;x:number;y:number;moved:boolean;wanted:boolean}|undefined;
    private document:Document;
    private win:Window;
    private viewport:VisualViewport|null;
    private view:EditorView;
    constructor(view:EditorView){
      this.view=view;
      this.document=view.dom.ownerDocument;this.win=this.document.defaultView!;this.viewport=this.win.visualViewport;
      this.document.addEventListener('focusin',this.focus,true);
      this.document.addEventListener('pointerdown',this.down,true);
      this.document.addEventListener('pointermove',this.move,true);
      this.document.addEventListener('pointerup',this.up,true);
      this.document.addEventListener('pointercancel',this.cancelGesture,true);
      this.document.addEventListener('dragstart',this.cancelGesture,true);
      this.document.addEventListener('wheel',this.cancelGesture,{capture:true,passive:true});
      this.document.addEventListener('touchmove',this.touchMove,{capture:true,passive:true});
      this.document.addEventListener('touchcancel',this.cancelGesture,true);
      this.document.addEventListener('keydown',this.key,true);
      this.document.addEventListener('scroll',this.cancelPending,true);
      view.dom.addEventListener('compositionstart',this.compositionStart,true);
      view.dom.addEventListener('compositionend',this.compositionEnd,true);
      this.win.addEventListener('blur',this.cancelGesture);
      this.win.addEventListener('resize',this.resize);
      this.viewport?.addEventListener('resize',this.resize);
    }
    private current=()=>{
      try{return !this.dead&&(isCurrent?.()??true)&&this.view.dom.isConnected
        &&this.document.visibilityState!=='hidden'&&this.document.activeElement===this.view.contentDOM
        &&!this.view.dom.closest('[inert]')&&!this.view.state.readOnly&&this.view.state.facet(EditorView.editable)
        &&!this.composing&&!this.view.composing&&!this.view.compositionStarted
        &&this.view.state.selection.ranges.length===1&&this.view.state.selection.main.empty
        &&!this.document.querySelector('.modal-overlay,[aria-modal="true"],[role="menu"]')
        &&!this.view.dom.querySelector('.cm-tooltip-autocomplete,.cm-search');}catch{return false;}
    };
    private cancel=()=>{this.epoch++;if(this.frame!==undefined)this.win.cancelAnimationFrame(this.frame);this.frame=undefined;};
    private cancelGesture=()=>{this.manual=true;if(this.pointer){this.pointer.moved=true;this.pointer.wanted=false;}this.cancel();};
    private cancelPending=()=>{if(this.pointer)this.cancelGesture();else this.cancel();};
    private focus=(event:FocusEvent)=>{
      this.cancel();
      if(event.target===this.view.contentDOM){this.manual=false;this.schedule();}
    };
    private down=(event:PointerEvent)=>{
      if(this.pointer||event.isPrimary===false){this.cancelGesture();return;}
      this.cancel();
      const target=event.target as HTMLElement|null;
      const control=target?.closest?.('a,.cm-live-inline-link[data-live-inline-rendered="true"][role="link"],button,input,textarea,select,audio,video,[contenteditable="false"],.interactive-child');
      const body=target?.closest?.('.cm-content')===this.view.contentDOM&&(!control||!this.view.contentDOM.contains(control));
      this.manual=!body||event.button!==0||event.defaultPrevented;
      this.pointer=this.manual?undefined:{id:event.pointerId??0,x:event.clientX,y:event.clientY,moved:false,wanted:false};
    };
    private move=(event:PointerEvent)=>{
      if(this.pointer&&this.pointer.id===(event.pointerId??0)&&Math.hypot(event.clientX-this.pointer.x,event.clientY-this.pointer.y)>4)this.cancelGesture();
    };
    private touchMove=(event:TouchEvent)=>{
      const point=event.touches[0];
      if(!this.pointer||event.touches.length!==1||!point||Math.hypot(point.clientX-this.pointer.x,point.clientY-this.pointer.y)>4)this.cancelGesture();
    };
    private up=(event:PointerEvent)=>{
      if(this.pointer&&this.pointer.id!==(event.pointerId??0))return;
      const pointer=this.pointer;this.pointer=undefined;
      if(!pointer||pointer.moved||event.defaultPrevented||event.button!==0){this.cancel();return;}
      // DOM selection may arrive just after pointerup. No eager focus/caret rewrite.
      if(pointer.wanted)this.schedule();
    };
    private key=(event:KeyboardEvent)=>{
      if(event.target===this.view.contentDOM&&!event.isComposing){this.manual=false;this.pointer=undefined;}
    };
    private compositionStart=()=>{this.composing=true;this.cancel();};
    private compositionEnd=()=>{this.composing=false;};
    private resize=()=>{if(!this.manual)this.schedule();};
    private schedule=()=>{
      this.cancel();
      if(this.manual||!this.current())return;
      if(this.pointer){this.pointer.wanted=true;return;}
      const epoch=this.epoch,doc=this.view.state.doc,selection=this.view.state.selection;
      const valid=()=>epoch===this.epoch&&!this.manual&&!this.pointer&&this.current()
        &&this.view.state.doc===doc&&this.view.state.selection.eq(selection);
      this.view.requestMeasure({key:this,read:()=>valid(),write:ready=>{
        if(!ready||!valid())return;
        // CM measure.write runs during an update. Dispatch only after it returns.
        this.frame=this.win.requestAnimationFrame(()=>{
          this.frame=undefined;if(!valid())return;
          this.view.dispatch({effects:EditorView.scrollIntoView(selection.main,{x:'nearest',y:'nearest',yMargin:8})});
        });
      }});
    };
    update(update:ViewUpdate){
      if(update.docChanged){this.cancelPending();return;} // Typing already requests its own CM reveal.
      if(!update.startState.selection.eq(update.state.selection)||update.focusChanged)this.schedule();
    }
    destroy(){
      this.dead=true;this.cancel();
      this.document.removeEventListener('focusin',this.focus,true);
      this.document.removeEventListener('pointerdown',this.down,true);this.document.removeEventListener('pointermove',this.move,true);
      this.document.removeEventListener('pointerup',this.up,true);this.document.removeEventListener('pointercancel',this.cancelGesture,true);
      this.document.removeEventListener('dragstart',this.cancelGesture,true);this.document.removeEventListener('wheel',this.cancelGesture,true);
      this.document.removeEventListener('touchmove',this.touchMove,true);this.document.removeEventListener('touchcancel',this.cancelGesture,true);
      this.document.removeEventListener('keydown',this.key,true);this.document.removeEventListener('scroll',this.cancelPending,true);
      this.view.dom.removeEventListener('compositionstart',this.compositionStart,true);this.view.dom.removeEventListener('compositionend',this.compositionEnd,true);
      this.win.removeEventListener('blur',this.cancelGesture);this.win.removeEventListener('resize',this.resize);this.viewport?.removeEventListener('resize',this.resize);
    }
  });
}
