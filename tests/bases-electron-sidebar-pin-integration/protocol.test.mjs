import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {parse} from 'yaml';
import {BaseDocument} from '../../src/bases/document.ts';
import {executeBaseQuery} from '../../src/bases/query.ts';
import {BASE, VIEW, A, B, RENAMED_A, ROW_A, ROW_B, ROW_NULL, fixtureFiles, expectedFiles, phases} from './fixtures.mjs';
import {sidebarPinFrame, pinFrameReady, assertPinFrame, assertPinAudit, installPinAudit, assertRenamedIdentity, pinKeyboardPortalFrame, assertCleanPinKeyboardPortal} from './oracles.mjs';
import {keyboardPinFromCleanPortal} from './campaign.mjs';

const expected = {pinned: false, rows: [{path: ROW_A, score: 11}], title: 'Context A'};
const frame = () => ({hostCount: 1, visibleHosts: 1, hostConnected: true, gridVisible: true, gridLabel: VIEW, rowCount: '2',
  controllerVersion: '7', renderedVersion: '7', updating: 'false', error: 'false', busy: 'false', controlCount: 1,
  pinVisible: true, pinLabel: 'Pin sidebar Base', pinPressed: 'false', pinDisabled: false,
  activeTitle: 'Context A', activeNoteTitle: 'Context A', errors: [], rows: [{path: ROW_A, score: '11', widgetVersion: '7', input: null}]});
