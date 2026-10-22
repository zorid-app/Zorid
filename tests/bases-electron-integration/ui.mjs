import assert from 'node:assert/strict';
import {delay, until} from '../tasks-electron-integration/cdp.mjs';

// Every positive mutation is routed through visible app controls. DOM evaluation
// locates/reads elements; it does not call workspace/controller/store APIs.
export class UI {
  constructor(cdp, actions) { this.cdp = cdp; this.actions = actions; }
  dom(body) { return this.cdp.evaluate(`(()=>{${body}})()`); }
  async wait(body, label, timeout = 20000) {
    return until(async () => { const result = await this.dom(body); assert.ok(result, label); return result; }, timeout);
  }
  async point(selector, index = 0) {
    return this.wait(`const e=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.getClientRects().length&&!e.closest('[hidden]'))[${index}];if(!e||e.disabled)return false;e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return r.width&&r.height&&e.contains(document.elementFromPoint(x,y))?{x,y}:false;`, `Visible unobscured ${selector}[${index}]`);
  }
  async click(selector, {index = 0, count = 1, modifiers = 0, button = 'left'} = {}) {
    const point = await this.point(selector, index);
    await this.cdp.call('Input.dispatchMouseEvent', {type:'mouseMoved', ...point});
    for (let clickCount = 1; clickCount <= count; clickCount++) {
      await this.cdp.call('Input.dispatchMouseEvent', {type:'mousePressed', button, clickCount, modifiers, ...point});
      await this.cdp.call('Input.dispatchMouseEvent', {type:'mouseReleased', button, clickCount, modifiers, ...point});
    }
    this.actions.push({action:'pointer', selector, index, count, modifiers, button, at:Date.now()});
  }
  async button(label, scope = 'body') {
    const selector = await this.wait(`const root=document.querySelector(${JSON.stringify(scope)});const all=root?[...root.querySelectorAll('button,[role="menuitem"]')]:[];const match=all.filter(e=>!e.disabled&&e.getClientRects().length&&(e.getAttribute('aria-label')===${JSON.stringify(label)}||e.textContent.trim()===${JSON.stringify(label)}));if(match.length!==1)return false;const e=match[0];return {index:[...document.querySelectorAll('button,[role="menuitem"]')].indexOf(e)};`, `Exactly one visible ${label} button in ${scope}`);
    // Index is from all nodes; address by exact DOM index to avoid text escaping.
    const point = await this.wait(`const e=document.querySelectorAll('button,[role="menuitem"]')[${selector.index}];if(!e||e.disabled)return false;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return e.contains(document.elementFromPoint(x,y))?{x,y}:false;`, 'Button hit target');
    await this.cdp.call('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...point});
    await this.cdp.call('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...point});
    this.actions.push({action:'button',label,scope,at:Date.now()});
  }
  async key(key, {code, modifiers = 0} = {}) {
    const codes = {Enter:['Enter',13],Escape:['Escape',27],Tab:['Tab',9],Backspace:['Backspace',8],Delete:['Delete',46],ArrowDown:['ArrowDown',40],ArrowUp:['ArrowUp',38],ArrowRight:['ArrowRight',39],ArrowLeft:['ArrowLeft',37],Home:['Home',36],End:['End',35]};
    const mapped = codes[key] ?? [code ?? `Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0)];
    for (const type of ['keyDown','keyUp']) await this.cdp.call('Input.dispatchKeyEvent',{type,key,code:code ?? mapped[0],windowsVirtualKeyCode:mapped[1],modifiers});
    this.actions.push({action:'key',key,modifiers,at:Date.now()});
  }
  async type(selector, text) {
    await this.click(selector); await this.key('a',{modifiers:4});
    await this.cdp.call('Input.insertText',{text});
    this.actions.push({action:'text',selector,text,at:Date.now()});
  }
  async select(selector, value) {
    const values = await this.wait(`const e=document.querySelector(${JSON.stringify(selector)});return e?.tagName==='SELECT'?[...e.options].map(o=>({value:o.value,label:o.textContent,disabled:o.disabled})):false;`, 'Native select options');
    const index = values.findIndex(o => o.value === value || o.label === value);
    assert.ok(index >= 0 && !values[index].disabled, `Selectable ${value}`);
    await this.click(selector); await this.key('Home');
    for (let i = 0; i < index; i++) await this.key('ArrowDown');
    await this.key('Enter');
    await this.wait(`return document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(values[index].value)};`, 'Native select accepted keyboard input');
  }
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
  async edit(file, property, text) {
    const cell = this.cell(file,property); await this.click(cell,{count:2});
    await this.type(`${cell} input:not([type="checkbox"]),${cell} textarea`,text); await this.key('Enter'); await this.idle();
  }
}
