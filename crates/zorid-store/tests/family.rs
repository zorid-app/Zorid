//! Current-format integration fixtures use fresh temporary authorities only.
use zorid_core::{EntryId, EntryKind, Mutation, MutationRequest, OperationId, VaultPath};
use zorid_crypto::{OpenedEnvelope, VaultKey};
use zorid_store::{FamilyCreateMode, FamilyPayloadKind, FamilyPublication, FamilyScope, Store};
use zorid_sync_protocol::{ExpectedContext, LogPosition, RealmId, ServerEpoch, VaultId};
fn scope() -> FamilyScope {
    FamilyScope {
        realm_id: RealmId::new("realm").unwrap(),
        vault_id: VaultId::new("vault").unwrap(),
    }
}
fn create(id: &str, path: &str, bytes: &[u8]) -> MutationRequest {
    MutationRequest {
        operation_id: OperationId::new(format!("create_{id}")).unwrap(),
        mutation: Mutation::Create {
            id: EntryId::new(id).unwrap(),
            path: VaultPath::new(path).unwrap(),
            kind: EntryKind::File,
            content: Some(bytes.to_vec()),
        },
    }
}
fn wires(store: &mut Store) -> Vec<(FamilyPayloadKind, ExpectedContext, Vec<u8>)> {
    store
        .family_pending_authored(None, 1000)
        .unwrap()
        .into_iter()
        .map(|p| {
            let expected = ExpectedContext {
                realm_id: p.scope.realm_id,
                vault_id: p.scope.vault_id,
                update_id: p.update_id,
                key_epoch: 1,
            };
            let bytes = store
                .family_seal(&expected, &VaultKey::from_bytes([7; 32]))
                .unwrap();
            (p.family, expected, bytes)
        })
        .collect()
}
fn open(expected: &ExpectedContext, bytes: &[u8]) -> OpenedEnvelope {
    OpenedEnvelope::open(bytes, expected, &VaultKey::from_bytes([7; 32])).unwrap()
}
#[test]
fn single_existing_text_write_invalidates_one_file_and_replays_without_another_event() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a");
    let mut store = Store::open(&path).unwrap();
    store.family_enroll(&scope()).unwrap();
    let initial = store.list_snapshot().unwrap();
    store
        .family_apply(
            &create("text", "note.md", b"before\r\n"),
            Some(FamilyCreateMode::Text),
        )
        .unwrap();
    assert!(store
        .changes_after(&initial.cursor, 100)
        .unwrap()
        .changes
        .iter()
        .any(|event| event.requires_full_reload));
    let file = VaultPath::new("note.md").unwrap();
    let before = store.read_path(&file).unwrap().unwrap();
    let baseline = store.list_snapshot().unwrap();
    let bytes = "after β\r\n\r\nUnrelated body stays exact.\r\n".as_bytes();
    let request = MutationRequest {
        operation_id: OperationId::new("scoped-text-write").unwrap(),
        mutation: Mutation::Write {
            id: before.state.id.clone(),
            expected: before.state.revision.clone(),
            content: bytes.to_vec(),
        },
    };
    let receipt = store.family_apply(&request, None).unwrap();
    assert_eq!(receipt.changes.len(), 1);
    let after = store.read_path(&file).unwrap().unwrap();
    assert_eq!(after.content.as_deref(), Some(bytes));
    assert_ne!(after.state.revision, before.state.revision);
    assert_eq!(after.state.id, before.state.id);
    assert_eq!(after.state.path, before.state.path);
    assert_eq!(after.presentation.ctime_ms, before.presentation.ctime_ms);
    assert!(after.presentation.mtime_ms >= before.presentation.mtime_ms);
    assert_eq!(after.presentation.size_bytes, bytes.len() as u64);
    let page = store.changes_after(&baseline.cursor, 100).unwrap();
    assert_eq!(page.changes.len(), 1);
    let event = &page.changes[0];
    assert!(!event.requires_full_reload);
    assert_eq!(
        event.origin,
        zorid_store::ChangeOrigin::LocalCommand {
            operation_id: request.operation_id.clone()
        }
    );
    assert_eq!(event.entries.len(), 1);
    assert_eq!(event.entries[0].state, after.state);
    assert_eq!(event.entries[0].presentation, after.presentation);
    let peer = Store::open(&path).unwrap();
    assert_eq!(peer.changes_after(&baseline.cursor, 100).unwrap(), page);
    drop(store);
    let mut store = Store::open(&path).unwrap();
    assert_eq!(store.family_apply(&request, None).unwrap(), receipt);
    assert_eq!(store.changes_after(&baseline.cursor, 100).unwrap(), page);
    let stale = MutationRequest {
        operation_id: OperationId::new("stale-scoped-write").unwrap(),
        mutation: request.mutation.clone(),
    };
    assert!(store.family_apply(&stale, None).is_err());
    assert_eq!(store.changes_after(&baseline.cursor, 100).unwrap(), page);
}

