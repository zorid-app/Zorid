//! App-local history is optional for embedders and never participates in sync.
use super::*;
use zorid_recovery::{
    PeriodicCaptureEligibility, RecoveryScope, RecoveryStore, SnapshotInput, SnapshotProvenance,
};

pub(super) enum MaintenanceCursor {
    Scanning(Option<i64>),
    Pruning,
}

pub(super) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

impl NativeVault {
    /// Bounded device-local history metadata, independent of current liveness or
    /// path so renames and deleted notes keep their historical entry identity.
    pub fn list_local_recovery(
        &self,
        entry: &EntryId,
        before: Option<LocalRecoveryCursor>,
        limit: usize,
    ) -> Result<Vec<LocalRecoveryVersion>> {
        self.paths.verify()?;
        let recovery = self
            .recovery
            .as_ref()
            .ok_or(Error::Unsupported("local recovery is unavailable"))?;
        let versions = recovery.list(entry.as_str(), before, limit)?;
        if versions
            .iter()
            .any(|version| version.entry_id != entry.as_str())
        {
            return Err(zorid_recovery::RecoveryError::CorruptRecord.into());
        }
        Ok(versions)
    }

    /// A snapshot number is not entry authority. A caller must provide its
    /// captured entry identity, and a foreign snapshot never returns its body.
    pub fn read_local_recovery(
        &self,
        entry: &EntryId,
        snapshot_id: i64,
    ) -> Result<Option<LocalRecoverySnapshot>> {
        self.paths.verify()?;
        let recovery = self
            .recovery
            .as_ref()
            .ok_or(Error::Unsupported("local recovery is unavailable"))?;
        Ok(recovery
            .read(snapshot_id)?
            .filter(|snapshot| snapshot.info.entry_id == entry.as_str()))
    }

    /// The host supplies an app-owned path outside the vault. Tests and native
    /// shells can inject their private data directory without global environment.
    pub fn enable_local_recovery(&mut self, path: impl AsRef<Path>, now_ms: i64) -> Result<()> {
        self.enable_local_recovery_mode(path.as_ref(), now_ms, false)
    }

    /// Desktop owners opt in before saves, then schedule periodic work explicitly.
    /// Admission validates the same private path/scope without an expiry sweep.
    pub fn enable_local_recovery_deferred(
        &mut self,
        path: impl AsRef<Path>,
        now_ms: i64,
    ) -> Result<()> {
        self.enable_local_recovery_mode(path.as_ref(), now_ms, true)
    }

    fn enable_local_recovery_mode(
        &mut self,
        path: &Path,
        now_ms: i64,
        deferred: bool,
    ) -> Result<()> {
        self.paths.verify()?;
        let parent = path
            .parent()
            .ok_or_else(|| Error::UnsafePath("recovery parent missing".into()))?
            .canonicalize()?;
        if parent.starts_with(&self.paths.absolute) {
            return Err(Error::UnsafePath(
                "local recovery must be outside the vault".into(),
            ));
        }
        let local_id = self.identity()?.local_store_id;
        let scope = RecoveryScope {
            vault_id: local_id.as_str().to_owned(),
            replica_id: "native-local".into(),
        };
        let name = path
            .file_name()
            .ok_or_else(|| Error::UnsafePath("recovery filename missing".into()))?;
        self.recovery = Some(if deferred {
            RecoveryStore::open_deferred(parent.join(name), &scope, now_ms)?
        } else {
            RecoveryStore::open(parent.join(name), &scope, now_ms)?
        });
        self.recovery_queue = None;
        Ok(())
    }

