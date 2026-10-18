use zorid_store::{Store, StoreError};

#[test]
fn existing_mode_rejects_missing_and_empty_databases_without_initializing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("vault.sqlite");
    assert!(matches!(
        Store::open_existing_no_follow(&path),
        Err(StoreError::Sql(rusqlite::Error::SqliteFailure(error, _)))
            if error.code == rusqlite::ErrorCode::CannotOpen
    ));
    assert!(!path.exists());
    drop(rusqlite::Connection::open(&path).unwrap());
    let before = std::fs::read(&path).unwrap();
    assert!(matches!(
        Store::open_existing_no_follow(&path),
        Err(StoreError::Corrupt(_))
    ));
    assert_eq!(std::fs::read(&path).unwrap(), before);
    // Also reject a valid SQLite header with no initialized application schema.
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute_batch("CREATE TABLE temporary_fixture(value); DROP TABLE temporary_fixture;")
        .unwrap();
    drop(connection);
    let before = std::fs::read(&path).unwrap();
    assert!(matches!(
        Store::open_existing_no_follow(&path),
        Err(StoreError::Corrupt(_))
    ));
    assert_eq!(std::fs::read(&path).unwrap(), before);
    drop(Store::open_no_follow(&path).unwrap());
    assert!(Store::open_existing_no_follow(&path)
        .unwrap()
        .list()
        .unwrap()
        .is_empty());
}

#[cfg(unix)]
#[test]
fn store_no_follow_modes_reject_symlinks_without_changing_target() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().canonicalize().unwrap();
    let target = parent.join("vault.sqlite");
    drop(Store::open(&target).unwrap());
    let alias = parent.join("alias.sqlite");
    std::os::unix::fs::symlink(&target, &alias).unwrap();
    let before = std::fs::read(&target).unwrap();
    assert!(Store::open_no_follow(&alias).is_err());
    assert!(Store::open_existing_no_follow(&alias).is_err());
    assert_eq!(std::fs::read(&target).unwrap(), before);
}