#[test]
fn ancestor_and_namespace_changes_keep_full_reload_journals() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    store.family_enroll(&scope()).unwrap();
    let folder = MutationRequest {
        operation_id: OperationId::new("create-folder").unwrap(),
        mutation: Mutation::Create {
            id: EntryId::new("folder").unwrap(),
            path: VaultPath::new("P").unwrap(),
            kind: EntryKind::Folder,
            content: None,
        },
    };
    store.family_apply(&folder, None).unwrap();
    let baseline = store.list_snapshot().unwrap();
    store
        .family_apply(
            &create("nested", "P/note.md", b"before"),
            Some(FamilyCreateMode::Text),
        )
        .unwrap();
    assert!(store
        .changes_after(&baseline.cursor, 100)
        .unwrap()
        .changes
        .iter()
        .any(|event| event.requires_full_reload));
    let id = EntryId::new("nested").unwrap();
    for (op, kind) in [
        ("nested-write", 0),
        ("nested-move", 1),
        ("nested-delete", 2),
    ] {
        let current = store.read(&id).unwrap().unwrap().state;
        let baseline = store.list_snapshot().unwrap();
        let mutation = match kind {
            0 => Mutation::Write {
                id: id.clone(),
                expected: current.revision,
                content: b"after".to_vec(),
            },
            1 => Mutation::Move {
                id: id.clone(),
                expected: current.revision,
                path: VaultPath::new("moved.md").unwrap(),
            },
            _ => Mutation::Delete {
                id: id.clone(),
                expected: current.revision,
                recursive: false,
            },
        };
        let receipt = store
            .family_apply(
                &MutationRequest {
                    operation_id: OperationId::new(op).unwrap(),
                    mutation,
                },
                None,
            )
            .unwrap();
        if kind == 0 {
            assert!(
                receipt.changes.len() > 1,
                "nested writes also change ancestor revisions"
            );
        }
        let page = store.changes_after(&baseline.cursor, 100).unwrap();
        assert!(
            page.changes.iter().any(|event| event.requires_full_reload),
            "{op} must retain full reload"
        );
    }
}

#[test]
fn received_text_write_retains_full_reload_fallback() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = Store::open(dir.path().join("a")).unwrap();
    let mut b = Store::open(dir.path().join("b")).unwrap();
    a.family_enroll(&scope()).unwrap();
    b.family_enroll(&scope()).unwrap();
    a.family_apply(
        &create("text", "note.md", b"before"),
        Some(FamilyCreateMode::Text),
    )
    .unwrap();
    for (_, expected, wire) in wires(&mut a) {
        b.family_receive(&open(&expected, &wire), None).unwrap();
    }
    let baseline = b.list_snapshot().unwrap();
    let id = EntryId::new("text").unwrap();
    let current = a.read(&id).unwrap().unwrap().state;
    a.family_apply(
        &MutationRequest {
            operation_id: OperationId::new("remote-text-write").unwrap(),
            mutation: Mutation::Write {
                id: id.clone(),
                expected: current.revision,
                content: b"after\r\n".to_vec(),
            },
        },
        None,
    )
    .unwrap();
    for (_, expected, wire) in wires(&mut a) {
        b.family_receive(&open(&expected, &wire), None).unwrap();
    }
    assert_eq!(
        b.read(&id).unwrap().unwrap().content.as_deref(),
        Some(b"after\r\n".as_slice())
    );
    let page = b.changes_after(&baseline.cursor, 100).unwrap();
    assert!(page.changes.iter().any(|event| event.requires_full_reload));
}

