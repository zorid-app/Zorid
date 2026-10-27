use serde_json::{json, Value};
use zorid_core::{EntryId, EntryKind, Mutation, MutationRequest, OperationId, VaultPath};
use zorid_store::{
    DatabaseCollection, DatabaseEntry, DatabaseProjection, DatabaseRequest, DatabaseSnapshot, Store,
};

fn op(text: &str) -> OperationId {
    OperationId::new(text).unwrap()
}
fn id(text: &str) -> EntryId {
    EntryId::new(text).unwrap()
}
fn request(store: &mut Store, input: Value) -> DatabaseSnapshot {
    store
        .database_request(&serde_json::from_value(input).unwrap())
        .unwrap()
}
fn create(store: &mut Store, name: &str) -> DatabaseCollection {
    request(store,json!({"op":"create","operationId":format!("create-{name}"),"name":name,"properties":[{"name":"Score","datatype":"number"},{"name":"Status","datatype":"status","options":[{"name":"Todo","category":"not_started"},{"name":"Done","category":"done"}]}]})).collections.remove(0)
}
fn new_entry(store: &mut Store, collection: &DatabaseCollection, entry: &str) -> DatabaseEntry {
    request(store,json!({"op":"create_entry","operationId":format!("new-{entry}"),"collectionId":collection.id,"expectedCollectionRevision":collection.revision,"entryId":entry,"path":format!("{entry}.md"),"body":"# Body\r\n\r\nKeep β exactly.\r\n","values":{collection.properties[0].id.clone():3,collection.properties[1].id.clone():collection.properties[1].options[0].id}})).entries.into_iter().find(|value|value.entry_id.as_str()==entry).unwrap()
}
fn input(collection: &DatabaseCollection) -> Vec<Value> {
    collection
        .properties
        .iter()
        .map(|p| {
            let mut v = serde_json::to_value(p).unwrap();
            if v["default"].is_null() {
                v.as_object_mut().unwrap().remove("default");
            }
            v
        })
        .collect()
}
fn update(
    store: &mut Store,
    collection: &DatabaseCollection,
    name: &str,
    properties: Vec<Value>,
    confirm: bool,
) -> DatabaseSnapshot {
    request(
        store,
        json!({"op":"update","operationId":format!("update-{}-{name}",collection.revision),"collectionId":collection.id,"expectedRevision":collection.revision,"name":name,"properties":properties,"confirmDestructive":confirm}),
    )
}
fn get(store: &mut Store, collection: &DatabaseCollection) -> DatabaseSnapshot {
    request(store, json!({"op":"get","collectionId":collection.id}))
}
fn source(projection: &DatabaseProjection, extra: &str, body: &str) -> String {
    let mut properties = projection.properties.clone();
    properties.insert("unrelated".into(), json!(extra));
    format!(
        "---\n{}\n---\n{body}",
        serde_json::to_string_pretty(&properties).unwrap()
    )
}
fn publish(store: &mut Store, entry: &DatabaseEntry, operation: &str) -> String {
    let projection = store
        .database_entry_projection(&entry.entry_id)
        .unwrap()
        .unwrap();
    let text = source(
        &projection,
        "untouched",
        "# Body\r\n\r\nKeep β exactly.\r\n",
    );
    let current = store.read(&entry.entry_id).unwrap().unwrap();
    let request = MutationRequest {
        operation_id: op(operation),
        mutation: Mutation::Write {
            id: entry.entry_id.clone(),
            expected: current.state.revision,
            content: text.as_bytes().to_vec(),
        },
    };
    if store.family_is_enrolled().unwrap() {
        store.family_apply(&request, None).unwrap();
    } else {
        store.apply(&request).unwrap();
    }
    store
        .database_projection_ack(
            &entry.entry_id,
            &projection.entry_revision,
            &projection.collection_revision,
        )
        .unwrap();
    text
}

#[test]
fn local_schema_and_entries_are_durable_without_enrollment_or_global_registry() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vault.sqlite");
    let mut store = Store::open(&path).unwrap();
    assert!(!store.family_is_enrolled().unwrap());
    let collection = create(&mut store, "Books");
    let entry = new_entry(&mut store, &collection, "book");
    assert_eq!(store.list().unwrap().len(), 1);
    assert!(store
        .list()
        .unwrap()
        .iter()
        .all(|e| e.path.as_str() != "Properties.yaml"));
    for value in std::iter::once(&collection.id)
        .chain(collection.properties.iter().map(|p| &p.id))
        .chain(
            collection
                .properties
                .iter()
                .flat_map(|p| p.options.iter().map(|o| &o.id)),
        )
    {
        assert_eq!(value.len(), 12);
        assert!(value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()));
    }
    assert!(entry.pending_projection);
    assert_eq!(
        entry.file_revision,
        Some(store.read(&entry.entry_id).unwrap().unwrap().state.revision)
    );
    drop(store);
    let mut store = Store::open(&path).unwrap();
    assert_eq!(get(&mut store, &collection).entries, [entry]);
    assert!(!store.family_is_enrolled().unwrap());
    assert_eq!(store.database_pending_projection_count().unwrap(), 2);
}

