use rusqlite::Connection;
use zorid_sqlite::{open_checked, OpenMode};

fn open(path: &std::path::Path, mode: OpenMode) -> rusqlite::Result<Connection> {
    open_checked(path, mode, |_| Ok(()))
}

#[test]
fn checked_connections_apply_durability_and_enforce_foreign_keys_on_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("recovery.sqlite");
    let connection = open(&path, OpenMode::CreateNoFollow).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE snapshots(id INTEGER PRIMARY KEY); \
             CREATE TABLE references_to_snapshots(id INTEGER REFERENCES snapshots(id)); \
             INSERT INTO snapshots VALUES(7); \
             INSERT INTO references_to_snapshots VALUES(7);",
        )
        .unwrap();
    drop(connection);

    let reopened = open(&path, OpenMode::ExistingNoFollow).unwrap();
    assert_eq!(
        reopened
            .pragma_query_value(None, "journal_mode", |r| r.get::<_, String>(0))
            .unwrap(),
        "wal"
    );
    for (pragma, expected) in [
        ("synchronous", 2),
        ("foreign_keys", 1),
        ("busy_timeout", 5000),
    ] {
        assert_eq!(
            reopened
                .pragma_query_value(None, pragma, |r| r.get::<_, i64>(0))
                .unwrap(),
            expected
        );
    }
    assert_eq!(
        reopened
            .query_row("SELECT id FROM snapshots", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        7
    );
    assert!(reopened
        .execute("INSERT INTO references_to_snapshots VALUES(8)", [])
        .is_err());
}

#[test]
fn validation_reads_a_snapshot_before_journal_configuration() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("cache.sqlite");
    drop(Connection::open(&path).unwrap());
    let connection = open_checked(&path, OpenMode::ExistingNoFollow, |snapshot| {
        assert!(!snapshot.is_autocommit());
        assert_eq!(
            snapshot.pragma_query_value(None, "journal_mode", |r| r.get::<_, String>(0))?,
            "delete"
        );
        Ok::<(), rusqlite::Error>(())
    })
    .unwrap();
    assert!(connection.is_autocommit());
    assert_eq!(
        connection
            .pragma_query_value(None, "journal_mode", |r| r.get::<_, String>(0))
            .unwrap(),
        "wal"
    );
}

#[derive(Debug)]
enum ValidationError {
    Sql(rusqlite::Error),
    ForeignDatabase,
}

impl From<rusqlite::Error> for ValidationError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sql(error)
    }
}

#[test]
fn domain_rejection_preserves_foreign_database_bytes_and_journal_mode() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("foreign.sqlite");
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch("PRAGMA user_version=99; CREATE TABLE unrelated(value); INSERT INTO unrelated VALUES(42);")
        .unwrap();
    drop(connection);
    let before = std::fs::read(&path).unwrap();
    let result = open_checked(&path, OpenMode::ExistingNoFollow, |snapshot| {
        let version: i64 = snapshot.pragma_query_value(None, "user_version", |r| r.get(0))?;
        assert_eq!(version, 99);
        Err(ValidationError::ForeignDatabase)
    });
    assert!(matches!(result, Err(ValidationError::ForeignDatabase)));
    assert_eq!(std::fs::read(&path).unwrap(), before);
    let connection = Connection::open(&path).unwrap();
    assert_eq!(
        connection
            .pragma_query_value(None, "journal_mode", |r| r.get::<_, String>(0))
            .unwrap(),
        "delete"
    );
    assert_eq!(
        connection
            .query_row("SELECT value FROM unrelated", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        42
    );
}

#[test]
fn existing_mode_never_creates_a_missing_database() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("missing.sqlite");
    let result = open_checked(&path, OpenMode::ExistingNoFollow, |_| {
        Ok::<(), ValidationError>(())
    });
    match result {
        Err(ValidationError::Sql(error)) => assert!(error.sqlite_error().is_some()),
        _ => panic!("missing database must fail before validation"),
    }
    assert!(!path.exists());
}

#[cfg(unix)]
#[test]
fn no_follow_modes_reject_database_symlinks() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().canonicalize().unwrap();
    let target = parent.join("target.sqlite");
    drop(Connection::open(&target).unwrap());
    let alias = parent.join("alias.sqlite");
    std::os::unix::fs::symlink(&target, &alias).unwrap();
    let before = std::fs::read(&target).unwrap();
    for mode in [OpenMode::CreateNoFollow, OpenMode::ExistingNoFollow] {
        assert!(open(&alias, mode).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), before);
    }
    let directory_alias = parent.join("directory_alias");
    std::os::unix::fs::symlink(&parent, &directory_alias).unwrap();
    for mode in [OpenMode::CreateNoFollow, OpenMode::ExistingNoFollow] {
        assert!(open(&directory_alias.join("target.sqlite"), mode).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), before);
    }
    // Follow mode remains available for explicitly selected database paths.
    drop(open(&alias, OpenMode::Create).unwrap());
}
