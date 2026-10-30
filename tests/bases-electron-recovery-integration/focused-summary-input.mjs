// Campaign-local trusted keyboard continuation. Renderer instrumentation only
// observes standard DOM/events; it never changes focus, DOM or product state.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
const digest=text=>createHash('sha256').update(text).digest('hex');
export const summaryOwner='[role="dialog"][aria-label="Edit summary"]';
export const summaryEditor='.cm-content[role="textbox"][aria-label="Summary expression"]';
export const summaryBase='.pane.is-active .bases-session';

/** Standard DOM readiness, with exact retained nodes rather than a fresh target.
 * Hit testing is deliberately absent: a completion popup may cover the center
 * while this very editor continues owning the keyboard and document selection. */
export function focusedSummaryFrame(document,original,state,expectedText){
  const {owner,editor,base,mirror,selectors,breadcrumb}=original;
  if(state.disposed||state.composing||state.settling||state.keyComposing||state.observed!==true)return false;
  if(document.visibilityState!=='visible'||document.hidden||!document.hasFocus())return false;
  if(!owner?.isConnected||!editor?.isConnected||!base?.isConnected||!mirror?.isConnected)return false;
  const unique=(root,selector,node)=>{const nodes=root.querySelectorAll(selector);return nodes.length===1&&nodes[0]===node;};
  if(!unique(document,selectors.owner,owner)||!unique(document,selectors.base,base)||!unique(owner,selectors.editor,editor)||!unique(owner,'textarea[aria-label="Summary expression"]',mirror))return false;
  if(!owner.contains(editor)||!owner.contains(mirror)||editor.closest(selectors.owner)!==owner||document.activeElement!==editor)return false;
  if(base.closest('.pane.is-active')?.querySelector('.breadcrumbs')?.textContent!==breadcrumb)return false;
  const visible=node=>{if(!node.getClientRects().length)return false;const rect=node.getBoundingClientRect();if(rect.width<=0||rect.height<=0||rect.right<=0||rect.bottom<=0||rect.left>=document.defaultView.innerWidth||rect.top>=document.defaultView.innerHeight)return false;for(let at=node;at;at=at.parentElement){const style=document.defaultView.getComputedStyle(at);if(at.hidden||at.hasAttribute('inert')||at.getAttribute('aria-hidden')==='true'||style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||style.opacity==='0')return false;}return true;};
  if(!visible(owner)||!visible(editor)||!visible(base)||owner.closest('[inert],[aria-disabled="true"],fieldset:disabled')||editor.closest('[inert],[aria-disabled="true"],fieldset:disabled')||mirror.matches(':disabled')||mirror.readOnly)return false;
  if(editor.getAttribute('contenteditable')!=='true'||editor.getAttribute('role')!=='textbox'||editor.getAttribute('aria-readonly')!=='false'||editor.getAttribute('aria-disabled')==='true'||mirror.value!==expectedText||editor.textContent!==expectedText)return false;
  const selection=document.getSelection();if(selection?.rangeCount!==1||!editor.contains(selection.anchorNode)||!editor.contains(selection.focusNode))return false;
  return{focused:true,connected:true,enabled:true,composing:false,ownerMatches:1,editorMatches:1,selectionComplete:selection.toString()===expectedText};
}

/** Install before the first A input on this newly opened, exact editor. This
 * observes IME-related DOM events only; it makes no claim about OS IME state. */
