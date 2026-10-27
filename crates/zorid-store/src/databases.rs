//! Local collection authority. No enrollment, CRDT or network side effects.
//! Readable files are recoverable projections; native owns guarded publication.
use super::*;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use unicode_normalization::UnicodeNormalization;
use zorid_core::{OperationId, VaultPath};
use zorid_crypto::{EntropySource, SystemEntropy};

const MAX_COLLECTIONS: usize = 256;
const MAX_ENTRIES: usize = 4096;
const MAX_PROPERTIES: usize = 128;
const MAX_OPTIONS: usize = 128;
const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_COMMAND_BYTES: usize = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_ENTRY_BYTES: usize = 64 * 1024;
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

pub(super) const SCHEMA: &[(&str, &str)] = &[
    ("local_database_state", "CREATE TABLE local_database_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL CHECK(revision>=0))"),
    ("local_collections", "CREATE TABLE local_collections (id TEXT PRIMARY KEY NOT NULL, name_key TEXT NOT NULL UNIQUE, revision TEXT NOT NULL, deleted INTEGER NOT NULL CHECK(deleted IN (0,1)), model TEXT NOT NULL CHECK(length(model)<=1048576), projected_path TEXT, projected_source TEXT)"),
    ("local_collection_entries", "CREATE TABLE local_collection_entries (entry_id TEXT PRIMARY KEY NOT NULL, collection_id TEXT NOT NULL REFERENCES local_collections(id), revision TEXT NOT NULL, deleted INTEGER NOT NULL CHECK(deleted IN (0,1)), values_json TEXT NOT NULL CHECK(length(values_json)<=65536), preserved_json TEXT NOT NULL CHECK(length(preserved_json)<=65536), original_path TEXT NOT NULL, projected_properties TEXT NOT NULL CHECK(length(projected_properties)<=1048576))"),
    ("local_collection_members", "CREATE INDEX local_collection_members ON local_collection_entries(collection_id,entry_id)"),
    ("local_database_projections", "CREATE TABLE local_database_projections (entry_id TEXT PRIMARY KEY NOT NULL REFERENCES local_collection_entries(entry_id), kind TEXT NOT NULL CHECK(kind IN ('properties','trash','restore')))"),
    ("local_database_schema_projections", "CREATE TABLE local_database_schema_projections (collection_id TEXT PRIMARY KEY NOT NULL REFERENCES local_collections(id))"),
    ("local_database_operations", "CREATE TABLE local_database_operations (operation_id TEXT PRIMARY KEY NOT NULL, request TEXT NOT NULL CHECK(length(request)<=10485760), response TEXT NOT NULL CHECK(length(response)<=16777216))"),
    ("local_database_history", "CREATE TABLE local_database_history (sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL REFERENCES local_database_operations(operation_id) DEFERRABLE INITIALLY DEFERRED, collection_id TEXT NOT NULL, entry_id TEXT, record TEXT NOT NULL CHECK(length(record)<=1048576))"),
    ("local_database_history_collection", "CREATE INDEX local_database_history_collection ON local_database_history(collection_id,sequence)"),
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DatabaseDatatype {
    Text,
    Number,
    Checkbox,
    Date,
    Datetime,
    Select,
    MultiSelect,
    Status,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabaseOption {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabaseProperty {
    pub id: String,
    pub name: String,
    pub datatype: DatabaseDatatype,
    #[serde(default)]
    pub options: Vec<DatabaseOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabaseOptionInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabasePropertyInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub datatype: DatabaseDatatype,
    #[serde(default)]
    pub options: Vec<DatabaseOptionInput>,
    #[serde(default)]
    pub default: Option<Value>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabaseCollection {
    pub id: String,
    pub name: String,
    pub revision: String,
    pub deleted: bool,
    pub properties: Vec<DatabaseProperty>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabaseEntry {
    pub entry_id: EntryId,
    pub collection_id: String,
    pub revision: String,
    pub file_revision: Option<Revision>,
    pub path: String,
    pub values: BTreeMap<String, Value>,
    pub deleted: bool,
    pub pending_projection: bool,
    /// Incompatible source values stay visible for correction, never retyped.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub problems: BTreeMap<String, String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabaseSnapshot {
    pub collections: Vec<DatabaseCollection>,
    pub entries: Vec<DatabaseEntry>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "op",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DatabaseRequest {
    List,
    Get {
        collection_id: String,
    },
    GetEntry {
        entry_id: EntryId,
    },
    Create {
        operation_id: OperationId,
        name: String,
        #[serde(default)]
        preset: Option<String>,
        #[serde(default)]
        properties: Vec<DatabasePropertyInput>,
    },
    Update {
        operation_id: OperationId,
        collection_id: String,
        expected_revision: String,
        name: String,
        properties: Vec<DatabasePropertyInput>,
        #[serde(default)]
        confirm_destructive: bool,
    },
    CreateEntry {
        operation_id: OperationId,
        collection_id: String,
        expected_collection_revision: String,
        entry_id: EntryId,
        path: String,
        #[serde(default)]
        body: String,
        #[serde(default)]
        values: BTreeMap<String, Value>,
    },
    SetEntry {
        operation_id: OperationId,
        entry_id: EntryId,
        expected_revision: String,
        expected_collection_revision: String,
        values: BTreeMap<String, Value>,
    },
    DuplicateEntry {
        operation_id: OperationId,
        entry_id: EntryId,
        expected_revision: String,
        new_entry_id: EntryId,
        path: String,
    },
    Delete {
        operation_id: OperationId,
        collection_id: String,
        expected_revision: String,
    },
    Restore {
        operation_id: OperationId,
        collection_id: String,
        expected_revision: String,
    },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseProjectionKind {
    Properties,
    Trash,
    Restore,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabaseProjection {
    pub entry_id: EntryId,
    pub collection_id: String,
    pub entry_revision: String,
    pub collection_revision: String,
    pub kind: DatabaseProjectionKind,
    pub properties: BTreeMap<String, Value>,
    pub previous_properties: BTreeMap<String, Value>,
    pub previous_keys: Vec<String>,
    pub original_path: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabaseSchemaProjection {
    pub collection_id: String,
    pub revision: String,
    pub path: String,
    pub source: String,
    pub previous_path: Option<String>,
    pub previous_source: Option<String>,
    pub deleted: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabaseQueryState {
    pub revision: String,
    pub collections: Vec<DatabaseCollection>,
    pub entries: Vec<DatabaseEntry>,
}

fn invalid(reason: impl Into<String>) -> StoreError {
    ContractError::InvalidMutation {
        reason: reason.into(),
    }
    .into()
}
fn check_schema_id(id: &str) -> Result<()> {
    if id.len() != 12
        || !id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    {
        return Err(invalid("Invalid collection schema identity"));
    }
    Ok(())
}
fn random_id() -> Result<String> {
    // Rejection sampling makes all 36 characters equiprobable (252 = 7*36).
    let mut result = String::with_capacity(12);
    while result.len() < 12 {
        let mut bytes = [0; 32];
        SystemEntropy.fill(&mut bytes)?;
        for byte in bytes {
            if byte < 252 {
                result.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(byte % 36) as usize] as char);
                if result.len() == 12 {
                    break;
                }
            }
        }
    }
    Ok(result)
}
fn new_revision() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn label(text: &str) -> Result<()> {
    if text.trim().is_empty() || text.len() > 256 || text.chars().any(char::is_control) {
        return Err(invalid(
            "Names must be nonempty single-line text of at most 256 bytes",
        ));
    }
    Ok(())
}
fn collection_name(text: &str) -> Result<String> {
    label(text)?;
    if text != text.trim()
        || text.ends_with('.')
        || text.chars().any(|c| "<>:\"/\\|?*".contains(c))
        || text == "."
        || text == ".."
    {
        return Err(invalid("Collection name must be a portable filename"));
    }
    let stem = text.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    {
        return Err(invalid(
            "Collection name is reserved on supported filesystems",
        ));
    }
    Ok(text
        .nfc()
        .flat_map(char::to_lowercase)
        .collect::<String>()
        .nfc()
        .collect())
}
fn bounded<T: Serialize>(value: &T, limit: usize) -> Result<String> {
    let text = serde_json::to_string(value)?;
    if text.len() > limit {
        return Err(invalid("Local collection data exceeds its byte limit"));
    }
    Ok(text)
}
fn load_collection(tx: &Connection, id: &str) -> Result<Option<DatabaseCollection>> {
    let raw: Option<(String, String, i64)> = tx
        .query_row(
            "SELECT model,revision,deleted FROM local_collections WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    raw.map(|(json, revision, deleted)| {
        let collection: DatabaseCollection = serde_json::from_str(&json)?;
        if collection.id != id
            || collection.revision != revision
            || collection.deleted != (deleted == 1)
        {
            return Err(StoreError::Corrupt("collection columns disagree".into()));
        }
        Ok(collection)
    })
    .transpose()
}
fn require_collection(
    tx: &Connection,
    id: &str,
    expected: Option<&str>,
    active: bool,
) -> Result<DatabaseCollection> {
    check_schema_id(id)?;
    if expected.is_some_and(|value| value.len() > 128) {
        return Err(invalid("Invalid expected collection revision"));
    }
    let collection =
        load_collection(tx, id)?.ok_or_else(|| invalid("Collection does not exist"))?;
    if expected.is_some_and(|value| value != collection.revision) {
        return Err(invalid("Collection changed; reload before saving"));
    }
    if active && collection.deleted {
        return Err(invalid("Collection is deleted"));
    }
    Ok(collection)
}
fn save_collection(tx: &Connection, collection: &DatabaseCollection) -> Result<()> {
    let name_key = collection_name(&collection.name)?;
    let occupied: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM local_collections WHERE name_key=?1 AND id<>?2)",
        params![name_key, collection.id],
        |r| r.get(0),
    )?;
    if occupied {
        return Err(invalid(
            "A collection with this name already exists, including Trash",
        ));
    }
    tx.execute("INSERT INTO local_collections(id,name_key,revision,deleted,model) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET name_key=excluded.name_key,revision=excluded.revision,deleted=excluded.deleted,model=excluded.model", params![collection.id,name_key,collection.revision,collection.deleted,bounded(collection,MAX_REQUEST_BYTES)?])?;
    tx.execute(
        "INSERT OR IGNORE INTO local_database_schema_projections(collection_id) VALUES(?1)",
        [&collection.id],
    )?;
    Ok(())
}
fn build_properties(
    inputs: &[DatabasePropertyInput],
    previous: Option<&DatabaseCollection>,
    tx: &Connection,
) -> Result<Vec<DatabaseProperty>> {
    if inputs.len() > MAX_PROPERTIES {
        return Err(invalid("Too many collection properties"));
    }
    let mut ids = BTreeSet::new();
    let mut names = BTreeSet::new();
    let mut result = Vec::new();
    for input in inputs {
        label(&input.name)?;
        if matches!(input.name.as_str(), "_id" | "_type") || !names.insert(input.name.clone()) {
            return Err(invalid(
                "Property names must be unique and cannot use _id or _type",
            ));
        }
        let id = match &input.id {
            Some(id) => {
                check_schema_id(id)?;
                if !previous.is_some_and(|p| p.properties.iter().any(|v| &v.id == id)) {
                    return Err(invalid("Unknown property identity"));
                }
                id.clone()
            }
            None => allocate_identity(tx, &ids)?,
        };
        if !ids.insert(id.clone()) {
            return Err(invalid("Duplicate property identity"));
        }
        let old = previous.and_then(|p| p.properties.iter().find(|v| v.id == id));
        if input.options.len() > MAX_OPTIONS {
            return Err(invalid("Too many property options"));
        }
        let select = matches!(
            input.datatype,
            DatabaseDatatype::Select | DatabaseDatatype::MultiSelect | DatabaseDatatype::Status
        );
        if !select && !input.options.is_empty() {
            return Err(invalid("This datatype cannot have options"));
        }
        let mut option_ids = BTreeSet::new();
        let mut option_names = BTreeSet::new();
        let mut options = Vec::new();
        for input in &input.options {
            label(&input.name)?;
            if !option_names.insert(input.name.clone()) {
                return Err(invalid("Option labels must be unique within a property"));
            }
            let option_id = match &input.id {
                Some(id) => {
                    check_schema_id(id)?;
                    if !old.is_some_and(|p| p.options.iter().any(|o| &o.id == id)) {
                        return Err(invalid("Unknown option identity"));
                    }
                    id.clone()
                }
                None => allocate_identity(tx, &option_ids)?,
            };
            if !option_ids.insert(option_id.clone()) {
                return Err(invalid("Duplicate option identity"));
            }
            if let Some(color) = &input.color {
                label(color)?;
            }
            options.push(DatabaseOption {
                id: option_id,
                name: input.name.clone(),
                category: input.category.clone(),
                color: input.color.clone(),
            });
        }
        if input.datatype == DatabaseDatatype::Status {
            if options.iter().any(|o| {
                !o.category
                    .as_ref()
                    .is_some_and(|c| matches!(c.as_str(), "not_started" | "working" | "done"))
            }) {
                return Err(invalid("Each status option needs a semantic category"));
            }
        } else if options.iter().any(|o| o.category.is_some()) {
            return Err(invalid("Only Status options have semantic categories"));
        }
        let property = DatabaseProperty {
            id,
            name: input.name.clone(),
            datatype: input.datatype.clone(),
            options,
            default: input.default.clone(),
        };
        if let Some(default) = &property.default {
            validate_value(&property, default)?;
        }
        result.push(property);
    }
    Ok(result)
}
fn allocate_identity(tx: &Connection, local: &BTreeSet<String>) -> Result<String> {
    for _ in 0..32 {
        let id = random_id()?;
        let used: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM local_collections WHERE id=?1)",
            [&id],
            |r| r.get(0),
        )?;
        // Retired schema identities are reserved in history too, not merely live rows.
        let retired: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM local_database_history WHERE instr(record,?1)>0)",
            [&id],
            |r| r.get(0),
        )?;
        if !used && !retired && !local.contains(&id) {
            return Ok(id);
        }
    }
    Err(invalid("Could not allocate a unique schema identity"))
}
fn valid_date(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes
            .iter()
            .enumerate()
            .any(|(i, b)| i != 4 && i != 7 && !b.is_ascii_digit())
    {
        return false;
    }
    let year: u32 = text[0..4].parse().unwrap_or(0);
    let month: u32 = text[5..7].parse().unwrap_or(0);
    let day: u32 = text[8..10].parse().unwrap_or(0);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    day > 0 && day <= days
}
fn valid_datetime(text: &str) -> bool {
    // Portable ISO local datetime or explicit UTC/offset, seconds optional.
    if text.len() < 16 || !text.is_ascii() || !valid_date(&text[..10]) || &text[10..11] != "T" {
        return false;
    }
    let time = &text[11..];
    let base = time.strip_suffix('Z').unwrap_or(time);
    let (clock, offset) = base
        .find(['+', '-'])
        .map(|i| (&base[..i], Some(&base[i + 1..])))
        .unwrap_or((base, None));
    if text.ends_with('Z') && offset.is_some() {
        return false;
    }
    let parts: Vec<_> = clock.split(':').collect();
    if !(2..=3).contains(&parts.len()) {
        return false;
    }
    let component = |s: &str, max: u32| {
        s.len() == 2
            && s.bytes().all(|b| b.is_ascii_digit())
            && s.parse::<u32>().is_ok_and(|n| n < max)
    };
    if !component(parts[0], 24) || !component(parts[1], 60) {
        return false;
    }
    if parts.len() == 3 {
        let (seconds, fraction) = parts[2]
            .split_once('.')
            .map(|(s, f)| (s, Some(f)))
            .unwrap_or((parts[2], None));
        if !component(seconds, 60)
            || fraction.is_some_and(|f| {
                f.is_empty() || f.len() > 9 || !f.bytes().all(|b| b.is_ascii_digit())
            })
        {
            return false;
        }
    }
    !offset.is_some_and(|o| {
        let p: Vec<_> = o.split(':').collect();
        p.len() != 2 || !component(p[0], 24) || !component(p[1], 60)
    })
}
pub fn validate_database_property_value(property: &DatabaseProperty, value: &Value) -> Result<()> {
    if value.is_null() {
        return Ok(());
    }
    let option = |v: &Value| {
        v.as_str()
            .is_some_and(|id| property.options.iter().any(|o| o.id == id))
    };
    let valid = match property.datatype {
        DatabaseDatatype::Text => value.is_string(),
        DatabaseDatatype::Number => value.as_f64().is_some_and(|v| {
            v.is_finite() && (v.fract() != 0.0 || v.abs() <= 9_007_199_254_740_991.0)
        }),
        DatabaseDatatype::Checkbox => value.is_boolean(),
        DatabaseDatatype::Date => value.as_str().is_some_and(valid_date),
        DatabaseDatatype::Datetime => value.as_str().is_some_and(valid_datetime),
        DatabaseDatatype::Select | DatabaseDatatype::Status => option(value),
        DatabaseDatatype::MultiSelect => value.as_array().is_some_and(|items| {
            items.len() <= MAX_OPTIONS
                && items.iter().all(option)
                && items
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<BTreeSet<_>>()
                    .len()
                    == items.len()
        }),
    };
    if !valid {
        return Err(invalid(format!(
            "Invalid value for property {}",
            property.name
        )));
    }
    Ok(())
}
fn validate_value(property: &DatabaseProperty, value: &Value) -> Result<()> {
    validate_database_property_value(property, value)
}

#[cfg(test)]
pub(super) fn drop_schema_for_test(connection: &Connection) {
    for (name, _) in SCHEMA.iter().rev() {
        let kind: String = connection
            .query_row(
                "SELECT type FROM sqlite_master WHERE name=?1",
                [name],
                |r| r.get(0),
            )
            .unwrap();
        connection
            .execute_batch(&format!("DROP {kind} \"{name}\";"))
            .unwrap();
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Member {
    entry_id: EntryId,
    collection_id: String,
    revision: String,
    deleted: bool,
    values: BTreeMap<String, Value>,
    preserved: BTreeMap<String, Value>,
    original_path: String,
    projected_properties: BTreeMap<String, Value>,
}
fn member(tx: &Connection, id: &EntryId) -> Result<Option<Member>> {
    let row:Option<(String,String,bool,String,String,String,String)>=tx.query_row("SELECT collection_id,revision,deleted,values_json,preserved_json,original_path,projected_properties FROM local_collection_entries WHERE entry_id=?1",[id.as_str()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional()?;
    row.map(
        |(
            collection_id,
            revision,
            deleted,
            values,
            preserved,
            original_path,
            projected_properties,
        )| {
            Ok(Member {
                entry_id: id.clone(),
                collection_id,
                revision,
                deleted,
                values: serde_json::from_str(&values)?,
                preserved: serde_json::from_str(&preserved)?,
                original_path,
                projected_properties: serde_json::from_str(&projected_properties)?,
            })
        },
    )
    .transpose()
}
fn require_member(tx: &Connection, id: &EntryId, expected: Option<&str>) -> Result<Member> {
    if expected.is_some_and(|value| value.len() > 128) {
        return Err(invalid("Invalid expected entry revision"));
    }
    let member = member(tx, id)?.ok_or_else(|| invalid("Entry is not a collection member"))?;
    if expected.is_some_and(|e| e != member.revision) {
        return Err(invalid("Collection entry changed; reload before saving"));
    }
    Ok(member)
}
fn save_member(tx: &Connection, member: &Member) -> Result<()> {
    tx.execute("INSERT INTO local_collection_entries(entry_id,collection_id,revision,deleted,values_json,preserved_json,original_path,projected_properties) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(entry_id) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted,values_json=excluded.values_json,preserved_json=excluded.preserved_json,original_path=excluded.original_path,projected_properties=excluded.projected_properties",params![member.entry_id.as_str(),member.collection_id,member.revision,member.deleted,bounded(&member.values,MAX_ENTRY_BYTES)?,bounded(&member.preserved,MAX_ENTRY_BYTES)?,member.original_path,bounded(&member.projected_properties,MAX_REQUEST_BYTES)?])?;
    Ok(())
}
fn queue(tx: &Connection, id: &EntryId, kind: DatabaseProjectionKind) -> Result<()> {
    let kind = match kind {
        DatabaseProjectionKind::Properties => "properties",
        DatabaseProjectionKind::Trash => "trash",
        DatabaseProjectionKind::Restore => "restore",
    };
    tx.execute("INSERT INTO local_database_projections(entry_id,kind) VALUES(?1,?2) ON CONFLICT(entry_id) DO UPDATE SET kind=CASE WHEN excluded.kind='properties' AND local_database_projections.kind<>'properties' THEN local_database_projections.kind ELSE excluded.kind END",params![id.as_str(),kind])?;
    Ok(())
}
fn rendered(property: &DatabaseProperty, value: &Value) -> Result<Value> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    validate_value(property, value)?;
    let name = |id: &str| {
        property
            .options
            .iter()
            .find(|option| option.id == id)
            .map(|o| Value::String(o.name.clone()))
            .ok_or_else(|| invalid("Unknown option identity"))
    };
    match property.datatype {
        DatabaseDatatype::Select | DatabaseDatatype::Status => {
            name(value.as_str().ok_or_else(|| invalid("Invalid selection"))?)
        }
        DatabaseDatatype::MultiSelect => value
            .as_array()
            .ok_or_else(|| invalid("Invalid selection"))?
            .iter()
            .map(|v| name(v.as_str().ok_or_else(|| invalid("Invalid selection"))?))
            .collect::<Result<Vec<_>>>()
            .map(Value::Array),
        _ => Ok(value.clone()),
    }
}
fn projected_properties(
    collection: &DatabaseCollection,
    member: &Member,
) -> Result<BTreeMap<String, Value>> {
    let mut properties = BTreeMap::from([
        ("_id".into(), Value::String(member.entry_id.as_str().into())),
        ("_type".into(), Value::String(collection.name.clone())),
    ]);
    for property in &collection.properties {
        let value = match member.preserved.get(&property.id) {
            Some(value) => value.clone(),
            None => rendered(
                property,
                member.values.get(&property.id).unwrap_or(&Value::Null),
            )?,
        };
        properties.insert(property.name.clone(), value);
    }
    Ok(properties)
}
fn entry_snapshot(
    tx: &Connection,
    collection: &DatabaseCollection,
    member: &Member,
) -> Result<DatabaseEntry> {
    let file = entry_content::read_metadata_row(tx, &member.entry_id)?;
    let pending = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM local_database_projections WHERE entry_id=?1)",
        [member.entry_id.as_str()],
        |r| r.get(0),
    )?;
    Ok(DatabaseEntry{entry_id:member.entry_id.clone(),collection_id:member.collection_id.clone(),revision:member.revision.clone(),file_revision:file.as_ref().map(|f|f.state.revision.clone()),path:file.map(|f|f.state.path.as_str().to_owned()).unwrap_or_else(||member.original_path.clone()),values:member.values.clone(),deleted:member.deleted||collection.deleted,pending_projection:pending,problems:member.preserved.keys().map(|id|(id.clone(),"This value was authored for an earlier datatype. Correct or clear it to finish conversion.".into())).collect()})
}
fn collection_member_ids(tx: &Connection, id: &str) -> Result<Vec<EntryId>> {
    let ids=tx.prepare("SELECT entry_id FROM local_collection_entries WHERE collection_id=?1 ORDER BY entry_id LIMIT ?2")?.query_map(params![id,(MAX_ENTRIES+1) as i64],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
    if ids.len() > MAX_ENTRIES {
        return Err(invalid("Collection entry count exceeds limit"));
    }
    ids.into_iter()
        .map(|id| EntryId::new(id).map_err(Into::into))
        .collect()
}
fn snapshot(tx: &Connection, id: Option<&str>) -> Result<DatabaseSnapshot> {
    let collections = if let Some(id) = id {
        vec![require_collection(tx, id, None, false)?]
    } else {
        let raw = tx
            .prepare("SELECT model FROM local_collections ORDER BY name_key LIMIT ?1")?
            .query_map([(MAX_COLLECTIONS + 1) as i64], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if raw.len() > MAX_COLLECTIONS {
            return Err(invalid("Collection count exceeds limit"));
        }
        raw.into_iter()
            .map(|json| serde_json::from_str(&json).map_err(Into::into))
            .collect::<Result<Vec<DatabaseCollection>>>()?
    };
    let mut entries = Vec::new();
    if id.is_some() {
        for collection in &collections {
            for id in collection_member_ids(tx, &collection.id)? {
                entries.push(entry_snapshot(
                    tx,
                    collection,
                    &require_member(tx, &id, None)?,
                )?);
            }
        }
    }
    let result = DatabaseSnapshot {
        collections,
        entries,
    };
    bounded(&result, MAX_RESPONSE_BYTES)?;
    Ok(result)
}
pub(crate) fn query_state(tx: &Connection) -> Result<DatabaseQueryState> {
    let revision: i64 = tx.query_row(
        "SELECT revision FROM local_database_state WHERE singleton=1",
        [],
        |r| r.get(0),
    )?;
    let collections = snapshot(tx, None)?.collections;
    let mut entries = Vec::new();
    for collection in &collections {
        for id in collection_member_ids(tx, &collection.id)? {
            if entries.len() >= MAX_ENTRIES {
                return Err(invalid("Collection query snapshot exceeds entry limit"));
            }
            let mut entry = entry_snapshot(tx, collection, &require_member(tx, &id, None)?)?;
            entry.pending_projection = false;
            entries.push(entry);
        }
    }
    let result = DatabaseQueryState {
        revision: revision.to_string(),
        collections,
        entries,
    };
    bounded(&result, MAX_RESPONSE_BYTES)?;
    Ok(result)
}
fn history<T: Serialize>(
    tx: &Connection,
    operation: &OperationId,
    collection: &str,
    entry: Option<&EntryId>,
    record: &T,
) -> Result<()> {
    tx.execute("INSERT INTO local_database_history(operation_id,collection_id,entry_id,record) VALUES(?1,?2,?3,?4)",params![operation.as_str(),collection,entry.map(EntryId::as_str),bounded(record,MAX_REQUEST_BYTES)?])?;
    Ok(())
}
fn collection_body(tx: &Connection, id: &EntryId) -> Result<StoredEntry> {
    let entry = entry_content::read_legacy_entry(tx, id)?
        .ok_or_else(|| invalid("Collection file is missing"))?;
    if entry.state.deleted || entry.state.kind != EntryKind::File {
        return Err(invalid("Collection entry file is unavailable"));
    }
    Ok(entry)
}
fn validate_path(path: &str) -> Result<VaultPath> {
    let path = VaultPath::new(path)?;
    if !path.as_str().to_ascii_lowercase().ends_with(".md")
        || path.as_str().split('/').any(|part| part.starts_with('.'))
    {
        return Err(invalid(
            "Collection entries require a visible Markdown path",
        ));
    }
    Ok(path)
}
fn initial_values(
    collection: &DatabaseCollection,
    input: &BTreeMap<String, Value>,
) -> Result<BTreeMap<String, Value>> {
    let mut values = collection
        .properties
        .iter()
        .map(|p| {
            (
                p.id.clone(),
                p.default.clone().unwrap_or_else(|| {
                    if p.datatype == DatabaseDatatype::MultiSelect {
                        Value::Array(Vec::new())
                    } else {
                        Value::Null
                    }
                }),
            )
        })
        .collect::<BTreeMap<_, _>>();
    apply_values(collection, &mut values, input)?;
    Ok(values)
}
fn apply_values(
    collection: &DatabaseCollection,
    values: &mut BTreeMap<String, Value>,
    input: &BTreeMap<String, Value>,
) -> Result<()> {
    for (id, value) in input {
        let property = collection
            .properties
            .iter()
            .find(|p| &p.id == id)
            .ok_or_else(|| invalid("Unknown property identity"))?;
        validate_value(property, value)?;
        values.insert(id.clone(), value.clone());
    }
    bounded(values, MAX_ENTRY_BYTES)?;
    Ok(())
}
fn create_entry(
    tx: &Connection,
    operation: &OperationId,
    collection: &DatabaseCollection,
    id: &EntryId,
    path: &str,
    body: &str,
    values: BTreeMap<String, Value>,
    baseline: BTreeMap<String, Value>,
) -> Result<()> {
    if body.len() > MAX_BODY_BYTES {
        return Err(invalid("Entry body exceeds byte limit"));
    }
    let count: i64 = tx.query_row("SELECT count(*) FROM local_collection_entries", [], |r| {
        r.get(0)
    })?;
    if count >= MAX_ENTRIES as i64 {
        return Err(invalid("Local collection entry limit reached"));
    }
    if member(tx, id)?.is_some() {
        return Err(invalid("Entry identity has already been used"));
    }
    let used: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM entries WHERE id=?1)",
        [id.as_str()],
        |r| r.get(0),
    )?;
    if used {
        return Err(invalid(
            "Existing or deleted notes cannot be imported into a collection",
        ));
    }
    // Atomic logical file and membership. Native still must publish this file
    // through its existing physical journal before reporting materialization.
    let request = MutationRequest {
        operation_id: OperationId::new(format!("{}-file", operation.as_str()))?,
        mutation: Mutation::Create {
            id: id.clone(),
            path: validate_path(path)?,
            kind: EntryKind::File,
            content: Some(body.as_bytes().to_vec()),
        },
    };
    let enrolled: bool =
        tx.query_row("SELECT EXISTS(SELECT 1 FROM family_graph_heads)", [], |r| {
            r.get(0)
        })?;
    if enrolled {
        let command = FamilyCommand::new(request, Some(FamilyCreateMode::Text))
            .map_err(|_| invalid("Invalid collection file command"))?;
        let prepared = family_metadata_transactions::prepare_family_command(tx, &command)?;
        family_metadata_transactions::commit_prepared(tx, &prepared)?;
    } else {
        Store::apply_transaction(tx, &request)?;
    }
    let member = Member {
        entry_id: id.clone(),
        collection_id: collection.id.clone(),
        revision: new_revision(),
        deleted: false,
        values,
        preserved: BTreeMap::new(),
        original_path: path.into(),
        projected_properties: baseline,
    };
    save_member(tx, &member)?;
    queue(tx, id, DatabaseProjectionKind::Properties)?;
    history(tx, operation, &collection.id, Some(id), &member)?;
    Ok(())
}
fn operation(request: &DatabaseRequest) -> Option<&OperationId> {
    match request {
        DatabaseRequest::List | DatabaseRequest::Get { .. } | DatabaseRequest::GetEntry { .. } => {
            None
        }
        DatabaseRequest::Create { operation_id, .. }
        | DatabaseRequest::Update { operation_id, .. }
        | DatabaseRequest::CreateEntry { operation_id, .. }
        | DatabaseRequest::SetEntry { operation_id, .. }
        | DatabaseRequest::DuplicateEntry { operation_id, .. }
        | DatabaseRequest::Delete { operation_id, .. }
        | DatabaseRequest::Restore { operation_id, .. } => Some(operation_id),
    }
}

impl Store {
    pub fn database_query_state(&self) -> Result<DatabaseQueryState> {
        let tx = self.connection.unchecked_transaction()?;
        let state = query_state(&tx)?;
        tx.commit()?;
        Ok(state)
    }
    pub fn database_request(&mut self, request: &DatabaseRequest) -> Result<DatabaseSnapshot> {
        let raw = bounded(request, MAX_COMMAND_BYTES)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(operation) = operation(request) else {
            let result = match request {
                DatabaseRequest::List => snapshot(&tx, None)?,
                DatabaseRequest::Get { collection_id } => snapshot(&tx, Some(collection_id))?,
                DatabaseRequest::GetEntry { entry_id } => {
                    let member = require_member(&tx, entry_id, None)?;
                    let mut result = snapshot(&tx, Some(&member.collection_id))?;
                    result.entries.retain(|e| &e.entry_id == entry_id);
                    result
                }
                _ => unreachable!(),
            };
            tx.commit()?;
            return Ok(result);
        };
        if operation.as_str().len() > 96 {
            return Err(invalid("Database operation identity exceeds 96 bytes"));
        }
        let previous: Option<(String, String)> = tx
            .query_row(
                "SELECT request,response FROM local_database_operations WHERE operation_id=?1",
                [operation.as_str()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((previous, response)) = previous {
            if previous != raw {
                return Err(ContractError::IdempotencyConflict {
                    operation_id: operation.clone(),
                }
                .into());
            }
            let response = serde_json::from_str(&response)?;
            tx.commit()?;
            return Ok(response);
        }
        let used:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM operations WHERE operation_id=?1) OR EXISTS(SELECT 1 FROM host_intents WHERE operation_id=?1)",[operation.as_str()],|r|r.get(0))?;
        if used || blob_stage::operation_reserved(&tx, operation)? {
            return Err(ContractError::IdempotencyConflict {
                operation_id: operation.clone(),
            }
            .into());
        }
        let collection_id = execute(&tx, operation, request)?;
        tx.execute("UPDATE local_database_state SET revision=revision+1 WHERE singleton=1 AND revision<9223372036854775807",[])?;
        if tx.changes() != 1 {
            return Err(StoreError::Corrupt(
                "collection revision counter exhausted".into(),
            ));
        }
        presentation::record_changes(
            &tx,
            ChangeOrigin::LocalCommand {
                operation_id: operation.clone(),
            },
            &[],
            presentation::now_ms()?,
        )?;
        let response = snapshot(&tx, Some(&collection_id))?;
        tx.execute(
            "INSERT INTO local_database_operations(operation_id,request,response) VALUES(?1,?2,?3)",
            params![
                operation.as_str(),
                raw,
                bounded(&response, MAX_RESPONSE_BYTES)?
            ],
        )?;
        tx.commit()?;
        Ok(response)
    }
}

fn execute(tx: &Connection, operation: &OperationId, request: &DatabaseRequest) -> Result<String> {
    match request {
        DatabaseRequest::Create {
            name,
            preset,
            properties,
            ..
        } => {
            collection_name(name)?;
            let count: i64 =
                tx.query_row("SELECT count(*) FROM local_collections", [], |r| r.get(0))?;
            if count >= MAX_COLLECTIONS as i64 {
                return Err(invalid("Local collection limit reached"));
            }
            let inputs = match preset.as_deref().unwrap_or("blank") {
                "blank" => properties.clone(),
                "tasks" if properties.is_empty() => task_preset(),
                "tasks" => {
                    return Err(invalid(
                        "Task preset cannot be combined with explicit properties",
                    ))
                }
                _ => return Err(invalid("Unknown collection preset")),
            };
            let mut properties = build_properties(&inputs, None, tx)?;
            if preset.as_deref() == Some("tasks") {
                if let Some(status) = properties
                    .iter_mut()
                    .find(|p| p.datatype == DatabaseDatatype::Status)
                {
                    status.default = status.options.first().map(|o| Value::String(o.id.clone()));
                }
            }
            let collection = DatabaseCollection {
                id: allocate_identity(tx, &BTreeSet::new())?,
                name: name.clone(),
                revision: new_revision(),
                deleted: false,
                properties,
            };
            save_collection(tx, &collection)?;
            history(tx, operation, &collection.id, None, &collection)?;
            Ok(collection.id)
        }
        DatabaseRequest::Update {
            collection_id,
            expected_revision,
            name,
            properties,
            confirm_destructive,
            ..
        } => {
            let previous = require_collection(tx, collection_id, Some(expected_revision), true)?;
            let next = DatabaseCollection {
                id: previous.id.clone(),
                name: name.clone(),
                revision: new_revision(),
                deleted: false,
                properties: build_properties(properties, Some(&previous), tx)?,
            };
            let mut updates = Vec::new();
            let mut affected = 0;
            for id in collection_member_ids(tx, collection_id)? {
                let mut entry = require_member(tx, &id, None)?;
                let old = entry.clone();
                let mut destructive = false;
                for property in &previous.properties {
                    let value = entry
                        .values
                        .get(&property.id)
                        .cloned()
                        .unwrap_or(Value::Null);
                    let Some(replacement) = next.properties.iter().find(|p| p.id == property.id)
                    else {
                        if !value.is_null() && value != Value::Array(vec![]) {
                            destructive = true;
                        }
                        entry.values.remove(&property.id);
                        entry.preserved.remove(&property.id);
                        continue;
                    };
                    if property.datatype == replacement.datatype
                        && matches!(
                            property.datatype,
                            DatabaseDatatype::Select
                                | DatabaseDatatype::Status
                                | DatabaseDatatype::MultiSelect
                        )
                    {
                        let removed = |v: &Value| {
                            v.as_str()
                                .is_some_and(|id| !replacement.options.iter().any(|o| o.id == id))
                        };
                        let cleared = if property.datatype == DatabaseDatatype::MultiSelect {
                            Value::Array(
                                value
                                    .as_array()
                                    .cloned()
                                    .unwrap_or_default()
                                    .into_iter()
                                    .filter(|v| !removed(v))
                                    .collect(),
                            )
                        } else if removed(&value) {
                            Value::Null
                        } else {
                            value.clone()
                        };
                        if cleared != value {
                            destructive = true;
                            entry.values.insert(property.id.clone(), cleared);
                            entry.preserved.remove(&property.id);
                        }
                    } else if property.datatype != replacement.datatype {
                        if !entry.preserved.contains_key(&property.id) {
                            if let Some(converted) = compatible_value(property, replacement, &value)
                            {
                                entry.values.insert(property.id.clone(), converted);
                            } else {
                                entry
                                    .preserved
                                    .insert(property.id.clone(), rendered(property, &value)?);
                            }
                        }
                    }
                }
                for property in &next.properties {
                    entry
                        .values
                        .entry(property.id.clone())
                        .or_insert_with(|| property.default.clone().unwrap_or(Value::Null));
                }
                if destructive {
                    affected += 1;
                }
                entry.revision = new_revision();
                updates.push((old, entry));
            }
            if affected > 0 && !*confirm_destructive {
                return Err(invalid(format!(
                    "Confirm removal of values in {affected} affected collection entries"
                )));
            }
            history(tx, operation, collection_id, None, &previous)?;
            save_collection(tx, &next)?;
            for (old, entry) in updates {
                history(tx, operation, collection_id, Some(&entry.entry_id), &old)?;
                save_member(tx, &entry)?;
                queue(
                    tx,
                    &entry.entry_id,
                    if entry.deleted {
                        DatabaseProjectionKind::Trash
                    } else {
                        DatabaseProjectionKind::Properties
                    },
                )?;
            }
            Ok(collection_id.clone())
        }
        DatabaseRequest::CreateEntry {
            collection_id,
            expected_collection_revision,
            entry_id,
            path,
            body,
            values,
            ..
        } => {
            let collection =
                require_collection(tx, collection_id, Some(expected_collection_revision), true)?;
            // Create is never an import path. A supplied identity is accepted only
            // as the new core identity, not an existing document's `_id`.
            let facts = zorid_document::parse_markdown_facts(body)
                .map_err(|_| invalid("Invalid entry body"))?;
            if !matches!(
                facts.frontmatter.state,
                zorid_document::FrontmatterState::Absent | zorid_document::FrontmatterState::Valid
            ) || facts
                .properties
                .iter()
                .any(|p| matches!(p.key.as_str(), "_id" | "_type"))
            {
                return Err(invalid(
                    "New entry body cannot supply managed identity properties",
                ));
            }
            create_entry(
                tx,
                operation,
                &collection,
                entry_id,
                path,
                body,
                initial_values(&collection, values)?,
                BTreeMap::new(),
            )?;
            Ok(collection_id.clone())
        }
        DatabaseRequest::SetEntry {
            entry_id,
            expected_revision,
            expected_collection_revision,
            values,
            ..
        } => {
            let mut entry = require_member(tx, entry_id, Some(expected_revision))?;
            let collection = require_collection(
                tx,
                &entry.collection_id,
                Some(expected_collection_revision),
                true,
            )?;
            if entry.deleted {
                return Err(invalid("Entry is deleted"));
            }
            let old = entry.clone();
            apply_values(&collection, &mut entry.values, values)?;
            for id in values.keys() {
                entry.preserved.remove(id);
            }
            entry.revision = new_revision();
            history(tx, operation, &entry.collection_id, Some(entry_id), &old)?;
            save_member(tx, &entry)?;
            queue(tx, entry_id, DatabaseProjectionKind::Properties)?;
            Ok(entry.collection_id)
        }
        DatabaseRequest::DuplicateEntry {
            entry_id,
            expected_revision,
            new_entry_id,
            path,
            ..
        } => {
            let entry = require_member(tx, entry_id, Some(expected_revision))?;
            if entry.deleted {
                return Err(invalid("Entry is deleted"));
            }
            let collection = require_collection(tx, &entry.collection_id, None, true)?;
            let source = collection_body(tx, entry_id)?
                .content
                .ok_or_else(|| invalid("Entry has no body"))?;
            let source =
                std::str::from_utf8(&source).map_err(|_| invalid("Entry body is not UTF-8"))?;
            // The copied last-published properties are an explicit duplicate
            // baseline, so the native composer may replace the old `_id` safely.
            let source_values = read_projection_values(source)?;
            let managed_names = collection
                .properties
                .iter()
                .map(|p| p.name.as_str())
                .chain(entry.projected_properties.keys().map(String::as_str))
                .chain(["_id", "_type"])
                .collect::<BTreeSet<_>>();
            let baseline = source_values
                .into_iter()
                .filter(|(key, _)| managed_names.contains(key.as_str()))
                .collect();
            create_entry(
                tx,
                operation,
                &collection,
                new_entry_id,
                path,
                source,
                entry.values.clone(),
                baseline,
            )?;
            if !entry.preserved.is_empty() {
                let mut copy = require_member(tx, new_entry_id, None)?;
                copy.preserved = entry.preserved;
                save_member(tx, &copy)?;
            }
            Ok(entry.collection_id)
        }
        DatabaseRequest::Delete {
            collection_id,
            expected_revision,
            ..
        }
        | DatabaseRequest::Restore {
            collection_id,
            expected_revision,
            ..
        } => {
            let mut collection =
                require_collection(tx, collection_id, Some(expected_revision), false)?;
            let deleting = matches!(request, DatabaseRequest::Delete { .. });
            if collection.deleted == deleting {
                return Err(invalid(if deleting {
                    "Collection is already deleted"
                } else {
                    "Collection is not deleted"
                }));
            }
            history(tx, operation, collection_id, None, &collection)?;
            collection.deleted = deleting;
            collection.revision = new_revision();
            save_collection(tx, &collection)?;
            for id in collection_member_ids(tx, collection_id)? {
                let mut entry = require_member(tx, &id, None)?;
                history(tx, operation, collection_id, Some(&id), &entry)?;
                if deleting {
                    let file = entry_content::read_metadata_row(tx, &id)?;
                    if let Some(file) = file {
                        if !file.state.path.as_str().starts_with(".trash/") {
                            entry.original_path = file.state.path.as_str().into();
                        }
                    }
                }
                entry.deleted = deleting;
                entry.revision = new_revision();
                save_member(tx, &entry)?;
                queue(
                    tx,
                    &id,
                    if deleting {
                        DatabaseProjectionKind::Trash
                    } else {
                        DatabaseProjectionKind::Restore
                    },
                )?;
            }
            Ok(collection_id.clone())
        }
        _ => Err(invalid("Read request cannot execute as a mutation")),
    }
}
fn task_preset() -> Vec<DatabasePropertyInput> {
    vec![
        DatabasePropertyInput {
            id: None,
            name: "Status".into(),
            datatype: DatabaseDatatype::Status,
            options: [
                ("Not started", "not_started"),
                ("In progress", "working"),
                ("Done", "done"),
            ]
            .into_iter()
            .map(|(name, category)| DatabaseOptionInput {
                id: None,
                name: name.into(),
                category: Some(category.into()),
                color: None,
            })
            .collect(),
            default: None,
        },
        DatabasePropertyInput {
            id: None,
            name: "Planned date".into(),
            datatype: DatabaseDatatype::Date,
            options: vec![],
            default: None,
        },
        DatabasePropertyInput {
            id: None,
            name: "Deadline".into(),
            datatype: DatabaseDatatype::Date,
            options: vec![],
            default: None,
        },
    ]
}
fn compatible_value(
    old: &DatabaseProperty,
    new: &DatabaseProperty,
    value: &Value,
) -> Option<Value> {
    if value.is_null() {
        return Some(Value::Null);
    }
    if matches!(
        (&old.datatype, &new.datatype),
        (
            DatabaseDatatype::Select | DatabaseDatatype::Status,
            DatabaseDatatype::Text
        )
    ) {
        return rendered(old, value).ok();
    }
    if validate_value(new, value).is_ok() {
        return Some(value.clone());
    }
    let converted = match (&old.datatype, &new.datatype) {
        (DatabaseDatatype::Text, DatabaseDatatype::Number) => value
            .as_str()?
            .parse::<f64>()
            .ok()
            .and_then(serde_json::Number::from_f64)
            .map(Value::Number),
        (DatabaseDatatype::Number | DatabaseDatatype::Checkbox, DatabaseDatatype::Text) => {
            Some(Value::String(value.to_string()))
        }
        (DatabaseDatatype::Date, DatabaseDatatype::Datetime) => {
            Some(Value::String(format!("{}T00:00:00", value.as_str()?)))
        }
        (DatabaseDatatype::Select | DatabaseDatatype::Status, DatabaseDatatype::Text) => {
            rendered(old, value).ok()
        }
        (DatabaseDatatype::Text, DatabaseDatatype::Select | DatabaseDatatype::Status) => new
            .options
            .iter()
            .find(|o| Some(o.name.as_str()) == value.as_str())
            .map(|o| Value::String(o.id.clone())),
        _ => None,
    }?;
    validate_value(new, &converted).ok()?;
    Some(converted)
}

fn read_projection_values(source: &str) -> Result<BTreeMap<String, Value>> {
    let facts = zorid_document::parse_markdown_facts(source)
        .map_err(|_| invalid("Cannot parse managed frontmatter"))?;
    if !matches!(
        facts.frontmatter.state,
        zorid_document::FrontmatterState::Absent | zorid_document::FrontmatterState::Valid
    ) {
        return Err(invalid(
            "Managed frontmatter must be valid YAML; original source is retained",
        ));
    }
    facts
        .properties
        .into_iter()
        .map(|property| Ok((property.key, serde_json::to_value(property.value)?)))
        .collect()
}
fn projection(
    tx: &Connection,
    member: &Member,
    kind: DatabaseProjectionKind,
) -> Result<DatabaseProjection> {
    let collection = require_collection(tx, &member.collection_id, None, false)?;
    Ok(DatabaseProjection {
        entry_id: member.entry_id.clone(),
        collection_id: member.collection_id.clone(),
        entry_revision: member.revision.clone(),
        collection_revision: collection.revision.clone(),
        kind,
        properties: projected_properties(&collection, member)?,
        previous_properties: member.projected_properties.clone(),
        previous_keys: member.projected_properties.keys().cloned().collect(),
        original_path: member.original_path.clone(),
    })
}
fn read_kind(text: &str) -> Result<DatabaseProjectionKind> {
    match text {
        "properties" => Ok(DatabaseProjectionKind::Properties),
        "trash" => Ok(DatabaseProjectionKind::Trash),
        "restore" => Ok(DatabaseProjectionKind::Restore),
        _ => Err(StoreError::Corrupt(
            "Invalid local database projection kind".into(),
        )),
    }
}
fn current_projection(tx: &Connection, id: &EntryId) -> Result<Option<DatabaseProjection>> {
    let Some(member) = member(tx, id)? else {
        return Ok(None);
    };
    let kind: Option<String> = tx
        .query_row(
            "SELECT kind FROM local_database_projections WHERE entry_id=?1",
            [id.as_str()],
            |r| r.get(0),
        )
        .optional()?;
    Ok(Some(projection(
        tx,
        &member,
        kind.as_deref()
            .map(read_kind)
            .transpose()?
            .unwrap_or(if member.deleted {
                DatabaseProjectionKind::Trash
            } else {
                DatabaseProjectionKind::Properties
            }),
    )?))
}
/// Every generic content write is fenced after idempotent replay under the
/// authoritative writer. A prepared native intent cannot overwrite a schema or
/// value change committed after its composition. Raw field edits remain drafts.
pub(crate) fn validate_content_write(tx: &Connection, request: &MutationRequest) -> Result<()> {
    let Mutation::Write { id, content, .. } = &request.mutation else {
        return Ok(());
    };
    let Some(projection) = current_projection(tx, id)? else {
        return Ok(());
    };
    let member = require_member(tx, id, None)?;
    let collection = require_collection(tx, &member.collection_id, None, false)?;
    if member.deleted || collection.deleted {
        return Err(invalid("Cannot write a deleted collection entry"));
    }
    let source =
        std::str::from_utf8(content).map_err(|_| invalid("Collection Markdown must be UTF-8"))?;
    validate_projected_source(&projection, source)
}
/// Observation imports alone may carry unchanged old generated values with a
/// newly edited body. Native validates intentional property changes first; this
/// final writer verifies the captured branch and preserves current authority.
pub(crate) fn validate_external_content_write(
    tx: &Connection,
    request: &MutationRequest,
    observation: &ExternalObservation,
) -> Result<()> {
    let Mutation::Write { id, content, .. } = &request.mutation else {
        return validate_content_write(tx, request);
    };
    let Some(projection) = current_projection(tx, id)? else {
        return Ok(());
    };
    let member = require_member(tx, id, None)?;
    require_collection(tx, &member.collection_id, None, true)?;
    if member.deleted {
        return Err(invalid(
            "Cannot import edits into a deleted collection entry",
        ));
    }
    let baseline = observation
        .baseline
        .as_ref()
        .ok_or_else(|| invalid("Collection external edits require a known baseline"))?;
    if baseline.state.id != *id
        || baseline.state.path != observation.path
        || observation.resolution.is_some()
    {
        return Err(invalid(
            "External collection observation does not match its entry",
        ));
    }
    let stored: String = tx.query_row(
        "SELECT record FROM external_observations WHERE observation_id=?1",
        [observation.observation_id.as_str()],
        |r| r.get(0),
    )?;
    if projection::decode_observation(observation.observation_id.as_str(), &stored)? != *observation
        || physical_bindings::check_observation(tx, &observation.observation_id, id)?.is_none()
    {
        return Err(invalid(
            "External collection edit lacks its captured physical proof",
        ));
    }
    let raw = observation
        .content
        .inline_bytes()
        .ok_or_else(|| invalid("External collection Markdown requires bounded inline content"))?;
    for bytes in [raw, content.as_slice()] {
        let source =
            std::str::from_utf8(bytes).map_err(|_| invalid("Collection Markdown must be UTF-8"))?;
        let values = read_projection_values(source)?;
        if values.get("_id") != Some(&Value::String(id.as_str().into())) {
            return Err(invalid(
                "External edit changed or removed the collection entry identity",
            ));
        }
        if values.get("_type").is_some_and(|v| !v.is_string()) {
            return Err(invalid(
                "External collection name must remain readable text",
            ));
        }
        for key in projection
            .properties
            .keys()
            .chain(projection.previous_properties.keys())
            .filter(|k| k.as_str() != "_id" && k.as_str() != "_type")
        {
            let actual = values.get(key).unwrap_or(&Value::Null);
            let desired = projection.properties.get(key).unwrap_or(&Value::Null);
            let prior = projection
                .previous_properties
                .get(key)
                .unwrap_or(&Value::Null);
            if actual != desired && actual != prior {
                return Err(invalid(format!(
                    "External property {key} requires validated collection reconciliation"
                )));
            }
        }
    }
    queue(tx, id, DatabaseProjectionKind::Properties)
}
pub(crate) fn reject_binary_write(tx: &Connection, id: &EntryId) -> Result<()> {
    if member(tx, id)?.is_some() {
        return Err(invalid("Collection entries require a composed Markdown write; binary replacement is not allowed"));
    }
    Ok(())
}
fn validate_projected_source(projection: &DatabaseProjection, source: &str) -> Result<()> {
    let values = read_projection_values(source)?;
    for (key, value) in &projection.properties {
        if values.get(key) != Some(value) {
            return Err(invalid(format!("Managed property {key} changed; compose the current collection values before saving")));
        }
    }
    for key in &projection.previous_keys {
        if !projection.properties.contains_key(key) && values.contains_key(key) {
            return Err(invalid(format!(
                "Retired managed property {key} is still present"
            )));
        }
    }
    Ok(())
}
fn schema_projection(tx: &Connection, id: &str) -> Result<DatabaseSchemaProjection> {
    let collection = require_collection(tx, id, None, false)?;
    let (previous_path, previous_source) = tx.query_row(
        "SELECT projected_path,projected_source FROM local_collections WHERE id=?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    // JSON-quoted scalars are valid YAML 1.2 and avoid ambiguous dates/booleans.
    let mut source = format!(
        "version: 1\nid: {}\nname: {}\nproperties:",
        collection.id,
        serde_json::to_string(&collection.name)?
    );
    if collection.properties.is_empty() {
        source.push_str(" []\n");
    } else {
        source.push('\n');
        for property in &collection.properties {
            source.push_str(&format!(
                "  - id: {}\n    name: {}\n    datatype: {}\n",
                property.id,
                serde_json::to_string(&property.name)?,
                serde_json::to_string(&property.datatype)?.trim_matches('"')
            ));
            if let Some(default) = &property.default {
                source.push_str(&format!(
                    "    default: {}\n",
                    serde_json::to_string(default)?
                ));
            }
            if !property.options.is_empty() {
                source.push_str("    options:\n");
                for option in &property.options {
                    source.push_str(&format!(
                        "      - id: {}\n        name: {}\n",
                        option.id,
                        serde_json::to_string(&option.name)?
                    ));
                    if let Some(category) = &option.category {
                        source.push_str(&format!("        category: {category}\n"));
                    }
                    if let Some(color) = &option.color {
                        source.push_str(&format!(
                            "        color: {}\n",
                            serde_json::to_string(color)?
                        ));
                    }
                }
            }
        }
    }
    Ok(DatabaseSchemaProjection {
        collection_id: id.into(),
        revision: collection.revision.clone(),
        path: format!(".zorid/types/{}.yaml", collection.name),
        source,
        previous_path,
        previous_source,
        deleted: collection.deleted,
    })
}
impl Store {
    pub fn database_pending_projection_count(&self) -> Result<usize> {
        let count:i64=self.connection.query_row("SELECT (SELECT count(*) FROM local_database_projections)+(SELECT count(*) FROM local_database_schema_projections)",[],|r|r.get(0))?;
        usize::try_from(count).map_err(|_| StoreError::Corrupt("Invalid projection count".into()))
    }
    pub fn database_entry_projection(&self, id: &EntryId) -> Result<Option<DatabaseProjection>> {
        let tx = self.connection.unchecked_transaction()?;
        let result = current_projection(&tx, id)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn database_pending_projections(&self, limit: u32) -> Result<Vec<DatabaseProjection>> {
        if limit == 0 || limit > 256 {
            return Err(invalid("Projection page limit must be between 1 and 256"));
        }
        let tx = self.connection.unchecked_transaction()?;
        let rows = tx
            .prepare(
                "SELECT entry_id,kind FROM local_database_projections ORDER BY entry_id LIMIT ?1",
            )?
            .query_map([limit], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let result = rows
            .into_iter()
            .map(|(id, kind)| {
                projection(
                    &tx,
                    &require_member(&tx, &EntryId::new(id)?, None)?,
                    read_kind(&kind)?,
                )
            })
            .collect::<Result<Vec<_>>>()?;
        bounded(&result, MAX_RESPONSE_BYTES)?;
        tx.commit()?;
        Ok(result)
    }
    /// Verify the exact committed logical file before acknowledging projection.
    /// Physical durability is a separate native precondition to this host API.
    pub fn database_projection_ack(
        &mut self,
        id: &EntryId,
        entry_revision: &str,
        collection_revision: &str,
    ) -> Result<()> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut member = require_member(&tx, id, Some(entry_revision))?;
        require_collection(&tx, &member.collection_id, Some(collection_revision), false)?;
        let kind: Option<String> = tx
            .query_row(
                "SELECT kind FROM local_database_projections WHERE entry_id=?1",
                [id.as_str()],
                |r| r.get(0),
            )
            .optional()?;
        let Some(kind) = kind else {
            tx.commit()?;
            return Ok(());
        };
        let projection = projection(&tx, &member, read_kind(&kind)?)?;
        let entry = collection_body(&tx, id)?;
        match projection.kind {
            DatabaseProjectionKind::Trash => {
                if !entry.state.path.as_str().starts_with(".trash/") {
                    return Err(invalid(
                        "Collection entry has not reached recoverable Trash",
                    ));
                }
            }
            DatabaseProjectionKind::Properties | DatabaseProjectionKind::Restore => {
                if entry
                    .state
                    .path
                    .as_str()
                    .split('/')
                    .any(|p| p.starts_with('.'))
                {
                    return Err(invalid("Restored collection entry has no visible path"));
                }
                let source = entry
                    .content
                    .ok_or_else(|| invalid("Collection entry has no text"))?;
                validate_projected_source(
                    &projection,
                    std::str::from_utf8(&source)
                        .map_err(|_| invalid("Collection Markdown must be UTF-8"))?,
                )?;
                member.projected_properties = projection.properties;
                member.original_path = entry.state.path.as_str().into();
                save_member(&tx, &member)?;
            }
        }
        tx.execute(
            "DELETE FROM local_database_projections WHERE entry_id=?1",
            [id.as_str()],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn database_pending_schema_projections(
        &self,
        limit: u32,
    ) -> Result<Vec<DatabaseSchemaProjection>> {
        if limit == 0 || limit > 256 {
            return Err(invalid(
                "Schema projection page limit must be between 1 and 256",
            ));
        }
        let tx = self.connection.unchecked_transaction()?;
        let ids=tx.prepare("SELECT collection_id FROM local_database_schema_projections ORDER BY collection_id LIMIT ?1")?.query_map([limit],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let result = ids
            .into_iter()
            .map(|id| schema_projection(&tx, &id))
            .collect::<Result<Vec<_>>>()?;
        bounded(&result, MAX_RESPONSE_BYTES)?;
        tx.commit()?;
        Ok(result)
    }
    /// Native must verify guarded internal-file publication before calling this.
    pub fn database_schema_projection_ack(&mut self, id: &str, revision: &str) -> Result<()> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_collection(&tx, id, Some(revision), false)?;
        let projection = schema_projection(&tx, id)?;
        tx.execute(
            "UPDATE local_collections SET projected_path=?1,projected_source=?2 WHERE id=?3",
            params![projection.path, projection.source, id],
        )?;
        tx.execute(
            "DELETE FROM local_database_schema_projections WHERE collection_id=?1",
            [id],
        )?;
        tx.commit()?;
        Ok(())
    }
}
