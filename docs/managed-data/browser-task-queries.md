# Pinned Rust task queries in the normal browser client

Owner: root worker `browser_task_queries`, isolated Orca branch
`browser-task-queries` at `/Users/ctk/orca/workspaces/Zorid/browser-task-queries`.
Base: canonical `8e8732ea2473f98db49da2c3f8a5ccd26943fee7`. Root retains sole
main integration ownership. The exact source commit is reported in the worker
handoff. Source review, integration and actual browser acceptance remain separate.

The accepted optional `DocumentPin.tasks` contract now reaches the browser's
normal admitted adapter and worker. Selectors identify actual retained Type YAML;
Rust checks its bytes against the selected generation's immutable record before
compiling Type configuration, task rows and capture summaries. Caller paths,
witnesses, ASTs and detached configuration are not accepted. Note metadata and
Type source witnesses come from the same retained generation. Malformed YAML
returns diagnostic data; missing or excluded source fails closed. No schema,
dependency, authoring, WorkBlock, Calendar, Workspace or mobile changes are made.

Frozen scope approved by root before edits:

- `crates/zorid-wasm/src/document_index.rs`: additive `tasksJson(sources, options)`
  and private bounded source/options/report helpers plus four focused tests.
- `src/core/browser-document-index.ts`: additive required browser `tasks` method,
  bounded capture helper, retained projection reads with pin checks before/after
  asynchronous work and evaluation. Lossless UTF-8 decoding retains a BOM.
- `src/platform/browser-core-runtime.ts`: named task request capture import and
  `document-index-tasks` RPC only.
- `src/platform/browser-client-admission.ts`: named task forwarding in its two
  existing admitted wrappers only.
- `src/platform/browser-core-worker.ts`: one named task operation case only.
- `tests/browser-document-index.test.ts`, `tests/browser-task-runtime.test.ts`,
  `tests/browser-task-queries/*` and this evidence record.

Bounds match existing task contracts: at most128 unique selectors,256 KiB per
Type source,1 MiB aggregate Type source, at most10000 result rows,128-byte timezone,
safe-integer `clockMs`, strict known options. The main-thread task capture bounds
and snapshots input before RPC cloning; the worker independently validates it.
Rust bounds JSON input before decoding and checks source budgets and duplicates
before compilation. It serializes the native-shaped `definitions`, `types` and
`result` under the selected snapshot/source envelope. Actual IANA timezone and
calendar-day interpretation remain Rust-owned.

Observed source-turn verification:

- `node --test --test-concurrency=1 tests/browser-document-index.test.ts tests/browser-task-runtime.test.ts tests/task-document-binding.test.ts`:32/32 passed.
  A subsequent added aggregate-budget test passed with all six Tasks-named host/
  runtime cases. The earlier run contained25 index cases, one runtime case and
  six existing binding cases; the new aggregate case adds one index case.
- `node --test --test-concurrency=1 tests/browser-client-admission.test.ts tests/browser-core-runtime.test.ts`:20/20 passed.
- `node node_modules/typescript/bin/tsc --noEmit`:exit0 using a temporary symlink
  to the canonical checkout's installed dependencies; no package install or lock
  change. The symlink is removed before commit.
- `rustfmt --edition 2021 crates/zorid-wasm/src/document_index.rs`, `git diff --check`
  and Node syntax checks for both browser fixture modules pass.

These Node host/transport tests use explicitly labeled opaque WASM doubles; they
do not establish Rust semantic or actual browser acceptance. Four Rust module
checks are authored but unexecuted. The bounded actual normal-browser fixture and
provenance/cleanup runner are prepared, syntax-checked and unexecuted. The shared
managed-data lead owns the current Rust/Electron validation turn; this worker
launched no Rust compile, WASM build, Chrome or Electron. After independent review,
request a concrete serialized turn using the commands in
`tests/browser-task-queries/README.md`; build generated assets from that exact
reviewed composition before runtime. Integration must retain these remaining
validation gates explicitly.
