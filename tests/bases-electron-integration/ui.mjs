import assert from 'node:assert/strict';
import {delay, until} from '../tasks-electron-integration/cdp.mjs';
import {beginDrag} from '../bases-electron-layouts-integration/drag.mjs';
export const MOD={alt:1,control:2,meta:4,shift:8};

// Serialized into the renderer by both pointer locators. This reads standard DOM
// actionability and existing diagnostics only; it never asks product state to settle.
function pointerTarget(element, {allowDisabled = false, requireEnabled = true} = {}) {
  if (!element?.isConnected || !element.getClientRects().length || element.closest('[hidden]')) return false;
  const nativeDisabled = element.matches(':disabled');
  const ariaDisabled = !!element.closest('[aria-disabled="true"]');
  const inert = !!element.closest('[inert]');
  // A negative disabled-control probe still needs a real, non-inert hit target.
  if (inert || (requireEnabled && !allowDisabled && (nativeDisabled || ariaDisabled))) return false;
  element.scrollIntoView({block:'nearest',inline:'nearest'});
  const bounds = element.getBoundingClientRect(), x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  if (!bounds.width || !bounds.height || !element.contains(element.ownerDocument.elementFromPoint(x,y))) return false;
  const attr = (node,name) => node?.getAttribute(name) ?? null;
  const session = element.closest('.bases-session'), cell = element.closest('[role="gridcell"],[data-property]');
  return {x,y,actionability:{observedAt:Date.now(),nativeDisabled,ariaDisabled,inert,allowDisabled,requireEnabled,
    disabledReasons:[...(nativeDisabled ? ['native-disabled'] : []),...(ariaDisabled ? ['aria-disabled'] : [])],
    target:{tag:element.tagName,role:attr(element,'role'),label:attr(element,'aria-label'),path:attr(cell,'data-path'),property:attr(cell,'data-property')},
    ...(session ? {base:{controllerVersion:attr(session,'data-base-controller-version'),controllerUpdating:attr(session,'data-base-controller-updating'),controllerError:attr(session,'data-base-controller-error'),
      renderedVersion:attr(session.querySelector('.zorid-bases-table'),'data-base-rendered-version'),widgetVersion:attr(cell,'data-base-widget-version'),
      busy:attr(session.querySelector('.bases-session-content'),'aria-busy'),ariaDisabled:attr(cell,'aria-disabled'),editing:attr(cell,'data-base-editing')}} : {})}};
}

// Native SELECT diagnostics are passive snapshots. Browser :open support is
// optional and says nothing by itself about a macOS-owned menu or OS key routing.
function nativeSelectFrame(document, selector) {
  const matches = [...document.querySelectorAll(selector)], element = matches[0], focused = document.activeElement;
  let open = null;
  if (element) try { open = element.matches(':open'); } catch { /* Unsupported selector. */ }
  return {matches:matches.length,tag:element?.tagName??null,connected:element?.isConnected??false,
    value:element?.value??null,selectedIndex:element?.selectedIndex??null,
    options:element?.tagName==='SELECT'?[...element.options].map(option=>({value:option.value,label:option.textContent,selected:option.selected,disabled:option.disabled})):[],
    nativeDisabled:element?.matches(':disabled')??null,ariaDisabled:!!element?.closest('[aria-disabled="true"]'),inert:!!element?.closest('[inert]'),
    open,focus:{isSelect:focused===element,tag:focused?.tagName??null,role:focused?.getAttribute('role')??null,label:focused?.getAttribute('aria-label')??null},
    document:{visibilityState:document.visibilityState,hidden:document.hidden,hasFocus:document.hasFocus()}};
}