#[test]
fn indexed_text_journal_failure_rolls_back_publication_and_exact_retry() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a");
    let mut store = Store::open(&path).unwrap();
    store.family_enroll(&scope()).unwrap();
    store
        .family_apply(
            &create("text", "note.md", b"before"),
            Some(FamilyCreateMode::Text),
        )
        .unwrap();
    let file = VaultPath::new("note.md").unwrap();
    let before = store.read_path(&file).unwrap().unwrap();
    let baseline = store.list_snapshot().unwrap();
    let materialization = store.family_materialization(&before.state.id).unwrap();
    let authored = store.family_pending_authored(None, 100).unwrap();
    let request = MutationRequest {
        operation_id: OperationId::new("retry-scoped-text").unwrap(),
        mutation: Mutation::Write {
            id: before.state.id.clone(),
            expected: before.state.revision.clone(),
            content: b"after".to_vec(),
        },
    };
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TRIGGER reject_text_invalidation BEFORE INSERT ON local_changes BEGIN SELECT RAISE(ABORT,'injected journal failure'); END;").unwrap();
    assert!(store.family_apply(&request, None).is_err());
    assert_eq!(store.read_path(&file).unwrap().unwrap(), before);
    assert_eq!(store.list_snapshot().unwrap(), baseline);
    assert_eq!(
        store.family_materialization(&before.state.id).unwrap(),
        materialization
    );
    assert_eq!(store.family_pending_authored(None, 100).unwrap(), authored);
    db.execute_batch("DROP TRIGGER reject_text_invalidation")
        .unwrap();
    let receipt = store.family_apply(&request, None).unwrap();
    assert_eq!(
        store.read_path(&file).unwrap().unwrap().content.as_deref(),
        Some(b"after".as_slice())
    );
    let page = store.changes_after(&baseline.cursor, 100).unwrap();
    assert_eq!(page.changes.len(), 1);
    assert!(!page.changes[0].requires_full_reload);
    assert_eq!(store.family_apply(&request, None).unwrap(), receipt);
    assert_eq!(store.changes_after(&baseline.cursor, 100).unwrap(), page);
}

