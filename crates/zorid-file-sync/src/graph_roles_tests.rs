use super::*;
use crate::{
    metadata::{GraphRecord, MetadataState},
    ChunkPage, Family, Location, Manifest, Sha256Digest,
};
use std::collections::{BTreeMap, BTreeSet};
use zorid_core::{EntryKind, Revision};
use zorid_sync_protocol::{RealmId, VaultId};

fn id(value: &str) -> UpdateId {
    UpdateId::new(value).unwrap()
}
fn entry(value: &str) -> EntryId {
    EntryId::new(value).unwrap()
}
fn scope() -> Scope {
    Scope {
        realm_id: RealmId::new("realm").unwrap(),
        vault_id: VaultId::new("vault").unwrap(),
    }
}
fn identity(name: &str, root: &str) -> EntryIdentity {
    EntryIdentity {
        entry_id: entry(name),
        bootstrap_id: id(root),
    }
}
#[derive(Clone)]
enum Source {
    File(UpdateId, GraphRecord),
    Text(v2::StoredActivity),
}
impl Source {
    fn facts(&self) -> SourceFacts {
        match self {
            Self::File(id, record) => SourceFacts::file(&scope(), id, record).unwrap(),
            Self::Text(activity) => SourceFacts::text(&scope(), activity).unwrap(),
        }
    }
}
fn file(source: &str, body: v2::Body) -> Source {
    let payload = v2::Payload {
        family: Family::Files,
        format_version: v2::FORMAT_VERSION,
        scope: scope(),
        id: id(source),
        body,
    };
    let (_, source_id, record) =
        GraphRecord::from_authored_exact(&payload.encode().unwrap()).unwrap();
    Source::File(source_id, record)
}
fn events(source: &str, events: Vec<v2::EntryEvent>) -> Source {
    file(source, v2::Body::Events { events })
}
fn create(name: &str, root: &str, text_root: &str) -> v2::EntryEvent {
    v2::EntryEvent {
        id: id(root),
        identity: identity(name, root),
        parents: vec![],
        effect: v2::Effect::Create {
            entry_kind: EntryKind::File,
            location: Location {
                parent: None,
                name: format!("{name}.md"),
            },
            content: Some(v2::ContentSeed::Text {
                text_bootstrap_id: id(text_root),
                text_format: zorid_client_sync::v2::TEXT_FORMAT_VERSION,
            }),
        },
    }
}
fn child(name: &str, root: &str, event: &str, parent: &str) -> v2::EntryEvent {
    v2::EntryEvent {
        id: id(event),
        identity: identity(name, root),
        parents: vec![id(parent)],
        effect: v2::Effect::Delete,
    }
}
fn activity(name: &str, root: &str, text_root: &str, update: &str) -> Source {
    Source::Text(
        serde_json::from_value(serde_json::json!({
            "identity": { "realm_id": scope().realm_id, "vault_id": scope().vault_id,
                "entry_id": entry(name), "bootstrap_id": id(text_root) },
            "update_id": update, "namespace": {"bootstrap_id": root, "parents": [root]},
            "payload_bytes": 64, "payload_digest": Sha256Digest::of(b"ledger-checked text")
        }))
        .unwrap(),
    )
}
fn binary(name: &str, root: &str, page: PageRef) -> Source {
    let mut event = create(name, root, "unused");
    let v2::Effect::Create { content, .. } = &mut event.effect else {
        unreachable!()
    };
    *content = Some(v2::ContentSeed::Binary {
        manifest: Manifest {
            bytes: page.bytes,
            digest: Sha256Digest::of(b"content"),
            pages: vec![page],
        },
    });
    events(root, vec![event])
}
fn chunk_reference() -> ChunkRef {
    ChunkRef {
        id: id("chunk"),
        bytes: 7,
        digest: Sha256Digest::of(b"content"),
    }
}
fn page(reference: ChunkRef) -> Source {
    file(
        "page",
        v2::Body::Page {
            page: ChunkPage {
                chunks: vec![reference],
            },
        },
    )
}
fn claims_at<'a>(facts: &'a [SourceFacts], target: &UpdateId) -> Vec<Claim<'a>> {
    facts
        .iter()
        .flat_map(|source| {
            source
                .claims()
                .iter()
                .enumerate()
                .filter(|(_, claim)| claim.id() == target)
                .map(move |(ordinal, _)| Claim::at(source, ordinal).unwrap())
        })
        .collect()
}
fn oracle(sources: &[Source]) -> Result<MetadataState> {
    let mut records = BTreeMap::new();
    let mut activities = BTreeMap::new();
    for source in sources {
        match source {
            Source::File(id, record) => {
                assert!(records.insert(id.clone(), record.clone()).is_none());
            }
            Source::Text(activity) => {
                assert!(activities
                    .insert(activity.update_id().clone(), activity.clone())
                    .is_none());
            }
        }
    }
    MetadataState::from_records(scope(), Revision::new("test").unwrap(), records, activities)
}
/// These fixtures isolate per-ID role rules. Other whole-graph invariants, such
/// as causal cycles and cross-ID entry bindings, belong to separate reducers.
fn differential(sources: Vec<Source>, expected: bool) {
    assert_eq!(oracle(&sources).is_ok(), expected, "reference fixture");
    let facts: Vec<_> = sources.iter().map(Source::facts).collect();
    let ids: BTreeSet<_> = facts
        .iter()
        .flat_map(|source| source.claims().iter().map(|claim| claim.id().clone()))
        .collect();
    for reverse in [false, true] {
        let mut compatible = true;
        for target in &ids {
            let mut claims = claims_at(&facts, target);
            if reverse {
                claims.reverse();
            }
            let first = reduce(&scope(), target, claims.iter().copied(), []).is_ok();
            // Splits also exercise existing→incoming arrival and every rotation.
            for split in 0..=claims.len() {
                assert_eq!(
                    reduce(
                        &scope(),
                        target,
                        claims[..split].iter().copied(),
                        claims[split..].iter().copied()
                    )
                    .is_ok(),
                    first
                );
            }
            for shift in 0..claims.len() {
                claims.rotate_left(shift);
                assert_eq!(
                    reduce(&scope(), target, [], claims.iter().copied()).is_ok(),
                    first
                );
            }
            compatible &= first;
        }
        assert_eq!(compatible, expected, "per-ID compatibility");
    }
}

