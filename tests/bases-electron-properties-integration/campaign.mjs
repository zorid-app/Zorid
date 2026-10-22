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

export async function journey(c){
  const expected=structuredClone(initial),expectedRaw=fixtureFiles();
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
  for(const file of [alpha,beta])await saved(file,'P7-final-exact-properties-'+file);
  for(const [file,source]of expectedRaw)await c.saved(file,current=>assert.equal(current,source),'P7-independent-full-source-oracle-'+file);
  await c.quit('P7-normal-quit-after-property-edits');
  // Offline oracles run after normal process termination, never by an in-app hook.
  for(const [file,source]of expectedRaw)assert.equal(await c.read(file),source,'Exact bytes after normal quit: '+file);
  c.evidence.checks.push({name:'P7-offline-note-and-registry-byte-oracle',files:[...expectedRaw.keys()]});
  await c.launch('supplemental-properties-restart');await c.ui.openFile('Properties.base');await c.ui.idle();await view(c,'table');
  await visible(c,property('table',alpha,'blurb'),'Cards text 🌱');await visible(c,property('table',alpha,'topics'),'Picker topic');await visible(c,property('table',alpha,'status'),'Complete');
  for(const [file,source]of expectedRaw)await c.saved(file,current=>assert.equal(current,source),'P7-restart-exact-bytes-'+file);
  await c.screenshot('properties-06-restart');await c.quit('P7-normal-quit-after-restart');
}