#[test]
fn uncertain_mutation_retries_return_original_receipt_without_new_identities() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    let command: DatabaseRequest =
        serde_json::from_value(json!({"op":"create","operationId":"same","name":"Books"})).unwrap();
    let first = store.database_request(&command).unwrap();
    drop(store);
    let mut store = Store::open(&path).unwrap();
    assert_eq!(store.database_request(&command).unwrap(), first);
    let changed =
        serde_json::from_value(json!({"op":"create","operationId":"same","name":"Projects"}))
            .unwrap();
    assert!(store.database_request(&changed).is_err());
    assert_eq!(
        request(&mut store, json!({"op":"list"})).collections.len(),
        1
    );
}

#[test]
fn create_entry_logical_file_and_membership_rollback_together() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    let collection = create(&mut store, "Books");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TRIGGER injected_member_failure BEFORE INSERT ON local_collection_entries BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
    let command=serde_json::from_value(json!({"op":"create_entry","operationId":"atomic","collectionId":collection.id,"expectedCollectionRevision":collection.revision,"entryId":"one","path":"One.md"})).unwrap();
    assert!(store.database_request(&command).is_err());
    assert!(store.read(&id("one")).unwrap().is_none());
    assert!(get(&mut store, &collection).entries.is_empty());
    assert!(store.operations_after(0, 100).unwrap().is_empty());
    db.execute_batch("DROP TRIGGER injected_member_failure")
        .unwrap();
    store.database_request(&command).unwrap();
    assert_eq!(get(&mut store, &collection).entries.len(), 1);
}

#[test]
fn existing_note_child_operation_replay_cannot_import_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    let collection = create(&mut store, "Books");
    store
        .apply(&MutationRequest {
            operation_id: op("attach-file"),
            mutation: Mutation::Create {
                id: id("ordinary"),
                path: VaultPath::new("Ordinary.md").unwrap(),
                kind: EntryKind::File,
                content: Some(vec![]),
            },
        })
        .unwrap();
    let command=serde_json::from_value(json!({"op":"create_entry","operationId":"attach","collectionId":collection.id,"expectedCollectionRevision":collection.revision,"entryId":"ordinary","path":"Ordinary.md"})).unwrap();
    assert!(store.database_request(&command).is_err());
    assert!(get(&mut store, &collection).entries.is_empty());
    for op in ["assign", "import", "detach", "move_entry"] {
        assert!(serde_json::from_value::<DatabaseRequest>(json!({"op":op})).is_err());
    }
}

#[test]
fn schema_rename_keeps_field_option_identity_values_and_published_baseline() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    let collection = create(&mut store, "Books");
    let entry = new_entry(&mut store, &collection, "one");
    publish(&mut store, &entry, "publish");
    let mut fields = input(&collection);
    fields[1]["name"] = json!("Progress");
    fields[1]["options"][0]["name"] = json!("Started");
    let next = update(&mut store, &collection, "Library", fields, false)
        .collections
        .remove(0);
    assert_eq!(next.id, collection.id);
    assert_eq!(next.properties[1].id, collection.properties[1].id);
    assert_eq!(
        next.properties[1].options[0].id,
        collection.properties[1].options[0].id
    );
    let projection = store
        .database_entry_projection(&entry.entry_id)
        .unwrap()
        .unwrap();
    assert_eq!(projection.properties["Progress"], json!("Started"));
    assert_eq!(projection.properties["_type"], json!("Library"));
    assert_eq!(projection.properties["_id"], json!("one"));
    assert_eq!(projection.previous_properties["Status"], json!("Todo"));
    assert!(!projection.properties.contains_key("Status"));
    assert!(store
        .database_projection_ack(
            &entry.entry_id,
            &projection.entry_revision,
            &projection.collection_revision
        )
        .is_err());
    drop(store);
    let mut store = Store::open(&path).unwrap();
    assert_eq!(
        store
            .database_entry_projection(&entry.entry_id)
            .unwrap()
            .unwrap(),
        projection
    );
    let current = get(&mut store, &next).entries.remove(0);
    let text = publish(&mut store, &current, "publish-renamed");
    assert!(text.ends_with("# Body\r\n\r\nKeep β exactly.\r\n"));
    assert!(!get(&mut store, &next).entries[0].pending_projection);
}

#[test]
fn stale_schema_or_scalar_commands_cannot_clobber_new_values() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut first = Store::open(&path).unwrap();
    let collection = create(&mut first, "Books");
    let entry = new_entry(&mut first, &collection, "one");
    let mut second = Store::open(&path).unwrap();
    let command = |op: &str, score: i32| {
        serde_json::from_value(json!({"op":"set_entry","operationId":op,"entryId":entry.entry_id,"expectedRevision":entry.revision,"expectedCollectionRevision":collection.revision,"values":{collection.properties[0].id.clone():score}})).unwrap()
    };
    first.database_request(&command("first", 4)).unwrap();
    assert!(second.database_request(&command("second", 5)).is_err());
    assert_eq!(
        get(&mut second, &collection).entries[0].values[&collection.properties[0].id],
        json!(4)
    );
    let next = update(
        &mut first,
        &collection,
        "Library",
        input(&collection),
        false,
    )
    .collections
    .remove(0);
    let stale=serde_json::from_value(json!({"op":"update","operationId":"stale-schema","collectionId":collection.id,"expectedRevision":collection.revision,"name":"Oops","properties":input(&collection)})).unwrap();
    assert!(second.database_request(&stale).is_err());
    assert_eq!(get(&mut second, &next).collections[0].name, "Library");
}

