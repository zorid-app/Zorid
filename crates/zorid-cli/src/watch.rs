//! Foreground polling over existing native durability; no process owns a daemon.
use super::{Failure, Result};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use zorid_native::{ExternalFileMode, NativeVault, ScanOptions};
use zorid_native_sync::{FixtureSync, SyncLimits};

static STOP: AtomicBool = AtomicBool::new(false);
extern "C" fn stop(_: libc::c_int) {
    STOP.store(true, Ordering::Relaxed);
}
struct Signals {
    interrupt: libc::sigaction,
    terminate: libc::sigaction,
}
impl Signals {
    fn install() -> Result<Self> {
        STOP.store(false, Ordering::Relaxed);
        unsafe {
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction = stop as *const () as libc::sighandler_t;
            action.sa_flags = libc::SA_RESTART;
            libc::sigemptyset(&mut action.sa_mask);
            let mut interrupt = std::mem::zeroed();
            let mut terminate = std::mem::zeroed();
            if libc::sigaction(libc::SIGINT, &action, &mut interrupt) != 0 {
                return Err(Failure::new(
                    "signal_setup",
                    "Could not install watch shutdown handling",
                    1,
                ));
            }
            if libc::sigaction(libc::SIGTERM, &action, &mut terminate) != 0 {
                libc::sigaction(libc::SIGINT, &interrupt, std::ptr::null_mut());
                return Err(Failure::new(
                    "signal_setup",
                    "Could not install watch shutdown handling",
                    1,
                ));
            }
            Ok(Self {
                interrupt,
                terminate,
            })
        }
    }
}
impl Drop for Signals {
    fn drop(&mut self) {
        unsafe {
            libc::sigaction(libc::SIGINT, &self.interrupt, std::ptr::null_mut());
            libc::sigaction(libc::SIGTERM, &self.terminate, std::ptr::null_mut());
        }
    }
}
fn emit(value: Value) -> Result<()> {
    super::write_json(&mut std::io::stdout().lock(), &value).map_err(|_| {
        Failure::new(
            "output_io",
            "Watch output failed; pending work remains durable",
            1,
        )
    })
}
fn retryable(error: &Failure) -> bool {
    matches!(
        error.code,
        "lock_timeout" | "filesystem_changed" | "sync_transport"
    )
}
fn pause(milliseconds: u64) {
    let deadline = Instant::now() + Duration::from_millis(milliseconds);
    while !STOP.load(Ordering::Relaxed) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        std::thread::sleep(remaining.min(Duration::from_millis(50)));
    }
}
fn cycle(
    root: &Path,
    sync: Option<&FixtureSync>,
    limits: SyncLimits,
    expected: &mut Option<Value>,
    snapshot_due: bool,
) -> Result<Option<Value>> {
    // Reopen each cycle: no stale in-memory core cache or filesystem lock spans
    // the wait, and replacement of a previously selected authority fails closed.
    let mut vault = NativeVault::open_existing(root)?;
    let family = vault.family_status()?;
    let authority =
        json!({"local_store_id":vault.identity()?.local_store_id,"family_scope":family.scope});
    if expected.as_ref().is_some_and(|prior| *prior != authority) {
        return Err(Failure::new(
            "watch_authority_changed",
            "Vault authority or enrollment changed; restart explicitly",
            1,
        ));
    }
    if let Some(sync) = sync {
        sync.check_binding(&vault)?;
    }
    if expected.is_none() {
        *expected = Some(authority);
    }
    if STOP.load(Ordering::Relaxed) {
        return Ok(None);
    }
    super::enable_local_recovery(&mut vault, root, snapshot_due);
    let scan = if family.scope.is_some() {
        // Discover before recovery. Recovering an unobserved external move or
        // deletion can recreate the old physical path and lose its evidence.
        let report = vault.reconcile_external(ScanOptions::default(), ExternalFileMode::Auto)?;
        let issues: Vec<_> = report
            .issues
            .iter()
            .take(32)
            .map(|issue| json!({"path":issue.path,"code":"scan_issue"}))
            .collect();
        let mut recovered = false;
        let mut recovery_blocked = 0;
        if report.complete && !STOP.load(Ordering::Relaxed) {
            recovery_blocked = vault.recover()?.blocked.len();
            recovered = true;
        }
        json!({"complete":report.complete&&recovery_blocked==0,"finished":report.run.finished,
            "scan_complete":report.run.complete,"observed":report.run.observed,
            "imported":report.imported.len(),"namespace_applied":report.namespace.len(),
            "issue_count":report.issues.len(),"issues":issues,"issues_truncated":report.issues.len()>32,
            "recovery_run":recovered,"recovery_blocked":recovery_blocked})
    } else {
        // The legacy scanner owns recovery-before-observation for its own
        // projection gaps; it never treats unobserved paths as deletions.
        let report = vault.rescan_with_options(ScanOptions::default())?;
        let issues: Vec<_> = report
            .issues
            .iter()
            .take(32)
            .map(|issue| json!({"path":issue.path,"code":"scan_issue"}))
            .collect();
        json!({"complete":report.run.complete,"finished":report.run.finished,"scan_complete":report.run.complete,
            "observed":report.run.observed,"imported":report.run.imported,
            "issue_count":report.issues.len(),"issues":issues,"issues_truncated":report.issues.len()>32})
    };
    if STOP.load(Ordering::Relaxed) {
        return Ok(None);
    }
    // Receive and even duplicate handling can recover publications internally.
    // Defer the whole sweep until external inventory is proven safe.
    let sync_deferred = sync.is_some() && scan["complete"] != true;
    let sync_report = if sync_deferred {
        None
    } else {
        sync.map(|sync| sync.once(&mut vault, limits)).transpose()?
    };
    if STOP.load(Ordering::Relaxed) {
        return Ok(None);
    }
    let local = vault.status()?;
    // complete describes this local scan only. A bounded network sweep, a local
    // commit and an independent backup are never called globally "synced".
    Ok(Some(
        json!({"complete":scan["complete"],"scan":scan,"sync":sync_report,
        "sync_deferred":if sync_deferred {Some("scan_incomplete")}else{None},
        "local":{"pending_outbox":local.pending_outbox,"pending_projection":local.pending_projection,
        "projection_attempts":local.attempts.len(),"namespace_attempts":local.namespace_attempts.len()},
        "synced":false}),
    ))
}
pub fn run(
    root: &Path,
    credentials: Option<&Path>,
    interval_ms: u64,
    max_cycles: Option<u64>,
    limits: SyncLimits,
) -> Result<()> {
    let _signals = Signals::install()?;
    let root = std::fs::canonicalize(root)
        .map_err(|_| Failure::new("filesystem_io", "Could not resolve existing watch vault", 1))?;
    // Load through the existing protected credential loader. Never enroll,
    // rotate, auto-rebind, or print credential data or transport diagnostics.
    let sync = credentials
        .map(|path| FixtureSync::load(path, &root))
        .transpose()?;
    let mut expected = None;
    let mut cycles = 0_u64;
    let mut failures = 0_u32;
    let mut last_complete = false;
    let mut next_recovery_snapshot = Instant::now();
    while !STOP.load(Ordering::Relaxed) && max_cycles.is_none_or(|limit| cycles < limit) {
        cycles += 1;
        last_complete = false;
        let snapshot_due = Instant::now() >= next_recovery_snapshot;
        if snapshot_due { next_recovery_snapshot = Instant::now() + Duration::from_secs(5 * 60); }
        match cycle(&root, sync.as_ref(), limits, &mut expected, snapshot_due) {
            Ok(None) => break,
            Ok(Some(mut result)) => {
                failures = 0;
                last_complete = result["complete"] == true;
                result["event"] = json!("watch_cycle");
                result["cycle"] = json!(cycles);
                emit(json!({"version":1,"ok":true,"result":result}))?;
            }
            Err(error) if retryable(&error) => {
                failures = failures.saturating_add(1);
                last_complete = false;
                emit(
                    json!({"version":1,"ok":false,"event":"watch_cycle","cycle":cycles,
                    "retrying":true,"error":{"code":error.code,"message":"Watch will retry durable pending work"}}),
                )?;
            }
            Err(error) => return Err(error),
        }
        if max_cycles.is_some_and(|limit| cycles >= limit) {
            break;
        }
        let delay = if failures == 0 {
            interval_ms
        } else {
            interval_ms
                .saturating_mul(1_u64 << failures.min(8))
                .min(interval_ms.max(30_000))
        };
        pause(delay);
    }
    emit(
        json!({"version":1,"ok":true,"result":{"event":"watch_stopped","cycles":cycles,
        "reason":if STOP.load(Ordering::Relaxed){"signal"}else{"max_cycles"},
        "last_cycle_complete":last_complete,"synced":false}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retry_allowlist_never_retries_fatal_identity_or_storage_errors() {
        for code in [
            "sync_authorization_failed",
            "sync_revoked",
            "sync_binding_mismatch",
            "watch_authority_changed",
            "sync_unsupported_protocol",
            "sync_invalid_protocol",
            "unsupported_schema",
            "corrupt_storage",
            "storage_io",
            "unsafe_path",
        ] {
            assert!(!retryable(&Failure::new(code, "redacted", 1)), "{code}");
        }
        for code in ["sync_transport", "filesystem_changed", "lock_timeout"] {
            assert!(retryable(&Failure::new(code, "redacted", 1)), "{code}");
        }
    }
}
