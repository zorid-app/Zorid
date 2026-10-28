//! Family observations retain actual streamed bytes before causal import. A
//! content reference never substitutes for the saved public inode/parent proof.
use super::*;
use crate::fs_stream::StreamSnapshot;
use zorid_store::{ExternalObservation, ProjectionBaseline, Sha256Digest};

impl NativeVault {
    fn retain_streamed_observation(
        &mut self,
        path: &VaultPath,
        parent: &File,
        expected: &StreamSnapshot,
        origin: &OperationId,
        baseline: Option<&ProjectionBaseline>,
        proof: Option<&ObservationPhysical>,
        text: bool,
        scan: Option<&external_namespace::EnrolledScan<'_>>,
    ) -> Result<ExternalObservation> {
        self.paths.verify_parent(path, parent)?;
        let physical = PhysicalIdentity {
            inode: expected.identity.clone(),
            parent_inode: expected.parent_identity.clone(),
        };
        if let Some(observation) = self.store.find_matching_external_observation(
            &content_stream::core_client()?,
            path,
            baseline,
            proof,
            expected.length,
            &Sha256Digest(expected.digest),
        )? {
            // Keep the original observation ID and retained source, including
            // namespace pending-content captures. A locator match alone does
            // not prove that these bytes still occupy the observed public path.
            self.verify_observed_content(path, parent, &physical, &observation.content)?;
            return Ok(observation);
        }
        let content = self.capture_observed_file_with_scan(
            path,
            parent,
            path.file_name(),
            origin,
            baseline,
            proof,
            expected,
            text,
            scan,
        )?;
        self.verify_observed_content(path, parent, &physical, &content)?;
        self.retain_observed_content(path, baseline, &content, proof)
    }

    pub(super) fn observe_streamed_file(
        &mut self,
        path: &VaultPath,
        parent: &File,
        expected: &StreamSnapshot,
        origin: &OperationId,
    ) -> Result<Option<CommitResult>> {
        self.observe_streamed_file_with_scan(path, parent, expected, origin, None)
    }

