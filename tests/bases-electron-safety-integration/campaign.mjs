import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {delay, until} from '../tasks-electron-integration/cdp.mjs';
import {MOD} from '../bases-electron-integration/ui.mjs';
import {fixtureFiles, template, vaultName, openBoundaries} from './fixtures.mjs';
export {fixtureFiles, template, vaultName};

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
async function config(c, name) { await c.ui.button('Views', active); await c.ui.button('Configure view ' + name, dialog('Views')); }
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
async function conflictNote(c, file, marker) {
  await c.ui.openFile(file); await waitNote(c, file.replace(/\.md$/, ''));
  const before = await c.read(file), draft = before + '\n' + marker + '\n', external = before + '\nExternal authority ' + marker + '\n';
  await c.ui.type(editor, draft);
  // Fail rather than claim an overlapping draft if the native autosave already won.
  assert.equal(await c.read(file), before, 'Unsaved note draft precondition before external race');
  await c.external(file, external, 'retained-buffer-conflict-' + marker);
  await c.ui.wait(`const e=document.querySelector('.pane.is-active .note-recovery');return e&&!e.hidden&&document.querySelector(${JSON.stringify(editor)})?.textContent.includes(${JSON.stringify(marker)});`, 'Real native conflict retains typed draft', 45000);
  assert.equal(await c.read(file), external); return {before, draft, external};
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
    ['typed-null-list-link-date-folder-new-and-moves', typedGroups],
    ['sidebar-clean-renames-hidden-outline-and-retained-dirty-control', sidebarRenames],
  ];
  c.evidence.scenarios = phases.map(([name]) => ({name, status: 'unexecuted'}));
  await c.launch('safety-shared-writes-and-recovery');
  let named;
  for (let i = 0; i < phases.length; i++) {
    const [name, run] = phases[i], result = c.evidence.scenarios[i]; result.status = 'running'; result.started = new Date().toISOString();
    try { const value = await run(c); if (name === 'named-fragment-dirty-reference-retry') named = value; result.status = 'passed'; }
    catch (error) { result.status = 'failed'; result.failure = error.message; throw error; }
    finally { result.finished = new Date().toISOString(); }
  }
  assert.ok(named);
  const durable = new Map();
  for (const file of ['A.md', 'B.md', 'Safety.base', 'Properties.yaml', 'Named.base', 'Named host.md', 'Scalar A.md', 'List A.md', 'Date A.md', 'Link A.md', 'To/Move.md', 'Shelves/Dirty moved.base', 'Shelves/Other.base']) durable.set(file, await c.read(file));
  await c.quit('safety-normal-quit-with-settled-recovery');
  await c.launch('safety-restart-and-binding-readback');
  await c.ui.openFile('Named host.md'); await waitNote(c, 'Named host');
  await c.ui.wait(`return document.querySelectorAll('.pane.is-active .bases-embed .bases-session').length>=2&&document.querySelector('.pane.is-active .bases-embed .bases-session [role="grid"]')?.getAttribute('aria-label')==='Renamed view';`, 'Named fragments mount after normal restart');
  for (const [file, expected] of durable) await c.saved(file, source => assert.equal(source, expected), 'safety-restart-exact-' + file);
  await c.saved(named.copy, source => assert.equal(source, named.draft), 'safety-restart-recovery-copy-exact');
  assert.equal(await c.read('Named host.md'), named.renamedHost);
  await c.screenshot('s09-safety-restart-and-named-embeds'); await c.diskGuard(); await c.quit('safety-final-normal-quit');
}
