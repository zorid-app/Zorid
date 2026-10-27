//! Local collection service transport. Replication is deliberately not exposed.
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DATABASE_SCHEMA_VERSION: u32 = 1;
pub const MAX_DATABASE_REQUEST_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_DATABASE_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabaseRequest {
    pub schema_version: u32,
    /// Validated against the closed Store command enum or compose/retry before
    /// executing any work. Arbitrary JSON never supplies query authority.
    pub command: Value,
}
impl DatabaseRequest {
    pub fn operation(&self) -> Option<&str> {
        self.command.get("op")?.as_str()
    }
    pub fn may_commit(&self) -> bool {
        self.operation() != Some("compose")
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseProjectionIssue {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_id: Option<zorid_core::EntryId>,
    pub message: String,
}
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseProjectionReport {
    pub pending: usize,
    pub issues: Vec<DatabaseProjectionIssue>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseComposition {
    pub content: String,
    pub current_source: String,
    pub current_file_revision: String,
    pub entry_revision: String,
    pub collection_revision: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseReply {
    #[serde(flatten)]
    pub snapshot: zorid_store::DatabaseSnapshot,
    pub projection: DatabaseProjectionReport,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub composition: Option<DatabaseComposition>,
}
