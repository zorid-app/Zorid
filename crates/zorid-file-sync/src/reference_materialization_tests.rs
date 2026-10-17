use super::*;
use crate::binary_stream::{verify_complete_binary_manifests, ChunkSource};
use crate::metadata::GraphRecord;
use crate::{ChunkPage, ChunkRef, Family, Location, Manifest, Scope};
use zorid_client_sync::{ActorOwner, ActorRegistration, AuthorRequest, Edit, TextIdentity};
use zorid_core::{OperationId, Revision};
use zorid_sync_protocol::{DeviceId, RealmId, VaultId};

fn id(value: &str) -> UpdateId {
    UpdateId::new(value).unwrap()
}
fn entry(value: &str) -> EntryId {
    EntryId::new(value).unwrap()
}
fn revision(value: &str) -> Revision {
    Revision::new(value).unwrap()
}
fn scope() -> Scope {
    Scope {
        realm_id: RealmId::new("realm").unwrap(),
        vault_id: VaultId::new("vault").unwrap(),
    }
}
fn identity(name: &str) -> EntryIdentity {
    EntryIdentity {
        entry_id: entry(name),
        bootstrap_id: id(&format!("create-{name}")),
    }
}
fn location(name: &str) -> Location {
    Location {
        parent: None,
        name: name.into(),
    }
}
fn payload(name: &str, body: v2::Body) -> v2::Payload {
    v2::Payload {
        family: Family::Files,
        format_version: v2::FORMAT_VERSION,
        scope: scope(),
        id: id(name),
        body,
    }
}
fn event(name: &str, update: &str, parents: &[&str], effect: v2::Effect) -> v2::Payload {
    payload(
        update,
        v2::Body::Events {
            events: vec![v2::EntryEvent {
                id: id(update),
                identity: identity(name),
                parents: parents.iter().map(|parent| id(parent)).collect(),
                effect,
            }],
        },
    )
}
fn create(name: &str, kind: EntryKind, content: Option<v2::ContentSeed>) -> v2::Payload {
    event(
        name,
        &format!("create-{name}"),
        &[],
        v2::Effect::Create {
            entry_kind: kind,
            location: location(name),
            content,
        },
    )
}
fn binary_create(name: &str, manifest: Manifest) -> v2::Payload {
    create(
        name,
        EntryKind::File,
        Some(v2::ContentSeed::Binary { manifest }),
    )
}
fn text_create(name: &str) -> v2::Payload {
    create(
        name,
        EntryKind::File,
        Some(v2::ContentSeed::Text {
            text_bootstrap_id: id(&format!("text-{name}")),
            text_format: zorid_client_sync::v2::TEXT_FORMAT_VERSION,
        }),
    )
}
fn text(name: &str, contents: &str) -> TextState {
    let empty = TextState::empty(
        TextIdentity {
            realm_id: scope().realm_id,
            vault_id: scope().vault_id,
            entry_id: entry(name),
            bootstrap_id: id(&format!("text-{name}")),
        },
        revision("empty"),
    );
    if contents.is_empty() {
        return empty;
    }
    zorid_client_sync::plan_authored_text(
        &empty,
        &AuthorRequest {
            expected_version: empty.version.clone(),
            next_version: revision("text"),
            update_id: id("text-update"),
            actor: ActorRegistration {
                actor: 7,
                owner: ActorOwner {
                    replica_id: DeviceId::new("device").unwrap(),
                    incarnation_id: OperationId::new("incarnation").unwrap(),
                },
            },
            edits: vec![Edit::Insert {
                index: 0,
                text: contents.into(),
            }],
        },
    )
    .unwrap()
    .next_state
}
fn binary(tag: &str, bytes: &[u8]) -> (Manifest, Vec<v2::Payload>) {
    if bytes.is_empty() {
        return (
            Manifest {
                bytes: 0,
                digest: Sha256Digest::of(&[]),
                pages: vec![],
            },
            vec![],
        );
    }
    let page = ChunkPage {
        chunks: vec![ChunkRef {
            id: id(&format!("chunk-{tag}")),
            bytes: bytes.len() as u32,
            digest: Sha256Digest::of(bytes),
        }],
    };
    let page_id = id(&format!("page-{tag}"));
    let manifest = Manifest {
        bytes: bytes.len() as u64,
        digest: Sha256Digest::of(bytes),
        pages: vec![page.reference(page_id).unwrap()],
    };
    (
        manifest,
        vec![
            payload(
                &format!("chunk-{tag}"),
                v2::Body::Chunk {
                    bytes: bytes.to_vec(),
                },
            ),
            payload(&format!("page-{tag}"), v2::Body::Page { page }),
        ],
    )
}

