import assert from 'node:assert/strict';
import {MOD} from '../bases-electron-integration/ui.mjs';
import {fixtureFiles, vaultName, rowNames, rowSource, OLD_BASE, FIRST_BASE, NEWEST_BASE, OLD_VIEW, FIRST_VIEW, NEWEST_VIEW, FIRST_NOTE, NEWEST_NOTE, ROW_COUNT} from './fixtures.mjs';
import {assertNoLifecycleErrors, assertPending, assertNewestTrace, assertRestartedTrace, assertClearedSource, paneTitleSelector} from './oracles.mjs';
export {fixtureFiles, vaultName};
const sidebar = '.right-sidebar .sidebar-base-host';
const command = 'Bases: Open in right sidebar';

// Passive public DOM observation only. No workspace/controller/service access,
// injected user events, delayed providers, network overrides or product mutation.
export function installAudit() {
  const sidebar = document.querySelector('.right-sidebar');
  const root = sidebar?.querySelector('.sidebar-base-host .bases-session');
  if (!root) throw Error('Original sidebar session is absent');
  const ids = new WeakMap(), knownHosts = new WeakSet(); let next = 0, last;
  const hostsIn = node => node.nodeType === 1 ? [...(node.matches('.sidebar-base-host') ? [node] : []), ...node.querySelectorAll('.sidebar-base-host')] : [];
  const activeHosts = new Set(sidebar.querySelectorAll('.sidebar-base-host'));
  for (const host of activeHosts) knownHosts.add(host);
  const id = node => { if (!ids.has(node)) ids.set(node, ++next); return ids.get(node); };
  const audit = {events: [], overflow: false, secondMarker: undefined};
  const read = () => {
    const all = [...sidebar.querySelectorAll('.sidebar-base-host')];
    const visible = e => e.getClientRects().length && !e.closest('[hidden]');
    const hosts = all.filter(visible), current = hosts[0]?.querySelector('.bases-session'), grid = current?.querySelector('[role=grid]');
    const errors = [...document.querySelectorAll('.notice,[role=alert]')].filter(visible).map(e => e.textContent.trim()).filter(Boolean);
    for (const session of document.querySelectorAll('.bases-session[data-base-controller-error="true"]')) errors.push(session.querySelector('.bases-session-status')?.textContent.trim() || 'Base controller error');
    return {at: performance.now(), hostCount: hosts.length, totalHostCount: all.length, rootId: current ? id(current) : null,
      originalConnected: root.isConnected, originalIsCurrent: current === root,
      gridVisible: !!grid && !!visible(grid), gridLabel: grid?.getAttribute('aria-label') ?? null, gridBusy: grid?.getAttribute('aria-busy') ?? null,
      rowCount: grid?.getAttribute('aria-rowcount') ?? null, overflow: audit.overflow, errors,
      activeTitle: document.querySelector('.pane.is-active .tab.is-active .tab-title')?.textContent.trim() ?? null};
  };
  const append = value => {
    const key = JSON.stringify({...value, at: undefined}); if (key === last) return value; last = key;
    if (audit.events.length >= 512) { audit.overflow = true; return value; }
    audit.events.push(value); return value;
  };
  const record = () => append(read());
  const observeRoot = session => {
    const grid = session.querySelector('[role=grid]');
    if (grid) append({...read(), observedGridLabel: grid.getAttribute('aria-label'), observedRootId: id(session), observedHostCount: activeHosts.size});
  };
  const observeErrors = mutation => {
    const errors = [];
    const add = text => { const value = text?.trim(); if (value) errors.push(value); };
    if (mutation.type === 'attributes' && mutation.attributeName === 'data-base-controller-error' && mutation.target.matches('.bases-session') && (mutation.oldValue === 'true' || mutation.target.getAttribute('data-base-controller-error') === 'true')) {
      errors.push('Observed Base controller error during sidebar lifecycle');
    } else if (mutation.type === 'characterData') {
      const alert = mutation.target.parentElement?.closest('.notice,[role=alert]');
      if (alert && !alert.closest('[hidden]')) { add(mutation.oldValue); add(mutation.target.textContent); }
    } else if (mutation.type === 'childList') {
      const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
      const targetAlert = target?.closest('.notice,[role=alert]');
      const targetHidden = target?.closest('[hidden]');
      if (!targetHidden) {
        for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
          if (targetAlert && !targetAlert.closest('[hidden]')) add(node.textContent);
          if (node.nodeType === 1) {
            const alerts = [...(node.matches('.notice,[role=alert]') ? [node] : []), ...node.querySelectorAll('.notice,[role=alert]')];
            for (const alert of alerts) if (!alert.closest('[hidden]')) add(alert.textContent);
          }
        }
      }
    }
    if (errors.length) { const value = read(); append({...value, errors: [...value.errors, ...errors]}); }
  };
  const process = records => {
    for (const mutation of records) {
      observeErrors(mutation);
      const targetHost = mutation.target.nodeType === 1 ? mutation.target.closest('.sidebar-base-host') : null;
      const owned = sidebar.contains(mutation.target) || (targetHost && knownHosts.has(targetHost));
      if (!owned) continue;
      if (mutation.type === 'childList') {
        for (const node of mutation.removedNodes) for (const host of hostsIn(node)) if (knownHosts.has(host)) {
          activeHosts.delete(host); append({...read(), observedHostCount: activeHosts.size});
        }
        for (const node of mutation.addedNodes) {
          for (const host of hostsIn(node)) {
            knownHosts.add(host); activeHosts.add(host); append({...read(), observedHostCount: activeHosts.size});
            for (const session of host.querySelectorAll('.bases-session')) observeRoot(session);
          }
          if (node.nodeType === 1 && targetHost && knownHosts.has(targetHost)) {
            const sessions = [...(node.matches('.bases-session') ? [node] : []), ...node.querySelectorAll('.bases-session')];
            for (const session of sessions) observeRoot(session);
            const session = node.closest('.bases-session'); if (session) observeRoot(session);
          }
        }
      } else if (mutation.attributeName === 'aria-label' && mutation.target.matches('[role=grid]')) {
        const session = mutation.target.closest('.bases-session');
        if (session) for (const label of [mutation.oldValue, mutation.target.getAttribute('aria-label')]) append({...read(), observedGridLabel: label, observedRootId: id(session), observedHostCount: activeHosts.size});
      }
    }
    record();
  };
  const observer = new MutationObserver(process);
  observer.observe(document.body, {subtree: true, childList: true, characterData: true, characterDataOldValue: true, attributes: true, attributeOldValue: true, attributeFilter: ['aria-label','aria-busy','aria-rowcount','data-base-controller-error']});
  audit.read = () => { process(observer.takeRecords()); return record(); };
  audit.markSecond = () => { process(observer.takeRecords()); audit.secondMarker = audit.events.length; append({...read(), dispatchMarker: 'newest'}); };
  audit.finish = () => { process(observer.takeRecords()); observer.disconnect(); return {events: audit.events, overflow: audit.overflow, secondMarker: audit.secondMarker}; };
  window.__zoridOwnedSidebarRaceAudit = audit;
  return record();
}
async function receipt(c, label, rootId) {
  const value = await c.ui.dom('return window.__zoridOwnedSidebarRaceAudit.read();');
  c.evidence.actions.push({action: 'sidebar-pending-witness', label, ...value});
  assertPending(value, label, rootId); return value;
}
async function pendingCommand(c, name, rootId) {
  await c.ui.click('.ribbon [data-hotkey-command="command-palette"]');
  await c.ui.type('.command-modal .command-input', command);
  await c.ui.wait(`return [...document.querySelectorAll('.command-modal .suggestion')].filter(e=>e.getClientRects().length&&e.textContent.includes(${JSON.stringify(command)})).length===1;`, 'Unique ordinary sidebar command');
  const before = await receipt(c, `${name}-before-Enter`, rootId);
  assert.equal(before.activeTitle, name === 'first' ? FIRST_BASE.replace('.base', '') : NEWEST_BASE.replace('.base', ''), 'Sidebar command targets the visibly active Base');
  if (name === 'newest') await c.ui.dom('window.__zoridOwnedSidebarRaceAudit.markSecond();return true;');
  await c.ui.key('Enter');
  const after = await receipt(c, `${name}-after-Enter`, rootId);
  c.evidence.checks.push({name: `genuine-pending-${name}-selection`, before, after});
}
async function ready(c, scope, view, file, value) {
  await c.ui.wait(`const hosts=[...document.querySelectorAll(${JSON.stringify(scope)})],host=hosts[0],session=host?.querySelector('.bases-session'),grid=host?.querySelector('[role="grid"]');return hosts.length===1&&host.isConnected&&host.getClientRects().length&&!host.closest('[hidden]')&&grid?.getClientRects().length&&session?.dataset.baseControllerError==='false'&&session.dataset.baseControllerUpdating==='false'&&session.querySelector('.bases-session-content')?.getAttribute('aria-busy')==='false'&&grid?.getAttribute('aria-label')===${JSON.stringify(view)}&&grid.getAttribute('aria-rowcount')===${JSON.stringify(String((view === OLD_VIEW ? ROW_COUNT : 1) + 1))}&&grid.querySelector(${JSON.stringify(c.ui.cell(file, 'note.race_score'))})?.textContent===${JSON.stringify(String(value))};`, `Saved ${view} target`, 45000);
}
export async function journey(c) {
  const names = ['baseline-preopened-targets', 'accepted-bulk-pending', 'first-selection-pending', 'newest-selection-pending', 'newest-target-and-durable-bulk', 'normal-restart-newest-target'];
  c.evidence.campaign = 'bases-sidebar-in-flight-newest-selection';
  c.evidence.limitations.push('One bounded32-file attempt. Missing either original pending DOM witness fails; sequential selection does not establish race acceptance.', 'Pending work is caused by normal selected-cell bulk clearing and ordinary native saves; no service delay/outcome, private product call or synthetic ClipboardEvent is installed.');
  c.evidence.scenarios = names.map(name => ({name, status: 'unexecuted'}));
  const phase = async (name, action) => { const item = c.evidence.scenarios.find(p => p.name === name); item.status = 'running'; item.started = new Date().toISOString(); try { await action(); item.status = 'passed'; } catch (error) { item.status = 'failed'; item.failure = error.message; throw error; } finally { item.finished = new Date().toISOString(); } };
  assert.equal(c.evidence.windowMode, 'visible', 'Sidebar race requires the owned visible-window mode before launch');
  await c.launch('sidebar-real-pending-race');
  let rootId, audit;
  try {
    await phase(names[0], async () => {
      await c.ui.openFile(OLD_BASE); await c.ui.idle(); await c.ui.command(command);
      await ready(c, sidebar, OLD_VIEW, rowNames[0], 1);
      await c.ui.openFile(FIRST_BASE); await c.ui.idle(); await c.ui.command('Split right');
      await c.ui.wait('return document.querySelectorAll(".pane").length===2;', 'Two actual visible panes');
      await c.ui.openFile(NEWEST_BASE); await ready(c, '.pane.is-active', NEWEST_VIEW, NEWEST_NOTE, 999);
      await c.ui.click(paneTitleSelector(FIRST_VIEW));
      await ready(c, '.pane.is-active', FIRST_VIEW, FIRST_NOTE, 111); await ready(c, sidebar, OLD_VIEW, rowNames[0], 1);
      const before = await c.ui.dom(`return (${installAudit.toString()})();`); assertNoLifecycleErrors(before, 'baseline'); rootId = before.rootId;
      assert.equal(before.rowCount, String(ROW_COUNT + 1)); await c.screenshot('sidebar-race-baseline');
    });
    await phase(names[1], async () => {
      await c.ui.selectCell(rowNames[0], 'note.race_score'); await c.ui.key('a', {modifiers: MOD.meta}); await c.ui.key('Backspace');
      await c.ui.wait(`return document.querySelector(${JSON.stringify(sidebar + ' [role=grid]')})?.getAttribute('aria-busy')==='true';`, 'Actual accepted bulk operation is pending');
      await receipt(c, 'accepted-normal-bulk-clear', rootId);
    });
    await phase(names[2], () => pendingCommand(c, 'first', rootId));
    await phase(names[3], async () => {
      await c.ui.click(paneTitleSelector(NEWEST_VIEW));
      const activation = await receipt(c, 'newest-pane-activated-with-original-work-pending', rootId);
      assert.equal(activation.activeTitle, NEWEST_BASE.replace('.base', ''));
      await pendingCommand(c, 'newest', rootId);
    });
    await phase(names[4], async () => {
      await ready(c, sidebar, NEWEST_VIEW, NEWEST_NOTE, 999);
      for (const [index, file] of rowNames.entries()) await c.saved(file, source => assertClearedSource(source, rowSource(index), c.frontmatter(source), index), 'sidebar-race-durable-bulk-row-' + (index + 1));
      for (const [file, source] of fixtureFiles()) if (!rowNames.includes(file)) assert.equal(await c.read(file), source, 'Immutable fixture ' + file);
      await c.ui.openFile(FIRST_NOTE);
      await c.ui.wait('return document.querySelector(".pane.is-active .tab.is-active .tab-title")?.textContent=== "SidebarRaceFirst";', 'New main note context');
      await ready(c, sidebar, NEWEST_VIEW, NEWEST_NOTE, 999);
      const current = await c.ui.dom('return window.__zoridOwnedSidebarRaceAudit.read();'); assertNoLifecycleErrors(current, 'newest completion');
      audit = await c.ui.dom('return window.__zoridOwnedSidebarRaceAudit.finish();'); assertNewestTrace(audit);
      c.evidence.checks.push({name: 'sidebar-newest-wins-one-mount-through-real-pending-close', audit}); await c.screenshot('sidebar-race-newest-wins');
    });
    await phase(names[5], async () => {
      await c.quit('sidebar-race-normal-quit'); audit = undefined; await c.launch('sidebar-race-normal-reopen');
      await c.ui.wait('return !!document.querySelector(".right-sidebar .sidebar-base-host .bases-session");', 'Restarted sidebar session exists');
      await c.ui.dom(`return (${installAudit.toString()})();`);
      await ready(c, sidebar, NEWEST_VIEW, NEWEST_NOTE, 999);
      for (const [index, file] of rowNames.entries()) await c.saved(file, source => assertClearedSource(source, rowSource(index), c.frontmatter(source), index), 'sidebar-race-restarted-bulk-row-' + (index + 1));
      for (const [file, source] of fixtureFiles()) if (!rowNames.includes(file)) assert.equal(await c.read(file), source, 'Restarted immutable fixture ' + file);
      const restartedAudit = await c.ui.dom('return window.__zoridOwnedSidebarRaceAudit.finish();'); assertRestartedTrace(restartedAudit); audit = restartedAudit;
      c.evidence.checks.push({name: 'sidebar-newest-selection-survives-normal-restart', audit: restartedAudit}); await c.screenshot('sidebar-race-restarted-newest'); await c.quit('sidebar-race-final-normal-quit');
    });
  } finally {
    if (!audit) try { c.evidence.sidebarRaceAudit = await c.ui.dom('return window.__zoridOwnedSidebarRaceAudit?.finish?.()??null;'); } catch (error) { c.evidence.sidebarRaceAuditFailure = error.message; }
  }
}