#[test]
fn raw_body_writes_require_current_managed_properties_and_preserve_unknown_data() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    let collection = create(&mut store, "Books");
    let entry = new_entry(&mut store, &collection, "one");
    let text = publish(&mut store, &entry, "publish");
    let before = store.read(&entry.entry_id).unwrap().unwrap();
    let write = |op: &str, source: String| MutationRequest {
        operation_id: self::op(op),
        mutation: Mutation::Write {
            id: entry.entry_id.clone(),
            expected: before.state.revision.clone(),
            content: source.into_bytes(),
        },
    };
    let wrong = text.replace("\"Score\": 3", "\"Score\": 9");
    assert!(store.apply(&write("wrong", wrong)).is_err());
    assert_eq!(store.read(&entry.entry_id).unwrap().unwrap(), before);
    let changed = text.replace("Keep β exactly.", "Body changed independently.");
    store.apply(&write("body", changed.clone())).unwrap();
    assert_eq!(
        store
            .read(&entry.entry_id)
            .unwrap()
            .unwrap()
            .content
            .unwrap(),
        changed.as_bytes()
    );
    assert_eq!(
        get(&mut store, &collection).entries[0].values[&collection.properties[0].id],
        json!(3)
    );
}

#[test]
fn prepared_old_note_write_is_rejected_after_schema_or_property_change() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    let collection = create(&mut store, "Books");
    let entry = new_entry(&mut store, &collection, "one");
    let text = publish(&mut store, &entry, "publish");
    let before = store.read(&entry.entry_id).unwrap().unwrap();
    let command = MutationRequest {
        operation_id: op("prepared"),
        mutation: Mutation::Write {
            id: entry.entry_id.clone(),
            expected: before.state.revision,
            content: text.replace("Keep β exactly.", "Edit").into_bytes(),
        },
    };
    let prepared = store.prepare_host_intent(&op("editor"), &command).unwrap();
    assert_eq!(prepared.state, zorid_store::HostIntentState::Prepared);
    let reference = zorid_store::HostIntentRef {
        client_id: prepared.client_id,
        token: prepared.token,
    };
    store.request_host_commit(&reference).unwrap();
    let current = get(&mut store, &collection).entries.remove(0);
    request(
        &mut store,
        json!({"op":"set_entry","operationId":"new-value","entryId":entry.entry_id,"expectedRevision":current.revision,"expectedCollectionRevision":collection.revision,"values":{collection.properties[0].id.clone():8}}),
    );
    assert!(store.apply(&command).is_err());
    assert_eq!(
        get(&mut store, &collection).entries[0].values[&collection.properties[0].id],
        json!(8)
    );
}

#[test]
fn collection_membership_survives_file_move_and_collection_delete_restore() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    let collection = create(&mut store, "Books");
    let entry = new_entry(&mut store, &collection, "one");
    publish(&mut store, &entry, "publish");
    let file = store.read(&entry.entry_id).unwrap().unwrap();
    store
        .apply(&MutationRequest {
            operation_id: op("rename"),
            mutation: Mutation::Move {
                id: entry.entry_id.clone(),
                expected: file.state.revision,
                path: VaultPath::new("Moved.md").unwrap(),
            },
        })
        .unwrap();
    assert_eq!(
        get(&mut store, &collection).entries[0].collection_id,
        collection.id
    );
    let deleted = request(
        &mut store,
        json!({"op":"delete","operationId":"trash-all","collectionId":collection.id,"expectedRevision":collection.revision}),
    );
    assert!(deleted.collections[0].deleted);
    assert!(deleted.entries[0].deleted);
    assert_eq!(
        store.database_pending_projections(20).unwrap()[0].original_path,
        "Moved.md"
    );
    let projection = store
        .database_entry_projection(&entry.entry_id)
        .unwrap()
        .unwrap();
    assert!(store
        .database_projection_ack(
            &entry.entry_id,
            &projection.entry_revision,
            &projection.collection_revision
        )
        .is_err());
    let restored = request(
        &mut store,
        json!({"op":"restore","operationId":"restore-all","collectionId":collection.id,"expectedRevision":deleted.collections[0].revision}),
    );
    assert!(!restored.collections[0].deleted);
    assert!(!restored.entries[0].deleted);
    assert_eq!(restored.entries[0].entry_id, entry.entry_id);
}

