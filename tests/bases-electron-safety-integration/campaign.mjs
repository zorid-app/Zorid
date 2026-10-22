import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {delay, until} from '../tasks-electron-integration/cdp.mjs';
import {MOD} from '../bases-electron-integration/ui.mjs';
import {fixtureFiles as originalFixtureFiles, template, vaultName, openBoundaries} from './fixtures.mjs';
import {mountedRename, nestedRename, fencedRename, mountedRenameFixtures, nestedRenamedExternal, assertMountedRenameRetention, assertLogicalCellSelection, hoverPublication, newPublication, publicationFixtures, assertInlinePublicationFrame} from './mounted-rename-contract.mjs';
export {template, vaultName};
export function fixtureFiles() {
  const files=originalFixtureFiles();
  for(const [file,source] of [...mountedRenameFixtures(),...publicationFixtures()]){assert.ok(!files.has(file));files.set(file,source);}
  return files;
}

const active = '.pane.is-active .bases-session';
const dialog = name => `[role="dialog"][aria-label=${JSON.stringify(name)}]`;
const field = (name, scope = 'body') => `${scope} input[aria-label=${JSON.stringify(name)}],${scope} textarea[aria-label=${JSON.stringify(name)}],${scope} [contenteditable="true"][aria-label=${JSON.stringify(name)}]`;
const editor = '.pane.is-active .cm-content[contenteditable="true"]';
const popover = '.bases-new-item-popover[role="dialog"][aria-label="New item"]';
const basePane = '.pane:has(.bases-session)';
const notePane = '.pane:has(.note-title)';
const bodyOf = source => source.slice(source.indexOf('\n---\n') + 5);
async function open(c, file) { await c.ui.openFile(file); await c.ui.idle(); }
async function fm(c, file, check, name) { return c.saved(file, source => check(c.frontmatter(source), source), name); }
function restoredProperties(c, source, before) { assert.deepEqual(c.frontmatter(source), c.frontmatter(before)); assert.equal(bodyOf(source), bodyOf(before)); }
async function message(c, pattern, scope = 'body') {
  return c.ui.wait(`return [...document.querySelectorAll(${JSON.stringify(scope + ' [role="alert"],' + scope + ' [role="status"]')})].some(e=>e.getClientRects().length&&${pattern}.test(e.textContent));`, 'Visible recovery: ' + pattern);
}
async function config(c, name, scope = active) { await c.ui.button('Views', scope); await c.ui.button('Configure view ' + name, dialog('Views')); }
async function dismiss(c, name) {
  for (let i = 0; i < 3 && await c.ui.dom(`return !!document.querySelector(${JSON.stringify(dialog(name))});`); i++) { await c.ui.key('Escape'); await delay(300); }
  await c.ui.wait(`return !document.querySelector(${JSON.stringify(dialog(name))});`, 'Dismissed ' + name);
}
async function propertySettings(c) {
  await c.ui.button('Properties', active); await c.ui.button('Configure property topics', dialog('Properties')); await c.ui.button('Property type', dialog('Property'));
  await c.ui.wait(`return !!document.querySelector(${JSON.stringify(dialog('Property settings'))});`, 'Shared definitions editor');
}
async function selectBaseCell(c, file, property = 'note.score') {
  await c.ui.selectCell(file, property);
  await c.ui.wait(`return document.activeElement?.getAttribute('role')==='gridcell';`, 'Base command has cell focus');
}
async function closeNew(c) {
  for (let i = 0; i < 3 && await c.ui.dom(`return !!document.querySelector(${JSON.stringify(popover)});`); i++) { await c.ui.key('Escape'); await delay(200); }
  await c.ui.wait(`return !document.querySelector(${JSON.stringify(popover)});`, 'New editor settles and closes');
}
function owned(c, file) {
  assert.ok(file && !path.isAbsolute(file) && !file.split('/').includes('..'));
  const result = path.resolve(c.vault, file); assert.ok(result.startsWith(path.resolve(c.vault) + path.sep)); return result;
}
async function registryExternal(c, source, label) {
  await fs.writeFile(owned(c, 'Properties.yaml'), source);
  c.evidence.actions.push({action: 'external-property-definition-fixture', file: 'Properties.yaml', label, source, at: Date.now()});
}
async function waitNote(c, title) { await c.ui.wait(`return document.querySelector('.pane.is-active .note-title')?.value===${JSON.stringify(title)}&&!!document.querySelector(${JSON.stringify(editor)});`, 'Ordinary editor ' + title); }
async function recoveryCopy(c, expectedDraft, expectedOriginal, file, name) {
  const before = new Set(await fs.readdir(c.vault));
  await c.ui.button('Save recovery copy', '.pane.is-active .note-recovery');
  const copy = await until(async () => {
    const names = (await fs.readdir(c.vault)).filter(value => !before.has(value) && value.endsWith('.md'));
    assert.equal(names.length, 1, 'One recovery copy, not replacement or duplicate'); return names[0];
  }, 30000);
  await c.saved(copy, source => assert.equal(source, expectedDraft), name + '-exact-draft-copy');
  await c.saved(file, source => assert.equal(source, expectedOriginal), name + '-external-original-preserved');
  await c.ui.wait(`return !!document.querySelector('.pane.is-active .note-recovery[hidden]');`, 'Recovery conflict resolved');
  return copy;
}
export async function conflictNote(c, file, marker) {
  await c.ui.openFile(file); await waitNote(c, file.replace(/\.md$/, ''));
  const before = await c.read(file), draft = before + '\n' + marker + '\n', external = before + '\nExternal authority ' + marker + '\n';
  assert.ok(before.endsWith('\n'),'Owned conflict note has an actual terminal empty body line');
  assert.ok(c.externalCliConflicts,'Explicit independent CLI conflict fixture required');
  const writer=await c.externalCliConflicts.prime(file,before);
  try{
    // Live Edit's Select All intentionally excludes hidden frontmatter. Append
    // through the actual body caret rather than pasting a second YAML prefix.
    await c.ui.click(editor);await c.ui.key('ArrowDown',{modifiers:MOD.meta});
    const caret=await c.ui.dom(`const e=document.querySelector(${JSON.stringify(editor)}),lines=e?[...e.querySelectorAll('.cm-line')]:[],last=lines.at(-1),selection=document.getSelection(),index=last?.parentNode===e?[...e.childNodes].indexOf(last):-1;return {collapsed:selection?.isCollapsed,lastText:last?.textContent,atLast:!!(last&&selection?.anchorNode&&(last.contains(selection.anchorNode)||(selection.anchorNode===e&&index>=0&&selection.anchorOffset>=index)))};`);
    assert.equal(caret.collapsed,true);assert.equal(caret.lastText,'');assert.equal(caret.atLast,true,'Actual caret reaches the original terminal body line');
    await c.ui.key('Enter');await c.cdp.call('Input.insertText',{text:marker+'\n'});
    c.evidence.actions.push({action:'native-editor-input',scenario:'retained-conflict-body-append',file,key:'Enter',text:marker+'\n',beforeCaret:caret});
    assert.equal(await c.read(file),before,'Unsaved note draft precondition before independent logical write');
    const ordered=await writer.commit(draft,external);
    await c.ui.wait(`const e=document.querySelector('.pane.is-active .note-recovery');return e&&!e.hidden&&document.querySelector(${JSON.stringify(editor)})?.textContent.includes(${JSON.stringify(marker)});`, 'Real native conflict retains typed draft',45000);
    await ordered.assertConflict();assert.equal(await c.read(file),external);return{before,draft,external};
  }finally{await writer.close();}
}
async function closeSplit(c) {
  await c.ui.click(`${notePane} .tab.is-active .tab-close`);
  await c.ui.wait(`return document.querySelectorAll('.pane').length===1;`, 'Temporary ordinary-note split closed');
}

