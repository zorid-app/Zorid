//! Privileged offline snapshot publication. Backup artifacts deliberately carry
//! a different application ID so normal server startup cannot revive old tokens.
use crate::{
    check_schema_for_application, identity, random_epoch, Identity, RelayError, RelayStore, Result,
    APPLICATION_ID, migrate_schema,
};
use rusqlite::{
    backup::{Backup, StepResult},
    Connection, OpenFlags, TransactionBehavior,
};
use std::{
    fs::{self, File},
    io,
    path::{Path, PathBuf},
};
use tempfile::NamedTempFile;
use zorid_sync_protocol::{DeviceId, Envelope, ProtocolError, RealmId, MAX_WIRE_BYTES};

const BACKUP_APPLICATION_ID: i64 = 0x5a53424b; // ZSBK, not the live ZSRL marker.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Boundary {
    Pinned,
    Copied,
    EpochChanged,
    Secured,
    FileSynced,
    Published,
}

pub(crate) fn backup(store: &mut RelayStore, destination: &Path) -> Result<Identity> {
    backup_with(store, destination, |_| Ok(()))
}

fn backup_with(
    store: &mut RelayStore,
    destination: &Path,
    mut hook: impl FnMut(Boundary) -> Result<()>,
) -> Result<Identity> {
    let tx = store.connection.transaction()?;
    // First SELECT pins a WAL read snapshot. External writers may continue, but
    // account permissions and log bytes copied here are from the same snapshot.
    let original = validate(&tx, APPLICATION_ID)?;
    hook(Boundary::Pinned)?;
    let ready = prepare(&tx, destination, &original.realm_id, false, &mut hook)?;
    tx.commit()?;
    ready.publish(hook)
}

pub(crate) fn restore(backup: &Path, destination: &Path, realm: &RealmId) -> Result<Identity> {
    restore_with(backup, destination, realm, |_| Ok(()))
}