#[derive(Default)]
struct Source(BTreeMap<UpdateId, Vec<u8>>);
impl ChunkSource for Source {
    fn read_chunk(
        &mut self,
        actual_scope: &Scope,
        chunk: &UpdateId,
        _expected: &GraphRecord,
    ) -> Result<Vec<u8>> {
        assert_eq!(actual_scope, &scope());
        self.0.get(chunk).cloned().ok_or(Error::InvalidState)
    }
}
fn state(records: &[v2::Payload]) -> (MetadataState, Source) {
    let mut source = Source::default();
    let records = records
        .iter()
        .map(|payload| {
            if let v2::Body::Chunk { bytes } = &payload.body {
                source.0.insert(payload.id.clone(), bytes.clone());
            }
            let (_, id, record) =
                GraphRecord::from_authored_exact(&payload.encode().unwrap()).unwrap();
            (id, record)
        })
        .collect();
    (
        MetadataState::from_records(scope(), revision("graph"), records, BTreeMap::new()).unwrap(),
        source,
    )
}
fn classify(records: &[v2::Payload], texts: &[TextState]) -> Vec<EntryMaterializationRef> {
    let (state, mut source) = state(records);
    let verified = verify_complete_binary_manifests(&state, &mut source).unwrap();
    classify_metadata(
        &state,
        &verified,
        texts,
        MAX_FILE_BYTES,
        MAX_STATE_BYTES as u64,
    )
    .unwrap()
}
fn outcome<'a>(results: &'a [EntryMaterializationRef], name: &str) -> &'a OutcomeRef {
    &results
        .iter()
        .find(|result| result.identity.entry_id == entry(name))
        .unwrap()
        .outcome
}

#[test]
fn complete_binary_returns_causal_reference_with_no_text_budget() {
    let (manifest, mut records) = binary("shared", &vec![7; crate::MAX_CHUNK_BYTES]);
    records.push(binary_create("first", manifest.clone()));
    records.push(binary_create("second", manifest.clone()));
    let (state, mut source) = state(&records);
    let verified = verify_complete_binary_manifests(&state, &mut source).unwrap();
    let output = classify_metadata(&state, &verified, &[], MAX_FILE_BYTES, 0).unwrap();
    assert_eq!(output.len(), 2);
    for name in ["first", "second"] {
        let OutcomeRef::Normal {
            content: Some(ContentRef::Binary(content)),
            ..
        } = outcome(&output, name)
        else {
            panic!("complete binary must have a reference");
        };
        assert_eq!(content.entry(), &identity(name));
        assert_eq!(content.selected_event(), &identity(name).bootstrap_id);
        assert_eq!(content.manifest(), &manifest);
    }
}

#[test]
fn stale_binary_set_fails_before_any_classification_including_hidden_outputs() {
    let (state, mut source) = state(&[text_create("note")]);
    let verified = verify_complete_binary_manifests(&state, &mut source).unwrap();
    let changed = MetadataState::from_records(
        scope(),
        revision("changed"),
        state.records().clone(),
        state.activities().clone(),
    )
    .unwrap();
    assert_eq!(
        classify_metadata(&changed, &verified, &[], MAX_FILE_BYTES, 0),
        Err(Error::VersionConflict)
    );
}

