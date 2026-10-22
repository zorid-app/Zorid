import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {fixtureFiles, rowNames, rowSource, ROW_COUNT, OLD_VIEW, FIRST_VIEW, NEWEST_VIEW} from './fixtures.mjs';
import {assertPending, assertNewestTrace, assertRestartedTrace, assertClearedSource, paneTitleSelector} from './oracles.mjs';
import {installAudit} from './campaign.mjs';
import {CAMPAIGN_DIRECTORIES} from '../bases-electron-integration/owned-fixtures.mjs';
const pending = () => ({hostCount: 1, totalHostCount: 1, gridVisible: true, originalConnected: true, originalIsCurrent: true, gridLabel: OLD_VIEW, gridBusy: 'true', rowCount: String(ROW_COUNT + 1), overflow: false, errors: [], rootId: 1});
const trace = () => ({secondMarker: 1, overflow: false, events: [pending(), pending(), {...pending(), originalConnected: false, originalIsCurrent: false, gridLabel: null, rootId: null}, {...pending(), originalConnected: false, originalIsCurrent: false, gridLabel: NEWEST_VIEW, gridBusy: null, rowCount: '2', rootId: 2}]});
test('campaign is admitted with exactly32 bounded row fixtures and immutable independent winner targets', () => {
  assert.ok(CAMPAIGN_DIRECTORIES.includes('bases-electron-sidebar-race-integration'));
  const files = fixtureFiles(); assert.equal(files.size, 38); assert.equal(rowNames.length, 32);
  assert.equal([...files.keys()].filter(path => path.startsWith('SidebarRaceRows/')).length, 32);
  rowNames.forEach((name, i) => assert.equal(files.get(name), rowSource(i)));
  const again = fixtureFiles(); files.set(rowNames[0], 'caller mutation'); assert.equal(again.get(rowNames[0]), rowSource(0));
});
test('observed original pending identity is required at every command boundary, never inferred from final selection', () => {
  assert.equal(assertPending(pending(), 'first-before'), 1); assert.equal(assertPending(pending(), 'newest-after', 1), 1);
  for (const change of [{totalHostCount: 2}, {gridVisible: false}, {gridBusy: null}, {gridBusy: 'false'}, {originalConnected: false}, {originalIsCurrent: false}, {gridLabel: NEWEST_VIEW}, {hostCount: 0}, {hostCount: 2}, {rowCount: '2'}, {overflow: true}, {rootId: 2}]) {
    assert.throws(() => assertPending({...pending(), ...change}, 'newest-before', 1));
  }
});
test('closing-context and partial-save errors cannot be ignored even while an old grid remains pending', () => {
  for (const message of ['This base view is closing', 'The sidebar Base changed.', 'Some files were saved before editing Row02.md failed.']) {
    assert.throws(() => assertPending({...pending(), errors: [message]}, 'first-after', 1), /Unexpected lifecycle error/);
  }
  const value = trace(); value.events[1].errors = ['The sidebar Base changed.']; assert.throws(() => assertNewestTrace(value), /Unexpected lifecycle error/);
});
test('one newest session is accepted while a late older target, duplicate mount, or missing overlap marker fails', () => {
  assertNewestTrace(trace());
  const old = trace(); old.events.splice(3, 0, {...pending(), gridLabel: FIRST_VIEW, rootId: 3}); assert.throws(() => assertNewestTrace(old), /Superseded first selection revived/);
  const duplicate = trace(); duplicate.events.push({...duplicate.events.at(-1), rootId: 4}); assert.throws(() => assertNewestTrace(duplicate), /Exactly one newest/);
  const two = trace(); two.events[2].hostCount = 2; assert.throws(() => assertNewestTrace(two), /Two sidebar hosts/);
  const missing = trace(); missing.secondMarker = undefined; assert.throws(() => assertNewestTrace(missing), /dispatch marker/);
  const overflow = trace(); overflow.overflow = true; assert.throws(() => assertNewestTrace(overflow), /overflowed/);
});
test('durable clear oracle preserves every unselected property and complete body', () => {
  const initial = rowSource(0), cleared = initial.replace('race_score: 1', 'race_score: null');
  assertClearedSource(cleared, initial, {race_score: null, sentinel: 'keep-1'}, 0);
  assert.throws(() => assertClearedSource(initial, initial, {race_score: 1, sentinel: 'keep-1'}, 0));
  assert.throws(() => assertClearedSource(cleared + 'Changed body', initial, {race_score: null, sentinel: 'keep-1'}, 0), /complete original body/);
  assert.throws(() => assertClearedSource(cleared, initial, {race_score: null, sentinel: 'changed'}, 0), /only the selected property/);
});

