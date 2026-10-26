import assert from 'node:assert/strict';
import {fixtureFiles,cases,records,base,roundTripSources} from './fixtures.mjs';
import {assertMembership,assertConfiguration,expectedPaths} from './oracles.mjs';
import {closeTypedFilter as close} from './close-readiness.mjs';
export {fixtureFiles,vaultName} from './fixtures.mjs';
const active='.pane.is-active .bases-session',panel='[role="dialog"][aria-label="Filter"]';
const local=panel+' .bases-filter-section:nth-of-type(2)',root=local+' .bases-filter-tree > .bases-filter-group';
const row=number=>root+` > .bases-filter-condition:nth-of-type(${number})`;
const value=scope=>scope+' input[aria-label="Filter value"]';
async function choose(c,name){await c.ui.button('Views',active);await c.ui.button('Open view '+name,'[role="dialog"][aria-label="Views"]');await c.ui.wait(`return document.querySelector('${active} [aria-label="Views"]')?.textContent===${JSON.stringify(name)};`,'Selected exact filter view '+name);}
async function membership(c,ids,name){
  const paths=expectedPaths(ids);
  const actual=await c.ui.wait(`const grid=document.querySelector('${active} [role="grid"]');if(grid?.getAttribute('aria-rowcount')!==${JSON.stringify(String(paths.length+1))})return false;const paths=[...grid.querySelectorAll('.zorid-bases-table-body .zorid-bases-table-row')].map(e=>e.querySelector('[data-path]')?.dataset.path);return JSON.stringify(paths)===${JSON.stringify(JSON.stringify(paths))}?paths:false;`,name);
  assertMembership(actual,ids);c.evidence.checks.push({name,paths:actual});
}
async function saved(c,expression,name){return c.saved('Typed filters.base',source=>assertConfiguration(c.yaml,source,expression),name);}
async function boolean(c,selector,expected){
  let state=await c.ui.wait(`const e=document.querySelector(${JSON.stringify(selector)});return e?.type==='checkbox'?{checked:e.checked,indeterminate:e.indeterminate}:false;`,'Real checkbox operand');
  if(state.indeterminate){await c.ui.click(selector);state=await c.ui.dom(`const e=document.querySelector(${JSON.stringify(selector)});return {checked:e.checked,indeterminate:e.indeterminate};`);}
  if(state.checked!==expected)await c.ui.click(selector);
  await c.ui.wait(`const e=document.querySelector(${JSON.stringify(selector)});return e?.checked===${expected}&&e.indeterminate===false;`,'Checkbox operand has exact Boolean value');
}
async function operand(c,scope,item){
  if(['isEmpty','isNotEmpty'].includes(item.operator)){
    await c.ui.wait(`const e=document.querySelector(${JSON.stringify(scope+' .bases-filter-values')});return !!e&&!e.querySelector('input,select,textarea,button');`,'No RHS controls for empty predicate');return;
  }
  if(item.property==='file.file'){
    for(const text of item.values){await c.ui.type(value(scope),text);if(item.operator==='hasTag'||item.operator==='notHasTag')await c.ui.key('Enter');else await c.ui.key('Tab');}
    return;
  }
  const list=['items','mixed'].includes(item.property),chips=list||['containsAny','notContainsAny','containsAll','notContainsAll'].includes(item.operator);
  if(chips){
    if(!item.values.length){await c.ui.button('Empty list',scope);return;}
    for(const literal of item.values){
      if(list){const type=literal===null?'Null':typeof literal==='number'?'Number':typeof literal==='boolean'?'Checkbox':'Text';await c.ui.select(scope+' select[aria-label="Item type"]',type);}
      if(literal!==null){if(typeof literal==='boolean')await boolean(c,value(scope),literal);else await c.ui.type(value(scope),String(literal));}
      await c.ui.button('Add item',scope);
    }
    return;
  }
  const literal=item.values[0];
  if(literal===null){await c.ui.button('Clear value',scope);return;}
  if(typeof literal==='boolean'){await boolean(c,value(scope),literal);return;}
  await c.ui.type(value(scope),String(literal));
  // Native date/datetime controls must actually accept the trusted input. A
  // platform input limitation fails here; no DOM assignment or constructor
  // expression is used to conceal it.
  await c.ui.wait(`return document.querySelector(${JSON.stringify(value(scope))})?.value===${JSON.stringify(String(literal))};`,'Exact visible operand value');await c.ui.key('Tab');
}
async function untouched(c,initial,label){
  for(const[file,source]of initial)if(file!=='Typed filters.base')assert.equal(await c.read(file),source,'Filter UI cannot rewrite '+file);
  c.evidence.checks.push({name:label,files:[...initial.keys()].filter(file=>file!=='Typed filters.base')});
}
async function reopened(c,item){
  const scope=row(1),state=await c.ui.wait(`const r=document.querySelector(${JSON.stringify(scope)}),widget=r?.querySelector('.bases-filter-values');if(!r||!widget||r.querySelector('textarea[aria-label="Filter expression"]'))return false;const field=widget.querySelector('input[aria-label="Filter value"]'),type=widget.querySelector('select[aria-label="Item type"]');const visible=e=>!!e?.getClientRects().length&&!e.closest('[hidden]');return {property:r.querySelector('select[aria-label="Filter property"]')?.value,operator:r.querySelector('select[aria-label="Condition"]')?.value,controls:widget.querySelectorAll('input,select,textarea,button').length,field:field?{type:field.type,value:field.value,inputMode:field.inputMode,checked:field.checked,indeterminate:field.indeterminate,visible:visible(field)}:null,chips:[...widget.querySelectorAll('.bases-filter-operand-chip')].map(e=>({label:e.querySelector('span')?.textContent,visible:visible(e)})),itemTypes:type?[...type.options].map(e=>e.value):null,itemTypeVisible:!!type&&visible(type.hidden?type.nextElementSibling:type)};`,'Supported filter reopens with structured typed controls');
  const explicitNull=item.values.length===1&&item.values[0]===null;
  assert.equal(state.property,item.property==='file.file'?'file.file':'note.'+item.property);
  assert.equal(state.operator,explicitNull?(item.operator==='neq'?'set':'unset'):item.operator,'Exact reopened operator including null compatibility');
  const none=explicitNull||['isEmpty','isNotEmpty'].includes(item.operator);
  if(none)assert.equal(state.controls,0,'No RHS controls for empty/null convenience');
  else if(['items','mixed'].includes(item.property)||['containsAny','notContainsAny','containsAll','notContainsAll'].includes(item.operator)||(item.property==='file.file'&&['hasTag','notHasTag'].includes(item.operator))){
    assert.deepEqual(state.chips.map(chip=>chip.label),item.values.map(String),'Reopened literal label/order');assert.ok(state.chips.every(chip=>chip.visible));
    assert.ok(state.field?.visible,'Chip draft field is visible');
    if(item.property!=='file.file'){
      assert.ok(state.itemTypeVisible,'Typed member selector is actually presented');
      if(item.property==='text')assert.deepEqual(state.itemTypes,['string'],'String variadic operands remain Text only');
      else for(const kind of ['string','number','boolean','null'])assert.ok(state.itemTypes.includes(kind));
    }
  }else{
    assert.ok(state.field?.visible,'Actual scalar RHS editor is visible');
    if(item.property==='enabled'){assert.equal(state.field.type,'checkbox');assert.equal(state.field.checked,item.values[0]);assert.equal(state.field.indeterminate,false);}
    else{assert.equal(state.field.type,item.property==='due'?'date':item.property==='moment'?'datetime-local':'text');assert.equal(state.field.value,String(item.values[0]));if(item.property==='amount')assert.equal(state.field.inputMode,'decimal');}
  }
  c.evidence.checks.push({name:'typed-filter-reopened-controls-'+item.id,state});
  if(roundTripSources[item.id]){
    // Visible Number1 and String"1" chips have the same label. A real edit plus
    // the complete expected expression proves retained types without private
    // widget state. Also pins one-array versus variadic argument rehydration.
    await c.ui.button('Remove item '+String(item.values.at(-1)),scope);
    await saved(c,roundTripSources[item.id],'typed-filter-reopened-remove-retains-types-'+item.id);
    await operand(c,scope,{...item,values:[item.values.at(-1)]});
    await saved(c,item.expression,'typed-filter-reopened-readd-retains-shape-'+item.id);
  }
}
async function scenario(c,item){
  await c.ui.button('Filter',active);await c.ui.button('Add filter',local);
  await c.ui.select(row(2)+' select[aria-label="Filter property"]',item.property==='file.file'?'file.file':'note.'+item.property);
  await c.ui.select(row(2)+' select[aria-label="Condition"]',item.operator);await operand(c,row(2),item);await close(c);
  const source=await saved(c,item.expression,'typed-filter-source-'+item.id);
  await membership(c,item.members,'typed-filter-membership-'+item.id);
  await c.ui.button('Filter',active);
  await reopened(c,item);
  if(item.id==='string-zero-results'){
    const operators=await c.ui.dom(`return [...document.querySelector(${JSON.stringify(row(1)+' select[aria-label="Condition"]')}).options].map(e=>e.value);`);
    for(const op of ['startsWith','endsWith','containsAny','containsAll','isEmpty'])assert.ok(operators.includes(op),'Captured String catalog survives zero results');
    for(const op of ['lt','lte','gt','gte'])assert.ok(!operators.includes(op),'No guessed numeric operators from missing result rows');
    c.evidence.checks.push({name:'string-descriptor-retained-with-zero-query-rows',operators});
  }
  await close(c);await c.saved('Typed filters.base',actual=>assert.equal(actual,source),(roundTripSources[item.id]?'typed-filter-edit-roundtrip-byte-exact-':'opening-supported-filter-does-not-rewrite-')+item.id);
  await c.ui.button('Filter',active);await c.ui.button('Remove filter',row(1));await close(c);
  await saved(c,undefined,'typed-filter-clear-'+item.id);await membership(c,records.map(record=>record.id),'typed-filter-clear-membership-'+item.id);
}
export async function journey(c){
  c.evidence.kind='actual-electron-bases-typed-filters';
  c.evidence.limitations.push('Source-authored typed operator campaign; actual execution is required. Native date/datetime acceptance must pass field readback without DOM assignment. Reference typed controls were audited statically; this does not establish reference runtime or visual parity.');
  const initial=fixtureFiles();await c.launch('typed-filter-author');await c.ui.openFile('Typed filters.base');
  await membership(c,records.map(record=>record.id),'typed-filter-five-record-baseline');
  await c.ui.button('Filter',active);await c.ui.button('Add filter',local);
  assert.equal(await c.read('Typed filters.base'),base,'Adding a local blank does not immediately publish a Base write');
  await close(c);await c.saved('Typed filters.base',source=>assert.equal(source,base),'blank-File-and-added-filter-stay-local');
  for(const item of cases)await scenario(c,item);
  await c.screenshot('01-all-typed-filters-cleared');await untouched(c,initial,'all-filter-operand-edits-preserve-notes-and-registry');
  await choose(c,'Unknown source');await membership(c,['B'],'unknown-loaded-expression-membership');
  const before=await c.read('Typed filters.base');await c.ui.button('Filter',active);
  await c.ui.wait(`return document.querySelector(${JSON.stringify(row(1)+' textarea[aria-label="Filter expression"]')})?.value==='note.amount > max(1, 2)';`,'Unknown expression remains exact advanced source');
  await close(c);await c.saved('Typed filters.base',source=>assert.equal(source,before),'unknown-expression-open-close-byte-exact');
  await c.screenshot('02-unknown-source-retained');
  for(const[name,ids]of[['Offset source',['A']],['Single-list source',['A','B','C','E']]]){
    await choose(c,name);await membership(c,ids,'loaded-'+name+'-membership');const prior=await c.read('Typed filters.base');
    await c.ui.button('Filter',active);await close(c);await c.saved('Typed filters.base',source=>assert.equal(source,prior),'loaded-'+name+'-open-close-byte-exact');
  }
  await c.quit('typed-filter-normal-quit');
  await c.launch('typed-filter-fresh-process');await c.ui.openFile('Typed filters.base');await choose(c,'Unknown source');
  await membership(c,['B'],'unknown-expression-fresh-process-membership');await saved(c,undefined,'typed-filter-configuration-restart-exact');
  for(const[name,ids]of[['Offset source',['A']],['Single-list source',['A','B','C','E']]]){await choose(c,name);await membership(c,ids,'fresh-process-'+name+'-membership');}
  await choose(c,'Typed');await membership(c,records.map(record=>record.id),'typed-filter-cleared-fresh-process-five-records');
  await untouched(c,initial,'fresh-process-all-notes-and-registry-exact');await c.quit('typed-filter-restart-normal-quit');
}
