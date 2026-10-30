# LaunchServices foreground diagnostic

Root-controlled, separate from the startup benchmark. This launches one unchanged
APFS-cloned packaged app through the installed `/usr/bin/open -n -W -a` interface
with a unique disposable profile/vault/local-data directory. It does not activate,
focus, click, type, edit a note, change throttling or modify a packaged artifact.
It passively checks the same strict native-window/document foreground conditions.
After foreground is observed, it waits within the original diagnostic deadline
for completed actual Native opening and the normal, non-inert workspace containing
the exact fixture tree row. It captures partial lifecycle/DOM state before its
single normal Quit, before closing inspectors, and on setup failure. No synthetic
ready flag or repeated Quit is used. First/latest readiness samples are retained
without retaining an unbounded snapshot on every poll.

Run only in the coordinated GUI lane:

```sh
node scripts/launchservices-focus-diagnostic/run.mjs --app /absolute/Zorid.app --out /private/tmp/zorid-launchservices-focus-UNIQUE
```

For a candidate containing the reviewed opt-in Main startup chronology, add
`--startup-profile`. This explicitly passes `ZORID_PROFILE_STARTUP=1`; inherited
profiling flags remain stripped. The runner snapshots the bounded version1
`__zoridStartupProfile` read-only, including optional spawn-bound Native phase
events. In this mode it also requires the actual `close_handler.ready` mark in the
same Main clock before declaring workspace preparation ready. Legacy apps without
the profile remain supported by the default diagnostic mode. Profile absence or
malformation is unavailable evidence, never fabricated phase timing.

The clock begins before spawning `open`, but this is **not a performance result**.
Actual main PID/executable/ASAR/profile/local-data identity is authenticated from
the current launch's fresh inspector output and unique live process, independently
of the wrapper PID. No input is sent. All files and the clone are retained.

Cleanup reports `open` wrapper exit separately from the actual Electron quit-event
code, real Native child exit codes/signals and final owned-PID absence. The actual
app's **kernel exit status remains unknown** because it is not a Node child. A
successful lifecycle diagnostic is not equivalent to existing benchmark cleanup
acceptance, and cannot authorize its reset oracle or800ms claim. Failure to attach
or authenticate may leave an explicitly reported surviving owned app requiring
the Root's cleanup; this tool never signals a guessed/foreign/reused PID. If normal
Quit fails, only the freshly revalidated actual app PID may receive SIGTERM, which
invalidates the diagnostic. The wrapper is never mistaken for the app.

Focused source-only checks (no apps/OS activation):

```sh
node --test --test-concurrency=1 scripts/launchservices-focus-diagnostic/*.test.mjs
```
