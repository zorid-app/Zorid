import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {delay} from '../tasks-electron-integration/cdp.mjs';
import {MOD} from '../bases-electron-integration/ui.mjs';
import {fixtureFiles, names} from './fixtures.mjs';
import {beginDrag, assertWikiPayload} from './drag.mjs';
export {fixtureFiles};
export const vaultName = 'LayoutInteractions';
const active = '.pane.is-active .bases-session';
const panel = name => `[role="dialog"][aria-label=${JSON.stringify(name)}]`;
const row = (kind, name) => `${active} .bases-${kind}-${kind === 'cards' ? 'item' : kind === 'list' ? 'item' : 'card'}[data-path=${JSON.stringify('Items/' + name + '.md')}]`;
const column = label => `${active} .bases-kanban-column:has(.bases-kanban-column-body[aria-label=${JSON.stringify(label)}])`;
const files = ['Layouts.base', ...names.map(name => `Items/${name}.md`)];
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

export async function journey(c) {
  c.evidence.layoutCases = [];
  c.evidence.layoutScope = {unresolved: [
    {id: 'LAYOUT-HOVER-001', state: 'source hook absent at authoring baseline', reason: 'No positive hover acceptance is claimed until the reference-backed lifecycle helper is integrated.'},
    {id: 'LAYOUT-LIST-DRAG-001', state: 'source hook absent at authoring baseline', reason: 'List file-link browser drag is not counted as a correct Markdown file-drag payload.'},
  ]};
  c.evidence.limitations.push('Source-authored supplemental campaign; its executed case list and retained result determine actual acceptance.', 'Native drag payloads are captured from Chromium; no receiving external application or OS Finder drag is exercised.', 'Formula-derived groups test per-column read-only behavior; typed/null/folder grouping belongs to the separate session campaign.', 'Matched Obsidian screenshot parity, rich property edits and hover acceptance are outside these case assertions.');
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
        await c.ui.wait(`return document.querySelector('.pane.is-active .inline-title')?.textContent==='Alpha';`, 'Opened exact note content');
        await selectTab(c, retained); await c.ui.idle(); assert.equal(await selectedView(c), name);
      }
    }
    await noMutation(c, expected, 'Opening only never edits notes or Base configuration');
  });

  await step(c, 'all-layouts-file-context-open-and-bookmark-actions', async () => {
    for (const [name, kind, note] of [['Grouped cards', 'cards', 'Alpha'], ['Grouped list', 'list', 'Beta'], ['Board', 'kanban', 'Gamma']]) {
      await choose(c, name); const retained = await baseTab(c), target = kind === 'list' ? `${row(kind, note)} a.internal-link` : row(kind, note);
      await c.ui.click(target, {button: 'right'});
      const labels = await c.ui.wait(`const menus=[...document.querySelectorAll('.context-menu')].filter(e=>e.getClientRects().length);return menus.length===1?[...menus[0].querySelectorAll('.context-menu-item')].map(e=>e.textContent.trim()):false;`, 'Actual file context menu');
      assert.deepEqual(labels, ['Open in new tab', 'Bookmark', 'Version history', 'Rename…', 'Move to trash']);
      const before = await tabs(c); await newTabOracle(c, before, note, () => c.ui.button('Open in new tab', '.context-menu'));
      await selectTab(c, retained); await c.ui.idle();
      if (kind === 'cards') {
        await c.ui.click(target, {button: 'right'}); await c.ui.button('Bookmark', '.context-menu');
        await c.ui.wait(`return Object.entries(localStorage).some(([key,raw])=>key.startsWith('zorid:workspace:')&&JSON.parse(raw).bookmarks?.includes('Items/Alpha.md'));`, 'Bookmark persisted by normal UI action');
        await c.ui.click(target, {button: 'right'}); await c.ui.wait(`return [...document.querySelectorAll('.context-menu-item')].some(e=>e.textContent.trim()==='Remove bookmark');`, 'Context action reflects bookmark'); await c.ui.key('Escape');
      }
    }
    await noMutation(c, expected, 'Context opening/bookmarking does not modify vault files');
  });

  await step(c, 'Cards-and-Kanban-native-file-drag-payload', async () => {
    for (const [name, kind] of [['Grouped cards', 'cards'], ['Board', 'kanban']]) {
      await choose(c, name); const drag = await beginDrag(c, row(kind, 'Alpha'));
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
    await c.ui.drag(source, target); await c.saved('Layouts.base', source => assert.deepEqual(c.yaml.parse(source).views.find(view => view.name === 'Board').groupOrder, ['Done', 'Todo', 'Later']), 'column-reorder-exact-saved-order');
    expected['Layouts.base'] = await c.read('Layouts.base'); await noMutation(c, expected, 'Only intended Base group order changed');
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
    const folder = await fs.realpath(path.join(c.vault, 'Items')), vault = await fs.realpath(c.vault); assert.ok(folder.startsWith(vault + path.sep));
    const mode = (await fs.stat(folder)).mode & 0o777, original = expected['Items/Alpha.md'], desired = original.replace('status: Todo\n', 'status: Done\n');
    try {
      await fs.chmod(folder, 0o555); c.evidence.actions.push({action: 'owned-negative-permission-fixture', path: folder, mode: '0555', purpose: 'real atomic note save failure', at: Date.now()});
      await c.ui.drag(row('kanban', 'Alpha'), `${column('Done')} .bases-kanban-column-body`);
      await c.ui.wait(`return /Could not move .*Alpha/.test(document.querySelector('${active} .bases-kanban-status')?.textContent??'');`, 'Failed real write has visible move feedback', 45000);
      assert.equal(await c.read('Items/Alpha.md'), original, 'Failed save did not touch original file');
      await c.ui.wait(`return !!document.querySelector(${JSON.stringify(column('Todo') + ' .bases-kanban-card[data-path="Items/Alpha.md"]')});`, 'Failed optimistic card preview returns to source column');
      const draft = await c.ui.wait(`for(const[key,raw]of Object.entries(localStorage)){if(!key.startsWith('zorid:draft:')||!key.endsWith(encodeURIComponent('Items/Alpha.md')))continue;const draft=JSON.parse(raw);if(draft.base===${JSON.stringify(original)}&&draft.content===${JSON.stringify(desired)})return{key,draft};}return false;`, 'Exact desired source retained in normal recovery storage');
      c.evidence.checks.push({name: 'failed-move-durable-recovery-draft', file: 'Items/Alpha.md', ...draft}); await capture(c, 'kanban-failed-move-retained-draft');
    } finally { await fs.chmod(folder, mode); c.evidence.actions.push({action: 'restore-owned-fixture-permissions', path: folder, mode, at: Date.now()}); }
    // Navigation uses the normal session flush path to retry the retained draft.
    await c.ui.openFile('Items/Alpha.md'); await c.saved('Items/Alpha.md', source => assert.equal(source, desired), 'navigation-retries-retained-Kanban-write'); expected['Items/Alpha.md'] = desired;
    await c.ui.openFile('Layouts.base'); await c.ui.idle(); await choose(c, 'Board'); await noMutation(c, expected, 'Failure repair changes only the retained Alpha status');
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

  await c.quit('supplemental-layouts-normal-quit');
  await c.launch('supplemental-layouts-restart'); await c.ui.openFile('Layouts.base'); await c.ui.idle(); await choose(c, 'Board');
  await noMutation(c, expected, 'Exact note/Base bytes survive actual app restart');
  await c.ui.wait(`return JSON.stringify([...document.querySelectorAll('${active} .bases-kanban-column-body')].map(e=>e.getAttribute('aria-label')))===${JSON.stringify(JSON.stringify(['Done', 'Todo', 'Later']))};`, 'Reordered columns survive restart');
  await c.quit('supplemental-layouts-final-normal-quit');
}