#[test]
fn actual_family_commands_receive_restart_and_exact_replay_preserve_authority() {
    let dir = tempfile::tempdir().unwrap();
    let a_path = dir.path().join("a");
    let b_path = dir.path().join("b");
    let mut a = Store::open(&a_path).unwrap();
    let mut b = Store::open(&b_path).unwrap();
    a.family_enroll(&scope()).unwrap();
    b.family_enroll(&scope()).unwrap();
    let request = create("text", "note.md", "hello 🦀\r\n".as_bytes());
    let receipt = a
        .family_apply(&request, Some(FamilyCreateMode::Text))
        .unwrap();
    assert_eq!(
        a.family_apply(&request, Some(FamilyCreateMode::Text))
            .unwrap(),
        receipt
    );
    assert!(matches!(
        a.family_apply(&request, Some(FamilyCreateMode::Binary)),
        Err(zorid_store::StoreError::Contract(
            zorid_core::ContractError::IdempotencyConflict { .. }
        ))
    ));
    // A mode-bound family receipt does not authorize the generic legacy API.
    assert!(a.apply(&request).is_err());
    let mut packets = wires(&mut a);
    packets.sort_by_key(|(family, _, _)| {
        if *family == FamilyPayloadKind::Text {
            0
        } else {
            1
        }
    });
    let (_, expected, wire) = &packets[0];
    let first = b.family_receive(&open(expected, wire), None).unwrap();
    assert!(first.pending_prerequisites > 0);
    assert!(b.list().unwrap().is_empty());
    assert!(matches!(
        b.family_materialization(&EntryId::new("text").unwrap())
            .unwrap()
            .unwrap()
            .publication,
        FamilyPublication::Pending { .. }
    ));
    drop(b);
    b = Store::open(&b_path).unwrap();
    for (_, expected, wire) in &packets {
        b.family_receive(&open(expected, wire), None).unwrap();
    }
    let row = b.read(&EntryId::new("text").unwrap()).unwrap().unwrap();
    assert_eq!(row.content.as_deref(), Some("hello 🦀\r\n".as_bytes()));
    assert!(b.family_pending_authored(None, 100).unwrap().is_empty());
    let before = b.list_snapshot().unwrap();
    for (_, expected, wire) in &packets {
        assert!(
            b.family_receive(&open(expected, wire), None)
                .unwrap()
                .duplicate
        );
    }
    assert_eq!(b.list_snapshot().unwrap(), before);
    let binary = create("binary", ".hidden.unknown", &[0, 255, 1, 255]);
    a.family_apply(&binary, Some(FamilyCreateMode::Binary))
        .unwrap();
    for (_, expected, wire) in wires(&mut a) {
        b.family_receive(&open(&expected, &wire), None).unwrap();
    }
    assert_eq!(
        b.read(&EntryId::new("binary").unwrap())
            .unwrap()
            .unwrap()
            .content,
        Some(vec![0, 255, 1, 255])
    );
    assert_eq!(
        a.family_apply(&request, Some(FamilyCreateMode::Text))
            .unwrap(),
        receipt
    );
    let id = EntryId::new("text").unwrap();
    for (op, kind) in [("write_text", 0), ("move_text", 1), ("delete_text", 2)] {
        let current = a.read(&id).unwrap().unwrap().state;
        let mutation = match kind {
            0 => Mutation::Write {
                id: id.clone(),
                expected: current.revision,
                content: b"edited".to_vec(),
            },
            1 => Mutation::Move {
                id: id.clone(),
                expected: current.revision,
                path: VaultPath::new("renamed.md").unwrap(),
            },
            _ => Mutation::Delete {
                id: id.clone(),
                expected: current.revision,
                recursive: false,
            },
        };
        a.family_apply(
            &MutationRequest {
                operation_id: OperationId::new(op).unwrap(),
                mutation,
            },
            None,
        )
        .unwrap();
    }
    assert!(a.read(&id).unwrap().is_none());
    for (_, expected, wire) in wires(&mut a) {
        b.family_receive(&open(&expected, &wire), None).unwrap();
    }
    assert!(b.read(&id).unwrap().is_none());
    assert!(a.apply(&create("bypass", "bypass.md", b"no")).is_err());
}
#[test]
fn receive_failure_rolls_back_exact_wire_graph_visibility_and_cursor() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("receiver");
    let mut a = Store::open(dir.path().join("author")).unwrap();
    let mut b = Store::open(&path).unwrap();
    a.family_enroll(&scope()).unwrap();
    b.family_enroll(&scope()).unwrap();
    a.family_apply(
        &create("file", "note.md", b"body"),
        Some(FamilyCreateMode::Text),
    )
    .unwrap();
    let packet = wires(&mut a)
        .into_iter()
        .find(|p| p.0 == FamilyPayloadKind::Text)
        .unwrap();
    let cursor = zorid_client_sync::ReceiveCursor {
        realm_id: scope().realm_id,
        vault_id: scope().vault_id,
        server_epoch: ServerEpoch::new("epoch").unwrap(),
        after: LogPosition::new(0),
    };
    b.family_set_receive_cursor(None, &cursor).unwrap();
    b.family_set_receive_cursor(None, &cursor).unwrap();
    let mut skipped = cursor.clone();
    skipped.after = LogPosition::new(9);
    assert!(b
        .family_set_receive_cursor(Some(&cursor), &skipped)
        .is_err());
    let mut next = cursor.clone();
    next.after = LogPosition::new(1);
    let delivery = zorid_client_sync::CursorAdvance {
        expected: cursor.clone(),
        next: next.clone(),
    };
    let before = b.family_status().unwrap();
    let injected = rusqlite::Connection::open(&path).unwrap();
    injected.execute_batch("CREATE TRIGGER reject_family_cache BEFORE INSERT ON family_materializations BEGIN SELECT RAISE(ABORT,'fixture'); END").unwrap();
    assert!(b
        .family_receive(&open(&packet.1, &packet.2), Some(&delivery))
        .is_err());
    assert_eq!(b.family_status().unwrap(), before);
    assert!(b
        .family_envelope_status(&packet.1.update_id)
        .unwrap()
        .is_none());
    assert!(b.list().unwrap().is_empty());
    injected
        .execute_batch("DROP TRIGGER reject_family_cache")
        .unwrap();
    drop(injected);
    b.family_receive(&open(&packet.1, &packet.2), Some(&delivery))
        .unwrap();
    drop(b);
    let b = Store::open(&path).unwrap();
    assert_eq!(
        b.family_receive_cursor(&scope().realm_id, &scope().vault_id)
            .unwrap(),
        Some(next)
    );
    assert!(b
        .family_envelope_status(&packet.1.update_id)
        .unwrap()
        .is_some());
    let corrupt = rusqlite::Connection::open(&path).unwrap();
    corrupt
        .execute("DELETE FROM family_materializations", [])
        .unwrap();
    assert!(matches!(
        b.family_status(),
        Err(zorid_store::StoreError::Corrupt(_))
    ));
}
#[test]
fn obsolete_fixture_schema_rejection_does_not_change_database_bytes() {
    let dir = tempfile::tempdir().unwrap();
    for version in [1, 6, 7, 8, 9] {
        let path = dir.path().join(format!("old{version}"));
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch(
            "CREATE TABLE retained(value BLOB); INSERT INTO retained VALUES(x'00ff');",
        )
        .unwrap();
        db.pragma_update(None, "application_id", 0x5a4f5244)
            .unwrap();
        db.pragma_update(None, "user_version", version).unwrap();
        drop(db);
        let before = std::fs::read(&path).unwrap();
        assert!(
            matches!(Store::open(&path),Err(zorid_store::StoreError::UnsupportedSchema(v)) if v==version)
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(!path.with_file_name(format!("old{version}-wal")).exists());
    }
}
