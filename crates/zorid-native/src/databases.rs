//! Local collection service and guarded readable projections. No enrollment or
//! network side effects; all authority remains in the existing vault Store.
use super::*;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use zorid_store::{
    DatabaseProjection, DatabaseProjectionKind, DatabaseSchemaProjection, DatabaseSnapshot,
};
#[path = "database_external.rs"]
mod external;
#[path = "database_schema_projection.rs"]
mod schema;
#[path = "database_source.rs"]
mod source;
#[cfg(test)]
#[path = "databases_tests.rs"]
mod tests;

fn invalid(reason: impl Into<String>) -> Error {
    Error::Contract(zorid_core::ContractError::InvalidMutation {
        reason: reason.into(),
    })
}
fn core_request(command: Value) -> Result<zorid_store::DatabaseRequest> {
    serde_json::from_value(command).map_err(|_| invalid("Invalid local collection request"))
}
fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 15) as usize] as char);
    }
    output
}
fn empty_snapshot() -> DatabaseSnapshot {
    DatabaseSnapshot {
        collections: vec![],
        entries: vec![],
    }
}
fn publication_message(error: &Error, schema: bool) -> String {
    match error {
        Error::Busy(_) | Error::ConditionalSource(_) => "The saved file changed outside Zorid. Its content and your collection change are retained; reconcile the file and retry publication.",
        Error::UnsafePath(_) => "Publication is blocked by a changed or unsafe file path. The existing file was preserved.",
        Error::Unsupported(_) if !schema => "This entry has unsupported or invalid frontmatter. Its source is preserved; repair it and retry publication.",
        Error::Contract(_) | Error::Store(zorid_store::StoreError::Contract(_)) if !schema => "This entry has invalid or conflicting properties. Its source and saved collection change are retained for repair.",
        _ if schema => "The collection definition could not be published. Its saved change is retained; retry publication.",
        _ => "This entry could not be published. Its saved collection change is retained; retry publication.",
    }.into()
}
fn operation(stage: &str, id: &str, revision: &str, content: &[u8]) -> Result<OperationId> {
    let mut hash = Sha256::new();
    for bytes in [
        stage.as_bytes(),
        id.as_bytes(),
        revision.as_bytes(),
        content,
    ] {
        hash.update((bytes.len() as u64).to_be_bytes());
        hash.update(bytes);
    }
    Ok(OperationId::new(format!(
        "database-{}",
        hex(hash.finalize().as_slice())
    ))?)
}

#[derive(Deserialize)]
#[serde(
    tag = "op",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Maintenance {
    Retry,
    Compose {
        entry_id: EntryId,
        expected_revision: Revision,
        baseline: String,
        proposed: String,
    },
}

