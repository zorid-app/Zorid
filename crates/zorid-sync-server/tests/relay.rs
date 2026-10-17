use rusqlite::Connection;
use std::{sync::mpsc, time::Duration};
use tempfile::TempDir;
use zorid_crypto::{seal, SystemEntropy, VaultKey};
use zorid_sync_protocol::{
    Cursor, DeviceId, Envelope, Header, LogPosition, ProtocolError, RealmId, ServerEpoch, UpdateId,
    VaultId, MAX_PLAINTEXT_BYTES,
};
use zorid_sync_server::{BearerToken, RelayError, RelayStore, MAX_PAGE_BYTES};

fn realm() -> RealmId {
    RealmId::new("realm").unwrap()
}
fn vault() -> VaultId {
    VaultId::new("vault-a").unwrap()
}
fn update(id: &str) -> UpdateId {
    UpdateId::new(id).unwrap()
}
fn device(id: &str) -> DeviceId {
    DeviceId::new(id).unwrap()
}
struct Fixture {
    dir: TempDir,
    store: RelayStore,
    a: BearerToken,
    b: BearerToken,
    reader: BearerToken,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut store = RelayStore::open(dir.path().join("relay.db"), &realm()).unwrap();
        store.create_account("account-a").unwrap();
        store.create_account("account-b").unwrap();
        store.create_account("reader").unwrap();
        store.create_vault(&vault()).unwrap();
        store
            .create_vault(&VaultId::new("vault-b").unwrap())
            .unwrap();
        store.grant_access("account-a", &vault(), true).unwrap();
        store
            .grant_access("account-b", &VaultId::new("vault-b").unwrap(), true)
            .unwrap();
        store.grant_access("reader", &vault(), false).unwrap();
        let a = store
            .issue_device("account-a", &device("device-a"))
            .unwrap();
        let b = store
            .issue_device("account-b", &device("device-b"))
            .unwrap();
        let reader = store
            .issue_device("reader", &device("device-reader"))
            .unwrap();
        Self {
            dir,
            store,
            a,
            b,
            reader,
        }
    }
    fn cursor(&self) -> Cursor {
        Cursor::start(self.store.identity().unwrap().server_epoch)
    }
    fn raw(id: &str, plaintext: &[u8]) -> Vec<u8> {
        let header = Header::new(realm(), vault(), update(id), device("origin-a"), 1).unwrap();
        let key = VaultKey::generate(&mut SystemEntropy).unwrap();
        seal(&header, plaintext, &key, &mut SystemEntropy)
            .unwrap()
            .encode()
    }
}

#[test]
fn durable_lost_ack_retry_and_immutable_identity() {
    let mut f = Fixture::new();
    let raw = Fixture::raw("u1", b"sensitive-note-not-in-server-plaintext");
    let first = f.store.append(&f.a, &vault(), &update("u1"), &raw).unwrap();
    assert_eq!(first.sequence().get(), 1);
    // Drop connection and lose ACK; fresh process-equivalent connection retries.
    f.store = RelayStore::open(f.dir.path().join("relay.db"), &realm()).unwrap();
    let retry = f.store.append(&f.a, &vault(), &update("u1"), &raw).unwrap();
    assert_eq!(retry.sequence(), first.sequence());
    assert!(matches!(
        f.store.append(
            &f.a,
            &vault(),
            &update("u1"),
            &Fixture::raw("u1", b"changed")
        ),
        Err(RelayError::Conflict)
    ));
    assert!(matches!(
        f.store.append(&f.a, &vault(), &update("other"), &raw),
        Err(RelayError::Protocol(ProtocolError::ContextMismatch))
    ));
    // Another authorized device can replay original ciphertext for recovery;
    // header origin is not claimed to be a device signature.
    let second = f
        .store
        .issue_device("account-a", &device("device-second"))
        .unwrap();
    assert_eq!(
        f.store
            .append(&second, &vault(), &update("u1"), &raw)
            .unwrap()
            .sequence(),
        first.sequence()
    );
    let cursor = f.cursor();
    let page = f.store.pull(&second, &vault(), &cursor, None, 64).unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].envelope.encode(), raw);
    let db = Connection::open(f.dir.path().join("relay.db")).unwrap();
    let saved: Vec<u8> = db
        .query_row("SELECT envelope FROM updates", [], |r| r.get(0))
        .unwrap();
    let marker = b"sensitive-note-not-in-server-plaintext";
    assert!(!saved.windows(marker.len()).any(|w| w == marker));
    let hash: Vec<u8> = db
        .query_row(
            "SELECT token_hash FROM devices WHERE id='device-a'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(hash.len(), 32);
    assert_ne!(hash, f.a.expose_secret().as_bytes());
}

