import assert from 'node:assert/strict';

// Real Chromium dragstart produces the payload. No synthetic DOM DragEvents,
// DataTransfer fabrication, controller calls, or positive filesystem edits.
export async function beginDrag(c, source) {
  const from = await c.ui.point(source);
  await c.cdp.call('Input.setInterceptDrags', {enabled: true});
  let listener, timer, finished = false, last = from;
  const intercepted = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Error('Chromium did not intercept the actual dragstart: ' + source)), 8000);
    listener = event => { const value = JSON.parse(event.data); if (value.method === 'Input.dragIntercepted') { clearTimeout(timer); resolve(value.params.data); } };
    c.cdp.ws.addEventListener('message', listener);
  });
  intercepted.catch(() => {});
  const release = async () => {
    if (finished) return; finished = true;
    clearTimeout(timer); if (listener) c.cdp.ws.removeEventListener('message', listener);
    try { await c.cdp.call('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...last}); }
    finally { await c.cdp.call('Input.setInterceptDrags', {enabled: false}); }
  };
  try {
    await c.cdp.call('Input.dispatchMouseEvent', {type: 'mouseMoved', ...from});
    await c.cdp.call('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...from});
    for (let i = 1; i <= 12; i++) await c.cdp.call('Input.dispatchMouseEvent', {type: 'mouseMoved', button: 'left', buttons: 1, x: from.x + i * 3, y: from.y + i});
    const data = await intercepted;
    assert.ok(Array.isArray(data.items) && data.items.length, 'The native source supplied a nonempty drag payload');
    c.evidence.actions.push({action: 'native-layout-drag-intercept', source, data, at: Date.now()});
    await c.cdp.call('Input.dispatchDragEvent', {type: 'dragEnter', ...from, data});
    return {
      data,
      async over(target) { last = await c.ui.point(target); await c.cdp.call('Input.dispatchDragEvent', {type: 'dragOver', ...last, data}); return last; },
      async drop(target) { last = await c.ui.point(target); await c.cdp.call('Input.dispatchDragEvent', {type: 'drop', ...last, data}); await release(); },
      async escape() {
        // The oracle must observe actual Escape/dragend. dragCancel below is
        // cleanup only and can never satisfy a successful cancellation check.
        await c.ui.key('Escape');
      },
      async cleanup() { if (!finished) { try { await c.cdp.call('Input.dispatchDragEvent', {type: 'dragCancel', ...last, data}); } finally { await release(); } } },
    };
  } catch (error) { await release(); throw error; }
}
export function assertWikiPayload(data, expected) {
  const plain = data.items.filter(item => item.mimeType === 'text/plain');
  assert.deepEqual(plain.map(item => item.data), [expected], 'Native file drag carries exactly the captured Markdown link');
}