fn restore_with(
    backup: &Path,
    destination: &Path,
    realm: &RealmId,
    mut hook: impl FnMut(Boundary) -> Result<()>,
) -> Result<Identity> {
    // No CREATE, write access, journal changes or repairs to the input artifact.
    let mut source = Connection::open_with_flags(backup, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let tx = source.transaction()?;
    let original = validate(&tx, BACKUP_APPLICATION_ID)?;
    if original.realm_id != *realm {
        return Err(RelayError::Protocol(ProtocolError::ContextMismatch));
    }
    hook(Boundary::Pinned)?;
    let ready = prepare(&tx, destination, realm, true, &mut hook)?;
    tx.commit()?;
    ready.publish(hook)
}

struct PreparedSnapshot {
    staging: NamedTempFile,
    target: PathBuf,
    parent: File,
    identity: Identity,
}

fn prepare(
    source: &Connection,
    destination: &Path,
    realm: &RealmId,
    restoring: bool,
    mut hook: impl FnMut(Boundary) -> Result<()>,
) -> Result<PreparedSnapshot> {
    let (staging, target, parent) = staging(destination)?;
    let mut copy = Connection::open_with_flags(staging.path(), OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    copy.pragma_update(None, "synchronous", "FULL")?;
    {
        let backup = Backup::new(source, &mut copy)?;
        // The source read transaction pins one snapshot across bounded steps.
        // Busy/locked fails cleanly; do not spin indefinitely on an operator job.
        loop {
            match backup.step(256)? {
                StepResult::Done => break,
                StepResult::More => continue,
                StepResult::Busy | StepResult::Locked => return Err(RelayError::Busy),
                _ => return Err(RelayError::Corrupt),
            }
        }
    }
    hook(Boundary::Copied)?;
    // Publication is a self-contained single file, never a database that still
    // depends on a staging-name WAL/journal. The input is never modified.
    let mode: String =
        copy.pragma_update_and_check(None, "journal_mode", "DELETE", |row| row.get(0))?;
    if !mode.eq_ignore_ascii_case("delete") {
        return Err(RelayError::Corrupt);
    }
    copy.pragma_update(None, "foreign_keys", true)?;
    let expected_application = if restoring {
        BACKUP_APPLICATION_ID
    } else {
        APPLICATION_ID
    };
    let original = validate(&copy, expected_application)?;
    if original.realm_id != *realm {
        return Err(RelayError::Protocol(ProtocolError::ContextMismatch));
    }
    let tx = copy.transaction_with_behavior(TransactionBehavior::Immediate)?;
    migrate_schema(&tx)?;
    if restoring {
        let fresh = random_epoch()?;
        if fresh == original.server_epoch {
            return Err(RelayError::EntropyUnavailable);
        }
        tx.execute(
            "UPDATE identity SET epoch=?1 WHERE singleton=1",
            [fresh.as_str()],
        )?;
        hook(Boundary::EpochChanged)?;
        tx.execute("UPDATE devices SET revoked=1", [])?;
        tx.pragma_update(None, "application_id", APPLICATION_ID)?;
    } else {
        tx.pragma_update(None, "application_id", BACKUP_APPLICATION_ID)?;
    }
    tx.commit()?;
    hook(Boundary::Secured)?;
    let result = validate(
        &copy,
        if restoring {
            APPLICATION_ID
        } else {
            BACKUP_APPLICATION_ID
        },
    )?;
    copy.close()
        .map_err(|(_, error)| RelayError::Storage(error))?;
    // SQLite has committed and closed; sync the exact inode before adding its
    // public name. Staging is in the same protected directory/filesystem.
    staging.as_file().sync_all()?;
    hook(Boundary::FileSynced)?;
    Ok(PreparedSnapshot {
        staging,
        target,
        parent,
        identity: result,
    })
}

impl PreparedSnapshot {
    fn publish(self, mut hook: impl FnMut(Boundary) -> Result<()>) -> Result<Identity> {
        match fs::hard_link(self.staging.path(), &self.target) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                return Err(RelayError::DestinationExists)
            }
            Err(error) => return Err(error.into()),
        }
        // From here, errors mean the complete safe artifact may exist. Never unlink
        // that target or claim publication failed without this distinct outcome.
        hook(Boundary::Published).map_err(|_| RelayError::PublicationUnconfirmed)?;
        self.parent
            .sync_all()
            .map_err(|_| RelayError::PublicationUnconfirmed)?;
        // An interrupted cleanup can leave a second private hard link. It cannot
        // expose a half-written or unrevoked restored target. No auto-adoption.
        drop(self.staging);
        Ok(self.identity)
    }
}

#[cfg(unix)]
fn staging(destination: &Path) -> Result<(NamedTempFile, PathBuf, File)> {
    use std::os::unix::fs::MetadataExt;
    let filename = destination.file_name().ok_or(RelayError::InvalidRequest)?;
    let directory = destination
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let directory = fs::canonicalize(directory)?;
    let parent = File::open(&directory)?;
    let metadata = parent.metadata()?;
    if !metadata.is_dir() || metadata.mode() & 0o022 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "snapshot directory must not be writable by other users",
        )
        .into());
    }
    let target = directory.join(filename);
    match fs::symlink_metadata(&target) {
        Ok(_) => return Err(RelayError::DestinationExists),
        Err(error) if error.kind() == io::ErrorKind::NotFound => (),
        Err(error) => return Err(error.into()),
    }
    let staging = tempfile::Builder::new()
        .prefix(".zorid-relay-stage-")
        .tempfile_in(&directory)?;
    let staged = staging.as_file().metadata()?;
    if staged.uid() != metadata.uid() || staged.mode() & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "snapshot directory ownership or file protection mismatch",
        )
        .into());
    }
    Ok((staging, target, parent))
}

#[cfg(not(unix))]
fn staging(_destination: &Path) -> Result<(NamedTempFile, PathBuf, File)> {
    // Directory flush and private ACL publication need a platform implementation;
    // returning success after only a file flush would overclaim durability.
    Err(RelayError::UnsupportedPlatform)
}

