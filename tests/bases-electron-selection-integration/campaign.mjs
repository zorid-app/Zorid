import assert from 'node:assert/strict';
import {MOD} from '../bases-electron-integration/ui.mjs';
import {fixtureFiles,file,base,properties,sources,phases,prefix,word,targetLine} from './fixtures.mjs';
import {selectionFrame,assertSelection,assertMapping} from './selection-oracle.mjs';
import {selectionTableReady} from './table-readiness.mjs';
export {fixtureFiles,vaultName} from './fixtures.mjs';
const note='.pane:has(input.note-title)',basePane='.pane:has(.bases-session)',editor=note+' .cm-content[contenteditable="true"]';
const noteTab=note+' .tab.is-active .tab-title',baseTab=basePane+' .tab.is-active .tab-title';
async function snapshot(c,label){
  const frame=await c.ui.wait(`const frame=(${selectionFrame.toString()})(document,${JSON.stringify(editor)});return frame.editorFocused&&frame.anchor&&frame.head?frame:false;`,label);
  c.evidence.actions.push({action:'passive-dom-editor-selection',label,frame,at:Date.now()});return frame;
}
async function noteReady(c){
  const live=note+' button[data-hotkey-name="Switch to Live Edit"]';
  if(await c.ui.dom(`return !!document.querySelector(${JSON.stringify(live)});`))await c.ui.click(live);
  await c.ui.wait(`return document.querySelector(${JSON.stringify(note+' input.note-title')})?.value==='Selection note'&&!!document.querySelector(${JSON.stringify(editor)});`,'Ordinary Live Edit note is mounted');
}
export async function journey(c){
  c.evidence.kind='actual-electron-bases-mapped-editor-selection';
  c.evidence.limitations.push('DOM-visible caret/range mapping across an ordinary Base property edit and existing-tab focus restoration only; no private EditorView state, DOM Selection assignment, mobile or OS keyboard parity. Restart verifies source/UI durability, not restoration of selection across sessions.');
  await c.launch('mapped-selection');await c.ui.openFile('Selection.base');
  await c.ui.wait(`return document.querySelector('.pane.is-active [role="grid"]')?.getAttribute('aria-rowcount')==='2';`,'One independently authored selection note');
  await c.ui.command('Split right');await c.ui.openFile(file);await noteReady(c);
  await c.ui.wait(`return document.querySelectorAll('.pane').length===2&&document.querySelectorAll(${JSON.stringify(note)}).length===1&&document.querySelectorAll(${JSON.stringify(basePane)}).length===1;`,'One Base pane and one ordinary editor');
  // The only body click is initial setup, before either mapping capture. Actual
  // keyboard navigation establishes the fixture word without assigning a range.
  await c.ui.click(editor);await c.ui.key('ArrowDown',{modifiers:MOD.meta});await c.ui.key('ArrowUp');await c.ui.key('ArrowLeft',{modifiers:MOD.meta});
  for(const character of [...prefix]){void character;await c.ui.key('ArrowRight');}
  for(const phase of phases){
    if(!phase.collapsed)for(const character of word){void character;await c.ui.key('ArrowRight',{modifiers:MOD.shift});}
    const before=await snapshot(c,phase.name+'-before');assertSelection(before,phase);
    const sourceBefore=await c.read(file);assert.equal(sourceBefore,phase.before);
    const cell=basePane+' '+c.ui.cell(file,'note.score');
    const ready=await c.ui.wait(`return (${selectionTableReady.toString()})(document,${JSON.stringify(cell)});`,'Existing property table is settled and current');
    c.evidence.actions.push({action:'selection-property-table-precondition',phase:phase.name,ready,at:Date.now()});
    await c.ui.click(cell,{count:2});
    await c.ui.type(cell+' input:not([type="checkbox"])',phase.score);await c.ui.key('Enter');
    const sourceAfter=await c.saved(file,source=>assert.equal(source,phase.after),'exact-property-source-'+phase.name);
    // Existing active-tab selection focuses editor.focus() through the normal
    // workspace route. Clicking body text here would reset the very caret/range.
    await c.ui.click(noteTab);const after=await snapshot(c,phase.name+'-after-tab-focus');
    const mapping=assertMapping(before,after,phase,sourceBefore,sourceAfter);
    c.evidence.checks.push({name:'mapped-body-selection-'+phase.name,before,after,mapping});await c.screenshot(phase.name);
    assert.equal(await c.read('Selection.base'),base);assert.equal(await c.read('Properties.yaml'),properties);
  }
  await c.quit('mapped-selection-normal-quit');
  await c.launch('mapped-selection-fresh-process');
  await c.saved(file,source=>assert.equal(source,sources.final),'mapped-selection-final-source-after-restart');
  await c.saved('Selection.base',source=>assert.equal(source,base),'mapped-selection-base-after-restart');
  await c.saved('Properties.yaml',source=>assert.equal(source,properties),'mapped-selection-registry-after-restart');
  await c.ui.wait(`return !!document.querySelector(${JSON.stringify(baseTab)})&&!!document.querySelector(${JSON.stringify(noteTab)});`,'Normal split tabs restored');
  await c.ui.click(baseTab);await c.ui.wait(`return document.querySelector(${JSON.stringify(basePane+' '+c.ui.cell(file,'note.score'))})?.textContent.trim()==='2';`,'Fresh Base reads the durable score');
  await c.ui.click(noteTab);await noteReady(c);await c.ui.wait(`return [...document.querySelectorAll(${JSON.stringify(editor+' .cm-line')})].some(e=>e.textContent===${JSON.stringify(targetLine)});`,'Fresh ordinary note retains exact body line');
  await c.screenshot('mapped-selection-fresh-process');await c.quit('mapped-selection-restart-normal-quit');
}
