use super::*;
use zorid_crypto::{CryptoError, EntropySource};
use zorid_sync_protocol::{DeviceId, Header};

struct FixtureEntropy(u8);
impl EntropySource for FixtureEntropy {
    fn fill(&mut self, bytes: &mut [u8]) -> std::result::Result<(), CryptoError> {
        bytes.fill(self.0);
        Ok(())
    }
}
fn id(s: &str) -> UpdateId {
    UpdateId::new(s).unwrap()
}
fn entry(s: &str) -> EntryId {
    EntryId::new(s).unwrap()
}
fn version(s: &str) -> Revision {
    Revision::new(s).unwrap()
}
fn scope() -> Scope {
    Scope {
        realm_id: RealmId::new("realm").unwrap(),
        vault_id: VaultId::new("vault").unwrap(),
    }
}
fn initial() -> State {
    State::empty(scope(), version("initial"))
}
fn location(parent: Option<&str>, name: &str) -> Location {
    Location {
        parent: parent.map(entry),
        name: name.into(),
    }
}
fn empty_manifest() -> Manifest {
    Manifest {
        bytes: 0,
        digest: Sha256Digest::of(&[]),
        pages: vec![],
    }
}
fn create(name: &str, parent: Option<&str>, path: &str, kind: EntryKind) -> EntryEvent {
    EntryEvent {
        id: id(&format!("{name}-create")),
        identity: EntryIdentity {
            entry_id: entry(name),
            bootstrap_id: id(&format!("{name}-create")),
        },
        parents: vec![],
        effect: Effect::Create {
            entry_kind: kind,
            location: location(parent, path),
            content: (kind == EntryKind::File).then(empty_manifest),
        },
    }
}
fn event(name: &str, source: &EntryEvent, parents: &[&str], effect: Effect) -> EntryEvent {
    EntryEvent {
        id: id(name),
        identity: source.identity.clone(),
        parents: parents.iter().map(|p| id(p)).collect(),
        effect,
    }
}
fn payload(name: &str, body: Body) -> Payload {
    Payload {
        family: Family::Files,
        format_version: FORMAT_VERSION,
        scope: scope(),
        id: id(name),
        body,
    }
}
fn one(event: EntryEvent) -> Payload {
    payload(
        &format!("record-{}", event.id.as_str()),
        Body::Events {
            events: vec![event],
        },
    )
}
fn auth(payload: &Payload, nonce: u8) -> AuthenticatedPayload {
    let header = Header::new(
        payload.scope.realm_id.clone(),
        payload.scope.vault_id.clone(),
        payload.id.clone(),
        DeviceId::new("device").unwrap(),
        1,
    )
    .unwrap();
    let wire = zorid_crypto::seal(
        &header,
        &payload.encode().unwrap(),
        &VaultKey::from_bytes([7; 32]),
        &mut FixtureEntropy(nonce),
    )
    .unwrap()
    .encode();
    AuthenticatedPayload::open(
        &wire,
        &ExpectedContext {
            realm_id: payload.scope.realm_id.clone(),
            vault_id: payload.scope.vault_id.clone(),
            update_id: payload.id.clone(),
            key_epoch: 1,
        },
        &VaultKey::from_bytes([7; 32]),
    )
    .unwrap()
}
fn apply(state: &State, payload: &Payload) -> State {
    let incoming = auth(payload, 1);
    plan_received(
        state,
        &incoming,
        None,
        version(&format!("v-{}", payload.id.as_str())),
    )
    .unwrap()
    .next_state
    .unwrap_or_else(|| state.clone())
}
fn restart(state: &State) -> State {
    serde_json::from_slice(&serde_json::to_vec(state).unwrap()).unwrap()
}
fn append(state: &State, event: EntryEvent) -> State {
    apply(state, &one(event))
}
fn contents(name: &str, bytes: &[u8]) -> (Manifest, Vec<Payload>) {
    let chunk = payload(
        &format!("{name}-chunk"),
        Body::Chunk {
            bytes: bytes.to_vec(),
        },
    );
    let page = ChunkPage {
        chunks: vec![ChunkRef {
            id: chunk.id.clone(),
            bytes: bytes.len() as u32,
            digest: Sha256Digest::of(bytes),
        }],
    };
    let reference = page.reference(id(&format!("{name}-page"))).unwrap();
    let page = payload(&format!("{name}-page"), Body::Page { page });
    (
        Manifest {
            bytes: bytes.len() as u64,
            digest: Sha256Digest::of(bytes),
            pages: vec![reference],
        },
        vec![page, chunk],
    )
}

