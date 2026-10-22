import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {until,delay} from '../tasks-electron-integration/cdp.mjs';

const active='.pane.is-active .bases-session';
const dialog=name=>`[role="dialog"][aria-label=${JSON.stringify(name)}]`;
const input=(name,scope='body')=>`${scope} input[aria-label=${JSON.stringify(name)}],${scope} textarea[aria-label=${JSON.stringify(name)}]`;
async function choose(c,name){await c.ui.button('Views',active);await c.ui.button(`Open view ${name}`,dialog('Views'));await c.ui.idle();}
async function apply(c,name){await c.ui.button('Apply',dialog(name));await c.ui.wait(`return !document.querySelector(${JSON.stringify(dialog(name))});`,'Applied '+name);await c.ui.idle();}
async function config(c,name){await c.ui.button('Views',active);await c.ui.button(`Configure view ${name}`,dialog('Views'));}
async function fmSaved(c,file,check,name){return c.saved(file,source=>check(c.frontmatter(source),source),name);}
async function visibleCell(c,file,property,expected){return c.ui.wait(`const e=document.querySelector(${JSON.stringify(c.ui.cell(file,property))});return e&&e.textContent.includes(${JSON.stringify(expected)});`,`${file} ${property} = ${expected}`);}
async function noAlerts(c){await c.ui.wait(`return ![...document.querySelectorAll('.pane.is-active [role="alert"]')].some(e=>e.getClientRects().length&&e.textContent.trim());`,'No visible failure after positive flow');}

