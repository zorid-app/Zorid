use super::*;
use rusqlite::types::Value;
use std::collections::BTreeMap;
use zorid_crypto::{seal, SystemEntropy, VaultKey};
use zorid_sync_protocol::Header;

fn realm() -> RealmId { RealmId::new("realm").unwrap() }
fn vault() -> VaultId { VaultId::new("vault").unwrap() }
fn token() -> BearerToken { BearerToken::parse(&"a".repeat(64)).unwrap() }
fn wire(id: &str, bytes: &[u8]) -> Vec<u8> {
    let header = Header::new(realm(), vault(), UpdateId::new(id).unwrap(), DeviceId::new("device").unwrap(), 1).unwrap();
    seal(&header, bytes, &VaultKey::from_bytes([5; 32]), &mut SystemEntropy).unwrap().encode()
}
fn legacy(path: &Path) -> Vec<u8> {
    let connection = Connection::open(path).unwrap();
    for (name, sql) in SCHEMA { connection.execute_batch(if *name == "updates" { LEGACY_UPDATES_SQL } else { sql }).unwrap(); }
    connection.execute("INSERT INTO identity VALUES(1,'realm','retained-epoch')", []).unwrap();
    connection.execute("INSERT INTO accounts VALUES('account')", []).unwrap();
    connection.execute("INSERT INTO devices VALUES('device','account',?1,0)", [token().hash().as_slice()]).unwrap();
    connection.execute("INSERT INTO vaults VALUES('vault')", []).unwrap();
    connection.execute("INSERT INTO memberships VALUES('account','vault',1)", []).unwrap();
    let raw = wire("retained", b"retained plaintext");
    connection.execute("INSERT INTO updates VALUES('vault',1,'retained','device',?1)", [raw.as_slice()]).unwrap();
    connection.pragma_update(None, "application_id", APPLICATION_ID).unwrap();
    connection.pragma_update(None, "user_version", 1).unwrap();
    raw
}
fn records(connection: &Connection) -> BTreeMap<String, Vec<Vec<Value>>> {
    SCHEMA.iter().map(|(name, _)| {
        let mut statement = connection.prepare(&format!("SELECT * FROM \"{name}\" ORDER BY rowid")).unwrap();
        let columns = statement.column_count();
        let rows = statement.query_map([], |row| (0..columns).map(|column| row.get(column)).collect::<rusqlite::Result<Vec<Value>>>()).unwrap()
            .map(|row| row.unwrap()).collect();
        (name.to_string(), rows)
    }).collect()
}

#[test]
fn one_mib_text_relay_migrates_legacy_ciphertext_and_credentials_then_reopens_larger_wire() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("relay.db");
    let retained = legacy(&path);
    let before = records(&Connection::open(&path).unwrap());
    let mut store = RelayStore::open(&path, &realm()).unwrap();
    assert!(records(&store.connection) == before, "relay migration must preserve every durable row");
    assert_eq!(check_schema(&store.connection).unwrap(), 2);
    let old_identity = store.identity().unwrap();
    let raw = wire("large", &vec![7; 4 * 1024 * 1024 + 64]);
    assert!(raw.len() > 1052720 && raw.len() <= MAX_WIRE_BYTES);
    let accepted = store.append(&token(), &vault(), &UpdateId::new("large").unwrap(), &raw).unwrap();
    assert_eq!(accepted.sequence().get(), 2);
    drop(store);
    let mut store = RelayStore::open(&path, &realm()).unwrap();
    assert_eq!(store.identity().unwrap().server_epoch, old_identity.server_epoch);
    let page = store.pull(&token(), &vault(), &Cursor::start(old_identity.server_epoch), None, 64).unwrap();
    assert_eq!(page.items.len(), 2);
    assert!(page.items[0].envelope.encode() == retained);
    assert!(page.items[1].envelope.encode() == raw);
}

#[test]
fn one_mib_text_relay_rejects_modified_legacy_schema_without_mutation() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("relay.db");
    legacy(&path);
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch("ALTER TABLE updates ADD COLUMN unexpected TEXT").unwrap();
    drop(connection);
    let before = std::fs::read(&path).unwrap();
    assert!(RelayStore::open(&path, &realm()).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[test]
fn one_mib_text_relay_failed_copy_rolls_back_legacy_schema_and_rows() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("relay.db");
    legacy(&path);
    let connection = Connection::open(&path).unwrap();
    // Only this disposable fixture bypasses FK admission to model corrupt input.
    connection.pragma_update(None, "foreign_keys", false).unwrap();
    connection.execute("UPDATE updates SET uploader='missing-device'", []).unwrap();
    drop(connection);
    let before = std::fs::read(&path).unwrap();
    assert!(RelayStore::open(&path, &realm()).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[test]
fn one_mib_text_relay_restores_legacy_backup_to_current_schema_without_changing_source() {
    let directory = tempfile::tempdir().unwrap();
    let backup = directory.path().join("backup.db");
    let destination = directory.path().join("restored.db");
    let retained = legacy(&backup);
    let connection = Connection::open(&backup).unwrap();
    connection.pragma_update(None, "application_id", 0x5a53424b).unwrap();
    drop(connection);
    let before = std::fs::read(&backup).unwrap();
    let restored = RelayStore::restore_new(&backup, &destination, &realm()).unwrap();
    assert_ne!(restored.server_epoch, ServerEpoch::new("retained-epoch").unwrap());
    assert_eq!(std::fs::read(&backup).unwrap(), before);
    let mut store = RelayStore::open(&destination, &realm()).unwrap();
    assert_eq!(check_schema(&store.connection).unwrap(), 2);
    let raw: Vec<u8> = store.connection.query_row("SELECT envelope FROM updates WHERE update_id='retained'", [], |row| row.get(0)).unwrap();
    assert!(raw == retained);
    assert!(matches!(store.pull(&token(), &vault(), &Cursor::start(restored.server_epoch), None, 64), Err(RelayError::Unauthorized)));
}
