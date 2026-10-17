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