impl NativeVault {
    /// Cooperating CLI and desktop clients share the same native lock and
    /// transactional authority. Local durability precedes projection outcomes.
    pub fn database_request(&mut self, request: &DatabaseRequest) -> Result<DatabaseReply> {
        if request.schema_version != DATABASE_SCHEMA_VERSION {
            return Err(invalid("Unsupported local collection protocol version"));
        }
        if serde_json::to_vec(request)
            .map_err(|_| invalid("Invalid collection request"))?
            .len()
            > MAX_DATABASE_REQUEST_BYTES
        {
            return Err(invalid("Collection request exceeds byte limit"));
        }
        let _lock = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        if matches!(request.operation(), Some("retry" | "compose")) {
            let maintenance: Maintenance = serde_json::from_value(request.command.clone())
                .map_err(|_| invalid("Invalid collection maintenance request"))?;
            match maintenance {
                Maintenance::Retry => {
                    let projection = self
                        .database_recover_locked()
                        .map_err(|error| Error::DatabaseCommitted(Box::new(error)))?;
                    let snapshot = self
                        .store
                        .database_request(&core_request(json!({"op":"list"}))?)
                        .map_err(|error| Error::DatabaseCommitted(Box::new(error.into())))?;
                    return Ok(DatabaseReply {
                        snapshot,
                        projection,
                        composition: None,
                    });
                }
                Maintenance::Compose {
                    entry_id,
                    expected_revision,
                    baseline,
                    proposed,
                } => {
                    return self.database_compose_locked(
                        &entry_id,
                        &expected_revision,
                        &baseline,
                        &proposed,
                    );
                }
            }
        }
        let command = core_request(request.command.clone())?;
        let snapshot = self.store.database_request(&command)?;
        (|| -> Result<DatabaseReply> {
            #[cfg(test)]
            if let Some(fault) = self.database_after_commit_error {
                return Err(fault());
            }
            self.point("database_logical_committed");
            let mut projection = self.database_recover_locked()?;
            if matches!(request.operation(), Some("list" | "get" | "get_entry")) {
                let entries = if request.operation() == Some("list") {
                    self.store.database_query_state()?.entries
                } else {
                    snapshot.entries.clone()
                };
                self.database_reconcile_visible_locked(&entries, &mut projection)?;
                projection.pending = self.store.database_pending_projection_count()?;
            }
            // Exact mutation retries still return their original logical receipt,
            // while the refreshed scoped snapshot reports actual file publication.
            let refreshed = if matches!(request.operation(), Some("list" | "get_entry")) {
                self.store.database_request(&command)?
            } else if snapshot.collections.len() == 1 {
                self.store.database_request(&core_request(
                    json!({"op":"get","collectionId":snapshot.collections[0].id}),
                )?)?
            } else {
                self.store
                    .database_request(&core_request(json!({"op":"list"}))?)?
            };
            Ok(DatabaseReply {
                snapshot: refreshed,
                projection,
                composition: None,
            })
        })()
        .map_err(|error| Error::DatabaseCommitted(Box::new(error)))
    }

    fn database_compose_locked(
        &mut self,
        id: &EntryId,
        _expected: &Revision,
        baseline: &str,
        proposed: &str,
    ) -> Result<DatabaseReply> {
        if baseline.len() > self.options.max_file_bytes
            || proposed.len() > self.options.max_file_bytes
        {
            return Err(invalid(
                "Collection note exceeds the configured source limit",
            ));
        }
        let Some(projection) = self.store.database_entry_projection(id)? else {
            // Ordinary notes use exactly the same path without manufactured
            // membership or schema. Their existing save CAS remains unchanged.
            return Ok(DatabaseReply {
                snapshot: empty_snapshot(),
                projection: DatabaseProjectionReport::default(),
                composition: None,
            });
        };
        if projection.kind == DatabaseProjectionKind::Trash {
            return Err(invalid(
                "This collection was deleted; restore it before saving its entry",
            ));
        }
        let entry = self
            .store
            .read(id)?
            .ok_or_else(|| invalid("Saved collection entry is unavailable"))?;
        let current = String::from_utf8(
            entry
                .content
                .ok_or_else(|| invalid("Collection entry has no text content"))?,
        )
        .map_err(|_| invalid("Collection entry is not UTF-8"))?;
        let baseline_values = source::properties(baseline)?;
        let proposed_values = source::properties(proposed)?;
        let owned = projection
            .properties
            .keys()
            .chain(projection.previous_properties.keys())
            .chain(projection.previous_keys.iter())
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        if owned
            .iter()
            .any(|key| baseline_values.get(key) != proposed_values.get(key))
        {
            return Err(invalid("Collection properties changed in the note source. Use the collection property controls, or keep this draft for repair"));
        }
        let baseline_owned: BTreeMap<_, _> = baseline_values
            .into_iter()
            .filter(|(key, _)| owned.contains(key))
            .collect();
        let current_owned: BTreeMap<_, _> = source::properties(&current)?
            .into_iter()
            .filter(|(key, _)| owned.contains(key))
            .collect();
        let canonical_baseline = source::compose(
            baseline,
            &projection.properties,
            &baseline_owned,
            &projection.previous_keys,
        )?;
        let canonical_current = source::compose(
            &current,
            &projection.properties,
            &current_owned,
            &projection.previous_keys,
        )?;
        if canonical_baseline != canonical_current {
            return Err(invalid("The saved note body or unrelated frontmatter changed. Keep the draft and reopen the current note before saving"));
        }
        let content = source::compose(
            proposed,
            &projection.properties,
            &baseline_owned,
            &projection.previous_keys,
        )?;
        Ok(DatabaseReply {
            snapshot: empty_snapshot(),
            projection: DatabaseProjectionReport::default(),
            composition: Some(DatabaseComposition {
                content,
                current_source: current,
                current_file_revision: entry.state.revision.as_str().into(),
                entry_revision: projection.entry_revision,
                collection_revision: projection.collection_revision,
            }),
        })
    }