fn validate(connection: &Connection, application: i64) -> Result<Identity> {
    if !matches!(check_schema_for_application(connection, application)?, 1 | 2) {
        return Err(RelayError::Corrupt);
    }
    let identity = identity(connection)?;
    let mut check = connection.prepare("PRAGMA integrity_check")?;
    let mut rows = check.query([])?;
    if rows
        .next()?
        .ok_or(RelayError::Corrupt)?
        .get::<_, String>(0)?
        != "ok"
        || rows.next()?.is_some()
    {
        return Err(RelayError::Corrupt);
    }
    let mut foreign = connection.prepare("PRAGMA foreign_key_check")?;
    if foreign.query([])?.next()?.is_some() {
        return Err(RelayError::Corrupt);
    }
    let mut ids = connection.prepare(
        "SELECT id FROM accounts UNION ALL SELECT id FROM devices UNION ALL SELECT id FROM vaults",
    )?;
    let mut ids = ids.query([])?;
    while let Some(row) = ids.next()? {
        DeviceId::new(row.get::<_, String>(0)?).map_err(|_| RelayError::Corrupt)?;
    }
    let mut log = connection
        .prepare("SELECT vault,sequence,update_id,envelope FROM updates ORDER BY vault,sequence")?;
    let mut log = log.query([])?;
    let mut previous_vault = String::new();
    let mut previous = 0i64;
    while let Some(row) = log.next()? {
        let vault: String = row.get(0)?;
        let sequence: i64 = row.get(1)?;
        let update: String = row.get(2)?;
        if vault != previous_vault {
            previous = 0;
        }
        if previous.checked_add(1) != Some(sequence) {
            return Err(RelayError::Corrupt);
        }
        let blob = row.get_ref(3)?;
        let raw = blob.as_blob().map_err(|_| RelayError::Corrupt)?;
        if raw.len() > MAX_WIRE_BYTES {
            return Err(RelayError::Corrupt);
        }
        let envelope = Envelope::decode(raw).map_err(|_| RelayError::Corrupt)?;
        let header = envelope.header();
        if header.realm_id() != &identity.realm_id
            || header.vault_id().as_str() != vault
            || header.update_id().as_str() != update
        {
            return Err(RelayError::Corrupt);
        }
        previous_vault = vault;
        previous = sequence;
    }
    Ok(identity)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::BearerToken;
    use std::{
        os::unix::fs::{symlink, PermissionsExt},
        process::Command,
    };
    use zorid_crypto::{open, seal, SystemEntropy, VaultKey};
    use zorid_sync_protocol::{Cursor, ExpectedContext, Header, UpdateId, VaultId};

    fn realm() -> RealmId {
        RealmId::new("realm").unwrap()
    }
    fn vault() -> VaultId {
        VaultId::new("vault").unwrap()
    }
    fn device() -> DeviceId {
        DeviceId::new("writer").unwrap()
    }
    fn update(id: &str) -> UpdateId {
        UpdateId::new(id).unwrap()
    }
    fn wire(key: &VaultKey, id: &str) -> Vec<u8> {
        let header = Header::new(realm(), vault(), update(id), device(), 1).unwrap();
        seal(
            &header,
            b"private recovery note\0\xff",
            key,
            &mut SystemEntropy,
        )
        .unwrap()
        .encode()
    }
    struct Fixture {
        directory: tempfile::TempDir,
        store: RelayStore,
        writer: BearerToken,
        reader: BearerToken,
        key: VaultKey,
    }
    impl Fixture {
        fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let mut store = RelayStore::open(directory.path().join("live.db"), &realm()).unwrap();
            store.create_account("owner").unwrap();
            store.create_account("reader").unwrap();
            store.create_account("no-access").unwrap();
            store.create_vault(&vault()).unwrap();
            store.grant_access("owner", &vault(), true).unwrap();
            store.grant_access("reader", &vault(), false).unwrap();
            let writer = store.issue_device("owner", &device()).unwrap();
            let reader = store
                .issue_device("reader", &DeviceId::new("reader-device").unwrap())
                .unwrap();
            let key = VaultKey::generate(&mut SystemEntropy).unwrap();
            store
                .append(&writer, &vault(), &update("u1"), &wire(&key, "u1"))
                .unwrap();
            Self {
                directory,
                store,
                writer,
                reader,
                key,
            }
        }
    }

    #[test]
    fn backup_restore_preserves_every_table_but_changes_epoch_and_all_credentials() {
        let mut f = Fixture::new();
        let backup_path = f.directory.path().join("backup.db");
        let retained = wire(&f.key, "u2");
        let initial_cursor = Cursor::start(f.store.identity().unwrap().server_epoch);
        let original_u1 = f
            .store
            .pull(&f.writer, &vault(), &initial_cursor, None, 64)
            .unwrap()
            .items[0]
            .envelope
            .encode();
        let original = f.store.backup_to(&backup_path).unwrap();
        assert_eq!(
            fs::metadata(&backup_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(!f.directory.path().join("backup.db-wal").exists());
        assert!(!f.directory.path().join("backup.db-journal").exists());
        assert!(matches!(
            RelayStore::open(&backup_path, &realm()),
            Err(RelayError::Corrupt)
        ));
        f.store
            .append(&f.writer, &vault(), &update("u2"), &retained)
            .unwrap();
        // A revocation newer than the backup must never be undone by restoring it.
        f.store.revoke_device(&device()).unwrap();
        let source_before = fs::read(&backup_path).unwrap();
        let restored_path = f.directory.path().join("restored.db");
        let restored_id = RelayStore::restore_new(&backup_path, &restored_path, &realm()).unwrap();
        assert_eq!(fs::read(&backup_path).unwrap(), source_before);
        assert_eq!(restored_id.realm_id, original.realm_id);
        assert_ne!(restored_id.server_epoch, original.server_epoch);
        let mut restored = RelayStore::open(&restored_path, &realm()).unwrap();
        let cursor = Cursor::start(restored_id.server_epoch.clone());
        for token in [&f.writer, &f.reader] {
            assert!(matches!(
                restored.pull(token, &vault(), &cursor, None, 64),
                Err(RelayError::Unauthorized)
            ));
        }
        let account_count: i64 = restored
            .connection
            .query_row("SELECT count(*) FROM accounts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(account_count, 3);
        let revoked: i64 = restored
            .connection
            .query_row("SELECT count(*) FROM devices WHERE revoked=1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(revoked, 2);
        assert!(restored.reauthorize_device("reader", &device()).is_err());
        let new_writer = restored.reauthorize_device("owner", &device()).unwrap();
        assert_ne!(new_writer.expose_secret(), f.writer.expose_secret());
        assert!(matches!(
            restored.pull(&f.writer, &vault(), &cursor, None, 64),
            Err(RelayError::Unauthorized)
        ));
        let old_cursor = Cursor::start(original.server_epoch);
        assert!(matches!(
            restored.pull(&new_writer, &vault(), &old_cursor, None, 64),
            Err(RelayError::Protocol(ProtocolError::EpochMismatch))
        ));
        let page = restored
            .pull(&new_writer, &vault(), &cursor, None, 64)
            .unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].envelope.encode(), original_u1);
        let context = ExpectedContext {
            realm_id: realm(),
            vault_id: vault(),
            update_id: update("u1"),
            key_epoch: 1,
        };
        assert_eq!(
            open(&page.items[0].envelope, &context, &f.key)
                .unwrap()
                .as_slice(),
            b"private recovery note\0\xff"
        );
        assert_eq!(
            restored
                .append(&new_writer, &vault(), &update("u1"), &original_u1)
                .unwrap()
                .sequence()
                .get(),
            1
        );
        // Retained local ciphertext lost from the old snapshot can be replayed.
        assert_eq!(
            restored
                .append(&new_writer, &vault(), &update("u2"), &retained)
                .unwrap()
                .sequence()
                .get(),
            2
        );
        let new_reader = restored
            .reauthorize_device("reader", &DeviceId::new("reader-device").unwrap())
            .unwrap();
        assert_eq!(
            restored
                .pull(&new_reader, &vault(), &cursor, None, 64)
                .unwrap()
                .items
                .len(),
            2
        );
        assert!(matches!(
            restored.append(&new_reader, &vault(), &update("u3"), &wire(&f.key, "u3")),
            Err(RelayError::Forbidden)
        ));
    }

    #[test]
    fn online_backup_uses_one_pinned_wal_snapshot_across_permissions_and_log() {
        let mut f = Fixture::new();
        let mut writer = RelayStore::open(f.directory.path().join("live.db"), &realm()).unwrap();
        let backup_path = f.directory.path().join("backup.db");
        backup_with(&mut f.store, &backup_path, |boundary| {
            if boundary == Boundary::Pinned {
                writer.append(&f.writer, &vault(), &update("u2"), &wire(&f.key, "u2"))?;
                writer.grant_access("reader", &vault(), true)?;
                writer.create_account("late-account")?;
            }
            Ok(())
        })
        .unwrap();
        let output = f.directory.path().join("restored.db");
        let identity = RelayStore::restore_new(&backup_path, &output, &realm()).unwrap();
        let mut restored = RelayStore::open(&output, &realm()).unwrap();
        let token = restored
            .reauthorize_device("reader", &DeviceId::new("reader-device").unwrap())
            .unwrap();
        let page = restored
            .pull(
                &token,
                &vault(),
                &Cursor::start(identity.server_epoch),
                None,
                64,
            )
            .unwrap();
        assert_eq!(page.items.len(), 1);
        assert!(matches!(
            restored.append(&token, &vault(), &update("u2"), &wire(&f.key, "u2")),
            Err(RelayError::Forbidden)
        ));
        assert_eq!(
            restored
                .connection
                .query_row(
                    "SELECT count(*) FROM accounts WHERE id='late-account'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        let current = f.store.identity().unwrap();
        assert_eq!(
            f.store
                .pull(
                    &f.writer,
                    &vault(),
                    &Cursor::start(current.server_epoch),
                    None,
                    64
                )
                .unwrap()
                .items
                .len(),
            2
        );
    }

    #[test]
    fn validation_and_publication_errors_never_overwrite_or_partly_restore() {
        let mut f = Fixture::new();
        let backup_path = f.directory.path().join("backup.db");
        f.store.backup_to(&backup_path).unwrap();
        let before = fs::read(&backup_path).unwrap();
        assert!(matches!(
            f.store.backup_to(&backup_path),
            Err(RelayError::DestinationExists)
        ));
        let target = f.directory.path().join("restore.db");
        assert!(
            RelayStore::restore_new(&backup_path, &target, &RealmId::new("wrong").unwrap())
                .is_err()
        );
        assert!(!target.exists());
        // Failure between epoch update and revocation must never publish.
        assert!(restore_with(&backup_path, &target, &realm(), |boundary| {
            if boundary == Boundary::EpochChanged {
                Err(RelayError::InvalidRequest)
            } else {
                Ok(())
            }
        })
        .is_err());
        assert!(!target.exists());
        assert_eq!(fs::read(&backup_path).unwrap(), before);
        // A race after the initial absent-target check cannot overwrite a winner.
        let result = restore_with(&backup_path, &target, &realm(), |boundary| {
            if boundary == Boundary::FileSynced {
                fs::write(&target, b"other owner won")?;
            }
            Ok(())
        });
        assert!(matches!(result, Err(RelayError::DestinationExists)));
        assert_eq!(fs::read(&target).unwrap(), b"other owner won");
        let linked = f.directory.path().join("linked.db");
        symlink(&target, &linked).unwrap();
        assert!(matches!(
            RelayStore::restore_new(&backup_path, &linked, &realm()),
            Err(RelayError::DestinationExists)
        ));
        assert_eq!(fs::read(&target).unwrap(), b"other owner won");
        let ambiguous = f.directory.path().join("ambiguous.db");
        assert!(matches!(
            restore_with(&backup_path, &ambiguous, &realm(), |boundary| {
                if boundary == Boundary::Published {
                    Err(RelayError::InvalidRequest)
                } else {
                    Ok(())
                }
            }),
            Err(RelayError::PublicationUnconfirmed)
        ));
        // Error after publication is explicitly ambiguous, but never unsafe data.
        let mut restored = RelayStore::open(&ambiguous, &realm()).unwrap();
        let cursor = Cursor::start(restored.identity().unwrap().server_epoch);
        assert!(matches!(
            restored.pull(&f.writer, &vault(), &cursor, None, 64),
            Err(RelayError::Unauthorized)
        ));
    }

    #[test]
    fn malformed_snapshot_schema_foreign_keys_and_log_context_are_rejected() {
        let mut f = Fixture::new();
        let backup = f.directory.path().join("backup.db");
        f.store.backup_to(&backup).unwrap();
        for (index, sql) in [
            "CREATE TABLE injected(value TEXT)",
            "DELETE FROM accounts WHERE id='owner'",
            "UPDATE updates SET update_id='mismatch'",
            "UPDATE updates SET sequence=2",
        ]
        .iter()
        .enumerate()
        {
            let damaged = f.directory.path().join(format!("damaged-{index}.db"));
            fs::copy(&backup, &damaged).unwrap();
            let conn = Connection::open(&damaged).unwrap();
            // Deliberately damage only this disposable snapshot. Production
            // connections keep foreign-key enforcement enabled.
            conn.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
            conn.execute_batch(sql).unwrap();
            if index == 1 {
                let violations: i64 = conn
                    .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| row.get(0))
                    .unwrap();
                assert!(violations > 0, "fixture must contain a broken foreign key");
            }
            drop(conn);
            let target = f.directory.path().join(format!("invalid-{index}.db"));
            assert!(RelayStore::restore_new(&damaged, &target, &realm()).is_err());
            assert!(!target.exists());
        }
        // A live DB must not be silently interpreted as an approved snapshot.
        assert!(RelayStore::restore_new(
            f.directory.path().join("live.db"),
            f.directory.path().join("invalid-live.db"),
            &realm()
        )
        .is_err());
        let public = f.directory.path().join("unsafe-directory");
        fs::create_dir(&public).unwrap();
        fs::set_permissions(&public, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(f.store.backup_to(public.join("backup.db")).is_err());
        assert!(!public.join("backup.db").exists());
    }

    #[test]
    #[ignore = "subprocess crash helper; parent test runs exact helper explicitly"]
    fn crash_child() {
        let Some(directory) = std::env::var_os("ZORID_RELAY_CRASH_DIRECTORY") else {
            return;
        };
        let directory = PathBuf::from(directory);
        let stage = std::env::var("ZORID_RELAY_CRASH_STAGE").unwrap();
        restore_with(
            &directory.join("backup.db"),
            &directory.join(format!("{stage}.db")),
            &realm(),
            |boundary| {
                if (stage == "before" && boundary == Boundary::FileSynced)
                    || (stage == "after" && boundary == Boundary::Published)
                {
                    std::process::exit(77);
                }
                Ok(())
            },
        )
        .unwrap();
        panic!("crash hook was not reached");
    }

    #[test]
    fn process_crashes_before_and_after_publication_never_expose_revived_tokens() {
        let mut f = Fixture::new();
        f.store
            .backup_to(f.directory.path().join("backup.db"))
            .unwrap();
        for stage in ["before", "after"] {
            let result = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "snapshot::tests::crash_child", "--ignored"])
                .env("ZORID_RELAY_CRASH_DIRECTORY", f.directory.path())
                .env("ZORID_RELAY_CRASH_STAGE", stage)
                .output()
                .unwrap();
            assert_eq!(result.status.code(), Some(77));
        }
        assert!(!f.directory.path().join("before.db").exists());
        let mut restored = RelayStore::open(f.directory.path().join("after.db"), &realm()).unwrap();
        let cursor = Cursor::start(restored.identity().unwrap().server_epoch);
        assert!(matches!(
            restored.pull(&f.writer, &vault(), &cursor, None, 64),
            Err(RelayError::Unauthorized)
        ));
        let staged: Vec<_> = fs::read_dir(f.directory.path())
            .unwrap()
            .map(|entry| entry.unwrap())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".zorid-relay-stage-")
            })
            .collect();
        assert!(!staged.is_empty());
        assert!(staged
            .iter()
            .all(|entry| entry.metadata().unwrap().permissions().mode() & 0o077 == 0));
    }
}
