import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

/** Passive fixture-only observer: no focus, DOM writes, synthetic events or
 * product methods. Retained node references live only in its CDP object group. */
export function observeLostCreateUi(document){
  const win=document.defaultView,panes=[...document.querySelectorAll('.pane.is-active')];
  if(panes.length!==1)throw Error('One original active pane is required');
  const pane=panes[0],tabs=[...pane.querySelectorAll('.tab.is-active')];
  if(tabs.length!==1||!tabs[0].dataset.tabId)throw Error('One original stable active tab is required');
  const tabId=tabs[0].dataset.tabId,state={observed:true,mutationFrames:0,animationFrames:0,failures:[],overflow:false,disposed:false};
  let frameId;
  const visible=node=>{
    if(!node?.isConnected||!node.getClientRects().length)return false;
    const visibility=win.getComputedStyle(node).visibility;if(visibility==='hidden'||visibility==='collapse')return false;
    for(let current=node;current;current=current.parentElement){const style=win.getComputedStyle(current);if(current.hidden||style.display==='none'||style.opacity==='0')return false;}
    return true;
  };
  const fail=(category,node)=>{
    if(state.failures.some(row=>row.category===category))return;
    if(state.failures.length>=32){state.overflow=true;return;}
    state.failures.push({category,tag:node?.tagName??null,role:node?.getAttribute?.('role')??null});
  };
  const scanNode=node=>{
    if(node?.nodeType!==1)return;
    for(const element of [node,...node.querySelectorAll('[role="alert"],[role="status"],button,[role="button"],a,.bases-configuration-review')]){
      if(!visible(element))continue;
      const text=(element.textContent??'').trim(),label=(element.getAttribute('aria-label')??text).trim();
      if(element.getAttribute('role')==='alert'&&text)fail('visible-alert',element);
      if(element.getAttribute('role')==='status'&&/failed|unavailable|uncertain|unconfirmed|error|reopen|retry|reconcile|could not|not saved|unable/i.test(text))fail('visible-failure-status',element);
      if(element.matches('button,[role="button"],a')&&/\bretry\b|\breopen\b|\btry again\b|\breview retained changes\b/i.test(label))fail('visible-manual-recovery-control',element);
      if(element.matches('.bases-configuration-review'))fail('visible-retained-error-review',element);
    }
  };
  const sample=()=>{
    const active=[...document.querySelectorAll('.pane.is-active')];
    if(!pane.isConnected||active.length!==1||active[0]!==pane)fail('original-pane-changed',pane);
    const currentTabs=[...pane.querySelectorAll('.tab.is-active')];
    if(currentTabs.length!==1||currentTabs[0].dataset.tabId!==tabId)fail('original-tab-changed',currentTabs[0]);
    if(pane.querySelector('.breadcrumbs')?.textContent!=='Create')fail('original-source-changed',pane);
    scanNode(document.documentElement);
  };
  const observer=new win.MutationObserver(records=>{
    if(state.disposed)return;state.mutationFrames++;sample();
    // Also inspect still-connected added nodes; rAF sampling covers actual
    // visible frames. Detached nodes cannot have painted after their removal.
    for(const record of records)for(const node of record.addedNodes)scanNode(node);
  });
  observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
  const animate=()=>{if(state.disposed)return;state.animationFrames++;sample();frameId=win.requestAnimationFrame(animate);};
  sample();frameId=win.requestAnimationFrame(animate);
  const frame=()=>{
    sample();const bases=[...pane.querySelectorAll('.bases-session')],base=bases.length===1?bases[0]:null;
    const views=base?[...base.querySelectorAll('.bases-toolbar-tab[aria-selected="true"]')]:[];
    const buttons=base?[...base.querySelectorAll('button[aria-label="New"]')].filter(visible):[];
    const newButton=buttons.length===1?buttons[0]:null;
    return{...state,failures:state.failures.map(row=>({...row})),paneConnected:pane.isConnected,tabId,breadcrumb:pane.querySelector('.breadcrumbs')?.textContent??null,baseCount:bases.length,viewLabel:views.length===1?views[0].getAttribute('aria-label'):null,viewIndex:views.length===1?[...views[0].parentElement.children].indexOf(views[0]):-1,settled:!!base&&base.dataset.baseControllerError==='false'&&base.dataset.baseControllerUpdating==='false'&&base.querySelector('.bases-session-content')?.getAttribute('aria-busy')==='false'&&!!newButton&&!newButton.disabled&&!newButton.closest('[inert],[aria-disabled="true"]')};
  };
  return{pane,frame,dispose(){if(state.disposed)return;state.disposed=true;observer.disconnect();win.cancelAnimationFrame(frameId);}};
}
function value(reply){assert.equal(reply.exceptionDetails,undefined,'Lost-create passive observation failed');return reply.result.value;}
export async function captureLostCreateUi(c){
  const group='lost-create-ui-'+randomUUID();let objectId;
  try{
    const reply=await c.cdp.call('Runtime.evaluate',{expression:`(${observeLostCreateUi.toString()})(document)`,objectGroup:group,returnByValue:false});
    assert.equal(reply.exceptionDetails,undefined);objectId=reply.result.objectId;assert.ok(objectId);
    const pane=await c.cdp.call('Runtime.callFunctionOn',{objectId,functionDeclaration:'function(){return this.pane;}',objectGroup:group,returnByValue:false});assert.equal(pane.exceptionDetails,undefined);
    const {node}=await c.cdp.call('DOM.describeNode',{objectId:pane.result.objectId});
    return{group,objectId,paneBackendNodeId:node.backendNodeId};
  }catch(error){if(objectId)try{await c.cdp.call('Runtime.callFunctionOn',{objectId,functionDeclaration:'function(){this.dispose();}',returnByValue:true});}catch{}await c.cdp.call('Runtime.releaseObjectGroup',{objectGroup:group});throw error;}
}
export async function lostCreateUiFrame(c,original){return value(await c.cdp.call('Runtime.callFunctionOn',{objectId:original.objectId,functionDeclaration:'function(){return this.frame();}',returnByValue:true}));}
export async function disposeLostCreateUi(c,original){
  try{value(await c.cdp.call('Runtime.callFunctionOn',{objectId:original.objectId,functionDeclaration:'function(){this.dispose();}',returnByValue:true}));}
  finally{await c.cdp.call('Runtime.releaseObjectGroup',{objectGroup:original.group});}
}