    fn database_recover_locked(&mut self) -> Result<DatabaseProjectionReport> {
        let mut report = DatabaseProjectionReport::default();
        let mut schema_after: Option<String> = None;
        // Pages may be short due to their byte budget. Continue by the last
        // identity even when all earlier work is blocked; never revisit a failed
        // prefix or infer end-of-work from a short page.
        for _ in 0..256 {
            let batch = self
                .store
                .database_pending_schema_projections_after(schema_after.as_deref(), 256)?;
            if batch.is_empty() {
                break;
            }
            schema_after = batch
                .last()
                .map(|projection| projection.collection_id.clone());
            for projection in batch {
                if let Err(error) = self.database_publish_schema_locked(&projection) {
                    report.issues.push(DatabaseProjectionIssue {
                        entry_id: None,
                        message: publication_message(&error, true),
                    });
                }
            }
        }
        let mut entry_after: Option<EntryId> = None;
        for _ in 0..4096 {
            let batch = self
                .store
                .database_pending_projections_after(entry_after.as_ref(), 256)?;
            if batch.is_empty() {
                break;
            }
            entry_after = batch.last().map(|projection| projection.entry_id.clone());
            for projection in batch {
                if let Err(error) = self.database_publish_entry_locked(&projection) {
                    report.issues.push(DatabaseProjectionIssue {
                        entry_id: Some(projection.entry_id.clone()),
                        message: publication_message(&error, false),
                    });
                }
            }
        }
        report.pending = self.store.database_pending_projection_count()?;
        Ok(report)
    }

    fn database_reconcile_visible_locked(
        &mut self,
        entries: &[zorid_store::DatabaseEntry],
        report: &mut DatabaseProjectionReport,
    ) -> Result<()> {
        for entry in entries
            .iter()
            .filter(|entry| !entry.deleted && !entry.pending_projection)
            .take(4096)
        {
            let Some(stored) = self.store.read(&entry.entry_id)? else {
                continue;
            };
            let (parent, name) = self.paths.parent(&stored.state.path)?;
            let Some(disk) = fs::snapshot(&parent, &name, self.options.max_file_bytes)? else {
                // An acknowledged file disappearing is an external namespace
                // event, not authority to recreate it during a collection read.
                continue;
            };
            if stored.content.as_deref() == Some(disk.bytes.as_slice()) {
                continue;
            }
            let Some(projection) = self.store.database_entry_projection(&entry.entry_id)? else {
                continue;
            };
            if let Err(error) = self.database_publish_entry_locked(&projection) {
                report.issues.push(DatabaseProjectionIssue {
                    entry_id: Some(entry.entry_id.clone()),
                    message: publication_message(&error, false),
                });
            }
        }
        Ok(())
    }

