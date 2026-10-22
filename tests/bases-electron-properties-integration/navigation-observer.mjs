import {randomUUID} from 'node:crypto';

// A bounded DOM observation, shared by the passive event route and the existing
// padding-point read. It admits no text, URLs, arbitrary classes or attributes.
export function propertyTargetWitness(document,node,{allowedPaths=[],allowedProperties=[]}={}){
  if(!node||node.nodeType!==1)return null;
  const paths=new Set(allowedPaths),properties=new Set(allowedProperties);
  const own=(value,set)=>value===null?null:typeof value==='string'&&value.length<=512&&set.has(value)?value:'<redacted>';
  const classes=['bases-kanban-card','bases-kanban-card-line','bases-kanban-card-property','bases-kanban-column-body','bases-cards-item','bases-list-item','bases-metadata-value','bases-rendered-value','metadata-property-value','multi-select-pill','bases-property-popover','bases-file-hover','bases-file-hover-content','is-selected','is-pending','is-being-dragged','is-unresolved'];
  const owner=node.closest('[role="gridcell"][data-path],.bases-kanban-card[data-path],.bases-cards-item[data-path],.bases-list-item[data-path]');
  const property=node.closest('[data-property],[data-property-key]'),session=node.closest('.bases-session');
  const attr=(element,key)=>element?.getAttribute(key)??null;
  const flag=(element,key)=>{const value=attr(element,key);return value==='true'?true:value==='false'?false:null;};
  const version=(element,key)=>{const value=attr(element,key);return value===null?null:/^\d{1,16}$/.test(value)?value:'<redacted>';};
  const draft=attr(property,'data-base-editing'),focused=document.activeElement;
  const surface=node.closest('.bases-property-popover')?'picker':node.closest('.bases-file-hover')?'hover':node.closest('.bases-kanban-card')?'kanban':node.closest('.bases-cards-item')?'cards':node.closest('.bases-list-item')?'list':node.closest('.zorid-bases-table')?'table':'other';
  return {connected:node.isConnected,path:own(attr(owner,'data-path'),paths),property:own(attr(property,'data-property')??attr(property,'data-property-key'),properties),
    surface,classes:classes.filter(value=>node.classList.contains(value)).slice(0,8),
    editable:flag(property,'data-base-property-editable'),ariaDisabled:flag(property,'aria-disabled'),draft:['draft','pending'].includes(draft)?draft:draft===null?null:'<redacted>',
    widgetVersion:version(property,'data-base-widget-version'),renderedVersion:version(session?.querySelector('.zorid-bases-table'),'data-base-rendered-version'),controllerVersion:version(session,'data-base-controller-version'),controllerUpdating:flag(session,'data-base-controller-updating'),controllerError:flag(session,'data-base-controller-error'),
    busy:flag(session?.querySelector('.bases-session-content'),'aria-busy'),exactPropertyFocus:!!property&&focused===property,propertyOwnsFocus:!!property&&property.contains(focused),
    pickerPresent:!!document.querySelector('.bases-property-popover'),pickerHasFocus:!!document.querySelector('.bases-property-popover')?.contains(focused),hoverPresent:!!document.querySelector('.bases-file-hover'),dragging:!!document.querySelector('.bases-kanban-card.is-being-dragged')};
}

