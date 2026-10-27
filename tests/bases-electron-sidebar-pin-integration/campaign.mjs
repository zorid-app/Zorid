import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {MOD} from '../bases-electron-integration/ui.mjs';
import {BASE, VIEW, A, B, RENAMED_A, ROW_A, ROW_B, ROW_NULL, fixtureFiles, expectedFiles, phases} from './fixtures.mjs';
import {sidebarPinFrame, pinFrameReady, assertPinFrame, assertPinAudit, installPinAudit, assertRenamedIdentity, pinKeyboardPortalFrame, assertCleanPinKeyboardPortal} from './oracles.mjs';
export {fixtureFiles, vaultName} from './fixtures.mjs';
const sidebar = '.right-sidebar .sidebar-base-host';
const pinScope = '.right-sidebar .right-tabs';
const noteTitle = '.pane.is-active input.note-title';
const titleOf = file => file.replace(/\.md$/, '');
const row = (path, score) => ({path, score});
async function audit(c, requireRefusal = false) {
  const value = await c.ui.dom('return window.__zoridOwnedSidebarPinAudit.read();'); assertPinAudit(value, {requireRefusal}); return value;
}
async function ready(c, expected, name) {
  const value = await c.ui.wait(`const value=(${sidebarPinFrame.toString()})(document);return (${pinFrameReady.toString()})(value,${JSON.stringify(expected)},${JSON.stringify(VIEW)})?value:false;`, name);
  assertPinFrame(value, expected); await audit(c);
  c.evidence.actions.push({action: 'sidebar-pin-public-frame', name, frame: value, at: Date.now()}); return value;
}
async function openNote(c, file, expected, name) { await c.ui.openFile(file); return ready(c, {...expected, title: titleOf(file)}, name); }
async function clickPin(c, pinned) { await c.ui.button(pinned ? 'Pin sidebar Base' : 'Unpin sidebar Base', pinScope); }
export async function keyboardPinFromCleanPortal(c) {
  const route = {action: 'sidebar-pin-clean-portal-keyboard-route', maximumTabKeys: 48, frames: [], tabKeys: 0, activationKey: 'Enter', activated: false, at: Date.now()};
  c.evidence.actions.push(route);
  const observe = async initial => {
    const frame = await c.ui.dom(`return (${pinKeyboardPortalFrame.toString()})(document);`);
    route.frames.push({at: Date.now(), frame}); assertCleanPinKeyboardPortal(frame, {initial}); return frame;
  };
  let frame = await observe(true);
  while (!frame.focusedPin && route.tabKeys < route.maximumTabKeys) {
    await c.ui.key('Tab', {modifiers: MOD.shift}); route.tabKeys++;
    frame = await observe(false);
  }
  assert.equal(frame.focusedPin, true, 'Pin must be reachable through bounded ordinary Shift+Tab navigation without closing the clean panel');
  route.activationAt = Date.now(); await c.ui.key('Enter'); route.activated = true;
  await c.ui.wait('return document.querySelectorAll(\'.bases-toolbar-popover[data-panel="View options"][role="dialog"]\').length===0;', 'Keyboard Pin dismisses the owned clean portal before its frozen-context result is accepted');
  route.portalAbsentAt = Date.now();
}
async function sources(c, renamed, name) {
  const expected = expectedFiles({renamed});
  const names = (await fs.readdir(c.vault)).filter(file => file !== '.zorid').sort();
  assert.deepEqual(names, [...expected.keys()].sort(), 'No note creation, duplicate or missing context file');
  for (const [file, source] of expected) await c.saved(file, actual => assert.equal(actual, source), `${name}-${file}`);
}
async function stat(c, file) {
  const observed = await c.cdp.evaluate(`(async()=>{const vault=await window.zorid.getVault();return {vault:vault.path,entry:await window.zorid.stat(vault.path,${JSON.stringify(file)})};})()`);
  assert.equal(observed.vault, c.vault); c.evidence.actions.push({action: 'read-only-normal-context-identity', file, observed, at: Date.now()}); return observed.entry;
}
export async function journey(c) {
  c.evidence.campaign = 'bases-sidebar-pin-context';
  c.evidence.limitations.push('Sidebar-only pin context, public controls and ordinary rename/restart. No generic main-pane pin, arbitrary crash, mobile or same-path external replacement acceptance follows.', 'Immediate unpin catch-up and frozen-context restoration are deliberate Zorid improvements; reference pin evidence is static only.', 'Accepted multi-file-write overlap remains the separate strict32-row sidebar-race campaign.');
  c.evidence.scenarios = phases.map(name => ({name, status: 'unexecuted'}));
  const phase = async (name, run) => {
    const item = c.evidence.scenarios.find(item => item.name === name); item.status = 'running'; item.started = new Date().toISOString();
    await c.ui.dom(`window.__zoridOwnedSidebarPinAudit.mark(${JSON.stringify(name)});return true;`);
    try { await run(); item.status = 'passed'; } catch (error) { item.status = 'failed'; item.failure = error.message; throw error; }
    finally { item.finished = new Date().toISOString(); }
  };
  let observing = false, beforeIdentity;
  await c.launch('sidebar-pin-public-controls');
  try {
    await c.ui.dom(`(${installPinAudit.toString()})();return true;`); observing = true;
    await phase(phases[0], async () => {
      await c.ui.openFile(BASE); await c.ui.idle(); await c.ui.command('Bases: Open in right sidebar');
      await ready(c, {pinned: false, rows: [], title: BASE.replace(/\.base$/, ''), noteTitle: null}, 'Base context differs from null');
      await openNote(c, A, {pinned: false, rows: [row(ROW_A, 11)]}, 'Sidebar follows first actual note');
      await sources(c, false, 'initial-source');
    });
    await phase(phases[1], async () => {
      await c.ui.button('Views', sidebar); await c.ui.button('Configure view ' + VIEW, '[role="dialog"][aria-label="Views"]');
      await c.ui.wait('return !!document.querySelector(\'.bases-toolbar-popover[data-panel="View options"][role="dialog"]\');', 'Normal clean sidebar view-options portal opens');
      await keyboardPinFromCleanPortal(c);
      await ready(c, {pinned: true, rows: [row(ROW_A, 11)], title: titleOf(A)}, 'Pin first current note');
      await openNote(c, B, {pinned: true, rows: [row(ROW_A, 11)]}, 'Changing main note preserves pinned context'); await c.screenshot('pin-frozen-first-context');
    });
    await phase(phases[2], async () => {
      await clickPin(c, false); await ready(c, {pinned: false, rows: [row(ROW_B, 22)], title: titleOf(B)}, 'Unpin catches up without another note-open action');
    });
    await phase(phases[3], async () => {
      const cell = sidebar + ' ' + c.ui.cell(ROW_B, 'note.score'), input = cell + ' input:not([type="checkbox"])';
      await c.ui.click(cell, {count: 2}); await c.ui.type(input, '88'); await clickPin(c, true);
      await ready(c, {pinned: false, rows: [row(ROW_B, 22)], title: titleOf(B), draft: true, allowRefusal: true}, 'Uncommitted draft refuses pin and remains intact');
      assert.equal(await c.read(ROW_B), fixtureFiles().get(ROW_B)); await c.screenshot('pin-refused-retained-draft');
      await c.ui.click(input); await c.ui.key('Escape');
      await ready(c, {pinned: false, rows: [row(ROW_B, 22)], title: titleOf(B)}, 'Ordinary Escape cancels the intentionally retained draft'); await sources(c, false, 'draft-refusal-source');
    });
    await phase(phases[4], async () => {
      await c.ui.click('.pane.is-active button[data-hotkey-command="new-tab"]');
      await ready(c, {pinned: false, rows: [row(ROW_NULL, 0)], title: 'New tab', noteTitle: null}, 'Blank main tab explicitly selects null this');
      await clickPin(c, true); await ready(c, {pinned: true, rows: [row(ROW_NULL, 0)], title: 'New tab', noteTitle: null}, 'Pin the explicit no-file context');
      await openNote(c, A, {pinned: true, rows: [row(ROW_NULL, 0)]}, 'Pinned null context survives opening a real note');
      await clickPin(c, false); await ready(c, {pinned: false, rows: [row(ROW_A, 11)], title: titleOf(A)}, 'Unpin null catches up to the current note'); await c.screenshot('pin-null-context');
    });
    await phase(phases[5], async () => {
      beforeIdentity = await stat(c, A); await clickPin(c, true);
      await ready(c, {pinned: true, rows: [row(ROW_A, 11)], title: titleOf(A)}, 'Pin before normal context-note rename');
      await c.ui.type(noteTitle, titleOf(RENAMED_A)); await c.ui.key('Enter');
      await ready(c, {pinned: true, rows: [row(ROW_A, 11)], title: titleOf(RENAMED_A)}, 'Known rename keeps pinned file context');
      await c.saved(RENAMED_A, source => assert.equal(source, fixtureFiles().get(A)), 'renamed-context-exact-body');
      assertRenamedIdentity(beforeIdentity, await stat(c, RENAMED_A), await stat(c, A));
      await openNote(c, B, {pinned: true, rows: [row(ROW_A, 11)]}, 'Renamed pinned context remains independent of main note'); await sources(c, true, 'renamed-source');
    });
    await phase(phases[6], async () => {
      const firstAudit = await c.ui.dom('return window.__zoridOwnedSidebarPinAudit.finish();'); observing = false; assertPinAudit(firstAudit, {requireRefusal: true});
      c.evidence.checks.push({name: 'sidebar-pin-first-process-no-unexpected-lifecycle-errors', audit: firstAudit});
      await c.quit('sidebar-pin-normal-quit'); await c.launch('sidebar-pin-fresh-process');
      await c.ui.dom(`(${installPinAudit.toString()})();window.__zoridOwnedSidebarPinAudit.mark(${JSON.stringify(phases[6])});return true;`); observing = true;
      await ready(c, {pinned: true, rows: [row(ROW_A, 11)], title: titleOf(B)}, 'Restart restores pinned renamed context while another main note is active');
      const currentIdentity = await stat(c, RENAMED_A); assert.equal(currentIdentity?.entryId, beforeIdentity.entryId);
      await clickPin(c, false); await ready(c, {pinned: false, rows: [row(ROW_B, 22)], title: titleOf(B)}, 'Restored pin unpins directly to latest main note');
      await sources(c, true, 'restart-source'); await c.screenshot('pin-restored-and-unpinned');
    });
    const finalAudit = await c.ui.dom('return window.__zoridOwnedSidebarPinAudit.finish();'); observing = false; assertPinAudit(finalAudit);
    c.evidence.checks.push({name: 'sidebar-pin-restored-process-no-unexpected-lifecycle-errors', audit: finalAudit}); await c.quit('sidebar-pin-restart-normal-quit');
  } finally {
    if (observing) try { const remaining = await c.ui.dom('return window.__zoridOwnedSidebarPinAudit.finish();'); c.evidence.sidebarPinFailureAudit = remaining; } catch (error) { c.evidence.sidebarPinAuditCleanup = error.message; }
  }
}