async function sharedBodyAndHistory(c) {
  await open(c, 'Safety.base'); await c.ui.command('Split right');
  await c.ui.openFile('A.md'); await waitNote(c, 'A');
  const before = await c.read('A.md'), marker = 'Shared body draft 😀', appended = '\n' + marker;
  await c.ui.click(editor); await c.ui.key('ArrowDown', {modifiers: MOD.meta});
  const beforeCaret = await c.ui.dom(`const host=document.querySelector(${JSON.stringify(editor)}),lines=host?[...host.querySelectorAll('.cm-line')]:[],last=lines.at(-1),selection=document.getSelection(),lastIndex=last?.parentNode===host?[...host.childNodes].indexOf(last):-1;return {collapsed:selection?.isCollapsed,lastText:last?.textContent,lineCount:lines.length,atLast:!!(last&&selection?.anchorNode&&(last.contains(selection.anchorNode)||(selection.anchorNode===host&&lastIndex>=0&&selection.anchorOffset>=lastIndex)))};`);
  assert.equal(beforeCaret.collapsed, true); assert.equal(beforeCaret.lastText, ''); assert.equal(beforeCaret.atLast, true, 'Actual keyboard caret is at the original terminal empty line');
  await c.ui.key('Enter'); await c.cdp.call('Input.insertText', {text: marker});
  const afterCaret = await c.ui.dom(`const host=document.querySelector(${JSON.stringify(editor)}),lines=host?[...host.querySelectorAll('.cm-line')]:[],last=lines.at(-1),selection=document.getSelection();let prefix=null;if(last&&selection?.anchorNode&&(last.contains(selection.anchorNode)||selection.anchorNode===host)){const range=document.createRange();range.selectNodeContents(last);range.setEnd(selection.anchorNode,selection.anchorOffset);prefix=range.toString();}return {collapsed:selection?.isCollapsed,lineCount:lines.length,tail:lines.slice(-3).map(line=>line.textContent),prefix};`);
  assert.equal(afterCaret.collapsed, true); assert.equal(afterCaret.lineCount, beforeCaret.lineCount + 1);
  assert.deepEqual(afterCaret.tail, ['Body A sentinel', '', marker], 'Actual Enter preserves the intended blank line before the marker'); assert.equal(afterCaret.prefix, marker, 'Native caret follows the entire single-line marker');
  c.evidence.actions.push({action: 'native-editor-input', scenario: 'shared-body-before-property-save', key: 'Enter', text: marker, beforeCaret, afterCaret});
  assert.equal(await c.read('A.md'), before, 'Shared-buffer body is still unsaved when Base editing starts');
  // Hit the other pane's production cell without navigating/closing the note.
  const cell = `${basePane} ${c.ui.cell('A.md', 'note.score')}`;
  await c.ui.click(cell, {count: 2}); await c.ui.type(`${cell} input:not([type="checkbox"])`, '9');
  assert.equal(await c.read('A.md'), before, 'Dirty body overlaps the actual Base property commit');
  await c.ui.key('Enter'); await c.ui.idle();
  const saved = await fm(c, 'A.md', (p, source) => { assert.equal(p.score, 9); assert.equal(p.untouched, 'keep'); assert.equal(bodyOf(source), bodyOf(before) + appended); }, 'shared-dirty-body-and-property-commit');
  await c.ui.click(`${notePane} .cm-content`); await c.ui.key('z', {modifiers: MOD.meta});
  await fm(c, 'A.md', (p, source) => { assert.equal(p.score, 9, 'Editor undo cannot revert independent Base property edit'); assert.equal(bodyOf(source), bodyOf(before)); }, 'editor-undo-owns-body-only');
  await c.ui.key('z', {modifiers: MOD.meta | MOD.shift});
  await c.saved('A.md', source => assert.equal(source, saved), 'editor-redo-restores-body-with-base-property');
  await c.ui.click(`${basePane} .tab.is-active .tab-title`); await selectBaseCell(c, 'A.md');
  const unrelated = saved.replace('untouched: keep', 'untouched: external-unrelated') + '\nExternal unrelated body marker\n';
  await c.external('A.md', unrelated, 'conditional-undo-unrelated-source');
  await c.ui.wait(`return [...document.querySelectorAll(${JSON.stringify(c.ui.cell('A.md', 'note.score'))})].some(e=>e.textContent==='9');`, 'Saved row remains after unrelated edit'); await delay(1000);
  await selectBaseCell(c, 'A.md'); await c.ui.key('z', {modifiers: MOD.meta});
  const undone = await fm(c, 'A.md', (p, source) => { assert.equal(p.score, 1); assert.equal(p.untouched, 'external-unrelated'); assert.equal(bodyOf(source), bodyOf(unrelated)); }, 'base-undo-preserves-unrelated-external-content');
  await selectBaseCell(c, 'A.md'); await c.ui.key('z', {modifiers: MOD.meta | MOD.shift});
  await c.saved('A.md', source => assert.equal(source, unrelated), 'base-redo-preserves-unrelated-external-content');
  const touched = unrelated.replace('score: 9', 'score: 7');
  await c.external('A.md', touched, 'conditional-undo-touched-property'); await delay(1200);
  await selectBaseCell(c, 'A.md'); await c.ui.key('z', {modifiers: MOD.meta});
  await message(c, '/touched property changed|current value was preserved/', active);
  assert.equal(await c.read('A.md'), touched, 'History cannot overwrite an intervening touched property');
  assert.notEqual(undone, touched); await c.screenshot('s01-shared-body-conditional-history');
  await closeSplit(c);
}

async function partialBulk(c) {
  const conflict = await conflictNote(c, 'B.md', 'Retained B body draft');
  await open(c, 'Safety.base');
  await c.ui.wait(`return document.querySelector(${JSON.stringify(c.ui.cell('B.md', 'note.score'))})?.textContent==='2';`, 'Fresh saved B row loaded despite retained buffer conflict');
  const aBefore = await c.read('A.md');
  await selectBaseCell(c, 'A.md'); await c.ui.key('ArrowDown', {modifiers: MOD.shift}); await c.ui.key('Delete');
  await message(c, '/Some files were saved before editing B.md failed/', active);
  await fm(c, 'A.md', p => assert.equal(p.score ?? null, null), 'partial-clear-first-file-durable');
  await c.ui.wait(`const e=document.querySelector(${JSON.stringify(c.ui.cell('A.md', 'note.score'))});return e&&e.textContent.trim()==='';`, 'Partial success publishes fresh saved row before history'); await c.ui.idle();
  assert.equal(await c.read('B.md'), conflict.external, 'Failed second file preserves external bytes');
  await c.screenshot('s02-partial-bulk-boundary');
  await selectBaseCell(c, 'A.md'); await c.ui.key('z', {modifiers: MOD.meta});
  await c.saved('A.md', source => restoredProperties(c, source, aBefore), 'partial-command-undo-restores-only-success');
  assert.equal(await c.read('B.md'), conflict.external);
  await c.ui.openFile('B.md'); await waitNote(c, 'B');
  await recoveryCopy(c, conflict.draft, conflict.external, 'B.md', 'partial-bulk-recovery');
  await open(c, 'Safety.base');
  await selectBaseCell(c, 'A.md'); await c.ui.key('ArrowDown', {modifiers: MOD.shift}); await c.ui.key('Delete'); await c.ui.idle();
  for (const file of ['A.md', 'B.md']) await fm(c, file, p => assert.equal(p.score ?? null, null), 'recovered-bulk-clear-' + file);
  await selectBaseCell(c, 'A.md'); await c.ui.key('z', {modifiers: MOD.meta}); await c.ui.idle();
  await c.saved('A.md', source => restoredProperties(c, source, aBefore), 'recovered-bulk-undo-A');
  await c.saved('B.md', source => restoredProperties(c, source, conflict.external), 'recovered-bulk-undo-B');
}

