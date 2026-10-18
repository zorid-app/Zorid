# Optional mobile web-routing bridge integration

Root7f97d7f1 exactly matches all five approved source/test files at finalf42b5dcb
(original80f46047, admission38d511cb, corrected final collision successor).
Independent reviewer stage5_enrollment_inventory approves exact source and reads
9/9 focused cases. Root confirms five-file equality, reads the same retained log
and runs combined full TypeScript: session85678 terminal0. No iOS build was run.

The optional webRouting:1 capability is exclusive with old sameVaultNavigation:1.
The channel uses the already admitted actual Store/client/session, owns no extra
storage claim, requires latest state acknowledgment before applied results,
retains exact lost-result packets and drains before host lease retirement.

At most128 commands are admitted before scheduling. Exact captured-payload retries
coalesce. Changed payload under an admitted ID is dropped without handler or
result task; only the original eventual result can settle that native request.
Overflow is non-admission with the original ID retained for a later exact retry.
The tests include1,024 conflicting duplicates. Progress is frame-coalesced and
resultless; it does not become a stream of storage operations.

This adds the platform bridge only. Consuming Workspace/editor-window activation,
paired Swift host state/receipt handling and actual WebKit/phone behavior remain
separate required gates. The phone still has Dev19, which does not contain this
retained web-owned navigation implementation.

```json
{
  "originalFinalCommit": "f42b5dcb24847d4fca6afabf1a69850e2e8f9d88",
  "rootEquivalent": "7f97d7f1",
  "sourceHashes": {
    "src/platform/index.ts": "15faacdad3592c8b55fec763be591a381d9de139b25235dada2cdd1887c4d2b3",
    "src/platform/mobile-native.ts": "3be5ecbf6c76829169af96dccf8d1d460f95f56eae642c81ca54b237f45b96c9",
    "src/platform/mobile-web-routing-bridge.ts": "9e3dc8457c7652a23659cdd959d1adaf927a6f1db35b04cc43af6aa553ee7ff2",
    "tests/mobile-native.test.ts": "8f0cb18f06a2785fc53b02cd2ac9e9d67636bb1ab3bd8fc16d966cecb52d7b20",
    "tests/mobile-web-routing-bridge.test.ts": "65da656aaa918f3e1870d06818062bd7e9571826bd1a664dfabf6a32072229ec"
  },
  "logs": {
    "/Users/ctk/orca/artifacts/zorid-native-20261018/web-routing-bridge-collision-final.log": "da11698d5fbd2eb8721caf63ea1a760067dde52eb0d58e64a6ee63bbdb7d56dd",
    "/Users/ctk/orca/artifacts/zorid-native-20261018/mobile-routing-bridge-main-tsc.log": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  },
  "focusedTests": {
    "tests": 9,
    "pass": 9,
    "fail": 0
  },
  "rootCombinedTypeScript": {
    "session": 85678,
    "exitCode": 0
  },
  "approval": "stage5_enrollment_inventory exact final source; no tests/build repeated by reviewer"
}
```
