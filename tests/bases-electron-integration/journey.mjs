import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {until,delay} from '../tasks-electron-integration/cdp.mjs';
import {parseCSV} from './csv.mjs';

const active='.pane.is-active .bases-session';
const dialog=name=>`[role="dialog"][aria-label=${JSON.stringify(name)}]`;
const input=(name,scope='body')=>`${scope} input[aria-label=${JSON.stringify(name)}],${scope} textarea[aria-label=${JSON.stringify(name)}],${scope} [contenteditable="true"][aria-label=${JSON.stringify(name)}]`;
async function choose(c,name){await c.ui.button('Views',active);await c.ui.button(`Open view ${name}`,dialog('Views'));await c.ui.idle();}
async function apply(c,name){
  if(name==='New item settings')await c.ui.button('Apply',dialog(name));
  else for(let i=0;i<3&&await c.ui.dom(`return !!document.querySelector(${JSON.stringify(dialog(name))});`);i++){
    await c.ui.key('Escape'); // First Escape may close expression completion.
    await delay(300);
  }
  await c.ui.wait(`return !document.querySelector(${JSON.stringify(dialog(name))});`,'Applied '+name);await c.ui.idle();
}
async function config(c,name){await c.ui.button('Views',active);await c.ui.button(`Configure view ${name}`,dialog('Views'));}
async function viewAction(c,label){await c.ui.button('View actions',dialog('View options'));await c.ui.button(label);await c.ui.idle();}
async function propertySettings(c,property){await c.ui.button('Properties',active);await c.ui.button(`Configure property ${property}`,dialog('Properties'));await c.ui.button('Property type',dialog('Property'));await c.ui.wait(`return !!document.querySelector(${JSON.stringify(dialog('Property settings'))});`,'Shared property settings');}
async function savePropertySettings(c){await c.ui.button('Apply',dialog('Property settings'));await c.ui.wait(`return !document.querySelector(${JSON.stringify(dialog('Property settings'))});`,'Property definition saved');await c.ui.idle();}
async function formulaEditor(c,name){await c.ui.button('Properties',active);await c.ui.button(`Configure property ${name}`,dialog('Properties'));await c.ui.button('Edit formula',dialog('Property'));}
async function summary(c,name){await c.ui.click(`${active} .zorid-bases-table-footer [data-summary-property="note.rating"]`);await c.ui.click(`.zorid-bases-summary-picker [role="option"][data-summary-id=${JSON.stringify(name)}]`);await c.ui.idle();}
const newPopover='.bases-new-item-popover[role="dialog"][aria-label="New item"]';
async function closeNew(c){
  for(let i=0;i<3&&await c.ui.dom(`return !!document.querySelector(${JSON.stringify(newPopover)});`);i++){await c.ui.key('Escape');await delay(300);}
  await c.ui.wait(`return !document.querySelector(${JSON.stringify(newPopover)});`,'New item popover closed after save');await c.ui.idle();
}
async function fmSaved(c,file,check,name){return c.saved(file,source=>check(c.frontmatter(source),source),name);}
async function visibleCell(c,file,property,expected){return c.ui.wait(`const e=document.querySelector(${JSON.stringify(c.ui.cell(file,property))});return e&&e.textContent.includes(${JSON.stringify(expected)});`,`${file} ${property} = ${expected}`);}
async function noAlerts(c){await c.ui.wait(`return ![...document.querySelectorAll('.pane.is-active [role="alert"]')].some(e=>e.getClientRects().length&&e.textContent.trim());`,'No visible failure after positive flow');}
async function confirmDelete(c,action){
  let listener,timer;
  const confirmed=new Promise((resolve,reject)=>{
    timer=setTimeout(()=>reject(Error('Expected real Delete confirmation not observed')),10000);
    listener=event=>{const value=JSON.parse(event.data);if(value.method!=='Page.javascriptDialogOpening')return;
      try{assert.equal(value.params.type,'confirm');assert.match(value.params.message,/Move 1 file to trash/);clearTimeout(timer);c.evidence.actions.push({action:'actual-confirm-dialog',...value.params,accepted:true});c.cdp.call('Page.handleJavaScriptDialog',{accept:true}).then(resolve,reject);}catch(error){reject(error);}
    };c.cdp.ws.addEventListener('message',listener);
  });confirmed.catch(()=>{});
  try{await action();await confirmed;}finally{clearTimeout(timer);c.cdp.ws.removeEventListener('message',listener);}
}