    fn database_publish_entry_locked(&mut self, projection: &DatabaseProjection) -> Result<()> {
        self.paths.verify()?;
        let stored = self
            .store
            .read(&projection.entry_id)?
            .ok_or_else(|| invalid("Collection entry is missing"))?;
        match projection.kind {
            DatabaseProjectionKind::Properties => {
                let current = String::from_utf8(
                    stored
                        .content
                        .ok_or_else(|| invalid("Collection entry has no text content"))?,
                )
                .map_err(|_| invalid("Collection entry is not UTF-8"))?;
                // Interpret physical edits against the retained ACK baseline
                // before importing a raw observation. A pure field-ID patch is
                // durably recorded first, then the existing observation import
                // preserves the exact body and unrelated frontmatter. Store's
                // proven-observation guard permits old generated baseline values
                // but never grants a general authored-write bypass.
                let (parent, name) = self.paths.parent(&stored.state.path)?;
                if let Some(disk) = fs::snapshot(&parent, &name, self.options.max_file_bytes)? {
                    self.paths.verify_parent(&stored.state.path, &parent)?;
                    let actual = std::str::from_utf8(&disk.bytes).map_err(|_| {
                        invalid("External collection entry is not UTF-8; source preserved")
                    })?;
                    let snapshot = self.store.database_request(&core_request(
                        json!({"op":"get","collectionId":projection.collection_id}),
                    )?)?;
                    let collection = snapshot.collections.first().ok_or_else(|| {
                        invalid("Collection is unavailable during external reconciliation")
                    })?;
                    let patch = external::reconcile(collection, projection, actual)?;
                    if !patch.is_empty() {
                        let command = core_request(json!({"op":"set_entry",
                            "operationId":operation("external", projection.entry_id.as_str(), &projection.entry_revision, &disk.bytes)?,
                            "entryId":projection.entry_id,"expectedRevision":projection.entry_revision,
                            "expectedCollectionRevision":projection.collection_revision,"values":patch}))?;
                        // Revalidate the complete observed source immediately
                        // before authoring the hidden-value change. Later
                        // filesystem changes remain protected by normal import.
                        let latest = fs::snapshot(&parent, &name, self.options.max_file_bytes)?
                            .ok_or(Error::Busy("External collection file disappeared"))?;
                        if latest.identity != disk.identity || latest.bytes != disk.bytes {
                            return Err(Error::Busy(
                                "External collection file changed during reconciliation",
                            ));
                        }
                        self.store.database_request(&command)?;
                        let latest = self
                            .store
                            .database_entry_projection(&projection.entry_id)?
                            .ok_or_else(|| invalid("Collection projection disappeared"))?;
                        return self.database_publish_entry_locked(&latest);
                    }
                }
                let _ = self.observe(&stored.state.path)?;
                let refreshed = self
                    .store
                    .read(&projection.entry_id)?
                    .ok_or_else(|| invalid("Collection entry is missing"))?;
                let current = if refreshed.state.revision != stored.state.revision {
                    String::from_utf8(
                        refreshed
                            .content
                            .clone()
                            .ok_or_else(|| invalid("Collection entry has no text content"))?,
                    )
                    .map_err(|_| invalid("Collection entry is not UTF-8"))?
                } else {
                    current
                };
                let mut previous = projection.previous_properties.clone();
                // `_type` is a readable label, never a membership command. Its
                // mismatched external text is reconciled to the owning name.
                if let Some(value) = source::properties(&current)?.get("_type") {
                    previous.insert("_type".into(), value.clone());
                }
                let composed = source::compose(
                    &current,
                    &projection.properties,
                    &previous,
                    &projection.previous_keys,
                )?;
                if composed != current {
                    let request = MutationRequest {
                        operation_id: operation(
                            "properties",
                            projection.entry_id.as_str(),
                            &format!(
                                "{}:{}",
                                projection.entry_revision,
                                refreshed.state.revision.as_str()
                            ),
                            composed.as_bytes(),
                        )?,
                        mutation: Mutation::Write {
                            id: projection.entry_id.clone(),
                            expected: refreshed.state.revision,
                            content: composed.into_bytes(),
                        },
                    };
                    let outcome = self.apply_locked(&request)?;
                    if let ProjectionStatus::Pending(_) = outcome.projection {
                        return Err(Error::Busy("Collection note publication is pending"));
                    }
                } else {
                    self.project(&projection.entry_id)?;
                }
            }
            DatabaseProjectionKind::Trash => {
                if !stored.state.path.as_str().starts_with(".trash/") {
                    let parent = format!(".trash/collections/{}", projection.collection_id);
                    self.database_ensure_folders_locked(&parent)?;
                    let path = VaultPath::new(format!(
                        "{parent}/entry-{}.md",
                        hex(Sha256::digest(projection.entry_id.as_str().as_bytes()).as_slice())
                    ))?;
                    let request = MutationRequest {
                        operation_id: operation(
                            "trash",
                            projection.entry_id.as_str(),
                            &projection.entry_revision,
                            path.as_str().as_bytes(),
                        )?,
                        mutation: Mutation::Move {
                            id: projection.entry_id.clone(),
                            expected: stored.state.revision,
                            path,
                        },
                    };
                    if matches!(
                        self.apply_locked(&request)?.projection,
                        ProjectionStatus::Pending(_)
                    ) {
                        return Err(Error::Busy("Collection entry move to Trash is pending"));
                    }
                }
                // A prior logical Move can be committed while its physical
                // namespace publication is still pending. Reopen/retry must
                // prove the file actually reached Trash before acknowledging.
                let _ = self.recover_locked();
                self.project(&projection.entry_id)?;
            }
            DatabaseProjectionKind::Restore => {
                if stored.state.path.as_str().starts_with(".trash/") {
                    let path = self.database_restore_path(&projection.original_path)?;
                    if let Some((parent, _)) = path.as_str().rsplit_once('/') {
                        self.database_ensure_folders_locked(parent)?;
                    }
                    let request = MutationRequest {
                        operation_id: operation(
                            "restore",
                            projection.entry_id.as_str(),
                            &projection.entry_revision,
                            path.as_str().as_bytes(),
                        )?,
                        mutation: Mutation::Move {
                            id: projection.entry_id.clone(),
                            expected: stored.state.revision,
                            path,
                        },
                    };
                    if matches!(
                        self.apply_locked(&request)?.projection,
                        ProjectionStatus::Pending(_)
                    ) {
                        return Err(Error::Busy("Collection entry restore is pending"));
                    }
                }
                let _ = self.recover_locked();
                // A delete may have superseded an unpublished property change.
                // Moving the old file out of Trash alone cannot acknowledge its
                // current authoritative values.
                let mut properties = projection.clone();
                properties.kind = DatabaseProjectionKind::Properties;
                return self.database_publish_entry_locked(&properties);
            }
        }
        self.point("database_file_projected");
        self.store.database_projection_ack(
            &projection.entry_id,
            &projection.entry_revision,
            &projection.collection_revision,
        )?;
        Ok(())
    }

