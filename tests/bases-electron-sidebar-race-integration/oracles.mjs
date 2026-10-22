import assert from 'node:assert/strict';
import {OLD_VIEW, FIRST_VIEW, NEWEST_VIEW, ROW_COUNT} from './fixtures.mjs';
export const paneTitleSelector = view => `.pane:has([role="grid"][aria-label=${JSON.stringify(view)}]) .tab.is-active .tab-title`;
export function assertNoLifecycleErrors(receipt, label) {
  assert.deepEqual(receipt.errors, [], `Unexpected lifecycle error ${label}: ${receipt.errors.join('; ')}`);
}
export function assertPending(receipt, label, originalRoot) {
  assertNoLifecycleErrors(receipt, label);
  assert.equal(receipt.totalHostCount, 1, `In-flight precondition missed ${label}: hidden or duplicate sidebar host`);
  assert.equal(receipt.gridVisible, true, `In-flight precondition missed ${label}: grid is hidden`);
  assert.equal(receipt.hostCount, 1, `In-flight precondition missed ${label}: one original sidebar host required`);
  assert.equal(receipt.originalConnected, true, `In-flight precondition missed ${label}: original sidebar retired`);
  assert.equal(receipt.originalIsCurrent, true, `In-flight precondition missed ${label}: sidebar was replaced`);
  assert.equal(receipt.gridLabel, OLD_VIEW, `In-flight precondition missed ${label}: original sidebar label`);
  assert.equal(receipt.gridBusy, 'true', `In-flight precondition missed ${label}: accepted bulk operation already settled; no race exercised`);
  assert.equal(receipt.rowCount, String(ROW_COUNT + 1), `Unexpected original row count ${label}`);
  if (originalRoot !== undefined) assert.equal(receipt.rootId, originalRoot, `Original sidebar identity changed ${label}`);
  assert.equal(receipt.overflow, false, 'Passive sidebar audit overflowed');
  return receipt.rootId;
}
export function assertNewestTrace(audit) {
  assert.equal(audit.overflow, false, 'Passive sidebar audit overflowed');
  assert.ok(Number.isInteger(audit.secondMarker), 'Second pending dispatch marker required');
  for (const event of audit.events) {
    assertNoLifecycleErrors(event, 'passive sidebar trace');
    assert.ok(event.totalHostCount <= 1 && (event.observedHostCount === undefined || event.observedHostCount <= 1), 'Two sidebar hosts became present');
  }
  const relevant = audit.events.slice(audit.secondMarker);
  assert.ok(relevant.length, 'Newest-selection trace is empty');
  for (const event of relevant) {
    assert.equal(event.hostCount <= 1, true, 'Two sidebar hosts became visible');
    assert.notEqual(event.observedGridLabel, FIRST_VIEW, 'Superseded first selection revived within one DOM batch');
    assert.notEqual(event.gridLabel, FIRST_VIEW, 'Superseded first selection revived after the newer pending command');
  }
  const winners = new Set();
  for (const event of relevant) {
    if (event.gridLabel === NEWEST_VIEW) winners.add(event.rootId);
    if (event.observedGridLabel === NEWEST_VIEW) winners.add(event.observedRootId);
  }
  assert.equal(winners.size, 1, 'Exactly one newest sidebar session must mount');
  assertVisibleNewest(relevant.at(-1), 'Newest sidebar remains the final visible target');
}
function assertVisibleNewest(event, label) {
  assertNoLifecycleErrors(event, label);
  assert.equal(event.hostCount, 1, 'Exactly one visible newest sidebar host required');
  assert.equal(event.totalHostCount, 1, 'No hidden duplicate sidebar host is accepted');
  assert.equal(event.gridVisible, true, 'Newest sidebar grid is visible');
  assert.equal(event.gridLabel, NEWEST_VIEW, label);
  assert.equal(event.rowCount, '2', 'Newest sidebar contains exactly its one note');
}
export function assertRestartedTrace(audit) {
  assert.equal(audit.overflow, false, 'Restarted sidebar audit overflowed');
  assert.ok(audit.events.length, 'Restarted sidebar trace is empty');
  for (const event of audit.events) {
    assertNoLifecycleErrors(event, 'restarted sidebar trace');
    assert.ok(event.totalHostCount <= 1 && (event.observedHostCount === undefined || event.observedHostCount <= 1), 'Duplicate restarted sidebar hosts');
  }
  assertVisibleNewest(audit.events.at(-1), 'Restarted sidebar remains the newest target');
}
export function assertClearedSource(source, original, properties, index) {
  assert.equal(properties.race_score, null, `Row ${index + 1}: normal bulk clear is durable`);
  assert.deepEqual(properties, {race_score: null, sentinel: `keep-${index + 1}`}, 'Bulk clear changes only the selected property');
  const body = text => text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
  assert.equal(body(source), body(original), 'Bulk clear preserves the complete original body');
}