#[test]
fn incompatible_datatype_values_are_retained_until_explicit_correction() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    let collection = create(&mut store, "Books");
    let entry = new_entry(&mut store, &collection, "one");
    publish(&mut store, &entry, "publish");
    let mut fields = input(&collection);
    fields[0]["datatype"] = json!("date");
    let changed = update(&mut store, &collection, "Books", fields, false);
    let changed_collection = &changed.collections[0];
    let changed_entry = &changed.entries[0];
    assert_eq!(changed_entry.values[&collection.properties[0].id], json!(3));
    assert!(changed_entry
        .problems
        .contains_key(&collection.properties[0].id));
    assert_eq!(
        store
            .database_entry_projection(&entry.entry_id)
            .unwrap()
            .unwrap()
            .properties["Score"],
        json!(3)
    );
    let corrected = request(
        &mut store,
        json!({"op":"set_entry","operationId":"correct","entryId":entry.entry_id,"expectedRevision":changed_entry.revision,"expectedCollectionRevision":changed_collection.revision,"values":{collection.properties[0].id.clone():"2026-10-27"}}),
    );
    assert!(corrected.entries[0].problems.is_empty());
}

#[test]
fn select_to_text_converts_readable_label_instead_of_reinterpreting_option_id() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    let collection = create(&mut store, "Books");
    new_entry(&mut store, &collection, "one");
    let mut fields = input(&collection);
    fields[1]["datatype"] = json!("text");
    fields[1]["options"] = json!([]);
    let changed = update(&mut store, &collection, "Books", fields, false);
    assert_eq!(
        changed.entries[0].values[&collection.properties[1].id],
        json!("Todo")
    );
    assert!(changed.entries[0].problems.is_empty());
}

#[test]
fn destructive_schema_removal_requires_count_confirmation_and_retains_history() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    let collection = create(&mut store, "Books");
    new_entry(&mut store, &collection, "one");
    let mut fields = input(&collection);
    fields[1]["options"].as_array_mut().unwrap().remove(0);
    let command=serde_json::from_value(json!({"op":"update","operationId":"remove","collectionId":collection.id,"expectedRevision":collection.revision,"name":"Books","properties":fields})).unwrap();
    assert!(store
        .database_request(&command)
        .unwrap_err()
        .to_string()
        .contains("1 affected"));
    assert_eq!(
        get(&mut store, &collection).entries[0].values[&collection.properties[1].id],
        json!(collection.properties[1].options[0].id)
    );
    let changed = update(&mut store, &collection, "Books", fields, true);
    assert!(changed.entries[0].values[&collection.properties[1].id].is_null());
    let db = rusqlite::Connection::open(path).unwrap();
    let retained: i64 = db
        .query_row(
            "SELECT count(*) FROM local_database_history WHERE instr(record,?1)>0",
            [&collection.properties[1].options[0].id],
            |r| r.get(0),
        )
        .unwrap();
    assert!(retained > 0);
}

#[test]
fn duplicate_gets_new_identity_and_retains_unrelated_frontmatter_in_baseline() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    let collection = create(&mut store, "Books");
    let entry = new_entry(&mut store, &collection, "one");
    publish(&mut store, &entry, "publish");
    let current = get(&mut store, &collection).entries.remove(0);
    let duplicate = request(
        &mut store,
        json!({"op":"duplicate_entry","operationId":"duplicate","entryId":entry.entry_id,"expectedRevision":current.revision,"newEntryId":"two","path":"Two.md"}),
    );
    let second = duplicate
        .entries
        .iter()
        .find(|e| e.entry_id == id("two"))
        .unwrap();
    assert_eq!(second.values, current.values);
    let projection = store
        .database_entry_projection(&second.entry_id)
        .unwrap()
        .unwrap();
    assert_eq!(projection.properties["_id"], json!("two"));
    assert_eq!(projection.previous_properties["_id"], json!("one"));
    assert!(!projection.previous_keys.contains(&"unrelated".into()));
    assert!(store
        .read(&second.entry_id)
        .unwrap()
        .unwrap()
        .content
        .unwrap()
        .windows(9)
        .any(|w| w == b"unrelated"));
}

#[test]
fn portable_collection_name_collisions_and_invalid_values_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    let collection = create(&mut store, "Books");
    for (name, operation) in [("books", "case"), ("Bad/Name", "path"), ("CON", "reserved")] {
        let command =
            serde_json::from_value(json!({"op":"create","operationId":operation,"name":name}))
                .unwrap();
        assert!(store.database_request(&command).is_err());
    }
    let entry = new_entry(&mut store, &collection, "one");
    let bad=serde_json::from_value(json!({"op":"set_entry","operationId":"invalid","entryId":entry.entry_id,"expectedRevision":entry.revision,"expectedCollectionRevision":collection.revision,"values":{collection.properties[0].id.clone():"wrong"}})).unwrap();
    assert!(store.database_request(&bad).is_err());
    request(
        &mut store,
        json!({"op":"create","operationId":"unicode-a","name":"Café"}),
    );
    let unicode = serde_json::from_value(
        json!({"op":"create","operationId":"unicode-b","name":"Cafe\u{301}"}),
    )
    .unwrap();
    assert!(store.database_request(&unicode).is_err());
}

