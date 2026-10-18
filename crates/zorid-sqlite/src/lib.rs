//! Native SQLite connection policy. Callers own their schemas and transactions;
//! this module never repairs, resets or migrates a database.

use rusqlite::{Connection, OpenFlags};
use std::{path::Path, time::Duration};

/// How to open the explicitly selected database path.
///
/// No-follow modes reject symbolic links in the database filename, including
/// parent directories. Callers must select a checked canonical database location.
/// Existing mode forbids file creation, but schema validation
/// must still reject an existing empty/uninitialized database when required.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OpenMode {
    Create,
    CreateNoFollow,
    ExistingNoFollow,
}

/// Open and validate a database before enabling the native durable-write policy.
///
/// `validate` runs in a read transaction and must only inspect the database. It
/// owns format/application/schema checks and returns the caller's domain errors.
/// Rejection leaves the journal mode and schema untouched. A missing file may
/// have been created in a create mode, but no schema is initialized here.
///
/// Successful connections use a five-second busy timeout, WAL journaling, FULL
/// synchronization and foreign-key enforcement. SQLite uses its memory journal
/// for in-memory databases instead of WAL. Each process opens its own connection.
///
/// Validation is not a schema lock: callers that initialize or migrate must
/// revalidate inside their own IMMEDIATE transaction before changing schema.
pub fn open_checked<E>(
    path: impl AsRef<Path>,
    mode: OpenMode,
    validate: impl FnOnce(&Connection) -> Result<(), E>,
) -> Result<Connection, E>
where
    E: From<rusqlite::Error>,
{
    let mut flags = OpenFlags::default();
    if mode != OpenMode::Create {
        flags |= OpenFlags::SQLITE_OPEN_NOFOLLOW;
    }
    if mode == OpenMode::ExistingNoFollow {
        flags.remove(OpenFlags::SQLITE_OPEN_CREATE);
    }
    let mut connection = Connection::open_with_flags(path, flags)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    {
        let snapshot = connection.transaction()?;
        validate(&snapshot)?;
        snapshot.commit()?;
    }
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "FULL")?;
    connection.pragma_update(None, "foreign_keys", true)?;
    Ok(connection)
}
