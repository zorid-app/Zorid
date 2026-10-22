// Rust omits an empty summaries map. Default only that declared empty case;
// null, wrong shapes and missing populated summaries must still fail equality.
export function optionalSummaryMap(actual, expected) {
  return actual === undefined && expected !== null && typeof expected === 'object'
    && !Array.isArray(expected) && Object.keys(expected).length === 0 ? {} : actual;
}