#[test]
fn entries_and_body_guard_work_in_existing_family_enrolled_vault() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    store
        .family_enroll(&zorid_store::FamilyScope {
            realm_id: zorid_sync_protocol::RealmId::new("existing").unwrap(),
            vault_id: zorid_sync_protocol::VaultId::new("existing").unwrap(),
        })
        .unwrap();
    let collection = create(&mut store, "Books");
    let entry = new_entry(&mut store, &collection, "one");
    let text = publish(&mut store, &entry, "publish");
    let current = store.read(&entry.entry_id).unwrap().unwrap();
    let bad = MutationRequest {
        operation_id: op("raw-bypass"),
        mutation: Mutation::Write {
            id: entry.entry_id.clone(),
            expected: current.state.revision.clone(),
            content: text.replace("\"Score\": 3", "\"Score\": 77").into_bytes(),
        },
    };
    assert!(store.family_apply(&bad, None).is_err());
    assert_eq!(store.read(&entry.entry_id).unwrap().unwrap(), current);
}

#[test]
fn schema_only_mutation_changes_document_source_watermark() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    let before = store.list_snapshot().unwrap().cursor;
    let collection = create(&mut store, "Books");
    let after = store.list_snapshot().unwrap().cursor;
    assert_ne!(before, after);
    let changes = store.changes_after(&before, 100).unwrap();
    assert_eq!(changes.changes.len(), 1);
    assert!(changes.changes[0].requires_full_reload);
    assert!(changes.changes[0].entries.is_empty());
    let first = store.database_query_state().unwrap();
    update(
        &mut store,
        &collection,
        "Library",
        input(&collection),
        false,
    );
    let second = store.database_query_state().unwrap();
    assert_ne!(first.revision, second.revision);
    assert_ne!(after, store.list_snapshot().unwrap().cursor);
    let changes = store.changes_after(&after, 100).unwrap();
    assert_eq!(changes.changes.len(), 1);
    assert!(changes.changes[0].requires_full_reload);
    assert!(changes.changes[0].entries.is_empty());
}

#[test]
fn old_schema17_migrates_once_without_modifying_existing_files_or_receipts() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    store
        .apply(&MutationRequest {
            operation_id: op("ordinary"),
            mutation: Mutation::Create {
                id: id("note"),
                path: VaultPath::new("Note.md").unwrap(),
                kind: EntryKind::File,
                content: Some(b"ordinary".to_vec()),
            },
        })
        .unwrap();
    let before = store.read(&id("note")).unwrap();
    let receipts = store.operations_after(0, 20).unwrap();
    drop(store);
    let db = rusqlite::Connection::open(&path).unwrap();
    let objects=db.prepare("SELECT type,name FROM sqlite_master WHERE name LIKE 'local_database_%' OR name LIKE 'local_collection%' ORDER BY type").unwrap().query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
    for (kind, name) in objects {
        db.execute_batch(&format!("DROP {kind} \"{name}\";"))
            .unwrap();
    }
    db.pragma_update(None, "user_version", 17).unwrap();
    drop(db);
    let mut store = Store::open(&path).unwrap();
    assert_eq!(store.read(&id("note")).unwrap(), before);
    assert_eq!(store.operations_after(0, 20).unwrap(), receipts);
    assert!(request(&mut store, json!({"op":"list"}))
        .collections
        .is_empty());
    drop(store);
    Store::open(&path).unwrap();
}

fn bind_published(store: &mut Store, entry: &DatabaseEntry) {
    let attempt = store
        .begin_projection_bound(&entry.entry_id, "root-inode")
        .unwrap();
    store
        .mark_projection(
            &attempt.attempt_id,
            zorid_store::ProjectionPhase::Staged,
            Some("original-inode".into()),
        )
        .unwrap();
    store
        .finish_projection_bound(
            &attempt.attempt_id,
            &zorid_store::PhysicalIdentity {
                inode: "original-inode".into(),
                parent_inode: "root-inode".into(),
            },
        )
        .unwrap();
}
fn capture_external(
    store: &mut Store,
    entry: &DatabaseEntry,
    source: String,
    bound: bool,
) -> (zorid_store::ExternalObservation, MutationRequest) {
    let baseline = store.projection_baseline(&entry.entry_id).unwrap().unwrap();
    let observation = if bound {
        let proof = zorid_store::ObservationPhysical {
            physical: zorid_store::PhysicalIdentity {
                inode: "external-inode".into(),
                parent_inode: "root-inode".into(),
            },
            expected_binding: store.physical_binding(&entry.entry_id).unwrap(),
        };
        store
            .record_external_bound(
                &baseline.state.path,
                Some(baseline.clone()),
                source.as_bytes().to_vec(),
                &proof,
            )
            .unwrap()
    } else {
        store
            .record_external(
                &baseline.state.path,
                Some(baseline.clone()),
                source.as_bytes().to_vec(),
            )
            .unwrap()
    };
    let command = MutationRequest {
        operation_id: observation.observation_id.clone(),
        mutation: Mutation::Write {
            id: entry.entry_id.clone(),
            expected: baseline.state.revision,
            content: source.into_bytes(),
        },
    };
    (observation, command)
}