#[test]
fn preferred_incomplete_binary_never_falls_back_to_verified_alternative() {
    let (first, mut records) = binary("first", b"first");
    let (last, last_parts) = binary("last", b"last");
    records.push(binary_create("attachment", first.clone()));
    records.push(event(
        "attachment",
        "write-a",
        &["create-attachment"],
        v2::Effect::SetContent { content: first },
    ));
    records.push(event(
        "attachment",
        "write-z",
        &["create-attachment"],
        v2::Effect::SetContent { content: last },
    ));
    records.push(last_parts[1].clone());
    assert_eq!(
        outcome(&classify(&records, &[]), "attachment"),
        &OutcomeRef::Pending {
            reason: PendingReason::BinaryDependencies {
                ids: BTreeSet::from([id("chunk-last")])
            }
        }
    );
    records.push(last_parts[0].clone());
    let output = classify(&records, &[]);
    assert!(matches!(
        outcome(&output, "attachment"),
        OutcomeRef::Normal { content: Some(ContentRef::Binary(content)), .. }
            if content.selected_event() == &id("write-z")
    ));
}

#[test]
fn equal_bytes_at_different_heads_keep_selected_causal_witness() {
    let (manifest, mut records) = binary("same", b"unchanged");
    records.push(binary_create("attachment", manifest.clone()));
    let before = classify(&records, &[]);
    records.push(event(
        "attachment",
        "new-head",
        &["create-attachment"],
        v2::Effect::SetContent { content: manifest },
    ));
    let after = classify(&records, &[]);
    let content = |output: &[EntryMaterializationRef]| {
        let OutcomeRef::Normal {
            content: Some(ContentRef::Binary(content)),
            ..
        } = outcome(output, "attachment")
        else {
            panic!("binary reference expected");
        };
        content.clone()
    };
    let before = content(&before);
    let after = content(&after);
    assert_eq!(before.manifest(), after.manifest());
    assert_ne!(before.selected_event(), after.selected_event());
    assert_ne!(before, after);
}

#[test]
fn text_budget_counts_exact_utf8_output_and_empty_text_needs_zero_bytes() {
    let (state, mut source) = state(&[
        text_create("a-empty"),
        text_create("b-first"),
        text_create("c-second"),
    ]);
    let verified = verify_complete_binary_manifests(&state, &mut source).unwrap();
    let texts = [
        text("a-empty", ""),
        text("b-first", "😀"),
        text("c-second", "é"),
    ];
    assert_eq!(
        classify_metadata(&state, &verified, &texts, MAX_FILE_BYTES, 5),
        Err(Error::TooLarge)
    );
    let output = classify_metadata(&state, &verified, &texts, MAX_FILE_BYTES, 6).unwrap();
    for (name, wanted) in [("a-empty", ""), ("b-first", "😀"), ("c-second", "é")] {
        assert!(matches!(
            outcome(&output, name),
            OutcomeRef::Normal { content: Some(ContentRef::Text(content)), .. }
                if content.bytes == wanted.as_bytes()
        ));
    }
    assert_eq!(
        outcome(
            &classify_metadata(&state, &verified, &texts, 3, 2).unwrap(),
            "b-first"
        ),
        &OutcomeRef::Pending {
            reason: PendingReason::FileLimitExceeded { bytes: 4, limit: 3 }
        }
    );
}

#[test]
fn empty_binary_empty_text_and_folder_are_distinct() {
    let (empty, _) = binary("empty", &[]);
    let output = classify(
        &[
            binary_create("binary", empty),
            text_create("text"),
            create("folder", EntryKind::Folder, None),
        ],
        &[text("text", "")],
    );
    assert!(matches!(
        outcome(&output, "binary"),
        OutcomeRef::Normal { content: Some(ContentRef::Binary(content)), .. }
            if content.manifest().bytes == 0
    ));
    assert!(matches!(
        outcome(&output, "text"),
        OutcomeRef::Normal { content: Some(ContentRef::Text(content)), .. }
            if content.bytes.is_empty()
    ));
    assert!(matches!(
        outcome(&output, "folder"),
        OutcomeRef::Normal {
            kind: EntryKind::Folder,
            content: None,
            ..
        }
    ));
}