    pub(super) fn observe_streamed_file_with_scan(
        &mut self,
        path: &VaultPath,
        parent: &File,
        expected: &StreamSnapshot,
        origin: &OperationId,
        scan: Option<&external_namespace::EnrolledScan<'_>>,
    ) -> Result<Option<CommitResult>> {
        self.paths.verify_parent(path, parent)?;
        match scan {
            Some(scan) => scan.check(self)?,
            None if !self.store.family_is_enrolled()? => return Err(Error::Unsupported(
                "streamed file observation requires family enrollment",
            )),
            None => {},
        }
        let state = self
            .store
            .read_path_metadata(path)?
            .map(|entry| entry.state);
        let owner = self.store.physical_owner_at(path)?;
        let physical = PhysicalIdentity {
            inode: expected.identity.clone(),
            parent_inode: expected.parent_identity.clone(),
        };
        match self.namespace_clear(path) {
            Ok(()) => {}
            Err(error @ Error::Busy(_)) => {
                // The namespace fence still wins. Only its exact visible,
                // historical public branch may journal an edit while blocked;
                // no attempt or covered job is settled by this retention.
                if let Some(owner) = owner.as_ref().filter(|owner| {
                    owner.state.kind == EntryKind::File
                        && owner.physical == physical
                        && state.as_ref().is_some_and(|state| {
                            state.id == owner.state.id
                                && state.path == owner.state.path
                                && state.kind == EntryKind::File
                                && !state.deleted
                        })
                }) {
                    if let Some(base) = self
                        .store
                        .projection_baseline(&owner.state.id)?
                        .filter(|base| base.state == owner.state)
                    {
                        if !snapshot_matches_content(expected, &base.content) {
                            let text = self.store.family_text_state(&owner.state.id)?.is_some();
                            self.retain_streamed_observation(
                                path,
                                parent,
                                expected,
                                origin,
                                Some(&base),
                                Some(&ObservationPhysical {
                                    physical: physical.clone(),
                                    expected_binding: Some(owner.clone()),
                                }),
                                text,
                                scan,
                            )?;
                        }
                    }
                }
                return Err(error);
            }
            Err(error) => return Err(error),
        }
        if let Some(owner) = &owner {
            if state
                .as_ref()
                .is_none_or(|state| state.id != owner.state.id)
            {
                return Err(Error::Busy(
                    "retained physical owner is hidden or awaits namespace reconciliation",
                ));
            }
        }
        if state
            .as_ref()
            .is_some_and(|state| state.kind != EntryKind::File)
        {
            return Err(Error::UnsafePath(
                "filesystem file collides with logical folder".into(),
            ));
        }
        let baseline = match &state {
            Some(state) => self.store.projection_baseline(&state.id)?,
            None => None,
        };
        let binding = match &state {
            Some(state) => self.store.physical_binding(&state.id)?,
            None => None,
        };
        // An exact physical no-op consumes no Text/Binary dispatch decision.
        // Preserve the same namespace, saved-baseline, inode/parent and fresh
        // byte proof before returning; do not reconstruct retained CRDT state
        // just to choose a mode which this branch never uses. Selected retained
        // Text validation remains at explicit retained Text reads and authoring/
        // import admissions, plus every changed, replacement or blocked-retention
        // path which needs that mode. Raw byte reads are not a causal scrub.
        if let Some(base) = baseline.as_ref().filter(|base| {
            base.state.path == *path && snapshot_matches_content(expected, &base.content)
        }) {
            if binding.as_ref().is_some_and(|binding| binding.physical == physical) {
                self.verify_observed_content(path, parent, &physical, &base.content)?;
                return Ok(None);
            }
        }
        let text = match &state {
            Some(state) => self.store.family_text_state(&state.id)?.is_some(),
            None => false,
        };
        if binding
            .as_ref()
            .is_some_and(|binding| binding.physical.parent_inode != physical.parent_inode)
        {
            self.retain_streamed_observation(
                path,
                parent,
                expected,
                origin,
                baseline.as_ref(),
                None,
                text,
                scan,
            )?;
            return Err(Error::Busy(
                "observation parent replaced; original binding retained",
            ));
        }
        if baseline.is_some() && binding.is_none() {
            self.retain_streamed_observation(
                path,
                parent,
                expected,
                origin,
                baseline.as_ref(),
                None,
                text,
                scan,
            )?;
            return Err(Error::Busy(
                "unproven physical baseline requires explicit enrollment",
            ));
        }
        if let Some(base) = baseline.as_ref().filter(|base| {
            base.state.path == *path && snapshot_matches_content(expected, &base.content)
        }) {
            self.retain_streamed_observation(
                path,
                parent,
                expected,
                origin,
                Some(base),
                None,
                text,
                scan,
            )?;
            return Err(Error::Busy(
                "equal-byte replacement has no original inode authority",
            ));
        }
        let active = self
            .store
            .projection_attempts(false)?
            .into_iter()
            .find(|attempt| attempt.target.state.path == *path);
        let proof = ObservationPhysical {
            physical: physical.clone(),
            expected_binding: binding,
        };
        let observation = self.retain_streamed_observation(
            path,
            parent,
            expected,
            origin,
            baseline.as_ref(),
            Some(&proof),
            text,
            scan,
        )?;
        // An oversized Text alternative is retained through an inert capture.
        // Its immutable mode does not become Binary, and no stage is cancelled
        // merely to attempt an unsupported Text import.
        if text && observation.content.inline_bytes().is_none() {
            return Err(Error::Unsupported(
                "external text exceeds supported inline limit",
            ));
        }
        if let Some(active) = active {
            let previous = format!("{}.previous", active.attempt_id.as_str());
            let undisplaced = matches!(
                active.phase,
                ProjectionPhase::Prepared | ProjectionPhase::Staged
            ) && active.stage_identity.as_ref() != Some(&expected.identity)
                && fs::node_type(&self.paths.private, &previous)?.is_none();
            if text && undisplaced {
                self.paths.verify_parent(path, parent)?;
                self.store.finish_projection(&active.attempt_id, false)?;
            } else {
                return Err(Error::Busy(
                    "unresolved projection; external observation retained",
                ));
            }
        }
        if state.is_none() || baseline.is_none() {
            return Err(Error::Unsupported(
                "new external files require explicit family mode enrollment",
            ));
        }
        self.verify_observed_content(path, parent, &physical, &observation.content)?;
        self.paths.verify_parent(path, parent)?;
        Ok(Some(self.store.import_family_observation_content(
            &content_stream::core_client()?,
            &observation.observation_id,
        )?))
    }
}

