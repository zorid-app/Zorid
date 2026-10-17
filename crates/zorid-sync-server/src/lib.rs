//! Ciphertext-only relay. Privileged provisioning methods are fixture/operator
//! APIs, never unauthenticated HTTP endpoints. No vault keys enter this crate.
pub mod http;
mod snapshot;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{fmt, path::Path, time::Duration};
use zeroize::Zeroizing;
use zorid_sync_protocol::{
    Accepted, Cursor, DeviceId, Envelope, LogPosition, ProtocolError, RealmId, ServerEpoch,
    UpdateId, VaultId, MAX_WIRE_BYTES,
};

const APPLICATION_ID: i64 = 0x5a53524c; // ZSRL
const SCHEMA: &[(&str, &str)] = &[
    ("identity", "CREATE TABLE identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), realm TEXT NOT NULL, epoch TEXT NOT NULL) STRICT"),
    ("accounts", "CREATE TABLE accounts (id TEXT PRIMARY KEY NOT NULL) STRICT"),
    ("devices", "CREATE TABLE devices (id TEXT PRIMARY KEY NOT NULL, account TEXT NOT NULL REFERENCES accounts(id), token_hash BLOB NOT NULL UNIQUE CHECK(length(token_hash)=32), revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))) STRICT"),
    ("vaults", "CREATE TABLE vaults (id TEXT PRIMARY KEY NOT NULL) STRICT"),
    ("memberships", "CREATE TABLE memberships (account TEXT NOT NULL REFERENCES accounts(id), vault TEXT NOT NULL REFERENCES vaults(id), can_write INTEGER NOT NULL CHECK(can_write IN (0,1)), PRIMARY KEY(account,vault)) STRICT"),
    ("updates", "CREATE TABLE updates (vault TEXT NOT NULL REFERENCES vaults(id), sequence INTEGER NOT NULL CHECK(sequence>0), update_id TEXT NOT NULL, uploader TEXT NOT NULL REFERENCES devices(id), envelope BLOB NOT NULL CHECK(length(envelope)>=48 AND length(envelope)<=1052720), PRIMARY KEY(vault,sequence), UNIQUE(vault,update_id)) STRICT"),
];

pub const MAX_PAGE_ITEMS: usize = 64;
/// A full maximum-size envelope always fits; base64 HTTP expansion is separate.
pub const MAX_PAGE_BYTES: usize = 2 * MAX_WIRE_BYTES;

#[derive(Debug)]
pub enum RelayError {
    Unauthorized,
    Forbidden,
    Conflict,
    InvalidRequest,
    Corrupt,
    EntropyUnavailable,
    Busy,
    DestinationExists,
    PublicationUnconfirmed,
    UnsupportedPlatform,
    Io(std::io::Error),
    Protocol(ProtocolError),
    Storage(rusqlite::Error),
}
impl fmt::Display for RelayError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Never disclose SQL, credentials, or envelopes via error formatting.
        f.write_str(match self {
            Self::Unauthorized => "unauthorized",
            Self::Forbidden => "forbidden",
            Self::Conflict => "immutable update conflict",
            Self::InvalidRequest => "invalid request",
            Self::Corrupt => "unsupported or corrupt relay database",
            Self::EntropyUnavailable => "system entropy unavailable",
            Self::Busy => "relay busy",
            Self::DestinationExists => "snapshot destination already exists",
            Self::PublicationUnconfirmed => {
                "snapshot published but directory durability unconfirmed"
            }
            Self::UnsupportedPlatform => {
                "durable snapshot publication is not supported on this platform"
            }
            Self::Io(_) => "relay snapshot filesystem failure",
            Self::Protocol(_) => "invalid or unsupported protocol message",
            Self::Storage(_) => "relay storage failure",
        })
    }
}
impl std::error::Error for RelayError {}
impl From<rusqlite::Error> for RelayError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Storage(value)
    }
}
impl From<ProtocolError> for RelayError {
    fn from(value: ProtocolError) -> Self {
        Self::Protocol(value)
    }
}
impl From<std::io::Error> for RelayError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}
pub type Result<T> = std::result::Result<T, RelayError>;