test('visible target panes are located by exact grid labels without sibling-index assumptions', () => {
  const dom = new JSDOM('<main><section><div class="pane" id="left"><div class="tab is-active"><span class="tab-title">First</span></div><div role="grid"></div></div></section><aside><div class="pane" id="right"><div class="tab is-active"><span class="tab-title">Newest</span></div><div role="grid"></div></div></aside></main>');
  try {
    const doc = dom.window.document; doc.querySelector('#left [role=grid]').setAttribute('aria-label', FIRST_VIEW); doc.querySelector('#right [role=grid]').setAttribute('aria-label', NEWEST_VIEW);
    assert.equal(doc.querySelector(paneTitleSelector(FIRST_VIEW)).textContent, 'First'); assert.equal(doc.querySelector(paneTitleSelector(NEWEST_VIEW)).textContent, 'Newest');
    assert.equal(doc.querySelectorAll(paneTitleSelector(FIRST_VIEW)).length, 1); assert.equal(doc.querySelectorAll(paneTitleSelector(NEWEST_VIEW)).length, 1);
  } finally { dom.window.close(); }
});

function auditDOM() {
  const dom = new JSDOM('<main><div class="right-sidebar"><div class="sidebar-base-host"><div class="bases-session"><div role="grid"></div></div></div></div></main>', {runScripts: 'outside-only'});
  dom.window.HTMLElement.prototype.getClientRects = function () { return this.closest('[hidden]') ? [] : [{}]; };
  const grid = dom.window.document.querySelector('[role=grid]'); grid.setAttribute('aria-label', OLD_VIEW); grid.setAttribute('aria-rowcount', '33'); grid.setAttribute('aria-busy', 'true');
  dom.window.eval(`(${installAudit.toString()})()`);
  return {dom, audit: dom.window.__zoridOwnedSidebarRaceAudit, sidebar: dom.window.document.querySelector('.right-sidebar')};
}
const finishAudit = audit => JSON.parse(JSON.stringify(audit.finish())); // Match CDP's serialized DOM boundary.
function newHost(dom, view) {
  const host = dom.window.document.createElement('div'); host.className = 'sidebar-base-host'; host.innerHTML = '<div class="bases-session"><div role="grid" aria-rowcount="2" aria-busy="false"></div></div>';
  host.querySelector('[role=grid]').setAttribute('aria-label', view); return host;
}
test('actual observer rejects a superseded host inserted and removed within a single DOM batch', async () => {
  const {dom, audit, sidebar} = auditDOM();
  try {
    audit.markSecond(); sidebar.firstElementChild.remove();
    const first = newHost(dom, FIRST_VIEW); sidebar.append(first); first.remove(); sidebar.append(newHost(dom, NEWEST_VIEW));
    await Promise.resolve(); const result = finishAudit(audit);
    assert.ok(result.events.some(event => event.observedGridLabel === FIRST_VIEW));
    assert.throws(() => assertNewestTrace(result), /Superseded first selection/);
  } finally { dom.window.close(); }
});
test('actual observer retains intermediate labels and drains older records before the newest marker', () => {
  const first = auditDOM();
  try {
    first.audit.markSecond(); const grid = first.sidebar.querySelector('[role=grid]');
    grid.setAttribute('aria-label', FIRST_VIEW); grid.setAttribute('aria-label', NEWEST_VIEW); grid.setAttribute('aria-rowcount', '2');
    assert.throws(() => assertNewestTrace(finishAudit(first.audit)), /Superseded first selection/);
  } finally { first.dom.window.close(); }
  const second = auditDOM();
  try {
    second.sidebar.firstElementChild.remove(); const transient = newHost(second.dom, FIRST_VIEW); second.sidebar.append(transient); transient.remove(); second.sidebar.append(newHost(second.dom, NEWEST_VIEW));
    second.audit.markSecond(); assertNewestTrace(finishAudit(second.audit));
  } finally { second.dom.window.close(); }
});
test('actual audit marker shares the512-event bound and reports overflow immediately', () => {
  const {dom, audit, sidebar} = auditDOM();
  try {
    const grid = sidebar.querySelector('[role=grid]');
    for (let i = 0; i < 511; i++) { grid.setAttribute('aria-rowcount', String(i)); audit.read(); }
    assert.equal(audit.events.length, 512); assert.equal(audit.overflow, false);
    audit.markSecond(); assert.equal(audit.events.length, 512); assert.equal(audit.overflow, true);
    assert.throws(() => assertNewestTrace(finishAudit(audit)), /overflowed/);
  } finally { dom.window.close(); }
});
test('restart acceptance rejects hidden or duplicate hosts and lifecycle errors', () => {
  const final = {...pending(), gridLabel: NEWEST_VIEW, rowCount: '2'};
  assertRestartedTrace({events: [final], overflow: false});
  for (const change of [{gridVisible: false}, {hostCount: 0}, {totalHostCount: 2}, {errors: ['This base view is closing']}]) assert.throws(() => assertRestartedTrace({events: [{...final, ...change}], overflow: false}));
  const {dom, audit, sidebar} = auditDOM();
  try {
    sidebar.firstElementChild.remove(); sidebar.append(newHost(dom, NEWEST_VIEW)); const hidden = newHost(dom, NEWEST_VIEW); hidden.hidden = true; sidebar.append(hidden);
    assert.throws(() => assertRestartedTrace(finishAudit(audit)), /Duplicate restarted sidebar hosts/);
  } finally { dom.window.close(); }
});