async function settingsCAS(c) {
  await open(c, 'Safety.base'); await propertySettings(c);
  const label = field('Option label', dialog('Property settings') + ' .bases-property-option-row:nth-child(1)');
  await c.ui.type(label, 'Retained local label');
  const external = c.yaml.parse(await c.read('Properties.yaml')); external.properties.topics.options[0].label = 'External authoritative label'; external.externalSentinel = 'keep';
  const externalSource = c.yaml.stringify(external); await registryExternal(c, externalSource, 'same-property-definition-cas'); await delay(1000);
  await c.ui.button('Apply', dialog('Property settings')); await message(c, '/changed|Refresh|reopen/i', dialog('Property settings'));
  assert.equal(await c.read('Properties.yaml'), externalSource);
  assert.equal(await c.ui.dom(`return document.querySelector(${JSON.stringify(label)})?.value;`), 'Retained local label');
  await c.screenshot('s03-property-settings-stale-draft'); await c.ui.button('Cancel', dialog('Property settings'));
  await propertySettings(c); assert.equal(await c.ui.dom(`return document.querySelector(${JSON.stringify(label)})?.value;`), 'External authoritative label');
  await c.ui.type(label, 'Accepted fresh label'); await c.ui.button('Apply', dialog('Property settings'));
  await c.saved('Properties.yaml', source => { const value = c.yaml.parse(source); assert.equal(value.properties.topics.options[0].label, 'Accepted fresh label'); assert.equal(value.externalSentinel, 'keep'); }, 'fresh-property-settings-save-preserves-unrelated-config');
}

async function summaryCAS(c) {
  await open(c, 'Safety.base');
  await c.ui.click(`${active} .zorid-bases-table-footer [data-summary-property="note.score"]`);
  await c.ui.button('Edit Total', '.zorid-bases-summary-picker');
  const expression = field('Summary expression', dialog('Edit summary'));
  await c.ui.type(expression, 'values.sum() + 1');
  await c.saved('Safety.base', source => assert.equal(c.yaml.parse(source).summaries.Total, 'values.sum() + 1'), 'summary-own-save-baseline');
  const own = await c.read('Safety.base');
  await c.ui.type(expression, 'values.sum() + 2');
  assert.equal(await c.read('Safety.base'), own, 'Unacknowledged summary draft precedes external write');
  const external = own.replace('values.sum() + 1', '777'); assert.notEqual(external, own);
  await c.external('Safety.base', external, 'same-summary-external-config-cas');
  await message(c, '/changed|Refresh|reopen/i', dialog('Edit summary'));
  assert.equal(await c.read('Safety.base'), external);
  assert.equal(await c.ui.dom(`return document.querySelector(${JSON.stringify(expression)})?.value;`), 'values.sum() + 2');
  await c.ui.type(expression, 'values.sum() + 3'); await delay(700);
  assert.equal(await c.read('Safety.base'), external, 'Newer local input cannot adopt an unrelated external configuration as its baseline');
  assert.equal(await c.ui.dom(`return document.querySelector(${JSON.stringify(expression)})?.value;`), 'values.sum() + 3');
  await c.screenshot('s04-summary-stale-newer-draft'); await c.ui.button('Cancel changes', dialog('Edit summary')); await c.ui.key('Escape');
}

async function pathReuseAndClose(c) {
  await open(c, 'Replacement.base');
  await c.ui.click(c.ui.cell('Replace.md', 'note.score'), {count: 2}); await c.ui.type(`${c.ui.cell('Replace.md', 'note.score')} input`, '8');
  const old = await c.read('Replace.md'), replacement = '---\nkind: replacement\nscore: 6\nuntouched: replacement\n---\nReplacement identity body 😀\n';
  await fs.mkdir(owned(c, 'Retired'), {recursive: true}); await fs.rename(owned(c, 'Replace.md'), owned(c, 'Retired/Original.md')); await fs.writeFile(owned(c, 'Replace.md'), replacement);
  c.evidence.actions.push({action: 'external-path-reuse-fixture', from: 'Replace.md', preservedAt: 'Retired/Original.md', replacement, at: Date.now()});
  await delay(1200); await c.ui.key('Enter'); await message(c, '/stale|changed|replaced|conflict/i', active);
  assert.equal(await c.read('Replace.md'), replacement); assert.equal(await c.read('Retired/Original.md'), old);
  await c.ui.wait(`const e=document.querySelector(${JSON.stringify(c.ui.cell('Replace.md', 'note.score') + ' input')});return e?.value==='8';`, 'Stale editor retains original user input');
  await c.screenshot('s05-path-reuse-retained-draft'); await c.ui.key('Escape');
  await open(c, 'Safety.base');
  const before = await c.read('Properties.yaml'); await propertySettings(c);
  const label = field('Option label', dialog('Property settings') + ' .bases-property-option-row:nth-child(1)');
  await c.ui.type(label, 'Unapplied close-guard draft');
  await c.ui.click('.pane.is-active .tab.is-active .tab-close'); await message(c, '/Finish or cancel|before leaving|before.*base/i');
  assert.equal(await c.read('Properties.yaml'), before);
  assert.equal(await c.ui.dom(`return document.querySelector(${JSON.stringify(label)})?.value;`), 'Unapplied close-guard draft');
  await c.ui.wait(`return !!document.querySelector('.pane.is-active .bases-session');`, 'Failed close retains original Base session');
  await c.screenshot('s06-close-guard-retains-draft'); await c.ui.button('Cancel', dialog('Property settings'));
  await c.ui.click('.pane.is-active .tab.is-active .tab-close');
  await c.ui.wait(`return !document.querySelector('.pane.is-active .bases-session');`, 'Clean Base tab can close after explicit cancellation');
  await open(c, 'Safety.base'); assert.equal(await c.read('Properties.yaml'), before);
}

