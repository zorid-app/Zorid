# Actual browser/WASM Bases semantic integration

This is a **source-only prepared campaign** until the coordinator grants a frozen
build/browser slot and the resulting report passes. No browser or Rust build was
launched while authoring this harness.

The fixture uses the normal `BrowserCoreRuntime`, admitted client,
`defaultBrowserAdapter.documentSemantics`, unchanged product Worker, generated
Rust/WASM and actual IndexedDB. Notes, folders, attachments and edits go through
public admitted adapter commands. It neither calls a detached evaluator nor
constructs an index generation, modifies an IDB store, substitutes a Worker,
injects a registry, or supplies expected results to product code.

The nine independently authored groups cover:

1. Ordinary notes **without Properties.yaml**: source-relative wikilinks,
   recursive list/object links, cross-file `.asFile`, URLs, dates, missing values
   and file/link summaries retaining original target identities.
2. Exact raw edit-value transport and TypeScript projection, CRLF/Unicode body,
   wiki alias/quote/comment retention, durable compare-and-write and stale CAS
   refusal. This uses the product property transformation and admitted save;
   it does not claim mounted NoteBuffer/widget or undo interaction acceptance.
3. Overall and group summaries over final sorted/limited rows, rather than all
   matches or mounted DOM rows.
4. Overall versus selected-group summary previews and stale group rejection.
5. HTML/image/icon/recursive link-label values; fixed-seed repeatability and seed
   changes; explicit-timezone Moment formatting; missing files and explicit
   unsupported-regex/unknown-function/cycle diagnostics. HTML remains inert data;
   this fixture does not mount or claim a renderer sanitization test.
6. Saved fenced configuration with UTF-8 byte spans around Unicode/CRLF and `this`
   context, rejecting forged source, invalid spans and wrong contextual identity.
7. Optional property settings: filtered relation target choices, reverse
   relations, counts, averages and formulas/filtering over derived values.
   Current-note relation frames must carry the exact actor revision, raw alias
   baseline and typed resolved target, while no-current requests omit the field.
8. Exact saved settings source/witness proof for Base reads and ordinary-note
   property target reads, plus invalid option rejection.
9. Retained old pins after edits/settings creation, foreign-client denial,
   explicit close, real Worker/IDB restart and exact durable source readback.
   An independent target eligibility change removes it from picker candidates
   while retaining the existing saved link display. A subsequent current-note
   edit to an unresolved alias remains raw and unresolved; the old pin keeps its
   original actor/target witnesses and candidate list. These disposable sources
   are restored exactly through fresh admitted CAS before restart assertions.

Expected values are hand-authored (`7 + 3 + 5 = 15`; global limit keeps `7, 5`;
Ada has two books with average five). Seed checks assert the public bounded,
repeatable contract rather than deriving an oracle from the PRNG implementation.
Snapshot and file witnesses come from the actual admitted host; they are checked
against returned values, never forged by a source factory. Warm cache work counts
may differ and are not semantic expectations.

The runner reuses the existing owned Chrome PID/profile/Vite cleanup helper. It
uses the same two CommonJS aliases as normal Vite startup, without rewriting
product source. It serves the existing generated glue and WASM bytes unchanged
and verifies both SHA-256 digests and the complete Rust input fingerprint before
and after execution. All TypeScript/product fixture sources, the two local CJS
boundaries and dependency/config files are fingerprinted as well. CDP passively
records the product Worker target, exact WASM asset GETs, browser identity,
console/protocol events, fixture screenshot and cleanup receipts. The screenshot
shows this semantic proof page, not product UI parity.

A stale artifact or changed source rejects evidence. The runner never compiles,
installs dependencies, repairs generated metadata or manufactures a passing
report. It records partial groups, unexecuted groups and failures honestly.

After the coordinator integrates the harness and grants matching build/runtime:

```sh
# The coordinator owns the serialized build and exact toolchain paths.
# Do not run a second build or browser against another owner's active slot.
node tests/bases-browser-integration/run.mjs \
  --expect-head FULL_40_HEX_FROZEN_COMMIT \
  --runtime-authorized \
  --wasm-dir /absolute/path/to/existing/generated/assets \
  --out /private/tmp/zorid-bases-browser-RUN_ID
```

`--wasm-dir` defaults to `target/browser-wasm/generated` and may point at the
coordinator's matching generated output. It must contain `build.json`,
`zorid_wasm.js` and `zorid_wasm_bg.wasm`. The root source fingerprint must match.
The assigned build uses the existing toolchain, including
`/Users/ctk/Projects/Zorid/tmp/stage4-tools/wasm-bindgen` and the shared Rust
sysroot; only the coordinator should launch that build.

The final `report.json` must have all nine groups passed, no unexecuted group,
observed product Worker and WASM GETs, no cleanup failures and no runner error.
Full rendered Electron heavy-user acceptance, normal web UI/CLI, native/mobile,
sync and large-vault performance are separate evidence.