// Every positive mutation is routed through visible app controls. DOM evaluation
// locates/reads elements; it does not call workspace/controller/store APIs.
export class UI {
  constructor(cdp, actions, {nativeSelectInput} = {}) { this.cdp = cdp; this.actions = actions; this.nativeSelectInput = nativeSelectInput; }
  dom(body) { return this.cdp.evaluate(`(()=>{${body}})()`); }
  async wait(body, label, timeout = 20000) {
    return until(async () => { const result = await this.dom(body); assert.ok(result, label); return result; }, timeout);
  }
  async point(selector, index = 0, {allowDisabled = false, requireEnabled = true, receipt = false} = {}) {
    const point = await this.wait(`const e=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.getClientRects().length&&!e.closest('[hidden]'))[${index}];return (${pointerTarget.toString()})(e,${JSON.stringify({allowDisabled,requireEnabled})});`, `Actionable visible unobscured ${selector}[${index}]`);
    // Existing drag/hover consumers spread point() into CDP arguments.
    return receipt ? point : {x:point.x,y:point.y};
  }
  async click(selector, {index = 0, count = 1, modifiers = 0, button = 'left', allowDisabled = false} = {}) {
    let point = await this.point(selector, index, {allowDisabled,receipt:true});
    await this.cdp.call('Input.dispatchMouseEvent', {type:'mouseMoved', x:point.x, y:point.y});
    // Mouse movement can change the hit target or enablement. Re-read before
    // dispatch; this is the same generic actionability gate, not a result wait.
    point = await this.point(selector, index, {allowDisabled,receipt:true});
    for (let clickCount = 1; clickCount <= count; clickCount++) {
      await this.cdp.call('Input.dispatchMouseEvent', {type:'mousePressed', button, clickCount, modifiers, x:point.x, y:point.y});
      await this.cdp.call('Input.dispatchMouseEvent', {type:'mouseReleased', button, clickCount, modifiers, x:point.x, y:point.y});
    }
    this.actions.push({action:'pointer', selector, index, count, modifiers, button, point:{x:point.x,y:point.y},actionability:point.actionability,at:Date.now()});
  }
  async button(label, scope = 'body', {allowDisabled = false} = {}) {
    const locate = () => this.wait(`const root=document.querySelector(${JSON.stringify(scope)});const all=root?[...root.querySelectorAll('button,[role="menuitem"]')]:[];const match=all.filter(e=>e.getClientRects().length&&!e.closest('[hidden]')&&(e.getAttribute('aria-label')===${JSON.stringify(label)}||e.textContent.trim()===${JSON.stringify(label)}));if(match.length!==1)return false;return (${pointerTarget.toString()})(match[0],${JSON.stringify({allowDisabled})});`, `Exactly one actionable visible ${label} button in ${scope}`);
    const resultsState=()=>this.dom(`const e=document.querySelector(${JSON.stringify(scope)})?.querySelector('button[aria-label="Results"]');return {expanded:e?.getAttribute('aria-expanded'),dialog:!!document.querySelector('[role="dialog"][aria-label="Results"]'),busy:document.querySelector('.pane.is-active .bases-session-content')?.getAttribute('aria-busy'),summary:document.querySelector('.pane.is-active .zorid-bases-table-footer [data-summary-property="note.rating"] .summary-function-name')?.textContent};`);
    let point=await locate();
    const before=label==='Results'?await resultsState():undefined;
    if(before)point=await locate(); // Diagnostic awaits cannot authorize a stale disabled target.
    await this.cdp.call('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,x:point.x,y:point.y});
    await this.cdp.call('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,x:point.x,y:point.y});
    const after=label==='Results'?await resultsState():undefined;
    this.actions.push({action:'button',label,scope,point:{x:point.x,y:point.y},actionability:point.actionability,...(before?{before,after}:{}),at:Date.now()});
  }
  async key(key, {code, modifiers = 0, commands} = {}) {
    const codes = {Enter:['Enter',13],Escape:['Escape',27],Tab:['Tab',9],Backspace:['Backspace',8],Delete:['Delete',46],ArrowDown:['ArrowDown',40],ArrowUp:['ArrowUp',38],ArrowRight:['ArrowRight',39],ArrowLeft:['ArrowLeft',37],Home:['Home',36],End:['End',35]};
    const mapped = codes[key] ?? [code ?? `Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0)];
    for (const type of ['keyDown','keyUp']) await this.cdp.call('Input.dispatchKeyEvent',{type,key,code:code ?? mapped[0],windowsVirtualKeyCode:mapped[1],modifiers,...(type==='keyDown'&&commands?{commands}:{})});
    this.actions.push({action:'key',key,modifiers,commands,at:Date.now()});
  }
  async type(selector, text) {
    await this.click(selector); await this.key('a',{modifiers:MOD.meta,commands:['selectAll']});
    await this.cdp.call('Input.insertText',{text});
    this.actions.push({action:'text',selector,text,at:Date.now()});
  }
  async drag(source,target) {
    const drag=await beginDrag({cdp:this.cdp,ui:this,evidence:{actions:this.actions}},source);
    try { await drag.over(target); await drag.dropAtLast(); }
    finally { await drag.cleanup(); }
  }
  async select(selector, value) {
    const model = await this.wait(`const matches=[...document.querySelectorAll(${JSON.stringify(selector)})],e=matches[0];if(e?.tagName!=='SELECT')return false;const row=e.closest('.bases-filter-condition'),base=document.querySelector('.pane.is-active .bases-session'),attr=(node,name)=>node?.getAttribute(name)??null;return {matches:matches.length,connected:e.isConnected,label:e.getAttribute('aria-label'),custom:e.hidden&&e.nextElementSibling?.getAttribute('role')==='combobox',value:e.value,selectedIndex:e.selectedIndex,nativeDisabled:e.matches(':disabled'),ariaDisabled:!!e.closest('[aria-disabled="true"]'),inert:!!e.closest('[inert]'),values:[...e.options].map(o=>({value:o.value,label:o.textContent,disabled:o.disabled})),filterProperty:row?.querySelector('select[aria-label="Filter property"]')?.value??null,activeBase:base?{controllerVersion:attr(base,'data-base-controller-version'),controllerUpdating:attr(base,'data-base-controller-updating'),controllerError:attr(base,'data-base-controller-error'),busy:attr(base.querySelector('.bases-session-content'),'aria-busy'),renderedVersion:attr(base.querySelector('.zorid-bases-table'),'data-base-rendered-version')}:null};`, 'Select value model');
    // Retain the observed model even when the original admission assertion
    // rejects it. This diagnostic adds no input, retry or readiness condition.
    this.actions.push({action:'select-value-model',selector,requestedValue:value,model:structuredClone(model),at:Date.now()});
    const values=model.values;
    const index = values.findIndex(o => o.value === value || o.label === value);
    assert.ok(index >= 0 && !values[index].disabled, `Selectable ${value}`);
    if(model.custom){
      const presented=selector.replace(/select(?=\[)/g,'button[role="combobox"]');
      await this.click(presented);
      const chosen=await this.wait(`const list=[...document.querySelectorAll('[role="listbox"]')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(model.label)}&&e.getClientRects().length);const options=list?[...list.querySelectorAll('[role="option"]')]:[];const row=options.find(e=>e.textContent===${JSON.stringify(values[index].label)}&&e.getAttribute('aria-disabled')!=='true');if(!row)return false;row.scrollIntoView({block:'nearest'});const r=row.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return row.contains(document.elementFromPoint(x,y))?{x,y}:false;`,'Visible custom option '+values[index].label);
      await this.cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...chosen});await this.cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...chosen});
      this.actions.push({action:'custom-option',selector,label:values[index].label,value:values[index].value,at:Date.now()});
    }else{
      const frame=async phase=>{const observed={action:'native-select-frame',selector,phase,expectedValue:values[index].value,...await this.dom(`return (${nativeSelectFrame.toString()})(document,${JSON.stringify(selector)});`),at:Date.now()};this.actions.push(observed);return observed;};
      const key=async(key,phase)=>{await frame('before-'+phase);await this.key(key);await frame('after-'+phase);};
      await frame('before-click');await this.click(selector);const opened=await frame('after-click');
      // Preserve the existing platform recipe while observing each key. These
      // CDP reads add round trips, not sleeps, semantic waits, retries or writes.
      if(this.nativeSelectInput){
        try{await this.nativeSelectInput(opened);}catch(error){
          try{await frame('cua-input-failed');}catch(diagnostic){this.actions.push({action:'native-select-diagnostic-error',selector,message:diagnostic.message,at:Date.now()});}
          throw error;
        }
        await frame('after-cua-input');
      }else{
        await key('Home','Home');
        for (let i = 0; i < index; i++) await key('ArrowDown','ArrowDown-'+(i+1));
        await key('Enter','Enter');
      }
      try{
        await this.wait(`return document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(values[index].value)};`, 'Native select accepted keyboard input');
        await frame('readback-succeeded');
      }catch(error){
        try{await frame('readback-failed');}catch(diagnostic){this.actions.push({action:'native-select-diagnostic-error',selector,message:diagnostic.message,at:Date.now()});}
        throw error;
      }
      return;
    }
    await this.wait(`return document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(values[index].value)};`, 'Native select accepted keyboard input');
  }
  async range(selector,value){
    const model=await this.wait(`const e=document.querySelector(${JSON.stringify(selector)});return e?.type==='range'?{min:Number(e.min),max:Number(e.max),step:Number(e.step||1)}:false;`,'Visible range model');
    const steps=Math.round((value-model.min)/model.step);assert.ok(steps>=0&&value<=model.max);
    await this.click(selector);await this.key('Home');for(let i=0;i<steps;i++)await this.key('ArrowRight');
    await this.wait(`return Math.abs(Number(document.querySelector(${JSON.stringify(selector)})?.value)-${value})<0.00001;`,'Range accepts actual keyboard value');
  }
  async scroll(selector,deltaY){const point=await this.point(selector,0,{requireEnabled:false});await this.cdp.call('Input.dispatchMouseEvent',{type:'mouseWheel',deltaX:0,deltaY,x:point.x,y:point.y});await delay(100);this.actions.push({action:'wheel',selector,deltaY,at:Date.now()});}
  async openFile(file) {
    const selector = `[role="treeitem"][data-path=${JSON.stringify(file)}]`;
    // Open ancestor folders through their actual tree controls when necessary.
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0,i).join('/');
      const collapsed = await this.dom(`const e=document.querySelector('[role="treeitem"][data-path='+CSS.escape(${JSON.stringify(folder)})+']');return e?.getAttribute('aria-expanded')==='false';`);
      if (collapsed) await this.click(`[role="treeitem"][data-path=${JSON.stringify(folder)}]`);
    }
    await this.click(selector);
    const breadcrumb = file.replace(/\.(?:md|base)$/i, '').replaceAll('/', ' / ');
    await this.wait(`return document.querySelector('.pane.is-active .breadcrumbs')?.textContent===${JSON.stringify(breadcrumb)};`, 'Requested file is visibly mounted');
  }
  async command(label) {
    await this.click('.ribbon [data-hotkey-command="command-palette"]');
    await this.type('.command-modal .command-input',label);
    await this.wait(`return [...document.querySelectorAll('.command-modal .suggestion')].filter(e=>e.getClientRects().length&&e.textContent.includes(${JSON.stringify(label)})).length===1;`, 'Unique command '+label);
    await this.key('Enter');
  }
  async idle() {
    await this.wait(`const e=document.querySelector('.pane.is-active .bases-session-content');return e&&e.getAttribute('aria-busy')!=='true'&&!document.querySelector('.pane.is-active [data-base-editing="pending"]');`, 'Bases idle',45000);
    await delay(80);
  }
  cell(file, property) { return `[role="gridcell"][data-path=${JSON.stringify(file)}][data-property=${JSON.stringify(property)}]`; }
  async selectCell(file,property) {
    await this.click(this.cell(file,property));await this.key('Escape');
    await this.wait(`const e=document.activeElement;return e?.getAttribute('role')==='gridcell'&&e.dataset.path===${JSON.stringify(file)}&&e.dataset.property===${JSON.stringify(property)};`,'Real cell focus after cancelling editor');
  }
  async edit(file, property, text) {
    const cell = this.cell(file,property); await this.click(cell,{count:2});
    await this.type(`${cell} input:not([type="checkbox"]),${cell} textarea`,text); await this.key('Enter'); await this.idle();
  }
}