const accepts = (value, target = expected) => { assert.equal(pinFrameReady(value, target, VIEW), true); return assertPinFrame(value, target); };
const rejects = (value, target = expected) => { assert.equal(pinFrameReady(value, target, VIEW), false); assert.throws(() => assertPinFrame(value, target)); };
function document(markup) {
  const dom = new JSDOM('<body>' + markup + '</body>', {pretendToBeVisual: true, runScripts: 'outside-only'});
  dom.window.structuredClone = structuredClone;
  dom.window.HTMLElement.prototype.getClientRects = function() { return this.closest('[hidden]') ? [] : [{x: 0, y: 0, width: 20, height: 20}]; };
  return dom;
}
test('handwritten fixture selects different category rows and an explicit-null sentinel rather than the Base itself', () => {
  const files = fixtureFiles(), base = BaseDocument.parse(files.get(BASE));
  const snapshot = {version: 1, files: [...files].map(([path, source]) => ({path, properties: path.endsWith('.md') ? parse(/^---\n([\s\S]*?)\n---/.exec(source)?.[1] ?? '') ?? {} : {}}))};
  const paths = currentFilePath => executeBaseQuery(base, snapshot, {currentFilePath}).rows.map(row => row.path);
  assert.deepEqual(paths(A), [ROW_A]); assert.deepEqual(paths(B), [ROW_B]); assert.deepEqual(paths(null), [ROW_NULL]); assert.deepEqual(paths(BASE), []);
  assert.equal(files.size, 7); assert.equal(phases.length, 7); assert.equal(expectedFiles({renamed: true}).get(RENAMED_A), files.get(A));
  assert.equal(expectedFiles({renamed: true}).has(A), false); assert.equal(expectedFiles({renamed: true}).size, 7);
});
test('strict public frame accepts settled pinned/unpinned states and requires the requested main note', () => {
  accepts(frame()); const pinned = frame(); pinned.pinLabel = 'Unpin sidebar Base'; pinned.pinPressed = 'true'; accepts(pinned, {...expected, pinned: true});
  rejects(pinned); const other = frame(); other.activeNoteTitle = 'Context B'; rejects(other);
  const wrongRow = frame(); wrongRow.rows[0].path = ROW_B; wrongRow.rows[0].score = '22'; rejects(wrongRow);
});
test('busy, stale, duplicate, hidden, disabled and missing-control states cannot satisfy an eventual result oracle', () => {
  for (const [key, value] of [['busy', 'true'], ['updating', 'true'], ['error', 'true'], ['renderedVersion', '6'], ['controllerVersion', null],
    ['hostCount', 2], ['visibleHosts', 0], ['controlCount', 0], ['controlCount', 2], ['pinVisible', false], ['pinDisabled', true], ['rowCount', '3']]) {
    const candidate = frame(); candidate[key] = value; rejects(candidate);
  }
  const staleWidget = frame(); staleWidget.rows[0].widgetVersion = '6'; rejects(staleWidget);
  const unexpected = frame(); unexpected.errors = ['The sidebar Base changed.']; rejects(unexpected);
});
test('blank main context requires null note title, the sentinel row and a matching explicit pin state', () => {
  const blank = frame(); blank.activeTitle = 'New tab'; blank.activeNoteTitle = null; blank.rows = [{path: ROW_NULL, score: '0', widgetVersion: '7', input: null}];
  const target = {pinned: false, rows: [{path: ROW_NULL, score: 0}], title: 'New tab', noteTitle: null}; accepts(blank, target);
  const stale = structuredClone(blank); stale.activeNoteTitle = 'Context A'; rejects(stale, target);
  const fallback = structuredClone(blank); fallback.rows = []; fallback.rowCount = '1'; rejects(fallback, target);
});
test('one intentional retained draft requires exact88 and a specific refusal without a changed pin or saved display', () => {
  const retained = frame(); retained.activeTitle = 'Context B'; retained.activeNoteTitle = 'Context B'; retained.rows = [{path: ROW_B, score: '', widgetVersion: '7', input: '88'}]; retained.errors = ['Finish or cancel the property edit before leaving this base'];
  const target = {pinned: false, rows: [{path: ROW_B, score: 22}], title: 'Context B', draft: true, allowRefusal: true}; accepts(retained, target);
  const lost = structuredClone(retained); lost.rows[0].input = null; rejects(lost, target);
  const wrong = structuredClone(retained); wrong.errors = ['The sidebar Base changed.']; rejects(wrong, target);
  const changed = structuredClone(retained); changed.pinPressed = 'true'; changed.pinLabel = 'Unpin sidebar Base'; rejects(changed, target);
});
test('normal rename oracle requires stable entry identity, a revision and absence of the old path', () => {
  const before = {path: A, type: 'file', entryId: 'owned-entry', revision: 'first'}, after = {path: RENAMED_A, type: 'file', entryId: 'owned-entry', revision: 'renamed'};
  assertRenamedIdentity(before, after, null);
  for (const changed of [{...after, entryId: 'replacement'}, {...after, path: A}, {...after, revision: undefined}]) assert.throws(() => assertRenamedIdentity(before, changed, null));
  assert.throws(() => assertRenamedIdentity(before, after, before)); assert.throws(() => assertRenamedIdentity({...before, entryId: undefined}, after, null));
});
test('portable public DOM reader and readiness expression need no parent-process imports inside the renderer', () => {
  const dom = document(`<section class="pane is-active"><div class="tab is-active"><span class="tab-title">Context A</span></div><input class="note-title" value="Context A"></section><aside class="right-sidebar"><div class="right-tabs"><button class="sidebar-base-pin" aria-label="Pin sidebar Base" aria-pressed="false"></button></div><div class="sidebar-base-host"><section class="bases-session" data-base-controller-version="7" data-base-controller-updating="false" data-base-controller-error="false"><div class="bases-session-content" aria-busy="false"><div role="grid" aria-label="${VIEW}" aria-rowcount="2" data-base-rendered-version="7"><div role="gridcell" data-property="file.name" data-path="${ROW_A}">Row One</div><div role="gridcell" data-property="note.score" data-path="${ROW_A}" data-base-widget-version="7">11</div></div></div></section></div></aside>`);
  try {
    const expression = `(()=>{const frame=(${sidebarPinFrame.toString()})(document);return (${pinFrameReady.toString()})(frame,${JSON.stringify(expected)},${JSON.stringify(VIEW)})?frame:false;})()`;
    const value = structuredClone(dom.window.eval(expression)); accepts(value);
    dom.window.document.querySelector('.sidebar-base-pin').disabled = true; assert.equal(dom.window.eval(expression), false);
  } finally { dom.window.close(); }
});
test('audit accepts only the specifically phased retained-draft refusal and never overflows silently', () => {
  const event = {phase: 'retained-draft-refuses-pin', message: 'Finish or cancel the property edit before leaving this base'};
  assertPinAudit({events: [event], overflow: false}, {requireRefusal: true});
  assert.throws(() => assertPinAudit({events: [], overflow: false}, {requireRefusal: true}));
  assert.throws(() => assertPinAudit({events: [{...event, phase: phases[0]}], overflow: false}));
  assert.throws(() => assertPinAudit({events: [{...event, message: 'This base view is closing'}], overflow: false}));
  assert.throws(() => assertPinAudit({events: [event], overflow: true}));
});
test('passive audit captures removed notices and a transient controller error before a phase changes', () => {
  const dom = document('<section class="bases-session" data-base-controller-error="false"><div class="bases-session-status"></div></section>');
  try {
    dom.window.eval(`(${installPinAudit.toString()})();`); const audit = dom.window.__zoridOwnedSidebarPinAudit;
    audit.mark('retained-draft-refuses-pin'); const notice = dom.window.document.createElement('div'); notice.className = 'notice'; notice.textContent = 'Finish or cancel the property edit before leaving this base';
    dom.window.document.body.append(notice); notice.remove(); audit.mark(phases[4]);
    assertPinAudit(structuredClone(audit.read()), {requireRefusal: true});
    const session = dom.window.document.querySelector('.bases-session'); session.setAttribute('data-base-controller-error', 'true'); session.setAttribute('data-base-controller-error', 'false');
    const caught = structuredClone(audit.finish()); assert.equal(caught.events.length, 2); assert.throws(() => assertPinAudit(caught));
  } finally { dom.window.close(); }
});