#[test]
fn text_identity_is_checked_even_when_tombstoned_and_duplicates_fail_closed() {
    let (state, mut source) = state(&[
        text_create("note"),
        event("note", "delete", &["create-note"], v2::Effect::Delete),
    ]);
    let verified = verify_complete_binary_manifests(&state, &mut source).unwrap();
    let original = text("note", "");
    let mut changed = original.clone();
    changed.identity.bootstrap_id = id("wrong-text");
    assert_eq!(
        classify_metadata(&state, &verified, &[changed], MAX_FILE_BYTES, 0),
        Err(Error::IdentityMismatch)
    );
    assert_eq!(
        classify_metadata(
            &state,
            &verified,
            &[original.clone(), original.clone()],
            MAX_FILE_BYTES,
            0
        ),
        Err(Error::IdentityMismatch)
    );
    assert_eq!(
        outcome(
            &classify_metadata(&state, &verified, &[original], MAX_FILE_BYTES, 0).unwrap(),
            "note"
        ),
        &OutcomeRef::Tombstone
    );
}

#[test]
fn pending_parent_event_blocks_descendants_without_materializing_text() {
    let mut child = text_create("child");
    if let v2::Body::Events { events } = &mut child.body {
        if let v2::Effect::Create { location, .. } = &mut events[0].effect {
            location.parent = Some(entry("folder"));
        }
    }
    let records = [
        create("folder", EntryKind::Folder, None),
        child,
        event(
            "folder",
            "pending-move",
            &["missing-parent"],
            v2::Effect::Move {
                location: location("moved"),
            },
        ),
    ];
    let (state, mut source) = state(&records);
    let verified = verify_complete_binary_manifests(&state, &mut source).unwrap();
    let mut malformed = text("child", "");
    malformed.snapshot = vec![255];
    let output = classify_metadata(&state, &verified, &[malformed], MAX_FILE_BYTES, 0).unwrap();
    for name in ["folder", "child"] {
        assert_eq!(
            outcome(&output, name),
            &OutcomeRef::Pending {
                reason: PendingReason::CausalDependencies {
                    events: BTreeSet::from([id("pending-move")])
                }
            }
        );
    }
}

#[test]
fn prebootstrap_events_and_activity_retain_stable_pending_identities() {
    let note = text("note", "");
    // Trusted metadata fixture only; classification is not ingress authority.
    let activity: v2::StoredActivity = serde_json::from_value(serde_json::json!({
        "identity": note.identity,
        "update_id": "edit",
        "namespace": {"bootstrap_id": "create-note", "parents": ["create-note"]},
        "payload_digest": Sha256Digest::of(b"checked payload"),
        "payload_bytes": 15
    }))
    .unwrap();
    let (graph, mut source) = state(&[event(
        "absent",
        "move",
        &["create-absent"],
        v2::Effect::Move {
            location: location("guessed"),
        },
    )]);
    let graph = MetadataState::from_records(
        scope(),
        graph.version().clone(),
        graph.records().clone(),
        BTreeMap::from([(id("edit"), activity)]),
    )
    .unwrap();
    let verified = verify_complete_binary_manifests(&graph, &mut source).unwrap();
    let output = classify_metadata(&graph, &verified, &[note], MAX_FILE_BYTES, 0).unwrap();
    for name in ["note", "absent"] {
        let result = output
            .iter()
            .find(|result| result.identity.entry_id == entry(name))
            .unwrap();
        assert_eq!(result.identity, identity(name));
        assert_eq!(
            result.outcome,
            OutcomeRef::Pending {
                reason: PendingReason::MissingBootstrap
            }
        );
    }
}

