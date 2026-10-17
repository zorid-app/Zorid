use super::*;
use crate::{ChunkPage, ChunkRef, Family, Location, Scope};
use zorid_sync_protocol::{RealmId, VaultId};

fn id(s: &str) -> UpdateId {
    UpdateId::new(s).unwrap()
}
fn entry(s: &str) -> EntryId {
    EntryId::new(s).unwrap()
}
fn rev(s: &str) -> Revision {
    Revision::new(s).unwrap()
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
fn event(name: &str, event: &str, parents: &[&str], effect: v2::Effect) -> v2::EntryEvent {
    v2::EntryEvent {
        id: id(event),
        identity: identity(name),
        parents: parents.iter().map(|p| id(p)).collect(),
        effect,
    }
}
fn payload(event: v2::EntryEvent) -> v2::Payload {
    record(
        event.id.clone(),
        v2::Body::Events {
            events: vec![event],
        },
    )
}
fn record(id: UpdateId, body: v2::Body) -> v2::Payload {
    v2::Payload {
        family: Family::Files,
        format_version: 2,
        scope: scope(),
        id,
        body,
    }
}
fn create(name: &str, kind: EntryKind, content: Option<v2::ContentSeed>) -> v2::Payload {
    payload(event(
        name,
        &format!("create-{name}"),
        &[],
        v2::Effect::Create {
            entry_kind: kind,
            location: location(name),
            content,
        },
    ))
}
fn text_create(name: &str) -> v2::Payload {
    create(
        name,
        EntryKind::File,
        Some(v2::ContentSeed::Text {
            text_bootstrap_id: id(&format!("text-{name}")),
            text_format: 2,
        }),
    )
}
fn text(name: &str) -> TextState {
    TextState::empty(
        TextIdentity {
            realm_id: scope().realm_id,
            vault_id: scope().vault_id,
            entry_id: entry(name),
            bootstrap_id: id(&format!("text-{name}")),
        },
        rev("text-state"),
    )
}
fn state(records: Vec<v2::Payload>) -> v2::State {
    v2::State::from_records(
        scope(),
        rev("graph"),
        records.into_iter().map(|p| (p.id.clone(), p)).collect(),
        BTreeMap::new(),
    )
    .unwrap()
}
fn binary(tag: &str, bytes: &[u8]) -> (Manifest, Vec<v2::Payload>) {
    let chunk_id = id(&format!("chunk-{tag}"));
    let page_id = id(&format!("page-{tag}"));
    let page = ChunkPage {
        chunks: vec![ChunkRef {
            id: chunk_id.clone(),
            bytes: bytes.len() as u32,
            digest: Sha256Digest::of(bytes),
        }],
    };
    let manifest = Manifest {
        bytes: bytes.len() as u64,
        digest: Sha256Digest::of(bytes),
        pages: vec![page.reference(page_id.clone()).unwrap()],
    };
    (
        manifest,
        vec![
            record(
                chunk_id,
                v2::Body::Chunk {
                    bytes: bytes.to_vec(),
                },
            ),
            record(page_id, v2::Body::Page { page }),
        ],
    )
}
fn binary_create(name: &str, manifest: Manifest) -> v2::Payload {
    create(
        name,
        EntryKind::File,
        Some(v2::ContentSeed::Binary { manifest }),
    )
}
fn outcome<'a>(result: &'a BTreeMap<EntryId, EntryMaterialization>, name: &str) -> &'a Outcome {
    &result[&entry(name)].outcome
}

#[test]
fn folder_and_complete_empty_text_are_distinct_and_missing_text_is_pending() {
    let graph = state(vec![
        create("folder", EntryKind::Folder, None),
        text_create("note"),
    ]);
    let empty = text("note");
    let results = classify(&graph, &[empty.clone()], 0).unwrap();
    assert!(matches!(
        outcome(&results, "folder"),
        Outcome::Normal {
            kind: EntryKind::Folder,
            content: None,
            ..
        }
    ));
    let Outcome::Normal {
        content: Some(content),
        namespace_heads,
        location_event,
        ..
    } = outcome(&results, "note")
    else {
        panic!("empty text must be complete");
    };
    assert!(content.bytes.is_empty());
    assert_eq!(namespace_heads, &[id("create-note")]);
    assert_eq!(location_event, &id("create-note"));
    assert!(
        matches!(&content.witness, ContentWitness::Text { identity, revision, snapshot_digest } if identity == &empty.identity && revision == &empty.version && snapshot_digest == &Sha256Digest::of(&empty.snapshot))
    );
    assert!(matches!(
        outcome(&classify(&graph, &[], 16).unwrap(), "note"),
        Outcome::Pending {
            reason: PendingReason::MissingText
        }
    ));
}