#[cfg(test)]
mod family_hint_tests {
    use super::*;
    use std::os::unix::fs::{symlink, MetadataExt};
    use zorid_store::ScanRun;
    use zorid_sync_protocol::{RealmId, VaultId};

    const ORIGINAL: &[u8] = b"\xef\xbb\xbf# Original\r\nRetained body.\r\n";
    const EXTERNAL: &[u8] = b"\xef\xbb\xbf# Original\r\nExternal body \xe2\x98\x83.\r\n";

    struct Fixture {
        root: tempfile::TempDir,
        _history: tempfile::TempDir,
        vault: NativeVault,
        id: EntryId,
        path: VaultPath,
    }

    struct Witness {
        entry: zorid_store::StoredEntry,
        authored: Vec<FamilyAuthoredStatus>,
        scan: Option<ScanRun>,
        history: Vec<LocalRecoverySnapshot>,
    }

    impl Fixture {
        fn new(nested: bool) -> Self {
            let root = tempfile::tempdir().unwrap();
            let history = tempfile::tempdir().unwrap();
            let mut vault = NativeVault::open(root.path()).unwrap();
            vault
                .family_enroll(&FamilyScope {
                    realm_id: RealmId::new("hint-realm").unwrap(),
                    vault_id: VaultId::new("hint-vault").unwrap(),
                })
                .unwrap();
            if nested {
                let outcome = vault
                    .family_apply(
                        &MutationRequest {
                            operation_id: OperationId::new("hint-create-folder").unwrap(),
                            mutation: Mutation::Create {
                                id: EntryId::new("hint-folder").unwrap(),
                                path: VaultPath::new("Folder").unwrap(),
                                kind: EntryKind::Folder,
                                content: None,
                            },
                        },
                        None,
                    )
                    .unwrap();
                assert!(matches!(outcome.projection, ProjectionStatus::Projected));
            }
            let id = EntryId::new("hint-note").unwrap();
            let path = VaultPath::new(if nested { "Folder/note.md" } else { "note.md" }).unwrap();
            let outcome = vault
                .family_apply(
                    &MutationRequest {
                        operation_id: OperationId::new("hint-create-note").unwrap(),
                        mutation: Mutation::Create {
                            id: id.clone(),
                            path: path.clone(),
                            kind: EntryKind::File,
                            content: Some(ORIGINAL.to_vec()),
                        },
                    },
                    Some(FamilyCreateMode::Text),
                )
                .unwrap();
            assert!(matches!(outcome.projection, ProjectionStatus::Projected));
            vault
                .enable_local_recovery(history.path().join("history.sqlite"), 1_700_000_000_000)
                .unwrap();
            vault.snapshot_local_recovery(1_700_000_000_000).unwrap();
            Self {
                root,
                _history: history,
                vault,
                id,
                path,
            }
        }

        fn file(&self) -> std::path::PathBuf {
            self.root.path().join(self.path.as_str())
        }

        fn history(&self) -> Vec<LocalRecoverySnapshot> {
            let versions = self.vault.list_local_recovery(&self.id, None, 100).unwrap();
            assert!(
                !versions.is_empty(),
                "the fixture must retain real note history"
            );
            versions
                .into_iter()
                .map(|version| {
                    self.vault
                        .read_local_recovery(&self.id, version.id)
                        .unwrap()
                        .unwrap()
                })
                .collect()
        }

        fn witness(&self) -> Witness {
            Witness {
                entry: self.vault.read(&self.id).unwrap().unwrap(),
                authored: self.vault.family_pending_authored(None, 1000).unwrap(),
                scan: self.vault.status().unwrap().scan,
                history: self.history(),
            }
        }

