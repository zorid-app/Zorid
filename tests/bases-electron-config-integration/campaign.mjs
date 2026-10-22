import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {until} from '../tasks-electron-integration/cdp.mjs';
import {createClipboardGuard} from '../bases-electron-clipboard-integration/clipboard.mjs';
import {fixtureFiles,records,exportRecords,recoveredInline,repairedStandalone} from './fixtures.mjs';
import {rootMembership,filteredRecords,sortedRecords,exportMatrix,expectedTSV,parseDelimited,assertLargeTSV} from './oracles.mjs';
import {active,dialog,input,closeMenu,choose,focusByTab,exactRows,section,group,match,addGroup,addCondition,editCondition,savedConfiguration,previewAndEscape} from './controls.mjs';
import {awaitFixtureAdmission} from './admission.mjs';
export {fixtureFiles,vaultName} from './fixtures.mjs';

async function filters(c){
  await c.ui.button('Filter',active);await c.ui.button('All views',dialog('Filter'));
  const all=section('All views'),root=group(all);
  await addGroup(c,root);const rootOr=group(all,[0]);await match(c,rootOr,'or');
  await editCondition(c,rootOr,0,'note.status','eq','Todo');await addCondition(c,rootOr);await editCondition(c,rootOr,1,'note.status','eq','Done');
  await addGroup(c,root);const rootNot=group(all,[1]);await match(c,rootNot,'not');await editCondition(c,rootNot,0,'note.enabled','eq','false');
  const local=section('This view');await c.ui.select(`${local} .bases-filter-tree > select[aria-label="Match"]`,'or');
  const localRoot=group(local);await addCondition(c,localRoot);await editCondition(c,localRoot,0,'note.score','gte','4');
  await addGroup(c,localRoot);const localAnd=group(local,[0]);await editCondition(c,localAnd,0,'note.priority','eq','High');
  await addGroup(c,localAnd);const localNot=group(local,[0,0]);await match(c,localNot,'not');await editCondition(c,localNot,0,'note.status','eq','Done');
  await closeMenu(c,'Filter');
  await savedConfiguration(c,config=>{
    assert.deepEqual(config.filters,{and:['note.kind == "config"',{or:['note["status"] == "Todo"','note["status"] == "Done"']},{not:['note["enabled"] == false']}]});
    assert.deepEqual(config.views[0].filters,{or:['note["score"] >= 4',{and:['note["priority"] == "High"',{not:['note["status"] == "Done"']}]}]});
  },'nested-visual-all-and-this-view-AND-OR-NOT-source');
  await exactRows(c,filteredRecords().map(item=>item.path),'nested-visual-filters-independent-five-record-membership');await c.screenshot('01-nested-visual-filters');
}
async function sorting(c){
  await c.ui.button('Sort',active);
  await c.ui.select(`${dialog('Sort')} .bases-toolbar-rule:nth-child(1) select[aria-label="Sort property"]`,'note.score');
  await c.ui.select(`${dialog('Sort')} .bases-toolbar-rule:nth-child(1) select[aria-label="Sort direction"]`,'DESC');
  await c.ui.button('Add sort',dialog('Sort'));
  await c.ui.select(`${dialog('Sort')} .bases-toolbar-rule:nth-child(2) select[aria-label="Sort property"]`,'note.priority');
  await c.ui.select(`${dialog('Sort')} .bases-toolbar-rule:nth-child(2) select[aria-label="Sort direction"]`,'ASC');await closeMenu(c,'Sort');
  const first=[['score','DESC'],['priority','ASC']];
  await savedConfiguration(c,config=>assert.deepEqual(config.views[0].sort,[{property:'note.score',direction:'DESC'},{property:'note.priority',direction:'ASC'}]),'two-criterion-sort-source');
  await exactRows(c,sortedRecords(first).map(item=>item.path),'multi-sort-tie-break-exact-order');
  await c.ui.button('Sort',active);
  await c.ui.click(`${dialog('Sort')} .bases-toolbar-rule:nth-child(2) button[role="combobox"][aria-label="Sort property"]`);await c.ui.key('Escape');
  await c.ui.key('ArrowUp',{modifiers:1});await closeMenu(c,'Sort');
  await savedConfiguration(c,config=>assert.deepEqual(config.views[0].sort,[{property:'note.priority',direction:'ASC'},{property:'note.score',direction:'DESC'}]),'sort-priority-reordered-by-actual-alt-arrow');
  await exactRows(c,sortedRecords([['priority','ASC'],['score','DESC']]).map(item=>item.path),'reordered-multi-sort-independent-order');
}
async function properties(c){
  await c.ui.button('Properties',active);await c.ui.button('Configure property score',dialog('Properties'));await c.ui.type(input('Display name',dialog('Property')),'Points');await closeMenu(c,'Property');
  await savedConfiguration(c,config=>assert.equal(config.properties['note.score'].displayName,'Points'),'property-display-name-source');
  await c.ui.wait(`return document.querySelector('${active} [role="columnheader"][title="note.score"]')?.textContent.includes('Points');`,'Display label is reflected in table header');
  await c.ui.button('Properties',active);await c.ui.button('Hide all',dialog('Properties'));
  for(const property of ['file.name','note.score','note.status'])await c.ui.click(`${dialog('Properties')} .bases-toolbar-property-row input[data-property=${JSON.stringify(property)}]`);
  await focusByTab(c,'e.matches(\'input[type="checkbox"][data-property="note.score"]\')','visible score property checkbox',{reverse:true});await c.ui.key('ArrowDown',{modifiers:1});await closeMenu(c,'Properties');
  const expected=['file.name','note.status','note.score'];
  await savedConfiguration(c,config=>assert.deepEqual(config.views[0].order,expected),'visibility-and-keyboard-property-order-source');
  const actual=await c.ui.wait(`const headers=[...document.querySelectorAll('${active} [role="columnheader"]')].map(e=>e.title);return JSON.stringify(headers)===${JSON.stringify(JSON.stringify(expected))}?headers:false;`,'Exact visible property order');
  c.evidence.checks.push({name:'visible-columns-match-explicit-order',properties:actual});await c.screenshot('02-sort-properties');
}
async function groups(c){
  await choose(c,'Board');await c.ui.button('Group',active);await c.ui.select(`${dialog('Group')} select[aria-label="Group direction"]`,'MANUAL');await closeMenu(c,'Group');
  await savedConfiguration(c,config=>assert.deepEqual(config.views[1].groupOrder,[]),'first-manual-order-hides-all');
  await c.ui.wait(`return !document.querySelector('${active} .bases-kanban-column');`,'Manual empty order has no columns');
  await c.ui.button('Group',active);await c.ui.click(`${dialog('Group')} input[aria-label="Show group Done"]`);await closeMenu(c,'Group');
  await savedConfiguration(c,config=>assert.deepEqual(config.views[1].groupOrder,['Done']),'manual-show-one-group-source');
  await c.ui.wait(`const bodies=[...document.querySelectorAll('${active} .bases-kanban-column-body')];return bodies.length===1&&bodies[0].getAttribute('aria-label')==='Done';`,'Only selected manual group is visible');
  await c.ui.button('Group',active);await c.ui.button('Hide all groups',dialog('Group'));await closeMenu(c,'Group');
  await savedConfiguration(c,config=>assert.deepEqual(config.views[1].groupOrder,[]),'manual-hide-all-source');
  await c.ui.button('Group',active);await c.ui.button('Show all groups',dialog('Group'));await closeMenu(c,'Group');
  await savedConfiguration(c,config=>assert.deepEqual(new Set(config.views[1].groupOrder),new Set(['Done','Todo'])),'manual-show-all-source');
  await c.ui.button('Group',active);await c.ui.select(`${dialog('Group')} select[aria-label="Group direction"]`,'ASC');await closeMenu(c,'Group');
  await savedConfiguration(c,config=>{assert.equal(config.views[1].groupOrder,undefined);assert.equal(config.views[1].groupBy.direction,'ASC');assert.equal(config.views[1].groupBy.extension,'keep');},'manual-reset-to-automatic-preserves-group-extension');
  const all=records.filter(rootMembership),paths=await c.ui.wait(`const cards=[...document.querySelectorAll('${active} .bases-kanban-card')].map(e=>e.dataset.path);return cards.length===${all.length}?cards:false;`,'Every base-wide admitted card visible after reset');assert.deepEqual(new Set(paths),new Set(all.map(item=>item.path)));
  const column=status=>`${active} .bases-kanban-column:has(> .bases-kanban-column-body[aria-label=${JSON.stringify(status)}])`;
  await previewAndEscape(c,{source:`${column('Done')} > .bases-kanban-column-header`,target:`${column('Todo')} > .bases-kanban-column-header`,placeholder:`${active} .bases-kanban-column-drop-placeholder`,name:'03-column-live-preview-escape'});
  await previewAndEscape(c,{source:`${active} .bases-kanban-card[data-path="Records/Item 03.md"]`,target:`${column('Todo')} > .bases-kanban-column-body`,placeholder:`${active} .bases-kanban-card-drop-placeholder`,name:'04-card-live-preview-escape'});
}
async function formulaEditor(c,name){await c.ui.button('Properties',active);await c.ui.button('Configure property '+name,dialog('Properties'));await c.ui.button('Edit formula',dialog('Property'));}
async function formulas(c){
  await choose(c,'Configuration');await formulaEditor(c,'twice');await c.ui.type(input('Formula expression',dialog('Formula')),'note.score +');
  await c.ui.wait(`return document.querySelector(${JSON.stringify(dialog('Formula'))})?.querySelector('.cm-content')?.getAttribute('aria-invalid')==='true';`,'Invalid expression remains visibly diagnosed');
  await savedConfiguration(c,config=>assert.equal(config.formulas.twice,'note.score +'),'invalid-formula-source-retained-with-visible-diagnostics');await c.screenshot('05-invalid-formula-draft');
  await c.ui.type(input('Formula expression',dialog('Formula')),'note.score * 2');await closeMenu(c,'Formula');
  await savedConfiguration(c,config=>assert.equal(config.formulas.twice,'note.score * 2'),'formula-syntax-recovery-source');
  await formulaEditor(c,'twice');await c.ui.type(input('Formula expression',dialog('Formula')),'formula.twice');await closeMenu(c,'Formula');
  await savedConfiguration(c,config=>assert.equal(config.formulas.twice,'formula.twice'),'self-cycle-is-retained-as-authored-source');
  // Visibility was deliberately restricted earlier. Re-enable the existing
  // formula through the normal Properties control to observe its runtime error.
  await c.ui.button('Properties',active);await c.ui.click(`${dialog('Properties')} input[data-property="formula.twice"]`);await closeMenu(c,'Properties');
  await c.ui.wait(`const values=[...document.querySelectorAll('${active} [data-property="formula.twice"]')].map(e=>e.textContent);return values.some(value=>/cycle|cyclic|infinite|recurs/i.test(value));`,'Cycle diagnostics appear in actual result cells');await c.screenshot('06-formula-cycle');
  await formulaEditor(c,'twice');await c.ui.type(input('Formula expression',dialog('Formula')),'note.score * 2');await closeMenu(c,'Formula');
  await c.ui.wait(`const cell=document.querySelector(${JSON.stringify(c.ui.cell('Records/Item 01.md','formula.twice'))});return cell?.textContent==='4';`,'Cycle repair reevaluates through shared core');
}
async function recovery(c){
  await c.ui.openFile('Invalid.base');await c.ui.wait(`const e=document.querySelector('.pane.is-active .base-source-recovery');return !!e?.getClientRects().length;`,'Invalid standalone Base exposes production source recovery');
  await c.ui.click('.pane.is-active .base-source-recovery');
  const sourceEditor='.pane.is-active .base-source-view .cm-content[aria-label="Base source"]';
  await c.ui.type(sourceEditor,'# Retain invalid author text while repairing.\nviews: [\n');await c.ui.key('s',{modifiers:4});
  await c.saved('Invalid.base',source=>assert.equal(source,'# Retain invalid author text while repairing.\nviews: [\n'),'invalid-standalone-source-is-editable-and-saveable');
  await c.ui.wait(`return !!document.querySelector(${JSON.stringify(sourceEditor)})?.getClientRects().length;`,'Saving invalid YAML retains the ordinary source editor');
  await c.ui.type(sourceEditor,repairedStandalone);await c.ui.key('s',{modifiers:4});
  await c.saved('Invalid.base',source=>assert.equal(source,repairedStandalone),'standalone-invalid-base-repaired-via-production-source-editor');
  await c.ui.click('.pane.is-active .base-source-toggle[aria-label="Return to Base"]');await exactRows(c,records.map(item=>item.path),'repaired-standalone-base-renders-all-records');await c.screenshot('07a-standalone-source-recovery');
  await c.ui.openFile('Unknown.base');await c.ui.wait(`return document.querySelector('${active} .bases-session-content')?.textContent.includes('Unsupported base view: future-grid');`,'Unknown renderer is inspectable without rewriting its config');
  await c.ui.button('Views',active);await c.ui.button('Configure view Future view',dialog('Views'));await c.ui.select(`${dialog('View options')} select[aria-label="Layout"]`,'table');await closeMenu(c,'View options');
  await c.saved('Unknown.base',source=>{const config=c.yaml.parse(source);assert.equal(config.fixtureSentinel,'unknown-keep');assert.deepEqual(config.pluginRoot,{version:23,values:['x','y']});assert.equal(config.views[0].type,'table');assert.deepEqual(config.views[0].pluginView,{future:true,amount:17});assert.match(source,/# Unknown renderer/);},'unknown-renderer-repaired-through-layout-selector-retains-fields');await exactRows(c,records.map(item=>item.path),'unknown-renderer-normal-table-recovery');
  await c.ui.openFile('Recovery host.md');await c.ui.wait(`return !!document.querySelector('.pane.is-active .bases-session-status')?.textContent.trim();`,'Prelaunch invalid inline Base has a visible parse error');
  await c.ui.button('Edit Base source','.pane.is-active');
  await c.ui.type('.pane.is-active .cm-editor > .cm-scroller > .cm-content',recoveredInline);
  await c.saved('Recovery host.md',source=>assert.equal(source,recoveredInline),'invalid-inline-base-repaired-through-normal-editor');
  await c.ui.openFile('Configuration.base');await c.ui.openFile('Recovery host.md');await c.ui.wait(`return document.querySelector('.pane.is-active .bases-embed [role="grid"]')?.getAttribute('aria-rowcount')==='13';`,'Recovered inline Base renders all independently expected records');
  await c.screenshot('07-source-recovery');
}
async function exports1005(c){
  await c.ui.openFile('Large export.base');await c.ui.wait(`return document.querySelector('${active} [role="grid"]')?.getAttribute('aria-rowcount')==='1006';`,'1005 admitted export rows, independent of mounted viewport');
  const clipboard=createClipboardGuard();await clipboard.capture();
  try{
    await c.ui.button('Results',active);await c.ui.button('Copy',dialog('Results'));
    await until(()=>clipboard.recordOwnedClipboard(expectedTSV()),20000);const plain=await clipboard.readPlainText();
    c.evidence.checks.push({name:'actual-system-clipboard-tsv-1005-complete-ordered-rows',...assertLargeTSV(plain),sha256:createHash('sha256').update(plain).digest('hex')});
    // Native clipboard receipt can precede the toolbar's async command
    // continuation. Observe that continuation before reopening this toggle.
    await c.ui.wait(`return !document.querySelector(${JSON.stringify(dialog('Results'))});`,'Acknowledged Copy closes Results before the CSV menu is reopened');
  }finally{await clipboard.restore();}
  const directory=await c.prepareDownloads();await c.ui.button('Results',active);await c.ui.button('Export CSV',dialog('Results'));
  const source=await until(async()=>{const names=(await fs.readdir(directory)).filter(file=>file.endsWith('.csv'));assert.equal(names.length,1);return fs.readFile(path.join(directory,names[0]),'utf8');},30000);
  assert.deepEqual(parseDelimited(source,','),exportMatrix());c.evidence.checks.push({name:'actual-csv-download-1005-complete-ordered-rows',rows:exportRecords.length,sha256:createHash('sha256').update(source).digest('hex')});
  c.evidence.limitations.push('Markdown and paths serializers have no normal UI/CLI entrypoint. This campaign accepts only supported Copy TSV and Export CSV controls; it does not claim Markdown/paths UI acceptance.');
}
export async function journey(c){
  c.evidence.kind='actual-electron-bases-configuration';c.evidence.limitations.push('1005-row export fixture is a bounded functional test, not a performance budget or large-vault campaign.');
  await c.launch('configuration-campaign');await c.ui.openFile('Configuration.base');await c.ui.idle();
  await awaitFixtureAdmission(c,[...fixtureFiles().keys()]);
  await exactRows(c,records.map(item=>item.path),'prelaunch-twelve-record-baseline');
  await filters(c);await sorting(c);await properties(c);await groups(c);await formulas(c);await recovery(c);await exports1005(c);
  const fixtures=fixtureFiles();for(const item of records)assert.equal(await c.read(item.path),fixtures.get(item.path),'Configuration/preview interactions never alter note bytes: '+item.path);
  c.evidence.checks.push({name:'all-twelve-note-bodies-and-frontmatter-remain-exact',paths:records.map(item=>item.path)});
  await c.quit('configuration-campaign-normal-quit');
  await c.launch('configuration-campaign-reopen');await c.ui.openFile('Configuration.base');await choose(c,'Configuration');await exactRows(c,sortedRecords([['priority','ASC'],['score','DESC']]).map(item=>item.path),'fresh-process-reopen-retains-nested-filters-and-sort');await c.screenshot('08-fresh-process-configuration');await c.quit('configuration-campaign-reopen-normal-quit');
}
