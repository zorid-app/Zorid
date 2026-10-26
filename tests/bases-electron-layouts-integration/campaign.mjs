import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {delay} from '../tasks-electron-integration/cdp.mjs';
import {MOD} from '../bases-electron-integration/ui.mjs';
import {fixtureFiles, names, hoverTextFiles} from './fixtures.mjs';
import {hoverJourney} from './hover.mjs';
import {beginDrag, assertWikiPayload} from './drag.mjs';
import {columnOrderSource,layoutNoteSurface,withLayoutCheckpointFailure} from './checkpoint-fault.mjs';
import {assertOriginalInlineCheckpointRetry} from '../bases-electron-safety-integration/inline-checkpoint-fault.mjs';
export {fixtureFiles};
export {createNativeRelay} from '../bases-electron-recovery-integration/control.mjs';
export const vaultName = 'LayoutInteractions';
const active = '.pane.is-active .bases-session';
const panel = name => `[role="dialog"][aria-label=${JSON.stringify(name)}]`;
const row = (kind, name) => `${active} .bases-${kind}-${kind === 'cards' ? 'item' : kind === 'list' ? 'item' : 'card'}[data-path=${JSON.stringify('Items/' + name + '.md')}]`;
const column = label => `${active} .bases-kanban-column:has(.bases-kanban-column-body[aria-label=${JSON.stringify(label)}])`;
const files = ['Layouts.base', ...names.map(name => `Items/${name}.md`), ...hoverTextFiles.keys()];
const selectedView = c => c.ui.dom(`return document.querySelector('${active} button[aria-label="Views"]')?.textContent;`);
async function choose(c, name) { await c.ui.button('Views', active); await c.ui.button('Open view ' + name, panel('Views')); await c.ui.wait(`return document.querySelector('${active} button[aria-label="Views"]')?.textContent===${JSON.stringify(name)};`, 'Actual selected layout ' + name); await c.ui.idle(); }
async function bytes(c) { return Object.fromEntries(await Promise.all(files.map(async file => [file, await c.read(file)]))); }
async function tabs(c) { return c.ui.dom(`return [...document.querySelectorAll('.pane')].map(p=>({active:p.classList.contains('is-active'),tabs:[...p.querySelectorAll(':scope > .tab-bar [role=tab]')].map(t=>({id:t.dataset.tabId,title:t.querySelector('.tab-title')?.textContent,active:t.getAttribute('aria-selected')==='true'}))}));`); }
async function baseTab(c) { const state = await tabs(c); assert.equal(state.length, 1, 'This bounded campaign owns one pane'); assert.equal(state[0].active, true); const tab = state[0].tabs.find(tab => tab.active); assert.equal(tab.title, 'Layouts'); return tab.id; }
async function selectTab(c, id) { await c.ui.click(`[role="tab"][data-tab-id=${JSON.stringify(id)}]`); await c.ui.wait(`return document.querySelector('[role=tab][data-tab-id='+CSS.escape(${JSON.stringify(id)})+']')?.getAttribute('aria-selected')==='true';`, 'Selected exact retained tab ID'); }
async function newTabOracle(c, before, title, action) {
  await action();
  const after = await c.ui.wait(`const panes=[...document.querySelectorAll('.pane')];if(panes.length!==1)return false;const tabs=[...panes[0].querySelectorAll(':scope > .tab-bar [role=tab]')].map(t=>({id:t.dataset.tabId,title:t.querySelector('.tab-title')?.textContent,active:t.getAttribute('aria-selected')==='true'}));return tabs.length===${before[0].tabs.length + 1}&&tabs.at(-1)?.active&&tabs.at(-1)?.title===${JSON.stringify(title)}?{active:panes[0].classList.contains('is-active'),tabs}:false;`, 'Exactly one new active note tab in the same pane');
  assert.deepEqual(after.tabs.slice(0, -1).map(tab => [tab.id, tab.title]), before[0].tabs.map(tab => [tab.id, tab.title]), 'Existing tab IDs/order remain unchanged');
  assert.ok(!before[0].tabs.some(tab => tab.id === after.tabs.at(-1).id)); assert.equal(after.active, true);
  return after.tabs.at(-1).id;
}
async function step(c, name, run) { const record = {name, status: 'running', started: Date.now()}; c.evidence.layoutCases.push(record); try { await run(); record.status = 'passed'; } catch (error) { record.status = 'failed'; record.failure = error.message; throw error; } finally { record.finished = Date.now(); } }
async function visiblePaths(c, kind) { return c.ui.dom(`return [...document.querySelectorAll('${active} .bases-${kind}-${kind === 'kanban' ? 'card' : 'item'}')].map(e=>e.dataset.path);`); }
async function noMutation(c, before, label) { assert.deepEqual(await bytes(c), before, label); }
async function capture(c, name) { await c.screenshot(name); }
const groupRow = label => `${panel('Group')} .bases-manual-group-row:has(input[aria-label=${JSON.stringify('Show group ' + label)}])`;
const groupGrip = label => `${groupRow(label)} .bases-manual-group-grip`;
async function menuOrder(c) { return c.ui.dom(`return [...document.querySelectorAll('${panel('Group')} .bases-manual-group-row')].map(e=>({name:e.querySelector('.bases-manual-group-name')?.textContent,top:e.getBoundingClientRect().top,height:e.getBoundingClientRect().height})).filter(e=>e.height>0).sort((a,b)=>a.top-b.top).map(e=>e.name);`); }
async function boardOrder(c) { return c.ui.dom(`return [...document.querySelectorAll('${active} .bases-kanban-column')].map(e=>({name:e.querySelector('.bases-kanban-column-body')?.getAttribute('aria-label'),left:e.getBoundingClientRect().left})).sort((a,b)=>a.left-b.left).map(e=>e.name);`); }
function orderConfiguration(c, source, viewName, order) { const expected = c.yaml.parse(source), views = expected.views.filter(view => view.name === viewName); assert.equal(views.length, 1); views[0].groupOrder = order; return expected; }
async function savedOrder(c, original, order, label) { const expected = orderConfiguration(c, original, 'Board', order); return c.saved('Layouts.base', source => assert.deepEqual(c.yaml.parse(source), expected), label); }