#[test]
fn proven_external_body_keeps_newer_structured_values_and_queues_reprojection() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    let collection = create(&mut store, "Books");
    let entry = new_entry(&mut store, &collection, "one");
    let text = publish(&mut store, &entry, "publish");
    bind_published(&mut store, &entry);
    let current = get(&mut store, &collection).entries.remove(0);
    request(
        &mut store,
        json!({"op":"set_entry","operationId":"newer-property","entryId":entry.entry_id,"expectedRevision":current.revision,"expectedCollectionRevision":collection.revision,"values":{collection.properties[0].id.clone():8}}),
    );
    let external = text.replace("Keep β exactly.", "Externally edited body.");
    let (observation, command) = capture_external(&mut store, &entry, external.clone(), true);
    // Authored saves have no observation exemption.
    assert!(store.apply(&command).is_err());
    store
        .import_observation(&observation.observation_id, &command)
        .unwrap();
    assert_eq!(
        store
            .read(&entry.entry_id)
            .unwrap()
            .unwrap()
            .content
            .unwrap(),
        external.as_bytes()
    );
    let current = get(&mut store, &collection).entries.remove(0);
    assert_eq!(current.values[&collection.properties[0].id], json!(8));
    assert!(current.pending_projection);
    let projection = store
        .database_entry_projection(&entry.entry_id)
        .unwrap()
        .unwrap();
    assert_eq!(projection.properties["Score"], json!(8));
    assert!(store
        .database_projection_ack(
            &entry.entry_id,
            &projection.entry_revision,
            &projection.collection_revision
        )
        .is_err());
}

#[test]
fn external_changed_values_need_validated_field_operation_before_import() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    let collection = create(&mut store, "Books");
    let entry = new_entry(&mut store, &collection, "one");
    let text = publish(&mut store, &entry, "publish");
    bind_published(&mut store, &entry);
    let external = text.replace("\"Score\": 3", "\"Score\": 9");
    let (observation, command) = capture_external(&mut store, &entry, external, true);
    assert!(store
        .import_observation(&observation.observation_id, &command)
        .is_err());
    assert!(store
        .external_observations()
        .unwrap()
        .iter()
        .find(|o| o.observation_id == observation.observation_id)
        .unwrap()
        .resolution
        .is_none());
    let current = get(&mut store, &collection).entries.remove(0);
    request(
        &mut store,
        json!({"op":"set_entry","operationId":"validated-external-value","entryId":entry.entry_id,"expectedRevision":current.revision,"expectedCollectionRevision":collection.revision,"values":{collection.properties[0].id.clone():9}}),
    );
    store
        .import_observation(&observation.observation_id, &command)
        .unwrap();
    assert_eq!(
        get(&mut store, &collection).entries[0].values[&collection.properties[0].id],
        json!(9)
    );
}

#[test]
fn external_identity_edit_or_unproven_branch_is_retained_without_import() {
    for (identity_change, bound) in [(true, true), (false, false)] {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().join("db")).unwrap();
        let collection = create(&mut store, "Books");
        let entry = new_entry(&mut store, &collection, "one");
        let text = publish(&mut store, &entry, "publish");
        bind_published(&mut store, &entry);
        let before = store.read(&entry.entry_id).unwrap();
        let external = if identity_change {
            text.replace("\"_id\": \"one\"", "\"_id\": \"someone-else\"")
        } else {
            text.replace("Keep β exactly.", "Unproven body.")
        };
        let (observation, command) = capture_external(&mut store, &entry, external, bound);
        assert!(store
            .import_observation(&observation.observation_id, &command)
            .is_err());
        assert_eq!(store.read(&entry.entry_id).unwrap(), before);
        assert_eq!(
            get(&mut store, &collection).entries[0].entry_id,
            entry.entry_id
        );
    }
}

#[test]
fn external_type_label_edit_is_projection_mismatch_without_membership_change() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    let collection = create(&mut store, "Books");
    let entry = new_entry(&mut store, &collection, "one");
    let text = publish(&mut store, &entry, "publish");
    bind_published(&mut store, &entry);
    let external = text.replace("\"_type\": \"Books\"", "\"_type\": \"Other collection\"");
    let (observation, command) = capture_external(&mut store, &entry, external, true);
    store
        .import_observation(&observation.observation_id, &command)
        .unwrap();
    let current = get(&mut store, &collection).entries.remove(0);
    assert_eq!(current.collection_id, collection.id);
    assert!(current.pending_projection);
    assert_eq!(
        store
            .database_entry_projection(&entry.entry_id)
            .unwrap()
            .unwrap()
            .properties["_type"],
        json!("Books")
    );
}

#[test]
fn unrelated_schema_rename_keeps_incompatible_multiselect_scalar_without_confirmation() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    let collection = create(&mut store, "Books");
    let entry = new_entry(&mut store, &collection, "one");
    publish(&mut store, &entry, "publish");
    let mut fields = input(&collection);
    fields[0]["datatype"] = json!("multi-select");
    let converted = update(&mut store, &collection, "Books", fields, false);
    assert_eq!(
        converted.entries[0].values[&collection.properties[0].id],
        json!(3)
    );
    let renamed = update(
        &mut store,
        &converted.collections[0],
        "Library",
        input(&converted.collections[0]),
        false,
    );
    assert_eq!(
        renamed.entries[0].values[&collection.properties[0].id],
        json!(3)
    );
    assert!(renamed.entries[0]
        .problems
        .contains_key(&collection.properties[0].id));
    assert_eq!(
        store
            .database_entry_projection(&entry.entry_id)
            .unwrap()
            .unwrap()
            .properties["Score"],
        json!(3)
    );
}