async function namedReferenceRetry(c) {
  const conflict = await conflictNote(c, 'Named host.md', 'Retained named-host draft 😀');
  await open(c, 'Named.base'); await config(c, 'Old view');
  await c.ui.type(field('View name', dialog('View options')), 'Renamed view'); await c.ui.key('Enter');
  await c.saved('Named.base', source => assert.equal(c.yaml.parse(source).views[0].name, 'Renamed view'), 'named-rename-base-acknowledged-before-reference-retry');
  await c.ui.wait(`const e=document.querySelector(${JSON.stringify(dialog('View options'))});return e&&[...e.querySelectorAll('button')].some(b=>!b.hidden&&b.textContent==='Retry save');`, 'Dirty reference exposes an exact retained retry');
  await c.saved('Named clean.md', source => assert.equal(source, '# Clean reference\n![[Named.base#Renamed view]]\n'), 'named-rename-independent-clean-reference-completed');
  assert.equal(await c.read('Named host.md'), conflict.external, 'Dirty reference failure preserves external original');
  await c.screenshot('s07-named-reference-partial-retry');
  const beforeCopies = new Set(await fs.readdir(c.vault));
  await c.ui.button('Save recovery copy', '.native-document-notice');
  const copy = await until(async () => { const names = (await fs.readdir(c.vault)).filter(name => !beforeCopies.has(name) && name.endsWith('.md')); assert.equal(names.length, 1); return names[0]; }, 30000);
  await c.saved(copy, source => assert.equal(source, conflict.draft), 'named-reference-recovery-copy-exact-user-draft');
  assert.equal(await c.read('Named host.md'), conflict.external);
  await c.ui.button('Retry save', dialog('View options'));
  const renamedHost = conflict.external.replace('#Old view|', '#Renamed view|').replace('#Old%20view)', '#Renamed%20view)');
  await c.saved('Named host.md', source => assert.equal(source, renamedHost), 'named-reference-retry-preserves-alias-other-view-and-external-body');
  assert.equal(await c.read(copy), conflict.draft, 'The separately created recovery copy is never rewritten by the older captured plan');
  await dismiss(c, 'View options'); await c.ui.openFile('Named host.md'); await waitNote(c, 'Named host');
  await c.ui.wait(`return document.querySelector('.pane.is-active .bases-embed .bases-session [role="grid"]')?.getAttribute('aria-label')==='Renamed view';`, 'Renamed file embed resolves its exact binding');
  return {renamedHost, copy, draft: conflict.draft};
}
// This isolated observer stores only weak DOM identities. It never writes DOM,
// source, selection, events, application objects or product state.
const embedScope = target => `.pane.is-active .bases-embed[data-embed-target=${JSON.stringify(target)}]`;
const mountedScope = (name,rooted=false) => embedScope(`${rooted?'/':''}${mountedRename.base}#${name}`);
const nestedScope = name => `.pane.is-active .markdown-embed[data-embed-target="C2 Nested child"] .bases-embed[data-embed-target=${JSON.stringify(nestedRename.base+'#'+name)}]`;
const fencedScope = `.pane.is-active .bases-embed[data-base-source=${JSON.stringify(fencedRename.host)}]`;
async function embedFrame(c,scope) {
  return c.ui.dom(`const host=document.querySelector(${JSON.stringify(scope)}),root=host?.querySelector('.base-embed-session'),session=root?.querySelector('.bases-session'),grid=session?.querySelector('[role="grid"]'),cell=session?.querySelector('[role="gridcell"][tabindex="0"]'),input=session?.querySelector('[data-base-editing] input:not([type="checkbox"])');
    const ids=window.__zoridC2ObservedNodes??(window.__zoridC2ObservedNodes={map:new WeakMap(),next:1});const id=node=>{if(!node)return null;if(!ids.map.has(node))ids.map.set(node,ids.next++);return ids.map.get(node);};
    return {rootId:id(root),sessionId:id(session),connected:session?.isConnected??false,inEmbed:!!(host&&root&&session&&host.contains(root)&&root.contains(session)),binding:root?.getAttribute('aria-label')??null,gridName:grid?.getAttribute('aria-label')??null,selected:cell?{path:cell.dataset.path,property:cell.dataset.property}:null,input:input?{id:id(input),connected:input.isConnected,value:input.value,start:input.selectionStart,end:input.selectionEnd,direction:input.selectionDirection}:null};`);
}
async function waitEmbedded(c,scope,name) {
  await c.ui.wait(`const host=document.querySelector(${JSON.stringify(scope)}),content=host?.querySelector('.bases-session-content');return host?.querySelector('[role="grid"]')?.getAttribute('aria-label')===${JSON.stringify(name)}&&content?.getAttribute('aria-busy')!=='true';`,'Mounted exact Base view '+name,45000);
}
async function openEmbeddedNote(c,file,scope,name) { await c.ui.openFile(file);await waitNote(c,file.replace(/\.md$/,''));await waitEmbedded(c,scope,name); }
async function reopenEmbeddedNote(c,file,scope,name) {
  await c.ui.click('.pane.is-active .tab.is-active .tab-close');
  await openEmbeddedNote(c,file,scope,name);
}
async function selectedEmbeddedScore(c,scope) {
  await c.ui.click(scope+' '+c.ui.cell('A.md','note.score'));await c.ui.key('Escape');
  await c.ui.wait(`const e=document.activeElement;return e?.matches(${JSON.stringify(scope+' '+c.ui.cell('A.md','note.score'))});`,'Actual embedded score cell focus');
  const frame=await embedFrame(c,scope);assert.deepEqual(frame.selected,{path:'A.md',property:'note.score'});return frame;
}
async function mountedFileRename(c) {
  const oldOrigin=mountedScope(mountedRename.from,true),oldSibling=mountedScope(mountedRename.from),newOrigin=mountedScope(mountedRename.to,true),newSibling=mountedScope(mountedRename.to);
  await openEmbeddedNote(c,mountedRename.host,oldOrigin,mountedRename.from);await waitEmbedded(c,oldSibling,mountedRename.from);
  const origin=await selectedEmbeddedScore(c,oldOrigin),aBefore=await c.read('A.md');
  const input=oldSibling+' '+c.ui.cell('A.md','note.score')+' input:not([type="checkbox"])';
  await c.ui.click(oldSibling+' '+c.ui.cell('A.md','note.score'),{count:2});await c.ui.type(input,mountedRename.draft);
  await c.ui.key('Home');for(let i=0;i<3;i++)await c.ui.key('ArrowRight',{modifiers:MOD.shift});
  const sibling=await embedFrame(c,oldSibling);assert.equal(sibling.input?.value,mountedRename.draft);assert.equal(sibling.input.start,0);assert.equal(sibling.input.end,3);
  await config(c,mountedRename.from,oldOrigin);await c.ui.type(field('View name',dialog('View options')),mountedRename.to);await c.ui.key('Enter');
  await c.saved(mountedRename.base,source=>assert.equal(source,mountedRename.afterBase),'c2-mounted-base-only-name-changed');
  await c.saved(mountedRename.host,source=>assert.equal(source,mountedRename.afterHost),'c2-mounted-host-only-exact-fragments-changed');
  await waitEmbedded(c,newOrigin,mountedRename.to);
  const afterOrigin=await embedFrame(c,newOrigin),afterSibling=await embedFrame(c,newSibling);
  assertMountedRenameRetention(origin,afterOrigin,{base:mountedRename.base,name:mountedRename.to});
  assertMountedRenameRetention(sibling,afterSibling,{base:mountedRename.base,name:mountedRename.to,draft:true});
  assert.equal(await c.read('A.md'),aBefore,'Rename never saves or discards the sibling invalid property draft');
  c.evidence.actions.push({action:'passive-mounted-rename-retention',origin,afterOrigin,sibling,afterSibling});
  await dismiss(c,'View options');await c.ui.click(newSibling+' '+c.ui.cell('A.md','note.score')+' input');await c.ui.key('Escape');
  await waitEmbedded(c,newSibling,mountedRename.to);assert.equal(await c.read('A.md'),aBefore);
  await reopenEmbeddedNote(c,mountedRename.host,newOrigin,mountedRename.to);
  await c.ui.wait(`return !!document.querySelector(${JSON.stringify(embedScope(mountedRename.base+'#Other')+' .bases-list-container')});`,'Unrelated named view still mounted');
  await c.screenshot('s-c2-mounted-file-rename-draft-selection');
}
async function nestedMountedRename(c) {
  const conflict=await conflictNote(c,nestedRename.child,'C2 retained nested child draft 😀'),old=nestedScope(nestedRename.from),fresh=nestedScope(nestedRename.to);
  await openEmbeddedNote(c,nestedRename.outer,old,nestedRename.from);const before=await selectedEmbeddedScore(c,old);
  await config(c,nestedRename.from,old);await c.ui.type(field('View name',dialog('View options')),nestedRename.to);await c.ui.key('Enter');
  await c.saved(nestedRename.base,source=>assert.equal(source,nestedRename.afterBase),'c2-nested-base-name-ack-before-dirty-host-retry');
  await c.saved(nestedRename.clean,source=>assert.equal(source,nestedRename.cleanAfter),'c2-nested-independent-clean-reference');
  await c.ui.wait(`return [...document.querySelectorAll(${JSON.stringify(dialog('View options')+' button')})].some(e=>e.textContent==='Retry save'&&e.getClientRects().length);`,'Nested dirty host retains rename retry');
  assert.equal(await c.read(nestedRename.child),conflict.external);assert.equal(await c.read(nestedRename.outer),nestedRename.outerSource);
  // Before the dirty child can be rewritten, its original wrapper still names
  // the old fragment while its already-mounted session follows the saved name.
  const pending=await embedFrame(c,old);assertMountedRenameRetention(before,pending,{base:nestedRename.base,name:nestedRename.to,renderedName:nestedRename.from});
  const names=new Set(await fs.readdir(c.vault));await c.ui.button('Save recovery copy','.native-document-notice');
  const copy=await until(async()=>{const added=(await fs.readdir(c.vault)).filter(name=>!names.has(name)&&name.endsWith('.md'));assert.equal(added.length,1);return added[0];},30000);
  await c.saved(copy,source=>assert.equal(source,conflict.draft),'c2-nested-recovery-copy-exact-original-draft');
  await c.ui.button('Retry save',dialog('View options'));
  const renamed=nestedRenamedExternal(conflict.external);
  await c.saved(nestedRename.child,source=>assert.equal(source,renamed),'c2-nested-retry-only-child-fragments-and-external-body');
  await waitEmbedded(c,fresh,nestedRename.to);const after=await embedFrame(c,fresh);
  assertMountedRenameRetention(before,after,{base:nestedRename.base,name:nestedRename.to});
  assert.equal(await c.read(copy),conflict.draft);assert.equal(await c.read(nestedRename.outer),nestedRename.outerSource);
  c.evidence.actions.push({action:'passive-nested-rename-retention',before,pending,after});
  await dismiss(c,'View options');await reopenEmbeddedNote(c,nestedRename.outer,fresh,nestedRename.to);
  await c.screenshot('s-c2-nested-rename-retry');return {copy,draft:conflict.draft,renamed};
}
async function ownedVaultPaths(c) {
  const paths=[];
  const visit=async directory=>{for(const entry of await fs.readdir(path.join(c.vault,directory),{withFileTypes:true})){
    const relative=directory?directory+'/'+entry.name:entry.name;
    assert.ok(!entry.isSymbolicLink(),'Owned fixture paths cannot alias outside the vault');
    if(entry.isDirectory())await visit(relative);else{assert.ok(entry.isFile());paths.push(relative);}
  }};
  await visit('');return paths.sort();
}
async function fencedMountedRename(c) {
  await openEmbeddedNote(c,fencedRename.host,fencedScope,fencedRename.from);const filesBefore=await ownedVaultPaths(c),selectionBefore=await selectedEmbeddedScore(c,fencedScope);
  await config(c,fencedRename.from,fencedScope);await c.ui.type(field('View name',dialog('View options')),fencedRename.to);await c.ui.key('Enter');
  await c.saved(fencedRename.host,source=>assert.equal(source,fencedRename.afterHost),'c2-fence-exact-containing-note-only-name-change');
  await dismiss(c,'View options');await waitEmbedded(c,fencedScope,fencedRename.to);
  const selectionAfter=await embedFrame(c,fencedScope);assertLogicalCellSelection(selectionBefore,selectionAfter);
  c.evidence.actions.push({action:'passive-fenced-logical-selection-retention',selectionBefore,selectionAfter});
  // A clean inline fence may remount after its source span changes. Exercise it
  // before navigation: continuing binding/function, not clean DOM identity.
  const before=await c.read('A.md'),cell=fencedScope+' '+c.ui.cell('A.md','note.score');
  assert.match(before,/^score: [^\n]+$/m);const expected=before.replace(/^score: [^\n]+$/m,'score: 31');assert.notEqual(before,expected);
  await c.ui.click(cell,{count:2});await c.ui.type(cell+' input','31');await c.ui.key('Enter');
  await c.saved('A.md',source=>assert.equal(source,expected),'c2-fence-renamed-still-mounted-normal-property-save');
  await c.saved(fencedRename.sentinel,source=>assert.equal(source,fencedRename.sentinelSource),'c2-fence-no-vault-wide-note-fragment-rewrite');
  assert.deepEqual(await ownedVaultPaths(c),filesBefore,'Inline rename/property edit creates no hidden backing Base or extra file in any owned subfolder');
  await reopenEmbeddedNote(c,fencedRename.host,fencedScope,fencedRename.to);await c.screenshot('s-c2-fence-rename-continued-binding');
}
const hoverSurface=dialog('File preview');
const inlineInSurface=(surface,file)=>`${surface} .bases-embed[data-base-source=${JSON.stringify(file)}]`;
async function publicationFrame(c,scope,surface){
  const frame=await embedFrame(c,scope);
  const host=await c.ui.dom(`const host=document.querySelector(${JSON.stringify(surface)}),node=document.querySelector(${JSON.stringify(scope)})?.querySelector('.bases-session'),score=node?.querySelector('[role="gridcell"][data-path="A.md"][data-property="note.score"]'),ids=window.__zoridC2ObservedNodes;let hostId=null;if(host&&ids){if(!ids.map.has(host))ids.map.set(host,ids.next++);hostId=ids.map.get(host);}return {hostId,hostConnected:host?.isConnected??false,nodeInHost:!!(host&&node&&host.contains(node)),propertyBlocked:score?.getAttribute('aria-disabled')==='true'};`);
  return {...frame,...host};
}
async function retryInlinePublication(c,{surface,file,from,to,before:original,after:desired,label}){
  const scope=inlineInSurface(surface,file);await waitEmbedded(c,scope,from);await selectedEmbeddedScore(c,scope);
  const before=await publicationFrame(c,scope,surface),aBefore=await c.read('A.md'),pathsBefore=await ownedVaultPaths(c);
  assert.equal(await c.read(file),original);
  const folder=await fs.realpath(path.dirname(owned(c,file))),vault=await fs.realpath(c.vault),output=await fs.realpath(c.outputDirectory),mode=(await fs.stat(folder)).mode&0o777;
  assert.ok(folder.startsWith(vault+path.sep)&&vault.startsWith(output+path.sep),'Permission fixture is inside the owned disposable output vault');
  let failed;
  try{
    await fs.chmod(folder,0o555);c.evidence.actions.push({action:'owned-negative-inline-host-permission-fixture',file,folder,mode:'0555',host:label,purpose:'real native atomic containing-note configuration save failure',at:Date.now()});
    await config(c,from,scope);await c.ui.type(field('View name',dialog('View options')),to);await c.ui.key('Enter');
    await c.ui.wait(`const p=document.querySelector(${JSON.stringify(dialog('View options'))}),input=p?.querySelector('input[aria-label="View name"]'),retry=p?[...p.querySelectorAll('button')].find(b=>b.textContent==='Retry save'):null;return input?.value===${JSON.stringify(to)}&&/EACCES|permission denied|not permitted|read.only/i.test(p?.querySelector('[role="alert"]')?.textContent??'')&&retry&&!retry.disabled&&retry.getClientRects().length;`,'Real '+label+' save failure retains exact name and actionable original retry',45000);
    await c.saved(file,source=>assert.equal(source,original),label+'-failed-inline-source-not-durable');
    failed=await publicationFrame(c,scope,surface);assertInlinePublicationFrame(before,failed,{file,name:from,failed:true});
    await delay(250);assertInlinePublicationFrame(before,await publicationFrame(c,scope,surface),{file,name:from,failed:true});
    assert.equal(await c.read(file),original);assert.equal(await c.read('A.md'),aBefore);
    await c.screenshot(label+'-failed-source-not-published');
  }finally{
    await fs.chmod(folder,mode);c.evidence.actions.push({action:'restore-owned-inline-host-permissions',file,folder,mode,host:label,at:Date.now()});
  }
  // One normal request, one original retained retry. Never retype the name or
  // reopen a replacement session to make a failed command look successful.
  await c.ui.button('Retry save',dialog('View options'));
  await c.saved(file,source=>assert.equal(source,desired),label+'-original-retry-exact-whole-note');
  await dismiss(c,'View options');await waitEmbedded(c,scope,to);
  const after=await publicationFrame(c,scope,surface);assertInlinePublicationFrame(before,after,{file,name:to});
  assert.equal(await c.read('A.md'),aBefore);assert.deepEqual(await ownedVaultPaths(c),pathsBefore);
  c.evidence.checks.push({name:label+'-one-ui-intent-original-continuation',file,requestedName:to,renameSubmissions:1,originalRetryClicks:1,before,failed,after,limitation:'Normal control intent count; not an instrumented count of physical native filesystem writes.'});
}
async function showPublicationHover(c,name){
  await open(c,hoverPublication.launcher);
  await c.cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:1000,y:780,modifiers:0});await delay(400);
  const selector=`${active} ${c.ui.cell(hoverPublication.file,'file.name')} a.internal-link`,point=await c.ui.point(selector);
  await c.cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',...point,modifiers:MOD.meta});
  c.evidence.actions.push({action:'trusted-hover-mouse',label:'C2 normal modifier entry',selector,point,modifiers:MOD.meta,at:Date.now()});
  await c.ui.wait(`const p=document.querySelector(${JSON.stringify(hoverSurface)});return document.querySelectorAll(${JSON.stringify(hoverSurface)}).length===1&&p?.getAttribute('aria-busy')!=='true'&&!p.inert;`,'One normal C2 file preview');
  await waitEmbedded(c,inlineInSurface(hoverSurface,hoverPublication.file),name);
}
async function hoverInlinePublication(c){
  await showPublicationHover(c,hoverPublication.from);
  await c.ui.click(hoverSurface+' .bases-file-hover-preview p');
  await c.ui.wait(`const e=document.querySelector(${JSON.stringify(hoverSurface+' .bases-file-hover-editor .cm-content')});return e&&e.contains(document.activeElement);`,'Normal Hover body click opens the shared live editor');
  await retryInlinePublication(c,{surface:hoverSurface,...hoverPublication,label:'c2-hover-inline-publication'});
  await c.ui.openFile('A.md');await c.ui.wait(`return !document.querySelector(${JSON.stringify(hoverSurface)});`,'Successful Hover inline save permits normal parent navigation');
  await showPublicationHover(c,hoverPublication.to);await c.ui.openFile('A.md');
  await c.ui.wait(`return !document.querySelector(${JSON.stringify(hoverSurface)});`,'Clean reopened Hover closes normally');
}
async function newInlinePublication(c){
  await open(c,newPublication.launcher);const before=new Set(await fs.readdir(owned(c,newPublication.folder)));
  await c.ui.button('New',active);
  const file=await until(async()=>{const added=(await fs.readdir(owned(c,newPublication.folder))).filter(name=>!before.has(name)&&name.endsWith('.md'));assert.equal(added.length,1,'One normal New item, no retry duplicate');return newPublication.folder+'/'+added[0];},30000);
  await c.saved(file,source=>assert.equal(source,newPublication.before),'c2-new-literal-full-template-copy');
  await c.ui.wait(`return !!document.querySelector(${JSON.stringify(popover)});`,'Normal New item popup');
  await c.ui.click(popover+' [aria-label="Edit note body"]');
  await c.ui.wait(`return !!document.querySelector(${JSON.stringify(popover+' .cm-content[contenteditable="true"]')});`,'New body opens shared live editor');
  await retryInlinePublication(c,{surface:popover,...newPublication,file,label:'c2-new-inline-publication'});
  await closeNew(c);assert.equal(await c.read(newPublication.template),newPublication.before,'Original literal template is never renamed');
  const added=(await fs.readdir(owned(c,newPublication.folder))).filter(name=>!before.has(name)&&name.endsWith('.md'));assert.deepEqual(added,[path.basename(file)]);
  await openEmbeddedNote(c,file,`.pane.is-active .bases-embed[data-base-source=${JSON.stringify(file)}]`,newPublication.to);
  return {file};
}
const columnFor = file => `${active} .bases-kanban-column:has(.bases-kanban-card[data-path=${JSON.stringify(file)}])`;
const columnBodyFor = file => `${columnFor(file)} .bases-kanban-column-body`;
async function moveInto(c, base, from, target, property, expected, name) {
  await open(c, base); const before = await c.read(from);
  await c.ui.wait(`return !!document.querySelector(${JSON.stringify(columnBodyFor(target))});`, 'Core destination group rendered for ' + name);
  await c.ui.drag(`${active} .bases-kanban-card[data-path=${JSON.stringify(from)}]`, columnBodyFor(target)); await c.ui.idle();
  await fm(c, from, (p, source) => { assert.deepEqual(p[property], expected); assert.equal(p.untouched, 'keep'); assert.equal(bodyOf(source), bodyOf(before)); }, name);
}
async function newInColumn(c, column, directory, check, name) {
  const before = new Set(await fs.readdir(owned(c, directory)));
  await c.ui.button('Create note', column + ' .bases-kanban-column-header');
  const file = await until(async () => { const names = (await fs.readdir(owned(c, directory))).filter(value => !before.has(value) && value.endsWith('.md')); assert.equal(names.length, 1, 'One New item in exact destination folder'); return directory + '/' + names[0]; }, 30000);
  await c.saved(file, check, name); await c.ui.wait(`return !!document.querySelector(${JSON.stringify(popover)});`, 'Group New opens ordinary note editor');
  await closeNew(c); return file;
}
async function typedGroups(c) {
  await moveInto(c, 'Scalar.base', 'Scalar A.md', 'Scalar B.md', 'stage', 'Done', 'scalar-group-move-exact-source-property');
  await newInColumn(c, columnFor('Scalar B.md'), 'Created', source => {const p = c.frontmatter(source); assert.equal(p.kind, 'scalar'); assert.equal(p.stage, 'Done');}, 'scalar-column-new-safe-filter-and-group');
  const nullBody = `${active} .bases-kanban-column-body[aria-label="No value"]`;
  await c.ui.drag(`${active} .bases-kanban-card[data-path="Scalar A.md"]`, nullBody); await c.ui.idle();
  await fm(c, 'Scalar A.md', p => assert.equal(Object.hasOwn(p, 'stage'), false), 'move-to-null-removes-group-property');
  await open(c, 'Null defaults.base');
  await newInColumn(c, `${active} .bases-kanban-column:has(.bases-kanban-column-body[aria-label="No value"])`, 'Created', source => {const p = c.frontmatter(source); assert.equal(p.kind, 'scalar-default'); assert.equal(p.stage, 'Todo');}, 'null-column-new-preserves-safe-filter-default');
  await open(c, 'Template group.base');
  await newInColumn(c, columnFor('Scalar B.md'), 'Created', source => assert.equal(source, template), 'template-column-new-copies-complete-conflicting-source');
  await message(c, '/outside.*view|copied unchanged|group values were not applied/i', active);
  assert.equal(await c.read('Templates/Conflict.md'), template);
  await moveInto(c, 'List.base', 'List A.md', 'List B.md', 'topics', ['Beta'], 'list-group-move-replaces-whole-list');
  await newInColumn(c, columnFor('List B.md'), 'Created', source => assert.deepEqual(c.frontmatter(source).topics, ['Beta']), 'list-column-new-persists-array');
  await moveInto(c, 'Date.base', 'Date A.md', 'Date B.md', 'day', '2026-10-02', 'typed-date-group-move-preserves-persisted-date-string');
  await newInColumn(c, columnFor('Date B.md'), 'Created', source => assert.equal(c.frontmatter(source).day, '2026-10-02'), 'date-column-new-uses-core-writable-key');
  await moveInto(c, 'Link.base', 'Link A.md', 'Link B.md', 'project', '[[/Projects/Two.md|Alias Two]]', 'typed-link-group-move-uses-rooted-target-and-retains-alias');
  await newInColumn(c, columnFor('Link B.md'), 'Created', source => assert.equal(c.frontmatter(source).project, '[[/Projects/Two.md|Alias Two]]'), 'link-column-new-uses-transfer-safe-core-key');
  await open(c, 'Folder.base'); const original = await c.read('From/Move.md');
  await c.ui.drag(`${active} .bases-kanban-card[data-path="From/Move.md"]`, columnBodyFor('To/Target.md')); await c.ui.idle();
  await c.saved('To/Move.md', source => assert.equal(source, original), 'folder-group-move-renames-file-with-exact-body');
  await until(async () => assert.ok(!(await fs.readdir(owned(c, 'From'))).includes('Move.md')), 30000);
  const createdBefore = (await fs.readdir(owned(c, 'Created'))).sort();
  await newInColumn(c, columnFor('To/Target.md'), 'To', source => assert.equal(c.frontmatter(source).kind, 'folder-group'), 'folder-column-new-overrides-configured-folder');
  assert.deepEqual((await fs.readdir(owned(c, 'Created'))).sort(), createdBefore, 'Folder-group New never creates an additional note in configured fallback');
  await c.screenshot('s08-typed-groups-and-folder-moves');
}

