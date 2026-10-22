import assert from 'node:assert/strict';
import {delay} from '../tasks-electron-integration/cdp.mjs';
export const active='.pane.is-active .bases-session';
export const dialog=name=>`[role="dialog"][aria-label=${JSON.stringify(name)}]`;
export const input=(name,scope='body')=>`${scope} input[aria-label=${JSON.stringify(name)}],${scope} textarea[aria-label=${JSON.stringify(name)}],${scope} [contenteditable="true"][aria-label=${JSON.stringify(name)}]`;
export async function closeMenu(c,name){
  // Completion Escape is a separate user interaction, not a retry of a failed
  // action. Only issue it if an actual completion/picker popup is visible.
  if(await c.ui.dom(`const panel=document.querySelector(${JSON.stringify(dialog(name))});return !![...panel?.querySelectorAll('[role="listbox"],.cm-tooltip-autocomplete')??[]].find(e=>e.getClientRects().length);`))await c.ui.key('Escape');
  await c.ui.key('Escape');await c.ui.wait(`return !document.querySelector(${JSON.stringify(dialog(name))});`,'Closed acknowledged '+name);await c.ui.idle();
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
  await c.ui.type(`${row} > input[aria-label="Filter value"]`,value);
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
