//! Concrete Store readers, never synthetic source/authority capabilities.
use super::*;
use family_graph_read::{EventSelector, GraphSnapshot, Work};
use zorid_core::{OperationId, VaultPath};
use zorid_file_sync::Scope;
use zorid_sync_protocol::{RealmId, UpdateId, VaultId};

fn scope() -> Scope {
    Scope {
        realm_id: RealmId::new("reader-realm").unwrap(),
        vault_id: VaultId::new("reader-vault").unwrap(),
    }
}
fn id(value: &str) -> EntryId {
    EntryId::new(value).unwrap()
}
fn create(store: &mut Store, value: &str) {
    store
        .family_apply(
            &MutationRequest {
                operation_id: OperationId::new(format!("create-{value}")).unwrap(),
                mutation: Mutation::Create {
                    id: id(value),
                    path: VaultPath::new(format!("{value}.md")).unwrap(),
                    kind: EntryKind::File,
                    content: Some(b"first".to_vec()),
                },
            },
            Some(FamilyCreateMode::Text),
        )
        .unwrap();
}
fn fixture() -> (tempfile::TempDir, Store) {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path().join("db")).unwrap();
    store.family_enroll(&scope()).unwrap();
    create(&mut store, "a");
    create(&mut store, "b");
    (directory, store)
}
fn admit(_: Work) -> Result<()> {
    Ok(())
}
fn event_id(store: &Store, entry: &str) -> UpdateId {
    UpdateId::new(store.connection.query_row(
        "SELECT event_id FROM family_graph_events WHERE entry_id=?1 ORDER BY event_id LIMIT 1",
        [entry], |row| row.get::<_, String>(0),
    ).unwrap()).unwrap()
}
fn replace_event_record(store: &Store, event: &UpdateId) {
    store
        .connection
        .execute_batch("DROP TRIGGER family_graph_events_no_update")
        .unwrap();
    store
        .connection
        .execute(
            "UPDATE family_graph_events SET record='{}' WHERE event_id=?1",
            [event.as_str()],
        )
        .unwrap();
    store
        .connection
        .execute_batch(
            family_graph::SCHEMA
                .iter()
                .find(|(name, _)| *name == "family_graph_events_no_update")
                .unwrap()
                .1,
        )
        .unwrap();
}

#[test]
fn factory_requires_actual_transaction_and_admitted_scope() {
    let (_directory, store) = fixture();
    assert!(matches!(
        GraphSnapshot::open(&store.connection, &scope()),
        Err(StoreError::Corrupt(_))
    ));
    let tx = store.connection.unchecked_transaction().unwrap();
    let foreign = Scope {
        vault_id: VaultId::new("foreign-vault").unwrap(),
        ..scope()
    };
    // A real but foreign head/state pair cannot admit a reader for that scope.
    file_state::initialize(&tx, &foreign, &Revision::new("foreign-head").unwrap()).unwrap();
    assert!(matches!(
        GraphSnapshot::open(&tx, &foreign),
        Err(StoreError::Sync(
            zorid_client_sync::SyncError::IdentityMismatch
        ))
    ));
    let reader = GraphSnapshot::open(&tx, &scope()).unwrap();
    assert_eq!(reader.scope(), &scope());
    assert_eq!(reader.source_count(), 4);
    assert_eq!(reader.event_count(), 4);
    assert_eq!(reader.entry_count(), 2);
    assert!(!reader.revision().as_str().is_empty());
}

#[test]
fn target_reads_do_not_scrub_unrelated_corrupt_facts() {
    let (_directory, store) = fixture();
    let damaged = event_id(&store, "a");
    let valid = event_id(&store, "b");
    replace_event_record(&store, &damaged);
    let tx = store.connection.unchecked_transaction().unwrap();
    let reader = GraphSnapshot::open(&tx, &scope()).unwrap();
    assert_eq!(
        reader
            .require_event(&valid, &mut admit)
            .unwrap()
            .identity()
            .entry_id,
        id("b")
    );
    assert!(matches!(
        reader.require_event(&damaged, &mut admit),
        Err(StoreError::Corrupt(_))
    ));
    let absent = UpdateId::new("absent").unwrap();
    assert!(reader.event(&absent, &mut admit).unwrap().is_none());
    assert!(matches!(
        reader.require_event(&absent, &mut admit),
        Err(StoreError::Corrupt(_))
    ));
}

