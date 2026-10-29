//! Cooperative interactive reconciliation. Durable inventory and attempts remain
//! authoritative; these ephemeral cursors only choose the next bounded unit.
use super::*;
use std::{collections::BTreeSet, time::Instant};

pub(super) struct ExternalWorkBudget {
    started: Instant,
    duration: std::time::Duration,
    limit: u16,
    units: BTreeSet<String>,
    positive_completed: bool,
    yielded: bool,
}
impl ExternalWorkBudget {
    pub(super) fn new(options: &ExternalReconcileOptions) -> Result<Self> {
        if options.scan.max_duration.is_zero() || options.max_work_units.get() > 256 {
            return Err(Error::Unsupported(
                "interactive reconciliation budget is invalid",
            ));
        }
        Ok(Self {
            started: Instant::now(),
            duration: options.scan.max_duration,
            limit: options.max_work_units.get(),
            units: BTreeSet::new(),
            positive_completed: false,
            yielded: false,
        })
    }
    pub(super) fn started(&self) -> Instant {
        self.started
    }
    pub(super) fn used(&self) -> u16 {
        self.units.len() as u16
    }
    pub(super) fn expired(&self) -> bool {
        self.started.elapsed() >= self.duration
    }
    pub(super) fn yielded(&self) -> bool {
        self.yielded
    }
    pub(super) fn available(&self) -> bool {
        self.used() < self.limit && (self.units.is_empty() || !self.expired())
    }
    /// Each caller supplies an exact phase/job/member identity. The first unit
    /// may proceed after costly validation; later units share this same clock.
    pub(super) fn try_unit(&mut self, key: String) -> bool {
        if !self.available() {
            self.yielded = true;
            return false;
        }
        if !self.units.insert(key) {
            self.yielded = true;
            return false;
        }
        true
    }
    pub(super) fn capture_positive(&mut self, path: &VaultPath) -> bool {
        self.try_unit(format!("positive:{}", path.as_str()))
    }
    /// Capture and enrollment of the same path are one positive unit. Finish
    /// at most its first admitted positive even if capture used the deadline.
    pub(super) fn enroll_positive(&mut self, path: &VaultPath) -> bool {
        let key = format!("positive:{}", path.as_str());
        let captured = self.units.contains(&key);
        let allowed = if captured {
            !self.positive_completed || !self.expired()
        } else {
            self.try_unit(key)
        };
        if allowed {
            self.positive_completed = true;
        } else {
            self.yielded = true;
        }
        allowed
    }
}