#[test]
fn reverse_delivery_pending_state_and_restart_converge() {
    let file = create("file", None, "a.dat", EntryKind::File);
    let moved = event(
        "move",
        &file,
        &["file-create"],
        Effect::Move {
            location: location(None, "b.dat"),
        },
    );
    let mut forward = initial();
    forward = append(&forward, file.clone());
    forward = append(&forward, moved.clone());
    let pending = append(&initial(), moved);
    assert_eq!(
        pending.view().unwrap().pending,
        BTreeSet::from([id("move")])
    );
    assert!(pending.view().unwrap().entries.is_empty());
    let reverse = append(&restart(&pending), file);
    assert_eq!(reverse.view().unwrap(), forward.view().unwrap());
    assert!(
        matches!(&reverse.view().unwrap().entries[&entry("file")].projection, Projection::Normal { path } if path.as_str() == "b.dat")
    );
}

#[test]
fn concurrent_binary_heads_are_retained_with_deterministic_choice() {
    let file = create("file", None, "a.unknown", EntryKind::File);
    let base = append(&initial(), file.clone());
    let (a, chunks_a) = contents("a", &[0, 255, 0, 128]);
    let (b, chunks_b) = contents("b", &[1, 0, 254]);
    let left = event(
        "write-a",
        &file,
        &["file-create"],
        Effect::SetContent { content: a.clone() },
    );
    let right = event(
        "write-b",
        &file,
        &["file-create"],
        Effect::SetContent { content: b.clone() },
    );
    let mut x = append(&append(&base, left.clone()), right.clone());
    let mut y = append(&append(&base, right), left);
    for payload in chunks_a.iter().chain(chunks_b.iter()) {
        x = apply(&x, payload);
    }
    for payload in chunks_b.iter().rev().chain(chunks_a.iter().rev()) {
        y = apply(&restart(&y), payload);
    }
    assert_eq!(x.view().unwrap(), y.view().unwrap());
    let view = x.view().unwrap();
    let heads = &view.entries[&entry("file")].contents;
    assert_eq!(
        heads.iter().map(|h| h.event.clone()).collect::<Vec<_>>(),
        vec![id("write-a"), id("write-b")]
    );
    assert_eq!(x.materialize(&a).unwrap().unwrap(), [0, 255, 0, 128]);
    assert_eq!(x.materialize(&b).unwrap().unwrap(), [1, 0, 254]);
    let resolution = event(
        "resolution",
        &file,
        &["write-a", "write-b"],
        Effect::SetContent { content: a.clone() },
    );
    let resolved = append(&x, resolution);
    assert_eq!(
        resolved.view().unwrap().entries[&entry("file")]
            .contents
            .len(),
        1
    );
    assert_eq!(resolved.materialize(&b).unwrap().unwrap(), [1, 0, 254]); // retained history
}

#[test]
fn concurrent_move_and_binary_edit_merge_independently() {
    let file = create("file", None, "old", EntryKind::File);
    let (content, pieces) = contents("new", b"new bytes");
    let moved = event(
        "move",
        &file,
        &["file-create"],
        Effect::Move {
            location: location(None, "new"),
        },
    );
    let written = event(
        "write",
        &file,
        &["file-create"],
        Effect::SetContent {
            content: content.clone(),
        },
    );
    let mut a = append(
        &append(&append(&initial(), file.clone()), moved.clone()),
        written.clone(),
    );
    let mut b = append(&append(&append(&initial(), file), written), moved);
    for piece in pieces {
        a = apply(&a, &piece);
        b = apply(&b, &piece);
    }
    assert_eq!(a.view().unwrap(), b.view().unwrap());
    let view = a.view().unwrap();
    assert!(
        matches!(&view.entries[&entry("file")].projection, Projection::Normal { path } if path.as_str() == "new")
    );
    assert_eq!(a.materialize(&content).unwrap().unwrap(), b"new bytes");
}

#[test]
fn observed_subtree_delete_does_not_delete_concurrent_new_child() {
    let folder = create("folder", None, "folder", EntryKind::Folder);
    let old = create("old", Some("folder"), "old", EntryKind::File);
    let new = create("new", Some("folder"), "new", EntryKind::File);
    let delete = payload(
        "delete-batch",
        Body::ObservedDelete {
            events: vec![
                event("delete-folder", &folder, &["folder-create"], Effect::Delete),
                event("delete-old", &old, &["old-create"], Effect::Delete),
            ],
        },
    );
    let base = append(&append(&initial(), folder), old);
    let a = append(&apply(&base, &delete), new.clone());
    let b = apply(&append(&base, new), &delete);
    assert_eq!(a.view().unwrap(), b.view().unwrap());
    let view = a.view().unwrap();
    assert_eq!(view.entries[&entry("old")].liveness, Liveness::Deleted);
    assert_eq!(view.entries[&entry("new")].liveness, Liveness::Live);
    assert!(matches!(
        view.entries[&entry("new")].projection,
        Projection::Recovery {
            reason: RecoveryReason::ParentUnavailable,
            ..
        }
    ));
}