    /// Called at startup and bounded host maintenance intervals. Capture is
    /// cadence-limited per note; attachments never enter retained note history.
    pub fn snapshot_local_recovery(&mut self, now_ms: i64) -> Result<()> {
        if self.recovery.is_none() {
            return Ok(());
        }
        self.paths.verify()?;
        let entries = self.store.list()?;
        let mut first_error = None;
        for entry in entries {
            if let Err(error) =
                self.capture_local_recovery(&entry.id, now_ms, SnapshotProvenance::Periodic)
            {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
        if let Some(error) = first_error {
            return Err(error);
        }
        if let Some(recovery) = &mut self.recovery {
            recovery.prune(now_ms)?;
        }
        Ok(())
    }

    /// Explicit secondary maintenance. Each unit visits one physical metadata
    /// row or prunes one expired snapshot; no complete inventory is materialized.
    /// The host controls scheduling and normally requests a single unit.
    pub fn maintain_local_recovery(
        &mut self,
        now_ms: i64,
        limit: u16,
    ) -> Result<RecoveryMaintenance> {
        if limit == 0 || limit > 64 {
            return Err(Error::Unsupported("recovery maintenance batch limit"));
        }
        if self.recovery.is_none() {
            return Ok(RecoveryMaintenance::default());
        }
        self.paths.verify()?;
        let mut failed_notes = 0;
        for _ in 0..limit {
            let cursor = self
                .recovery_queue
                .take()
                .unwrap_or(MaintenanceCursor::Scanning(None));
            match cursor {
                MaintenanceCursor::Scanning(after) => {
                    // Preserve the scheduling obligation even if metadata admission fails.
                    self.recovery_queue = Some(MaintenanceCursor::Scanning(after));
                    let (next, candidate, finished) = self.store.recovery_candidate_page(after)?;
                    self.recovery_queue = Some(if finished {
                        MaintenanceCursor::Pruning
                    } else {
                        MaintenanceCursor::Scanning(next)
                    });
                    if let Some(metadata) = candidate {
                        if self
                            .capture_local_recovery_metadata(
                                metadata,
                                now_ms,
                                SnapshotProvenance::Periodic,
                            )
                            .is_err()
                        {
                            failed_notes += 1;
                        }
                    }
                }
                MaintenanceCursor::Pruning => {
                    self.recovery_queue = Some(MaintenanceCursor::Pruning);
                    let progress = self
                        .recovery
                        .as_mut()
                        .expect("enabled recovery")
                        .prune_batch(now_ms, 1)?;
                    if !progress.pending {
                        self.recovery_queue = None;
                        break;
                    }
                }
            }
        }
        Ok(RecoveryMaintenance {
            pending: self.recovery_queue.is_some(),
            failed_notes,
        })
    }

    /// A rejected/uncertain save must preserve the attempted text as secondary
    /// history, without authorizing it as current source or changing its receipt.
    pub(super) fn capture_failed_save_request(&mut self, request: &MutationRequest) -> Result<()> {
        if self.recovery.is_none() {
            return Ok(());
        }
        let (id, path, content) = match &request.mutation {
            Mutation::Create {
                id,
                path,
                kind: EntryKind::File,
                content: Some(content),
            } => (id, path.clone(), content),
            Mutation::Write { id, content, .. } => {
                let Some(metadata) = self.store.read_metadata(id)? else {
                    return Ok(());
                };
                (id, metadata.state.path, content)
            }
            _ => return Ok(()),
        };
        if !path.as_str().to_ascii_lowercase().ends_with(".md") {
            return Ok(());
        }
        if let Some(recovery) = &mut self.recovery {
            recovery.capture(
                SnapshotInput {
                    entry_id: id.as_str(),
                    historical_path: path.as_str(),
                    content,
                    provenance: SnapshotProvenance::SaveFailure,
                },
                now_ms(),
            )?;
        }
        Ok(())
    }

    pub(super) fn capture_local_recovery(
        &mut self,
        id: &EntryId,
        now_ms: i64,
        provenance: SnapshotProvenance,
    ) -> Result<()> {
        if self.recovery.is_none() {
            return Ok(());
        }
        let Some(metadata) = self.store.read_metadata(id)? else {
            return Ok(());
        };
        self.capture_local_recovery_metadata(metadata, now_ms, provenance)
    }

    fn capture_local_recovery_metadata(
        &mut self,
        metadata: zorid_store::StoredEntryMetadata,
        now_ms: i64,
        provenance: SnapshotProvenance,
    ) -> Result<()> {
        if metadata.state.kind != EntryKind::File
            || !metadata
                .state
                .path
                .as_str()
                .to_ascii_lowercase()
                .ends_with(".md")
        {
            return Ok(());
        }
        // Check metadata before legacy read, which materializes the entire body.
        if metadata
            .content
            .as_ref()
            .is_none_or(|content| content.len() > 16 * 1024 * 1024)
        {
            return Ok(());
        }
        let content = metadata.content.as_ref().expect("file content checked");
        if provenance == SnapshotProvenance::Periodic {
            match self
                .recovery
                .as_ref()
                .expect("enabled recovery")
                .periodic_capture_eligibility(
                    metadata.state.id.as_str(),
                    content.len(),
                    &content.digest().0,
                    now_ms,
                )? {
                PeriodicCaptureEligibility::Unchanged
                | PeriodicCaptureEligibility::IntervalNotElapsed => return Ok(()),
                PeriodicCaptureEligibility::CaptureRequired => {}
            }
        }
        // This fresh Store read revalidates its own selected metadata and bytes.
        // Never combine an old digest/path witness with a newly selected body.
        let Some(entry) = self.store.read(&metadata.state.id)? else {
            return Ok(());
        };
        if entry.state.kind != EntryKind::File
            || !entry
                .state
                .path
                .as_str()
                .to_ascii_lowercase()
                .ends_with(".md")
        {
            return Ok(());
        }
        let Some(content) = entry.content else {
            return Ok(());
        };
        if let Some(recovery) = &mut self.recovery {
            recovery.capture(
                SnapshotInput {
                    entry_id: entry.state.id.as_str(),
                    historical_path: entry.state.path.as_str(),
                    content: &content,
                    provenance,
                },
                now_ms,
            )?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zorid_core::{Mutation, MutationRequest, OperationId};
    fn create(vault: &mut NativeVault, id: &str, path: &str, bytes: &[u8]) -> ApplyOutcome {
        vault
            .apply(&MutationRequest {
                operation_id: OperationId::new(format!("create-{id}")).unwrap(),
                mutation: Mutation::Create {
                    id: EntryId::new(id).unwrap(),
                    path: VaultPath::new(path).unwrap(),
                    kind: EntryKind::File,
                    content: Some(bytes.to_vec()),
                },
            })
            .unwrap()
    }
    mod body_trace {
        use rusqlite::ffi;
        use std::{
            cell::Cell,
            ffi::{c_char, c_int, c_void, CStr},
            sync::{Mutex, MutexGuard},
        };
        thread_local! {
            static ATTACH:Cell<bool>=const{Cell::new(false)};
            static MEASURING:Cell<bool>=const{Cell::new(false)};
            static READS:Cell<[usize;2]>=const{Cell::new([0;2])};
        }
        static REGISTRATION: Mutex<()> = Mutex::new(());
        unsafe extern "C" fn trace(
            event: u32,
            _: *mut c_void,
            _: *mut c_void,
            sql: *mut c_void,
        ) -> c_int {
            if event == ffi::SQLITE_TRACE_STMT && !sql.is_null() && MEASURING.with(Cell::get) {
                let text = unsafe { CStr::from_ptr(sql.cast()) }
                    .to_string_lossy()
                    .to_ascii_lowercase();
                let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
                let selected = [
                    compact.starts_with("selectcontentfromentries"),
                    compact.contains("content_hash,contentfromsnapshots"),
                ];
                READS.with(|reads| {
                    let mut value = reads.get();
                    for (index, yes) in selected.into_iter().enumerate() {
                        if yes {
                            value[index] += 1;
                        }
                    }
                    reads.set(value);
                });
            }
            0
        }
        unsafe extern "C" fn attach(
            db: *mut ffi::sqlite3,
            _: *mut *mut c_char,
            _: *const ffi::sqlite3_api_routines,
        ) -> c_int {
            if ATTACH.with(Cell::get) {
                unsafe {
                    ffi::sqlite3_trace_v2(
                        db,
                        ffi::SQLITE_TRACE_STMT,
                        Some(trace),
                        std::ptr::null_mut(),
                    );
                }
            }
            ffi::SQLITE_OK
        }
        pub struct Register {
            _serial: MutexGuard<'static, ()>,
        }
        impl Register {
            pub fn new() -> Self {
                let serial = REGISTRATION.lock().unwrap();
                ATTACH.with(|v| v.set(true));
                assert_eq!(
                    unsafe { ffi::sqlite3_auto_extension(Some(attach)) },
                    ffi::SQLITE_OK
                );
                Self { _serial: serial }
            }
        }
        impl Drop for Register {
            fn drop(&mut self) {
                ATTACH.with(|v| v.set(false));
                unsafe {
                    ffi::sqlite3_cancel_auto_extension(Some(attach));
                }
            }
        }
        pub fn measure<T>(run: impl FnOnce() -> T) -> (T, [usize; 2]) {
            struct Stop;
            impl Drop for Stop {
                fn drop(&mut self) {
                    MEASURING.with(|v| v.set(false));
                }
            }
            READS.with(|v| v.set([0; 2]));
            MEASURING.with(|v| v.set(true));
            let _stop = Stop;
            let result = run();
            (result, READS.with(Cell::get))
        }
    }
    #[test]
    fn unchanged_periodic_revisit_selects_neither_current_nor_retained_body() {
        let root = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let trace = body_trace::Register::new();
        let mut vault = NativeVault::open(root.path()).unwrap();
        let note = EntryId::new("note").unwrap();
        create(&mut vault, "note", "note.md", b"same body");
        vault
            .enable_local_recovery_deferred(data.path().join("history.sqlite"), 0)
            .unwrap();
        drop(trace);
        assert!(vault.maintain_local_recovery(0, 1).unwrap().pending);
        assert!(!vault.maintain_local_recovery(0, 1).unwrap().pending);
        let before = vault.list_local_recovery(&note, None, 10).unwrap();
        assert_eq!(before.len(), 1);
        let (progress, reads) =
            body_trace::measure(|| vault.maintain_local_recovery(301_000, 1).unwrap());
        assert!(progress.pending);
        assert_eq!(progress.failed_notes, 0);
        assert_eq!(reads, [0, 0]);
        let (_, positive) = body_trace::measure(|| {
            vault.read(&note).unwrap();
            vault.read_local_recovery(&note, before[0].id).unwrap();
        });
        assert_eq!(
            positive,
            [1, 1],
            "the same real connections must count explicit current/history body reads"
        );
        assert_eq!(vault.list_local_recovery(&note, None, 10).unwrap(), before);
    }
    #[test]
    fn deferred_expired_same_content_is_renewed_before_bounded_idle_pruning() {
        let root = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let mut vault = NativeVault::open(root.path()).unwrap();
        let note = EntryId::new("note").unwrap();
        create(&mut vault, "note", "note.md", b"retained");
        vault
            .enable_local_recovery_deferred(data.path().join("history.sqlite"), 0)
            .unwrap();
        vault
            .capture_local_recovery(&note, 0, SnapshotProvenance::Periodic)
            .unwrap();
        let later = zorid_recovery::DEFAULT_RETENTION_MS + 1;
        vault
            .capture_local_recovery(&note, later, SnapshotProvenance::Periodic)
            .unwrap();
        let versions = vault.list_local_recovery(&note, None, 10).unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(versions[0].captured_at_ms, later);
        assert!(vault.maintain_local_recovery(later, 1).unwrap().pending);
        assert!(!vault.maintain_local_recovery(later, 1).unwrap().pending);
        let kept = vault.list_local_recovery(&note, None, 10).unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0], versions[0]);
        assert_eq!(
            vault
                .read_local_recovery(&note, kept[0].id)
                .unwrap()
                .unwrap()
                .content,
            b"retained"
        );
    }
    #[test]
    fn first_maintenance_unit_does_not_decode_a_later_corrupt_candidate() {
        let root = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let mut vault = NativeVault::open(root.path()).unwrap();
        create(&mut vault, "one", "one.md", b"one");
        create(&mut vault, "two", "two.md", b"two");
        vault
            .enable_local_recovery_deferred(data.path().join("history.sqlite"), 0)
            .unwrap();
        let connection =
            rusqlite::Connection::open(root.path().join(".zorid/vault.sqlite")).unwrap();
        connection
            .execute("UPDATE entries SET state='invalid' WHERE id='two'", [])
            .unwrap();
        drop(connection);
        let first = vault.maintain_local_recovery(0, 1).unwrap();
        assert!(first.pending);
        assert_eq!(first.failed_notes, 0);
        assert_eq!(
            vault
                .list_local_recovery(&EntryId::new("one").unwrap(), None, 10)
                .unwrap()
                .len(),
            1
        );
        assert!(vault.maintain_local_recovery(0, 1).is_err());
    }
    #[test]
    fn entry_scoped_history_reads_exact_bytes_and_rejects_foreign_versions() {
        let root = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let mut vault = NativeVault::open(root.path()).unwrap();
        let note = EntryId::new("note").unwrap();
        let other = EntryId::new("other").unwrap();
        create(
            &mut vault,
            note.as_str(),
            "old.md",
            b"\xef\xbb\xbfexact\r\n",
        );
        create(&mut vault, other.as_str(), "other.md", b"other secret");
        assert!(vault.list_local_recovery(&note, None, 10).is_err());
        vault
            .enable_local_recovery(data.path().join("recovery.sqlite"), now_ms())
            .unwrap();
        vault.snapshot_local_recovery(now_ms()).unwrap();
        let note_versions = vault.list_local_recovery(&note, None, 10).unwrap();
        let other_versions = vault.list_local_recovery(&other, None, 10).unwrap();
        assert_eq!(note_versions.len(), 1);
        assert_eq!(note_versions[0].historical_path, "old.md");
        assert_eq!(
            vault
                .read_local_recovery(&note, note_versions[0].id)
                .unwrap()
                .unwrap()
                .content,
            b"\xef\xbb\xbfexact\r\n"
        );
        assert!(vault
            .read_local_recovery(&note, other_versions[0].id)
            .unwrap()
            .is_none());
        assert!(vault
            .read_local_recovery(&note, i64::MAX)
            .unwrap()
            .is_none());
        assert!(vault.read_local_recovery(&note, 0).is_err());
        assert!(vault.list_local_recovery(&note, None, 101).is_err());
        let cursor = LocalRecoveryCursor {
            captured_at_ms: note_versions[0].captured_at_ms,
            id: note_versions[0].id,
        };
        assert!(vault
            .list_local_recovery(&note, Some(cursor), 10)
            .unwrap()
            .is_empty());
        let revision = vault.read(&note).unwrap().unwrap().state.revision;
        vault
            .apply(&MutationRequest {
                operation_id: OperationId::new("rename").unwrap(),
                mutation: Mutation::Move {
                    id: note.clone(),
                    expected: revision,
                    path: VaultPath::new("new.md").unwrap(),
                },
            })
            .unwrap();
        assert_eq!(
            vault.list_local_recovery(&note, None, 10).unwrap(),
            note_versions
        );
        assert_eq!(
            vault
                .read_local_recovery(&note, note_versions[0].id)
                .unwrap()
                .unwrap()
                .info
                .historical_path,
            "old.md"
        );
    }
    #[test]
    fn local_snapshots_live_outside_vault_and_keep_exact_note_bytes() {
        let root = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let path = data.path().join("recovery.sqlite");
        let mut vault = NativeVault::open(root.path()).unwrap();
        create(&mut vault, "note", "note.md", b"first\n");
        create(&mut vault, "image", "image.png", b"image");
        let initial = now_ms() - zorid_recovery::DEFAULT_INTERVAL_MS;
        vault.enable_local_recovery(&path, initial).unwrap();
        vault.snapshot_local_recovery(initial).unwrap();
        let id = EntryId::new("note").unwrap();
        let expected = vault.read(&id).unwrap().unwrap().state.revision;
        let result = vault
            .apply(&MutationRequest {
                operation_id: OperationId::new("edit").unwrap(),
                mutation: Mutation::Write {
                    id: id.clone(),
                    expected,
                    content: b"second\n".to_vec(),
                },
            })
            .unwrap();
        assert!(matches!(result.projection, ProjectionStatus::Projected));
        assert!(!root.path().join(".zorid/recovery.sqlite").exists());
        let local_id = vault.identity().unwrap().local_store_id;
        drop(vault);
        let history = RecoveryStore::open(
            path.canonicalize().unwrap(),
            &RecoveryScope {
                vault_id: local_id.as_str().into(),
                replica_id: "native-local".into(),
            },
            now_ms(),
        )
        .unwrap();
        let notes = history.list("note", None, 100).unwrap();
        assert_eq!(notes.len(), 2);
        assert_eq!(
            history.read(notes[0].id).unwrap().unwrap().content,
            b"second\n"
        );
        assert_eq!(
            history.read(notes[1].id).unwrap().unwrap().content,
            b"first\n"
        );
        assert!(history.list("image", None, 100).unwrap().is_empty());
    }
    #[test]
    fn local_recovery_rejects_vault_location_and_never_changes_save_receipt() {
        let root = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let path = data.path().join("recovery.sqlite");
        let mut vault = NativeVault::open(root.path()).unwrap();
        assert!(vault
            .enable_local_recovery(root.path().join("recovery.sqlite"), 0)
            .is_err());
        vault.enable_local_recovery(&path, now_ms()).unwrap();
        // Simulate a broken secondary history store after opening. A successful
        // authoritative save must still return its receipt and publish its bytes.
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute_batch("DROP TABLE snapshots")
            .unwrap();
        let result = create(&mut vault, "note", "note.md", b"still saved");
        assert!(matches!(result.projection, ProjectionStatus::Projected));
        assert_eq!(
            std::fs::read(root.path().join("note.md")).unwrap(),
            b"still saved"
        );
    }
    #[test]
    fn enrolled_durable_saves_capture_normal_and_failed_projection_versions() {
        use zorid_sync_protocol::{RealmId, VaultId};
        let root = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let path = data.path().join("recovery.sqlite");
        let mut vault = NativeVault::open(root.path()).unwrap();
        vault
            .family_enroll(&FamilyScope {
                realm_id: RealmId::new("realm").unwrap(),
                vault_id: VaultId::new("vault").unwrap(),
            })
            .unwrap();
        let id = EntryId::new("note").unwrap();
        let created = vault
            .family_apply(
                &MutationRequest {
                    operation_id: OperationId::new("create").unwrap(),
                    mutation: Mutation::Create {
                        id: id.clone(),
                        path: VaultPath::new("note.md").unwrap(),
                        kind: EntryKind::File,
                        content: Some(b"base".to_vec()),
                    },
                },
                Some(FamilyCreateMode::Text),
            )
            .unwrap();
        assert!(matches!(created.projection, ProjectionStatus::Projected));
        vault.enable_local_recovery(&path, now_ms()).unwrap();
        let client = OperationId::new("editor").unwrap();
        for (operation, bytes, pending) in [
            ("saved", b"saved".as_slice(), false),
            ("pending", b"pending".as_slice(), true),
        ] {
            if pending {
                std::fs::write(root.path().join("note.md"), b"external edit").unwrap();
            }
            let revision = vault.read(&id).unwrap().unwrap().state.revision;
            let intent = vault
                .prepare_host_intent(
                    &client,
                    &MutationRequest {
                        operation_id: OperationId::new(operation).unwrap(),
                        mutation: Mutation::Write {
                            id: id.clone(),
                            expected: revision,
                            content: bytes.to_vec(),
                        },
                    },
                )
                .unwrap();
            let outcome = vault
                .commit_host_intent(&HostIntentRef {
                    client_id: client.clone(),
                    token: intent.token,
                })
                .unwrap();
            assert_eq!(outcome.state, HostIntentState::Committed);
            assert_eq!(
                matches!(outcome.projection, Some(HostProjectionState::Pending)),
                pending
            );
        }
        let local_id = vault.identity().unwrap().local_store_id;
        drop(vault);
        let history = RecoveryStore::open(
            path.canonicalize().unwrap(),
            &RecoveryScope {
                vault_id: local_id.as_str().into(),
                replica_id: "native-local".into(),
            },
            now_ms(),
        )
        .unwrap();
        let versions = history.list("note", None, 100).unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(
            history.read(versions[0].id).unwrap().unwrap().content,
            b"pending"
        );
        assert_eq!(versions[0].provenance, SnapshotProvenance::SaveFailure);
        assert_eq!(
            history.read(versions[1].id).unwrap().unwrap().content,
            b"saved"
        );
    }
    #[test]
    fn rejected_durable_save_keeps_attempted_text_without_changing_current_source() {
        use zorid_sync_protocol::{RealmId, VaultId};
        let root = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let path = data.path().join("recovery.sqlite");
        let mut vault = NativeVault::open(root.path()).unwrap();
        vault
            .family_enroll(&FamilyScope {
                realm_id: RealmId::new("realm").unwrap(),
                vault_id: VaultId::new("vault").unwrap(),
            })
            .unwrap();
        let id = EntryId::new("note").unwrap();
        vault
            .family_apply(
                &MutationRequest {
                    operation_id: OperationId::new("create").unwrap(),
                    mutation: Mutation::Create {
                        id: id.clone(),
                        path: VaultPath::new("note.md").unwrap(),
                        kind: EntryKind::File,
                        content: Some(b"current".to_vec()),
                    },
                },
                Some(FamilyCreateMode::Text),
            )
            .unwrap();
        vault.enable_local_recovery(&path, now_ms()).unwrap();
        let client = OperationId::new("editor").unwrap();
        let intent = vault
            .prepare_host_intent(
                &client,
                &MutationRequest {
                    operation_id: OperationId::new("rejected").unwrap(),
                    mutation: Mutation::Write {
                        id: id.clone(),
                        expected: Revision::new("stale").unwrap(),
                        content: b"valuable attempted draft".to_vec(),
                    },
                },
            )
            .unwrap();
        let outcome = vault
            .commit_host_intent(&HostIntentRef {
                client_id: client,
                token: intent.token,
            })
            .unwrap();
        assert_eq!(outcome.state, HostIntentState::Rejected);
        assert_eq!(
            vault.read(&id).unwrap().unwrap().content.unwrap(),
            b"current"
        );
        assert_eq!(
            std::fs::read(root.path().join("note.md")).unwrap(),
            b"current"
        );
        let local_id = vault.identity().unwrap().local_store_id;
        drop(vault);
        let history = RecoveryStore::open(
            path.canonicalize().unwrap(),
            &RecoveryScope {
                vault_id: local_id.as_str().into(),
                replica_id: "native-local".into(),
            },
            now_ms(),
        )
        .unwrap();
        let versions = history.list("note", None, 100).unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(
            history.read(versions[0].id).unwrap().unwrap().content,
            b"valuable attempted draft"
        );
        assert_eq!(versions[0].provenance, SnapshotProvenance::SaveFailure);
    }
    #[test]
    fn maintenance_pages_note_bodies_without_restarting_the_inventory() {
        let root = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let path = data.path().join("recovery.sqlite");
        let mut vault = NativeVault::open(root.path()).unwrap();
        for (id, name) in [("one", "one.md"), ("two", "two.md"), ("three", "three.md")] {
            create(&mut vault, id, name, name.as_bytes());
        }
        vault.enable_local_recovery(&path, now_ms()).unwrap();
        assert!(vault.maintain_local_recovery(now_ms(), 0).is_err());
        let first = vault.maintain_local_recovery(now_ms(), 1).unwrap();
        assert!(first.pending);
        assert_eq!(first.failed_notes, 0);
        assert_eq!(
            vault
                .recovery
                .as_ref()
                .unwrap()
                .list("one", None, 10)
                .unwrap()
                .len()
                + vault
                    .recovery
                    .as_ref()
                    .unwrap()
                    .list("two", None, 10)
                    .unwrap()
                    .len()
                + vault
                    .recovery
                    .as_ref()
                    .unwrap()
                    .list("three", None, 10)
                    .unwrap()
                    .len(),
            1
        );
        let second = vault.maintain_local_recovery(now_ms(), 1).unwrap();
        assert!(second.pending);
        let third = vault.maintain_local_recovery(now_ms(), 1).unwrap();
        assert!(third.pending); // Expiry pruning is its own next maintenance unit.
        assert_eq!(third.failed_notes, 0);
        let fourth = vault.maintain_local_recovery(now_ms(), 1).unwrap();
        assert!(!fourth.pending);
        for id in ["one", "two", "three"] {
            assert_eq!(
                vault
                    .recovery
                    .as_ref()
                    .unwrap()
                    .list(id, None, 10)
                    .unwrap()
                    .len(),
                1
            );
        }
    }
    #[test]
    fn discarding_and_rebuilding_cache_preserves_source_and_retained_history() {
        let root = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let recovery_path = data.path().join("recovery.sqlite");
        let cache_path = data.path().join("cache.sqlite");
        let mut vault = NativeVault::open(root.path()).unwrap();
        vault
            .enable_local_recovery(&recovery_path, now_ms())
            .unwrap();
        vault.enable_local_document_cache(&cache_path).unwrap();
        create(&mut vault, "note", "note.md", b"# Current note\n#retained");
        let id = EntryId::new("note").unwrap();
        let source = vault.read(&id).unwrap().unwrap();
        let history = vault.list_local_recovery(&id, None, 10).unwrap();
        assert_eq!(history.len(), 1);
        fn build(vault: &mut NativeVault) -> zorid_index::IndexSnapshotId {
            vault.initialize_document_index().unwrap();
            let stage = vault.begin_document_index().unwrap();
            assert!(vault.pump_document_index(&stage).unwrap().ready);
            vault.publish_document_index(&stage).unwrap()
        }
        let first = build(&mut vault);
        drop(vault);
        std::fs::remove_file(&cache_path).unwrap();
        let mut vault = NativeVault::open_existing(root.path()).unwrap();
        vault
            .enable_local_recovery(&recovery_path, now_ms())
            .unwrap();
        vault.enable_local_document_cache(&cache_path).unwrap();
        let rebuilt = build(&mut vault);
        assert_ne!(first, rebuilt);
        assert_eq!(vault.read(&id).unwrap().unwrap(), source);
        assert_eq!(vault.list_local_recovery(&id, None, 10).unwrap(), history);
        assert_eq!(
            vault
                .read_local_recovery(&id, history[0].id)
                .unwrap()
                .unwrap()
                .content,
            source.content.unwrap()
        );
        assert_eq!(
            std::fs::read(root.path().join("note.md")).unwrap(),
            b"# Current note\n#retained"
        );
    }
}