#[test]
fn recovery_and_tombstone_never_expand_content_or_spend_text_budget() {
    let records = [
        text_create("note"),
        event("note", "delete", &["create-note"], v2::Effect::Delete),
        event(
            "note",
            "move",
            &["create-note"],
            v2::Effect::Move {
                location: location("moved"),
            },
        ),
    ];
    let (state, mut source) = state(&records);
    let verified = verify_complete_binary_manifests(&state, &mut source).unwrap();
    let mut malformed = text("note", "");
    malformed.snapshot = vec![255];
    let output = classify_metadata(&state, &verified, &[malformed], MAX_FILE_BYTES, 0).unwrap();
    assert_eq!(
        outcome(&output, "note"),
        &OutcomeRef::Recovery {
            reason: RecoveryReason::DeleteConflict
        }
    );
}

fn text_with_missing_predecessor() -> TextState {
    use zorid_client_sync::{AuthenticatedText, ReceiveRequest};
    use zorid_crypto::{CryptoError, EntropySource, VaultKey};
    use zorid_sync_protocol::{ExpectedContext, Header};
    struct Entropy;
    impl EntropySource for Entropy {
        fn fill(&mut self, output: &mut [u8]) -> std::result::Result<(), CryptoError> {
            output.fill(7);
            Ok(())
        }
    }
    let initial = text("note", "");
    let predecessor = text("note", "a");
    let second = zorid_client_sync::plan_authored_text(
        &predecessor,
        &AuthorRequest {
            expected_version: predecessor.version.clone(),
            next_version: revision("second"),
            update_id: id("second"),
            actor: ActorRegistration {
                actor: 7,
                owner: predecessor.actors[&7].clone(),
            },
            edits: vec![Edit::Insert {
                index: 1,
                text: "b".into(),
            }],
        },
    )
    .unwrap();
    let key = VaultKey::from_bytes([7; 32]);
    let header = Header::new(
        scope().realm_id,
        scope().vault_id,
        second.authored.update_id.clone(),
        DeviceId::new("device").unwrap(),
        1,
    )
    .unwrap();
    let wire = zorid_crypto::seal(&header, &second.authored.payload_bytes, &key, &mut Entropy)
        .unwrap()
        .encode();
    let incoming = AuthenticatedText::open(
        &wire,
        &ExpectedContext {
            realm_id: scope().realm_id,
            vault_id: scope().vault_id,
            update_id: second.authored.update_id.clone(),
            key_epoch: 1,
        },
        &key,
    )
    .unwrap();
    zorid_client_sync::plan_received_text(
        &initial,
        &ReceiveRequest {
            expected_version: initial.version.clone(),
            next_version: revision("pending"),
            delivery: None,
        },
        &incoming,
        None,
        None,
    )
    .unwrap()
    .next_state
    .unwrap()
}

#[test]
fn resolved_namespace_keeps_incomplete_crdt_text_pending() {
    let pending = text_with_missing_predecessor();
    let (state, mut source) = state(&[text_create("note")]);
    let verified = verify_complete_binary_manifests(&state, &mut source).unwrap();
    let output = classify_metadata(&state, &verified, &[pending], MAX_FILE_BYTES, 0).unwrap();
    assert_eq!(
        outcome(&output, "note"),
        &OutcomeRef::Pending {
            reason: PendingReason::TextDependencies
        }
    );
}