#[test]
fn concurrent_delete_and_edit_retains_content_until_explicit_restore() {
    let file = create("file", None, "a", EntryKind::File);
    let deleted = event("deleted", &file, &["file-create"], Effect::Delete);
    let edited = event(
        "edited",
        &file,
        &["file-create"],
        Effect::SetContent {
            content: empty_manifest(),
        },
    );
    let state = append(&append(&append(&initial(), file.clone()), deleted), edited);
    let view = state.view().unwrap();
    assert_eq!(
        view.entries[&entry("file")].liveness,
        Liveness::DeleteConflict
    );
    assert_eq!(view.entries[&entry("file")].contents.len(), 1);
    let restore = event(
        "restored",
        &file,
        &["deleted", "edited"],
        Effect::Restore {
            location: location(None, "restored"),
        },
    );
    assert_eq!(
        append(&state, restore).view().unwrap().entries[&entry("file")].liveness,
        Liveness::Live
    );
    let illegal = event(
        "implicit-restore",
        &file,
        &["deleted", "edited"],
        Effect::Move {
            location: location(None, "oops"),
        },
    );
    assert_eq!(
        plan_authored(&state, &one(illegal), version("next")).unwrap_err(),
        Error::InvalidCausality
    );
}

#[test]
fn duplicate_exact_wire_and_cas_do_not_create_received_authored_intents() {
    let payload = one(create("file", None, "file", EntryKind::File));
    let incoming = auth(&payload, 1);
    let before = initial();
    let first = plan_received(&before, &incoming, None, version("first")).unwrap();
    first.check_preconditions(&before, None).unwrap();
    let state = first.next_state.unwrap();
    let duplicate = plan_received(
        &state,
        &incoming,
        Some(&first.received_record),
        state.version.clone(),
    )
    .unwrap();
    assert!(duplicate.next_state.is_none());
    let json = serde_json::to_value(&duplicate).unwrap();
    assert!(json.get("authored").is_none() && json.get("outbox").is_none());
    assert_eq!(
        duplicate.check_preconditions(&state, None).unwrap_err(),
        Error::DuplicateMismatch
    );
    assert_eq!(
        plan_received(
            &state,
            &auth(&payload, 2),
            Some(&first.received_record),
            version("next")
        )
        .unwrap_err(),
        Error::DuplicateMismatch
    );
    let authored = plan_authored(&before, &payload, version("authored")).unwrap();
    assert_eq!(
        authored.check_preconditions(&state, true).unwrap_err(),
        Error::VersionConflict
    );
    assert_eq!(
        authored.check_preconditions(&before, false).unwrap_err(),
        Error::DuplicateMismatch
    );
}

#[test]
fn missing_chunks_are_durable_pending_and_bad_bytes_never_materialize() {
    let file = create("file", None, "file", EntryKind::File);
    let (manifest, pieces) = contents("data", &[0, 255, 1, 0]);
    let write = event(
        "write",
        &file,
        &["file-create"],
        Effect::SetContent {
            content: manifest.clone(),
        },
    );
    let state = append(&append(&initial(), file), write);
    assert!(state.materialize(&manifest).unwrap().is_none());
    assert_eq!(
        state.view().unwrap().entries[&entry("file")].contents[0]
            .status
            .missing,
        BTreeSet::from([id("data-page")])
    );
    let state = apply(&restart(&state), &pieces[0]);
    assert_eq!(
        state.view().unwrap().entries[&entry("file")].contents[0]
            .status
            .missing,
        BTreeSet::from([id("data-chunk")])
    );
    let mut bad = pieces[1].clone();
    bad.body = Body::Chunk {
        bytes: vec![0, 254, 1, 0],
    };
    assert_eq!(
        plan_received(&state, &auth(&bad, 1), None, version("bad")).unwrap_err(),
        Error::InvalidContent
    );
    let final_state = apply(&restart(&state), &pieces[1]);
    assert_eq!(
        final_state.materialize(&manifest).unwrap().unwrap(),
        [0, 255, 1, 0]
    );
}