        fn assert_retained(&self, before: &Witness) {
            assert_eq!(self.vault.read(&self.id).unwrap().unwrap(), before.entry);
            assert_eq!(
                self.vault.family_pending_authored(None, 1000).unwrap(),
                before.authored
            );
            assert_eq!(
                self.vault.status().unwrap().scan,
                before.scan,
                "a path hint must not run a full scan"
            );
            self.assert_history(before);
        }

        fn assert_history(&self, before: &Witness) {
            for snapshot in &before.history {
                assert_eq!(
                    self.vault
                        .read_local_recovery(&self.id, snapshot.info.id)
                        .unwrap()
                        .as_ref(),
                    Some(snapshot),
                    "reconciliation must preserve exact retained historical bodies"
                );
            }
        }

        fn assert_blocked(report: &ReconcileReport, path: &VaultPath) {
            assert!(report.imported.is_empty(), "{report:?}");
            assert!(
                report.blocked.iter().any(|(blocked, _)| blocked == path),
                "{report:?}"
            );
        }
    }

    #[test]
    fn enrolled_path_hint_own_projection_echo_does_not_author_or_scan() {
        let mut f = Fixture::new(false);
        let expected = f.vault.read(&f.id).unwrap().unwrap().state.revision;
        let outcome = f
            .vault
            .family_apply(
                &MutationRequest {
                    operation_id: OperationId::new("hint-own-edit").unwrap(),
                    mutation: Mutation::Write {
                        id: f.id.clone(),
                        expected,
                        content: EXTERNAL.to_vec(),
                    },
                },
                None,
            )
            .unwrap();
        assert!(matches!(outcome.projection, ProjectionStatus::Projected));
        let before = f.witness();
        let inode = std::fs::metadata(f.file()).unwrap().ino();
        for _ in 0..2 {
            let report = f.vault.reconcile(&[f.path.clone()]).unwrap();
            assert!(
                report.imported.is_empty() && report.blocked.is_empty(),
                "{report:?}"
            );
            f.assert_retained(&before);
            assert_eq!(std::fs::metadata(f.file()).unwrap().ino(), inode);
            assert_eq!(std::fs::read(f.file()).unwrap(), EXTERNAL);
        }
    }

    #[test]
    fn enrolled_path_hint_inplace_text_edit_preserves_identity_and_authors_one_family_update() {
        let mut f = Fixture::new(false);
        let before = f.witness();
        let inode = std::fs::metadata(f.file()).unwrap().ino();
        std::fs::write(f.file(), EXTERNAL).unwrap();
        assert_eq!(std::fs::metadata(f.file()).unwrap().ino(), inode);
        let report = f.vault.reconcile(&[f.path.clone()]).unwrap();
        assert_eq!(report.imported.len(), 1, "{report:?}");
        assert!(report.blocked.is_empty(), "{report:?}");
        let after = f.vault.read(&f.id).unwrap().unwrap();
        assert_eq!(after.state.id, before.entry.state.id);
        assert_eq!(after.state.path, before.entry.state.path);
        assert_ne!(after.state.revision, before.entry.state.revision);
        assert_eq!(after.content.as_deref(), Some(EXTERNAL));
        assert_eq!(std::fs::read(f.file()).unwrap(), EXTERNAL);
        let authored = f.vault.family_pending_authored(None, 1000).unwrap();
        assert_eq!(authored.len(), before.authored.len() + 1);
        assert!(before
            .authored
            .iter()
            .all(|update| authored.contains(update)));
        assert_eq!(f.vault.status().unwrap().scan, before.scan);
        f.assert_history(&before);
        let observed = f.witness();
        let echo = f.vault.reconcile(&[f.path.clone()]).unwrap();
        assert!(
            echo.imported.is_empty() && echo.blocked.is_empty(),
            "{echo:?}"
        );
        f.assert_retained(&observed);
    }

