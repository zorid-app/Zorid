import init, { WasmTextReplica } from './pkg/zorid_wasm.js';
const values = [];
const checks = [];
let current;
const array = value => Array.from(value);
function replica(actor) { const result = new WasmTextReplica(actor); values.push(result); return result; }
function apply(doc, bytes) { doc.apply(Uint8Array.from(bytes)); }
function equal(a, b, label) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}
self.onmessage = async ({ data }) => {
  try {
    if (data.phase === 'native-input') {
      await init();
      const input = data.input;
      current = replica(2000);
      apply(current, input.seed);
      equal(current.text(), 'Hello 🦀 world\n', 'native seed');
      const before = current.stateVector();
      current.delete(9, 5);
      current.insert(9, '世');
      const first = array(current.changesSince(before));
      const afterFirst = current.stateVector();
      current.insert(10, '界');
      const second = array(current.changesSince(afterFirst));
      // Native's second delta depends on its first. Integrate only after our
      // offline edits so neither writer generated operations from merged content.
      apply(current, input.second);
      apply(current, input.second);
      apply(current, input.first);
      apply(current, input.first);
      equal(current.text(), 'Hello 🦀 Rust! 世界\n', 'offline merge');
      checks.push('real browser WASM imports native seed and merges independent UTF-16 edits');
      checks.push('native dependent updates integrate out of order with duplicate delivery');

      const nativeDelete = replica(2001);
      apply(nativeDelete, input.deletion);
      apply(nativeDelete, input.seed);
      apply(nativeDelete, input.deletion);
      equal(nativeDelete.text(), 'Hello 🦀 \n', 'native deletion before target');
      const browserDelete = replica(2002);
      apply(browserDelete, input.seed);
      const deleteBefore = browserDelete.stateVector();
      browserDelete.delete(9, 5);
      equal(array(deleteBefore), array(browserDelete.stateVector()), 'delete-only vector unchanged');
      checks.push('native deletion arrives before target; browser exports equal-vector deletion');

      const historical = replica(2003);
      apply(historical, input.yjs.deleted);
      apply(historical, input.yjs.seed);
      apply(historical, input.yjs.deleted);
      equal(historical.text(), input.yjs.expected, 'persisted Yjs13 fixture');
      checks.push('browser WASM reads committed Yjs13 update fixture');
      self.postMessage({
        phase: 'browser-output', ok: true, text: current.text(), first, second,
        snapshot: array(current.snapshot()), state_vector: array(current.stateVector()),
        deletion: array(browserDelete.changesSince(deleteBefore)),
        delete_before: array(deleteBefore), delete_after: array(browserDelete.stateVector()),
      });
    } else if (data.phase === 'native-return') {
      if (!current) throw new Error('initial browser phase must run first');
      apply(current, data.result.diff);
      apply(current, data.result.diff);
      equal(current.text(), data.result.text, 'final native update');
      const restarted = replica(2004);
      apply(restarted, data.result.snapshot);
      equal(restarted.text(), current.text(), 'final snapshot replay');
      checks.push('native post-merge edit returns to browser and replays in fresh WASM instance');
      self.postMessage({ phase: 'done', ok: true, text: current.text(), snapshot: array(current.snapshot()), checks, browser: navigator.userAgent });
      for (const value of values) value.free();
    } else throw new Error('unknown exchange phase');
  } catch (error) {
    self.postMessage({ phase: 'error', ok: false, checks, error: String(error), stack: error?.stack });
  }
};