#[test]
fn missing_pages_or_chunks_never_materialize_partial_binary() {
    let (manifest, parts) = binary("one", b"complete");
    for included in [vec![], vec![parts[1].clone()]] {
        let mut records = vec![binary_create("attachment", manifest.clone())];
        records.extend(included);
        let graph = state(records);
        assert!(matches!(
            outcome(&classify(&graph, &[], 64).unwrap(), "attachment"),
            Outcome::Pending {
                reason: PendingReason::BinaryDependencies { .. }
            }
        ));
        assert_eq!(
            recovery_content(&graph, &[], &entry("attachment"), 64).unwrap(),
            None
        );
    }
    let mut records = vec![binary_create("attachment", manifest.clone())];
    records.extend(parts);
    let graph = state(records);
    let Outcome::Normal {
        content: Some(content),
        ..
    } = classify(&graph, &[], 64)
        .unwrap()
        .remove(&entry("attachment"))
        .unwrap()
        .outcome
    else {
        panic!("complete binary");
    };
    assert_eq!(content.bytes, b"complete");
    assert_eq!(
        content.witness,
        ContentWitness::Binary {
            selected_event: id("create-attachment"),
            manifest
        }
    );
}

#[test]
fn deterministic_binary_head_keeps_alternatives_and_does_not_fallback() {
    let (first, first_parts) = binary("first", b"first");
    let (last, last_parts) = binary("last", b"last");
    let mut records = vec![
        binary_create("attachment", first.clone()),
        payload(event(
            "attachment",
            "write-a",
            &["create-attachment"],
            v2::Effect::SetContent { content: first },
        )),
        payload(event(
            "attachment",
            "write-z",
            &["create-attachment"],
            v2::Effect::SetContent {
                content: last.clone(),
            },
        )),
    ];
    records.extend(first_parts);
    records.push(last_parts[1].clone());
    let incomplete = state(records.clone());
    assert_eq!(
        incomplete.view().unwrap().namespace.entries[&entry("attachment")]
            .contents
            .len(),
        2
    );
    assert!(matches!(
        outcome(&classify(&incomplete, &[], 64).unwrap(), "attachment"),
        Outcome::Pending {
            reason: PendingReason::BinaryDependencies { .. }
        }
    ));
    assert!(recovery_content(&incomplete, &[], &entry("attachment"), 64)
        .unwrap()
        .is_none());
    records.push(last_parts[0].clone());
    let full = state(records.clone());
    records.reverse();
    let reordered = state(records);
    assert_eq!(classify(&full, &[], 64), classify(&reordered, &[], 64));
    let content = recovery_content(&full, &[], &entry("attachment"), 64)
        .unwrap()
        .unwrap();
    assert_eq!(content.bytes, b"last");
    assert_eq!(
        content.witness,
        ContentWitness::Binary {
            selected_event: id("write-z"),
            manifest: last
        }
    );
    assert_eq!(
        full.view().unwrap().namespace.entries[&entry("attachment")]
            .contents
            .len(),
        2
    );
}

#[test]
fn unresolved_move_identity_is_visible_as_pending_without_invented_path() {
    let graph = state(vec![payload(event(
        "absent",
        "move",
        &["create-absent"],
        v2::Effect::Move {
            location: location("guessed"),
        },
    ))]);
    let results = classify(&graph, &[], 64).unwrap();
    assert_eq!(results[&entry("absent")].identity, identity("absent"));
    assert_eq!(
        outcome(&results, "absent"),
        &Outcome::Pending {
            reason: PendingReason::MissingBootstrap
        }
    );
}

#[test]
fn precreate_text_activity_keeps_identity_and_explicit_recovery_bytes() {
    let text = text("note");
    // Restored trusted metadata fixture; this read-only classifier does not
    // authenticate it and must never be used as an ingress capability.
    let activity: v2::StoredActivity = serde_json::from_value(serde_json::json!({"identity":text.identity,"update_id":"edit", "namespace":{"bootstrap_id":"create-note","parents":["create-note"]}, "payload_digest":Sha256Digest::of(b"original authenticated payload"),"payload_bytes":30})).unwrap();
    let graph = v2::State::from_records(
        scope(),
        rev("graph"),
        BTreeMap::new(),
        BTreeMap::from([(id("edit"), activity)]),
    )
    .unwrap();
    assert!(matches!(
        outcome(&classify(&graph, &[text.clone()], 64).unwrap(), "note"),
        Outcome::Pending {
            reason: PendingReason::MissingBootstrap
        }
    ));
    assert!(recovery_content(&graph, &[text], &entry("note"), 64)
        .unwrap()
        .unwrap()
        .bytes
        .is_empty());
}