#[test]
fn self_create_event_envelope_and_both_bootstraps_are_compatible_in_any_order() {
    differential(vec![activity("note", "root", "root", "edit")], true);
    differential(
        vec![
            events("root", vec![create("note", "root", "root")]),
            activity("note", "root", "root", "edit"),
        ],
        true,
    );
}

#[test]
fn ordinary_event_may_alias_its_own_envelope_without_being_a_bootstrap() {
    differential(
        vec![events(
            "delete",
            vec![child("note", "root", "delete", "root")],
        )],
        true,
    );
}

#[test]
fn unresolved_parent_identity_is_reserved_before_arrival() {
    let pending = vec![
        events("child-a", vec![child("note", "root", "child-a", "missing")]),
        events("child-b", vec![child("note", "root", "child-b", "missing")]),
    ];
    differential(pending.clone(), true);
    let mut matching = pending.clone();
    matching.push(events(
        "missing",
        vec![child("note", "root", "missing", "root")],
    ));
    differential(matching, true);
    let mut wrong = pending;
    wrong.push(events(
        "missing",
        vec![child("other", "other-root", "missing", "other-root")],
    ));
    differential(wrong, false);
}

#[test]
fn different_unresolved_parent_identities_fail_complete_metadata_reference() {
    let sources = vec![
        events(
            "child-a",
            vec![child("first", "root-a", "child-a", "missing")],
        ),
        events(
            "child-b",
            vec![child("second", "root-b", "child-b", "missing")],
        ),
    ];
    assert!(matches!(oracle(&sources), Err(Error::IdentityMismatch)));
    let facts: Vec<_> = sources.iter().map(Source::facts).collect();
    assert_eq!(
        reduce(
            &scope(),
            &id("missing"),
            claims_at(&facts, &id("missing")),
            []
        ),
        Err(Error::IdentityMismatch)
    );
    differential(sources, false);
}

