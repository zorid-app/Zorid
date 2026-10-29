# Production editor floor benchmark

This is a rendering/input **lower-bound experiment**, not Zorid startup, vault
admission, import, metadata, recovery, or production-save acceptance. It runs the
unchanged production `createEditor` in live mode with actual packaged local assets
inside a cloned, byte-pinned Electron 44.9.1 runtime. No development server runs.
The Base/embed extension slots are enabled but the controlled plain-Markdown
fixtures contain no embeds, databases, tables or math. Unexpected render requests
fail rather than receiving fake content or authority.

After obtaining the shared-machine build/run slot:

```sh
node scripts/startup-editor-floor/run.mjs
```

Default matrix: 8 KiB ordinary, 0.5 MiB and 5 MiB, each with normal-reopen and
first-folder-selection clocks. Each case gets a fresh process and owned profile.
The command builds a release bundle, packages `app.asar`, clones the frozen
runtime, generates owned fixtures, runs the matrix, and retains its report under
`/private/tmp/zorid-editor-floor-*`. A failed deadline is a recorded failure, not a
reason to retry input. Filesystem caches are uncontrolled.

Run 50 MiB **separately**, after the prior run has exited and the machine's memory
has been inspected:

```sh
node scripts/startup-editor-floor/run.mjs --sizes 50 --allow-50mb --timeout-ms 20000
```

The command refuses that run below a 1.5 GiB free/inactive/speculative memory
estimate and records `vm_stat`. This estimate is not a guarantee against memory
pressure. No other heavy compile or app pass should overlap it.

The default read-only dependency source is
`.worktrees/bases-edit-performance/node_modules`. `--deps` can select another
explicit frozen directory. The worktree's dependency symlink must resolve to that
same frozen installation. No dependency installation or production file edit is
performed. `--build-only` stages the package without launching it.

## What is measured

- Normal reopen starts immediately before process spawn. The first-selection
  clock starts when the main process acknowledges the harness's preconfigured
  owned fixture selection, after the initial selection shell paints. It does not
  measure a human or operating-system picker. Spawn timing remains in both modes.
- Production editor construction, correct document length/prefix, visible first
  viewport, current fixture interaction guard, and actual `beforeinput.isTrusted`
  are recorded. The renderer/main epoch handshake checks their time conversion.
- One trusted character is sent immediately after the first visible ready frame.
  A second distinct probe is scheduled once for 800 ms. Neither is retried.
  Dispatch lateness and application timestamps are retained independently. The
  <=800 ms result is the earliest trusted applied character, not editor DOM alone.
- Caret state is checked both immediately and after paint. Full-body hashes run
  after the deadline, verifying later content was not truncated. The outer runner
  independently checks the expected edited hash and unchanged input fixture.
- Each edit appends a small record to an independent owned fixture journal,
  receives a file-fsync acknowledgment and readback, and is independently checked
  again after exit. This **does not prove production save authority or power-loss
  durability** and never writes a real vault.

The app captures its viewport and records startup events, runtime/source/asset
pins, journal receipts and memory metrics. Successful evidence requires ordinary
app quit, exit code zero, no signal, and absence of all processes from the unique
owned app path. A bounded TERM/KILL cleanup is recorded as forced and cannot pass.
Failures, screenshots and logs remain available for review.

Pure oracle checks do not launch Electron:

```sh
node --test scripts/startup-editor-floor/oracle.test.mjs
```

No result from this floor may be relabeled as an 800 ms production startup or an
Obsidian measurement. The full app still needs separate authority, recovery,
indexing, import, real-file persistence and native lifecycle acceptance.