export async function journey(c) {
  assert.equal(typeof c.nativeContextMenu,'function','Layouts requires the explicit visible native context menu CUA mode');
  c.evidence.layoutCases = [];
  c.evidence.layoutScope = {unresolved: [],nativeMenuAcceptance:'Five mixed CDP/CUA checkpoints require separate actual native AX labels/order and input receipts. Runner continuation alone establishes no native menu observation.'};
  c.evidence.limitations.push('Source-authored supplemental campaign; its executed case list and retained result determine actual acceptance.', 'Native drag payloads are captured from Chromium; no receiving external application or OS Finder drag is exercised.', 'Formula-derived groups test per-column read-only behavior; typed/null/folder grouping belongs to the separate session campaign.', 'Matched Obsidian font/height pixel parity and rich property edits are outside these case assertions.', 'Hover physical-key-after-entry and physical key-release behavior are Zorid-only checks: the corresponding reference protocol phase did not reach a terminal assertion.');
  const expected = await bytes(c);
  await c.launch('supplemental-layout-interactions');
  await c.cdp.call('Emulation.setDeviceMetricsOverride', {width: 1360, height: 900, deviceScaleFactor: 1, mobile: false});
  await c.ui.openFile('Layouts.base'); await c.ui.idle();

  await step(c, 'Cards-and-List-group-collapse-exact-membership-no-save', async () => {
    for (const [name, kind] of [['Grouped cards', 'cards'], ['Grouped list', 'list']]) {
      if (await selectedView(c) !== name) await choose(c, name);
      assert.deepEqual(await visiblePaths(c, kind), ['Items/Alpha.md', 'Items/Gamma.md', 'Items/Beta.md', 'Items/Delta.md']);
      await c.ui.button('Todo', active); await c.ui.wait(`return document.querySelector('${active} button.bases-group-heading')?.getAttribute('aria-expanded')==='false';`, 'Collapsed Todo heading');
      assert.deepEqual(await visiblePaths(c, kind), ['Items/Beta.md', 'Items/Delta.md']);
      await capture(c, kind + '-group-collapsed'); await c.ui.button('Todo', active);
      await c.ui.wait(`return document.querySelector('${active} button.bases-group-heading')?.getAttribute('aria-expanded')==='true';`, 'Expanded Todo heading');
      assert.deepEqual(await visiblePaths(c, kind), ['Items/Alpha.md', 'Items/Gamma.md', 'Items/Beta.md', 'Items/Delta.md']);
    }
    await noMutation(c, expected, 'Collapsing/expanding changes no file bytes');
  });

  await step(c, 'all-layouts-modifier-and-middle-open-exact-pane-tab-identity', async () => {
    for (const [name, kind] of [['Grouped cards', 'cards'], ['Grouped list', 'list'], ['Board', 'kanban']]) {
      await choose(c, name); const retained = await baseTab(c);
      for (const options of [{modifiers: MOD.meta}, {button: 'middle'}]) {
        const before = await tabs(c), target = kind === 'list' ? `${row(kind, 'Alpha')} a.internal-link` : row(kind, 'Alpha');
        await newTabOracle(c, before, 'Alpha', () => c.ui.click(target, options));
        await c.ui.wait(`return (${layoutNoteSurface.toString()})(document,'Alpha');`, 'Opened exact ordinary note title and mounted public mode');
        await selectTab(c, retained); await c.ui.idle(); assert.equal(await selectedView(c), name);
      }
    }
    await noMutation(c, expected, 'Opening only never edits notes or Base configuration');
  });

  await step(c, 'all-layouts-file-context-open-and-bookmark-actions', async () => {
    for (const [name, kind, note] of [['Grouped cards', 'cards', 'Alpha'], ['Grouped list', 'list', 'Beta'], ['Board', 'kanban', 'Gamma']]) {
      await choose(c, name); const retained = await baseTab(c), target = kind === 'list' ? `${row(kind, note)} a.internal-link` : row(kind, note);
      await c.ui.click(target, {button: 'right'});
      // File menus use Electron's native menu, outside renderer DOM. The CUA
      // checkpoint requires separate actual AX labels/order and native input;
      // its control-flow signal cannot stand in for the product result below.
      const before = await tabs(c); await newTabOracle(c, before, note, () => c.nativeContextMenu(kind+'-open'));
      await selectTab(c, retained); await c.ui.idle();
      if (kind === 'cards') {
        await c.ui.click(target, {button: 'right'}); await c.nativeContextMenu('cards-bookmark');
        await c.ui.wait(`return Object.entries(localStorage).some(([key,raw])=>key.startsWith('zorid:workspace:')&&JSON.parse(raw).bookmarks?.includes('Items/Alpha.md'));`, 'Bookmark persisted by normal UI action');
        await c.ui.click(target, {button: 'right'}); await c.nativeContextMenu('cards-bookmark-state');
      }
    }
    await noMutation(c, expected, 'Context opening/bookmarking does not modify vault files');
  });

  await step(c, 'all-layouts-native-file-drag-payload', async () => {
    for (const [name, kind] of [['Grouped cards', 'cards'], ['Grouped list', 'list'], ['Board', 'kanban']]) {
      await choose(c, name); const source = kind === 'list' ? `${row(kind, 'Alpha')} [data-property="file.name"] a.internal-link` : row(kind, 'Alpha');
      const drag = await beginDrag(c, source);
      try { assertWikiPayload(drag.data, '[[Items/Alpha]]'); await capture(c, kind + '-native-file-drag'); }
      finally { await drag.cleanup(); }
    }
    await noMutation(c, expected, 'Cancelled file drags are inert');
  });

  await step(c, 'Kanban-column-live-insertion-Escape-cancel-and-durable-reorder', async () => {
    await choose(c, 'Board');
    const readOrder = async () => c.yaml.parse(await c.read('Layouts.base')).views.find(view => view.name === 'Board').groupOrder;
    const initial = await c.read('Layouts.base'), source = `${column('Todo')} .bases-kanban-column-header`, target = `${column('Done')} .bases-kanban-column-header`;
    const drag = await beginDrag(c, source);
    try {
      await drag.over(target); await c.ui.wait(`const a=document.querySelector(${JSON.stringify(column('Todo'))}),b=document.querySelector(${JSON.stringify(column('Done'))});return !!document.querySelector('${active} .bases-kanban-column-drop-placeholder')&&parseFloat(a.style.left)>parseFloat(b.style.left);`, 'Live insertion changes actual column positions');
      assert.equal(await c.read('Layouts.base'), initial, 'Preview has not saved configuration'); await capture(c, 'kanban-column-insertion-preview');
      await drag.escape(); await c.ui.wait(`return !document.querySelector('${active} .bases-kanban-column-drop-placeholder')&&!document.querySelector('${active} .bases-kanban-column.is-being-dragged');`, 'Actual Escape cancels native drag');
      assert.equal(await c.read('Layouts.base'), initial); assert.deepEqual(await readOrder(), ['Todo', 'Done', 'Later']);
    } finally { await drag.cleanup(); }
    const committed = await beginDrag(c, source);
    try {
      await committed.over(target); await c.ui.wait(`const a=document.querySelector(${JSON.stringify(column('Todo'))}),b=document.querySelector(${JSON.stringify(column('Done'))});return !!document.querySelector('${active} .bases-kanban-column-drop-placeholder')&&parseFloat(a.style.left)>parseFloat(b.style.left);`, 'Completed column drag previews insertion before drop');
      assert.equal(await c.read('Layouts.base'), initial, 'Committing drag still has no durable write before drop');
      await committed.dropAtLast();
    } finally { await committed.cleanup(); }
    await savedOrder(c, initial, ['Done', 'Todo', 'Later'], 'column-reorder-exact-saved-order');
    expected['Layouts.base'] = await c.read('Layouts.base'); await noMutation(c, expected, 'Only intended Base group order changed');
  });

  await step(c, 'normal-Group-menu-row-live-insertion-Escape-focus-and-durable-reorder', async () => {
    await c.ui.button('Group', active); assert.deepEqual(await menuOrder(c), ['Done', 'Todo', 'Later']);
    let focused;
    for (let index = 0; index < 48; index++) { await c.ui.key('Tab'); focused = await c.ui.dom(`const e=document.activeElement;return e?.matches(${JSON.stringify(groupRow('Done'))})?{id:e.dataset.groupId,name:e.querySelector('.bases-manual-group-name')?.textContent}:null;`); if (focused) break; }
    assert.ok(focused, 'Real Tab focus reaches the source manual group row');
    const initial = await c.read('Layouts.base'), source = groupGrip('Done'), target = groupRow('Todo'), drag = await beginDrag(c, source);
    try {
      await drag.over(target); await c.ui.wait(`const rows=[...document.querySelectorAll('${panel('Group')} .bases-manual-group-row')].map(e=>({name:e.querySelector('.bases-manual-group-name')?.textContent,top:e.getBoundingClientRect().top})).sort((a,b)=>a.top-b.top);return JSON.stringify(rows.map(e=>e.name))===${JSON.stringify(JSON.stringify(['Todo', 'Done', 'Later']))};`, 'Manual menu rows visibly insert before drop');
      assert.equal(await c.read('Layouts.base'), initial, 'Manual insertion preview has not saved'); await capture(c, 'Group-menu-live-insertion-preview');
      await drag.escape(); await c.ui.wait(`const p=document.querySelector('${panel('Group')}'),e=document.activeElement;return !!p&&e?.matches('.bases-manual-group-row')&&e.dataset.groupId===${JSON.stringify(focused.id)};`, 'Actual Escape retains Group menu and restores the exact source row focus');
      assert.deepEqual(await menuOrder(c), ['Done', 'Todo', 'Later']); assert.equal(await c.read('Layouts.base'), initial); await capture(c, 'Group-menu-Escape-restored-focus');
    } finally { await drag.cleanup(); }
    const commit = await beginDrag(c, source);
    try { await commit.over(target); assert.deepEqual(await menuOrder(c), ['Todo', 'Done', 'Later']); assert.equal(await c.read('Layouts.base'), initial); await commit.dropAtLast(); }
    finally { await commit.cleanup(); }
    const saved = await savedOrder(c, initial, ['Todo', 'Done', 'Later'], 'manual-Group-menu-reorder-durable-complete-configuration');
    assert.deepEqual(await menuOrder(c), ['Todo', 'Done', 'Later']);
    // Restore the fixture through the same ordinary Group UI for later cases/restart.
    await c.ui.drag(groupGrip('Todo'), groupRow('Done')); await savedOrder(c, saved, ['Done', 'Todo', 'Later'], 'manual-Group-menu-restore-durable-complete-configuration');
    await c.ui.key('Escape'); await c.ui.wait(`return !document.querySelector('${panel('Group')}');`, 'Group menu closes normally after accepted saves');
    expected['Layouts.base'] = await c.read('Layouts.base'); assert.deepEqual(await boardOrder(c), ['Done', 'Todo', 'Later']); await noMutation(c, expected, 'Only the selected view order changed through Group UI');
  });

  await step(c, 'failed-column-configuration-save-reconciles-and-retries-retained-source', async () => {
    const original=await c.read('Layouts.base'),wanted=orderConfiguration(c,original,'Board',['Todo','Done','Later']),retained=columnOrderSource(original);
    assert.deepEqual(c.yaml.parse(retained),wanted,'The independent exact source patch changes only Board group order');
    const proof=await withLayoutCheckpointFailure(c,{file:'Layouts.base',original,desired:retained,label:'column-configuration',
      submit:()=>c.ui.drag(`${column('Done')} .bases-kanban-column-header`,`${column('Todo')} .bases-kanban-column-header`),
      verifyFailure:async()=>{
        await c.ui.wait(`const text=[...document.querySelectorAll('${active} .bases-kanban-status,${active} .bases-session-status')].map(e=>e.textContent).join(' ');return /could not|failed|retained|checkpoint/i.test(text)?text:false;`,'Failed actual column configuration has visible recovery feedback',10000);
        assert.equal(await c.read('Layouts.base'),original,'Failed column save leaves exact durable configuration bytes unchanged');
        await c.ui.wait(`const columns=[...document.querySelectorAll('${active} .bases-kanban-column')].map(e=>({name:e.querySelector('.bases-kanban-column-body')?.getAttribute('aria-label'),left:e.getBoundingClientRect().left})).sort((a,b)=>a.left-b.left);return JSON.stringify(columns.map(e=>e.name))===${JSON.stringify(JSON.stringify(['Done','Todo','Later']))}&&!document.querySelector('${active} .bases-kanban-column-drop-placeholder');`,'Failed column preview reconciles to prior rendered order without an insertion placeholder');
        await capture(c,'failed-column-order-reconciled-retained-draft');
      }});
    assert.deepEqual(c.yaml.parse(proof.recovery.draft.content),wanted,'Retained native configuration draft changes only Board group order');
    c.evidence.checks.push({name:'failed-column-config-original-and-retained-draft',original,...proof.recovery,held:proof.held,negative:proof.negative});
    await c.ui.openFile('Items/Alpha.md');await c.saved('Layouts.base',source=>assert.equal(source,retained),'normal-navigation-retries-exact-retained-column-configuration');
    const replay=assertOriginalInlineCheckpointRetry((await c.relay.events()).slice(proof.offset),proof);c.evidence.checks.push({name:'column-configuration-exact-original-checkpoint-and-intent-retry',...replay});
    await c.ui.wait(`return (${layoutNoteSurface.toString()})(document,'Alpha');`,'Original navigation retry mounts the exact ordinary Alpha note');
    await c.ui.openFile('Layouts.base');await c.ui.idle();await choose(c,'Board');assert.deepEqual(await boardOrder(c),['Todo','Done','Later']);
    await c.ui.drag(`${column('Todo')} .bases-kanban-column-header`,`${column('Done')} .bases-kanban-column-header`);await savedOrder(c,retained,['Done','Todo','Later'],'restored-column-order-after-recovery-acknowledgement');
    expected['Layouts.base']=await c.read('Layouts.base');await noMutation(c,expected,'Column configuration failure/retry never changes note bytes');
  });

  await step(c, 'Kanban-rank-sorted-insertion-and-input-owned-draft', async () => {
    const card = row('kanban', 'Gamma'), rank = `${card} .bases-kanban-card-line[data-property="note.rank"]`;
    await c.ui.click(rank, {count: 2}); await c.ui.type(`${rank} input`, '999');
    await c.ui.key('ArrowRight', {modifiers: MOD.alt});
    await c.ui.wait(`const e=document.querySelector(${JSON.stringify(rank + ' input')});return e?.value==='999'&&document.activeElement===e&&!!e.closest('[data-base-editing]');`, 'Owned input keeps exact draft and keyboard focus');
    assert.equal(await c.read('Items/Gamma.md'), expected['Items/Gamma.md']); await c.ui.key('Escape');
    await c.ui.wait(`return !document.querySelector('${active} [data-base-editing]');`, 'Cancel unfinished draft');
    await c.ui.drag(card, `${column('Done')} .bases-kanban-column-body`);
    const desired = expected['Items/Gamma.md'].replace('status: Todo\n', 'status: Done\n');
    await c.saved('Items/Gamma.md', source => assert.equal(source, desired), 'sorted-card-move-exact-source-body-preserved'); expected['Items/Gamma.md'] = desired;
    await c.ui.wait(`return JSON.stringify([...document.querySelectorAll(${JSON.stringify(column('Done') + ' .bases-kanban-card')})].map(e=>e.dataset.path))===${JSON.stringify(JSON.stringify(['Items/Beta.md', 'Items/Gamma.md', 'Items/Delta.md']))};`, 'Rank-sorted insertion has exact destination order');
    await noMutation(c, expected, 'Only Gamma status changed'); await capture(c, 'kanban-sorted-insertion');
  });

  await step(c, 'Kanban-failed-move-retains-exact-recovery-draft-and-retries-via-navigation', async () => {
    const original=expected['Items/Alpha.md'],desired=original.replace('status: Todo\n','status: Done\n');assert.notEqual(desired,original);
    const proof=await withLayoutCheckpointFailure(c,{file:'Items/Alpha.md',original,desired,label:'card-status',
      submit:()=>c.ui.drag(row('kanban','Alpha'),`${column('Done')} .bases-kanban-column-body`),
      verifyFailure:async()=>{
        await c.ui.wait(`return /Could not move .*Alpha/.test(document.querySelector('${active} .bases-kanban-status')?.textContent??'');`,'Failed real write has visible move feedback',10000);
        assert.equal(await c.read('Items/Alpha.md'),original,'Failed save did not touch original file');
        await c.ui.wait(`return !!document.querySelector(${JSON.stringify(column('Todo')+' .bases-kanban-card[data-path="Items/Alpha.md"]')});`,'Failed optimistic card preview returns to source column');
        await capture(c,'kanban-failed-move-retained-draft');
      }});
    c.evidence.checks.push({name:'failed-move-durable-recovery-draft',file:'Items/Alpha.md',...proof.recovery,held:proof.held,negative:proof.negative});
    // The same original navigation flush, not retyping or another card move,
    // retries the exact failed checkpoint and original prepared intent.
    await c.ui.openFile('Items/Alpha.md');await c.saved('Items/Alpha.md',source=>assert.equal(source,desired),'navigation-retries-retained-Kanban-write');expected['Items/Alpha.md']=desired;
    const replay=assertOriginalInlineCheckpointRetry((await c.relay.events()).slice(proof.offset),proof);c.evidence.checks.push({name:'card-status-exact-original-checkpoint-and-intent-retry',...replay});
    await c.ui.wait(`return (${layoutNoteSurface.toString()})(document,'Alpha');`,'Original card retry navigation mounts Alpha');
    await c.ui.openFile('Layouts.base');await c.ui.idle();await choose(c,'Board');await noMutation(c,expected,'Failure repair changes only the retained Alpha status');
  });

  await step(c, 'computed-Kanban-groups-remain-read-only-with-exact-labels', async () => {
    await choose(c, 'Computed board');
    const observed = await c.ui.wait(`const root=document.querySelector('${active} .bases-kanban-view');if(!root)return false;return {name:root.getAttribute('aria-label'),columns:[...root.querySelectorAll('.bases-kanban-column')].map(e=>({label:e.querySelector('.bases-kanban-column-body')?.getAttribute('aria-label'),newDisabled:[...e.querySelectorAll('.bases-kanban-column-create,.bases-kanban-column-footer button')].map(b=>b.disabled)})),cards:[...root.querySelectorAll('.bases-kanban-card')].map(e=>({path:e.dataset.path,draggable:e.draggable}))};`, 'Computed layout DOM read-only model');
    assert.equal(observed.name, 'Computed board'); assert.deepEqual(observed.columns.map(column => column.label), ['Todo', 'Done', 'Later']);
    assert.ok(observed.columns.every(column => column.newDisabled.length === 2 && column.newDisabled.every(Boolean)), 'Both column creation affordances are disabled');
    assert.equal(observed.cards.length, 4); assert.ok(observed.cards.every(card => !card.draggable));
    c.evidence.checks.push({name: 'computed-column-read-only-observation', observed}); await noMutation(c, expected, 'Read-only presentation causes no source edits'); await capture(c, 'computed-board-read-only');
  });

  await step(c, 'light-dark-scaled-resize-and-keyboard-link-label', async () => {
    await choose(c, 'Grouped cards'); const retained = await baseTab(c);
    for (const [theme, width, height, scale] of [['light', 1180, 820, 1], ['dark', 960, 740, 2]]) {
      await c.cdp.call('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: scale, mobile: false});
      await c.cdp.call('Emulation.setEmulatedMedia', {features: [{name: 'prefers-color-scheme', value: theme}]});
      await c.ui.wait(`return innerWidth===${width}&&innerHeight===${height}&&devicePixelRatio===${scale}&&document.documentElement.dataset.theme===${JSON.stringify(theme)};`, 'Actual requested theme/viewport/device scale');
      const geometry = await c.ui.wait(`const root=document.querySelector('${active} .bases-cards-container');if(!root)return false;const r=root.getBoundingClientRect(),cards=[...root.querySelectorAll('.bases-cards-item')].map(e=>{const b=e.getBoundingClientRect();return{path:e.dataset.path,left:b.left,right:b.right,width:b.width,height:b.height};});return cards.length===4?{left:r.left,right:r.right,cards}:false;`, 'All fixture cards after resize');
      assert.ok(geometry.cards.every(card => card.width > 0 && card.height > 0 && card.left >= geometry.left - 1 && card.right <= geometry.right + 1));
      assert.equal(await baseTab(c), retained); c.evidence.checks.push({name: 'layout-theme-scale-geometry', theme, width, height, scale, geometry}); await capture(c, `cards-${theme}-${width}-${scale}x`);
    }
    await c.ui.button('Search', active); await c.ui.key('Escape');
    let focused;
    for (let i = 0; i < 64; i++) { await c.ui.key('Tab'); focused = await c.ui.dom(`const e=document.activeElement;return e?.matches('${active} a.internal-link')?{path:e.closest('[data-path]')?.dataset.path,text:e.textContent,tag:e.tagName}:null;`); if (focused) break; }
    assert.ok(focused, 'Real Tab traversal reaches a file link'); assert.equal(focused.text, 'Alpha'); assert.equal(focused.path, 'Items/Alpha.md');
    const document = await c.cdp.call('DOM.getDocument'), target = await c.cdp.call('DOM.querySelector', {nodeId: document.root.nodeId, selector: `${row('cards', 'Alpha')} a.internal-link`});
    const ax = await c.cdp.call('Accessibility.getPartialAXTree', {nodeId: target.nodeId, fetchRelatives: false});
    assert.ok(ax.nodes.some(node => !node.ignored && node.role?.value === 'link' && node.name?.value === 'Alpha'), 'File link has the exact accessible label');
    c.evidence.checks.push({name: 'real-keyboard-focus-and-AX-link-label', focused, ax}); await noMutation(c, expected, 'Appearance and traversal leave vault bytes unchanged');
  });

  await hoverJourney(c, expected, step); await noMutation(c, expected, 'Hover changes only its explicitly edited target note');

  await c.quit('supplemental-layouts-normal-quit');
  await c.launch('supplemental-layouts-restart'); await c.ui.openFile('Layouts.base'); await c.ui.idle(); await choose(c, 'Board');
  await noMutation(c, expected, 'Exact note/Base bytes survive actual app restart');
  await c.ui.wait(`return JSON.stringify([...document.querySelectorAll('${active} .bases-kanban-column-body')].map(e=>e.getAttribute('aria-label')))===${JSON.stringify(JSON.stringify(['Done', 'Todo', 'Later']))};`, 'Reordered columns survive restart');
  await c.quit('supplemental-layouts-final-normal-quit');
}