#[test]
fn account_vault_read_write_revocation_isolation_including_retries() {
    let mut f = Fixture::new();
    let raw = Fixture::raw("u1", b"private");
    f.store.append(&f.a, &vault(), &update("u1"), &raw).unwrap();
    let cursor = f.cursor();
    assert!(matches!(
        f.store.pull(&f.b, &vault(), &cursor, None, 64),
        Err(RelayError::Forbidden)
    ));
    assert!(matches!(
        f.store.append(&f.b, &vault(), &update("u1"), &raw),
        Err(RelayError::Forbidden)
    ));
    assert_eq!(
        f.store
            .pull(&f.reader, &vault(), &cursor, None, 64)
            .unwrap()
            .items
            .len(),
        1
    );
    assert!(matches!(
        f.store.append(&f.reader, &vault(), &update("u1"), &raw),
        Err(RelayError::Forbidden)
    ));
    f.store.revoke_access("reader", &vault()).unwrap();
    assert!(matches!(
        f.store.pull(&f.reader, &vault(), &cursor, None, 64),
        Err(RelayError::Forbidden)
    ));
    f.store.revoke_device(&device("device-a")).unwrap();
    assert!(matches!(
        f.store.append(&f.a, &vault(), &update("u1"), &raw),
        Err(RelayError::Unauthorized)
    ));
    assert!(matches!(
        f.store.pull(&f.a, &vault(), &cursor, None, 64),
        Err(RelayError::Unauthorized)
    ));
    assert!(BearerToken::parse("weak-token").is_err());
    let unknown = BearerToken::parse(&"0".repeat(64)).unwrap();
    assert!(matches!(
        f.store.pull(&unknown, &vault(), &cursor, None, 64),
        Err(RelayError::Unauthorized)
    ));
}

#[test]
fn bounded_snapshot_pages_do_not_skip_bytes_or_include_later_writes() {
    let mut f = Fixture::new();
    let large = vec![7; MAX_PLAINTEXT_BYTES];
    for id in ["one", "two", "three", "four"] {
        f.store
            .append(&f.a, &vault(), &update(id), &Fixture::raw(id, &large))
            .unwrap();
    }
    let cursor = f.cursor();
    let page = f.store.pull(&f.a, &vault(), &cursor, None, 64).unwrap();
    assert_eq!(page.items.len(), 2);
    assert!(
        page.items
            .iter()
            .map(|i| i.envelope.encode().len())
            .sum::<usize>()
            <= MAX_PAGE_BYTES
    );
    assert_eq!(page.next.after.get(), 2);
    assert_eq!(page.through.get(), 4);
    assert!(!page.complete);
    f.store
        .append(
            &f.a,
            &vault(),
            &update("five"),
            &Fixture::raw("five", b"later"),
        )
        .unwrap();
    let next = f
        .store
        .pull(&f.a, &vault(), &page.next, Some(page.through), 1)
        .unwrap();
    assert_eq!(next.items[0].sequence.get(), 3);
    let final_page = f
        .store
        .pull(&f.a, &vault(), &next.next, Some(next.through), 64)
        .unwrap();
    assert_eq!(final_page.items.len(), 1);
    assert!(final_page.complete);
    let later = f
        .store
        .pull(&f.a, &vault(), &final_page.next, None, 64)
        .unwrap();
    assert_eq!(later.items[0].sequence.get(), 5);
    assert!(later.complete);
    assert!(f
        .store
        .pull(&f.a, &vault(), &later.next, Some(LogPosition::new(4)), 64)
        .is_err());
    assert!(f
        .store
        .pull(&f.a, &vault(), &cursor, Some(LogPosition::new(6)), 64)
        .is_err());
    for limit in [0, 65] {
        assert!(f.store.pull(&f.a, &vault(), &cursor, None, limit).is_err());
    }
    let stale = Cursor::start(ServerEpoch::new("old-restore-epoch").unwrap());
    assert!(matches!(
        f.store.pull(&f.a, &vault(), &stale, None, 64),
        Err(RelayError::Protocol(ProtocolError::EpochMismatch))
    ));
}