#[test]
fn immutable_text_identity_is_checked_even_when_tombstoned() {
    let graph = state(vec![
        text_create("note"),
        payload(event(
            "note",
            "delete",
            &["create-note"],
            v2::Effect::Delete,
        )),
    ]);
    let original = text("note");
    let mut variants = Vec::new();
    let mut changed = original.clone();
    changed.identity.realm_id = RealmId::new("other").unwrap();
    variants.push(changed);
    let mut changed = original.clone();
    changed.identity.vault_id = VaultId::new("other").unwrap();
    variants.push(changed);
    let mut changed = original.clone();
    changed.identity.entry_id = entry("other");
    variants.push(changed);
    let mut changed = original.clone();
    changed.identity.bootstrap_id = id("other");
    variants.push(changed);
    for changed in variants {
        assert_eq!(
            classify(&graph, &[changed], 64),
            Err(Error::IdentityMismatch)
        );
    }
    assert_eq!(
        classify(&graph, &[original.clone(), original], 64),
        Err(Error::IdentityMismatch)
    );
    assert_eq!(
        classify(&state(vec![]), &[text("orphan")], 64),
        Err(Error::IdentityMismatch)
    );
}

#[test]
fn recovery_and_tombstone_never_expose_publication_bytes() {
    let base = text_create("note");
    let deletion = payload(event(
        "note",
        "delete",
        &["create-note"],
        v2::Effect::Delete,
    ));
    let tombstone = state(vec![base.clone(), deletion.clone()]);
    assert_eq!(
        outcome(&classify(&tombstone, &[text("note")], 64).unwrap(), "note"),
        &Outcome::Tombstone
    );
    assert!(
        recovery_content(&tombstone, &[text("note")], &entry("note"), 64)
            .unwrap()
            .is_some()
    );
    let conflict = state(vec![
        base,
        deletion,
        payload(event(
            "note",
            "move",
            &["create-note"],
            v2::Effect::Move {
                location: location("moved"),
            },
        )),
    ]);
    assert_eq!(
        outcome(&classify(&conflict, &[text("note")], 64).unwrap(), "note"),
        &Outcome::Recovery {
            reason: RecoveryReason::DeleteConflict
        }
    );
    assert!(
        recovery_content(&conflict, &[text("note")], &entry("note"), 64)
            .unwrap()
            .is_some()
    );
}

#[test]
fn pending_folder_change_blocks_descendant_publication() {
    let folder = create("folder", EntryKind::Folder, None);
    let child = payload(event(
        "child",
        "create-child",
        &[],
        v2::Effect::Create {
            entry_kind: EntryKind::Folder,
            location: Location {
                parent: Some(entry("folder")),
                name: "child".into(),
            },
            content: None,
        },
    ));
    let unresolved = payload(event(
        "folder",
        "move",
        &["missing-parent"],
        v2::Effect::Move {
            location: location("moved"),
        },
    ));
    let graph = state(vec![folder, child, unresolved]);
    let results = classify(&graph, &[], 64).unwrap();
    for name in ["folder", "child"] {
        assert_eq!(
            outcome(&results, name),
            &Outcome::Pending {
                reason: PendingReason::CausalDependencies {
                    events: BTreeSet::from([id("move")])
                }
            }
        );
    }
}

#[test]
fn host_file_limit_preserves_pending_and_recovery_reports_too_large() {
    let (manifest, parts) = binary("large", b"12345");
    let mut records = vec![binary_create("attachment", manifest)];
    records.extend(parts);
    let graph = state(records);
    assert_eq!(
        outcome(&classify(&graph, &[], 4).unwrap(), "attachment"),
        &Outcome::Pending {
            reason: PendingReason::FileLimitExceeded { bytes: 5, limit: 4 }
        }
    );
    assert_eq!(
        recovery_content(&graph, &[], &entry("attachment"), 4),
        Err(Error::TooLarge)
    );
    assert_eq!(
        classify(&graph, &[], MAX_FILE_BYTES + 1),
        Err(Error::TooLarge)
    );
}