#[test]
fn datatype_change_converts_inherited_status_default_to_its_readable_label() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    let collection = request(
        &mut store,
        json!({"op":"create","operationId":"tasks","name":"Tasks","preset":"tasks"}),
    )
    .collections
    .remove(0);
    let mut fields = input(&collection);
    fields[0]["datatype"] = json!("text");
    fields[0]["options"] = json!([]);
    let changed = update(&mut store, &collection, "Tasks", fields, false);
    assert_eq!(
        changed.collections[0].properties[0].default,
        Some(json!("Not started"))
    );
}

#[test]
fn collection_restore_never_resurrects_a_previously_trashed_member() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    let collection = create(&mut store, "Books");
    let old = new_entry(&mut store, &collection, "earlier");
    let active = new_entry(&mut store, &collection, "active");
    publish(&mut store, &old, "publish-earlier");
    publish(&mut store, &active, "publish-active");
    store
        .apply(&MutationRequest {
            operation_id: op("trash-folder"),
            mutation: Mutation::Create {
                id: id("trash-folder"),
                path: VaultPath::new(".trash").unwrap(),
                kind: EntryKind::Folder,
                content: None,
            },
        })
        .unwrap();
    let before = store.read(&old.entry_id).unwrap().unwrap();
    store
        .apply(&MutationRequest {
            operation_id: op("independent-trash"),
            mutation: Mutation::Move {
                id: old.entry_id.clone(),
                expected: before.state.revision,
                path: VaultPath::new(".trash/earlier.md").unwrap(),
            },
        })
        .unwrap();
    let listed = get(&mut store, &collection);
    let trashed = listed
        .entries
        .iter()
        .find(|e| e.entry_id == old.entry_id)
        .unwrap();
    assert!(trashed.deleted);
    let edit=serde_json::from_value(json!({"op":"set_entry","operationId":"edit-trashed","entryId":old.entry_id,"expectedRevision":trashed.revision,"expectedCollectionRevision":collection.revision,"values":{collection.properties[0].id.clone():99}})).unwrap();
    assert!(store.database_request(&edit).is_err());
    let duplicate=serde_json::from_value(json!({"op":"duplicate_entry","operationId":"duplicate-trashed","entryId":old.entry_id,"expectedRevision":trashed.revision,"newEntryId":"unwanted","path":"Unwanted.md"})).unwrap();
    assert!(store.database_request(&duplicate).is_err());
    let deleted = request(
        &mut store,
        json!({"op":"delete","operationId":"delete-collection","collectionId":collection.id,"expectedRevision":collection.revision}),
    );
    let queued = store.database_pending_projections(20).unwrap();
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].entry_id, active.entry_id);
    drop(store);
    let mut store = Store::open(&path).unwrap();
    let restored = request(
        &mut store,
        json!({"op":"restore","operationId":"restore-collection","collectionId":collection.id,"expectedRevision":deleted.collections[0].revision}),
    );
    let old = restored
        .entries
        .iter()
        .find(|e| e.entry_id == old.entry_id)
        .unwrap();
    assert!(old.deleted);
    assert_eq!(old.path, ".trash/earlier.md");
    let queued = store.database_pending_projections(20).unwrap();
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].entry_id, active.entry_id);
    assert_eq!(queued[0].kind, zorid_store::DatabaseProjectionKind::Restore);
}

#[test]
fn independently_tombstoned_member_stays_deleted_after_collection_restore() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    let collection = create(&mut store, "Books");
    let entry = new_entry(&mut store, &collection, "one");
    let file = store.read(&entry.entry_id).unwrap().unwrap();
    store
        .apply(&MutationRequest {
            operation_id: op("independent-delete"),
            mutation: Mutation::Delete {
                id: entry.entry_id.clone(),
                expected: file.state.revision,
                recursive: false,
            },
        })
        .unwrap();
    assert!(get(&mut store, &collection).entries[0].deleted);
    let deleted = request(
        &mut store,
        json!({"op":"delete","operationId":"delete-collection","collectionId":collection.id,"expectedRevision":collection.revision}),
    );
    assert!(store.database_pending_projections(20).unwrap().is_empty());
    let restored = request(
        &mut store,
        json!({"op":"restore","operationId":"restore-collection","collectionId":collection.id,"expectedRevision":deleted.collections[0].revision}),
    );
    assert!(restored.entries[0].deleted);
    assert!(store.database_pending_projections(20).unwrap().is_empty());
    assert!(store.read(&entry.entry_id).unwrap().unwrap().state.deleted);
}

