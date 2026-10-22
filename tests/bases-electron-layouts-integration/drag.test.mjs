import test from 'node:test';
import assert from 'node:assert/strict';
import {beginDrag} from './drag.mjs';

// Protocol lifecycle unit tests only. Actual native payload/drag acceptance is
// exclusively asserted by the separately executed Electron journey.
function fixture() {
  const calls = [], points = [], ws = new EventTarget(), payload = {items: [{mimeType: 'text/plain', data: 'native-test-payload'}]};
  let intercepted = false, failOver = false, failDrop = false, target = {x: 400, y: 120};
  const c = {evidence: {actions: []}, ui: {async point(selector) {points.push(selector); return selector === 'source' ? {x: 100, y: 120} : {...target};}},
    cdp: {ws, async call(method, params) {
      calls.push({method, ...structuredClone(params)});
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved' && params.buttons === 1 && !intercepted) {intercepted = true; ws.dispatchEvent(new MessageEvent('message', {data: JSON.stringify({method: 'Input.dragIntercepted', params: {data: payload}})}));}
      if (params.type === 'dragOver' && failOver) throw Error('dragOver failed');
      if (params.type === 'drop' && failDrop) throw Error('drop failed');
    }} };
  return {c, calls, points, set target(value) {target = value;}, set failOver(value) {failOver = value;}, set failDrop(value) {failDrop = value;}};
}

test('dropAtLast preserves successful dragOver coordinates when live preview moves the target', async () => {
  const f = fixture(), drag = await beginDrag(f.c, 'source'), point = await drag.over('target');
  f.target = {x: 100, y: 120}; point.x = 999; // Neither relocated DOM nor a caller's returned point may retarget the drop.
  await drag.dropAtLast(); await drag.cleanup(); await drag.cleanup();
  assert.deepEqual(f.points, ['source', 'target']);
  const drops = f.calls.filter(call => call.type === 'drop'); assert.equal(drops.length, 1); assert.deepEqual({x: drops[0].x, y: drops[0].y}, {x: 400, y: 120});
  const releases = f.calls.filter(call => call.type === 'mouseReleased'); assert.equal(releases.length, 1); assert.deepEqual({x: releases[0].x, y: releases[0].y}, {x: 400, y: 120});
  assert.equal(f.calls.filter(call => call.type === 'dragCancel').length, 0); assert.equal(f.calls.filter(call => call.method === 'Input.setInterceptDrags' && call.enabled === false).length, 1);
  await assert.rejects(drag.dropAtLast(), /already finished/);
});

test('dropAtLast requires an accepted dragOver and cleanup remains single-owner', async () => {
  const f = fixture(), drag = await beginDrag(f.c, 'source'); await assert.rejects(drag.dropAtLast(), /successful dragOver/);
  f.failOver = true; await assert.rejects(drag.over('target'), /dragOver failed/); await assert.rejects(drag.dropAtLast(), /successful dragOver/);
  await drag.cleanup(); await drag.cleanup(); assert.equal(f.calls.filter(call => call.type === 'drop').length, 0); assert.equal(f.calls.filter(call => call.type === 'dragCancel').length, 1); assert.equal(f.calls.filter(call => call.type === 'mouseReleased').length, 1);
});

test('a failed later dragOver cannot replace the previously accepted pointer destination', async () => {
  const f = fixture(), drag = await beginDrag(f.c, 'source'); await drag.over('target'); f.target = {x: 700, y: 300}; f.failOver = true;
  await assert.rejects(drag.over('target'), /dragOver failed/); await drag.dropAtLast(); await drag.cleanup();
  const drop = f.calls.find(call => call.type === 'drop'); assert.deepEqual({x: drop.x, y: drop.y}, {x: 400, y: 120}); assert.equal(f.calls.filter(call => call.type === 'dragCancel').length, 0);
});

test('failed drop keeps cancellation and pointer release available to final cleanup', async () => {
  const f = fixture(), drag = await beginDrag(f.c, 'source'); await drag.over('target'); f.failDrop = true; await assert.rejects(drag.dropAtLast(), /drop failed/);
  await drag.cleanup(); await drag.cleanup(); assert.equal(f.calls.filter(call => call.type === 'dragCancel').length, 1); assert.equal(f.calls.filter(call => call.type === 'mouseReleased').length, 1); assert.equal(f.calls.filter(call => call.method === 'Input.setInterceptDrags' && call.enabled === false).length, 1);
});
