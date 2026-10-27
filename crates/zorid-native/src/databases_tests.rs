use super::*;
use serde_json::json;

fn request(vault: &mut NativeVault, command: Value) -> Result<DatabaseReply> {
    vault.database_request(&DatabaseRequest {
        schema_version: 1,
        command,
    })
}
fn create(vault: &mut NativeVault) -> zorid_store::DatabaseCollection {
    request(
        vault,
        json!({"op":"create","operationId":"create-collection","name":"Work","preset":"tasks"}),
    )
    .unwrap()
    .snapshot
    .collections
    .remove(0)
}
fn entry(
    vault: &mut NativeVault,
    collection: &zorid_store::DatabaseCollection,
    id: &str,
    path: &str,
) -> DatabaseReply {
    request(vault, json!({"op":"create_entry","operationId":format!("create-{id}"),"collectionId":collection.id,"expectedCollectionRevision":collection.revision,"entryId":id,"path":path,"body":"# Keep body\n\nText 🐈\n"})).unwrap()
}

#[test]
fn local_collection_create_properties_restart_and_rename_keep_identity() {
    let dir = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(dir.path()).unwrap();
    let collection = create(&mut vault);
    assert!(!dir.path().join("Properties.yaml").exists());
    assert!(dir.path().join(".zorid/types/Work.yaml").is_file());
    let created = entry(&mut vault, &collection, "note-one", "One.md");
    assert_eq!(created.projection.pending, 0, "{:?}", created.projection);
    let source = std::fs::read_to_string(dir.path().join("One.md")).unwrap();
    assert!(source.ends_with("# Keep body\n\nText 🐈\n"));
    let values = source::properties(&source).unwrap();
    assert_eq!(values.get("_id"), Some(&json!("note-one")));
    assert_eq!(values.get("_type"), Some(&json!("Work")));
    let before = created.snapshot.entries[0].clone();
    let listed = request(&mut vault, json!({"op":"list"})).unwrap();
    assert!(
        listed.snapshot.entries.is_empty(),
        "collection listing must not widen to all member entries"
    );
    drop(vault);
    let mut vault = NativeVault::open_existing(dir.path()).unwrap();
    let mut properties = serde_json::to_value(&collection.properties).unwrap();
    properties[0]["name"] = json!("Progress");
    properties[0]["options"][0]["name"] = json!("Waiting");
    let renamed = request(&mut vault, json!({"op":"update","operationId":"rename","collectionId":collection.id,"expectedRevision":collection.revision,"name":"Tasks","properties":properties})).unwrap();
    assert_eq!(renamed.projection.pending, 0, "{:?}", renamed.projection);
    assert_eq!(renamed.snapshot.entries[0].entry_id, before.entry_id);
    assert_eq!(
        renamed.snapshot.collections[0].properties[0].id,
        collection.properties[0].id
    );
    assert_eq!(
        renamed.snapshot.collections[0].properties[0].options[0].id,
        collection.properties[0].options[0].id
    );
    assert!(!dir.path().join(".zorid/types/Work.yaml").exists());
    assert!(dir.path().join(".zorid/types/Tasks.yaml").is_file());
    let source = std::fs::read_to_string(dir.path().join("One.md")).unwrap();
    let values = source::properties(&source).unwrap();
    assert!(!values.contains_key("Status"));
    assert_eq!(values.get("Progress"), Some(&json!("Waiting")));
    assert!(source.ends_with("# Keep body\n\nText 🐈\n"));
}