#[test]
fn source_admission_precedes_descriptor_decoding() {
    let (_directory, store) = fixture();
    let source: String = store
        .connection
        .query_row(
            "SELECT source_id FROM family_graph_sources WHERE kind='events' LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    store
        .connection
        .execute_batch("DROP TRIGGER immutable_payloads_no_update")
        .unwrap();
    store
        .connection
        .execute(
            "UPDATE immutable_payloads SET descriptor='bad' WHERE update_id=?1",
            [&source],
        )
        .unwrap();
    store
        .connection
        .execute_batch(
            immutable_payloads::SCHEMA
                .iter()
                .find(|(name, _)| *name == "immutable_payloads_no_update")
                .unwrap()
                .1,
        )
        .unwrap();
    let tx = store.connection.unchecked_transaction().unwrap();
    let reader = GraphSnapshot::open(&tx, &scope()).unwrap();
    let mut denied = false;
    let error = reader.source(&UpdateId::new(source).unwrap(), &mut |work| {
        if let Work::SourceBytes(bytes) = work {
            assert!(bytes > 0);
            denied = true;
            return Err(zorid_file_sync::Error::TooLarge.into());
        }
        Ok(())
    });
    assert!(denied);
    assert!(matches!(
        error,
        Err(StoreError::FileSync(zorid_file_sync::Error::TooLarge))
    ));
}

#[test]
fn selected_source_ordinal_and_head_changes_are_fenced() {
    let (_directory, store) = fixture();
    let event = event_id(&store, "a");
    store
        .connection
        .execute_batch("DROP TRIGGER family_graph_events_no_update")
        .unwrap();
    store
        .connection
        .execute(
            "UPDATE family_graph_events SET ordinal=127 WHERE event_id=?1",
            [event.as_str()],
        )
        .unwrap();
    store
        .connection
        .execute_batch(
            family_graph::SCHEMA
                .iter()
                .find(|(name, _)| *name == "family_graph_events_no_update")
                .unwrap()
                .1,
        )
        .unwrap();
    let tx = store.connection.unchecked_transaction().unwrap();
    let reader = GraphSnapshot::open(&tx, &scope()).unwrap();
    assert!(matches!(
        reader.require_event(&event, &mut admit),
        Err(StoreError::Corrupt(_))
    ));
    tx.execute("UPDATE family_graph_heads SET revision='later'", [])
        .unwrap();
    tx.execute("UPDATE family_graph_state SET revision='later'", [])
        .unwrap();
    assert!(matches!(
        reader.check_current(),
        Err(StoreError::Sync(
            zorid_client_sync::SyncError::VersionConflict
        ))
    ));
}

#[test]
fn entry_and_role_keysets_exhaust_without_truncation_or_cursor_rebinding() {
    let (_directory, mut store) = fixture();
    for index in 0..33 {
        let expected = store.read(&id("a")).unwrap().unwrap().state.revision;
        store
            .family_apply(
                &MutationRequest {
                    operation_id: OperationId::new(format!("write-{index}")).unwrap(),
                    mutation: Mutation::Write {
                        id: id("a"),
                        expected,
                        content: format!("body-{index}").into_bytes(),
                    },
                },
                None,
            )
            .unwrap();
    }
    let tx = store.connection.unchecked_transaction().unwrap();
    let reader = GraphSnapshot::open(&tx, &scope()).unwrap();
    let selector = EventSelector::Entry(id("a"));
    let first = reader.events(&selector, None, &mut admit).unwrap();
    assert_eq!(first.events.len(), 32);
    assert!(first.cursor.is_some());
    assert!(matches!(
        reader.events(
            &EventSelector::Entry(id("b")),
            first.cursor.as_ref(),
            &mut admit
        ),
        Err(StoreError::Corrupt(_))
    ));
    let mut all = first.events;
    let mut cursor = first.cursor;
    while let Some(next) = cursor {
        let page = reader.events(&selector, Some(&next), &mut admit).unwrap();
        all.extend(page.events);
        cursor = page.cursor;
    }
    assert_eq!(all.len(), 35);
    assert!(all.windows(2).all(|pair| pair[0].id() < pair[1].id()));
    assert!(all.iter().all(|event| event.identity().entry_id == id("a")));
    let bootstrap = all[0].identity().bootstrap_id.clone();
    let first = reader.roles(&bootstrap, None, &mut admit).unwrap();
    assert_eq!(first.claims.len(), 32);
    assert!(first.cursor.is_some());
    assert!(matches!(
        reader.roles(
            &UpdateId::new("other").unwrap(),
            first.cursor.as_ref(),
            &mut admit
        ),
        Err(StoreError::Corrupt(_))
    ));
    let mut claims = first.claims;
    let mut cursor = first.cursor;
    while let Some(next) = cursor {
        let page = reader.roles(&bootstrap, Some(&next), &mut admit).unwrap();
        claims.extend(page.claims);
        cursor = page.cursor;
    }
    assert!(claims.len() > 32);
    assert!(claims
        .iter()
        .all(|claim| claim.facts().claims()[claim.ordinal()].id() == &bootstrap));
    let children = reader
        .events(
            &EventSelector::Children(bootstrap.clone()),
            None,
            &mut admit,
        )
        .unwrap();
    assert!(children
        .events
        .iter()
        .all(|event| event.parents().contains(&bootstrap)));
}

#[test]
fn event_output_admission_can_cancel_without_returning_a_prefix() {
    let (_directory, store) = fixture();
    let tx = store.connection.unchecked_transaction().unwrap();
    let reader = GraphSnapshot::open(&tx, &scope()).unwrap();
    let mut retained = 0;
    let result = reader.events(&EventSelector::Entry(id("a")), None, &mut |work| {
        if let Work::RetainBytes(bytes) = work {
            assert!(bytes > 0);
            retained += 1;
            if retained == 2 {
                return Err(zorid_file_sync::Error::TooLarge.into());
            }
        }
        Ok(())
    });
    assert_eq!(retained, 2);
    assert!(matches!(
        result,
        Err(StoreError::FileSync(zorid_file_sync::Error::TooLarge))
    ));
}

#[test]
fn pending_entry_index_uses_actual_source_identity_and_fences_resolution() {
    let (directory, mut author) = fixture();
    let mut receiver = Store::open(directory.path().join("receiver")).unwrap();
    receiver.family_enroll(&scope()).unwrap();
    let source = |kind: &str| -> UpdateId {
        UpdateId::new(author.connection.query_row(
            "SELECT e.source_id FROM family_graph_events e JOIN family_graph_sources s ON s.realm_id=e.realm_id AND s.vault_id=e.vault_id AND s.source_id=e.source_id WHERE e.entry_id='a' AND s.kind=?1",
            [kind], |row| row.get::<_, String>(0),
        ).unwrap()).unwrap()
    };
    let text = source("text");
    let files = source("events");
    let mut packet = |update_id| {
        let expected = zorid_sync_protocol::ExpectedContext {
            realm_id: scope().realm_id,
            vault_id: scope().vault_id,
            update_id,
            key_epoch: 1,
        };
        let key = zorid_crypto::VaultKey::from_bytes([7; 32]);
        let wire = author.family_seal(&expected, &key).unwrap();
        zorid_crypto::OpenedEnvelope::open(&wire, &expected, &key).unwrap()
    };
    let text_packet = packet(text.clone());
    let file_packet = packet(files.clone());
    receiver.family_receive(&text_packet, None).unwrap();
    let tx = receiver.connection.unchecked_transaction().unwrap();
    let reader = GraphSnapshot::open(&tx, &scope()).unwrap();
    let pending = reader
        .events(&EventSelector::Pending(id("a")), None, &mut admit)
        .unwrap();
    assert_eq!(pending.events.len(), 1);
    assert_eq!(pending.events[0].id(), &text);
    assert!(reader
        .events(&EventSelector::Pending(id("b")), None, &mut admit)
        .unwrap()
        .events
        .is_empty());
    drop(reader);
    tx.commit().unwrap();
    receiver
        .connection
        .execute("UPDATE family_graph_pending SET entry_id='b'", [])
        .unwrap();
    let expected = blob_index::load_metadata(&receiver.connection, &scope()).unwrap();
    let tx = receiver.connection.unchecked_transaction().unwrap();
    let reader = GraphSnapshot::open(&tx, &scope()).unwrap();
    assert!(matches!(
        reader.events(&EventSelector::Pending(id("b")), None, &mut admit),
        Err(StoreError::Corrupt(_))
    ));
    drop(reader);
    tx.commit().unwrap();
    assert!(matches!(
        receiver.family_receive(&file_packet, None),
        Err(StoreError::Corrupt(_))
    ));
    assert_eq!(
        blob_index::load_metadata(&receiver.connection, &scope()).unwrap(),
        expected
    );
    assert!(family_ledger::metadata_only(
        &receiver.connection,
        &family_ledger::EnvelopeKey {
            realm_id: scope().realm_id,
            vault_id: scope().vault_id,
            update_id: files,
        }
    )
    .unwrap()
    .is_none());
    assert_eq!(
        receiver
            .connection
            .query_row("SELECT entry_id FROM family_graph_pending", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap(),
        "b"
    );
}

#[test]
fn retained_unpublished_bytes_are_not_members_and_missing_known_members_fail() {
    let (_directory, store) = fixture();
    let staged = UpdateId::new("unpublished").unwrap();
    let payload = zorid_file_sync::v2::Payload {
        family: zorid_file_sync::Family::Files,
        format_version: 2,
        scope: scope(),
        id: staged.clone(),
        body: zorid_file_sync::v2::Body::Chunk {
            bytes: b"staged".to_vec(),
        },
    };
    let exact = payload.encode().unwrap();
    let record = zorid_file_sync::metadata::GraphRecord::from_authored_exact(&exact)
        .unwrap()
        .2;
    immutable_payloads::put_exact(
        &store.connection,
        &family_ledger::EnvelopeMetadata {
            key: family_ledger::EnvelopeKey {
                realm_id: scope().realm_id,
                vault_id: scope().vault_id,
                update_id: staged.clone(),
            },
            family: family_ledger::Family::Files,
            format_version: 2,
            payload_digest: zorid_file_sync::Sha256Digest::of(&exact),
            payload_bytes: exact.len() as u32,
            file_summary_digest: Some(record.summary_digest().unwrap()),
            text_binding: None,
        },
        &exact,
        100_000,
    )
    .unwrap();
    let known: String = store
        .connection
        .query_row(
            "SELECT source_id FROM family_graph_sources WHERE kind='events' LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let known = UpdateId::new(known).unwrap();
    let tx = store.connection.unchecked_transaction().unwrap();
    let reader = GraphSnapshot::open(&tx, &scope()).unwrap();
    assert!(reader.member(&staged, &mut admit).unwrap().is_none());
    assert!(reader.member(&known, &mut admit).unwrap().is_some());
    tx.execute(
        "DELETE FROM family_file_records WHERE update_id=?1",
        [known.as_str()],
    )
    .unwrap();
    assert!(matches!(
        reader.member(&known, &mut admit),
        Err(StoreError::Corrupt(_))
    ));
}