#[test]
fn schema_rename_while_member_is_in_trash_defers_projection_until_individual_restore() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    let collection = create(&mut store, "Books");
    let entry = new_entry(&mut store, &collection, "one");
    publish(&mut store, &entry, "publish");
    store
        .apply(&MutationRequest {
            operation_id: op("trash-folder"),
            mutation: Mutation::Create {
                id: id("trash-folder"),
                path: VaultPath::new(".trash").unwrap(),
                kind: EntryKind::Folder,
                content: None,
            },
        })
        .unwrap();
    let current = store.read(&entry.entry_id).unwrap().unwrap();
    store
        .apply(&MutationRequest {
            operation_id: op("trash-note"),
            mutation: Mutation::Move {
                id: entry.entry_id.clone(),
                expected: current.state.revision,
                path: VaultPath::new(".trash/One.md").unwrap(),
            },
        })
        .unwrap();
    let renamed = update(
        &mut store,
        &collection,
        "Library",
        input(&collection),
        false,
    )
    .collections
    .remove(0);
    assert!(store.database_pending_projections(20).unwrap().is_empty());
    let current = store.read(&entry.entry_id).unwrap().unwrap();
    store
        .apply(&MutationRequest {
            operation_id: op("restore-note"),
            mutation: Mutation::Move {
                id: entry.entry_id.clone(),
                expected: current.state.revision,
                path: VaultPath::new("Restored.md").unwrap(),
            },
        })
        .unwrap();
    let pending = store.database_pending_projections(20).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].properties["_type"], json!("Library"));
    assert!(!get(&mut store, &renamed).entries[0].deleted);
}

#[test]
fn superseded_unacknowledged_schema_targets_remain_durable_until_current_ack() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    let first = create(&mut store, "Books");
    let second = update(&mut store, &first, "Library", input(&first), false)
        .collections
        .remove(0);
    let third = update(&mut store, &second, "Reading", input(&second), false)
        .collections
        .remove(0);
    drop(store);
    let mut store = Store::open(path).unwrap();
    let pending = store.database_pending_schema_projections(20).unwrap();
    assert_eq!(pending.len(), 1);
    let candidate_paths = pending[0]
        .candidates
        .iter()
        .map(|c| c.path.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        candidate_paths,
        [
            ".zorid/types/Books.yaml",
            ".zorid/types/Library.yaml",
            ".zorid/types/Reading.yaml"
        ]
    );
    assert!(pending[0]
        .candidates
        .iter()
        .all(|c| c.source.contains(&first.id)));
    assert!(store
        .database_schema_projection_ack(&first.id, &first.revision)
        .is_err());
    assert_eq!(
        store.database_pending_schema_projections(20).unwrap()[0]
            .candidates
            .len(),
        3
    );
    // Simulates the host acknowledgement only; physical cleanup is native's
    // independent contract and is covered in its filesystem tests.
    store
        .database_schema_projection_ack(&third.id, &third.revision)
        .unwrap();
    assert!(store
        .database_pending_schema_projections(20)
        .unwrap()
        .is_empty());
    let fourth = update(&mut store, &third, "Research", input(&third), false)
        .collections
        .remove(0);
    let pending = store.database_pending_schema_projections(20).unwrap();
    assert_eq!(pending[0].candidates.len(), 1);
    assert_eq!(
        pending[0].previous_path.as_deref(),
        Some(".zorid/types/Reading.yaml")
    );
    assert_eq!(pending[0].revision, fourth.revision);
}

#[test]
fn pending_schema_candidate_limit_rejects_transaction_without_losing_recovery_targets() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    let mut collection = request(
        &mut store,
        json!({"op":"create","operationId":"begin","name":"Collection 0"}),
    )
    .collections
    .remove(0);
    for n in 1..64 {
        collection = update(
            &mut store,
            &collection,
            &format!("Collection {n}"),
            vec![],
            false,
        )
        .collections
        .remove(0);
    }
    let command=serde_json::from_value(json!({"op":"update","operationId":"over-limit","collectionId":collection.id,"expectedRevision":collection.revision,"name":"Over limit","properties":[]})).unwrap();
    assert!(store.database_request(&command).is_err());
    assert_eq!(get(&mut store, &collection).collections[0], collection);
    assert_eq!(
        store.database_pending_schema_projections(1).unwrap()[0]
            .candidates
            .len(),
        64
    );
    store
        .database_schema_projection_ack(&collection.id, &collection.revision)
        .unwrap();
    store.database_request(&command).unwrap();
    assert_eq!(
        store.database_pending_schema_projections(1).unwrap()[0]
            .candidates
            .len(),
        1
    );
}

#[test]
fn projection_page_continuation_can_pass_an_unsettled_first_member() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    let collection = create(&mut store, "Books");
    for name in ["a", "b", "c"] {
        new_entry(&mut store, &collection, name);
    }
    let first = store.database_pending_projections_after(None, 1).unwrap();
    assert_eq!(first[0].entry_id, id("a"));
    let second = store
        .database_pending_projections_after(Some(&first[0].entry_id), 1)
        .unwrap();
    assert_eq!(second[0].entry_id, id("b"));
    let third = store
        .database_pending_projections_after(Some(&second[0].entry_id), 1)
        .unwrap();
    assert_eq!(third[0].entry_id, id("c"));
    assert!(store
        .database_pending_projections_after(Some(&third[0].entry_id), 1)
        .unwrap()
        .is_empty());
    assert_eq!(store.database_pending_projections(3).unwrap().len(), 3);
    let schema = store
        .database_pending_schema_projections_after(None, 1)
        .unwrap();
    assert_eq!(schema[0].collection_id, collection.id);
    assert!(store
        .database_pending_schema_projections_after(Some(&collection.id), 1)
        .unwrap()
        .is_empty());
}