    #[test]
    fn enrolled_path_hint_equal_byte_replacement_retains_history_without_claiming_original_inode() {
        let mut f = Fixture::new(false);
        let before = f.witness();
        let inode = std::fs::metadata(f.file()).unwrap().ino();
        let replacement = f.root.path().join(".replacement");
        std::fs::write(&replacement, ORIGINAL).unwrap();
        std::fs::rename(replacement, f.file()).unwrap();
        let replacement_inode = std::fs::metadata(f.file()).unwrap().ino();
        assert_ne!(replacement_inode, inode);
        let report = f.vault.reconcile(&[f.path.clone()]).unwrap();
        Fixture::assert_blocked(&report, &f.path);
        f.assert_retained(&before);
        assert_eq!(
            std::fs::metadata(f.file()).unwrap().ino(),
            replacement_inode
        );
        assert_eq!(std::fs::read(f.file()).unwrap(), ORIGINAL);
        assert!(
            f.vault
                .status()
                .unwrap()
                .observations
                .iter()
                .any(|observation| { observation.path == f.path && !observation.resolved }),
            "equal bytes on a new inode must remain a retained observation"
        );
    }

    #[test]
    fn enrolled_path_hint_deletion_requires_namespace_scan_and_does_not_recreate_the_file() {
        let mut f = Fixture::new(false);
        let before = f.witness();
        std::fs::remove_file(f.file()).unwrap();
        let report = f.vault.reconcile(&[f.path.clone()]).unwrap();
        Fixture::assert_blocked(&report, &f.path);
        f.assert_retained(&before);
        assert!(
            !f.file().exists(),
            "a deletion hint cannot authorize restoring its old projection"
        );
    }

    #[test]
    fn enrolled_path_hint_unknown_file_or_folder_requires_full_family_reconciliation() {
        for folder in [false, true] {
            let mut f = Fixture::new(false);
            let before = f.witness();
            let path = VaultPath::new(if folder { "Unknown" } else { "unknown.md" }).unwrap();
            let physical = f.root.path().join(path.as_str());
            if folder {
                std::fs::create_dir(&physical).unwrap();
            } else {
                std::fs::write(&physical, EXTERNAL).unwrap();
            }
            let report = f.vault.reconcile(&[path.clone()]).unwrap();
            Fixture::assert_blocked(&report, &path);
            f.assert_retained(&before);
            assert!(f
                .vault
                .list()
                .unwrap()
                .iter()
                .all(|entry| entry.path != path));
            if folder {
                assert!(physical.is_dir());
            } else {
                assert_eq!(std::fs::read(physical).unwrap(), EXTERNAL);
            }
        }
    }

    #[test]
    fn enrolled_path_hint_file_symlink_cannot_import_outside_content() {
        let mut f = Fixture::new(false);
        let before = f.witness();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("outside.md");
        std::fs::write(&target, EXTERNAL).unwrap();
        std::fs::remove_file(f.file()).unwrap();
        symlink(&target, f.file()).unwrap();
        let report = f.vault.reconcile(&[f.path.clone()]).unwrap();
        Fixture::assert_blocked(&report, &f.path);
        f.assert_retained(&before);
        assert!(std::fs::symlink_metadata(f.file())
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read(target).unwrap(), EXTERNAL);
    }

    #[test]
    fn enrolled_path_hint_replaced_parent_cannot_rebind_known_note_or_discard_history() {
        let mut f = Fixture::new(true);
        let before = f.witness();
        let folder = f.root.path().join("Folder");
        let parent_inode = std::fs::metadata(&folder).unwrap().ino();
        let displaced = f.root.path().join("DisplacedFolder");
        std::fs::rename(&folder, &displaced).unwrap();
        std::fs::create_dir(&folder).unwrap();
        assert_ne!(std::fs::metadata(&folder).unwrap().ino(), parent_inode);
        std::fs::write(f.file(), EXTERNAL).unwrap();
        let report = f.vault.reconcile(&[f.path.clone()]).unwrap();
        Fixture::assert_blocked(&report, &f.path);
        f.assert_retained(&before);
        assert_eq!(std::fs::read(f.file()).unwrap(), EXTERNAL);
        assert_eq!(std::fs::read(displaced.join("note.md")).unwrap(), ORIGINAL);
    }