test('actual observer rejects duplicate newest mounts and simultaneous hosts within one DOM batch', () => {
  for (const overlap of [false, true]) {
    const {dom, audit, sidebar} = auditDOM();
    try {
      audit.markSecond(); const original = sidebar.firstElementChild;
      if (!overlap) original.remove();
      const transient = newHost(dom, NEWEST_VIEW); sidebar.append(transient);
      if (overlap) original.remove();
      transient.remove(); sidebar.append(newHost(dom, NEWEST_VIEW));
      assert.throws(() => assertNewestTrace(finishAudit(audit)), overlap ? /Two sidebar hosts/ : /Exactly one newest/);
    } finally { dom.window.close(); }
  }
});

test('actual observer preserves same-batch outside notices and transient controller errors for both trace oracles', () => {
  for (const kind of ['notice', 'alert', 'controller', 'text-update']) {
    const {dom, audit, sidebar} = auditDOM();
    try {
      sidebar.firstElementChild.remove(); sidebar.append(newHost(dom, NEWEST_VIEW)); audit.markSecond();
      if (kind === 'controller') {
        const session = sidebar.querySelector('.bases-session'); session.setAttribute('data-base-controller-error', 'true'); session.setAttribute('data-base-controller-error', 'false');
      } else {
        const alert = dom.window.document.createElement('div');
        if (kind === 'notice') alert.className = 'notice'; else alert.setAttribute('role', 'alert');
        if (kind === 'text-update') {
          const text = dom.window.document.createTextNode(''); alert.append(text); dom.window.document.body.append(alert); text.data = 'This base view is closing'; text.data = '';
        } else { alert.textContent = 'This base view is closing'; dom.window.document.body.append(alert); }
        alert.remove();
      }
      const result = finishAudit(audit);
      assert.ok(result.events.some(event => event.errors.length));
      assert.throws(() => assertNewestTrace(result), /Unexpected lifecycle error/);
      assert.throws(() => assertRestartedTrace(result), /Unexpected lifecycle error/);
    } finally { dom.window.close(); }
  }
});