const keyboardFrame = () => ({panelCount: 1, panelConnected: true, panelVisible: true, bodyPortal: true, nameValue: VIEW, nameDisabled: false,
  triggerExpanded: 'true', pinCount: 1, pinVisible: true, pinDisabled: false, pinLabel: 'Pin sidebar Base', pinPressed: 'false', focusedName: true, focusedPin: false,
  focus: {tag: 'INPUT', role: null, label: 'View name', path: null, property: null}});
function keyboardDriver(frames, {portalCloses = true} = {}) {
  const keys = [], evidence = {actions: []}; let index = 0;
  const ui = {
    async dom(source) { assert.ok(source.includes('pinKeyboardPortalFrame')); return structuredClone(frames[Math.min(index++, frames.length - 1)]); },
    async key(key, options) { keys.push({key, options}); },
    async wait(source, label) { assert.ok(source.includes('View options')); assert.match(label, /before its frozen-context result/); if (!portalCloses) throw Error('Owned clean portal remained connected'); return true; },
    async click() { throw Error('The keyboard route cannot issue a pointer action'); },
  };
  return {ui, evidence, keys};
}
test('clean-portal keyboard protocol retains each focus frame and sends only ordinary Shift+Tab and one Enter', async () => {
  const initial = keyboardFrame(), back = {...keyboardFrame(), focusedName: false, focus: {tag: 'BUTTON', role: null, label: 'Back', path: null, property: null}}, pin = {...keyboardFrame(), focusedName: false, focusedPin: true, focus: {tag: 'BUTTON', role: null, label: 'Pin sidebar Base', path: null, property: null}};
  const driver = keyboardDriver([initial, back, pin]); await keyboardPinFromCleanPortal(driver);
  assert.deepEqual(driver.keys, [{key: 'Tab', options: {modifiers: 8}}, {key: 'Tab', options: {modifiers: 8}}, {key: 'Enter', options: undefined}]);
  const receipt = driver.evidence.actions[0]; assert.equal(receipt.tabKeys, 2); assert.equal(receipt.frames.length, 3); assert.equal(receipt.activated, true); assert.ok(receipt.portalAbsentAt >= receipt.activationAt);
  assert.equal(receipt.frames[0].frame.focusedName, true); assert.equal(receipt.frames.at(-1).frame.focusedPin, true); assert.equal(phases.length, 7);
});
test('a modeled Tab trap fails at48 without activating Pin or issuing a focus/pointer/extra-key fallback', async () => {
  const driver = keyboardDriver([keyboardFrame()]); await assert.rejects(keyboardPinFromCleanPortal(driver), /reachable through bounded ordinary Shift\+Tab/);
  assert.equal(driver.keys.length, 48); assert.ok(driver.keys.every(item => item.key === 'Tab' && item.options.modifiers === 8));
  const receipt = driver.evidence.actions[0]; assert.equal(receipt.tabKeys, 48); assert.equal(receipt.frames.length, 49); assert.equal(receipt.activated, false); assert.equal(receipt.portalAbsentAt, undefined);
});
test('early portal removal, a dirty name, a disabled/wrong Pin and incorrect initial focus all fail before activation', async () => {
  for (const changed of [{panelCount: 0, panelConnected: false}, {nameValue: ''}, {pinDisabled: true}, {pinLabel: 'Unpin sidebar Base', pinPressed: 'true'}, {bodyPortal: false}]) {
    const driver = keyboardDriver([keyboardFrame(), {...keyboardFrame(), ...changed, focusedName: false, focusedPin: true}]);
    await assert.rejects(keyboardPinFromCleanPortal(driver)); assert.equal(driver.keys.length, 1); assert.equal(driver.keys[0].key, 'Tab'); assert.equal(driver.evidence.actions[0].activated, false);
  }
  const initial = keyboardDriver([{...keyboardFrame(), focusedName: false, focusedPin: true}]); await assert.rejects(keyboardPinFromCleanPortal(initial), /initially focuses/); assert.deepEqual(initial.keys, []);
});
test('failure to dismiss the clean portal after one keyboard activation cannot accept a later frozen row', async () => {
  const driver = keyboardDriver([keyboardFrame(), {...keyboardFrame(), focusedName: false, focusedPin: true}], {portalCloses: false});
  await assert.rejects(keyboardPinFromCleanPortal(driver), /Owned clean portal remained connected/);
  assert.deepEqual(driver.keys.map(item => item.key), ['Tab', 'Enter']); assert.equal(driver.evidence.actions[0].activated, true); assert.equal(driver.evidence.actions[0].portalAbsentAt, undefined);
});
test('portable clean-portal reader observes actual fixture focus and rejects portals inside the inert host', () => {
  const dom = document(`<aside class="right-sidebar"><div class="right-tabs"><button class="sidebar-base-pin" aria-label="Pin sidebar Base" aria-pressed="false"></button></div><div class="sidebar-base-host"><button aria-label="Views" aria-expanded="true"></button></div></aside><section class="bases-toolbar-popover" data-panel="View options" role="dialog"><input aria-label="View name" value="${VIEW}"></section>`);
  try {
    const doc = dom.window.document, name = doc.querySelector('input'), pin = doc.querySelector('.sidebar-base-pin'); name.focus();
    const read = () => structuredClone(dom.window.eval(`(${pinKeyboardPortalFrame.toString()})(document)`));
    assertCleanPinKeyboardPortal(read(), {initial: true}); pin.focus(); const focused = read(); assertCleanPinKeyboardPortal(focused); assert.equal(focused.focusedPin, true); assert.equal(focused.focus.label, 'Pin sidebar Base');
    doc.querySelector('.sidebar-base-host').append(doc.querySelector('.bases-toolbar-popover')); assert.throws(() => assertCleanPinKeyboardPortal(read()));
  } finally { dom.window.close(); }
});