    #[test]
    fn enrolled_path_hint_symlink_parent_cannot_follow_an_external_directory() {
        let mut f = Fixture::new(true);
        let before = f.witness();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("note.md"), EXTERNAL).unwrap();
        let folder = f.root.path().join("Folder");
        let displaced = f.root.path().join("DisplacedFolder");
        std::fs::rename(&folder, &displaced).unwrap();
        symlink(outside.path(), &folder).unwrap();
        let report = f.vault.reconcile(&[f.path.clone()]).unwrap();
        Fixture::assert_blocked(&report, &f.path);
        f.assert_retained(&before);
        assert!(std::fs::symlink_metadata(folder)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::read(outside.path().join("note.md")).unwrap(),
            EXTERNAL
        );
        assert_eq!(std::fs::read(displaced.join("note.md")).unwrap(), ORIGINAL);
    }
}

#[cfg(test)]
mod no_op_dataflow_tests {
    use super::*;
    use rusqlite::{ffi, Connection};
    use std::{
        cell::Cell,
        ffi::{c_char, c_int, c_void, CStr},
        sync::{Mutex, MutexGuard},
    };
    use zorid_sync_protocol::{RealmId, VaultId};

    thread_local! {
        static ATTACH: Cell<bool> = const { Cell::new(false) };
        static MEASURING: Cell<bool> = const { Cell::new(false) };
        static READS: Cell<[usize; 2]> = const { Cell::new([0; 2]) };
    }
    static TRACE_REGISTRATION: Mutex<()> = Mutex::new(());
    unsafe extern "C" fn trace(
        event: u32,
        _: *mut c_void,
        _: *mut c_void,
        sql: *mut c_void,
    ) -> c_int {
        if event == ffi::SQLITE_TRACE_STMT && !sql.is_null() && MEASURING.with(Cell::get) {
            let bytes = unsafe { CStr::from_ptr(sql.cast()) }.to_bytes();
            for (slot, table) in [
                b" FROM text_bindings".as_slice(),
                b" FROM text_revisions".as_slice(),
            ]
            .into_iter()
            .enumerate()
            {
                if bytes.windows(table.len()).any(|window| window == table) {
                    READS.with(|reads| {
                        let mut value = reads.get();
                        value[slot] += 1;
                        reads.set(value);
                    });
                }
            }
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
                )
            };
        }
        ffi::SQLITE_OK
    }
    // Install a static, observational callback only on this thread's actual new
    // NativeVault connections. Other test threads neither attach nor count it.
    // Cancel auto-registration immediately after opening; no Store seam changes.
    struct RegisterTrace {
        _serial: MutexGuard<'static, ()>,
    }
    impl RegisterTrace {
        fn new() -> Self {
            let serial = TRACE_REGISTRATION.lock().unwrap();
            ATTACH.with(|value| value.set(true));
            assert_eq!(
                unsafe { ffi::sqlite3_auto_extension(Some(attach)) },
                ffi::SQLITE_OK
            );
            Self { _serial: serial }
        }
    }
    impl Drop for RegisterTrace {
        fn drop(&mut self) {
            ATTACH.with(|value| value.set(false));
            unsafe { ffi::sqlite3_cancel_auto_extension(Some(attach)) };
        }
    }
    fn measured<T>(run: impl FnOnce() -> T) -> (T, [usize; 2]) {
        struct Stop;
        impl Drop for Stop {
            fn drop(&mut self) {
                MEASURING.with(|value| value.set(false));
            }
        }
        READS.with(|value| value.set([0; 2]));
        MEASURING.with(|value| value.set(true));
        let _stop = Stop;
        let result = run();
        (result, READS.with(Cell::get))
    }
    const ORIGINAL: &[u8] = b"\xef\xbb\xbf# Saved\r\nBody remains exact.\r\n";
    const CHANGED: &[u8] = b"\xef\xbb\xbf# Saved\r\nExternal body changed.\r\n";
    struct Fixture {
        root: tempfile::TempDir,
        vault: NativeVault,
        sql: Connection,
        id: EntryId,
        path: VaultPath,
    }
    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let registration = RegisterTrace::new();
            let mut vault = NativeVault::open(root.path()).unwrap();
            drop(registration);
            vault
                .family_enroll(&FamilyScope {
                    realm_id: RealmId::new("noop-realm").unwrap(),
                    vault_id: VaultId::new("noop-vault").unwrap(),
                })
                .unwrap();
            let id = EntryId::new("noop-entry").unwrap();
            let path = VaultPath::new("note.md").unwrap();
            let result = vault
                .family_apply(
                    &MutationRequest {
                        operation_id: OperationId::new("noop-create").unwrap(),
                        mutation: Mutation::Create {
                            id: id.clone(),
                            path: path.clone(),
                            kind: EntryKind::File,
                            content: Some(ORIGINAL.to_vec()),
                        },
                    },
                    Some(FamilyCreateMode::Text),
                )
                .unwrap();
            assert!(matches!(result.projection, ProjectionStatus::Projected));
            let sql = Connection::open(root.path().join(".zorid/vault.sqlite")).unwrap();
            Self {
                root,
                vault,
                sql,
                id,
                path,
            }
        }
        fn observe(&mut self) -> Result<Option<CommitResult>> {
            let _guard = self.vault.paths.lock(self.vault.options.lock_timeout)?;
            let (parent, name) = self.vault.paths.parent(&self.path)?;
            let snapshot = content_stream::file_snapshot(&parent, &name)?.unwrap();
            self.vault.observe_streamed_file(
                &self.path,
                &parent,
                &snapshot,
                &OperationId::new("noop-observe")?,
            )
        }
        fn history(&self) -> Vec<Vec<String>> {
            ["SELECT json_array(id,path,deleted,state,hex(content),visible,content_ref,content_digest) FROM entries ORDER BY id",
             "SELECT record FROM projection_baselines ORDER BY entry_id",
             "SELECT record FROM physical_bindings ORDER BY entry_id",
             "SELECT json_array(realm_id,vault_id,update_id,metadata,accepted) FROM authored_envelopes ORDER BY update_id",
             "SELECT json_array(realm_id,vault_id,update_id,record) FROM family_text_activities ORDER BY update_id",
             "SELECT json_array(entry_id,realm_id,vault_id,bootstrap_id,revision) FROM text_bindings ORDER BY entry_id",
             "SELECT json_array(entry_id,revision,record) FROM text_revisions ORDER BY entry_id,revision",
             "SELECT record FROM external_observations ORDER BY observation_id",
             "SELECT json_array(cursor,record) FROM local_changes ORDER BY cursor",
             "SELECT json_array(job_id,entry_id,completed,record) FROM projection_jobs ORDER BY ordinal",
             "SELECT json_array(realm_id,vault_id,revision,record_count,activity_count) FROM family_graph_heads ORDER BY realm_id,vault_id",
             "SELECT record FROM family_materialization_history ORDER BY entry_id,revision",
             "SELECT json_array(realm_id,vault_id,update_id,family,payload_digest,hex(payload)) FROM immutable_payloads ORDER BY realm_id,vault_id,update_id"]
                .into_iter().map(|query| self.sql.prepare(query).unwrap().query_map([], |row| row.get(0)).unwrap().collect::<rusqlite::Result<Vec<String>>>().unwrap()).collect()
        }
    }
    #[test]
    fn exact_noop_does_not_query_retained_text_or_change_history() {
        let mut fixture = Fixture::new();
        let (text, calibration) = measured(|| fixture.vault.store.family_text_state(&fixture.id));
        assert!(text.unwrap().is_some());
        assert!(
            calibration[0] > 0 && calibration[1] > 0,
            "actual native connection was not traced: {calibration:?}"
        );
        let history = fixture.history();
        for _ in 0..3 {
            let (result, reads) = measured(|| fixture.observe());
            assert!(result.unwrap().is_none());
            assert_eq!(
                reads,
                [0, 0],
                "exact physical no-op queried retained Text state"
            );
            assert_eq!(fixture.history(), history);
            assert_eq!(
                std::fs::read(fixture.root.path().join("note.md")).unwrap(),
                ORIGINAL
            );
        }
    }
    #[test]
    fn changed_text_still_queries_imports_once_and_echo_is_noop() {
        let mut fixture = Fixture::new();
        std::fs::write(fixture.root.path().join("note.md"), CHANGED).unwrap();
        let (result, reads) = measured(|| fixture.observe());
        assert!(result.unwrap().is_some());
        assert!(reads[0] > 0 && reads[1] > 0);
        let text = fixture
            .vault
            .store
            .family_text_state(&fixture.id)
            .unwrap()
            .unwrap();
        assert_eq!(text.complete_materialized_utf8().unwrap().unwrap(), CHANGED);
        let history = fixture.history();
        let (echo, reads) = measured(|| fixture.observe());
        assert!(echo.unwrap().is_none());
        assert_eq!(reads, [0, 0]);
        assert_eq!(fixture.history(), history);
        assert_eq!(
            std::fs::read(fixture.root.path().join("note.md")).unwrap(),
            CHANGED
        );
    }
    #[test]
    fn retained_text_corruption_still_rejects_direct_and_changed_admission_without_writes() {
        for corruption in [
            "DELETE FROM text_bindings",
            "UPDATE text_bindings SET bootstrap_id='foreign-bootstrap'",
            "UPDATE text_bindings SET revision='missing-revision'",
            "UPDATE text_revisions SET record=json_set(record,'$.version','different-revision')",
            "UPDATE text_revisions SET record=json_set(record,'$.snapshot',json('[0]'))",
            "UPDATE text_revisions SET record='{'",
            "UPDATE authority_identity SET realm_id='foreign-realm'",
        ] {
            let mut fixture = Fixture::new();
            fixture.sql.execute(corruption, []).unwrap();
            std::fs::write(fixture.root.path().join("note.md"), CHANGED).unwrap();
            let history = fixture.history();
            assert!(
                fixture.vault.store.family_text_state(&fixture.id).is_err(),
                "{corruption}"
            );
            assert_eq!(fixture.history(), history);
            assert!(fixture.observe().is_err(), "{corruption}");
            assert_eq!(fixture.history(), history);
            assert_eq!(
                std::fs::read(fixture.root.path().join("note.md")).unwrap(),
                CHANGED
            );
        }
    }
    #[test]
    fn selected_noop_metadata_baseline_and_binding_corruption_still_reject_without_writes() {
        for corruption in [
            "UPDATE entries SET content_digest=NULL WHERE id='noop-entry'",
            "UPDATE projection_baselines SET record='{' WHERE entry_id='noop-entry'",
            "UPDATE physical_bindings SET parent_inode='wrong-parent' WHERE entry_id='noop-entry'",
        ] {
            let mut fixture = Fixture::new();
            fixture.sql.execute(corruption, []).unwrap();
            let history = fixture.history();
            assert!(fixture.observe().is_err(), "{corruption}");
            assert_eq!(fixture.history(), history);
            assert_eq!(
                std::fs::read(fixture.root.path().join("note.md")).unwrap(),
                ORIGINAL
            );
        }
    }
    #[test]
    fn equal_bytes_on_a_replacement_inode_still_probe_mode_and_retain_original_authority() {
        let mut fixture = Fixture::new();
        let baseline = fixture
            .vault
            .store
            .projection_baseline(&fixture.id)
            .unwrap()
            .unwrap();
        let binding = fixture
            .vault
            .store
            .physical_binding(&fixture.id)
            .unwrap()
            .unwrap();
        std::fs::rename(
            fixture.root.path().join("note.md"),
            fixture.root.path().join("original-inode.md"),
        )
        .unwrap();
        std::fs::write(fixture.root.path().join("note.md"), ORIGINAL).unwrap();
        let (result, reads) = measured(|| fixture.observe());
        assert!(result.is_err());
        assert!(reads[0] > 0 && reads[1] > 0);
        assert_eq!(
            fixture
                .vault
                .store
                .projection_baseline(&fixture.id)
                .unwrap()
                .unwrap(),
            baseline
        );
        assert_eq!(
            fixture
                .vault
                .store
                .physical_binding(&fixture.id)
                .unwrap()
                .unwrap(),
            binding
        );
        assert_eq!(
            std::fs::read(fixture.root.path().join("note.md")).unwrap(),
            ORIGINAL
        );
        assert_eq!(
            std::fs::read(fixture.root.path().join("original-inode.md")).unwrap(),
            ORIGINAL
        );
    }
}
