//! Private portable original-intent representation. These pure checks do not issue
//! checkpoints, authenticate callers, authorize storage, or publish mutations.
//! Hosts must load retained bytes under the reserved namespace and fence the exact
//! live head plus current registration in the publication/settlement transaction.
use crate::{
    admission, first_party, workblock_service, Command, Error, Id, Operation, Schema, Scope, State,
    MAX_BYTES, MAX_HISTORY,
};
use serde::{Deserialize, Serialize};

// Cross-crate fixture dependencies do not inherit cfg(test). Reject any attempt
// to put this opt-in trust catalog into a release artifact.
#[cfg(all(feature = "intent-test-fixtures", not(debug_assertions)))]
compile_error!("intent-test-fixtures must never be enabled in release artifacts");

pub const RESERVED_CHECKPOINT_CLIENT: &str = "f7bca1bf-2a2c-438e-b430-b3f05e5d9324";
pub const MAX_LINEAGE_DECLARATIONS: usize = 16;
pub const MAX_REGISTRATION_BYTES: usize = MAX_BYTES;
pub const MAX_INTENT_BYTES: usize = 2 * MAX_BYTES;
pub const MAX_SEMANTIC_BYTES: usize = 16 * 1024;
pub const MAX_INTENT_KEY_BYTES: usize = 1024;
// Shared budget values only. Hosts must charge and reserve settlement atomically.
pub const MAX_LIVE_INTENTS: usize = 32;
pub const MAX_LIVE_INTENT_BYTES: usize = 16 * MAX_BYTES;
pub const MAX_RETAINED_INTENT_KEYS: usize = 4096;
pub const MAX_INTENT_METADATA_BYTES: usize = 16 * MAX_BYTES;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IntentError {
    InvalidRegistration,
    UnsupportedSchema,
    OriginMissing,
    OriginInvalid,
    OriginMismatch,
    OperationCollision,
    Scope,
    HeadConflict,
    ReservedClient,
    InvalidIdentity,
    Limit,
    Domain(Error),
}
pub type IntentResult<T> = std::result::Result<T, IntentError>;
impl From<Error> for IntentError {
    fn from(error: Error) -> Self {
        Self::Domain(error)
    }
}
impl IntentError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::OriginMissing => "intent_origin_missing",
            Self::OriginInvalid | Self::InvalidRegistration => "intent_origin_invalid",
            Self::OriginMismatch => "intent_origin_mismatch",
            Self::OperationCollision => "operation_collision",
            Self::HeadConflict => "intent_head_conflict",
            Self::UnsupportedSchema => "incompatible_schema",
            Self::ReservedClient => "reserved_checkpoint_client",
            Self::Scope | Self::InvalidIdentity => "invalid_request",
            Self::Limit | Self::Domain(Error::Limit) => "limit",
            Self::Domain(_) => "invalid_operation",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SchemaLineage {
    pub format_version: u8,
    pub schemas: Vec<Schema>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LineageRegistration {
    pub realm: Id,
    pub vault: Id,
    pub owner: Id,
    pub schema: Schema,
    pub lineage: SchemaLineage,
}
/// No Deserialize or public constructor: only compiled declarations confer validity.
#[derive(Clone, Debug)]
pub struct ValidatedRegistration {
    declaration: LineageRegistration,
    bytes: Vec<u8>,
    // Always selected by trusted compiled code; never populated from retained JSON.
    catalog: Vec<Schema>,
}
impl ValidatedRegistration {
    pub fn declaration(&self) -> &LineageRegistration {
        &self.declaration
    }
    pub fn canonical_bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn origin_schema(&self, version: u32) -> Option<&Schema> {
        self.declaration
            .lineage
            .schemas
            .iter()
            .find(|s| s.version == version)
    }
    pub fn lineage_identity(&self) -> IntentResult<Vec<u8>> {
        json(&(
            "managed-record-lineage-v1",
            &self.declaration.realm,
            &self.declaration.vault,
            &self.declaration.owner,
            &self.declaration.schema.collection,
            &self.declaration.lineage.schemas,
        ))
    }
}
fn json<T: Serialize>(value: &T) -> IntentResult<Vec<u8>> {
    serde_json::to_vec(value).map_err(|_| IntentError::OriginInvalid)
}
fn canonical<T: for<'de> Deserialize<'de> + Serialize>(
    bytes: &[u8],
    limit: usize,
) -> IntentResult<T> {
    if bytes.len() > limit {
        return Err(IntentError::Limit);
    }
    let value: T = serde_json::from_slice(bytes).map_err(|_| IntentError::OriginInvalid)?;
    if json(&value)? != bytes {
        return Err(IntentError::OriginInvalid);
    }
    Ok(value)
}
fn valid_uuid(value: &str) -> IntentResult<()> {
    if value.len() != 36
        || !value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
    {
        return Err(IntentError::InvalidIdentity);
    }
    Ok(())
}
pub fn is_reserved_checkpoint_client(client: &str) -> bool {
    client.eq_ignore_ascii_case(RESERVED_CHECKPOINT_CLIENT)
}
/// Generic admission AND every generic checkpoint operation must call this guard.
/// It does not grant access to the reserved namespace to any caller.
pub fn validate_ordinary_checkpoint_client(client: &str) -> IntentResult<()> {
    if is_reserved_checkpoint_client(client) {
        return Err(IntentError::ReservedClient);
    }
    valid_uuid(client)
}
fn valid_authority(value: &str) -> IntentResult<()> {
    // Current native Store IDs and browser local-store-id are canonical UUIDs.
    valid_uuid(value)
}
fn check_scope(registration: &ValidatedRegistration, scope: &Scope) -> IntentResult<()> {
    scope.validate()?;
    let r = &registration.declaration;
    if scope.realm != r.realm
        || scope.vault != r.vault
        || scope.owner != r.owner
        || scope.collection != r.schema.collection
    {
        return Err(IntentError::Scope);
    }
    Ok(())
}
fn optional_step(old: &Schema, next: &Schema) -> IntentResult<()> {
    old.validate()?;
    next.validate()?;
    if old.collection != next.collection || old.policy != next.policy || old.version >= next.version
    {
        return Err(IntentError::InvalidRegistration);
    }
    for (id, field) in &old.fields {
        let after = next
            .fields
            .get(id)
            .ok_or(IntentError::InvalidRegistration)?;
        // f64 PartialEq equates -0.0 and 0.0; canonical bytes are the authority.
        if json(field)? != json(after)? {
            return Err(IntentError::InvalidRegistration);
        }
    }
    if next
        .fields
        .iter()
        .any(|(id, field)| !old.fields.contains_key(id) && field.required)
    {
        return Err(IntentError::InvalidRegistration);
    }
    Ok(())
}
fn validate_with_catalog(
    bytes: &[u8],
    catalog: &[Schema],
    owner: &Id,
) -> IntentResult<ValidatedRegistration> {
    let r: LineageRegistration = canonical(bytes, MAX_REGISTRATION_BYTES)?;
    for id in [&r.realm, &r.vault, &r.owner] {
        id.validate()?;
    }
    if &r.owner != owner
        || r.lineage.format_version != 1
        || r.lineage.schemas.is_empty()
        || r.lineage.schemas.len() > MAX_LINEAGE_DECLARATIONS
        || catalog.is_empty()
        || catalog.len() > MAX_LINEAGE_DECLARATIONS
        || r.lineage.schemas.len() > catalog.len()
    {
        return Err(IntentError::InvalidRegistration);
    }
    for (i, schema) in r.lineage.schemas.iter().enumerate() {
        schema.validate()?;
        if json(schema)? != json(&catalog[i])? {
            return Err(IntentError::InvalidRegistration);
        }
        if i > 0 {
            optional_step(&r.lineage.schemas[i - 1], schema)?;
        }
    }
    if json(&r.schema)?
        != json(
            r.lineage
                .schemas
                .last()
                .ok_or(IntentError::InvalidRegistration)?,
        )?
    {
        return Err(IntentError::InvalidRegistration);
    }
    Ok(ValidatedRegistration {
        declaration: r,
        bytes: bytes.to_vec(),
        catalog: catalog.to_vec(),
    })
}
/// The only production catalog is compiled WorkBlocks v1. No product v2 exists.
pub fn validate_registration(bytes: &[u8]) -> IntentResult<ValidatedRegistration> {
    validate_with_catalog(
        bytes,
        &[first_party::schema()],
        &Id::new(first_party::OWNER)?,
    )
}
pub fn compiled_registration(realm: Id, vault: Id) -> IntentResult<ValidatedRegistration> {
    let original = first_party::registration(realm, vault)?;
    let r = LineageRegistration {
        realm: original.realm,
        vault: original.vault,
        owner: original.owner,
        schema: original.schema.clone(),
        lineage: SchemaLineage {
            format_version: 1,
            schemas: vec![original.schema],
        },
    };
    validate_registration(&json(&r)?)
}
pub fn validate_extension(
    old: &ValidatedRegistration,
    next: &ValidatedRegistration,
) -> IntentResult<bool> {
    let a = &old.declaration;
    let b = &next.declaration;
    if a.realm != b.realm
        || a.vault != b.vault
        || a.owner != b.owner
        || a.schema.collection != b.schema.collection
    {
        return Err(IntentError::Scope);
    }
    if a.lineage.schemas.len() > b.lineage.schemas.len() {
        return Err(IntentError::InvalidRegistration);
    }
    for (i, schema) in a.lineage.schemas.iter().enumerate() {
        if json(schema)? != json(&b.lineage.schemas[i])? {
            return Err(IntentError::InvalidRegistration);
        }
    }
    Ok(old.bytes != next.bytes)
}
/// Validate against the operation's own certified declaration, never version <= active.
/// Causal union/pending/kind inference still belongs to existing State/admission.
pub fn validate_origin_operation(
    registration: &ValidatedRegistration,
    operation: &Operation,
) -> IntentResult<()> {
    check_scope(registration, &operation.scope)?;
    let schema = registration
        .origin_schema(operation.schema_version)
        .ok_or(IntentError::UnsupportedSchema)?;
    let structural = State::new_structural(schema.clone(), operation.scope.clone())?;
    structural.validate_operation_structure(operation)?;
    first_party::validate_operation(operation)?;
    Ok(())
}
pub fn validate_origin_history(
    registration: &ValidatedRegistration,
    operations: &[Operation],
) -> IntentResult<()> {
    if operations.len() > MAX_HISTORY {
        return Err(IntentError::Limit);
    }
    // Gate the whole payload before supported semantics: a future declaration is
    // retryable even if another supported operation would currently be invalid.
    if operations
        .iter()
        .any(|op| registration.origin_schema(op.schema_version).is_none())
    {
        return Err(IntentError::UnsupportedSchema);
    }
    for operation in operations {
        validate_origin_operation(registration, operation)?;
    }
    Ok(())
}
pub fn original_empty_state_bytes(
    registration: &ValidatedRegistration,
    scope: &Scope,
) -> IntentResult<Vec<u8>> {
    check_scope(registration, scope)?;
    // Host hashes these ORIGINAL bytes using its existing digest implementation.
    Ok(State::new(registration.declaration.schema.clone(), scope.clone())?.snapshot()?)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedIntentRef {
    pub operation: Id,
    pub capture_revision: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct IntentDocument {
    format_version: u8,
    store_authority: String,
    capture_revision: String,
    operation: Id,
    scope: Scope,
    origin_registration: String,
    expected_revision: [u8; 32],
    command: Command,
    semantic_request: Option<String>,
}
/// Immutable validated full request. It is evidence only when loaded by an authorized
/// host from its fenced checkpoint/journal; caller-provided bytes never prove issuance.
#[derive(Clone, Debug)]
pub struct LocalIntentV1 {
    document: IntentDocument,
    origin: ValidatedRegistration,
    bytes: Vec<u8>,
}
pub type ValidatedLocalIntent = LocalIntentV1;
impl LocalIntentV1 {
    pub fn reference(&self) -> ManagedIntentRef {
        ManagedIntentRef {
            operation: self.document.operation.clone(),
            capture_revision: self.document.capture_revision.clone(),
        }
    }
    pub fn scope(&self) -> &Scope {
        &self.document.scope
    }
    pub fn operation(&self) -> &Id {
        &self.document.operation
    }
    pub fn store_authority(&self) -> &str {
        &self.document.store_authority
    }
    pub fn capture_revision(&self) -> &str {
        &self.document.capture_revision
    }
    pub fn origin(&self) -> &ValidatedRegistration {
        &self.origin
    }
    pub fn expected_revision(&self) -> &[u8; 32] {
        &self.document.expected_revision
    }
    pub fn command(&self) -> &Command {
        &self.document.command
    }
    pub fn semantic_request(&self) -> Option<&[u8]> {
        self.document.semantic_request.as_deref().map(str::as_bytes)
    }
}
fn validate_raw(
    registration: &ValidatedRegistration,
    operation: &Id,
    scope: &Scope,
    command: &Command,
) -> IntentResult<()> {
    let parent = if operation.as_str() == "intent-validation-parent" {
        "intent-validation-parent-2"
    } else {
        "intent-validation-parent"
    };
    let op = Operation {
        id: operation.clone(),
        scope: scope.clone(),
        parents: if matches!(command, Command::Create(_)) {
            vec![]
        } else {
            vec![Id::new(parent)?]
        },
        schema_version: registration.declaration.schema.version,
        command: command.clone(),
    };
    validate_origin_operation(registration, &op)?;
    // Incoming history may retain supported unknown fields; fresh local input may not.
    if let Command::Create(actions) | Command::Patch(actions) = command {
        if actions.iter().any(|a| {
            !registration
                .declaration
                .schema
                .fields
                .contains_key(a.field())
        }) {
            return Err(Error::UnknownField.into());
        }
    }
    Ok(())
}
fn validate_semantic(document: &IntentDocument) -> IntentResult<()> {
    let Some(raw) = &document.semantic_request else {
        return Ok(());
    };
    if document.scope.owner.as_str() != first_party::OWNER
        || document.scope.collection.as_str() != first_party::COLLECTION
        || document.scope.restores.is_some()
    {
        return Err(IntentError::Scope);
    }
    use workblock_service::WorkBlockCommand as W;
    let semantic: W = canonical(raw.as_bytes(), MAX_SEMANTIC_BYTES)?;
    let (record, generation, operation) = match &semantic {
        W::Create {
            record,
            generation,
            operation,
            ..
        }
        | W::Move {
            record,
            generation,
            operation,
            ..
        }
        | W::Title {
            record,
            generation,
            operation,
            ..
        }
        | W::AddRef {
            record,
            generation,
            operation,
            ..
        }
        | W::RemoveRef {
            record,
            generation,
            operation,
            ..
        }
        | W::Delete {
            record,
            generation,
            operation,
            ..
        } => (record, generation, operation),
        _ => return Err(IntentError::OriginInvalid),
    };
    if record != &document.scope.record
        || generation != &document.scope.generation
        || operation != &document.operation
    {
        return Err(IntentError::OperationCollision);
    }
    // This tuple is only a transient call into shared semantic validation. It is never
    // persisted or accepted by the new format decoder as an alternate request format.
    let raw = admission::local_request(
        &document.scope,
        &document.expected_revision,
        &document.command,
    )?;
    workblock_service::command_for_replay(
        &semantic,
        &document.scope,
        &document.expected_revision,
        &raw,
    )
    .map_err(|e| match e {
        workblock_service::ServiceError::OperationCollision => IntentError::OperationCollision,
        workblock_service::ServiceError::Domain(e) => IntentError::Domain(e),
        workblock_service::ServiceError::Limit => IntentError::Limit,
        _ => IntentError::OriginInvalid,
    })?;
    Ok(())
}
fn document_valid(document: &IntentDocument, origin: &ValidatedRegistration) -> IntentResult<()> {
    if document.format_version != 1 {
        return Err(IntentError::OriginInvalid);
    }
    valid_authority(&document.store_authority)?;
    valid_uuid(&document.capture_revision)?;
    document.operation.validate()?;
    check_scope(origin, &document.scope)?;
    validate_raw(
        origin,
        &document.operation,
        &document.scope,
        &document.command,
    )?;
    validate_semantic(document)
}
pub fn capture_local_intent(
    registration: &ValidatedRegistration,
    store_authority: &str,
    capture_revision: &str,
    operation: Id,
    scope: Scope,
    expected: [u8; 32],
    command: Command,
    semantic_request: Option<&[u8]>,
) -> IntentResult<LocalIntentV1> {
    if semantic_request.is_some_and(|bytes| bytes.len() > MAX_SEMANTIC_BYTES) {
        return Err(IntentError::Limit);
    }
    let document = IntentDocument {
        format_version: 1,
        store_authority: store_authority.into(),
        capture_revision: capture_revision.into(),
        operation,
        scope,
        origin_registration: String::from_utf8(registration.bytes.clone())
            .map_err(|_| IntentError::OriginInvalid)?,
        expected_revision: expected,
        command,
        semantic_request: semantic_request
            .map(|b| String::from_utf8(b.to_vec()).map_err(|_| IntentError::OriginInvalid))
            .transpose()?,
    };
    document_valid(&document, registration)?;
    let bytes = json(&document)?;
    if bytes.len() > MAX_INTENT_BYTES {
        return Err(IntentError::Limit);
    }
    Ok(LocalIntentV1 {
        document,
        origin: registration.clone(),
        bytes,
    })
}
pub fn canonical_intent_request(intent: &LocalIntentV1) -> IntentResult<Vec<u8>> {
    if intent.bytes.len() > MAX_INTENT_BYTES {
        return Err(IntentError::Limit);
    }
    Ok(intent.bytes.clone())
}
pub fn validate_retained_intent(
    current: &ValidatedRegistration,
    store_authority: &str,
    expected_scope: &Scope,
    reference: &ManagedIntentRef,
    retained_bytes: &[u8],
) -> IntentResult<ValidatedLocalIntent> {
    if retained_bytes.is_empty() {
        return Err(IntentError::OriginMissing);
    }
    valid_authority(store_authority)?;
    valid_uuid(&reference.capture_revision)?;
    reference.operation.validate()?;
    check_scope(current, expected_scope)?;
    let document: IntentDocument = canonical(retained_bytes, MAX_INTENT_BYTES)?;
    if document.store_authority != store_authority || &document.scope != expected_scope {
        return Err(IntentError::Scope);
    }
    if document.operation != reference.operation {
        return Err(IntentError::OperationCollision);
    }
    if document.capture_revision != reference.capture_revision {
        return Err(IntentError::HeadConflict);
    }
    let origin = validate_with_catalog(
        document.origin_registration.as_bytes(),
        &current.catalog,
        &current.declaration.owner,
    )?;
    validate_extension(&origin, current)?;
    document_valid(&document, &origin)?;
    Ok(LocalIntentV1 {
        document,
        origin,
        bytes: retained_bytes.to_vec(),
    })
}
/// Call ONLY after exact committed-journal lookup found no row, before state/default work.
pub fn require_fresh_origin(
    current: &ValidatedRegistration,
    original: &ValidatedLocalIntent,
) -> IntentResult<()> {
    if current.bytes != original.origin.bytes {
        return Err(IntentError::OriginMismatch);
    }
    Ok(())
}
/// Repeated capture compares ORIGINAL caller input, excluding newly read origin.
/// Committed replay must separately compare the full canonical request byte-for-byte.
pub fn require_matching_input(
    original: &ValidatedLocalIntent,
    scope: &Scope,
    operation: &Id,
    expected: &[u8; 32],
    command: &Command,
    semantic: Option<&[u8]>,
) -> IntentResult<()> {
    if original.scope() != scope
        || original.operation() != operation
        || original.expected_revision() != expected
        || json(original.command())? != json(command)?
        || original.semantic_request() != semantic
    {
        return Err(IntentError::OperationCollision);
    }
    Ok(())
}
pub fn intent_checkpoint_key(scope: &Scope, operation: &Id) -> IntentResult<String> {
    scope.validate()?;
    operation.validate()?;
    let bytes = json(&(
        "managed-record-intent-v1",
        &scope.realm,
        &scope.vault,
        &scope.owner,
        &scope.collection,
        operation,
    ))?;
    if bytes.len() > MAX_INTENT_KEY_BYTES {
        return Err(IntentError::Limit);
    }
    String::from_utf8(bytes).map_err(|_| IntentError::OriginInvalid)
}

/// Fixed synthetic trust catalog for explicitly enabled downstream SQLite tests.
/// No arbitrary schema, collection, lineage or catalog input can confer trust.
#[cfg(feature = "intent-test-fixtures")]
pub fn intent_test_registration(
    realm: Id,
    vault: Id,
    version: u32,
) -> IntentResult<ValidatedRegistration> {
    if !matches!(version, 1 | 2) {
        return Err(IntentError::UnsupportedSchema);
    }
    let owner = Id::new("origin-store-fixture")?;
    let v1 = Schema {
        collection: Id::new("origin-store-fixture-records")?,
        version: 1,
        policy: crate::Policy::Synced,
        fields: std::collections::BTreeMap::new(),
    };
    let mut v2 = v1.clone();
    v2.version = 2;
    v2.fields.insert(
        Id::new("optional")?,
        crate::Field {
            kind: crate::Kind::String,
            required: false,
            nullable: false,
            default: Some(crate::Cell::Value(crate::Value::String(
                "new-default".into(),
            ))),
        },
    );
    let catalog = vec![v1, v2];
    let declaration = LineageRegistration {
        realm,
        vault,
        owner: owner.clone(),
        schema: catalog[version as usize - 1].clone(),
        lineage: SchemaLineage {
            format_version: 1,
            schemas: catalog[..version as usize].to_vec(),
        },
    };
    validate_with_catalog(&json(&declaration)?, &catalog, &owner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Action, Cell, Field, Kind, Policy, Value};
    use std::collections::BTreeMap;
    fn id(s: &str) -> Id {
        Id::new(s).unwrap()
    }
    fn fixture(schemas: Vec<Schema>, active: usize) -> ValidatedRegistration {
        let declaration = LineageRegistration {
            realm: id("r"),
            vault: id("v"),
            owner: id("fixture"),
            schema: schemas[active - 1].clone(),
            lineage: SchemaLineage {
                format_version: 1,
                schemas: schemas[..active].to_vec(),
            },
        };
        validate_with_catalog(&json(&declaration).unwrap(), &schemas, &id("fixture")).unwrap()
    }
    fn v1() -> Schema {
        Schema {
            collection: id("fixture-records"),
            version: 1,
            policy: Policy::Synced,
            fields: BTreeMap::new(),
        }
    }
    fn v2() -> Schema {
        let mut s = v1();
        s.version = 2;
        s.fields.insert(
            id("optional"),
            Field {
                kind: Kind::String,
                required: false,
                nullable: false,
                default: Some(Cell::Value(Value::String("new-default".into()))),
            },
        );
        s
    }
    fn scope() -> Scope {
        Scope {
            realm: id("r"),
            vault: id("v"),
            owner: id("fixture"),
            collection: id("fixture-records"),
            record: id("record"),
            generation: id("create"),
            restores: None,
        }
    }
    const AUTH: &str = "11111111-1111-4111-8111-111111111111";
    const REV: &str = "22222222-2222-4222-8222-222222222222";
    #[test]
    fn r1_no_row_origin_rejects_even_when_empty_state_digest_input_is_identical() {
        let old = fixture(vec![v1(), v2()], 1);
        let current = fixture(vec![v1(), v2()], 2);
        let scope = scope();
        // Identical canonical state bytes imply identical digest under either host hash.
        assert_eq!(
            original_empty_state_bytes(&old, &scope).unwrap(),
            original_empty_state_bytes(&current, &scope).unwrap()
        );
        let original = capture_local_intent(
            &old,
            AUTH,
            REV,
            id("create"),
            scope.clone(),
            [7; 32],
            Command::Create(vec![]),
            None,
        )
        .unwrap();
        let bytes = canonical_intent_request(&original).unwrap();
        let retained =
            validate_retained_intent(&current, AUTH, &scope, &original.reference(), &bytes)
                .unwrap();
        assert_eq!(canonical_intent_request(&retained).unwrap(), bytes);
        assert_eq!(
            require_fresh_origin(&current, &retained),
            Err(IntentError::OriginMismatch)
        );
        assert!(require_fresh_origin(&old, &retained).is_ok());
        // This counterexample is the fresh preparation the gate MUST prevent.
        let new_state = State::new(v2(), scope.clone()).unwrap();
        let p = new_state
            .prepare(id("create"), Command::Create(vec![]))
            .unwrap();
        assert!(
            matches!(&p.next().history()[&id("create")].command,Command::Create(a) if a.len()==1)
        );
        assert!(matches!(original.command(),Command::Create(a) if a.is_empty()));
        assert!(new_state.history().is_empty());
    }
    #[test]
    fn lineage_optional_only_prefix_and_canonical_numeric_defaults() {
        let a = fixture(vec![v1(), v2()], 1);
        let b = fixture(vec![v1(), v2()], 2);
        assert_eq!(validate_extension(&a, &b).unwrap(), true);
        assert!(validate_extension(&b, &a).is_err());
        assert_eq!(validate_extension(&b, &b).unwrap(), false);
        for kind in [Kind::String, Kind::Set] {
            let mut bad = v2();
            let f = bad.fields.get_mut(&id("optional")).unwrap();
            f.kind = kind;
            f.required = true;
            f.default = None;
            assert!(optional_step(&v1(), &bad).is_err());
        }
        let mut known = v1();
        known.fields.insert(
            id("kept"),
            Field {
                kind: Kind::String,
                required: false,
                nullable: false,
                default: None,
            },
        );
        for change in 0..8 {
            let mut next = known.clone();
            next.version = 2;
            match change {
                0 => {
                    next.fields.remove(&id("kept"));
                }
                1 => next.fields.get_mut(&id("kept")).unwrap().kind = Kind::Number,
                2 => next.fields.get_mut(&id("kept")).unwrap().nullable = true,
                3 => {
                    next.fields.get_mut(&id("kept")).unwrap().default =
                        Some(Cell::Value(Value::String("changed".into())))
                }
                4 => next.fields.get_mut(&id("kept")).unwrap().required = true,
                5 => next.policy = Policy::Local,
                6 => next.collection = id("different"),
                _ => next.version = 1,
            }
            assert!(
                optional_step(&known, &next).is_err(),
                "incompatible declaration change {change}"
            );
        }
        let mut negative = v1();
        negative.fields.insert(
            id("n"),
            Field {
                kind: Kind::Number,
                required: false,
                nullable: false,
                default: Some(Cell::Value(Value::Number(-0.0))),
            },
        );
        let mut positive = negative.clone();
        positive.version = 2;
        positive.fields.get_mut(&id("n")).unwrap().default = Some(Cell::Value(Value::Number(0.0)));
        assert!(optional_step(&negative, &positive).is_err());
        let mut nested = v2();
        nested.fields.insert(
            id("object"),
            Field {
                kind: Kind::Object,
                required: false,
                nullable: false,
                default: Some(Cell::Value(Value::Object(BTreeMap::from([
                    ("z".into(), serde_json::json!({"b":2,"a":1})),
                    ("a".into(), serde_json::json!(-0.0)),
                ])))),
            },
        );
        let validated = fixture(vec![v1(), nested], 2);
        let encoded = String::from_utf8(validated.bytes).unwrap();
        assert!(encoded.contains("\"a\":-0.0,\"z\":{\"a\":1,\"b\":2}"));
    }
    #[test]
    fn historical_operations_use_declared_origin_not_numeric_less_than_active() {
        let mut third = v2();
        third.version = 3;
        let current = fixture(vec![v1(), third], 2);
        let mut op = Operation {
            id: id("create"),
            scope: scope(),
            parents: vec![],
            schema_version: 1,
            command: Command::Create(vec![]),
        };
        validate_origin_history(&current, &[op.clone()]).unwrap();
        op.schema_version = 2;
        assert_eq!(
            validate_origin_operation(&current, &op),
            Err(IntentError::UnsupportedSchema)
        );
        op.schema_version = 3;
        validate_origin_operation(&current, &op).unwrap();
        let mut invalid = op.clone();
        invalid.id = id("not-generation");
        let mut future = op.clone();
        future.schema_version = 2;
        assert_eq!(
            validate_origin_history(&current, &[invalid, future]),
            Err(IntentError::UnsupportedSchema)
        );
    }
    #[test]
    fn lineage_declared_catalog_bounds_forks_and_omissions() {
        let mut catalog = Vec::new();
        for version in 1..=16 {
            let mut s = v1();
            s.version = version;
            catalog.push(s);
        }
        let top = fixture(catalog.clone(), 16);
        assert_eq!(top.declaration.lineage.schemas.len(), 16);
        let mut too_many = top.declaration.clone();
        let mut last = v1();
        last.version = 17;
        too_many.lineage.schemas.push(last.clone());
        too_many.schema = last;
        assert!(
            validate_with_catalog(&json(&too_many).unwrap(), &catalog, &id("fixture")).is_err()
        );
        let mut omitted = top.declaration.clone();
        omitted.lineage.schemas.remove(0);
        assert!(validate_with_catalog(&json(&omitted).unwrap(), &catalog, &id("fixture")).is_err());
        let mut fork = top.declaration.clone();
        fork.lineage.schemas[0].policy = Policy::Local;
        assert!(validate_with_catalog(&json(&fork).unwrap(), &catalog, &id("fixture")).is_err());
        assert_eq!(
            validate_with_catalog(
                &vec![b' '; MAX_REGISTRATION_BYTES + 1],
                &catalog,
                &id("fixture")
            )
            .err(),
            Some(IntentError::Limit)
        );
        let mut large = v1();
        for n in 0..40 {
            large.fields.insert(
                id(&format!("f{n}")),
                Field {
                    kind: Kind::String,
                    required: false,
                    nullable: false,
                    default: Some(Cell::Value(Value::String("x".repeat(15_000)))),
                },
            );
        }
        large.validate().unwrap();
        let declaration = LineageRegistration {
            realm: id("r"),
            vault: id("v"),
            owner: id("fixture"),
            schema: large.clone(),
            lineage: SchemaLineage {
                format_version: 1,
                schemas: vec![large.clone()],
            },
        };
        assert_eq!(
            validate_with_catalog(&json(&declaration).unwrap(), &[large], &id("fixture")).err(),
            Some(IntentError::Limit)
        );
    }
    #[test]
    fn raw_input_does_not_gain_defaults_and_changed_witness_or_raw_command_collides() {
        let current = fixture(vec![v1(), v2()], 2);
        let captured = capture_local_intent(
            &current,
            AUTH,
            REV,
            id("create"),
            scope(),
            [8; 32],
            Command::Create(vec![]),
            None,
        )
        .unwrap();
        assert!(matches!(captured.command(),Command::Create(a) if a.is_empty()));
        assert!(require_matching_input(
            &captured,
            &scope(),
            &id("create"),
            &[8; 32],
            &Command::Create(vec![]),
            None
        )
        .is_ok());
        assert_eq!(
            require_matching_input(
                &captured,
                &scope(),
                &id("create"),
                &[9; 32],
                &Command::Create(vec![]),
                None
            ),
            Err(IntentError::OperationCollision)
        );
        let mut numeric = v1();
        numeric.fields.insert(
            id("number"),
            Field {
                kind: Kind::Number,
                required: false,
                nullable: false,
                default: None,
            },
        );
        let numeric_registration = fixture(vec![numeric], 1);
        let negative = Command::Create(vec![Action::Write {
            field: id("number"),
            cell: Cell::Value(Value::Number(-0.0)),
        }]);
        let positive = Command::Create(vec![Action::Write {
            field: id("number"),
            cell: Cell::Value(Value::Number(0.0)),
        }]);
        assert_eq!(negative, positive); // Rust f64 equality alone would lose this identity.
        let signed = capture_local_intent(
            &numeric_registration,
            AUTH,
            REV,
            id("create"),
            scope(),
            [8; 32],
            negative,
            None,
        )
        .unwrap();
        assert_eq!(
            require_matching_input(&signed, &scope(), &id("create"), &[8; 32], &positive, None),
            Err(IntentError::OperationCollision)
        );
        let bytes = canonical_intent_request(&signed).unwrap();
        let decoded = validate_retained_intent(
            &numeric_registration,
            AUTH,
            &scope(),
            &signed.reference(),
            &bytes,
        )
        .unwrap();
        assert_eq!(canonical_intent_request(&decoded).unwrap(), bytes);
        let expanded = Command::Create(vec![Action::Write {
            field: id("optional"),
            cell: Cell::Value(Value::String("new-default".into())),
        }]);
        assert_eq!(
            require_matching_input(
                &captured,
                &scope(),
                &id("create"),
                &[8; 32],
                &expanded,
                None
            ),
            Err(IntentError::OperationCollision)
        );
    }
}