/// Server stores only SHA-256 of this 256-bit random bearer token. This is not a
/// password hash or vault encryption key. No Debug/Serialize/Clone by design.
pub struct BearerToken(Zeroizing<String>);
impl BearerToken {
    fn generate() -> Result<Self> {
        let mut bytes = Zeroizing::new([0u8; 32]);
        getrandom::fill(bytes.as_mut()).map_err(|_| RelayError::EntropyUnavailable)?;
        let mut value = Zeroizing::new(String::with_capacity(64));
        for byte in bytes.iter() {
            use std::fmt::Write;
            write!(value, "{byte:02x}").expect("String write cannot fail");
        }
        Ok(Self(value))
    }
    pub fn parse(value: &str) -> Result<Self> {
        if value.len() != 64
            || !value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(RelayError::Unauthorized);
        }
        Ok(Self(Zeroizing::new(value.to_owned())))
    }
    /// Explicit credential export for the fixture host's secret storage.
    pub fn expose_secret(&self) -> &str {
        &self.0
    }
    fn hash(&self) -> [u8; 32] {
        Sha256::digest(self.0.as_bytes()).into()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Identity {
    pub realm_id: RealmId,
    pub server_epoch: ServerEpoch,
}

pub struct PullItem {
    pub sequence: LogPosition,
    pub envelope: Envelope,
}
pub struct PullPage {
    pub items: Vec<PullItem>,
    pub next: Cursor,
    /// Stable upper bound to send again on continuation; later writes wait for
    /// the next snapshot. Never advance to this bound before applying the page.
    pub through: LogPosition,
    pub complete: bool,
}

pub struct RelayStore {
    connection: Connection,
}
impl RelayStore {
    pub fn open(path: impl AsRef<Path>, realm: &RealmId) -> Result<Self> {
        let mut connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", true)?;
        // Inspect before any journal-mode change; unknown DBs are not adopted.
        {
            let tx = connection.transaction()?;
            if check_schema(&tx)? == 1 && identity(&tx)?.realm_id != *realm {
                return Err(RelayError::Protocol(ProtocolError::ContextMismatch));
            }
            tx.commit()?;
        }
        {
            let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if check_schema(&tx)? == 0 {
                for (_, sql) in SCHEMA {
                    tx.execute_batch(sql)?;
                }
                let epoch = random_epoch()?;
                tx.execute(
                    "INSERT INTO identity VALUES(1,?1,?2)",
                    params![realm.as_str(), epoch.as_str()],
                )?;
                tx.pragma_update(None, "application_id", APPLICATION_ID)?;
                tx.pragma_update(None, "user_version", 1)?;
            }
            if identity(&tx)?.realm_id != *realm {
                return Err(RelayError::Protocol(ProtocolError::ContextMismatch));
            }
            tx.commit()?;
        }
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        Ok(Self { connection })
    }

    pub fn identity(&self) -> Result<Identity> {
        identity(&self.connection)
    }

    /// Privileged snapshot to a NEW protected file. Never overwrites, and the
    /// resulting artifact cannot be opened as a live relay without restore_new.
    pub fn backup_to(&mut self, destination: impl AsRef<Path>) -> Result<Identity> {
        snapshot::backup(self, destination.as_ref())
    }

    /// Offline managed restore into a NEW file, never over a running database.
    /// All restored tokens are revoked before publication; explicit operator
    /// reauthorization is required. Does not restore content encryption keys.
    pub fn restore_new(
        backup: impl AsRef<Path>,
        destination: impl AsRef<Path>,
        realm: &RealmId,
    ) -> Result<Identity> {
        snapshot::restore(backup.as_ref(), destination.as_ref(), realm)
    }

    /// Privileged local reauthorization after independently verifying the account
    /// and device. Restored account/membership records are not proof of identity.
    /// Replaces the credential; old tokens remain invalid even after this call.
    pub fn reauthorize_device(&mut self, account: &str, device: &DeviceId) -> Result<BearerToken> {
        validate_account(account)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let token = BearerToken::generate()?;
        let changed = tx.execute(
            "UPDATE devices SET token_hash=?1,revoked=0 WHERE id=?2 AND account=?3",
            params![token.hash().as_slice(), device.as_str(), account],
        )?;
        if changed != 1 {
            return Err(RelayError::InvalidRequest);
        }
        tx.commit()?;
        Ok(token)
    }

    /// Privileged local fixture/operator API. No public HTTP provisioning route.
    pub fn create_account(&mut self, account: &str) -> Result<()> {
        validate_account(account)?;
        self.connection
            .execute("INSERT INTO accounts(id) VALUES(?1)", [account])?;
        Ok(())
    }
    pub fn create_vault(&mut self, vault: &VaultId) -> Result<()> {
        self.connection
            .execute("INSERT INTO vaults(id) VALUES(?1)", [vault.as_str()])?;
        Ok(())
    }
    pub fn grant_access(&mut self, account: &str, vault: &VaultId, can_write: bool) -> Result<()> {
        validate_account(account)?;
        self.connection.execute("INSERT INTO memberships(account,vault,can_write) VALUES(?1,?2,?3) ON CONFLICT(account,vault) DO UPDATE SET can_write=excluded.can_write", params![account, vault.as_str(), can_write])?;
        Ok(())
    }
    pub fn revoke_access(&mut self, account: &str, vault: &VaultId) -> Result<()> {
        validate_account(account)?;
        self.connection.execute(
            "DELETE FROM memberships WHERE account=?1 AND vault=?2",
            params![account, vault.as_str()],
        )?;
        Ok(())
    }
    pub fn issue_device(&mut self, account: &str, device: &DeviceId) -> Result<BearerToken> {
        validate_account(account)?;
        let token = BearerToken::generate()?;
        self.connection.execute(
            "INSERT INTO devices(id,account,token_hash) VALUES(?1,?2,?3)",
            params![device.as_str(), account, token.hash().as_slice()],
        )?;
        Ok(token)
    }
    pub fn revoke_device(&mut self, device: &DeviceId) -> Result<()> {
        self.connection.execute(
            "UPDATE devices SET revoked=1 WHERE id=?1",
            [device.as_str()],
        )?;
        Ok(())
    }

    pub fn append(
        &mut self,
        token: &BearerToken,
        vault: &VaultId,
        update: &UpdateId,
        raw: &[u8],
    ) -> Result<Accepted> {
        // Raw size bound and structural validation before DB or copies. Relay
        // deliberately does not require a supported decrypted document format.
        let envelope = Envelope::decode(raw)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let uploader = authorize(&tx, token, vault, true)?;
        let identity = identity(&tx)?;
        let header = envelope.header();
        if header.realm_id() != &identity.realm_id
            || header.vault_id() != vault
            || header.update_id() != update
        {
            return Err(RelayError::Protocol(ProtocolError::ContextMismatch));
        }
        // Compare in SQLite without allocating a second ciphertext buffer (or an
        // unbounded Rust buffer if a damaged database bypassed its constraints).
        let existing: Option<(i64, bool, i64)> = tx
            .query_row(
                "SELECT sequence,envelope=?3,length(envelope) FROM updates WHERE vault=?1 AND update_id=?2",
                params![vault.as_str(), update.as_str(),raw],
                |r| Ok((r.get(0)?, r.get(1)?,r.get(2)?)),
            )
            .optional()?;
        let sequence = if let Some((sequence, same_bytes, length)) = existing {
            if sequence <= 0 || !(48..=MAX_WIRE_BYTES as i64).contains(&length) {
                return Err(RelayError::Corrupt);
            }
            if !same_bytes {
                return Err(RelayError::Conflict);
            }
            sequence
        } else {
            let previous: i64 = tx.query_row(
                "SELECT coalesce(max(sequence),0) FROM updates WHERE vault=?1",
                [vault.as_str()],
                |r| r.get(0),
            )?;
            let next = previous.checked_add(1).ok_or(RelayError::Corrupt)?;
            tx.execute("INSERT INTO updates(vault,sequence,update_id,uploader,envelope) VALUES(?1,?2,?3,?4,?5)", params![vault.as_str(),next,update.as_str(),uploader.as_str(),raw])?;
            next
        };
        let receipt = Accepted::new(
            vault.clone(),
            update.clone(),
            identity.server_epoch,
            LogPosition::new(sequence as u64),
        )?;
        tx.commit()?; // Never return an application ACK before durable commit.
        Ok(receipt)
    }

    pub fn pull(
        &mut self,
        token: &BearerToken,
        vault: &VaultId,
        cursor: &Cursor,
        through: Option<LogPosition>,
        limit: usize,
    ) -> Result<PullPage> {
        if !(1..=MAX_PAGE_ITEMS).contains(&limit) {
            return Err(RelayError::InvalidRequest);
        }
        let tx = self.connection.transaction()?;
        authorize(&tx, token, vault, false)?;
        let identity = identity(&tx)?;
        cursor.check_epoch(&identity.server_epoch)?;
        let latest: i64 = tx.query_row(
            "SELECT coalesce(max(sequence),0) FROM updates WHERE vault=?1",
            [vault.as_str()],
            |r| r.get(0),
        )?;
        let through = through.unwrap_or(LogPosition::new(latest as u64));
        if cursor.after > through || through.get() > latest as u64 {
            return Err(RelayError::InvalidRequest);
        }
        let mut items = Vec::new();
        let mut bytes = 0;
        {
            let mut statement = tx.prepare("SELECT sequence,update_id,envelope FROM updates WHERE vault=?1 AND sequence>?2 AND sequence<=?3 ORDER BY sequence LIMIT ?4")?;
            let mut rows = statement.query(params![
                vault.as_str(),
                cursor.after.get() as i64,
                through.get() as i64,
                limit as i64
            ])?;
            while let Some(row) = rows.next()? {
                let sequence: i64 = row.get(0)?;
                let update: String = row.get(1)?;
                let value = row.get_ref(2)?;
                let raw = value.as_blob().map_err(|_| RelayError::Corrupt)?;
                if raw.len() > MAX_WIRE_BYTES {
                    return Err(RelayError::Corrupt);
                }
                if bytes + raw.len() > MAX_PAGE_BYTES {
                    break;
                }
                let envelope = Envelope::decode(raw).map_err(|_| RelayError::Corrupt)?;
                let header = envelope.header();
                if header.realm_id() != &identity.realm_id
                    || header.vault_id() != vault
                    || header.update_id().as_str() != update
                    || sequence as u64 != cursor.after.get() + items.len() as u64 + 1
                {
                    return Err(RelayError::Corrupt);
                }
                bytes += raw.len();
                items.push(PullItem {
                    sequence: LogPosition::new(sequence as u64),
                    envelope,
                });
            }
        }
        let after = items.last().map_or(cursor.after, |item| item.sequence);
        // No GC in v1; a gap must not be silently advanced over.
        if items.is_empty() && after < through {
            return Err(RelayError::Corrupt);
        }
        let page = PullPage {
            items,
            next: Cursor::new(identity.server_epoch, after),
            through,
            complete: after == through,
        };
        tx.commit()?;
        Ok(page)
    }
}

fn authorize(
    connection: &Connection,
    token: &BearerToken,
    vault: &VaultId,
    write: bool,
) -> Result<DeviceId> {
    let device: Option<(String, String)> = connection
        .query_row(
            "SELECT id,account FROM devices WHERE token_hash=?1 AND revoked=0",
            [token.hash().as_slice()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (device, account) = device.ok_or(RelayError::Unauthorized)?;
    let membership: Option<bool> = connection
        .query_row(
            "SELECT can_write FROM memberships WHERE account=?1 AND vault=?2",
            params![account, vault.as_str()],
            |r| r.get(0),
        )
        .optional()?;
    if membership.is_none() || (write && membership != Some(true)) {
        return Err(RelayError::Forbidden);
    }
    DeviceId::new(device).map_err(|_| RelayError::Corrupt)
}
fn validate_account(account: &str) -> Result<()> {
    DeviceId::new(account).map(|_| ()).map_err(Into::into)
}
fn random_epoch() -> Result<ServerEpoch> {
    // Public random identity, independent of all credentials and vault keys.
    Ok(ServerEpoch::new(BearerToken::generate()?.expose_secret())?)
}
fn identity(connection: &Connection) -> Result<Identity> {
    let count: i64 = connection.query_row("SELECT count(*) FROM identity", [], |r| r.get(0))?;
    if count != 1 {
        return Err(RelayError::Corrupt);
    }
    let (realm, epoch): (String, String) = connection.query_row(
        "SELECT realm,epoch FROM identity WHERE singleton=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(Identity {
        realm_id: RealmId::new(realm).map_err(|_| RelayError::Corrupt)?,
        server_epoch: ServerEpoch::new(epoch).map_err(|_| RelayError::Corrupt)?,
    })
}
fn check_schema(connection: &Connection) -> Result<i64> {
    check_schema_for_application(connection, APPLICATION_ID)
}
fn check_schema_for_application(connection: &Connection, expected_application: i64) -> Result<i64> {
    let version: i64 = connection.pragma_query_value(None, "user_version", |r| r.get(0))?;
    let app: i64 = connection.pragma_query_value(None, "application_id", |r| r.get(0))?;
    let count: i64 = connection.query_row(
        "SELECT count(*) FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'",
        [],
        |r| r.get(0),
    )?;
    if version == 0 && app == 0 && count == 0 {
        return Ok(0);
    }
    if version != 1 || app != expected_application || count != SCHEMA.len() as i64 {
        return Err(RelayError::Corrupt);
    }
    for (name, sql) in SCHEMA {
        let actual: Option<String> = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name=?1 AND type='table'",
                [name],
                |r| r.get(0),
            )
            .optional()?;
        if actual.as_deref() != Some(*sql) {
            return Err(RelayError::Corrupt);
        }
    }
    Ok(version)
}