#[test]
fn recovery_hidden_binary_uses_current_causal_head_instead_of_cached_publication() {
    let (old, mut records) = binary("published", b"previously published");
    records.push(binary_create("attachment", old));
    let published = classify(&records, &[]);
    let OutcomeRef::Normal {
        content: Some(ContentRef::Binary(cached)),
        ..
    } = outcome(&published, "attachment")
    else {
        panic!("initial publication must be complete");
    };
    let (new, new_parts) = binary("remote", b"unique remote recovery content");
    records.extend(new_parts);
    records.push(event(
        "attachment",
        "remote-content",
        &["create-attachment"],
        v2::Effect::SetContent {
            content: new.clone(),
        },
    ));
    records.push(event(
        "attachment",
        "disk-delete",
        &["create-attachment"],
        v2::Effect::Delete,
    ));
    let (state, mut source) = state(&records);
    let verified = verify_complete_binary_manifests(&state, &mut source).unwrap();
    let classified = classify_metadata(&state, &verified, &[], MAX_FILE_BYTES, 0).unwrap();
    assert_eq!(
        outcome(&classified, "attachment"),
        &OutcomeRef::Recovery {
            reason: RecoveryReason::DeleteConflict
        }
    );
    let Some(ContentRef::Binary(recovered)) =
        recovery_content_ref(&state, &verified, &[], &entry("attachment"), MAX_FILE_BYTES).unwrap()
    else {
        panic!("hidden current binary must remain recoverable");
    };
    assert_eq!(recovered.selected_event(), &id("remote-content"));
    assert_eq!(recovered.manifest(), &new);
    assert_ne!(&recovered, cached);
}

#[test]
fn recovery_text_with_missing_dependencies_returns_none_instead_of_empty_bytes() {
    let pending = text_with_missing_predecessor();
    assert!(pending.materialized_utf8().unwrap().is_empty());
    let (state, mut source) = state(&[text_create("note")]);
    let verified = verify_complete_binary_manifests(&state, &mut source).unwrap();
    assert_eq!(
        recovery_content_ref(
            &state,
            &verified,
            &[pending],
            &entry("note"),
            MAX_FILE_BYTES
        )
        .unwrap(),
        None
    );
}

#[test]
fn namespace_paths_heads_and_hidden_outcomes_match_existing_classifier() {
    let records = [
        create("folder", EntryKind::Folder, None),
        text_create("note"),
        event(
            "note",
            "rename-note",
            &["create-note"],
            v2::Effect::Move {
                location: Location {
                    parent: Some(entry("folder")),
                    name: "renamed.md".into(),
                },
            },
        ),
        create("deleted", EntryKind::Folder, None),
        event("deleted", "delete", &["create-deleted"], v2::Effect::Delete),
        event(
            "absent",
            "unresolved",
            &["create-absent"],
            v2::Effect::Move {
                location: location("guessed"),
            },
        ),
    ];
    let texts = [text("note", "\u{feff}😀\r\n")];
    let legacy = v2::State::from_records(
        scope(),
        revision("graph"),
        records
            .iter()
            .cloned()
            .map(|record| (record.id.clone(), record))
            .collect(),
        BTreeMap::new(),
    )
    .unwrap();
    let expected = crate::materialization::classify(&legacy, &texts, MAX_FILE_BYTES).unwrap();
    let actual = classify(&records, &texts);
    assert_eq!(actual.len(), expected.len());
    for result in actual {
        let previous = &expected[&result.identity.entry_id];
        assert_eq!(result.identity, previous.identity);
        match (result.outcome, &previous.outcome) {
            (
                OutcomeRef::Normal {
                    path,
                    kind,
                    content,
                    namespace_heads,
                    location_event,
                },
                crate::materialization::Outcome::Normal {
                    path: expected_path,
                    kind: expected_kind,
                    content: expected_content,
                    namespace_heads: expected_heads,
                    location_event: expected_location,
                },
            ) => {
                assert_eq!(&path, expected_path);
                assert_eq!(&kind, expected_kind);
                assert_eq!(&namespace_heads, expected_heads);
                assert_eq!(&location_event, expected_location);
                match (content, expected_content) {
                    (None, None) => {}
                    (Some(ContentRef::Text(content)), Some(expected_content)) => {
                        assert_eq!(&content, expected_content);
                    }
                    _ => panic!("different content classification"),
                }
            }
            (
                OutcomeRef::Pending { reason },
                crate::materialization::Outcome::Pending {
                    reason: expected_reason,
                },
            ) => assert_eq!(&reason, expected_reason),
            (OutcomeRef::Tombstone, crate::materialization::Outcome::Tombstone) => {}
            _ => panic!("different namespace classification"),
        }
    }
}
