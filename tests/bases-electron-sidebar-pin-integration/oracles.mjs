import assert from 'node:assert/strict';
import {VIEW, A, RENAMED_A} from './fixtures.mjs';

/** Passive public-DOM frame. It never invokes the workspace, controller or store. */
export function sidebarPinFrame(document) {
  const visible = node => !!node && !!node.getClientRects().length && !node.closest('[hidden]');
  const hosts = [...document.querySelectorAll('.right-sidebar .sidebar-base-host')];
  const host = hosts[0], session = host?.querySelector('.bases-session'), grid = session?.querySelector('[role="grid"]');
  const controls = [...document.querySelectorAll('.right-sidebar .right-tabs button.sidebar-base-pin')], control = controls[0];
  const version = session?.getAttribute('data-base-controller-version') ?? null;
  const rowCells = [...(grid?.querySelectorAll('[role="gridcell"][data-property="file.name"]') ?? [])];
  const rows = rowCells.map(cell => {
    const path = cell.getAttribute('data-path'), score = [...grid.querySelectorAll('[role="gridcell"][data-property="note.score"]')].filter(candidate => candidate.getAttribute('data-path') === path);
    return {path, score: score.length === 1 ? score[0].textContent.trim() : null,
      widgetVersion: score[0]?.getAttribute('data-base-widget-version') ?? null,
      input: score[0]?.querySelector('input:not([type="checkbox"])')?.value ?? null};
  });
  return {hostCount: hosts.length, visibleHosts: hosts.filter(visible).length, hostConnected: !!host?.isConnected,
    gridVisible: visible(grid), gridLabel: grid?.getAttribute('aria-label') ?? null, rowCount: grid?.getAttribute('aria-rowcount') ?? null,
    controllerVersion: version, renderedVersion: grid?.getAttribute('data-base-rendered-version') ?? null,
    updating: session?.getAttribute('data-base-controller-updating') ?? null, error: session?.getAttribute('data-base-controller-error') ?? null,
    busy: session?.querySelector('.bases-session-content')?.getAttribute('aria-busy') ?? null,
    controlCount: controls.length, pinVisible: visible(control), pinLabel: control?.getAttribute('aria-label') ?? null,
    pinPressed: control?.getAttribute('aria-pressed') ?? null, pinDisabled: control?.disabled ?? null,
    activeTitle: document.querySelector('.pane.is-active .tab.is-active .tab-title')?.textContent.trim() ?? null,
    activeNoteTitle: document.querySelector('.pane.is-active input.note-title')?.value ?? null,
    errors: [...document.querySelectorAll('.notice,[role="alert"]')].filter(visible).map(node => node.textContent.trim()).filter(Boolean), rows};
}
export function assertPinFrame(frame, {pinned, rows, title, noteTitle = title, draft = false, allowRefusal = false}) {
  assert.equal(typeof pinned, 'boolean');
  assert.equal(frame.hostCount, 1); assert.equal(frame.visibleHosts, 1); assert.equal(frame.hostConnected, true);
  assert.equal(frame.gridVisible, true); assert.equal(frame.gridLabel, VIEW);
  assert.equal(frame.rowCount, String(rows.length + 1), 'Fixture has a column header and no summary footer');
  assert.match(frame.controllerVersion ?? '', /^(0|[1-9]\d*)$/); assert.equal(frame.renderedVersion, frame.controllerVersion);
  assert.equal(frame.updating, 'false'); assert.equal(frame.error, 'false'); assert.equal(frame.busy, 'false');
  assert.equal(frame.controlCount, 1); assert.equal(frame.pinVisible, true); assert.equal(frame.pinDisabled, false);
  assert.equal(frame.pinPressed, String(pinned)); assert.equal(frame.pinLabel, pinned ? 'Unpin sidebar Base' : 'Pin sidebar Base');
  assert.equal(frame.activeTitle, title); assert.equal(frame.activeNoteTitle, noteTitle);
  assert.equal(frame.rows.length, rows.length);
  for (const [index, expected] of rows.entries()) {
    assert.equal(frame.rows[index].path, expected.path); assert.equal(frame.rows[index].widgetVersion, frame.controllerVersion);
    assert.equal(frame.rows[index].input, draft ? '88' : null);
    if (!draft) assert.equal(frame.rows[index].score, String(expected.score));
  }
  if (allowRefusal) { assert.ok(frame.errors.length > 0); assert.ok(frame.errors.every(text => /Finish or cancel the property edit/.test(text))); }
  else assert.deepEqual(frame.errors, []);
  return frame;
}
/** Portable readiness predicate; the parent process separately asserts the frame. */
export function pinFrameReady(frame, expected, view) {
  try {
    const {pinned, rows, title, draft = false, allowRefusal = false} = expected;
    const noteTitle = expected.noteTitle === undefined ? title : expected.noteTitle;
    return typeof pinned === 'boolean' && frame.hostCount === 1 && frame.visibleHosts === 1 && frame.hostConnected === true
      && frame.gridVisible === true && frame.gridLabel === view && frame.rowCount === String(rows.length + 1)
      && /^(0|[1-9]\d*)$/.test(frame.controllerVersion) && frame.renderedVersion === frame.controllerVersion
      && frame.updating === 'false' && frame.error === 'false' && frame.busy === 'false'
      && frame.controlCount === 1 && frame.pinVisible === true && frame.pinDisabled === false
      && frame.pinPressed === String(pinned) && frame.pinLabel === (pinned ? 'Unpin sidebar Base' : 'Pin sidebar Base')
      && frame.activeTitle === title && frame.activeNoteTitle === noteTitle && frame.rows.length === rows.length
      && frame.rows.every((row, index) => row.path === rows[index].path && row.widgetVersion === frame.controllerVersion
        && row.input === (draft ? '88' : null) && (draft || row.score === String(rows[index].score)))
      && (allowRefusal ? frame.errors.length > 0 && frame.errors.every(text => /Finish or cancel the property edit/.test(text)) : frame.errors.length === 0);
  } catch { return false; }
}
export function assertRenamedIdentity(before, after, oldPath) {
  assert.equal(before?.type, 'file'); assert.equal(before?.path, A); assert.ok(typeof before.entryId === 'string' && before.entryId.length);
  assert.ok(typeof before.revision === 'string' && before.revision.length);
  assert.equal(after?.type, 'file'); assert.equal(after?.path, RENAMED_A); assert.equal(after?.entryId, before.entryId, 'Normal rename preserves pinned source identity');
  assert.ok(typeof after.revision === 'string' && after.revision.length); assert.equal(oldPath, null, 'Original context path is absent after rename');
}
export function assertPinAudit(audit, {requireRefusal = false} = {}) {
  assert.equal(audit.overflow, false, 'Passive notice/error audit is bounded and complete');
  for (const event of audit.events) {
    assert.equal(event.phase, 'retained-draft-refuses-pin', 'Unexpected lifecycle message outside the one intentional refusal');
    assert.match(event.message, /Finish or cancel the property edit/);
  }
  if (requireRefusal) assert.ok(audit.events.length > 0, 'Intentional draft refusal was observed');
}
/** Test-owned bounded error observation only; no product state or callbacks. */
export function installPinAudit() {
  let phase = 'ordinary-sidebar-context', overflow = false;
  const events = [], seen = new WeakMap();
  const append = (node, message) => {
    message = message?.trim(); if (!message || seen.get(node) === message) return; seen.set(node, message);
    if (events.length >= 128) { overflow = true; return; } events.push({phase, message, at: performance.now()});
  };
  const inspect = node => {
    if (node.nodeType !== 1) return;
    for (const alert of [...(node.matches('.notice,[role="alert"]') ? [node] : []), ...node.querySelectorAll('.notice,[role="alert"]')]) if (!alert.closest('[hidden]')) append(alert, alert.textContent);
    for (const session of [...(node.matches('.bases-session[data-base-controller-error="true"]') ? [node] : []), ...node.querySelectorAll('.bases-session[data-base-controller-error="true"]')]) append(session, session.querySelector('.bases-session-status')?.textContent || 'Base controller error');
  };
  const process = records => {
    for (const record of records) {
      const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      const alert = element?.closest('.notice,[role="alert"]'); if (alert) inspect(alert);
      if (record.type === 'attributes') {
        inspect(record.target);
        if (record.attributeName === 'data-base-controller-error' && record.oldValue === 'true' && record.target.getAttribute('data-base-controller-error') !== 'true') append(record.target, 'Observed Base controller error');
      }
      else if (record.type === 'childList') for (const node of [...record.addedNodes, ...record.removedNodes]) inspect(node);
    }
  };
  const observer = new MutationObserver(process); observer.observe(document.body, {subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true, attributeFilter: ['data-base-controller-error']});
  inspect(document.body);
  window.__zoridOwnedSidebarPinAudit = {
    mark(next) { process(observer.takeRecords()); phase = next; },
    read() { process(observer.takeRecords()); return {events: structuredClone(events), overflow}; },
    finish() { process(observer.takeRecords()); observer.disconnect(); return {events: structuredClone(events), overflow}; },
  };
}