#[test]
fn changed_chunk_and_manifest_digest_fail_before_publication() {
    let (manifest, parts) = binary("one", b"valid");
    let mut records = vec![binary_create("attachment", manifest)];
    records.extend(parts);
    let graph = state(records);
    let mut encoded = serde_json::to_value(&graph).unwrap();
    encoded["records"]["chunk-one"]["body"]["bytes"] = serde_json::json!([98, 97, 100, 33, 33]);
    let corrupt: v2::State = serde_json::from_value(encoded).unwrap();
    assert_eq!(classify(&corrupt, &[], 64), Err(Error::InvalidContent));
    let mut encoded = serde_json::to_value(&graph).unwrap();
    encoded["records"]["create-attachment"]["body"]["events"][0]["effect"]["content"]["manifest"]
        ["digest"] = serde_json::to_value(Sha256Digest::of(b"other")).unwrap();
    let corrupt: v2::State = serde_json::from_value(encoded).unwrap();
    assert_eq!(classify(&corrupt, &[], 64), Err(Error::InvalidContent));
}

#[test]
fn complete_empty_binary_is_a_file_not_missing_content() {
    let manifest = Manifest {
        bytes: 0,
        digest: Sha256Digest::of(&[]),
        pages: vec![],
    };
    let graph = state(vec![binary_create("empty", manifest)]);
    let result = classify(&graph, &[], 0).unwrap();
    assert!(
        matches!(outcome(&result,"empty"),Outcome::Normal { kind:EntryKind::File,content:Some(content),.. } if content.bytes.is_empty())
    );
    assert_eq!(
        classify(&graph, &[text("empty")], 64),
        Err(Error::IdentityMismatch)
    );
}

#[test]
fn concurrent_delete_and_text_preserve_unique_bytes_only_for_explicit_recovery() {
    let initial = text("note");
    let plan = zorid_client_sync::v2::plan_authored_text(
        &initial,
        &zorid_client_sync::AuthorRequest {
            expected_version: initial.version.clone(),
            next_version: rev("edited"),
            update_id: id("edit"),
            actor: zorid_client_sync::ActorRegistration {
                actor: 7,
                owner: zorid_client_sync::ActorOwner {
                    replica_id: zorid_sync_protocol::DeviceId::new("device").unwrap(),
                    incarnation_id: zorid_core::OperationId::new("incarnation").unwrap(),
                },
            },
            edits: vec![zorid_client_sync::Edit::Insert {
                index: 0,
                text: "unique offline text".into(),
            }],
        },
        &zorid_client_sync::v2::TextNamespaceContext {
            bootstrap_id: id("create-note"),
            parents: vec![id("create-note")],
        },
    )
    .unwrap();
    let deleted = state(vec![
        text_create("note"),
        payload(event(
            "note",
            "delete",
            &["create-note"],
            v2::Effect::Delete,
        )),
    ]);
    let graph = v2::plan_received_text_activity(&deleted, plan.activity(), rev("merged"))
        .unwrap()
        .next_state
        .unwrap();
    let texts = vec![plan.plan().next_state.clone()];
    assert_eq!(
        outcome(&classify(&graph, &texts, 64).unwrap(), "note"),
        &Outcome::Recovery {
            reason: RecoveryReason::DeleteConflict
        }
    );
    assert_eq!(
        recovery_content(&graph, &texts, &entry("note"), 64)
            .unwrap()
            .unwrap()
            .bytes,
        b"unique offline text"
    );
}

#[test]
fn shared_binary_manifest_expansion_obeys_aggregate_output_budget() {
    let (manifest, parts) = binary("shared", b"12345");
    let mut records = vec![
        binary_create("first", manifest.clone()),
        binary_create("second", manifest),
    ];
    records.extend(parts);
    let graph = state(records);
    assert_eq!(classify_bounded(&graph, &[], 5, 9), Err(Error::TooLarge));
    let output = classify_bounded(&graph, &[], 5, 10).unwrap();
    for name in ["first", "second"] {
        assert!(
            matches!(outcome(&output,name),Outcome::Normal { content:Some(content),.. } if content.bytes==b"12345")
        );
    }
}

