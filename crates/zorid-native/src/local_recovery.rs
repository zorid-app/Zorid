//! App-local history is optional for embedders and never participates in sync.
use super::*;
use zorid_recovery::{RecoveryScope, RecoveryStore, SnapshotInput, SnapshotProvenance};

pub(super) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

impl NativeVault {
    /// The host supplies an app-owned path outside the vault. Tests and native
    /// shells can inject their private data directory without global environment.
    pub fn enable_local_recovery(&mut self, path: impl AsRef<Path>, now_ms: i64) -> Result<()> {
        self.paths.verify()?;
        let path = path.as_ref();
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
        self.recovery = Some(RecoveryStore::open(parent.join(name), &scope, now_ms)?);
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
        let Some(entry) = self.store.read(id)? else {
            return Ok(());
        };
        let Some(content) = entry.content else {
            return Ok(());
        };
        if let Some(recovery) = &mut self.recovery {
            recovery.capture(
                SnapshotInput {
                    entry_id: id.as_str(),
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
}