#[test]
fn bootstrap_owner_and_create_arrivals_must_match() {
    let pending = events("child", vec![child("note", "root", "child", "root")]);
    differential(
        vec![
            pending.clone(),
            events("root", vec![create("note", "root", "text")]),
        ],
        true,
    );
    differential(
        vec![
            pending.clone(),
            events("root", vec![create("other", "root", "text")]),
        ],
        false,
    );
    differential(
        vec![
            pending,
            events(
                "child-other",
                vec![child("other", "root", "child-other", "root")],
            ),
        ],
        false,
    );
}

#[test]
fn text_bootstrap_requires_exact_create_text_binding_at_shared_namespace_root() {
    let mut binary_create = create("note", "root", "root");
    let v2::Effect::Create { content, .. } = &mut binary_create.effect else {
        unreachable!()
    };
    *content = Some(v2::ContentSeed::Binary {
        manifest: Manifest {
            bytes: 0,
            digest: Sha256Digest::of(&[]),
            pages: vec![],
        },
    });
    differential(
        vec![
            events("root", vec![binary_create]),
            activity("note", "root", "root", "edit"),
        ],
        false,
    );
    differential(
        vec![
            events("move", vec![child("note", "root", "move", "root")]),
            activity("note", "root", "move", "edit"),
        ],
        false,
    );
}

#[test]
fn duplicate_event_sources_and_foreign_envelope_aliases_are_rejected() {
    differential(
        vec![
            events("one", vec![create("note", "root", "text")]),
            events("two", vec![create("note", "root", "text")]),
        ],
        false,
    );
    differential(
        vec![
            events("one", vec![create("note", "root", "text")]),
            events("root", vec![create("other", "other-root", "other-text")]),
        ],
        false,
    );
}

#[test]
fn pending_parent_cannot_promote_to_non_event_envelope_or_text_only_root() {
    differential(
        vec![
            events("envelope", vec![create("note", "root", "text")]),
            events("child", vec![child("note", "root", "child", "envelope")]),
        ],
        false,
    );
    differential(
        vec![
            activity("note", "root", "text", "edit"),
            events("child", vec![child("note", "root", "child", "text")]),
        ],
        false,
    );
}

#[test]
fn page_and_chunk_references_allow_missing_and_matching_descriptor_arrivals() {
    let reference = chunk_reference();
    let chunk_page = ChunkPage {
        chunks: vec![reference.clone()],
    };
    let manifest = binary("file", "root", chunk_page.reference(id("page")).unwrap());
    differential(vec![manifest.clone()], true);
    differential(vec![manifest.clone(), page(reference.clone())], true);
    differential(
        vec![
            manifest,
            page(reference),
            file(
                "chunk",
                v2::Body::Chunk {
                    bytes: b"content".to_vec(),
                },
            ),
        ],
        true,
    );
}

#[test]
fn conflicting_expected_descriptors_and_orphan_chunk_mismatches_are_rejected() {
    let reference = chunk_reference();
    let expected = ChunkPage {
        chunks: vec![reference.clone()],
    }
    .reference(id("page"))
    .unwrap();
    let mut wrong = expected.clone();
    wrong.digest = Sha256Digest::of(b"wrong");
    differential(
        vec![
            binary("first", "first-root", expected.clone()),
            binary("second", "second-root", wrong),
        ],
        false,
    );
    let mut wrong = reference.clone();
    wrong.digest = Sha256Digest::of(b"wrong");
    differential(
        vec![
            page(reference.clone()),
            file(
                "other-page",
                v2::Body::Page {
                    page: ChunkPage {
                        chunks: vec![wrong.clone()],
                    },
                },
            ),
        ],
        false,
    );
    differential(vec![binary("file", "root", expected), page(wrong)], false);
    differential(
        vec![
            page(reference),
            file(
                "chunk",
                v2::Body::Chunk {
                    bytes: b"invalid".to_vec(),
                },
            ),
        ],
        false,
    );
}