#[test]
fn resolved_namespace_does_not_publish_text_with_missing_crdt_dependencies() {
    use zorid_client_sync::v2::{AuthenticatedText, TextNamespaceContext};
    use zorid_client_sync::{ActorOwner, ActorRegistration, AuthorRequest, Edit, ReceiveRequest};
    use zorid_crypto::{CryptoError, EntropySource, VaultKey};
    use zorid_sync_protocol::{DeviceId, ExpectedContext, Header};
    struct Entropy;
    impl EntropySource for Entropy {
        fn fill(&mut self, bytes: &mut [u8]) -> std::result::Result<(), CryptoError> {
            bytes.fill(9);
            Ok(())
        }
    }
    let initial = text("note");
    let context = TextNamespaceContext {
        bootstrap_id: id("create-note"),
        parents: vec![id("create-note")],
    };
    let request = |state: &TextState, name: &str, edits: Vec<Edit>| AuthorRequest {
        expected_version: state.version.clone(),
        next_version: rev(name),
        update_id: id(name),
        actor: ActorRegistration {
            actor: 11,
            owner: ActorOwner {
                replica_id: DeviceId::new("device").unwrap(),
                incarnation_id: zorid_core::OperationId::new("incarnation").unwrap(),
            },
        },
        edits,
    };
    let open = |plan: &zorid_client_sync::v2::AuthoredTextPlan| {
        let update = &plan.plan().authored.update_id;
        let header = Header::new(
            scope().realm_id,
            scope().vault_id,
            update.clone(),
            DeviceId::new("device").unwrap(),
            1,
        )
        .unwrap();
        let key = VaultKey::from_bytes([7; 32]);
        let wire = zorid_crypto::seal(
            &header,
            &plan.plan().authored.payload_bytes,
            &key,
            &mut Entropy,
        )
        .unwrap()
        .encode();
        AuthenticatedText::open(
            &wire,
            &ExpectedContext {
                realm_id: scope().realm_id,
                vault_id: scope().vault_id,
                update_id: update.clone(),
                key_epoch: 1,
            },
            &key,
        )
        .unwrap()
    };
    let receive = |state: &TextState, incoming: &AuthenticatedText, name: &str| {
        zorid_client_sync::v2::plan_received_text(
            state,
            &ReceiveRequest {
                expected_version: state.version.clone(),
                next_version: rev(name),
                delivery: None,
            },
            incoming,
            None,
            None,
        )
        .unwrap()
        .next_state
        .unwrap()
    };
    for edit in [
        Edit::Insert {
            index: 1,
            text: "b".into(),
        },
        Edit::Delete {
            index: 0,
            length: 1,
        },
    ] {
        let first = zorid_client_sync::v2::plan_authored_text(
            &initial,
            &request(
                &initial,
                "first",
                vec![Edit::Insert {
                    index: 0,
                    text: "a".into(),
                }],
            ),
            &context,
        )
        .unwrap();
        // A syntactically valid authenticated namespace frontier cannot prove
        // that all Yrs predecessor clocks are present at this receiver.
        let second = zorid_client_sync::v2::plan_authored_text(
            &first.plan().next_state,
            &request(&first.plan().next_state, "second", vec![edit]),
            &context,
        )
        .unwrap();
        let received_second = open(&second);
        let pending = receive(&initial, &received_second, "pending");
        let pending: TextState =
            serde_json::from_value(serde_json::to_value(&pending).unwrap()).unwrap();
        assert_eq!(pending.materialized_utf8().unwrap(), b"");
        let graph = v2::plan_received_text_activity(
            &state(vec![text_create("note")]),
            received_second.activity(),
            rev("graph-second"),
        )
        .unwrap()
        .next_state
        .unwrap();
        assert!(graph.view().unwrap().namespace.pending.is_empty());
        assert_eq!(
            outcome(&classify(&graph, &[pending.clone()], 64).unwrap(), "note"),
            &Outcome::Pending {
                reason: PendingReason::TextDependencies
            }
        );
        assert!(
            recovery_content(&graph, &[pending.clone()], &entry("note"), 64)
                .unwrap()
                .is_none()
        );
        let first_incoming = open(&first);
        let complete = receive(&pending, &first_incoming, "complete");
        let graph = v2::plan_received_text_activity(
            &graph,
            first_incoming.activity(),
            rev("graph-complete"),
        )
        .unwrap()
        .next_state
        .unwrap();
        let expected = second.plan().next_state.materialized_utf8().unwrap();
        assert!(
            matches!(outcome(&classify(&graph,&[complete],64).unwrap(),"note"),Outcome::Normal { content:Some(content),.. } if content.bytes==expected)
        );
    }
}
