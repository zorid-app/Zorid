use super::*;
use crate::{EntryIdentity, Family, Location, Manifest};
use zorid_core::EntryKind;
use zorid_sync_protocol::{RealmId, VaultId};

fn scope() -> Scope {
    Scope {
        realm_id: RealmId::new("realm").unwrap(),
        vault_id: VaultId::new("vault").unwrap(),
    }
}
fn id(value: &str) -> UpdateId {
    UpdateId::new(value).unwrap()
}
fn entry(value: &str) -> EntryId {
    EntryId::new(value).unwrap()
}
fn create(name: &str) -> v2::EntryEvent {
    v2::EntryEvent {
        id: id(name),
        identity: EntryIdentity {
            entry_id: entry(name),
            bootstrap_id: id(name),
        },
        parents: vec![],
        effect: v2::Effect::Create {
            entry_kind: EntryKind::File,
            location: Location {
                parent: None,
                name: format!("{name}.md"),
            },
            content: Some(v2::ContentSeed::Text {
                text_bootstrap_id: id(name),
                text_format: zorid_client_sync::v2::TEXT_FORMAT_VERSION,
            }),
        },
    }
}
fn record(body: v2::Body) -> GraphRecord {
    let payload = v2::Payload {
        family: Family::Files,
        format_version: v2::FORMAT_VERSION,
        scope: scope(),
        id: id("envelope"),
        body,
    };
    GraphRecord::from_authored_exact(&payload.encode().unwrap())
        .unwrap()
        .2
}
fn activity() -> v2::StoredActivity {
    serde_json::from_value(serde_json::json!({
        "identity": {
            "realm_id": scope().realm_id, "vault_id": scope().vault_id,
            "entry_id": entry("note"), "bootstrap_id": id("text-root")
        },
        "update_id": "edit", "namespace": {"bootstrap_id": "create", "parents": ["a", "create"]},
        "payload_bytes": 64, "payload_digest": Sha256Digest::of(b"ledger-checked payload")
    }))
    .unwrap()
}

#[test]
fn mixed_identity_events_keep_order_and_caller_labels() {
    let events = vec![create("first"), create("second")];
    let record = record(v2::Body::Events {
        events: events.clone(),
    });
    let mut caller_scope = scope();
    caller_scope.vault_id = VaultId::new("caller-vault-label").unwrap();
    let facts = SourceFacts::file(&caller_scope, &id("caller-source-label"), &record).unwrap();
    assert_eq!(facts.scope(), &caller_scope);
    assert_eq!(facts.source_id(), &id("caller-source-label"));
    assert_eq!(facts.kind(), SourceKind::Events);
    assert!(!facts.observed_delete());
    for (ordinal, expected) in events.iter().enumerate() {
        let actual = &facts.events()[ordinal];
        assert_eq!(actual.ordinal(), ordinal as u32);
        assert_eq!(actual.event(), &Event::File(expected.clone()));
        assert_eq!(actual.identity(), &expected.identity);
        assert_eq!(actual.id(), &expected.id);
        assert!(actual.parents().is_empty());
    }
}

#[test]
fn text_checks_scope_and_keeps_namespace_identity_parents_and_both_roots() {
    let stored = activity();
    let facts = SourceFacts::text(&scope(), &stored).unwrap();
    assert_eq!(facts.kind(), SourceKind::Text);
    assert_eq!(facts.source_id(), stored.update_id());
    assert_eq!(facts.events()[0].event(), &Event::Text(stored));
    assert_eq!(
        facts.events()[0].identity(),
        &EntryIdentity {
            entry_id: entry("note"),
            bootstrap_id: id("create")
        }
    );
    assert_eq!(facts.events()[0].parents(), &[id("a"), id("create")]);
    assert!(facts
        .claims()
        .contains(&RoleClaim::NamespaceBootstrapOwner {
            id: id("create"),
            entry_id: entry("note")
        }));
    assert!(facts.claims().contains(&RoleClaim::TextBootstrapOwner {
        id: id("text-root"),
        entry_id: entry("note")
    }));
    assert!(facts.claims().contains(&RoleClaim::ParentExpectedIdentity {
        id: id("a"),
        identity: facts.events()[0].identity().clone()
    }));
    let mut wrong_scope = scope();
    wrong_scope.vault_id = VaultId::new("wrong").unwrap();
    assert_eq!(
        SourceFacts::text(&wrong_scope, &activity()),
        Err(Error::IdentityMismatch)
    );
}

