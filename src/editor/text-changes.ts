/** UTF-16 source offsets, structurally compatible with CodeMirror ChangeSpec. */
export interface TextChange { from: number; to: number; insert: string }

/** Optional deterministic instrumentation; no clocks or retained source data. */
export interface TextChangeDiagnostics { work: number; traceCells: number; fallback: boolean }

interface Span { from: number; to: number; newFrom: number; newTo: number }
const MAX_DISTANCE = 128;
const FRONTIER_SIZE = MAX_DISTANCE * 2 + 3;
const OFFSET = MAX_DISTANCE + 1;

function splitsSurrogate(text: string, at: number): boolean {
  return at > 0 && at < text.length && text.charCodeAt(at - 1) >= 0xd800
    && text.charCodeAt(at - 1) <= 0xdbff && text.charCodeAt(at) >= 0xdc00
    && text.charCodeAt(at) <= 0xdfff;
}

function materialize(previous: string, next: string, spans: Span[]): TextChange[] {
  const runs: Span[] = [];
  for (const span of spans) {
    const last = runs.at(-1);
    if (last && last.to === span.from && last.newTo === span.newFrom) {
      last.to = span.to; last.newTo = span.newTo;
    } else runs.push(span);
  }
  const merged: Span[] = [];
  for (const span of runs) {
    // Equal runs can end between the two code units of a shared surrogate pair.
    // Include that pair in the edit rather than expose an interior text position.
    if (span.from > 0 && span.newFrom > 0
      && previous.charCodeAt(span.from - 1) === next.charCodeAt(span.newFrom - 1)
      && (splitsSurrogate(previous, span.from) || splitsSurrogate(next, span.newFrom))) {
      span.from--; span.newFrom--;
    }
    if (span.to < previous.length && span.newTo < next.length
      && previous.charCodeAt(span.to) === next.charCodeAt(span.newTo)
      && (splitsSurrogate(previous, span.to) || splitsSurrogate(next, span.newTo))) {
      span.to++; span.newTo++;
    }
    const last = merged.at(-1);
    if (last && span.from <= last.to && span.newFrom <= last.newTo) {
      last.to = Math.max(last.to, span.to); last.newTo = Math.max(last.newTo, span.newTo);
    } else merged.push(span);
  }
  return merged.map(span => ({ from: span.from, to: span.to, insert: next.slice(span.newFrom, span.newTo) }));
}

/**
 * Preserve unchanged islands between small, separated edits without splitting
 * documents into per-character/line arrays. Equal prefix/suffix scans are linear.
 * The middle uses Myers frontiers, capped at 128 inserted/deleted UTF-16 units
 * and 4 * (old middle + new middle) + 65,536 frontier/comparison steps. Trace
 * storage never exceeds 129 * 259 Int32 cells (about 131 KiB), independent of
 * document size. Backtracking records only edits, not each matching character.
 *
 * If either cap is reached, replace the trimmed middle exactly. That bounded
 * fallback may collapse positions inside it; unchanged prefix/suffix positions
 * still map normally. Repeated text uses a deterministic, deletion-first tie.
 */
export function textChanges(previous: string, next: string, diagnostics?: TextChangeDiagnostics): TextChange[] {
  let work = 0, traceCells = 0;
  const finish = (spans: Span[], fallback = false): TextChange[] => {
    if (diagnostics) Object.assign(diagnostics, { work, traceCells, fallback });
    return materialize(previous, next, spans);
  };
  if (previous === next) return finish([]);
  let from = 0;
  while (from < previous.length && from < next.length) {
    work++;
    if (previous.charCodeAt(from) !== next.charCodeAt(from)) break;
    from++;
  }
  let to = previous.length, newTo = next.length;
  while (to > from && newTo > from) {
    work++;
    if (previous.charCodeAt(to - 1) !== next.charCodeAt(newTo - 1)) break;
    to--; newTo--;
  }
  const envelope = () => [{ from, to, newFrom: from, newTo }];
  const oldLength = to - from, newLength = newTo - from;
  if (!oldLength || !newLength) return finish(envelope());
  if (Math.abs(oldLength - newLength) > MAX_DISTANCE) return finish(envelope(), true);

  const limit = work + 4 * (oldLength + newLength) + 65_536;
  const frontier = new Int32Array(FRONTIER_SIZE).fill(-1);
  frontier[OFFSET + 1] = 0;
  const trace: Int32Array[] = [];
  for (let distance = 0; distance <= MAX_DISTANCE; distance++) {
    trace.push(frontier.slice()); traceCells += FRONTIER_SIZE;
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      if (work >= limit) return finish(envelope(), true);
      work++;
      const at = OFFSET + diagonal;
      let x = diagonal === -distance || (diagonal !== distance && frontier[at - 1] < frontier[at + 1])
        ? frontier[at + 1] : frontier[at - 1] + 1;
      let y = x - diagonal;
      while (x < oldLength && y < newLength) {
        if (work >= limit) return finish(envelope(), true);
        work++;
        if (previous.charCodeAt(from + x) !== next.charCodeAt(from + y)) break;
        x++; y++;
      }
      frontier[at] = x;
      if (x < oldLength || y < newLength) continue;

      const edits: Span[] = [];
      for (let depth = distance; depth > 0; depth--) {
        const before = trace[depth], k = x - y, slot = OFFSET + k;
        const insertion = k === -depth || (k !== depth && before[slot - 1] < before[slot + 1]);
        const priorX = before[slot + (insertion ? 1 : -1)];
        const priorY = priorX - (k + (insertion ? 1 : -1));
        edits.push({ from: from + priorX, to: from + priorX + (insertion ? 0 : 1),
          newFrom: from + priorY, newTo: from + priorY + (insertion ? 1 : 0) });
        x = priorX; y = priorY;
      }
      return finish(edits.reverse());
    }
  }
  return finish(envelope(), true);
}