export function observeSummaryInput(document,selectors,breadcrumb,frame){
  const owners=document.querySelectorAll(selectors.owner),bases=document.querySelectorAll(selectors.base);
  if(owners.length!==1||bases.length!==1)throw Error('Unique original Summary owner and Base required');
  const owner=owners[0],editors=owner.querySelectorAll(selectors.editor),mirrors=owner.querySelectorAll('textarea[aria-label="Summary expression"]');
  if(editors.length!==1||mirrors.length!==1)throw Error('Unique original visible Summary editor and mirror required');
  const editor=editors[0],original={owner,editor,base:bases[0],mirror:mirrors[0],selectors,breadcrumb},state={observed:true,disposed:false,composing:false,settling:false,keyComposing:false};
  const start=()=>{state.composing=true;state.settling=false;},end=()=>{state.composing=false;state.settling=true;},input=event=>{if(!state.composing&&!event.isComposing)state.settling=false;},key=event=>{state.keyComposing=event.isComposing||event.keyCode===229;};
  const listeners=[['compositionstart',start],['compositionupdate',start],['compositionend',end],['input',input],['keydown',key]];
  for(const[type,listener]of listeners)editor.addEventListener(type,listener,{capture:true,passive:true});
  return{owner,editor,frame:expected=>frame(document,original,state,expected),dispose(){if(state.disposed)return;state.disposed=true;for(const[type,listener]of listeners)editor.removeEventListener(type,listener,true);}};
}
function value(reply){assert.equal(reply.exceptionDetails,undefined,'Focused editor passive read failed');return reply.result.value;}
export async function captureFocusedSummaryInput(c,breadcrumb){
  const group='recovery-summary-input-'+randomUUID(),selectors={owner:summaryOwner,editor:summaryEditor,base:summaryBase};let objectId;
  try{
    const reply=await c.cdp.call('Runtime.evaluate',{expression:`(${observeSummaryInput.toString()})(document,${JSON.stringify(selectors)},${JSON.stringify(breadcrumb)},${focusedSummaryFrame.toString()})`,objectGroup:group,returnByValue:false});
    assert.equal(reply.exceptionDetails,undefined);objectId=reply.result.objectId;assert.ok(objectId);
    const identity=async field=>{const node=await c.cdp.call('Runtime.callFunctionOn',{objectId,functionDeclaration:`function(){return this.${field};}`,objectGroup:group,returnByValue:false});assert.equal(node.exceptionDetails,undefined);return(await c.cdp.call('DOM.describeNode',{objectId:node.result.objectId})).node.backendNodeId;};
    return{objectId,group,panelBackendNodeId:await identity('owner'),editorBackendNodeId:await identity('editor')};
  }catch(error){if(objectId)try{await c.cdp.call('Runtime.callFunctionOn',{objectId,functionDeclaration:'function(){this.dispose();}',returnByValue:true});}catch{}await c.cdp.call('Runtime.releaseObjectGroup',{objectGroup:group});throw error;}
}
export async function disposeFocusedSummaryInput(c,original){
  try{const reply=await c.cdp.call('Runtime.callFunctionOn',{objectId:original.objectId,functionDeclaration:'function(){this.dispose();}',returnByValue:true});assert.equal(reply.exceptionDetails,undefined,'Original Summary input observer disposal failed');}
  finally{await c.cdp.call('Runtime.releaseObjectGroup',{objectGroup:original.group});}
}
export async function continueFocusedSummaryInput(c,original,text,expectedText){
  const guard=async(requireAll=false)=>{const reply=await c.cdp.call('Runtime.callFunctionOn',{objectId:original.objectId,functionDeclaration:'function(expected){return this.frame(expected);}',arguments:[{value:expectedText}],returnByValue:true});const result=value(reply);assert.ok(result,'Original Summary editor must still own safe keyboard focus and exact A source');if(requireAll)assert.equal(result.selectionComplete,true,'Original Summary editor must select the complete exact A before replacement');return result;};
  const before=await guard();await c.ui.key('a',{modifiers:4,commands:['selectAll']});await guard(true);
  await c.cdp.call('Input.insertText',{text});
  c.evidence.actions.push({action:'focused-summary-keyboard-continuation',panelBackendNodeId:original.panelBackendNodeId,editorBackendNodeId:original.editorBackendNodeId,before,expectedSha256:digest(expectedText),replacementSha256:digest(text),at:Date.now()});
}