#[test]
fn orphan_manifest_and_page_references_are_facts_without_global_presence_claim() {
    let reference = ChunkRef {
        id: id("missing-chunk"),
        bytes: 7,
        digest: Sha256Digest::of(b"content"),
    };
    let page = ChunkPage {
        chunks: vec![reference.clone()],
    };
    let page_reference = page.reference(id("missing-page")).unwrap();
    let event = v2::EntryEvent {
        effect: v2::Effect::Create {
            entry_kind: EntryKind::File,
            location: Location {
                parent: None,
                name: "file.bin".into(),
            },
            content: Some(v2::ContentSeed::Binary {
                manifest: Manifest {
                    bytes: 7,
                    digest: Sha256Digest::of(b"content"),
                    pages: vec![page_reference.clone()],
                },
            }),
        },
        ..create("file")
    };
    let facts = SourceFacts::file(
        &scope(),
        &id("source"),
        &record(v2::Body::Events {
            events: vec![event],
        }),
    )
    .unwrap();
    assert_eq!(
        facts.events()[0].content_binding(),
        Some(v2::ContentBinding::Binary)
    );
    assert!(facts.claims().contains(&RoleClaim::PageReference {
        reference: page_reference
    }));
    let facts = SourceFacts::file(
        &scope(),
        &id("page"),
        &record(v2::Body::Page { page: page.clone() }),
    )
    .unwrap();
    assert_eq!(facts.page(), Some(&page));
    assert!(facts.events().is_empty());
    assert!(facts
        .claims()
        .contains(&RoleClaim::ChunkReference { reference }));
}

#[test]
fn chunk_extracts_metadata_without_body() {
    let bytes = b"content".to_vec();
    let facts = SourceFacts::file(
        &scope(),
        &id("chunk"),
        &record(v2::Body::Chunk {
            bytes: bytes.clone(),
        }),
    )
    .unwrap();
    assert_eq!(facts.kind(), SourceKind::Chunk);
    assert_eq!(facts.chunk().unwrap().bytes(), bytes.len() as u32);
    assert_eq!(facts.chunk().unwrap().digest(), &Sha256Digest::of(&bytes));
    assert!(facts.events().is_empty());
    assert!(facts.page().is_none());
    assert_eq!(
        facts.claims(),
        &[RoleClaim::Envelope {
            id: id("chunk"),
            kind: SourceKind::Chunk
        }]
    );
}

#[test]
fn permitted_create_envelope_event_and_bootstrap_aliases_remain_explicit() {
    let event = create("same");
    let facts = SourceFacts::file(
        &scope(),
        &id("same"),
        &record(v2::Body::Events {
            events: vec![event.clone()],
        }),
    )
    .unwrap();
    for claim in [
        RoleClaim::Envelope {
            id: id("same"),
            kind: SourceKind::Events,
        },
        RoleClaim::EventIdentity {
            id: id("same"),
            identity: event.identity,
        },
        RoleClaim::NamespaceBootstrapOwner {
            id: id("same"),
            entry_id: entry("same"),
        },
        RoleClaim::TextBootstrapOwner {
            id: id("same"),
            entry_id: entry("same"),
        },
    ] {
        assert!(facts.claims().contains(&claim));
    }
    assert_eq!(
        facts.events()[0].content_binding(),
        Some(v2::ContentBinding::Text {
            text_bootstrap_id: id("same"),
            text_format: zorid_client_sync::v2::TEXT_FORMAT_VERSION,
        })
    );
}

#[test]
fn invalid_activity_parent_and_event_are_rejected_by_existing_record_checks() {
    let mut raw = serde_json::to_value(activity()).unwrap();
    raw["namespace"]["parents"] = serde_json::json!(["create", "a"]);
    let invalid: v2::StoredActivity = serde_json::from_value(raw).unwrap();
    assert_eq!(
        SourceFacts::text(&scope(), &invalid),
        Err(Error::InvalidCausality)
    );
    let mut invalid = create("bad");
    invalid.parents.push(id("parent"));
    let payload = v2::Payload {
        family: Family::Files,
        format_version: v2::FORMAT_VERSION,
        scope: scope(),
        id: id("bad"),
        body: v2::Body::Events {
            events: vec![invalid],
        },
    };
    let raw = serde_json::to_vec(&payload).unwrap();
    assert!(matches!(
        GraphRecord::from_authored_exact(&raw),
        Err(Error::InvalidCausality)
    ));
}