const sidebar = '.right-sidebar .sidebar-base-host .bases-session';
const tree = file => `[role="treeitem"][data-path=${JSON.stringify(file)}]`;
async function beginTreeRename(c, file, name) {
  await c.ui.click(tree(file), {button: 'right'}); await c.ui.button('Rename…', '.context-menu');
  const label = `${tree(file)} .tree-label[role="textbox"][aria-label="Folder or file name"]`;
  await c.ui.type(label, name); await c.ui.key('Enter'); return label;
}
async function sidebarRow(c, file, score) {
  await c.ui.wait(`const root=document.querySelector(${JSON.stringify(sidebar)});return root?.querySelector('[role="grid"]')?.getAttribute('aria-label')==='Sidebar context'&&root.querySelector('[role="grid"]')?.getAttribute('aria-rowcount')==='2'&&root.querySelector(${JSON.stringify(c.ui.cell(file, 'note.score'))})?.textContent===${JSON.stringify(String(score))};`, 'Sidebar saved context row ' + file);
}
async function outlineHidden(c) {
  await c.ui.wait(`return document.querySelector('.workspace')?.classList.contains('right-hidden')&&document.querySelector('.right-content > .right-heading')?.textContent==='Outline'&&!document.querySelector('.right-content .sidebar-base-host');`, 'Rename preserves hidden sidebar and selected Outline');
}
async function sidebarRenames(c) {
  await open(c, 'Sidebars/Context.base'); const original = await c.read('Sidebars/Context.base');
  await c.ui.command('Bases: Open in right sidebar');
  await c.ui.openFile('Context One.md'); await waitNote(c, 'Context One'); await sidebarRow(c, 'Sidebar One.md', 11);
  await c.ui.button('Outline', '.right-tabs'); await c.ui.click('.workspace-sidebar-toggle.is-right[aria-label="Collapse right sidebar"]'); await outlineHidden(c);
  await beginTreeRename(c, 'Sidebars/Context.base', 'Renamed.base');
  await c.saved('Sidebars/Renamed.base', source => assert.equal(source, original), 'sidebar-clean-base-file-rename-exact-source');
  await until(async () => assert.ok(!(await fs.readdir(owned(c, 'Sidebars'))).includes('Context.base')), 30000); await outlineHidden(c);
  await beginTreeRename(c, 'Sidebars', 'Shelves');
  await c.saved('Shelves/Renamed.base', source => assert.equal(source, original), 'sidebar-clean-parent-folder-rename-exact-source');
  await until(async () => assert.ok(!(await fs.readdir(c.vault)).includes('Sidebars')), 30000); await outlineHidden(c);
  await c.ui.click('.workspace-sidebar-toggle.is-right[aria-label="Expand right sidebar"]');
  await c.ui.wait(`return document.querySelector('.right-content > .right-heading')?.textContent==='Outline';`, 'Expanding does not silently select Bases');
  await c.ui.button('Bases', '.right-tabs'); await sidebarRow(c, 'Sidebar One.md', 11);
  await c.ui.openFile('Context Two.md'); await waitNote(c, 'Context Two'); await sidebarRow(c, 'Sidebar Two.md', 22);
  await c.screenshot('s09a-clean-sidebar-file-and-folder-rename-preserve-context');
  const registry = await c.read('Properties.yaml');
  await c.ui.button('Properties', sidebar); await c.ui.button('Configure property topics', dialog('Properties')); await c.ui.button('Property type', dialog('Property'));
  const label = field('Option label', dialog('Property settings') + ' .bases-property-option-row:nth-child(1)');
  await c.ui.type(label, 'Unapplied sidebar option label');
  const renameInput = await beginTreeRename(c, 'Shelves/Renamed.base', 'Must not rename.base');
  await c.ui.wait(`return document.querySelector(${JSON.stringify(renameInput)})?.getAttribute('aria-invalid')==='true';`, 'Normal file rename is refused by the retained sidebar draft guard');
  assert.equal(await c.read('Shelves/Renamed.base'), original); assert.ok(!(await fs.readdir(owned(c, 'Shelves'))).includes('Must not rename.base'));
  assert.equal(await c.ui.dom(`return document.querySelector(${JSON.stringify(label)})?.value;`), 'Unapplied sidebar option label');
  await c.ui.key('Escape'); // Cancel explorer rename, retaining the separate settings draft.
  await fs.rename(owned(c, 'Shelves/Renamed.base'), owned(c, 'Shelves/Dirty moved.base'));
  c.evidence.actions.push({action: 'external-sidebar-base-rename-fixture', from: 'Shelves/Renamed.base', to: 'Shelves/Dirty moved.base', reason: 'Normal rename correctly refuses pending sidebar drafts', at: Date.now()});
  await c.ui.wait(`return !!document.querySelector(${JSON.stringify(tree('Shelves/Dirty moved.base'))});`, 'External move observed through the normal explorer');
  assert.equal(await c.ui.dom(`return document.querySelector(${JSON.stringify(label)})?.value;`), 'Unapplied sidebar option label');
  assert.equal(await c.read('Properties.yaml'), registry); await c.screenshot('s09b-external-sidebar-rename-retains-dirty-control');
  await c.ui.button('Cancel', dialog('Property settings')); await c.ui.button('Bases', '.right-tabs'); await sidebarRow(c, 'Sidebar Two.md', 22);
  assert.equal(await c.read('Shelves/Dirty moved.base'), original); assert.equal(await c.read('Properties.yaml'), registry);
  // A real subsequent selection must remain current. No artificial pending
  // controller/service promise is installed, so this is sequential selection
  // acceptance rather than the independently required in-flight reentry race.
  await open(c, 'Shelves/Other.base'); await c.ui.command('Bases: Open in right sidebar');
  await c.ui.wait(`return document.querySelector(${JSON.stringify(sidebar + ' [role="grid"]')})?.getAttribute('aria-label')==='Other sidebar';`, 'Normal newer sidebar selection mounts the selected Base');
  await c.ui.openFile('Context One.md'); await waitNote(c, 'Context One');
  await c.ui.wait(`const root=document.querySelector(${JSON.stringify(sidebar)});return root?.querySelector('[role="grid"]')?.getAttribute('aria-label')==='Other sidebar'&&root.querySelector(${JSON.stringify(c.ui.cell('Sidebar Two.md', 'note.score'))})?.textContent==='22'&&!root.querySelector(${JSON.stringify(c.ui.cell('Sidebar One.md', 'note.score'))});`, 'Older context-bound sidebar cannot revive after a later ordinary selection');
  await c.screenshot('s09c-sidebar-explicit-newer-selection');
}