export async function journey(c){
  await c.launch('author-configure-and-edit');
  await c.ui.openFile('Library.base');await c.ui.idle();
  await c.ui.wait(`return document.querySelector('${active} [role="grid"]')?.getAttribute('aria-rowcount')==='74';`,'72 books plus heterogeneous row; filter excludes project/template/author files');
  await visibleCell(c,'Book 001.md','note.rating','1');
  await visibleCell(c,'Book 001.md','formula.doubleRating','2');
  await c.screenshot('01-library-table-initial');

  // Create through the normal app command; the preseeded Base is not creation proof.
  const basesBefore=new Set((await fs.readdir(c.vault)).filter(name=>name.endsWith('.base')));
  await c.ui.command('Bases: Create new base');await c.ui.idle();
  const created=await until(async()=>{const names=(await fs.readdir(c.vault)).filter(name=>name.endsWith('.base')&&!basesBefore.has(name));assert.equal(names.length,1,'One ordinary Base created');return names[0];},30000);
  assert.notEqual(created,'Library.base');
  await c.saved(created,source=>assert.ok(c.yaml.parse(source).views?.length>=1),'ordinary-create-base-writes-real-config');
  await c.ui.openFile('Library.base');await c.ui.idle();

  // Rename, add, duplicate, reorder, default and delete through actual view controls.
  await config(c,'Library');await c.ui.type(input('View name'),'Books table');await apply(c,'View options');
  await c.saved('Library.base',source=>{const b=c.yaml.parse(source);assert.equal(b.views[0].name,'Books table');assert.equal(b.fixtureSentinel,'keep-me');assert.match(source,/# Heavy-user fixture/);},'view-rename-preserves-unknown-fields-comments');
  await c.ui.button('Views',active);await c.ui.button('Add view',dialog('Views'));
  await c.ui.type(input('View name'),'Temporary view');await c.ui.key('Enter');
  await c.ui.wait(`return !!document.querySelector(${JSON.stringify(dialog('View options'))});`,'New view continues into Configure view');
  await c.ui.select(`${dialog('View options')} select[aria-label="Layout"]`,'List');await apply(c,'View options');
  await config(c,'Temporary view');await viewAction(c,'Duplicate view');
  const duplicate=await c.saved('Library.base',source=>assert.equal(c.yaml.parse(source).views.length,6),'add-and-duplicate-view');
  const copied=c.yaml.parse(duplicate).views.find(v=>v.name!=='Temporary view'&&v.name.startsWith('Temporary view')).name;
  await config(c,copied);await viewAction(c,'Move view earlier');
  await config(c,copied);await viewAction(c,'Set as default view');
  await c.saved('Library.base',source=>assert.equal(c.yaml.parse(source).views[0].name,copied),'default-view-is-first-saved-view');
  for(const name of[copied,'Temporary view']){await config(c,name);await viewAction(c,'Delete view');}
  await choose(c,'Books table');

  // View-level advanced filter composes with the fixture's Base-wide membership.
  await c.ui.button('Filter',active);await c.ui.button('Add expression',dialog('Filter'));
  await c.ui.type(input('Filter expression',dialog('Filter')),'note.rating >= 4');await apply(c,'Filter');
  await c.ui.wait(`return document.querySelector('${active} [role="grid"]')?.getAttribute('aria-rowcount')==='29';`,'28 high-rating rows');
  await c.screenshot('02-view-filter');
  await c.ui.button('Filter',active);await c.ui.button('Remove filter',dialog('Filter'));await apply(c,'Filter');

  // Formula UI edits the same portable Base configuration. Adding a formula does
  // not change the notes; choosing its column makes its derived result visible.
  await c.ui.button('Properties',active);await c.ui.button('Add formula',dialog('Properties'));
  await c.ui.type(input('Formula name',dialog('Formula')),'tripleRating');await c.ui.key('Enter');
  await c.saved('Library.base',source=>assert.ok(Object.hasOwn(c.yaml.parse(source).formulas,'tripleRating')),'new-formula-name-autosaved');
  await c.ui.type(input('Formula expression',dialog('Formula')),'note.rating * 3');await apply(c,'Formula');
  await visibleCell(c,'Book 001.md','formula.tripleRating','3');
  await formulaEditor(c,'tripleRating');await c.ui.type(input('Formula name',dialog('Formula')),'ratingTimesThree');await apply(c,'Formula');
  await c.saved('Library.base',source=>{const formulas=c.yaml.parse(source).formulas;assert.equal(formulas.ratingTimesThree,'note.rating * 3');assert.equal(formulas.tripleRating,undefined);},'formula-create-and-rename');
  await formulaEditor(c,'ratingTimesThree');await c.ui.button('Remove formula',dialog('Formula'));await c.ui.idle();
  await c.saved('Library.base',source=>assert.equal(c.yaml.parse(source).formulas.ratingTimesThree,undefined),'formula-remove');

  await c.ui.button('Search',active);await c.ui.type(`${active} input[aria-label="Search base"]`,'Book 001');await c.ui.idle();
  await c.ui.wait(`return document.querySelector('${active} [role="grid"]')?.getAttribute('aria-rowcount')==='2';`,'Search evaluated visible values returns exact file');await c.ui.key('Escape');await c.ui.idle();
  await c.ui.button('Results',active);await c.ui.type(input('Limit',dialog('Results')),'10');await apply(c,'Results');
  await c.ui.wait(`return document.querySelector('${active} [role="grid"]')?.getAttribute('aria-rowcount')==='11';`,'Saved result limit applied');
  await summary(c,'Sum');
  await c.ui.wait(`return document.querySelector('${active} .zorid-bases-table-footer [data-summary-property="note.rating"]')?.textContent==='30';`,'Summary uses final 10 returned rows');
  await c.ui.button('Results',active);await c.ui.button('Show all results',dialog('Results'));await c.ui.idle();
  await c.ui.wait(`return document.querySelector('${active} .zorid-bases-table-footer [data-summary-property="note.rating"]')?.textContent==='213';`,'Summary includes all 72 ratings, not viewport rows');
  await summary(c,'RatingTotal');
  await c.ui.wait(`return document.querySelector('${active} .zorid-bases-table-footer [data-summary-property="note.rating"]')?.textContent==='213';`,'Custom Rust summary agrees with independent sum');
  await c.screenshot('02b-search-limit-and-summaries');

  const downloadDirectory=await c.prepareDownloads();await c.ui.button('Results',active);await c.ui.button('Export CSV',dialog('Results'));
  const csvSource=await until(async()=>{const names=(await fs.readdir(downloadDirectory)).filter(n=>n.endsWith('.csv'));assert.equal(names.length,1,'One export from actual Results action');return fs.readFile(path.join(downloadDirectory,names[0]),'utf8');},30000);
  const exported=parseCSV(csvSource),headers=exported.shift(),ratingColumn=headers.indexOf('Rating');
  assert.ok(ratingColumn>=0);assert.equal(exported.length,73,'Export includes entire result, not mounted viewport');assert.equal(exported.filter(row=>/^Book \d{3}$/.test(row[0])).length,72);assert.equal(exported.filter(row=>row[0]==='Missing properties').length,1);assert.equal(exported.reduce((sum,row)=>sum+Number(row[ratingColumn]||0),0),213);
  c.evidence.checks.push({name:'actual-results-csv-export-full-result',headers,rowCount:exported.length,ratingSum:213,source:csvSource});

  await c.ui.click(`${active} .zorid-bases-table-footer [data-summary-property="note.rating"]`);await c.ui.type('.zorid-bases-summary-picker input[aria-label="Find or create summary"]','CustomTotal');await c.ui.button('Add summary: CustomTotal','.zorid-bases-summary-picker');
  await c.ui.type(input('Summary name',dialog('Add summary')),'CustomTotal');await c.ui.type(input('Summary expression',dialog('Add summary')),'values.sum()');await c.ui.button('Apply',dialog('Add summary'));await c.ui.idle();
  await c.saved('Library.base',source=>assert.equal(c.yaml.parse(source).summaries.CustomTotal,'values.sum()'),'custom-summary-definition-created-through-ui');
  await c.ui.click(`${active} .zorid-bases-table-footer [data-summary-property="note.rating"]`);await c.ui.button('Edit CustomTotal','.zorid-bases-summary-picker');await c.ui.type(input('Summary expression',dialog('Edit summary')),'values.sum() + 1');await c.ui.button('Apply',dialog('Edit summary'));await c.ui.idle();
  await c.ui.wait(`return document.querySelector('${active} .zorid-bases-table-footer [data-summary-property="note.rating"]')?.textContent==='214';`,'Edited custom summary evaluated by Rust');
  await c.ui.button('Group',active);await c.ui.select(`${dialog('Group')} select[aria-label="Group property"]`,'note.status');await apply(c,'Group');
  const groupSummaryValues=new Set();
  for(let i=0;i<10;i++){
    const values=await c.ui.dom(`return [...document.querySelectorAll('${active} .zorid-bases-table-body .zorid-bases-table-summary [data-property="note.rating"]')].map(e=>Number(e.textContent));`);for(const value of values)groupSummaryValues.add(value);
    await c.ui.scroll(`${active} [role="grid"]`,500);
  }
  assert.deepEqual([...groupSummaryValues].sort((a,b)=>a-b),[1,71,72,73],'Each of four groups has its own Rust summary, independent of viewport');c.evidence.checks.push({name:'group-custom-summary-scope',values:[...groupSummaryValues].sort((a,b)=>a-b),overall:214});await c.screenshot('02c-group-summaries');
  await c.ui.button('Group',active);await c.ui.button('Remove grouping',dialog('Group'));await apply(c,'Group');await c.ui.scroll(`${active} [role="grid"]`,-10000);

  // Reference resize behavior through a real separator and keyboard commands.
  const resize=`${active} [role="columnheader"][title="note.rating"] .zorid-bases-table-resize`;
  await c.ui.click(resize);await c.ui.dom(`document.querySelector(${JSON.stringify(resize)}).focus();`);await c.ui.key('ArrowRight');await c.ui.idle();
  await c.saved('Library.base',source=>assert.equal(c.yaml.parse(source).views.find(v=>v.name==='Books table').columnSize['note.rating'],190),'column-keyboard-resize-saved');
  await c.ui.click(resize);await c.ui.dom(`document.querySelector(${JSON.stringify(resize)}).focus();`);await c.ui.key('Home');await c.ui.idle();
  await c.saved('Library.base',source=>assert.equal(c.yaml.parse(source).views.find(v=>v.name==='Books table').columnSize?.['note.rating'],undefined),'column-reset-width-saved');

  // Field edits must preserve body/frontmatter not touched by the command.
  const firstBefore=await c.read('Book 001.md');
  await c.ui.edit('Book 001.md','note.rating','5');
  await fmSaved(c,'Book 001.md',(p,source)=>{assert.equal(p.rating,5);assert.equal(p.untouched,'preserve 0');assert.equal(source.slice(source.indexOf('\n# ')),firstBefore.slice(firstBefore.indexOf('\n# ')));},'table-numeric-edit-preserves-body-and-unrelated-properties');
  await visibleCell(c,'Book 001.md','formula.doubleRating','10');
  await c.ui.click(`${c.ui.cell('Book 001.md','note.done')} input[type="checkbox"]`);
  await fmSaved(c,'Book 001.md',p=>assert.equal(p.done,true),'checkbox-edit');

  // Rich pickers are shared production widgets. Multiple selections commit on
  // Enter with no search, rather than writing a comma-delimited string.
  await c.ui.click(`${c.ui.cell('Book 001.md','note.topics')}.bases-metadata-value`);
  await c.ui.type('.bases-property-popover input[role="combobox"]','Writing');
  await c.ui.key('ArrowDown');await c.ui.key('Enter');
  await c.ui.type('.bases-property-popover input[role="combobox"]','');await c.ui.key('Enter');await c.ui.idle();
  await fmSaved(c,'Book 001.md',p=>assert.deepEqual(p.topics,['Design','Writing']),'multiselect-stores-yaml-list');
  await c.ui.click(`${c.ui.cell('Book 001.md','note.status')}.bases-metadata-value`);
  await c.ui.type('.bases-property-popover input[role="combobox"]','Reading');await c.ui.key('ArrowDown');await c.ui.key('Enter');await c.ui.idle();
  await fmSaved(c,'Book 001.md',p=>assert.equal(p.status,'Reading'),'status-picker');
  await c.ui.click(`${c.ui.cell('Book 001.md','note.author')}.bases-metadata-value`);
  await c.ui.type('.bases-property-popover input[role="combobox"]','Author Grace');await c.ui.key('ArrowDown');await c.ui.key('Enter');await c.ui.idle();
  await fmSaved(c,'Book 001.md',p=>assert.equal(p.author,'[[Author Grace]]'),'relation-picker-stores-readable-link');

  for(const[property,type,initial]of[['finished','date','2026-10-01'],['appointment','datetime-local','2026-10-01T09:00']]){
    await c.ui.click(c.ui.cell('Book 001.md','note.'+property));const selector=`${c.ui.cell('Book 001.md','note.'+property)} input[type=${JSON.stringify(type)}]`;
    await c.ui.click(selector);await c.ui.key('ArrowUp');
    const value=await c.ui.wait(`const e=document.querySelector(${JSON.stringify(selector)});return e?.validity.valid&&e.value&&e.value!==${JSON.stringify(initial)}?e.value:false;`,'Native date segment keyboard change '+property);
    await c.ui.key('Enter');await c.ui.idle();await fmSaved(c,'Book 001.md',p=>assert.equal(p[property],value),'native-date-control-persists-'+property);
  }
  await c.ui.click(c.ui.cell('Book 001.md','note.priority'));await c.ui.type('.bases-property-popover input[role="combobox"]','High');await c.ui.key('ArrowDown');await c.ui.key('Enter');await c.ui.idle();await fmSaved(c,'Book 001.md',p=>assert.equal(p.priority,'High'),'select-picker-persists-single-value');
  await c.ui.click(c.ui.cell('Book 001.md','note.keywords'));await c.ui.type(`${c.ui.cell('Book 001.md','note.keywords')} input[aria-label="keywords"]`,'beta');await c.ui.key('Enter');await c.ui.idle();await fmSaved(c,'Book 001.md',p=>assert.deepEqual(p.keywords,['alpha','beta']),'plain-list-chip-add-persists-yaml-list');await c.ui.key('Escape');
  await c.screenshot('03-rich-property-edits');

  // Configure rich property options through the shared settings extension. Labels
  // and color/order metadata live in Properties.yaml; readable stored values stay
  // unchanged, including when a selected option is removed from the definition.
  const beforeOptionSettings=await c.read('Book 001.md');
  await propertySettings(c,'topics');await c.ui.button('Add option',dialog('Property settings'));
  const optionRow=n=>`${dialog('Property settings')} .bases-property-option-row:nth-child(${n})`;
  await c.ui.type(input('Stored option value',optionRow(4)),'Research');await c.ui.type(input('Option label',optionRow(4)),'Research');
  await c.ui.select(`${optionRow(4)} select[aria-label="Option color"]`,'purple');await c.ui.button('Move option up',optionRow(4));
  await c.ui.type(input('Option label',optionRow(1)),'Rust language');await savePropertySettings(c);
  await c.saved('Properties.yaml',source=>{const p=c.yaml.parse(source).properties;assert.deepEqual(p.topics.options.map(o=>o.value),['Rust','Design','Research','Writing']);assert.equal(p.topics.options[0].label,'Rust language');assert.equal(p.topics.options[2].color,'purple');assert.equal(p.author.type,'relation');},'option-create-reorder-color-and-label-rename');
  assert.equal(await c.read('Book 001.md'),beforeOptionSettings,'Definition labels never rewrite note values');
  await propertySettings(c,'topics');await c.ui.button('Remove option',optionRow(2));await savePropertySettings(c);
  assert.equal(await c.read('Book 001.md'),beforeOptionSettings,'Removing option preserves selected Markdown values');
  await c.ui.wait(`return !!document.querySelector(${JSON.stringify(c.ui.cell('Book 001.md','note.topics')+' .is-unknown')});`,'Unrecognized selected option visibly preserved');await c.screenshot('03a-unknown-option-preserved');
  await propertySettings(c,'topics');await c.ui.button('Add option',dialog('Property settings'));await c.ui.type(input('Stored option value',optionRow(4)),'Design');await c.ui.type(input('Option label',optionRow(4)),'Design');await c.ui.select(`${optionRow(4)} select[aria-label="Option color"]`,'blue');await savePropertySettings(c);

  // Missing fields are empty presentation until explicitly edited; merely opening
  // the Base must not add the entire visible schema to heterogeneous notes.
  const missingBefore=await c.read('Missing properties.md');assert.equal(c.frontmatter(missingBefore).rating,undefined);
  await c.ui.button('Search',active);await c.ui.type(`${active} input[aria-label="Search base"]`,'Missing properties');await c.ui.idle();
  await c.ui.wait(`const e=document.querySelector(${JSON.stringify(c.ui.cell('Missing properties.md','note.rating'))});return e&&e.textContent.trim()==='';`,'Missing property shown as empty');
  assert.equal(await c.read('Missing properties.md'),missingBefore,'Showing empty column does not write missing field');
  await c.ui.edit('Missing properties.md','note.rating','4');
  await fmSaved(c,'Missing properties.md',(p,source)=>{assert.equal(p.rating,4);assert.equal(p.status,undefined);assert.equal(source.slice(source.indexOf('\nA heterogeneous')),missingBefore.slice(missingBefore.indexOf('\nA heterogeneous')));},'edit-empty-cell-adds-only-selected-property');
  await c.ui.click(`${active} input[aria-label="Search base"]`);await c.ui.key('Escape');await c.ui.idle();

  // Native table keyboard selection and production TSV handler. Clipboard scope
  // is explicitly synthetic and does not read or replace the system clipboard.
  await c.ui.selectCell('Book 001.md','note.rating');
  const paste='4\tFinished\n2\tReading';
  const rawCells=[[{type:'note',data:4},{type:'note',data:'Finished'}],[{type:'note',data:2},{type:'note',data:'Reading'}]];
  const pasted=await c.ui.dom(`const target=document.activeElement;if(target?.getAttribute('role')!=='gridcell')throw Error('Focused real cell required');const data=new DataTransfer();data.setData('text/plain',${JSON.stringify(paste)});data.setData('obsidian/bases-cells',${JSON.stringify(JSON.stringify(rawCells))});const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data});target.dispatchEvent(event);return event.defaultPrevented;`);
  assert.equal(pasted,true,'Actual production paste handler accepted typed Bases clipboard');c.evidence.actions.push({action:'synthetic-clipboard-event',mime:['text/plain','obsidian/bases-cells'],text:paste,rawCells});
  await fmSaved(c,'Book 001.md',p=>{assert.equal(p.rating,4);assert.equal(p.status,'Finished');},'rectangular-paste-row-one');
  await fmSaved(c,'Book 002.md',p=>{assert.equal(p.rating,2);assert.equal(p.status,'Reading');},'rectangular-paste-row-two');
  await c.ui.key('z',{modifiers:4});await c.ui.idle();
  await fmSaved(c,'Book 001.md',p=>{assert.equal(p.rating,5);assert.equal(p.status,'Reading');},'single-command-undo-restores-rectangular-edit');
  await c.ui.key('z',{modifiers:5});await c.ui.idle();
  await fmSaved(c,'Book 001.md',p=>{assert.equal(p.rating,4);assert.equal(p.status,'Finished');},'redo-restores-rectangular-edit');
  await c.ui.selectCell('Book 001.md','note.rating');await c.ui.key('ArrowRight',{modifiers:1});await c.ui.key('ArrowDown',{modifiers:1});
  await c.ui.key('Delete');await c.ui.idle();
  for(const file of['Book 001.md','Book 002.md'])await fmSaved(c,file,p=>{assert.equal(p.rating??null,null);assert.equal(p.status??null,null);},'range-clear-'+file);
  await c.ui.key('z',{modifiers:4});await c.ui.idle();
  await fmSaved(c,'Book 001.md',p=>{assert.equal(p.rating,4);assert.equal(p.status,'Finished');},'undo-range-clear-restores-first-row');
  await fmSaved(c,'Book 002.md',p=>{assert.equal(p.rating,2);assert.equal(p.status,'Reading');},'undo-range-clear-restores-second-row');

  await c.ui.selectCell('Book 001.md','note.rating');
  const plainAccepted=await c.ui.dom(`const data=new DataTransfer();data.setData('text/plain','4');const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data});document.activeElement.dispatchEvent(event);return event.defaultPrevented;`);
  assert.equal(plainAccepted,true);c.evidence.actions.push({action:'synthetic-clipboard-event',mime:['text/plain'],text:'4'});
  await fmSaved(c,'Book 001.md',p=>assert.equal(p.rating,'4'),'external-plain-paste-preserves-string-type');
  await c.ui.wait(`return document.querySelector(${JSON.stringify(c.ui.cell('Book 001.md','note.rating'))})?.classList.contains('mod-error');`,'Incompatible pasted number visibly diagnosed');
  await c.ui.key('z',{modifiers:4});await c.ui.idle();await fmSaved(c,'Book 001.md',p=>assert.equal(p.rating,4),'undo-plain-paste-restores-number-type');

  await c.ui.drag(`${active} [role="columnheader"][title="note.status"]`,`${active} [role="columnheader"][title="note.rating"]`);await c.ui.idle();
  await c.saved('Library.base',source=>{const order=c.yaml.parse(source).views.find(v=>v.name==='Books table').order;assert.ok(order.indexOf('note.status')<order.indexOf('note.rating'));},'header-drag-runs-production-reorder');
  await c.ui.drag(`${active} [role="columnheader"][title="note.rating"]`,`${active} [role="columnheader"][title="note.status"]`);await c.ui.idle();
  await c.saved('Library.base',source=>{const order=c.yaml.parse(source).views.find(v=>v.name==='Books table').order;assert.ok(order.indexOf('note.rating')<order.indexOf('note.status'));},'header-drag-restores-property-order');

  // A second Base observes the same relation edits through Rust-derived reverse
  // relations and rollups. The oracle is authored from all durable book files,
  // independently of renderer-mounted rows or production query implementations.
  const authorBefore=await c.read('Author Grace.md');
  const ratings=[];
  for(let n=1;n<=72;n++){
    const file=`Book ${String(n).padStart(3,'0')}.md`,properties=c.frontmatter(await c.read(file));
    if(properties.author==='[[Author Grace]]')ratings.push(properties.rating);
  }
  assert.equal(ratings.length,37);
  await c.ui.openFile('Authors.base');await c.ui.idle();
  await visibleCell(c,'Author Grace.md','note.bookCount','37');
  await visibleCell(c,'Author Ada.md','note.bookCount','35');
  await c.ui.wait(`const e=document.querySelector(${JSON.stringify(c.ui.cell('Author Grace.md','note.averageRating'))});return e&&Math.abs(Number(e.textContent)-${ratings.reduce((a,b)=>a+b,0)/ratings.length})<0.000001;`,'Average rollup reflects all 37 related files');
  await visibleCell(c,'Author Grace.md','note.books','Book 001');
  assert.equal(await c.read('Author Grace.md'),authorBefore,'Derived reverse/rollup data never written into author note');
  c.evidence.checks.push({name:'reverse-relations-and-rollups',author:'Author Grace.md',count:ratings.length,average:ratings.reduce((a,b)=>a+b,0)/ratings.length,independentRatings:ratings});
  await c.screenshot('03b-reverse-relations-rollups');

  await c.ui.openFile('Author Grace.md');await c.ui.type('.pane.is-active .note-title','Author Grace Renamed');await c.ui.key('Enter');
  await c.saved('Author Grace Renamed.md',source=>assert.equal(source,authorBefore),'relation-target-normal-title-rename');
  await until(async()=>assert.ok(!(await fs.readdir(c.vault)).includes('Author Grace.md')),30000);
  await fmSaved(c,'Book 001.md',p=>assert.equal(p.author,'[[Author Grace Renamed]]'),'relation-readable-link-follows-target-rename');
  await c.ui.openFile('Authors.base');await c.ui.idle();await visibleCell(c,'Author Grace Renamed.md','note.bookCount','37');
  const referringBeforeDelete=await c.read('Book 001.md');
  await c.ui.click(c.ui.cell('Author Grace Renamed.md','note.bookCount'),{button:'right'});
  await confirmDelete(c,()=>c.ui.button('Delete','.zorid-bases-table-menu'));
  await until(async()=>assert.ok(!(await fs.readdir(c.vault)).includes('Author Grace Renamed.md')),30000);
  assert.equal(await c.read('Book 001.md'),referringBeforeDelete,'Deleting relation target never cascades or removes readable link');
  await c.ui.openFile('Library.base');await c.ui.idle();await choose(c,'Books table');
  await c.ui.wait(`return !!document.querySelector(${JSON.stringify(c.ui.cell('Book 001.md','note.author')+' .is-unresolved')});`,'Deleted relation target shown as unresolved');
  await c.screenshot('03d-deleted-target-unresolved-link');

  await c.ui.openFile('Rich.base');await c.ui.idle();
  await c.ui.wait(`const link=document.querySelector(${JSON.stringify(c.ui.cell('Book 001.md','formula.iconLink'))}+' a.internal-link .bases-rich-icon');const image=document.querySelector(${JSON.stringify(c.ui.cell('Book 001.md','formula.coverImage'))}+' img.bases-rich-image');const html=document.querySelector(${JSON.stringify(c.ui.cell('Book 001.md','formula.safeHTML'))});return !!link&&image?.complete&&image.naturalWidth===96&&image.naturalHeight===64&&html?.querySelector('b')?.textContent==='Ready'&&!html.querySelector('script')&&globalThis.__basesUnsafe===undefined;`,'Rich link/icon/image/sanitized HTML cross real Rust transport and renderer',45000);await c.screenshot('03h-rich-formula-rendering');
  await c.ui.click(`${c.ui.cell('Book 001.md','formula.iconLink')} a.internal-link`);await c.ui.wait(`return document.querySelector('.pane.is-active .note-title')?.value==='Book 001';`,'Rich formula link opens original note');
  await c.ui.openFile('Library.base');await c.ui.idle();await choose(c,'Books table');

  // Real missing-template failure: no blank fallback or duplicate. Repair the
  // configuration through its ordinary UI and explicitly retry New.
  await config(c,'Books table');await viewAction(c,'New item settings');
  await c.ui.type(input('New item template',dialog('New item settings')),'Templates/Missing.md');await apply(c,'New item settings');
  await c.ui.button('New',active);
  await c.ui.wait(`return [...document.querySelectorAll('.pane.is-active [role="status"],.pane.is-active [role="alert"]')].some(e=>/template|not found|missing/i.test(e.textContent));`,'Missing template explained');
  assert.deepEqual(await fs.readdir(path.join(c.vault,'Created')),[],'No silent blank-file fallback');await c.screenshot('03c-missing-template-failure');
  await config(c,'Books table');await viewAction(c,'New item settings');await c.ui.type(input('New item template',dialog('New item settings')),'Templates/Book.md');await apply(c,'New item settings');

  // Full literal template bytes, safe collision, unchanged source template.
  const existing=new Set(await fs.readdir(path.join(c.vault,'Created')));
  await c.ui.button('New',active);
  const newFile=await until(async()=>{const names=(await fs.readdir(path.join(c.vault,'Created'))).filter(n=>!existing.has(n)&&n.endsWith('.md'));assert.equal(names.length,1);return 'Created/'+names[0];},30000);
  await c.ui.wait(`return !!document.querySelector(${JSON.stringify(newPopover)});`,'New opens reference-sized hover editor');
  await c.saved(newFile,source=>assert.equal(source,c.template),'new-copies-full-template-literally');
  assert.equal(await c.read('Templates/Book.md'),c.template,'Template source unchanged');
  await c.screenshot('03e-full-template-new-popover');
  await c.ui.type(`${newPopover} .inline-title[role="textbox"][aria-label="Note title"]`,'Created from template');await c.ui.key('Enter');
  const authoredFile='Created/Created from template.md',authoredBody=c.template+'\nPopup authored body marker 😀\n';
  await c.saved(authoredFile,source=>assert.equal(source,c.template),'new-popover-title-renames-real-note-without-replacing-template');
  await c.ui.type(`${newPopover} .cm-content[contenteditable="true"]`,authoredBody);
  await c.saved(authoredFile,source=>assert.equal(source,authoredBody),'new-popover-shared-editor-saves-complete-literal-body');await c.screenshot('03f-new-popover-body-edit');
  await closeNew(c);
  await c.ui.openFile(authoredFile);await c.ui.wait(`return document.querySelector('.pane.is-active .note-title')?.value==='Created from template'&&document.querySelector('.pane.is-active .cm-content')?.textContent.includes('Popup authored body marker');`,'Created note reopens in ordinary editor with saved body');
  await c.saved(authoredFile,source=>assert.equal(source,authoredBody),'new-popover-close-and-normal-note-reopen-preserve-exact-bytes');await c.screenshot('03g-new-note-normal-editor-reopened');
  await c.ui.openFile('Library.base');await c.ui.idle();
  const collisionFiles=[];
  for(let attempt=0;attempt<2;attempt++){
    const before=new Set(await fs.readdir(path.join(c.vault,'Created')));await c.ui.button('New',active);
    let file=await until(async()=>{const names=(await fs.readdir(path.join(c.vault,'Created'))).filter(n=>!before.has(n)&&n.endsWith('.md'));assert.equal(names.length,1);return 'Created/'+names[0];},30000);
    await c.saved(file,source=>assert.equal(source,c.template),'collision-safe-full-template-copy-'+attempt);await c.ui.wait(`return !!document.querySelector(${JSON.stringify(newPopover)});`,'Each New opens its own hover editor');
    if(attempt===1){
      const namesBeforeFailure=(await fs.readdir(path.join(c.vault,'Created'))).sort();
      await c.ui.type(`${newPopover} .inline-title`,'Created from template');await c.ui.key('Enter');
      await c.ui.wait(`const root=document.querySelector(${JSON.stringify(newPopover)});return root?.querySelector('.bases-new-item-error')?.hidden===false&&root.querySelector('.inline-title')?.textContent==='Created from template';`,'Conflicting title retains exact New item draft and failure');
      await c.ui.button('Retry',newPopover);await delay(150);assert.deepEqual((await fs.readdir(path.join(c.vault,'Created'))).sort(),namesBeforeFailure,'Retry of invalid rename neither duplicates nor overwrites notes');assert.equal(await c.read(authoredFile),authoredBody);await c.screenshot('03i-new-title-conflict-retained-retry');
      await c.ui.type(`${newPopover} .inline-title`,'Recovered popup note');await c.ui.button('Retry',newPopover);file='Created/Recovered popup note.md';await c.saved(file,source=>assert.equal(source,c.template),'corrected-new-item-title-retry-saves-same-note');
    }
    collisionFiles.push(file);await closeNew(c);
  }
  assert.notEqual(collisionFiles[0],collisionFiles[1]);assert.equal(await c.read(authoredFile),authoredBody,'Further New never overwrites edited prior note');assert.equal(await c.read('Templates/Book.md'),c.template);

  await config(c,'Books table');await viewAction(c,'New item settings');await c.ui.type(input('New item template',dialog('New item settings')),'');await apply(c,'New item settings');
  const beforeBlank=new Set(await fs.readdir(path.join(c.vault,'Created')));await c.ui.button('New',active);
  const blank=await until(async()=>{const files=(await fs.readdir(path.join(c.vault,'Created'))).filter(n=>!beforeBlank.has(n));assert.equal(files.length,1);return 'Created/'+files[0];},30000);
  await fmSaved(c,blank,(p,source)=>{assert.equal(p.type,'book','Safe filter equality inferred');assert.ok(!source.includes('Literal template body'));},'new-without-template-safe-filter-default');
  await c.ui.wait(`return !!document.querySelector(${JSON.stringify(newPopover)});`,'Blank New opens hover editor');await closeNew(c);
  await c.ui.openFile('Library.base');await c.ui.idle();await config(c,'Books table');await viewAction(c,'New item settings');await c.ui.type(input('New item template',dialog('New item settings')),'Templates/Book.md');await apply(c,'New item settings');

  // All renderers show shared saved data, not copied layout-owned records.
  await choose(c,'Covers');await c.ui.wait(`return [...document.querySelectorAll('${active} .bases-cards-item')].some(e=>e.dataset.path==='Book 001.md');`,'Cards shows edited book');
  await config(c,'Covers');await c.ui.select(`${dialog('View options')} select[aria-label="Image property"]`,'note.cover');await c.ui.select(`${dialog('View options')} select[aria-label="Image fit"]`,'Contain');await c.ui.range(`${dialog('View options')} input[aria-label="Card size"]`,210);await c.ui.range(`${dialog('View options')} input[aria-label="Image aspect ratio"]`,1.5);await apply(c,'View options');
  await c.saved('Library.base',source=>{const view=c.yaml.parse(source).views.find(v=>v.name==='Covers');assert.equal(view.image,'note.cover');assert.equal(view.imageFit,'contain');assert.equal(view.cardSize,210);assert.equal(view.imageAspectRatio,1.5);},'cards-image-sizing-fit-configuration-saved');
  await c.ui.wait(`const image=document.querySelector('${active} .bases-cards-item[data-path="Book 001.md"] .bases-cards-cover img');return image?.complete&&image.naturalWidth===96&&image.naturalHeight===64&&getComputedStyle(image).objectFit==='contain';`,'Actual card cover decodes correct PNG and fit',45000);
  const pixels=await c.ui.dom(`const image=document.querySelector('${active} .bases-cards-item[data-path="Book 001.md"] .bases-cards-cover img'),canvas=document.createElement('canvas');canvas.width=96;canvas.height=64;const context=canvas.getContext('2d');context.drawImage(image,0,0);return{first:[...context.getImageData(0,0,1,1).data],last:[...context.getImageData(95,63,1,1).data]};`);
  assert.deepEqual(pixels,{first:[40,50,170,255],last:[230,176,170,255]});c.evidence.checks.push({name:'cards-cover-decoded-pixel-oracle',...pixels});await c.screenshot('04-cards');
  await choose(c,'Compact');await c.ui.wait(`return [...document.querySelectorAll('${active} .bases-list-item')].some(e=>e.dataset.path==='Book 001.md'&&e.textContent.includes('Finished'));`,'List agrees with table status');
  await config(c,'Compact');await c.ui.select(`${dialog('View options')} select[aria-label="Markers"]`,'Number');await c.ui.type(input('Property separator',dialog('View options')),' · ');await apply(c,'View options');
  await c.ui.wait(`return document.querySelector('${active} .bases-list-item .list-number')?.textContent==='1.'&&document.querySelector('${active} .bases-list-separator')?.textContent===' · ';`,'Numbered List and separator render');await c.screenshot('05-list');
  await config(c,'Compact');await c.ui.click(`${dialog('View options')} input[aria-label="Indent properties"]`);await apply(c,'View options');
  await c.saved('Library.base',source=>{const view=c.yaml.parse(source).views.find(v=>v.name==='Compact');assert.equal(view.markers,'number');assert.equal(view.indentProperties,true);assert.equal(view.separator,' · ');},'list-marker-separator-indent-settings-saved');await c.screenshot('05b-list-indented');
  await choose(c,'Reading board');await c.ui.wait(`return !!document.querySelector('${active} .bases-kanban-card[data-path="Book 001.md"]');`,'Kanban shows saved book');await c.screenshot('06-kanban-before-move');
  await c.ui.drag(`${active} .bases-kanban-card[data-path="Book 001.md"]`,`${active} .bases-kanban-column-body[aria-label="Reading"]`);await c.ui.idle();
  await fmSaved(c,'Book 001.md',p=>assert.equal(p.status,'Reading'),'kanban-pointer-drag-writes-original-note');
  await c.ui.wait(`return document.querySelector('${active} .bases-kanban-card[data-path="Book 001.md"]')?.getAttribute('aria-selected')==='true';`,'Dragged card remains selected');
  await c.ui.button('Search',active);await c.ui.key('Escape');await c.ui.key('Tab');await c.ui.key('Tab');
  await c.ui.wait(`return document.activeElement?.classList.contains('bases-kanban-view');`,'Keyboard Tab enters Kanban surface from toolbar');await c.ui.key('ArrowLeft',{modifiers:8});await c.ui.idle();
  // Exact target is determined by visible adjacent columns, not guessed status order.
  const move=await fmSaved(c,'Book 001.md',p=>assert.notEqual(p.status,'Reading'),'kanban-keyboard-move-writes-original-note');
  await c.screenshot('07-kanban-after-move');

  await c.ui.openFile('Library.base');await c.ui.idle();await choose(c,'Books table');
  await c.ui.command('Split right');
  await c.ui.wait(`return document.querySelectorAll('.pane .bases-session').length===2;`,'Ordinary split duplicates Base presentation');await c.ui.idle();
  await c.ui.edit('Book 003.md','note.rating','5');await fmSaved(c,'Book 003.md',p=>assert.equal(p.rating,5),'split-base-edit-writes-shared-file');
  await c.ui.wait(`return [...document.querySelectorAll(${JSON.stringify(c.ui.cell('Book 003.md','note.rating'))})].length===2&&[...document.querySelectorAll(${JSON.stringify(c.ui.cell('Book 003.md','note.rating'))})].every(e=>e.textContent==='5');`,'Both split Bases agree after save');await c.screenshot('07b-split-base-consistency');
  await c.ui.click('.pane.is-active .tab.is-active .tab-close');await c.ui.wait(`return document.querySelectorAll('.pane').length===1;`,'Close temporary split through normal tab');

  await c.ui.openFile('Context.base');await c.ui.idle();await c.ui.command('Bases: Open in right sidebar');
  await c.ui.wait(`return !!document.querySelector('.right-content .bases-session');`,'Sidebar Base mounted through palette');
  await c.ui.openFile('Context One.md');
  await c.ui.wait(`const root=document.querySelector('.right-content .bases-session');return root?.querySelector('[role="grid"]')?.getAttribute('aria-rowcount')==='38'&&root.querySelector('[data-path="Book 001.md"][data-property="note.category"]')?.textContent==='One';`,'Sidebar this follows first active Markdown note');
  await c.ui.openFile('Context Two.md');
  await c.ui.wait(`const root=document.querySelector('.right-content .bases-session');return root?.querySelector('[role="grid"]')?.getAttribute('aria-rowcount')==='38'&&root.querySelector('[data-path="Book 002.md"][data-property="note.category"]')?.textContent==='Two'&&!root.querySelector('[data-path="Book 001.md"]');`,'Sidebar this refreshes to second active Markdown note');await c.screenshot('07c-sidebar-active-note-context');
  c.evidence.checks.push({name:'sidebar-this-active-note-context',first:'Context One.md',second:'Context Two.md',expectedRows:37});

  await c.ui.openFile('Embed host.md');
  await c.ui.wait(`return document.querySelectorAll('.pane.is-active .bases-embed .bases-session').length>=2;`,'File and fenced embeds mount through actual editor');await c.screenshot('08-file-and-fenced-embeds');
  const embedBefore=(await import('./fixtures.mjs')).fixtureFiles().get('Embed host.md');
  assert.equal(await c.read('Embed host.md'),embedBefore,'Rendering embeds does not mutate Markdown');
  const inline='.pane.is-active .bases-embed[data-base-source="Embed host.md"] .bases-session';
  await c.ui.button('Views',inline);await c.ui.button('Configure view Embedded list',dialog('Views'));await c.ui.type(input('View name',dialog('View options')),'Inline renamed');await apply(c,'View options');
  await c.saved('Embed host.md',source=>assert.equal(source,embedBefore.replace('name: Embedded list','name: Inline renamed')),'fenced-view-configuration-updates-exact-original-markdown-block');
  await c.screenshot('08b-fenced-config-saved');

  // External edit while a real table editor holds its original baseline. Draft
  // must survive and stale save must not clobber the external writer.
  await c.ui.openFile('Library.base');await c.ui.idle();await choose(c,'Books table');
  await c.ui.click(c.ui.cell('Book 001.md','note.rating'),{count:2});await c.ui.type(`${c.ui.cell('Book 001.md','note.rating')} input`,'1');
  const authoritative=(await c.read('Book 001.md')).replace(/rating: 4\n/,'rating: 3\n')+'\nExternal editor marker\n';
  await c.external('Book 001.md',authoritative,'external-write-with-active-cell-draft');await delay(1200);await c.ui.key('Enter');
  await c.ui.wait(`return [...document.querySelectorAll('.pane.is-active [role="status"],.pane.is-active [role="alert"]')].some(e=>/stale|changed|conflict|refresh/i.test(e.textContent))||!!document.querySelector('.pane.is-active input[aria-invalid="true"]');`,'Stale edit has visible recovery feedback',45000);
  assert.equal(await c.read('Book 001.md'),authoritative,'Stale cell cannot overwrite external bytes');await c.screenshot('09-stale-retained-draft');await c.ui.key('Escape');
  await c.ui.openFile('Book 001.md');await c.ui.openFile('Library.base');await c.ui.idle();await choose(c,'Books table');await visibleCell(c,'Book 001.md','note.rating','3');
  await noAlerts(c);
  const finalBook=await c.read('Book 001.md'),finalBase=await c.read('Library.base');
  c.evidence.checks.push({name:'pre-restart-durable-snapshot',book:finalBook,base:finalBase,kanbanMovedSource:move,newFile});
  await c.quit('normal-quit-after-composed-user-session');
  await c.launch('restart-and-verify');await c.ui.openFile('Library.base');await c.ui.idle();await choose(c,'Books table');
  await c.saved('Book 001.md',source=>assert.equal(source,finalBook),'exact-note-bytes-survive-restart');
  await c.saved('Library.base',source=>assert.equal(source,finalBase),'exact-base-configuration-survives-restart');
  await c.saved(authoredFile,source=>assert.equal(source,authoredBody),'new-hover-edited-note-survives-real-app-restart');
  await visibleCell(c,'Book 001.md','note.rating','3');await c.screenshot('10-restarted-table');
  await c.diskGuard();await c.quit('final-normal-quit');
}