#[test]
fn opaque_future_document_format_relay_and_wrong_realm_rejection() {
    let mut f = Fixture::new();
    let wire = Fixture::raw("future", b"opaque");
    let envelope = Envelope::decode(&wire).unwrap();
    let mut header: serde_json::Value = serde_json::from_slice(envelope.header_bytes()).unwrap();
    header["document_format_version"] = 2.into();
    let future = Envelope::from_parts(
        &serde_json::to_vec(&header).unwrap(),
        *envelope.nonce(),
        envelope.ciphertext(),
    )
    .unwrap();
    // Deliberately no ability to validate the AEAD tag server-side.
    f.store
        .append(&f.a, &vault(), &update("future"), &future.encode())
        .unwrap();
    header["realm_id"] = "other".into();
    let wrong = Envelope::from_parts(
        &serde_json::to_vec(&header).unwrap(),
        *envelope.nonce(),
        envelope.ciphertext(),
    )
    .unwrap();
    assert!(matches!(
        f.store
            .append(&f.a, &vault(), &update("future"), &wrong.encode()),
        Err(RelayError::Protocol(ProtocolError::ContextMismatch))
    ));
}

#[test]
fn append_failure_rolls_back_and_unknown_schema_is_untouched() {
    let mut f = Fixture::new();
    let db = Connection::open(f.dir.path().join("relay.db")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_append BEFORE INSERT ON updates BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
    let raw = Fixture::raw("u1", b"data");
    assert!(f.store.append(&f.a, &vault(), &update("u1"), &raw).is_err());
    let cursor = f.cursor();
    assert!(f
        .store
        .pull(&f.a, &vault(), &cursor, None, 64)
        .unwrap()
        .items
        .is_empty());
    db.execute_batch("DROP TRIGGER fail_append").unwrap();
    assert_eq!(
        f.store
            .append(&f.a, &vault(), &update("u1"), &raw)
            .unwrap()
            .sequence()
            .get(),
        1
    );
    let foreign_path = f.dir.path().join("foreign.db");
    let foreign = Connection::open(&foreign_path).unwrap();
    foreign
        .execute_batch("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('keep');")
        .unwrap();
    drop(foreign);
    let before = std::fs::read(&foreign_path).unwrap();
    assert!(matches!(
        RelayStore::open(&foreign_path, &realm()),
        Err(RelayError::Corrupt)
    ));
    assert_eq!(std::fs::read(&foreign_path).unwrap(), before);
    assert!(!f.dir.path().join("foreign.db-wal").exists());
}

#[test]
fn revoke_committed_while_append_waits_is_rechecked_before_duplicate_ack() {
    let mut f = Fixture::new();
    let raw = Fixture::raw("u1", b"data");
    f.store.append(&f.a, &vault(), &update("u1"), &raw).unwrap();
    // Independent pre-opened connection, so authorization cannot be cached at
    // open. SQLite lock serializes the operation, not a Rust process mutex.
    let mut other = RelayStore::open(f.dir.path().join("relay.db"), &realm()).unwrap();
    let token = BearerToken::parse(f.a.expose_secret()).unwrap();
    let db = Connection::open(f.dir.path().join("relay.db")).unwrap();
    db.execute_batch("BEGIN IMMEDIATE; UPDATE devices SET revoked=1 WHERE id='device-a';")
        .unwrap();
    let (started_tx, started_rx) = mpsc::channel();
    let (result_tx, result_rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        started_tx.send(()).unwrap();
        result_tx
            .send(other.append(&token, &vault(), &update("u1"), &raw))
            .unwrap();
    });
    started_rx.recv().unwrap();
    assert!(matches!(
        result_rx.recv_timeout(Duration::from_millis(100)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    db.execute_batch("COMMIT").unwrap();
    assert!(matches!(
        result_rx.recv_timeout(Duration::from_secs(5)).unwrap(),
        Err(RelayError::Unauthorized)
    ));
    worker.join().unwrap();
}