export async function journey(c) {
  c.evidence.campaign = 'bases-desktop-safety';
  c.evidence.limitations.push(...openBoundaries);
  const phases = [
    ['shared-body-and-conditional-history', sharedBodyAndHistory],
    ['partial-bulk-conflict-history-and-recovery', partialBulk],
    ['property-settings-stale-cas', settingsCAS],
    ['live-summary-stale-cas-and-newer-input', summaryCAS],
    ['actor-path-reuse-and-unapplied-draft-close', pathReuseAndClose],
    ['named-fragment-dirty-reference-retry', namedReferenceRetry],
    ['mounted-file-embed-rename-retains-sibling-draft-and-cell-selection', mountedFileRename],
    ['nested-mounted-embed-rename-dirty-child-retry', nestedMountedRename],
    ['fenced-mounted-rename-continued-binding-and-property-save', fencedMountedRename],
    ['hover-inline-config-not-published-before-durable-original-retry', hoverInlinePublication],
    ['new-popup-inline-config-not-published-before-durable-original-retry', newInlinePublication],
    ['typed-null-list-link-date-folder-new-and-moves', typedGroups],
    ['sidebar-clean-renames-hidden-outline-and-retained-dirty-control', sidebarRenames],
  ];
  c.evidence.scenarios = phases.map(([name]) => ({name, status: 'unexecuted'}));
  await c.launch('safety-shared-writes-and-recovery');
  let named, nested, newInline;
  for (let i = 0; i < phases.length; i++) {
    const [name, run] = phases[i], result = c.evidence.scenarios[i]; result.status = 'running'; result.started = new Date().toISOString();
    try { const value = await run(c); if (name === 'named-fragment-dirty-reference-retry') named = value; if(name==='nested-mounted-embed-rename-dirty-child-retry')nested=value; if(name==='new-popup-inline-config-not-published-before-durable-original-retry')newInline=value; result.status = 'passed'; }
    catch (error) { result.status = 'failed'; result.failure = error.message; throw error; }
    finally { result.finished = new Date().toISOString(); }
  }
  assert.ok(named && nested && newInline);
  const durable = new Map();
  for (const file of ['A.md', 'B.md', 'Safety.base', 'Properties.yaml', 'Named.base', 'Named host.md', 'Scalar A.md', 'List A.md', 'Date A.md', 'Link A.md', 'To/Move.md', 'Shelves/Dirty moved.base', 'Shelves/Other.base']) durable.set(file, await c.read(file));
  for(const file of [...mountedRenameFixtures().keys(),...publicationFixtures().keys(),newInline.file])durable.set(file,await c.read(file));
  await c.quit('safety-normal-quit-with-settled-recovery');
  await c.launch('safety-restart-and-binding-readback');
  await c.ui.openFile('Named host.md'); await waitNote(c, 'Named host');
  await c.ui.wait(`return document.querySelectorAll('.pane.is-active .bases-embed .bases-session').length>=2&&document.querySelector('.pane.is-active .bases-embed .bases-session [role="grid"]')?.getAttribute('aria-label')==='Renamed view';`, 'Named fragments mount after normal restart');
  for (const [file, expected] of durable) await c.saved(file, source => assert.equal(source, expected), 'safety-restart-exact-' + file);
  await c.saved(named.copy, source => assert.equal(source, named.draft), 'safety-restart-recovery-copy-exact');
  assert.equal(await c.read('Named host.md'), named.renamedHost);
  await c.saved(nested.copy,source=>assert.equal(source,nested.draft),'c2-restart-nested-recovery-copy-exact');
  assert.equal(await c.read(nestedRename.child),nested.renamed);
  await openEmbeddedNote(c,mountedRename.host,mountedScope(mountedRename.to,true),mountedRename.to);
  await openEmbeddedNote(c,nestedRename.outer,nestedScope(nestedRename.to),nestedRename.to);
  await openEmbeddedNote(c,fencedRename.host,fencedScope,fencedRename.to);
  await showPublicationHover(c,hoverPublication.to);await c.ui.openFile('A.md');await c.ui.wait(`return !document.querySelector(${JSON.stringify(hoverSurface)});`,'Restart Hover closes normally');
  await openEmbeddedNote(c,newInline.file,`.pane.is-active .bases-embed[data-base-source=${JSON.stringify(newInline.file)}]`,newPublication.to);
  await c.screenshot('s09-safety-restart-and-named-embeds'); await c.diskGuard(); await c.quit('safety-final-normal-quit');
}