#[derive(Default)]
pub(super) struct PublicationCursor {
    scan_id: Option<OperationId>,
    source_head: String,
    data_version: i64,
    namespace: super::namespace::NamespaceRecoveryCursor,
    phase: u8,
    offset: usize,
    directory_attempts: Vec<zorid_store::DirectoryAttempt>,
    folders: Vec<zorid_core::EntryState>,
    attempt_ids: Vec<OperationId>,
    pending_ids: Vec<OperationId>,
    files: Vec<zorid_core::EntryState>,
    report: ReconcileReport,
}
impl NativeVault {
    fn publication_stamp(&self) -> Result<(String, i64)> {
        Ok((
            self.store.changes_after("0", 1)?.head_cursor,
            self.store.external_work_data_version()?,
        ))
    }
    /// The inventory has already interpreted all negative evidence before this
    /// point. Each publication operation rechecks its durable intent and source
    /// state. This cursor is scheduling state, never publication authority.
    pub(super) fn recover_external_quantum_locked(
        &mut self,
        scan_id: &OperationId,
        budget: &mut ExternalWorkBudget,
    ) -> Result<(bool, ReconcileReport)> {
        let stamp = self.publication_stamp()?;
        let mut cursor = self.external_publication.take().unwrap_or_default();
        if cursor.scan_id.as_ref() != Some(scan_id)
            || cursor.source_head != stamp.0
            || cursor.data_version != stamp.1
        {
            cursor = PublicationCursor {
                scan_id: Some(scan_id.clone()),
                ..Default::default()
            };
        }
        let result = self.recover_external_cursor(&mut cursor, budget);
        // Own commits legitimately advance the source. Capturing after the work
        // prevents the next quantum discarding all progress on its own writes.
        let stamp = self.publication_stamp()?;
        cursor.source_head = stamp.0;
        cursor.data_version = stamp.1;
        match result {
            Ok(true) => Ok((true, cursor.report)),
            Ok(false) => {
                let blocked = std::mem::take(&mut cursor.report.blocked);
                // Keep blockers in the cursor, but return a report snapshot.
                cursor.report.blocked = blocked.clone();
                let report = ReconcileReport {
                    imported: Vec::new(),
                    projected: Vec::new(),
                    blocked,
                };
                self.external_publication = Some(cursor);
                Ok((false, report))
            }
            Err(error) => {
                self.external_publication = Some(cursor);
                Err(error)
            }
        }
    }
    fn recover_external_cursor(
        &mut self,
        cursor: &mut PublicationCursor,
        budget: &mut ExternalWorkBudget,
    ) -> Result<bool> {
        loop {
            match cursor.phase {
                0 => {
                    if !self.recover_namespaces_quantum(
                        &mut cursor.namespace,
                        budget,
                        &mut cursor.report,
                    )? {
                        return Ok(false);
                    }
                    cursor.directory_attempts = self.store.directory_attempts(false)?;
                    cursor.phase = 1;
                    cursor.offset = 0;
                }
                1 => {
                    while cursor.offset < cursor.directory_attempts.len() {
                        let a = &cursor.directory_attempts[cursor.offset];
                        if !budget.try_unit(format!("directory-attempt:{}", a.attempt_id.as_str()))
                        {
                            return Ok(false);
                        }
                        // Re-read the exact current attempt; the snapshot only
                        // selects work and never authorizes filesystem writes.
                        if let Some(current) = self
                            .store
                            .directory_attempts(false)?
                            .into_iter()
                            .find(|current| current.attempt_id == a.attempt_id)
                        {
                            match self.resume_directory(&current) {
                                Ok(()) => cursor.report.projected.push(current.target.id),
                                Err(e) => cursor
                                    .report
                                    .blocked
                                    .push((current.target.path, e.to_string())),
                            }
                        }
                        cursor.offset += 1;
                    }
                    cursor.folders = self
                        .store
                        .list()?
                        .into_iter()
                        .filter(|s| s.kind == EntryKind::Folder)
                        .collect();
                    cursor.phase = 2;
                    cursor.offset = 0;
                }
                2 => {
                    while cursor.offset < cursor.folders.len() {
                        let state = &cursor.folders[cursor.offset];
                        if !budget.try_unit(format!("folder:{}", state.id.as_str())) {
                            return Ok(false);
                        }
                        if !cursor.report.blocked.iter().any(|(p, _)| p == &state.path)
                            && !cursor.report.projected.contains(&state.id)
                            && (self.store.directory_baseline(&state.id)?.is_some()
                                || self.store.pending_directory_create(&state.id)?)
                        {
                            match self.project_directory(&state.id) {
                                Ok(()) => cursor.report.projected.push(state.id.clone()),
                                Err(e) => cursor
                                    .report
                                    .blocked
                                    .push((state.path.clone(), e.to_string())),
                            }
                        }
                        cursor.offset += 1;
                    }
                    cursor.attempt_ids = self.store.projection_attempt_ids(true)?;
                    cursor.phase = 3;
                    cursor.offset = 0;
                }
                3 => {
                    while cursor.offset < cursor.attempt_ids.len() {
                        let id = &cursor.attempt_ids[cursor.offset];
                        if !budget.try_unit(format!("settled-file:{}", id.as_str())) {
                            return Ok(false);
                        }
                        let attempt = self.store.projection_attempt(id)?;
                        if attempt.completed() {
                            if let Err(e) = self.retire_settled_previous(id) {
                                cursor
                                    .report
                                    .blocked
                                    .push((attempt.target.state.path, e.to_string()));
                            }
                        }
                        cursor.offset += 1;
                    }
                    cursor.pending_ids = self.store.projection_attempt_ids(false)?;
                    cursor.phase = 4;
                    cursor.offset = 0;
                }
                4 => {
                    while cursor.offset < cursor.pending_ids.len() {
                        let id = &cursor.pending_ids[cursor.offset];
                        if !budget.try_unit(format!("pending-file:{}", id.as_str())) {
                            return Ok(false);
                        }
                        let attempt = self.store.projection_attempt(id)?;
                        if !attempt.completed() {
                            match self
                                .resume(&attempt)
                                .and_then(|_| self.project(&attempt.target.state.id))
                            {
                                Ok(()) => cursor.report.projected.push(attempt.target.state.id),
                                Err(e) => cursor
                                    .report
                                    .blocked
                                    .push((attempt.target.state.path, e.to_string())),
                            }
                        }
                        cursor.offset += 1;
                    }
                    cursor.files = self
                        .store
                        .list()?
                        .into_iter()
                        .filter(|s| s.kind == EntryKind::File)
                        .collect();
                    cursor.phase = 5;
                    cursor.offset = 0;
                }
                5 => {
                    while cursor.offset < cursor.files.len() {
                        if !budget.try_unit(format!("files:{}", cursor.offset)) {
                            return Ok(false);
                        }
                        let state = &cursor.files[cursor.offset];
                        if cursor.report.blocked.iter().any(|(p, _)| p == &state.path)
                            || cursor.report.projected.contains(&state.id)
                        {
                            cursor.offset += 1;
                            continue;
                        }
                        // One content baseline is one interactive unit. A
                        // 64-entry legacy page can decode 64 large inline
                        // bodies before yielding despite the shared deadline.
                        let end = (cursor.offset + 1).min(cursor.files.len());
                        let eligible_end = (cursor.offset..end)
                            .find(|&i| {
                                cursor
                                    .report
                                    .blocked
                                    .iter()
                                    .any(|(p, _)| p == &cursor.files[i].path)
                                    || cursor.report.projected.contains(&cursor.files[i].id)
                            })
                            .unwrap_or(end);
                        cursor.offset += self
                            .store
                            .projection_clean_prefix(&cursor.files[cursor.offset..eligible_end])?;
                        if cursor.offset < eligible_end {
                            let state = &cursor.files[cursor.offset];
                            match self.project(&state.id) {
                                Ok(()) => cursor.report.projected.push(state.id.clone()),
                                Err(e) => cursor
                                    .report
                                    .blocked
                                    .push((state.path.clone(), e.to_string())),
                            }
                            cursor.offset += 1;
                        }
                    }
                    cursor.phase = 6;
                }
                _ => {
                    // Check current obligations again before terminal status.
                    // Blocked jobs already attempted remain blockers, not a spin.
                    let namespace_done = self.recover_namespaces_quantum(
                        &mut cursor.namespace,
                        budget,
                        &mut cursor.report,
                    )?;
                    if !namespace_done {
                        return Ok(false);
                    }
                    if !budget.try_unit("publication:finalize".into()) {
                        return Ok(false);
                    }
                    let pending = self.store.projection_attempt_ids(false)?;
                    let directories = self.store.directory_attempts(false)?;
                    let list = self.store.list()?;
                    if pending.iter().any(|id| !cursor.pending_ids.contains(id))
                        || directories.iter().any(|a| {
                            !cursor
                                .directory_attempts
                                .iter()
                                .any(|old| old.attempt_id == a.attempt_id)
                        })
                        || list.iter().any(|state| {
                            !cursor
                                .files
                                .iter()
                                .chain(cursor.folders.iter())
                                .any(|old| old == state)
                        })
                    {
                        cursor.phase = 1;
                        cursor.offset = 0;
                        cursor.directory_attempts = directories;
                        continue;
                    }
                    self.paths.verify()?;
                    return Ok(true);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn path(value: &str) -> VaultPath {
        VaultPath::new(value).unwrap()
    }
    fn enrolled(root: &std::path::Path) -> NativeVault {
        let mut vault = NativeVault::open(root).unwrap();
        vault
            .family_enroll(&FamilyScope {
                realm_id: zorid_sync_protocol::RealmId::new("quantum-realm").unwrap(),
                vault_id: zorid_sync_protocol::VaultId::new("quantum-vault").unwrap(),
            })
            .unwrap();
        vault
    }
    fn tiny() -> ExternalReconcileOptions {
        ExternalReconcileOptions {
            scan: ScanOptions {
                max_duration: std::time::Duration::from_nanos(1),
                ..Default::default()
            },
            max_work_units: std::num::NonZeroU16::new(1).unwrap(),
        }
    }
    fn finish(vault: &mut NativeVault, options: ExternalReconcileOptions) -> usize {
        let mut turns = 0;
        loop {
            let turn = vault
                .reconcile_external_quantum(options.clone(), ExternalFileMode::Auto)
                .unwrap();
            turns += 1;
            assert!(turn.work_units <= options.max_work_units.get());
            if !turn.pending {
                assert_eq!(turn.phase, ExternalWorkPhase::Complete, "{:?}", turn);
                assert!(turn.reconciliation.complete);
                return turns;
            }
            assert!(turns < 1000, "cooperative import starved: {:?}", turn);
        }
    }
    thread_local! {
        static EDIT_REBASELINE: std::cell::RefCell<Option<std::path::PathBuf>> = const { std::cell::RefCell::new(None) };
    }
    fn edit_same_size_and_restore_mtime(point: &str) {
        if point != "external_quantum_rebaseline_before_verify" {
            return;
        }
        EDIT_REBASELINE.with(|root| {
            let Some(root) = root.borrow_mut().take() else {
                return;
            };
            let file = root.join("Note.md");
            let modified = std::fs::metadata(&file).unwrap().modified().unwrap();
            std::fs::write(&file, b"other note\n").unwrap();
            std::fs::OpenOptions::new()
                .write(true)
                .open(&file)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(modified))
                .unwrap();
        });
    }
    fn foreign_checkpoint_before_rebaseline_apply(point: &str) {
        if point != "external_quantum_rebaseline_before_apply" { return; }
        EDIT_REBASELINE.with(|root| {
            let Some(root) = root.borrow_mut().take() else { return; };
            let mut foreign = zorid_store::Store::open_existing_no_follow(root.canonicalize().unwrap().join(".zorid/vault.sqlite")).unwrap();
            let scope = CheckpointScope { vault_id: foreign.identity().unwrap().local_store_id, client_id: OperationId::new("99111b43-22b1-4d09-87c9-391b56032491").unwrap() };
            foreign.checkpoint_compare_and_swap(&scope, CheckpointWrite { key: "foreign-before-apply", expected_revision: None, next_revision: "337b15f1-026f-4a03-ae38-75b2970a274c", encoded_state: Some("{\"retained\":true}") }).unwrap();
        });
    }
    fn old_device(root: &std::path::Path) {
        let database = rusqlite::Connection::open(root.join(".zorid/vault.sqlite")).unwrap();
        let rows: Vec<String> = database
            .prepare("SELECT record FROM physical_bindings")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        for raw in rows {
            let mut row: serde_json::Value = serde_json::from_str(&raw).unwrap();
            row["physical"]["inode"] = serde_json::Value::String(format!(
                "old-device:{}",
                row["physical"]["inode"].as_str().unwrap()
            ));
            row["physical"]["parent_inode"] = serde_json::Value::String(format!(
                "old-device:{}",
                row["physical"]["parent_inode"].as_str().unwrap()
            ));
            database.execute("UPDATE physical_bindings SET inode=?1,parent_inode=?2,record=?3 WHERE entry_id=?4", rusqlite::params![row["physical"]["inode"].as_str(), row["physical"]["parent_inode"].as_str(), row.to_string(), row["state"]["id"].as_str()]).unwrap();
        }
    }
    #[test]
    fn prepared_rebaseline_rejects_same_size_in_place_edit_even_if_mtime_is_restored() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("Note.md"), b"saved note\n").unwrap();
        let mut vault = enrolled(root.path());
        assert!(
            vault
                .reconcile_external(ScanOptions::default(), ExternalFileMode::Auto)
                .unwrap()
                .complete
        );
        old_device(root.path());
        let original = vault.store.physical_binding_metadata().unwrap();
        EDIT_REBASELINE.with(|slot| *slot.borrow_mut() = Some(root.path().to_path_buf()));
        vault.fault = Some(edit_same_size_and_restore_mtime);
        for _ in 0..100 {
            match vault.reconcile_external_quantum(tiny(), ExternalFileMode::Auto) {
                Err(Error::Busy(_)) => {
                    assert_eq!(vault.store.physical_binding_metadata().unwrap(), original);
                    assert_eq!(
                        std::fs::read(root.path().join("Note.md")).unwrap(),
                        b"other note\n"
                    );
                    return;
                }
                Err(error) => panic!("unexpected failure: {error:?}"),
                Ok(turn) => assert!(turn.pending, "the changed proof cannot complete: {turn:?}"),
            }
        }
        panic!("did not reach guarded rebaseline finalization");
    }
    #[test]
    fn final_foreign_epoch_race_restarts_pending_instead_of_misreporting_blocked() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("Note.md"), b"saved note\n").unwrap();
        let mut vault = enrolled(root.path());
        assert!(vault.reconcile_external(ScanOptions::default(), ExternalFileMode::Auto).unwrap().complete);
        old_device(root.path());
        let original = vault.store.physical_binding_metadata().unwrap();
        EDIT_REBASELINE.with(|slot| *slot.borrow_mut() = Some(root.path().to_path_buf()));
        vault.fault = Some(foreign_checkpoint_before_rebaseline_apply);
        let mut saw_race = false;
        for _ in 0..100 {
            let turn = vault.reconcile_external_quantum(tiny(), ExternalFileMode::Auto).unwrap();
            let race_done = EDIT_REBASELINE.with(|slot| slot.borrow().is_none());
            if race_done {
                assert!(turn.pending, "epoch invalidation must keep its restart resumable: {turn:?}");
                assert_eq!(turn.phase, ExternalWorkPhase::Discovery);
                assert_eq!(vault.store.physical_binding_metadata().unwrap(), original);
                saw_race = true;
                break;
            }
        }
        assert!(saw_race);
        finish(&mut vault, tiny());
        assert_eq!(std::fs::read(root.path().join("Note.md")).unwrap(), b"saved note\n");
    }
    #[test]
    fn interactive_one_unit_progress_survives_preparation_exceeding_soft_deadline() {
        let root = tempfile::tempdir().unwrap();
        for i in 0..12 {
            std::fs::write(
                root.path().join(format!("{i:02}.md")),
                format!("UTF-8 note {i} 🌳\n"),
            )
            .unwrap();
        }
        let mut vault = enrolled(root.path());
        let first = vault
            .reconcile_external_quantum(tiny(), ExternalFileMode::Auto)
            .unwrap();
        assert_eq!(first.work_units, 1);
        assert_eq!(
            first.reconciliation.imported.len(),
            1,
            "the first valid positive is one capture+enrollment unit"
        );
        assert!(first.pending);
        assert!(finish(&mut vault, tiny()) > 1);
        assert_eq!(vault.list().unwrap().len(), 12);
        drop(vault);
        let mut reopened = NativeVault::open_existing(root.path()).unwrap();
        finish(&mut reopened, tiny());
        assert_eq!(reopened.list().unwrap().len(), 12);
    }
    #[test]
    fn invalid_names_consume_units_and_eventually_stop_blocked_without_spinning() {
        let root = tempfile::tempdir().unwrap();
        for i in 0..9 {
            std::fs::write(root.path().join(format!("bad\\{i}")), b"retained").unwrap();
        }
        let mut vault = enrolled(root.path());
        let first = vault
            .reconcile_external_quantum(tiny(), ExternalFileMode::Auto)
            .unwrap();
        assert_eq!(first.work_units, 1);
        assert!(first.pending);
        for turn in 0..20 {
            let next = vault
                .reconcile_external_quantum(tiny(), ExternalFileMode::Auto)
                .unwrap();
            assert!(next.work_units <= 1);
            if !next.pending {
                assert_eq!(next.phase, ExternalWorkPhase::Blocked);
                return;
            }
            assert!(turn < 19, "invalid names never terminated");
        }
    }
    #[test]
    fn failing_folder_enrollment_reaches_blocked_with_one_unit_budget() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("Occupied"), b"original").unwrap();
        let mut vault = enrolled(root.path());
        assert!(
            vault
                .reconcile_external(ScanOptions::default(), ExternalFileMode::Auto)
                .unwrap()
                .complete
        );
        let before = vault
            .store
            .read_path_metadata(&path("Occupied"))
            .unwrap()
            .unwrap()
            .state;
        std::fs::remove_file(root.path().join("Occupied")).unwrap();
        std::fs::create_dir(root.path().join("Occupied")).unwrap();
        for i in 0..30 {
            let turn = vault
                .reconcile_external_quantum(tiny(), ExternalFileMode::Auto)
                .unwrap();
            assert!(turn.work_units <= 1);
            if !turn.pending {
                assert_eq!(turn.phase, ExternalWorkPhase::Blocked);
                assert_eq!(
                    vault
                        .store
                        .read_path_metadata(&path("Occupied"))
                        .unwrap()
                        .unwrap()
                        .state,
                    before
                );
                assert!(root.path().join("Occupied").is_dir());
                return;
            }
            assert!(
                i < 29,
                "failed folder was retried forever instead of retained"
            );
        }
    }
    #[test]
    fn multipart_inventory_retries_moved_inode_and_child_with_complete_authority() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("Before")).unwrap();
        std::fs::write(root.path().join("Before/tracked.md"), b"tracked").unwrap();
        let mut vault = enrolled(root.path());
        assert!(
            vault
                .reconcile_external(ScanOptions::default(), ExternalFileMode::Auto)
                .unwrap()
                .complete
        );
        assert!(vault.recover().unwrap().blocked.is_empty());
        let folder = vault
            .store
            .read_path_metadata(&path("Before"))
            .unwrap()
            .unwrap()
            .state
            .id;
        let file = vault
            .store
            .read_path_metadata(&path("Before/tracked.md"))
            .unwrap()
            .unwrap()
            .state
            .id;
        std::fs::rename(root.path().join("Before"), root.path().join("After")).unwrap();
        std::fs::write(root.path().join("After/new.md"), b"new child").unwrap();
        for i in 0..8 {
            std::fs::write(root.path().join(format!("Extra{i}.md")), b"filler").unwrap();
        }
        finish(&mut vault, tiny());
        assert_eq!(
            vault
                .store
                .read_path_metadata(&path("After"))
                .unwrap()
                .unwrap()
                .state
                .id,
            folder
        );
        assert_eq!(
            vault
                .store
                .read_path_metadata(&path("After/tracked.md"))
                .unwrap()
                .unwrap()
                .state
                .id,
            file
        );
        assert!(vault
            .store
            .read_path_metadata(&path("After/new.md"))
            .unwrap()
            .is_some());
        assert!(!root.path().join("Before").exists());
    }
}