#[test]
fn ordinary_body_save_composes_newer_property_projection_and_rejects_raw_managed_edits() {
    let dir = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(dir.path()).unwrap();
    let collection = create(&mut vault);
    let created = entry(&mut vault, &collection, "note-one", "One.md");
    let old = created.snapshot.entries[0].clone();
    let baseline = std::fs::read_to_string(dir.path().join("One.md")).unwrap();
    let status = &collection.properties[0];
    request(&mut vault, json!({"op":"set_entry","operationId":"set-done","entryId":"note-one","expectedRevision":old.revision,"expectedCollectionRevision":collection.revision,"values":{status.id.clone():status.options[2].id}})).unwrap();
    let proposed = baseline.replace("Text 🐈", "New body");
    let composed = request(&mut vault, json!({"op":"compose","entryId":"note-one","expectedRevision":old.file_revision,"baseline":baseline,"proposed":proposed})).unwrap().composition.unwrap();
    assert!(composed.content.ends_with("# Keep body\n\nNew body\n"));
    assert_eq!(
        source::properties(&composed.content).unwrap().get("Status"),
        Some(&json!("Done"))
    );
    let changed = composed
        .current_source
        .replace("\"Status\": \"Done\"", "\"Status\": \"Not started\"");
    assert!(request(&mut vault, json!({"op":"compose","entryId":"note-one","expectedRevision":composed.current_file_revision,"baseline":composed.current_source,"proposed":changed})).is_err());
    let id = EntryId::new("note-one").unwrap();
    let current = vault.read(&id).unwrap().unwrap();
    let stale = MutationRequest {
        operation_id: OperationId::new("raw-stale-write").unwrap(),
        mutation: Mutation::Write {
            id,
            expected: current.state.revision,
            content: proposed.into_bytes(),
        },
    };
    assert!(vault.apply(&stale).is_err());
}

#[test]
fn delete_trashes_all_members_and_restore_keeps_occupying_file() {
    let dir = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(dir.path()).unwrap();
    let collection = create(&mut vault);
    entry(&mut vault, &collection, "one", "One.md");
    entry(&mut vault, &collection, "hidden", "Hidden.md");
    let deleted = request(&mut vault, json!({"op":"delete","operationId":"delete-work","collectionId":collection.id,"expectedRevision":collection.revision})).unwrap();
    assert_eq!(deleted.projection.pending, 0, "{:?}", deleted.projection);
    assert_eq!(deleted.snapshot.entries.len(), 2);
    assert!(deleted
        .snapshot
        .entries
        .iter()
        .all(|entry| entry.deleted && entry.path.starts_with(".trash/")));
    std::fs::write(dir.path().join("One.md"), "Occupying external file\n").unwrap();
    let restored = request(&mut vault, json!({"op":"restore","operationId":"restore-work","collectionId":collection.id,"expectedRevision":deleted.snapshot.collections[0].revision})).unwrap();
    assert_eq!(restored.projection.pending, 0, "{:?}", restored.projection);
    assert!(restored
        .snapshot
        .entries
        .iter()
        .all(|entry| !entry.deleted && !entry.path.starts_with(".trash/")));
    assert_eq!(
        std::fs::read_to_string(dir.path().join("One.md")).unwrap(),
        "Occupying external file\n"
    );
    assert!(restored
        .snapshot
        .entries
        .iter()
        .any(|entry| entry.path == "One (restored 2).md"));
}

#[test]
fn external_schema_is_retained_and_reported_without_clobber() {
    let dir = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(dir.path()).unwrap();
    let collection = create(&mut vault);
    let path = dir.path().join(".zorid/types/Work.yaml");
    let source = format!(
        "{}# external retained\n",
        std::fs::read_to_string(&path).unwrap()
    );
    std::fs::write(&path, &source).unwrap();
    let result = request(&mut vault, json!({"op":"update","operationId":"rename-external","collectionId":collection.id,"expectedRevision":collection.revision,"name":"Renamed","properties":collection.properties})).unwrap();
    assert!(result.projection.pending > 0);
    assert!(!result.projection.issues.is_empty());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), source);
    assert!(!dir.path().join(".zorid/types/Renamed.yaml").exists());
}

#[test]
fn internal_schema_symlink_is_never_followed() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(dir.path()).unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.path().join(".zorid/types")).unwrap();
    let result = request(
        &mut vault,
        json!({"op":"create","operationId":"create-blocked","name":"Work"}),
    )
    .unwrap();
    assert_eq!(result.projection.pending, 1);
    assert!(!outside.path().join("Work.yaml").exists());
}

