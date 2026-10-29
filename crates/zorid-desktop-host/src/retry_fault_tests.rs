use super::*;
use rusqlite::{ffi, Connection};

fn sql(error: rusqlite::Error) -> zorid_native::Error {
    zorid_native::Error::Store(zorid_store::StoreError::Sql(error))
}
fn sqlite_code(code: i32) -> zorid_native::Error {
    sql(rusqlite::Error::SqliteFailure(ffi::Error::new(code), None))
}
fn assert_fault(error: zorid_native::Error, code: &str) {
    let result = native_fault(error);
    assert_eq!(result["code"], code, "{result}");
    assert_eq!(result["commit_uncertain"], true, "classification cannot release an uncertain request");
}

#[test]
fn retry_fault_real_sqlite_busy_is_transient_but_constraint_is_terminal() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("busy.sqlite");
    let first = Connection::open(&path).unwrap();
    first.execute_batch("CREATE TABLE value (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE;").unwrap();
    let second = Connection::open(&path).unwrap();
    second.busy_timeout(std::time::Duration::ZERO).unwrap();
    assert_fault(sql(second.execute("INSERT INTO value VALUES (1)", []).unwrap_err()), "storage_busy");
    first.execute_batch("ROLLBACK; INSERT INTO value VALUES (1);").unwrap();
    assert_fault(sql(first.execute("INSERT INTO value VALUES (1)", []).unwrap_err()), "storage_failed");
}

#[test]
fn retry_fault_real_corrupt_database_and_bad_stored_type_never_become_io() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("not-a-database.sqlite");
    std::fs::write(&path, vec![b'x'; 4096]).unwrap();
    let error = match Connection::open(&path) {
        Err(error) => error,
        Ok(connection) => connection.query_row("SELECT count(*) FROM sqlite_master", [], |row| row.get::<_, i64>(0)).unwrap_err(),
    };
    assert_fault(sql(error), "corrupt_storage");
    let connection = Connection::open_in_memory().unwrap();
    let error = connection.query_row("SELECT 'wrong-type'", [], |row| row.get::<_, i64>(0)).unwrap_err();
    assert_fault(sql(error), "storage_failed");
}

#[test]
fn retry_fault_sqlite_allowlist_preserves_extended_security_and_corruption_codes() {
    for code in [ffi::SQLITE_BUSY, ffi::SQLITE_BUSY_SNAPSHOT, ffi::SQLITE_LOCKED] {
        assert_fault(sqlite_code(code), "storage_busy");
    }
    for code in [ffi::SQLITE_IOERR_READ, ffi::SQLITE_IOERR_WRITE, ffi::SQLITE_IOERR_FSYNC, ffi::SQLITE_IOERR_DIR_FSYNC] {
        assert_fault(sqlite_code(code), "storage_io_retryable");
    }
    for code in [ffi::SQLITE_FULL, ffi::SQLITE_NOMEM] {
        assert_fault(sqlite_code(code), "storage_capacity");
    }
    for code in [ffi::SQLITE_CORRUPT, ffi::SQLITE_NOTADB, ffi::SQLITE_IOERR_DATA, ffi::SQLITE_IOERR_CORRUPTFS] {
        assert_fault(sqlite_code(code), "corrupt_storage");
    }
    for code in [ffi::SQLITE_CONSTRAINT, ffi::SQLITE_READONLY, ffi::SQLITE_AUTH, ffi::SQLITE_PERM,
        ffi::SQLITE_CANTOPEN, ffi::SQLITE_MISUSE, ffi::SQLITE_IOERR, ffi::SQLITE_IOERR_SHORT_READ,
        ffi::SQLITE_IOERR_AUTH, ffi::SQLITE_IOERR_BADKEY, ffi::SQLITE_IOERR_CODEC, ffi::SQLITE_IOERR_CONVPATH] {
        assert_fault(sqlite_code(code), "storage_failed");
    }
}

#[test]
fn retry_fault_file_sync_semantics_are_not_filesystem_io() {
    for error in [zorid_file_sync::Error::AuthenticationFailed, zorid_file_sync::Error::IdentityMismatch,
        zorid_file_sync::Error::InvalidState, zorid_file_sync::Error::VersionConflict] {
        assert_fault(zorid_native::Error::Store(zorid_store::StoreError::FileSync(error)), "file_sync_failed");
    }
}

#[test]
fn retry_fault_filesystem_transients_exclude_invalid_data_permission_and_other() {
    for kind in [io::ErrorKind::Interrupted, io::ErrorKind::WouldBlock, io::ErrorKind::TimedOut,
        io::ErrorKind::WriteZero, io::ErrorKind::StorageFull, io::ErrorKind::QuotaExceeded,
        io::ErrorKind::ResourceBusy, io::ErrorKind::OutOfMemory] {
        assert_fault(zorid_native::Error::Io(io::Error::from(kind)), "filesystem_io_retryable");
    }
    for kind in [io::ErrorKind::PermissionDenied, io::ErrorKind::InvalidData, io::ErrorKind::InvalidInput,
        io::ErrorKind::NotFound, io::ErrorKind::UnexpectedEof, io::ErrorKind::Other] {
        assert_fault(zorid_native::Error::Io(io::Error::from(kind)), "filesystem_failed");
    }
    #[cfg(unix)]
    for errno in [libc::EIO, libc::EAGAIN, libc::EBUSY, libc::ENOSPC, libc::EDQUOT, libc::EMFILE,
        libc::ENFILE, libc::ENOMEM, libc::ESTALE] {
        assert_fault(zorid_native::Error::Io(io::Error::from_raw_os_error(errno)), "filesystem_io_retryable");
    }
}

#[test]
fn retry_fault_checkpoint_uses_same_typed_classification_and_keeps_uncertainty() {
    for (error, expected) in [
        (CheckpointError::Store(zorid_store::StoreError::Sql(rusqlite::Error::SqliteFailure(ffi::Error::new(ffi::SQLITE_BUSY), None))), "storage_busy"),
        (CheckpointError::Store(zorid_store::StoreError::Sql(rusqlite::Error::SqliteFailure(ffi::Error::new(ffi::SQLITE_CORRUPT), None))), "corrupt_storage"),
        (CheckpointError::ExternalStorage(io::Error::other(zorid_native::Error::LockTimeout)), "lock_timeout"),
        (CheckpointError::ExternalStorage(io::Error::other(zorid_native::Error::Io(io::ErrorKind::Interrupted.into()))), "filesystem_io_retryable"),
        (CheckpointError::ExternalStorage(io::Error::other(zorid_native::Error::Unsupported("platform"))), "unsupported"),
        (CheckpointError::ExternalStorage(io::Error::other("untyped legacy failure")), "filesystem_failed"),
    ] {
        let value = checkpoint_fault(error);
        assert_eq!(value["code"], expected, "{value}");
        assert_eq!(value["commit_uncertain"], true);
    }
    for (error, code) in [(CheckpointError::Conflict, "checkpoint_conflict"), (CheckpointError::Invalid, "checkpoint_invalid"),
        (CheckpointError::Limit, "checkpoint_limit"), (CheckpointError::ScopeMismatch, "checkpoint_scope_mismatch")] {
        let value = checkpoint_fault(error);
        assert_eq!(value["code"], code);
        assert_eq!(value["commit_uncertain"], false);
    }
}

