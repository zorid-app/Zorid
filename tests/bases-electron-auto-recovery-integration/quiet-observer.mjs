import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {sha256} from './oracles.mjs';
import {captureSessionOccurrence} from './session-occurrence.mjs';
/** Passive mutation + animation-frame audit. Only bounded category/count facts
 * leave the renderer; neither fixture text nor product/private state is read. */
export function observeQuietRecovery(document,options={kind:'busy'},occurrenceFactory){
  const occurrence=options.kind==='host'?occurrenceFactory(document,options.occurrence):undefined;
  const window=document.defaultView,pane=document.querySelector('.pane.is-active'),tab=pane?.querySelector('[role="tab"][data-tab-id][aria-selected="true"]'),breadcrumb=pane?.querySelector('.breadcrumbs')?.textContent;
  if(!pane||!tab?.dataset.tabId||!breadcrumb)throw Error('Original visible pane/tab/source required');
  const tabId=tab.dataset.tabId,events=[];let frames=0,overflow=false,stopped=false,raf;
  const record=kind=>{if(events.length>=128){overflow=true;return;}events.push({kind,at:performance.now()});};
  const hidden=node=>{for(let at=node;at;at=at.parentElement){const style=window.getComputedStyle(at);if(at.hidden||style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse')return true;}return false;};
  const inspect=node=>{if(node.nodeType!==1)return;const matches=[node,...node.querySelectorAll('[role="alert"],.notice,.bases-session[data-base-controller-error="true"],button')];for(const element of matches){
    if(hidden(element))continue;const text=element.textContent?.trim()??'';
    if(element.matches('[role="alert"]')&&text)record('nonempty-alert');
    if(element.matches('.notice')&&/failed|error|retry save|reopen vault/i.test(text))record('error-notice');
    if(element.matches('.bases-session[data-base-controller-error="true"]'))record('controller-error');
    if(element.matches('button')&&/^(Retry save|Review retained changes|Reopen vault)$/i.test(text)&&!element.hidden)record('manual-recovery-control');
  }};
  const records=changes=>{for(const change of changes){const element=change.target.nodeType===1?change.target:change.target.parentElement;if(element)inspect(element);if(change.type==='attributes'&&change.attributeName==='data-base-controller-error'&&change.oldValue==='true'&&!hidden(change.target))record('controller-error-between-samples');if(change.type==='characterData'&&change.oldValue?.trim()&&element?.closest('[role="alert"]')&&!hidden(element))record('alert-between-samples');if(change.type==='childList')for(const node of [...change.addedNodes,...change.removedNodes]){inspect(node);if(node.nodeType===3&&node.textContent?.trim()&&element?.closest('[role="alert"]')&&!hidden(element))record('alert-between-samples');}}};
  const observer=new window.MutationObserver(records);observer.observe(document.body,{subtree:true,childList:true,characterData:true,characterDataOldValue:true,attributes:true,attributeOldValue:true,attributeFilter:['data-base-controller-error','hidden','inert','aria-disabled','style']});
  const frame=()=>{if(stopped)return;frames++;occurrence?.read();inspect(document.body);raf=window.requestAnimationFrame(frame);};frame();
  const snapshot=()=>{records(observer.takeRecords());const active=document.querySelector('.pane.is-active'),activeTab=active?.querySelector('[role="tab"][data-tab-id][aria-selected="true"]');return{events:events.slice(),frames,overflow,visibilityState:document.visibilityState,hidden:document.hidden,sameDocument:document===pane.ownerDocument,samePane:active===pane&&pane.isConnected,sameTab:activeTab?.dataset.tabId===tabId,sameSource:active?.querySelector('.breadcrumbs')?.textContent===breadcrumb,tabId,breadcrumb,logicalOccurrence:occurrence?.read()};};
  return{metadata:()=>occurrence?.metadata(),read:snapshot,finish(){if(!stopped){stopped=true;window.cancelAnimationFrame(raf);try{records(observer.takeRecords());}finally{observer.disconnect();}}return snapshot();}};
}
export async function startQuietRecovery(c,options={kind:'busy'}){
  const group='auto-recovery-observer-'+randomUUID();let objectId;
  try{
    let occurrence;if(options.kind==='host'){const info=await c.cdp.evaluate('(async()=>window.zorid.getWindowInfo())()');assert.equal(typeof info.id,'string');assert.ok(info.id);occurrence={windowId:info.id,path:options.path,entryId:options.entryId};}
    const reply=await c.cdp.call('Runtime.evaluate',{expression:`(${observeQuietRecovery.toString()})(document,${JSON.stringify({kind:options.kind,occurrence})},${captureSessionOccurrence.toString()})`,objectGroup:group,returnByValue:false});
    assert.equal(reply.exceptionDetails,undefined);objectId=reply.result.objectId;assert.ok(objectId);const handle={group,objectId,kind:options.kind};
    if(options.kind==='host'){const read=await c.cdp.call('Runtime.callFunctionOn',{objectId,functionDeclaration:'function(){return this.metadata();}',returnByValue:true});assert.equal(read.exceptionDetails,undefined);const meta=read.result.value;
      assert.equal(sha256(meta.localStoreId),options.claim.localStoreIdSha256);assert.equal(sha256(meta.clientId),options.claim.clientIdSha256);assert.equal(options.claim.requestedClientIdSha256,options.claim.clientIdSha256);
      handle.occurrenceProof={keySha256:sha256(meta.key),localStoreIdSha256:sha256(meta.localStoreId),clientIdSha256:sha256(meta.clientId),paneId:meta.paneId,paneOrdinal:meta.paneOrdinal,tabOrdinal:meta.tabOrdinal,originalTabId:meta.originalTabId,entryId:meta.entryId,targetDomOrdinal:meta.targetDomOrdinal,domPaneOrderSha256:sha256(meta.domPaneOrderJson),descriptorSha256:sha256(meta.descriptorJson),inventorySha256:sha256(meta.inventoryJson),layoutSha256:sha256(meta.layoutJson)};
    }
    return handle;
  }catch(failure){let cleanup;try{if(objectId)await c.cdp.call('Runtime.callFunctionOn',{objectId,functionDeclaration:'function(){this.finish();}',returnByValue:true});}catch(error){cleanup=error;}try{await c.cdp.call('Runtime.releaseObjectGroup',{objectGroup:group});}catch(error){cleanup??=error;}if(cleanup)throw new AggregateError([failure,cleanup],failure.message+'; observer initialization cleanup also failed',{cause:failure});throw failure;}
}
export async function finishQuietRecovery(c,observer){
  let result,failure;
  try{const reply=await c.cdp.call('Runtime.callFunctionOn',{objectId:observer.objectId,functionDeclaration:'function(){return this.finish();}',returnByValue:true});assert.equal(reply.exceptionDetails,undefined);result=reply.result.value;assert.equal(result.overflow,false);assert.ok(result.frames>=2,'Both initial and later animation frames must be observed');assert.equal(result.visibilityState,'visible');assert.equal(result.hidden,false);assert.deepEqual(result.events,[],'Automatic recovery must not flash an error or offer manual recovery');assert.equal(result.sameDocument,true);if(observer.kind==='host')assert.equal(result.logicalOccurrence?.valid,true,'The exact original serialized pane/tab occurrence must restore');else{assert.equal(result.samePane,true);assert.equal(result.sameTab,true);}assert.equal(result.sameSource,true);}
  catch(error){failure=error;}
  try{await c.cdp.call('Runtime.releaseObjectGroup',{objectGroup:observer.group});}
  catch(cleanup){if(failure)throw new AggregateError([failure,cleanup],failure.message+'; observer cleanup also failed',{cause:failure});throw cleanup;}
  if(failure)throw failure;return observer.occurrenceProof?{...result,occurrenceProof:observer.occurrenceProof}:result;
}
