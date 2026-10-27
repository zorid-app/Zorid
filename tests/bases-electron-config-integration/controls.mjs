import assert from 'node:assert/strict';
import {delay} from '../tasks-electron-integration/cdp.mjs';
import {closeAcknowledgedToolbarPanel} from '../bases-electron-filter-integration/close-readiness.mjs';
export const active='.pane.is-active .bases-session';
export const dialog=name=>`[role="dialog"][aria-label=${JSON.stringify(name)}]`;
export const input=(name,scope='body')=>`${scope} input[aria-label=${JSON.stringify(name)}],${scope} textarea[aria-label=${JSON.stringify(name)}],${scope} [contenteditable="true"][aria-label=${JSON.stringify(name)}]`;
export async function closeMenu(c,name){
  const triggerLabel=({Property:'Properties',Formula:'Properties','View options':'Views'})[name]??name;
  // Config also edits Kanban and unsupported layouts. A present table still
  // needs a matching rendered version, but those layouts have no grid marker.
  await closeAcknowledgedToolbarPanel(c,{panelName:name,triggerLabel,requireTable:false,action:'configuration-panel-close-ready'});
  await c.ui.idle();
}
export async function choose(c,name){await c.ui.button('Views',active);await c.ui.button('Open view '+name,dialog('Views'));await c.ui.wait(`return document.querySelector('${active} [aria-label="Views"]')?.textContent.trim()===${JSON.stringify(name)};`,'Selected view '+name);await c.ui.idle();}
export async function focusByTab(c,predicate,label,{reverse=false,max=30}={}){
  for(let index=0;index<max;index++){
    if(await c.ui.dom(`const e=document.activeElement;return !!e&&(${predicate});`))return;
    await c.ui.key('Tab',{modifiers:reverse?8:0});
  }
  assert.fail('Actual Tab navigation did not reach '+label);
}
export async function exactRows(c,paths,name){
  const actual=await c.ui.wait(`const grid=document.querySelector('${active} [role="grid"]');if(grid?.getAttribute('aria-rowcount')!==${JSON.stringify(String(paths.length+1))})return false;const rows=[...grid.querySelectorAll('.zorid-bases-table-body .zorid-bases-table-row')].map(row=>row.querySelector('[data-path]')?.dataset.path);return JSON.stringify(rows)===${JSON.stringify(JSON.stringify(paths))}?rows:false;`,name);
  assert.deepEqual(actual,paths);c.evidence.checks.push({name,paths:actual});
}
export const section=(name)=>`${dialog('Filter')} .bases-filter-section:nth-of-type(${name==='All views'?1:2})`;
export function group(scope,path=[]){return `${scope} .bases-filter-tree > .bases-filter-group`+path.map(index=>` > .bases-filter-group:nth-child(${index+1} of .bases-filter-group)`).join('');}
export const condition=(owner,index)=>`${owner} > .bases-filter-condition:nth-child(${index+1} of .bases-filter-condition)`;
export async function match(c,owner,mode){await c.ui.select(`${owner} > select[aria-label="Match"]`,mode);}
export async function addGroup(c,owner){await c.ui.click(`${owner} > button[aria-label="Add group"]`);}
export async function addCondition(c,owner){await c.ui.click(`${owner} > button[aria-label="Add condition"]`);}
export async function editCondition(c,owner,index,property,operator,value){
  const row=condition(owner,index);
  await c.ui.select(`${row} > select[aria-label="Filter property"]`,property);
  await c.ui.select(`${row} > select[aria-label="Condition"]`,operator);
  const operand=`${row} .bases-filter-operand-host input[aria-label="Filter value"]`;
  if(typeof value==='boolean'){
    let state=await c.ui.wait(`const e=document.querySelector(${JSON.stringify(operand)});return e?.type==='checkbox'?{checked:e.checked,indeterminate:e.indeterminate}:false;`,'Real Boolean filter operand');
    if(state.indeterminate){await c.ui.click(operand);state=await c.ui.dom(`const e=document.querySelector(${JSON.stringify(operand)});return {checked:e.checked,indeterminate:e.indeterminate};`);}
    if(state.checked!==value)await c.ui.click(operand);
    await c.ui.wait(`const e=document.querySelector(${JSON.stringify(operand)});return e?.type==='checkbox'&&e.checked===${value}&&e.indeterminate===false;`,'Exact Boolean filter operand');
  }else{
    await c.ui.type(operand,value);
    await c.ui.wait(`const e=document.querySelector(${JSON.stringify(operand)});return e?.value===${JSON.stringify(String(value))}&&document.activeElement===e&&!e.matches(':disabled')&&!e.closest('[inert]');`,'Exact owned filter operand before completion');
    // Finish the field through its public keyboard interaction. Typing a
    // configured choice leaves a popup which can cover the next parent action.
    await c.ui.key('Tab');
    await c.ui.wait(`const e=document.querySelector(${JSON.stringify(operand)}),host=e?.closest('.bases-filter-operand-host');return e?.value===${JSON.stringify(String(value))}&&!!host&&e.getAttribute('aria-expanded')!=='true'&&!host.querySelector('[role="listbox"]');`,'Filter operand autocomplete completed');
  }
}
export async function savedConfiguration(c,check,name){return c.saved('Configuration.base',source=>{const config=c.yaml.parse(source);assert.equal(config.fixtureSentinel,'config-keep');assert.deepEqual(config.pluginRoot,{version:19,nested:['one','two']});assert.match(source,/# Configuration acceptance/);for(const view of config.views)assert.ok(view.pluginView,'Unknown per-view field retained');check(config);},name);}

/** Real Chromium drag start/interception, pointer preview, then keyboard cancel. */
export async function previewAndEscape(c,{source,target,placeholder,name}){
  const before=await c.read('Configuration.base'),from=await c.ui.point(source),to=await c.ui.point(target);
  let listener,timer,data,completed=false;
  await c.cdp.call('Input.setInterceptDrags',{enabled:true});
  const intercepted=new Promise((resolve,reject)=>{
    timer=setTimeout(()=>reject(Error('Native Chromium dragstart was not intercepted')),8000);
    listener=event=>{const value=JSON.parse(event.data);if(value.method==='Input.dragIntercepted'){clearTimeout(timer);resolve(value.params.data);}};
    c.cdp.ws.addEventListener('message',listener);
  });intercepted.catch(()=>{});
  try{
    await c.cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',...from});await c.cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...from});
    for(let step=1;step<=12;step++)await c.cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:from.x+(to.x-from.x)*step/12,y:from.y+(to.y-from.y)*step/12});
    data=await intercepted;
    for(const type of ['dragEnter','dragOver'])await c.cdp.call('Input.dispatchDragEvent',{type,...to,data});
    await c.ui.wait(`return !!document.querySelector(${JSON.stringify(placeholder)});`,name+' live preview');await c.screenshot(name+'-preview');
    await c.ui.key('Escape');await c.cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...to});
    await c.ui.wait(`return !document.querySelector(${JSON.stringify(placeholder)})&&!document.querySelector('${active} .is-being-dragged');`,name+' Escape removed preview');
    await delay(350);assert.equal(await c.read('Configuration.base'),before,'Canceled preview never persists configuration');
    c.evidence.actions.push({action:'actual-drag-preview-keyboard-cancel',name,from,to,types:data.items.map(item=>item.mimeType)});completed=true;
  }finally{
    clearTimeout(timer);if(listener)c.cdp.ws.removeEventListener('message',listener);
    // Cleanup is never the acceptance oracle for Escape. A failed assertion
    // remains failed even if Chromium requires this cleanup command.
    if(!completed){await c.cdp.call('Input.cancelDragging').catch(()=>{});c.evidence.actions.push({action:'failed-drag-cleanup',name});}
    await c.cdp.call('Input.setInterceptDrags',{enabled:false});
  }
}