// Serialized into the owned renderer. Reads standard DOM/event state only;
// it never calls product APIs or changes focus, selection, DOM or event routing.
export function installNavigationObserver(document,{allowedPaths,allowedProperties=[],limit=2500},observeTarget=propertyTargetWitness){
  if(!Number.isInteger(limit)||limit<0||limit>2500)throw new Error('Bounded navigation trace required');
  const window=document.defaultView,paths=new Set(allowedPaths),properties=new Set(allowedProperties);
  const labels=new Set(allowedPaths.flatMap(path=>[path,path.split('/').at(-1),path.split('/').at(-1).replace(/\.(?:md|base)$/i,'')]));
  const roles=new Set(['treeitem','gridcell','link','button','textbox','combobox','option','dialog','menuitem','tab','heading','group','listbox']);
  const tags=new Set(['DIV','SPAN','A','BUTTON','INPUT','TEXTAREA','SELECT','OPTION','SECTION','P','H1','H2','H3','BODY','HTML','SVG','PATH']);
  const events=[];let dropped=0,sequence=0,stopped=false,lastNavigation,observer,stoppedAtCap=false;
  const owned=(value,set,max=512)=>value===null?null:typeof value==='string'&&value.length<=max&&set.has(value)?value:'<redacted>';
  const describe=node=>{
    if(!node||node.nodeType!==1)return {kind:'other'};
    const tree=node.closest('[role="treeitem"][data-path]'),cell=node.closest('[role="gridcell"][data-path]'),property=node.closest('[data-property-key]'),link=node.closest('a,[role="link"]');
    const text=link?.textContent;
    return {tag:owned(node.tagName,tags,32),role:owned(node.getAttribute('role'),roles,32),kind:tree?'tree':cell?'gridcell':property?'property':link?'link':node.closest('input,textarea,[contenteditable="true"]')?'editor':'other',
      treePath:owned(tree?.getAttribute('data-path')??null,paths),cellPath:owned(cell?.getAttribute('data-path')??null,paths),
      property:owned(cell?.getAttribute('data-property')??property?.getAttribute('data-property-key')??null,properties,128),
      linkLabel:link?owned(typeof text==='string'&&text.length<=512?text.trim():'',labels):null,
      propertyTarget:observeTarget(document,node,{allowedPaths,allowedProperties})};
  };
  const frame=()=>{
    const pane=document.querySelector('.pane.is-active'),author=pane?.querySelector('[data-property-key="author"] .metadata-property-value'),active=document.querySelectorAll('[role="treeitem"].is-active[data-path]'),activeTreePaths=[];
    for(let i=0;i<Math.min(active.length,8);i++)activeTreePaths.push(owned(active[i].getAttribute('data-path'),paths));
    const tab=pane?.querySelector('.tab.is-active .tab-title')?.textContent;
    return {activeTreePaths,moreActivePaths:active.length>8,noteTitle:owned(pane?.querySelector('.note-title')?.value??null,labels),activeTab:owned(typeof tab==='string'&&tab.length<=512?tab.trim():null,labels),
      author:{present:!!author,linked:!!author?.querySelector('.multi-select-pill[role="link"]'),unresolved:!!author?.querySelector('.is-unresolved')},
      focused:describe(document.activeElement),readiness:observeTarget(document,pane?.querySelector('.bases-session'),{allowedPaths,allowedProperties}),visible:document.visibilityState,hasFocus:document.hasFocus()};
  };
  const cap=()=>{stoppedAtCap=true;observer?.disconnect();};
  const record=(kind,detail=()=>({}))=>{
    if(stopped)return;sequence++;
    if(events.length>=limit){dropped++;cap();return;}
    events.push({sequence,at:Date.now(),monotonicMs:window.performance.now(),kind,...detail(),navigation:frame()});
    if(events.length>=limit)cap();
  };
  const modifiers=event=>({alt:!!event.altKey,control:!!event.ctrlKey,meta:!!event.metaKey,shift:!!event.shiftKey});
  const pointer=event=>record(event.type,()=>({trusted:event.isTrusted,target:describe(event.target),button:event.button,buttons:event.buttons,x:event.clientX,y:event.clientY,modifiers:modifiers(event)}));
  const key=event=>record(event.type,()=>({trusted:event.isTrusted,target:describe(event.target),key:/^(?:Enter|Escape|Tab|Backspace|Delete|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown|Meta|Control|Alt|Shift|F(?:[1-9]|1[0-2]))$/.test(event.key)?event.key:'<character>',modifiers:modifiers(event),repeat:!!event.repeat}));
  const focus=event=>record(event.type,()=>({trusted:event.isTrusted,target:describe(event.target)}));
  const navigation=()=>{if(stoppedAtCap)return;const next=JSON.stringify(frame());if(next!==lastNavigation){lastNavigation=next;record('dom-navigation');}};
  const listeners=[...['pointerdown','pointerup','click','dragstart','dragend'].map(type=>[document,type,pointer]),...['keydown','keyup'].map(type=>[document,type,key]),[document,'focusin',focus],[document,'visibilitychange',focus],[window,'focus',focus],[window,'blur',focus]];
  for(const [target,type,listener] of listeners)target.addEventListener(type,listener,{capture:true,passive:true});
  observer=new window.MutationObserver(navigation);
  observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','data-path','data-property','data-property-key','role','aria-disabled','aria-busy','data-base-controller-version','data-base-controller-updating','data-base-controller-error','data-base-widget-version','data-base-editing']});
  record('observer-start');if(!stoppedAtCap)lastNavigation=JSON.stringify(frame());
  return {stop(){
    if(stopped)throw new Error('Navigation observer already stopped');let final;
    try{navigation();final=frame();}
    finally{observer.disconnect();for(const [target,type,listener] of listeners)target.removeEventListener(type,listener,true);stopped=true;}
    return {events,dropped,observed:sequence,limit,stoppedAtCap,final,stopped:true};
  }};
}

// Campaign-local diagnostics never replace an original result or exception.
export async function withNavigationObservation(context,run,{allowedPaths,allowedProperties=[],limit=2500}){
  const evidence=context.evidence;evidence.navigationTrace??=[];let active=false,launchName,retained=0,token;
  const problem=(error,stage)=>{const errors=evidence.navigationObserverErrors??=[];const name=['Error','TypeError','SyntaxError','AssertionError'].includes(error?.name)?error.name:'Error';if(errors.length<8)errors.push({stage,name,reason:'observation-unavailable'});else evidence.navigationObserverErrorOverflow=(evidence.navigationObserverErrorOverflow??0)+1;evidence.navigationTraceIncomplete=true;};
  async function drain(reason){
    if(!active)return;active=false;
    try{
      const trace=await context.ui.dom(`const owner=window.__zoridPropertiesNavigationObserver;if(!owner||owner.token!==${JSON.stringify(token)})return null;try{return owner.handle.stop();}finally{delete window.__zoridPropertiesNavigationObserver;}`);
      if(!trace){evidence.navigationObserverCleanupUnconfirmed=true;problem(new Error('Missing owned navigation observer'),'drain');return;}
      retained+=trace.events.length;evidence.navigationTrace.push({launch:launchName,reason,...trace});
    }catch(error){evidence.navigationObserverCleanupUnconfirmed=true;problem(error,'drain');}
  }
  const scoped=Object.create(context);
  scoped.launch=async(...args)=>{
    const result=await context.launch(...args);launchName=args[0];active=true;token='properties-navigation-'+randomUUID();
    try{await context.ui.dom(`if(window.__zoridPropertiesNavigationObserver)throw Error('Duplicate owned navigation observer');window.__zoridPropertiesNavigationObserver={token:${JSON.stringify(token)},handle:(${installNavigationObserver.toString()})(document,${JSON.stringify({allowedPaths,allowedProperties,limit:limit-retained})},(${propertyTargetWitness.toString()}))};return true;`);}
    catch(error){problem(error,'install');}
    return result;
  };
  scoped.quit=async(...args)=>{await drain('before-normal-quit');return context.quit(...args);};
  let failed=false;
  try{return await run(scoped);}
  catch(error){failed=true;throw error;}
  finally{await drain(failed?'campaign-failure':'campaign-finally');}
}
