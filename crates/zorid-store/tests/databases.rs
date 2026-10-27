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
    request(store,json!({"op":"create_entry","operationId":format!("new-{entry}"),"collectionId":collection.id,"expectedCollectionRevision":collection.revision,"entryId":entry,"path":format!("{entry}.md"),"body":"# Body\r\n\r\nKeep β exactly.\r\n","values":{collection.properties[0].id.clone():3,collection.properties[1].id.clone():collection.properties[1].options[0].id}})).entries.remove(0)
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