    fn database_ensure_folders_locked(&mut self, path: &str) -> Result<()> {
        let mut current = String::new();
        for part in path.split('/') {
            if !current.is_empty() {
                current.push('/');
            }
            current.push_str(part);
            let path = VaultPath::new(current.clone())?;
            if let Some(entry) = self.store.read_path_metadata(&path)? {
                if entry.state.kind != EntryKind::Folder {
                    return Err(invalid("Collection recovery folder is occupied by a file"));
                }
                continue;
            }
            let request = MutationRequest {
                operation_id: new_op(),
                mutation: Mutation::Create {
                    id: new_id(),
                    path,
                    kind: EntryKind::Folder,
                    content: None,
                },
            };
            if matches!(
                self.apply_locked(&request)?.projection,
                ProjectionStatus::Pending(_)
            ) {
                return Err(Error::Busy(
                    "Collection recovery folder publication is pending",
                ));
            }
        }
        Ok(())
    }

    fn database_restore_path(&self, original: &str) -> Result<VaultPath> {
        let available = |candidate: &str| -> Result<bool> {
            let path = VaultPath::new(candidate.to_owned())?;
            if self.store.read_path_metadata(&path)?.is_some() {
                return Ok(false);
            }
            match self.paths.parent(&path) {
                Ok((parent, name)) => Ok(fs::node_type(&parent, &name)?.is_none()),
                Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
                Err(error) => Err(error),
            }
        };
        if available(original)? {
            return Ok(VaultPath::new(original)?);
        }
        let (stem, extension) = original
            .rsplit_once('.')
            .map_or((original, ""), |(stem, extension)| (stem, extension));
        for suffix in 2..=10_000 {
            let candidate = if extension.is_empty() {
                format!("{stem} (restored {suffix})")
            } else {
                format!("{stem} (restored {suffix}).{extension}")
            };
            if available(&candidate)? {
                return Ok(VaultPath::new(candidate)?);
            }
        }
        Err(invalid("No available filename for collection restore"))
    }
}
