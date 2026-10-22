import assert from 'node:assert/strict';
import {alpha,beta,bodies,initial,fixtureFiles} from './fixtures.mjs';
import {applyRawEdit} from './raw-oracle.mjs';
export {fixtureFiles,vaultName} from './fixtures.mjs';
const active='.pane.is-active';
const dialog=name=>`[role="dialog"][aria-label=${JSON.stringify(name)}]`;
const esc=value=>JSON.stringify(value);
function property(layout,file,name){
  if(layout==='table')return `${active} [role="gridcell"][data-path=${esc(file)}][data-property=${esc('note.'+name)}]`;
  const host={cards:'.bases-cards-item',list:'.bases-list-item',kanban:'.bases-kanban-card'}[layout];
  return `${active} ${host}[data-path=${esc(file)}] .bases-metadata-value[data-property=${esc('note.'+name)}]`;
}
async function chooseView(c,name){await c.ui.button('Views',active);await c.ui.button('Open view '+name,dialog('Views'));await c.ui.idle();}
async function view(c,layout){await chooseView(c,{table:'Property table',cards:'Property cards',list:'Property list',kanban:'Property board'}[layout]);}
async function visible(c,selector,text){await c.ui.wait(`const e=document.querySelector(${esc(selector)});return e&&e.textContent.includes(${esc(text)});`,'Visible property '+text);}
async function editText(c,selector,text){
  await c.ui.click(selector);await c.ui.type(`${selector} input.metadata-input`,text);await c.ui.key('Enter');await c.ui.idle();
}
async function openPicker(c,selector){
  // Existing relation chips navigate. Enter the widget through its neutral
  // padding, or traverse actual Tab stops when the inline value has no padding.
  const point=await c.ui.dom(`const e=document.querySelector(${esc(selector)});if(!e)return false;e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();for(const [x,y]of [[r.right-3,r.y+r.height/2],[r.x+2,r.y+2]]){const h=document.elementFromPoint(x,y);if(h&&e.contains(h)&&!h.closest('a,input,button,[role="link"]'))return{x,y};}return false;`);
  if(point){for(const type of ['mousePressed','mouseReleased'])await c.cdp.call('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});c.evidence.actions.push({action:'pointer-property-padding',selector,point});}
  else {
    await c.ui.button('Views',active);await c.ui.key('Escape');let reached=false;
    for(let index=0;index<160;index++){if(await c.ui.dom(`return document.activeElement===document.querySelector(${esc(selector)});`)){reached=true;break;}await c.ui.key('Tab');}
    assert.ok(reached,'Property reached through real Tab navigation: '+selector);await c.ui.key('Enter');
  }await c.ui.wait(`return !!document.querySelector('.bases-property-popover input[role="combobox"]');`,'Rich picker opens through visible property');
}
async function pick(c,selector,text,{create=false,multiple=false}={}){
  await openPicker(c,selector);await c.ui.type('.bases-property-popover input[role="combobox"]',text);
  if(create)await c.ui.button(`Create “${text}”`,'.bases-property-popover');else await c.ui.key('Enter');
  await c.ui.wait(`return !document.querySelector('[data-base-editing="pending"]');`,'Selected chip save acknowledged');
  if(multiple){await c.ui.key('Escape');await c.ui.wait(`return !document.querySelector('.bases-property-popover');`,'Close retained multiple picker');}
  await c.ui.idle();
}
async function addTag(c,selector,text){
  await c.ui.click(selector);await c.ui.type(`${selector} .bases-property-inline-editor input`,text);await c.ui.key('Enter');
  await c.ui.wait(`return !document.querySelector('[data-base-editing="pending"]');`,'Tag chip saved immediately');await c.ui.key('Escape');await c.ui.idle();
}
async function readOnlyAttempt(c,layout,file,name,expectedSource){
  const selector=property(layout,file,name);assert.equal(await c.read(file),expectedSource,'Independent raw source before derived attempt');
  // Click the actual property's empty padding, avoiding a derived link's valid
  // navigation action; all coordinates are read from the live rendered node.
  const point=await c.ui.wait(`const e=document.querySelector(${esc(selector)});if(!e)return false;e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect(),x=r.right-5,y=r.y+r.height/2,h=document.elementFromPoint(x,y);return h===e?{x,y}:false;`,'Derived property own padding hit target');
  for(const type of ['mousePressed','mouseReleased'])await c.cdp.call('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});
  c.evidence.actions.push({action:'pointer-readonly-property-padding',layout,file,name,point});
  await c.ui.wait(`const e=document.querySelector(${esc(selector)});return e&&e.isConnected&&e.getClientRects().length&&document.activeElement===e&&e.dataset.path===${esc(file)}&&e.dataset.property===${esc('note.'+name)};`,'Exact current derived cell focused before Enter');
  c.evidence.checks.push({name:'P6-exact-focused-derived-cell-'+name,file,property:'note.'+name,activePane:true});await c.ui.key('Enter');
  await c.ui.wait(`const e=document.querySelector(${esc(selector)});return e&&!e.hasAttribute('data-base-editing')&&!e.querySelector('input.metadata-input,textarea,[contenteditable="true"]');`,'Derived property has no editable input');
  await c.ui.key('Escape');await c.ui.idle();assert.equal(await c.read(file),expectedSource,'Derived edit attempt preserves independently expected full source');c.evidence.checks.push({name:`derived-readonly-${layout}-${name}`,file,unchanged:true});
}
function body(source){const match=/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(source);assert.ok(match);return source.slice(match[0].length);}

const baseFile='Properties.base';
const originalTable='Property table',mirrorTable='Summary mirror';
const sharedSummary='Shared counters',renamedSummary='Renamed shared counters',keptSummary='Kept counters';
const sharedExpression='values.length',keptExpression='values.length + 40';
const summaryEditor=dialog('Edit summary');
const summaryInput=name=>`${summaryEditor} input[aria-label=${esc(name)}],${summaryEditor} textarea[aria-label=${esc(name)}],${summaryEditor} [contenteditable="true"][aria-label=${esc(name)}]`;
const footer=name=>`${active} .zorid-bases-table-footer [data-summary-property=${esc(name)}]`;
const sharedTargets=[[originalTable,'note.rating'],[originalTable,'note.peerCount'],[mirrorTable,'note.rating'],[mirrorTable,'note.peerCount']];

// Full independent configuration model: never derive expected mutations from a
// saved result or use the product serializer. Comments are checked separately.
export function assertSummaryConfiguration(yaml,source,expected){
  assert.deepEqual(yaml.parse(source),expected,'Whole independently expected Base configuration');
  assert.match(source,/^# Supplemental property interaction fixture$/m,'Original Base comment survives');
}
async function openSummary(c,name){
  const selector=footer(name);
  if(await c.ui.dom(`const e=document.querySelector(${esc(selector)});return !!e?.getClientRects().length&&!e.closest('[hidden]');`))await c.ui.click(selector);
  else{await c.ui.click(`${active} [role="columnheader"][title=${esc(name)}]`,{button:'right'});await c.ui.button('Summarize...','.context-menu');}
  await c.ui.wait(`return !!document.querySelector('.zorid-bases-summary-picker');`,'C1 summary picker opens through normal controls');
}
async function closeSummaryEditor(c){
  await c.ui.button('Back to summaries',summaryEditor);
  await c.ui.wait(`return !document.querySelector(${esc(summaryEditor)})&&!!document.querySelector('.zorid-bases-summary-picker');`,'C1 acknowledged editor returns to picker');
  await c.ui.key('Escape');await c.ui.wait(`return !document.querySelector('.zorid-bases-summary-picker');`,'C1 picker dismissed');await c.ui.idle();
}
async function summaryDisplay(c,property,name,value){
  await c.ui.wait(`const e=document.querySelector(${esc(footer(property))});return e?.querySelector('.summary-function-name')?.textContent===${esc(name)}&&e.querySelector('.summary-function-value')?.textContent===${esc(String(value))};`,'C1 published '+property+' summary '+name+' = '+value);
}
async function customSummaryReferences(c,expected,durableConfig){
  const selection=(view,name,id)=>{const target=expected.views.find(v=>v.name===view);assert.ok(target);(target.summaries??={})[name]=id;};
  async function select(view,property,id,value){
    await openSummary(c,property);await c.ui.click(`.zorid-bases-summary-picker [role="option"][data-summary-id=${esc(id)}]`);
    selection(view,property,id);await durableConfig('C1-selected-'+view+'-'+property+'-'+id);await summaryDisplay(c,property,id,value);await c.ui.idle();
  }
  async function create(view,property,name,expression,value){
    await openSummary(c,property);await c.ui.type('.zorid-bases-summary-picker input[aria-label="Find or create summary"]',name);await c.ui.button('Add summary: '+name,'.zorid-bases-summary-picker');
    (expected.summaries??={})[name]='';selection(view,property,name);await durableConfig('C1-created-shared-definition-'+name);
    await c.ui.wait(`return document.querySelector(${esc(summaryEditor)})?.querySelector('input[aria-label="Summary name"]')?.value===${esc(name)};`,'C1 exact custom editor');
    await c.ui.type(summaryInput('Summary expression'),expression);expected.summaries[name]=expression;await durableConfig('C1-custom-definition-expression-'+name);await closeSummaryEditor(c);await summaryDisplay(c,property,name,value);
  }
  // Duplicate an unconfigured table through the normal View actions before any
  // summary selection. Both views must acquire references by actual picker use.
  await chooseView(c,originalTable);await c.ui.button('Views',active);await c.ui.button('Configure view '+originalTable,dialog('Views'));await c.ui.button('View actions',dialog('View options'));await c.ui.button('Duplicate view',dialog('View options'));
  const copy=structuredClone(expected.views.find(v=>v.name===originalTable));copy.name='Property table 2';expected.views.push(copy);await durableConfig('C1-normal-table-copy-before-summary-selections');
  await c.ui.wait(`return document.querySelector(${esc(dialog('View options'))})?.querySelector('input[aria-label="View name"]')?.value==='Property table 2';`,'C1 exact acknowledged duplicate configuration');
  await c.ui.type(`${dialog('View options')} input[aria-label="View name"]`,mirrorTable);await c.ui.key('Enter');copy.name=mirrorTable;await durableConfig('C1-normal-mirror-view-name');
  await c.ui.wait(`const panel=document.querySelector(${esc(dialog('View options'))}),name=panel?.querySelector('input[aria-label="View name"]');return name?.value===${esc(mirrorTable)}&&!name.disabled&&panel.querySelector('[role="alert"]')?.textContent==='';`,'C1 view-name save acknowledged in visible panel');
  await c.ui.button('Close menu',dialog('View options'));await c.ui.wait(`return !document.querySelector(${esc(dialog('View options'))});`,'C1 view configuration closes through its normal button');await c.ui.idle();

  await chooseView(c,originalTable);await create(originalTable,'note.rating',sharedSummary,sharedExpression,2);await select(originalTable,'note.peerCount',sharedSummary,2);await create(originalTable,'note.done',keptSummary,keptExpression,42);
  await chooseView(c,mirrorTable);await select(mirrorTable,'note.rating',sharedSummary,2);await select(mirrorTable,'note.peerCount',sharedSummary,2);await select(mirrorTable,'note.done','Checked',1);
  await durableConfig('C1-four-independent-shared-selections-and-two-unrelated-selections');
  c.evidence.checks.push({name:'C1-shared-custom-selected-through-picker-across-two-views-and-properties',targets:sharedTargets,unrelated:[[originalTable,'note.done',keptSummary],[mirrorTable,'note.done','Checked']]});

  await chooseView(c,originalTable);await openSummary(c,'note.rating');await c.ui.button('Edit '+sharedSummary,'.zorid-bases-summary-picker');
  for(const [attempt,message,label]of [['   ','Summary name must not be empty.','blank'],[keptSummary,'A summary with this name already exists','collision']]){
    const before=await durableConfig('C1-before-'+label+'-rename-guard');
    await c.ui.type(summaryInput('Summary name'),attempt);await c.ui.key('Enter');
    await c.ui.wait(`const e=document.querySelector(${esc(summaryEditor)});return e?.querySelector('input[aria-label="Summary name"]')?.value===${esc(attempt)}&&e.querySelector('[role="alert"]')?.textContent===${esc(message)};`,'C1 explicit '+label+' rename guard');
    await c.saved(baseFile,source=>{assert.equal(source,before,'Rejected rename cannot write Base bytes');assertSummaryConfiguration(c.yaml,source,expected);},'C1-'+label+'-rename-preserves-all-config-and-source-bytes');
  }
  await c.ui.type(summaryInput('Summary name'),renamedSummary);await c.ui.key('Enter');
  delete expected.summaries[sharedSummary];expected.summaries[renamedSummary]=sharedExpression;
  for(const [view,property]of sharedTargets)selection(view,property,renamedSummary);
  await durableConfig('C1-rename-updates-all-four-references-preserves-unrelated-custom-and-builtin');await closeSummaryEditor(c);
  for(const name of [originalTable,mirrorTable]){
    await chooseView(c,name);for(const property of ['note.rating','note.peerCount'])await summaryDisplay(c,property,renamedSummary,2);
    await summaryDisplay(c,'note.done',name===originalTable?keptSummary:'Checked',name===originalTable?42:1);
  }
  await c.screenshot('properties-06a-cross-view-summary-rename');

  // Delete from the mirror to prove scope is the definition, not active view.
  await openSummary(c,'note.peerCount');await c.ui.button('Edit '+renamedSummary,'.zorid-bases-summary-picker');await c.ui.button('Summary actions',summaryEditor);await c.ui.button('Delete summary',summaryEditor);
  delete expected.summaries[renamedSummary];for(const [view,property]of sharedTargets)delete expected.views.find(v=>v.name===view).summaries[property];
  await durableConfig('C1-delete-from-mirror-clears-all-four-references-preserves-unrelated-config');
  await c.ui.wait(`return !document.querySelector(${esc(summaryEditor)})&&!!document.querySelector('.zorid-bases-summary-picker');`,'C1 deletion returns to picker');await c.ui.key('Escape');await c.ui.wait(`return !document.querySelector('.zorid-bases-summary-picker');`,'C1 deletion picker closes');
  for(const name of [originalTable,mirrorTable])await verifySummaryDeletion(c,name);
  c.evidence.checks.push({name:'C1-rename-and-delete-propagate-all-four-exact-references',targets:sharedTargets,deletedDefinition:renamedSummary,preservedCustomDefinition:{[keptSummary]:keptExpression}});
  await chooseView(c,originalTable);
}
async function verifySummaryDeletion(c,name){
  await chooseView(c,name);await summaryDisplay(c,'note.done',name===originalTable?keptSummary:'Checked',name===originalTable?42:1);
  await c.ui.wait(`return ${JSON.stringify(['note.rating','note.peerCount'])}.every(property=>{const cell=document.querySelector(${esc(active+' .zorid-bases-table-footer')}+' [data-summary-property='+JSON.stringify(property)+']');return cell?.isConnected&&cell.getClientRects().length&&!cell.closest('[hidden]')&&cell.dataset.summaryGroup==='overall'&&!cell.querySelector('.summary-function-name,.summary-function-value')&&cell.querySelector('.placeholder')?.textContent==='Summarize';});`,'C1 actual footer cells have neither deleted summary label nor value in '+name);
}

export async function journey(c){
  const expected=structuredClone(initial),expectedRaw=fixtureFiles();
  const expectedConfig=c.yaml.parse(expectedRaw.get(baseFile));
  const configSource=source=>assertSummaryConfiguration(c.yaml,source,expectedConfig);
  const durableConfig=name=>c.saved(baseFile,configSource,name);
  const expectedFile=(file,source,raw)=>file===baseFile?configSource(source):assert.equal(source,raw,'Independent full raw source: '+file);
  const rawStep=(name,file=alpha)=>expectedRaw.set(file,applyRawEdit(expectedRaw.get(file),name));
  async function saved(file,name){return c.saved(file,source=>{assert.deepEqual(c.frontmatter(source),expected[file]);assert.equal(body(source),bodies[file]);assert.equal(source,expectedRaw.get(file),'Independent raw source (quotes/comments/full body): '+file);},name);}
  await c.launch('supplemental-properties-authoring');await c.ui.openFile('Properties.base');await c.ui.idle();
  await c.ui.wait(`return document.querySelector('${active} [role="grid"]')?.getAttribute('aria-rowcount')==='3';`,'Exactly two ordinary source rows');
  await c.screenshot('properties-01-table');

  // P1: ordinary text, inline tags and a plain-link selection via real controls.
  await editText(c,property('table',alpha,'blurb'),'Table text 🌱');expected[alpha].blurb='Table text 🌱';rawStep('tableText');await saved(alpha,'P1-table-text-exact-yaml-body');
  await addTag(c,property('table',alpha,'tags'),'table-tag');expected[alpha].tags.push('table-tag');rawStep('tableTag');await saved(alpha,'P1-table-tags-readable-list');
  await pick(c,property('table',alpha,'reference'),'Grace');expected[alpha].reference='[[/Targets/Grace.md]]';rawStep('tableLink');await saved(alpha,'P1-plain-link-exact-rooted-choice');

  // P2: status category/color and picker-created options, not settings APIs.
  await c.ui.wait(`return document.querySelector(${esc(property('table',alpha,'status'))}+' [data-category="todo"][data-color="gray"]')?.textContent==='Planned';`,'Configured todo category and color visible');
  await pick(c,property('table',alpha,'status'),'Working');expected[alpha].status='Working';rawStep('tableStatus');await saved(alpha,'P2-status-readable-value');
  await c.ui.wait(`return document.querySelector(${esc(property('table',alpha,'status'))}+' [data-category="in-progress"][data-color="orange"]')?.textContent==='Working';`,'Selected status category and color retained');
  await pick(c,property('table',alpha,'priority'),'Picker priority',{create:true});expected[alpha].priority='Picker priority';rawStep('tablePriority');rawStep('priorityOption','Properties.yaml');await c.saved('Properties.yaml',source=>assert.equal(source,expectedRaw.get('Properties.yaml')),'P2-created-select-option-independent-raw-registry');await saved(alpha,'P2-select-create-option-and-select');
  await pick(c,property('table',alpha,'topics'),'Picker topic',{create:true,multiple:true});expected[alpha].topics.push('Picker topic');rawStep('tableTopics');rawStep('topicOption','Properties.yaml');await c.saved('Properties.yaml',source=>assert.equal(source,expectedRaw.get('Properties.yaml')),'P2-created-multiselect-option-independent-raw-registry');await saved(alpha,'P2-multiselect-create-preserves-unknown');
  await c.saved('Properties.yaml',source=>{const p=c.yaml.parse(source).properties;assert.ok(p.priority.options.some(o=>o.value==='Picker priority'));assert.ok(p.topics.options.some(o=>o.value==='Picker topic'));assert.equal(p.status.options.find(o=>o.value==='Working').category,'in-progress');},'P2-picker-options-durable-shared-registry');

  // P3: normal note panel consumes typed display but preserves its raw alias.
  await c.ui.openFile(alpha);
  const noteAuthor=`${active} [data-property-key="author"] .metadata-property-value`;
  await c.ui.wait(`const e=document.querySelector(${esc(noteAuthor)});return e?.querySelector('.multi-select-pill[role="link"]')&&!e.querySelector('.is-unresolved');`,'Ordinary note relation is core-resolved and clickable');
  await c.screenshot('properties-02-note-typed-relation');await c.ui.click(`${noteAuthor} .multi-select-pill[role="link"]`);
  await c.ui.wait(`return document.querySelector('${active}')?.innerText.includes('Author Ada sentinel.');`,'Typed relation opens actual Ada target');await saved(alpha,'P3-typed-display-navigation-never-rewrites-alias');
  await c.ui.openFile('Properties.base');await c.ui.idle();await view(c,'table');

  // P4: add and remove a new relation while alias and unresolved text survive.
  await pick(c,property('table',alpha,'peers'),'Alpha',{multiple:true});expected[alpha].peers.push('[[/Items/Alpha.md]]');rawStep('addPeer');await saved(alpha,'P4-relation-add-preserves-alias-and-unresolved');
  await openPicker(c,property('table',alpha,'peers'));await c.ui.button('Remove [[/Items/Alpha.md]]','.bases-property-popover');await c.ui.wait(`return !document.querySelector('[data-base-editing="pending"]');`,'Relation removal saved');await c.ui.key('Escape');await c.ui.idle();expected[alpha].peers.pop();rawStep('removePeer');await saved(alpha,'P4-relation-remove-preserves-originals');

  // P5: real edits in every alternative layout; each is checked against disk.
  await view(c,'cards');await editText(c,property('cards',alpha,'blurb'),'Cards text 🌱');expected[alpha].blurb='Cards text 🌱';rawStep('cardsText');await saved(alpha,'P5-cards-text-edit');await addTag(c,property('cards',alpha,'tags'),'cards-tag');expected[alpha].tags.push('cards-tag');rawStep('cardsTag');await saved(alpha,'P5-cards-tags-edit');await c.screenshot('properties-03-cards');
  await view(c,'list');await visible(c,property('list',alpha,'blurb'),'Cards text 🌱');await pick(c,property('list',alpha,'priority'),'High');expected[alpha].priority='High';rawStep('listPriority');await saved(alpha,'P5-list-select-edit');await pick(c,property('list',alpha,'reference'),'Ada');expected[alpha].reference='[[/Targets/Ada.md]]';rawStep('listLink');await saved(alpha,'P5-list-plain-link-edit');await c.screenshot('properties-04-list');
  await view(c,'kanban');await visible(c,property('kanban',alpha,'priority'),'High');await pick(c,property('kanban',alpha,'status'),'Complete');expected[alpha].status='Complete';rawStep('boardStatus');await saved(alpha,'P5-kanban-status-moves-row');
  const membership=await c.ui.wait(`const rows=[...document.querySelectorAll('${active} .bases-kanban-card')].filter(e=>e.dataset.path===${esc(alpha)});if(rows.length!==1)return false;const body=rows[0].closest('.bases-kanban-column-body[role="listbox"]');return body?.getAttribute('aria-label')==='Complete'?{file:rows[0].dataset.path,column:body.getAttribute('aria-label'),matchingMountedRows:rows.length}:false;`,'Saved status publishes Alpha in actual Complete Kanban column');c.evidence.checks.push({name:'P5-kanban-actual-column-membership-after-status-save',...membership});await pick(c,property('kanban',alpha,'topics'),'Rust',{multiple:true});expected[alpha].topics.push('Rust');rawStep('boardTopics');await saved(alpha,'P5-kanban-multiselect-edit');await c.screenshot('properties-05-kanban');

  // P6: derived fields have values, but no edit inputs or durable note writes.
  for(const layout of ['table','cards','list','kanban']){
    await view(c,layout);await c.ui.wait(`return document.querySelector(${esc(property(layout,beta,'peerCount'))})?.textContent.trim()==='1';`,'Exact derived count 1 in '+layout);
    for(const name of ['peerCount','incoming']){
      const selector=property(layout,beta,name);
      await c.ui.wait(`const e=document.querySelector(${esc(selector)});return e&&!e.hasAttribute('data-base-editing')&&!e.querySelector('input.metadata-input,textarea,[contenteditable="true"]');`,'Derived readonly presentation '+layout+' '+name);
    }
    c.evidence.checks.push({name:'P6-derived-readonly-control-presentation-'+layout,properties:['peerCount','incoming'],interaction:layout==='table'?'padding-pointer-and-Enter-below':'inspection-only; normal card/list values may navigate their file'});
    if(layout==='table'){await readOnlyAttempt(c,layout,beta,'peerCount',expectedRaw.get(beta));await readOnlyAttempt(c,layout,beta,'incoming',expectedRaw.get(beta));}
  }
  await view(c,'table');await visible(c,property('table',alpha,'blurb'),'Cards text 🌱');await visible(c,property('table',alpha,'priority'),'High');await visible(c,property('table',alpha,'status'),'Complete');
  await customSummaryReferences(c,expectedConfig,durableConfig);
  for(const file of [alpha,beta])await saved(file,'P7-final-exact-properties-'+file);
  for(const [file,source]of expectedRaw)await c.saved(file,current=>expectedFile(file,current,source),'P7-independent-source-or-config-oracle-'+file);
  await c.quit('P7-normal-quit-after-property-edits');
  // Offline oracles run after normal process termination, never by an in-app hook.
  for(const [file,source]of expectedRaw)expectedFile(file,await c.read(file),source);
  c.evidence.checks.push({name:'P7-offline-note-and-registry-byte-and-base-config-oracle',files:[...expectedRaw.keys()],baseConfiguration:structuredClone(expectedConfig)});
  await c.launch('supplemental-properties-restart');await c.ui.openFile('Properties.base');await c.ui.idle();await view(c,'table');
  await visible(c,property('table',alpha,'blurb'),'Cards text 🌱');await visible(c,property('table',alpha,'topics'),'Picker topic');await visible(c,property('table',alpha,'status'),'Complete');
  for(const name of [originalTable,mirrorTable])await verifySummaryDeletion(c,name);await chooseView(c,originalTable);
  for(const [file,source]of expectedRaw)await c.saved(file,current=>expectedFile(file,current,source),'P7-restart-independent-source-or-config-'+file);
  await c.screenshot('properties-06-restart');await c.quit('P7-normal-quit-after-restart');
}