#[test]
fn page_chunk_and_event_role_collisions_fail() {
    let mut reference = chunk_reference();
    reference.id = id("root");
    differential(
        vec![
            events("root", vec![create("note", "root", "text")]),
            page(reference),
        ],
        false,
    );
    let expected = ChunkPage {
        chunks: vec![chunk_reference()],
    }
    .reference(id("same"))
    .unwrap();
    let mut reference = chunk_reference();
    reference.id = id("same");
    differential(
        vec![binary("file", "root", expected), page(reference)],
        false,
    );
}

#[test]
fn claims_are_checked_source_bound_and_scope_and_id_specific() {
    let facts = events("root", vec![create("note", "root", "text")]).facts();
    assert!(matches!(
        Claim::at(&facts, facts.claims().len()),
        Err(Error::InvalidState)
    ));
    let claim = Claim::at(&facts, 0).unwrap();
    let mut wrong = scope();
    wrong.vault_id = VaultId::new("wrong").unwrap();
    assert_eq!(
        reduce(&wrong, &id("root"), [claim], []),
        Err(Error::IdentityMismatch)
    );
    assert_eq!(
        reduce(&scope(), &id("wrong"), [claim], []),
        Err(Error::InvalidState)
    );
    let claims: Vec<_> = facts
        .claims()
        .iter()
        .enumerate()
        .filter(|(_, claim)| claim.id() == &id("root"))
        .map(|(index, _)| Claim::at(&facts, index).unwrap())
        .collect();
    let state = reduce(
        &scope(),
        &id("root"),
        claims.iter().copied(),
        claims.iter().copied(),
    )
    .unwrap();
    assert_eq!(state.role(), Some(&Role::Event(identity("note", "root"))));
    assert!(state.occupied());
}

#[test]
fn streaming_reducer_drops_each_source_and_matches_iterator_reduction() {
    let mut reducer = RoleReducer::new(&scope(), &id("root"));
    for source in [
        events("root", vec![create("note", "root", "root")]),
        activity("note", "root", "root", "edit"),
    ] {
        let facts = source.facts();
        for (ordinal, claim) in facts.claims().iter().enumerate() {
            if claim.id() == &id("root") {
                reducer.push(Claim::at(&facts, ordinal).unwrap()).unwrap();
            }
        }
        // `facts` is dropped here, before the next source and final reduction.
    }
    let state = reducer.finish().unwrap();
    assert_eq!(state.role(), Some(&Role::Event(identity("note", "root"))));
    assert!(state.occupied());
}

#[test]
fn every_push_error_poisons_streaming_finish_and_subsequent_pushes() {
    let facts = events("root", vec![create("note", "root", "root")]).facts();
    let correct = Claim::at(&facts, 0).unwrap();
    let mut wrong_scope = scope();
    wrong_scope.vault_id = VaultId::new("wrong").unwrap();
    let mut reducer = RoleReducer::new(&wrong_scope, &id("root"));
    assert_eq!(reducer.push(correct), Err(Error::IdentityMismatch));
    assert_eq!(reducer.push(correct), Err(Error::IdentityMismatch));
    assert_eq!(reducer.finish(), Err(Error::IdentityMismatch));

    let mut reducer = RoleReducer::new(&scope(), &id("wrong"));
    assert_eq!(reducer.push(correct), Err(Error::InvalidState));
    assert_eq!(reducer.finish(), Err(Error::InvalidState));

    let mut reducer = RoleReducer::new(&scope(), &id("missing"));
    for (name, root, event) in [
        ("first", "first-root", "first-event"),
        ("second", "second-root", "second-event"),
    ] {
        let facts = events(event, vec![child(name, root, event, "missing")]).facts();
        for (ordinal, claim) in facts.claims().iter().enumerate() {
            if claim.id() == &id("missing") {
                let _ = reducer.push(Claim::at(&facts, ordinal).unwrap());
            }
        }
    }
    // Even if a caller discarded the conflict error, a valid prefix cannot win.
    assert_eq!(reducer.finish(), Err(Error::IdentityMismatch));
}