#[test]
fn valid_external_properties_body_and_unknown_frontmatter_reconcile_on_read() {
    let dir = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(dir.path()).unwrap();
    let collection = create(&mut vault);
    entry(&mut vault, &collection, "note-one", "One.md");
    let path = dir.path().join("One.md");
    let source = std::fs::read_to_string(&path).unwrap();
    let external = source
        .replace("\"Status\": \"Not started\"", "\"Status\": \"Done\"")
        .replace("Text 🐈", "External body")
        .replacen("---\n", "---\n# Unknown preserved\nextra: [A, B]\n", 1);
    assert_ne!(external, source);
    std::fs::write(&path, &external).unwrap();
    let result = request(&mut vault, json!({"op":"get","collectionId":collection.id})).unwrap();
    assert_eq!(result.projection.pending, 0, "{:?}", result.projection);
    assert!(
        result.projection.issues.is_empty(),
        "{:?}",
        result.projection
    );
    let status = &collection.properties[0];
    assert_eq!(
        result.snapshot.entries[0].values.get(&status.id),
        Some(&json!(status.options[2].id))
    );
    let saved = std::fs::read_to_string(&path).unwrap();
    assert!(saved.contains("# Unknown preserved\nextra: [A, B]\n"));
    assert!(saved.ends_with("# Keep body\n\nExternal body\n"));
    assert_eq!(
        source::properties(&saved).unwrap().get("Status"),
        Some(&json!("Done"))
    );
}

#[test]
fn external_type_does_not_reassign_and_external_identity_mismatch_is_preserved() {
    let dir = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(dir.path()).unwrap();
    let collection = create(&mut vault);
    entry(&mut vault, &collection, "note-one", "One.md");
    let path = dir.path().join("One.md");
    let source = std::fs::read_to_string(&path).unwrap();
    std::fs::write(
        &path,
        source.replace("\"_type\": \"Work\"", "\"_type\": \"Other\""),
    )
    .unwrap();
    let repaired = request(&mut vault, json!({"op":"get","collectionId":collection.id})).unwrap();
    assert_eq!(repaired.projection.pending, 0, "{:?}", repaired.projection);
    assert_eq!(repaired.snapshot.entries[0].collection_id, collection.id);
    let source = std::fs::read_to_string(&path).unwrap();
    assert_eq!(
        source::properties(&source).unwrap().get("_type"),
        Some(&json!("Work"))
    );
    let invalid = source.replace("\"_id\": \"note-one\"", "\"_id\": \"other-entry\"");
    std::fs::write(&path, &invalid).unwrap();
    let failed = request(&mut vault, json!({"op":"get","collectionId":collection.id})).unwrap();
    assert!(!failed.projection.issues.is_empty());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), invalid);
    assert_eq!(failed.snapshot.entries[0].entry_id.as_str(), "note-one");
}

#[test]
fn repeated_normalization_of_same_canonical_bytes_does_not_reuse_an_old_write_request() {
    let dir = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(dir.path()).unwrap();
    let collection = create(&mut vault);
    entry(&mut vault, &collection, "note-one", "One.md");
    let path = dir.path().join("One.md");
    let canonical = std::fs::read_to_string(&path).unwrap();
    for spaces in ["  ", "   "] {
        let external = canonical.replace("\"Status\": ", &format!("\"Status\":{spaces}"));
        assert_ne!(external, canonical);
        std::fs::write(&path, external).unwrap();
        let result = request(&mut vault, json!({"op":"get","collectionId":collection.id})).unwrap();
        assert_eq!(result.projection.pending, 0, "{:?}", result.projection);
        assert!(
            result.projection.issues.is_empty(),
            "{:?}",
            result.projection
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), canonical);
    }
}

#[test]
fn restart_after_logical_trash_move_requires_actual_physical_publication() {
    fn stop(stage: &str) {
        if stage == "namespace_committed" {
            panic!("interrupted after logical namespace commit");
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(dir.path()).unwrap();
    let collection = create(&mut vault);
    entry(&mut vault, &collection, "note-one", "One.md");
    vault.fault = Some(stop);
    let interrupted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        request(
            &mut vault,
            json!({"op":"delete","operationId":"delete-interrupted","collectionId":collection.id,"expectedRevision":collection.revision}),
        )
    }));
    assert!(interrupted.is_err());
    vault.fault = None;
    drop(vault);
    let mut vault = NativeVault::open_existing(dir.path()).unwrap();
    let result = request(&mut vault, json!({"op":"get","collectionId":collection.id})).unwrap();
    assert_eq!(result.projection.pending, 0, "{:?}", result.projection);
    assert!(!dir.path().join("One.md").exists());
    let trashed = &result.snapshot.entries[0];
    assert!(trashed.deleted && trashed.path.starts_with(".trash/"));
    assert!(std::fs::read_to_string(dir.path().join(&trashed.path))
        .unwrap()
        .ends_with("# Keep body\n\nText 🐈\n"));
}
