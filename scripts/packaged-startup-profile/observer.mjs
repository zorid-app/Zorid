/** Inject only observations into the real packaged renderer. Never dispatch a
 * CodeMirror transaction, bridge write, alternate editor or replacement save. */
export function installObserver(config){
  if(window.__zoridPackagedProbe?.identity===config.identity)return true;
  window.__zoridPackagedProbe?.dispose?.();
  const now=()=>performance.now(),state={identity:config.identity,path:config.path,installedAt:now(),readyStateAtAttach:document.readyState,events:[],ready:null,initial:null,probes:[],errors:[]};
  let stopped=false,framing=false;const pending=new Set();
  const current=()=>{
    const pane=document.querySelector('.pane.is-active'),node=pane?.querySelector('.cm-content'),view=node?.cmTile?.root?.view??node?.cmView?.view;
    if(!view||view.contentDOM!==node)return null;
    const title=pane.querySelector('.note-title')?.value,expectedTitle=config.path.split('/').at(-1).replace(/\.md$/i,'');
    if(title!==expectedTitle)return null;
    return {pane,node,view};
  };
  const eligible=()=>{
    const item=current();if(!item)return null;
    const {node,view}=item,bounds=node.getBoundingClientRect();
    if(view.state.doc.length!==config.characters||view.state.doc.sliceString(0,config.prefix.length)!==config.prefix||node.getAttribute('contenteditable')!=='true'||node.closest('[inert]')||bounds.width<=0||bounds.height<=0||bounds.bottom<=0||bounds.top>=innerHeight)return null;
    return item;
  };
  function check(){
    if(stopped||state.ready||framing)return;
    const item=eligible();if(!item)return;
    framing=true;
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      framing=false;if(stopped||state.ready)return;
      const actual=eligible();if(!actual||actual.view!==item.view)return;
      const firstLines=[...actual.pane.querySelectorAll('.cm-line')].slice(0,6).map(n=>n.textContent).join('\n');
      if(!firstLines.includes(config.visibleText)){state.errors.push('First viewport did not contain fixture marker');return;}
      state.initial={length:actual.view.state.doc.length,prefixMatches:true};state.ready={at:now(),visible:true,editable:true,visibleText:firstLines};
    }));
  }
  function applied(item){
    if(stopped||!pending.has(item))return;
    const {probe,node,before,offset,index}=item,actual=current(),view=actual?.view;
    const changed=actual?.node===node&&view?.state.doc.length===before+1&&view.state.doc.sliceString(offset,offset+1)===probe.marker&&view.state.selection.main.head===offset+1;
    if(!changed&&now()-probe.beforeInputAt<1000){
      if(!item.scheduled){item.scheduled=true;requestAnimationFrame(()=>{item.scheduled=false;applied(item);});}return;
    }
    pending.delete(item);
    if(changed)probe.appliedAt=now();else probe.notAppliedAt=now();
    probe.accepted=probe.trusted&&probe.guard&&before===config.characters+index&&changed;
    probe.caret=view?.state.selection.main.head;
    requestAnimationFrame(()=>requestAnimationFrame(()=>{if(stopped)return;probe.caretAfterPaint=view?.state.selection.main.head;probe.expectedCaretAfterPaint=state.probes.length;}));
  }
  const mutation=new MutationObserver(()=>{check();for(const item of pending)applied(item);});
  const beforeinput=event=>{
    const name=Object.keys(config.markers).find(key=>config.markers[key]===event.data);if(!name)return;
    const item=current();if(!item||!item.node.contains(event.target))return;
    const index=state.probes.length,offset=index,before=item.view.state.doc.length;
    const guard=!!state.ready&&!item.node.closest('[inert]')&&item.node.getAttribute('contenteditable')==='true'&&item.view.state.selection.main.head===offset;
    const probe={name,identity:config.identity,marker:event.data,trusted:event.isTrusted===true,inputType:event.inputType,beforeInputAt:now(),guard,beforeCharacters:before};
    state.probes.push(probe);
    const waiting={probe,node:item.node,before,offset,index,scheduled:false};pending.add(waiting);queueMicrotask(()=>applied(waiting));
  };
  const domReady=()=>state.events.push({kind:'dom-content-loaded',at:now()}),loaded=()=>state.events.push({kind:'window-load',at:now()});
  document.addEventListener('beforeinput',beforeinput,true);document.addEventListener('DOMContentLoaded',domReady);window.addEventListener('load',loaded);
  mutation.observe(document.documentElement??document,{subtree:true,childList:true,characterData:true,attributes:true});
  state.dispose=()=>{stopped=true;pending.clear();mutation.disconnect();document.removeEventListener('beforeinput',beforeinput,true);document.removeEventListener('DOMContentLoaded',domReady);window.removeEventListener('load',loaded);};
  // DOM properties and completed layout can become eligible without another
  // observed mutation. Each harness snapshot requests a fresh observational
  // check; readiness still requires its original two animation frames.
  state.sample=()=>{check();return {...Object.fromEntries(Object.entries(state).filter(([,value])=>typeof value!=='function')),sampledAt:now(),readinessCheck:{eligible:!!eligible(),framesPending:framing}};};
  window.__zoridPackagedProbe=state;check();return true;
}
export const observerSource=config=>`(${installObserver.toString()})(${JSON.stringify(config)})`;

export const sampleObserverSource=`(()=>{const value=window.__zoridPackagedProbe;if(!value)return null;return value.sample();})()`;
/** Diagnostic reads only. Preserve actual editor predicates and visible DOM even
 * when readiness never succeeds, without pretending this is acceptance proof. */
export function selectedEditorDiagnostics(){
  const pane=document.querySelector('.pane.is-active'),node=pane?.querySelector('.cm-content'),view=node?.cmTile?.root?.view??node?.cmView?.view;
  const rect=n=>{if(!n)return null;const value=n.getBoundingClientRect();return {top:value.top,bottom:value.bottom,left:value.left,width:value.width,height:value.height};};
  return {sampledAt:performance.now(),visibilityState:document.visibilityState??null,hidden:document.hidden??null,documentHasFocus:document.hasFocus?.()??null,probe:window.__zoridPackagedProbe?.sample?.()??null,
    title:pane?.querySelector('.note-title')?.value??null,contentFound:!!node,viewFound:!!view,contentDOMMatches:!!view&&view.contentDOM===node,
    characters:view?.state.doc.length??null,prefix:view?.state.doc.sliceString(0,160)??null,bounds:rect(node),editable:node?.getAttribute('contenteditable')??null,
    inert:!!node?.closest('[inert]'),focused:!!node&&document.activeElement===node,viewportHeight:innerHeight,
    firstLines:[...pane?.querySelectorAll('.cm-line')??[]].slice(0,6).map(n=>({text:n.textContent,bounds:rect(n)})),
    visibleContent:[...node?.children??[]].filter(n=>{const r=n.getBoundingClientRect();return r.height>0&&r.bottom>0&&r.top<innerHeight;}).slice(0,12).map(n=>({text:n.textContent,html:n.outerHTML?.slice(0,4096),bounds:rect(n)}))};
}
export async function captureObserverFailure(renderer,launch){
  if(!renderer){launch.failureObservation={unavailable:'Renderer observer not attached'};return;}
  try{launch.failureObservation=await renderer.evaluate(`(${selectedEditorDiagnostics.toString()})()`);
    const record=launch.cases?.find(record=>record.identity===launch.failureObservation?.probe?.identity);if(record)record.failureObservation=launch.failureObservation;
  }catch(error){launch.failureObservation={error:String(error)};}
}
