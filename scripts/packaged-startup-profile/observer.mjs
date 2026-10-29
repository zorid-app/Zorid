/** Inject only observations into the real packaged renderer. Never dispatch a
 * CodeMirror transaction, bridge write, alternate editor or replacement save. */
export function installObserver(config){
  if(window.__zoridPackagedProbe?.identity===config.identity)return true;
  window.__zoridPackagedProbe?.dispose?.();
  const now=()=>performance.now(),state={identity:config.identity,path:config.path,installedAt:now(),readyStateAtAttach:document.readyState,events:[],ready:null,initial:null,probes:[],errors:[]};
  let stopped=false,framing=false;
  const current=()=>{
    const pane=document.querySelector('.pane.is-active'),node=pane?.querySelector('.cm-content'),view=node?.cmTile?.root?.view??node?.cmView?.view;
    if(!view||view.contentDOM!==node)return null;
    const title=pane.querySelector('.note-title')?.value,expectedTitle=config.path.split('/').at(-1).replace(/\.md$/i,'');
    if(title!==expectedTitle)return null;
    return {pane,node,view};
  };
  function check(){
    if(stopped||state.ready||framing)return;
    const item=current();if(!item)return;
    const {node,view}=item,bounds=node.getBoundingClientRect();
    const prefixMatches=view.state.doc.sliceString(0,config.prefix.length)===config.prefix;
    if(view.state.doc.length!==config.characters||!prefixMatches||node.getAttribute('contenteditable')!=='true'||node.closest('[inert]')||bounds.width<=0||bounds.height<=0||bounds.bottom<=0||bounds.top>=innerHeight)return;
    framing=true;
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      framing=false;if(stopped||state.ready)return;
      const actual=current();if(!actual||actual.view!==view||view.state.doc.length!==config.characters)return;
      const firstLines=[...item.pane.querySelectorAll('.cm-line')].slice(0,6).map(n=>n.textContent).join('\n');
      if(!firstLines.includes(config.visibleText)){state.errors.push('First viewport did not contain fixture marker');return;}
      state.initial={length:view.state.doc.length,prefixMatches};state.ready={at:now(),visible:true,editable:true,visibleText:firstLines};
    }));
  }
  const mutation=new MutationObserver(check);
  const beforeinput=event=>{
    const name=Object.keys(config.markers).find(key=>config.markers[key]===event.data);if(!name)return;
    const item=current();if(!item||!item.node.contains(event.target))return;
    const index=state.probes.length,offset=index,before=item.view.state.doc.length;
    const guard=!!state.ready&&!item.node.closest('[inert]')&&item.node.getAttribute('contenteditable')==='true'&&item.view.state.selection.main.head===offset;
    const probe={name,identity:config.identity,marker:event.data,trusted:event.isTrusted===true,inputType:event.inputType,beforeInputAt:now(),guard,beforeCharacters:before};
    state.probes.push(probe);
    queueMicrotask(()=>{
      const actual=current(),view=actual?.view;
      probe.appliedAt=now();probe.accepted=probe.trusted&&guard&&actual?.node===item.node&&before===config.characters+index&&view?.state.doc.length===before+1&&view.state.doc.sliceString(offset,offset+1)===event.data&&view.state.selection.main.head===offset+1;
      probe.caret=view?.state.selection.main.head;
      requestAnimationFrame(()=>requestAnimationFrame(()=>{probe.caretAfterPaint=view?.state.selection.main.head;probe.expectedCaretAfterPaint=state.probes.length;}));
    });
  };
  const domReady=()=>state.events.push({kind:'dom-content-loaded',at:now()}),loaded=()=>state.events.push({kind:'window-load',at:now()});
  document.addEventListener('beforeinput',beforeinput,true);document.addEventListener('DOMContentLoaded',domReady);window.addEventListener('load',loaded);
  mutation.observe(document.documentElement??document,{subtree:true,childList:true,characterData:true,attributes:true});
  state.dispose=()=>{stopped=true;mutation.disconnect();document.removeEventListener('beforeinput',beforeinput,true);document.removeEventListener('DOMContentLoaded',domReady);window.removeEventListener('load',loaded);};
  window.__zoridPackagedProbe=state;check();return true;
}
export const observerSource=config=>`(${installObserver.toString()})(${JSON.stringify(config)})`;