export async function journey(c){
  await c.launch('author-configure-and-edit');
  await c.ui.openFile('Library.base');await c.ui.idle();
  await c.ui.wait(`return document.querySelector('${active} [role="grid"]')?.getAttribute('aria-rowcount')==='74';`,'72 books plus heterogeneous row; filter excludes project/template/author files');
  await visibleCell(c,'Book 001.md','note.rating','1');
  await visibleCell(c,'Book 001.md','formula.doubleRating','2');
  await c.screenshot('01-library-table-initial');

  // Create through the normal app command; the preseeded Base is not creation proof.
  const basesBefore=new Set((await fs.readdir(c.vault)).filter(name=>name.endsWith('.base')));
  await c.ui.command('Create new base');await c.ui.idle();
  const created=await until(async()=>{const names=(await fs.readdir(c.vault)).filter(name=>name.endsWith('.base')&&!basesBefore.has(name));assert.equal(names.length,1,'One ordinary Base created');return names[0];},30000);
  assert.notEqual(created,'Library.base');
  await c.saved(created,source=>assert.ok(c.yaml.parse(source).views?.length>=1),'ordinary-create-base-writes-real-config');
  await c.ui.openFile('Library.base');await c.ui.idle();

  // Rename, add, duplicate, reorder, default and delete through actual view controls.
  await config(c,'Library');await c.ui.type(input('View name'),'Books table');await apply(c,'View options');
  await c.saved('Library.base',source=>{const b=c.yaml.parse(source);assert.equal(b.views[0].name,'Books table');assert.equal(b.fixtureSentinel,'keep-me');assert.match(source,/# Heavy-user fixture/);},'view-rename-preserves-unknown-fields-comments');
  await c.ui.button('Views',active);await c.ui.button('Add view',dialog('Views'));
  await c.ui.type(input('View name'),'Temporary view');await c.ui.select(`${dialog('Add view')} select[aria-label="Layout"]`,'List');await c.ui.button('Create view',dialog('Add view'));await c.ui.idle();
  await config(c,'Temporary view');await c.ui.button('Duplicate view',dialog('View options'));await c.ui.idle();
  const duplicate=await c.saved('Library.base',source=>assert.equal(c.yaml.parse(source).views.length,6),'add-and-duplicate-view');
  const copied=c.yaml.parse(duplicate).views.find(v=>v.name!=='Temporary view'&&v.name.startsWith('Temporary view')).name;
  await config(c,copied);await c.ui.button('Move view earlier',dialog('View options'));await c.ui.idle();
  await config(c,copied);await c.ui.button('Set as default view',dialog('View options'));await c.ui.idle();
  await c.saved('Library.base',source=>assert.equal(c.yaml.parse(source).views[0].name,copied),'default-view-is-first-saved-view');
  for(const name of[copied,'Temporary view']){await config(c,name);await c.ui.button('Delete view',dialog('View options'));await c.ui.idle();}
  await choose(c,'Books table');

  // View-level advanced filter composes with the fixture's Base-wide membership.
  await c.ui.button('Filter',active);await c.ui.button('This view',dialog('Filter'));await c.ui.button('Add expression',dialog('Filter'));
  await c.ui.type(input('Filter expression',dialog('Filter')),'note.rating >= 4');await apply(c,'Filter');
  await c.ui.wait(`return document.querySelector('${active} [role="grid"]')?.getAttribute('aria-rowcount')==='29';`,'28 high-rating rows');
  await c.screenshot('02-view-filter');
  await c.ui.button('Filter',active);await c.ui.button('This view',dialog('Filter'));await c.ui.button('Remove filter',dialog('Filter'));await apply(c,'Filter');

  // Field edits must preserve body/frontmatter not touched by the command.
  const firstBefore=await c.read('Book 001.md');
  await c.ui.edit('Book 001.md','note.rating','5');
  await fmSaved(c,'Book 001.md',(p,source)=>{assert.equal(p.rating,5);assert.equal(p.untouched,'preserve 0');assert.equal(source.slice(source.indexOf('\n# ')),firstBefore.slice(firstBefore.indexOf('\n# ')));},'table-numeric-edit-preserves-body-and-unrelated-properties');
  await visibleCell(c,'Book 001.md','formula.doubleRating','10');
  await c.ui.click(`${c.ui.cell('Book 001.md','note.done')} input[type="checkbox"]`);
  await fmSaved(c,'Book 001.md',p=>assert.equal(p.done,true),'checkbox-edit');

  // Rich pickers are shared production widgets. Multiple selections commit on
  // Enter with no search, rather than writing a comma-delimited string.
  await c.ui.click(`${c.ui.cell('Book 001.md','note.topics')} .bases-metadata-value`);
  await c.ui.type('.bases-property-popover input[role="combobox"]','Writing');
  await c.ui.key('ArrowDown');await c.ui.key('Enter');
  await c.ui.type('.bases-property-popover input[role="combobox"]','');await c.ui.key('Enter');await c.ui.idle();
  await fmSaved(c,'Book 001.md',p=>assert.deepEqual(p.topics,['Design','Writing']),'multiselect-stores-yaml-list');
  await c.ui.click(`${c.ui.cell('Book 001.md','note.status')} .bases-metadata-value`);
  await c.ui.type('.bases-property-popover input[role="combobox"]','Reading');await c.ui.key('ArrowDown');await c.ui.key('Enter');await c.ui.idle();
  await fmSaved(c,'Book 001.md',p=>assert.equal(p.status,'Reading'),'status-picker');
  await c.ui.click(`${c.ui.cell('Book 001.md','note.author')} .bases-metadata-value`);
  await c.ui.type('.bases-property-popover input[role="combobox"]','Author Grace');await c.ui.key('ArrowDown');await c.ui.key('Enter');await c.ui.idle();
  await fmSaved(c,'Book 001.md',p=>assert.equal(p.author,'[[Author Grace]]'),'relation-picker-stores-readable-link');
  await c.screenshot('03-rich-property-edits');

  // Native table keyboard selection and production TSV handler. Clipboard scope
  // is explicitly synthetic and does not read or replace the system clipboard.
  await c.ui.click(c.ui.cell('Book 001.md','note.rating'));
  const paste='4\tFinished\n2\tReading';
  const pasted=await c.ui.dom(`const target=document.activeElement;if(target?.getAttribute('role')!=='gridcell')throw Error('Focused real cell required');const data=new DataTransfer();data.setData('text/plain',${JSON.stringify(paste)});const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data});target.dispatchEvent(event);return event.defaultPrevented;`);
  assert.equal(pasted,true,'Actual production paste handler accepted TSV');c.evidence.actions.push({action:'synthetic-clipboard-event',mime:'text/plain',text:paste});
  await fmSaved(c,'Book 001.md',p=>{assert.equal(p.rating,4);assert.equal(p.status,'Finished');},'rectangular-paste-row-one');
  await fmSaved(c,'Book 002.md',p=>{assert.equal(p.rating,2);assert.equal(p.status,'Reading');},'rectangular-paste-row-two');
  await c.ui.key('z',{modifiers:4});await c.ui.idle();
  await fmSaved(c,'Book 001.md',p=>{assert.equal(p.rating,5);assert.equal(p.status,'Reading');},'single-command-undo-restores-rectangular-edit');
  await c.ui.key('z',{modifiers:5});await c.ui.idle();
  await fmSaved(c,'Book 001.md',p=>{assert.equal(p.rating,4);assert.equal(p.status,'Finished');},'redo-restores-rectangular-edit');

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
  await c.ui.openFile('Library.base');await c.ui.idle();await choose(c,'Books table');

  // Full literal template bytes, safe collision, unchanged source template.
  const existing=new Set(await fs.readdir(path.join(c.vault,'Created')));
  await c.ui.button('New',active);
  const newFile=await until(async()=>{const names=(await fs.readdir(path.join(c.vault,'Created'))).filter(n=>!existing.has(n)&&n.endsWith('.md'));assert.equal(names.length,1);return 'Created/'+names[0];},30000);
  await c.saved(newFile,source=>assert.equal(source,c.template),'new-copies-full-template-literally');
  assert.equal(await c.read('Templates/Book.md'),c.template,'Template source unchanged');
  await c.ui.openFile('Library.base');await c.ui.idle();await choose(c,'Books table');await c.ui.button('New',active);
  await until(async()=>assert.equal((await fs.readdir(path.join(c.vault,'Created'))).filter(n=>n.endsWith('.md')).length,2),30000);
  for(const name of await fs.readdir(path.join(c.vault,'Created')))assert.equal(await c.read('Created/'+name),c.template,'Collision-safe create preserves exact template');
  await c.ui.openFile('Library.base');await c.ui.idle();

  // All renderers show shared saved data, not copied layout-owned records.
  await choose(c,'Covers');await c.ui.wait(`return [...document.querySelectorAll('${active} .bases-cards-item')].some(e=>e.dataset.path==='Book 001.md');`,'Cards shows edited book');await c.screenshot('04-cards');
  await choose(c,'Compact');await c.ui.wait(`return [...document.querySelectorAll('${active} .bases-list-item')].some(e=>e.dataset.path==='Book 001.md'&&e.textContent.includes('Finished'));`,'List agrees with table status');await c.screenshot('05-list');
  await choose(c,'Reading board');await c.ui.wait(`return !!document.querySelector('${active} .bases-kanban-card[data-path="Book 001.md"]');`,'Kanban shows saved book');await c.screenshot('06-kanban-before-move');
  await c.ui.click(`${active} .bases-kanban-card[data-path="Book 001.md"]`);await c.ui.key('ArrowLeft',{modifiers:8});await c.ui.idle();
  // Exact target is determined by visible adjacent columns, not guessed status order.
  const move=await fmSaved(c,'Book 001.md',p=>assert.notEqual(p.status,'Finished'),'kanban-keyboard-move-writes-original-note');
  await c.screenshot('07-kanban-after-move');

  await c.ui.openFile('Embed host.md');
  await c.ui.wait(`return document.querySelectorAll('.pane.is-active .bases-embed .bases-session').length>=2;`,'File and fenced embeds mount through actual editor');await c.screenshot('08-file-and-fenced-embeds');
  assert.equal(await c.read('Embed host.md'),(await import('./fixtures.mjs')).fixtureFiles().get('Embed host.md'),'Rendering embeds does not mutate Markdown');

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
  await visibleCell(c,'Book 001.md','note.rating','3');await c.screenshot('10-restarted-table');
  await c.diskGuard();await c.quit('final-normal-quit');
}