#[test]
fn folder_name_collision_recovers_descendants_without_crossing_parent_identity() {
    let a = create("a", None, "same", EntryKind::Folder);
    let b = create("b", None, "same", EntryKind::Folder);
    let child = create("child", Some("b"), "child", EntryKind::File);
    let state = append(&append(&append(&initial(), b), child), a);
    let view = state.view().unwrap();
    assert!(matches!(
        view.entries[&entry("a")].projection,
        Projection::Normal { .. }
    ));
    assert!(matches!(
        view.entries[&entry("b")].projection,
        Projection::Recovery {
            reason: RecoveryReason::NameCollision,
            ..
        }
    ));
    assert!(matches!(
        view.entries[&entry("child")].projection,
        Projection::Recovery {
            reason: RecoveryReason::NameCollision,
            ..
        }
    ));
}

#[test]
fn concurrent_folder_cycle_is_retained_in_recovery() {
    let a = create("a", None, "a", EntryKind::Folder);
    let b = create("b", None, "b", EntryKind::Folder);
    let move_a = event(
        "move-a",
        &a,
        &["a-create"],
        Effect::Move {
            location: location(Some("b"), "a"),
        },
    );
    let move_b = event(
        "move-b",
        &b,
        &["b-create"],
        Effect::Move {
            location: location(Some("a"), "b"),
        },
    );
    let state = append(&append(&append(&append(&initial(), a), b), move_a), move_b);
    for entry in state.view().unwrap().entries.values() {
        assert!(matches!(
            entry.projection,
            Projection::Recovery {
                reason: RecoveryReason::Cycle,
                ..
            }
        ));
    }
}

#[test]
fn causal_cycles_cross_entry_parents_and_bootstrap_reuse_fail_closed() {
    let a = create("a", None, "a", EntryKind::File);
    let b = create("b", None, "b", EntryKind::File);
    let base = append(&append(&initial(), a.clone()), b);
    let cross = event("cross", &a, &["b-create"], Effect::Delete);
    assert_eq!(
        plan_authored(&base, &one(cross), version("bad")).unwrap_err(),
        Error::IdentityMismatch
    );
    let mut reused = create("a", None, "other", EntryKind::File);
    reused.id = id("other-bootstrap");
    reused.identity.bootstrap_id = reused.id.clone();
    assert_eq!(
        plan_authored(&base, &one(reused), version("bad")).unwrap_err(),
        Error::IdentityMismatch
    );
    let first = event("cycle-a", &a, &["cycle-b", "missing"], Effect::Delete);
    let second = event("cycle-b", &a, &["cycle-a"], Effect::Delete);
    let pending = append(&base, first);
    assert_eq!(
        plan_authored(&pending, &one(second), version("bad")).unwrap_err(),
        Error::InvalidCausality
    );
}

#[test]
fn schema_bounds_scope_and_payload_identity_are_checked() {
    let payload = one(create("file", None, "file", EntryKind::File));
    let mut value = serde_json::to_value(&payload).unwrap();
    value["unknown"] = true.into();
    assert_eq!(
        Payload::decode(&serde_json::to_vec(&value).unwrap()).unwrap_err(),
        Error::InvalidPayload
    );
    let mut future = payload.clone();
    future.format_version = 2;
    assert_eq!(future.encode().unwrap_err(), Error::UnsupportedFormat);
    let mut other = payload.clone();
    other.scope.vault_id = VaultId::new("other").unwrap();
    assert_eq!(
        plan_authored(&initial(), &other, version("next")).unwrap_err(),
        Error::IdentityMismatch
    );
    let large = self::payload(
        "large",
        Body::Chunk {
            bytes: vec![0; MAX_CHUNK_BYTES + 1],
        },
    );
    assert_eq!(large.encode().unwrap_err(), Error::TooLarge);
    let mut changed = payload.clone();
    changed.id = id("wrong");
    let header = Header::new(
        scope().realm_id,
        scope().vault_id,
        payload.id.clone(),
        DeviceId::new("device").unwrap(),
        1,
    )
    .unwrap();
    let wire = zorid_crypto::seal(
        &header,
        &changed.encode().unwrap(),
        &VaultKey::from_bytes([7; 32]),
        &mut FixtureEntropy(1),
    )
    .unwrap()
    .encode();
    assert!(matches!(
        AuthenticatedPayload::open(
            &wire,
            &ExpectedContext {
                realm_id: scope().realm_id,
                vault_id: scope().vault_id,
                update_id: payload.id,
                key_epoch: 1
            },
            &VaultKey::from_bytes([7; 32])
        ),
        Err(Error::IdentityMismatch)
    ));
}

#[test]
fn authenticated_shared_capability_and_authored_echo_require_exact_wire() {
    let payload = one(create("file", None, "file", EntryKind::File));
    let incoming = auth(&payload, 1);
    let expected = ExpectedContext {
        realm_id: scope().realm_id,
        vault_id: scope().vault_id,
        update_id: payload.id.clone(),
        key_epoch: 1,
    };
    let opened = OpenedEnvelope::open(
        &incoming.record.exact_wire,
        &expected,
        &VaultKey::from_bytes([7; 32]),
    )
    .unwrap();
    let decoded = AuthenticatedPayload::from_opened(&opened).unwrap();
    assert_eq!(decoded.record, incoming.record);
    assert_eq!(decoded.payload, payload);
    let authored = plan_authored(&initial(), &payload, version("authored")).unwrap();
    assert_eq!(
        plan_received(&authored.next_state, &decoded, None, version("echo")).unwrap_err(),
        Error::DuplicateMismatch
    );
    let echoed = plan_received(
        &authored.next_state,
        &decoded,
        Some(&incoming.record),
        version("echo"),
    )
    .unwrap();
    assert!(echoed.next_state.is_none());
}

#[test]
fn wide_causal_frontiers_resolve_once_and_keep_all_concurrent_locations() {
    let create = create("file", None, "file", EntryKind::File);
    let mut state = initial();
    let first = one(create.clone());
    state.records.insert(first.id.clone(), first);
    let mut parents = vec![create.id.clone()];
    // Valid near-limit layered DAG. Construct persisted records directly so this
    // tests one complete rebuild, not thousands of repeated whole-state plans.
    for layer in 0..31 {
        let events: Vec<_> = (0..128)
            .map(|n| EntryEvent {
                id: id(&format!("event-{layer:02}-{n:03}")),
                identity: create.identity.clone(),
                parents: parents.clone(),
                effect: Effect::Move {
                    location: location(None, &format!("file-{layer}-{n}")),
                },
            })
            .collect();
        parents = events.iter().map(|e| e.id.clone()).collect();
        let record = payload(&format!("layer-{layer}"), Body::Events { events });
        state.records.insert(record.id.clone(), record);
    }
    let view = restart(&state).view().unwrap();
    assert!(view.pending.is_empty());
    assert_eq!(view.entries[&entry("file")].heads.len(), 128);
    assert_eq!(view.entries[&entry("file")].locations.len(), 128);
}

#[test]
fn unknown_or_legacy_family_is_explicitly_unsupported_without_relaxing_schema() {
    let payload = one(create("file", None, "file", EntryKind::File));
    let mut value = serde_json::to_value(&payload).unwrap();
    value.as_object_mut().unwrap().remove("family");
    assert_eq!(
        Payload::decode(&serde_json::to_vec(&value).unwrap()).unwrap_err(),
        Error::UnsupportedFormat
    );
    value["family"] = "text".into();
    assert_eq!(
        Payload::decode(&serde_json::to_vec(&value).unwrap()).unwrap_err(),
        Error::UnsupportedFormat
    );
    value["family"] = "files".into();
    value.as_object_mut().unwrap().remove("format_version");
    assert_eq!(
        Payload::decode(&serde_json::to_vec(&value).unwrap()).unwrap_err(),
        Error::UnsupportedFormat
    );
    let encoded = String::from_utf8(payload.encode().unwrap()).unwrap();
    let duplicate = encoded.replacen("{", "{\"family\":\"files\",", 1);
    assert_eq!(
        Payload::decode(duplicate.as_bytes()).unwrap_err(),
        Error::InvalidPayload
    );
}

#[test]
fn repeated_binary_versions_share_verified_content_without_losing_history() {
    let create = create("file", None, "file", EntryKind::File);
    let (manifest, pieces) = contents("shared", &vec![0x8f; MAX_CHUNK_BYTES]);
    let mut state = initial();
    for piece in pieces {
        state.records.insert(piece.id.clone(), piece);
    }
    let seed = one(create.clone());
    state.records.insert(seed.id.clone(), seed);
    let mut parent = create.id.clone();
    for n in 0..128 {
        let e = EntryEvent {
            id: id(&format!("write-{n:03}")),
            identity: create.identity.clone(),
            parents: vec![parent],
            effect: Effect::SetContent {
                content: manifest.clone(),
            },
        };
        parent = e.id.clone();
        let record = one(e);
        state.records.insert(record.id.clone(), record);
    }
    let restored = restart(&state);
    let view = restored.view().unwrap();
    assert_eq!(view.entries[&entry("file")].contents.len(), 1);
    assert_eq!(view.entries[&entry("file")].heads, vec![id("write-127")]);
    assert_eq!(restored.records.len(), 131);
    assert_eq!(
        restored.materialize(&manifest).unwrap().unwrap(),
        vec![0x8f; MAX_CHUNK_BYTES]
    );
}
