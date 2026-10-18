//! Pure first-party service DTOs and semantic preparation shared by native/WASM.
//! No storage access, admission authority, hashing, or durable receipt ownership.
use crate::{admission, first_party as domain, Action, Command, Error, Id, Result, Scope, State};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use zorid_core::EntryId;
pub use crate::first_party::Range as WorkBlockRange;

/// Same transparent 32-byte JSON array representation as native ManagedRevision.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkBlockRevision(pub [u8; 32]);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ServiceError {
    Domain(Error),
    InvalidRequest,
    OperationCollision,
    CorruptJournal,
    Limit,
}
pub type ServiceResult<T> = std::result::Result<T, ServiceError>;
impl From<Error> for ServiceError {
    fn from(error: Error) -> Self { Self::Domain(error) }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "op",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkBlockCommand {
    Create {
        record: Id,
        generation: Id,
        operation: Id,
        range: WorkBlockRange,
        title: Option<String>,
    },
    Read {
        record: Id,
        generation: Id,
    },
    Move {
        record: Id,
        generation: Id,
        operation: Id,
        expected_revision: WorkBlockRevision,
        range: WorkBlockRange,
    },
    Title {
        record: Id,
        generation: Id,
        operation: Id,
        expected_revision: WorkBlockRevision,
        #[serde(deserialize_with = "required_nullable_title")]
        title: Option<String>,
    },
    AddRef {
        record: Id,
        generation: Id,
        operation: Id,
        expected_revision: WorkBlockRevision,
        task: EntryId,
    },
    RemoveRef {
        record: Id,
        generation: Id,
        operation: Id,
        expected_revision: WorkBlockRevision,
        task: EntryId,
    },
    Delete {
        record: Id,
        generation: Id,
        operation: Id,
        expected_revision: WorkBlockRevision,
    },
    Window {
        from_ms: String,
        until_ms: String,
        limit: u32,
        byte_limit: u32,
        cursor: Option<String>,
    },
    Changes {
        after: String,
        limit: u32,
    },
}
fn required_nullable_title<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<String>, D::Error> {
    Option::<String>::deserialize(d)
}
impl WorkBlockCommand {
    pub fn op(&self) -> &'static str {
        match self {
            Self::Create { .. } => "create",
            Self::Read { .. } => "read",
            Self::Move { .. } => "move",
            Self::Title { .. } => "title",
            Self::AddRef { .. } => "add_ref",
            Self::RemoveRef { .. } => "remove_ref",
            Self::Delete { .. } => "delete",
            Self::Window { .. } => "window",
            Self::Changes { .. } => "changes",
        }
    }
    pub fn may_commit(&self) -> bool {
        !matches!(
            self,
            Self::Read { .. } | Self::Window { .. } | Self::Changes { .. }
        )
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkBlockRangeCandidate {
    pub operation: Id,
    pub range: WorkBlockRange,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkBlockTitleCandidate {
    pub operation: Id,
    pub title: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkBlockValue {
    pub ranges: Vec<WorkBlockRangeCandidate>,
    pub titles: Vec<WorkBlockTitleCandidate>,
    pub task_refs: Vec<EntryId>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkBlockRead {
    pub record: Id,
    pub generation: Id,
    pub revision: WorkBlockRevision,
    pub created: bool,
    pub deleted: bool,
    pub block: Option<WorkBlockValue>,
    pub unresolved: BTreeMap<String, String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkBlockWindowPage {
    pub blocks: Vec<WorkBlockRead>,
    pub cursor: Option<String>,
    pub incomplete: bool,
    pub watermark: String,
    pub scanned: u32,
    pub bytes: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowQuery {
    pub from: String,
    pub until: String,
    pub limit: u32,
    pub bytes: u32,
}

pub fn fixed_scope(realm: Id, vault: Id, record: Id, generation: Id) -> Result<Scope> {
    let scope = Scope {
        realm, vault, record, generation,
        owner: Id::new(domain::OWNER)?,
        collection: Id::new(domain::COLLECTION)?,
        restores: None,
    };
    scope.validate()?;
    Ok(scope)
}
fn check_fixed_scope(scope: &Scope) -> Result<()> {
    scope.validate()?;
    if scope.owner.as_str() != domain::OWNER
        || scope.collection.as_str() != domain::COLLECTION
        || scope.restores.is_some()
    { return Err(Error::Scope); }
    Ok(())
}
/// Hash these ORIGINAL bytes in the existing host hash implementation for create.
pub fn empty_state_bytes(scope: &Scope) -> Result<Vec<u8>> {
    check_fixed_scope(scope)?;
    State::new(domain::schema(), scope.clone())?.snapshot()
}

/// Validate public identities, create identity rule and mutation witness association.
/// This does not compare a witness to CURRENT state (the storage planner owns that).
fn mutation_identity<'a>(input: &'a WorkBlockCommand) -> ServiceResult<(&'a Id, &'a Id)> {
    use WorkBlockCommand::*;
    let (record, generation, operation) = match input {
        Create { record, generation, operation, .. } => {
            if operation != generation { return Err(ServiceError::InvalidRequest); }
            (record, generation, operation)
        }
        Move { record, generation, operation, .. }
        | Title { record, generation, operation, .. }
        | AddRef { record, generation, operation, .. }
        | RemoveRef { record, generation, operation, .. }
        | Delete { record, generation, operation, .. } => (record, generation, operation),
        _ => return Err(ServiceError::InvalidRequest),
    };
    for id in [record, generation, operation] { id.validate()?; }
    Ok((record, generation))
}

/// New remove-ref observes accepted history; every domain command remains first_party-owned.
pub fn command_for_new(input: &WorkBlockCommand, state: Option<&State>) -> ServiceResult<Command> {
    let (record, generation) = mutation_identity(input)?;
    use WorkBlockCommand::*;
    Ok(match input {
        Create { range, title, .. } => domain::create(range, title.clone())?,
        Move { range, .. } => domain::set_range(range)?,
        Title { title, .. } => domain::set_title(title.clone())?,
        AddRef { task, .. } => {
            let task = EntryId::new(task.as_str()).map_err(|_| Error::InvalidValue)?;
            domain::add_task(&task)
        }
        RemoveRef { task, .. } => {
            let task = EntryId::new(task.as_str()).map_err(|_| Error::InvalidValue)?;
            let state = state.ok_or(ServiceError::InvalidRequest)?;
            check_fixed_scope(state.scope())?;
            if &state.scope().record != record || &state.scope().generation != generation {
                return Err(Error::Scope.into());
            }
            domain::remove_task(state, &task)?
        }
        Delete { .. } => domain::delete(),
        _ => return Err(ServiceError::InvalidRequest),
    })
}

/// Recover exact original semantics BEFORE touching accepted state or its quotas.
/// Invalid/noncanonical retained bytes are corruption; valid different requests collide.
pub fn command_for_replay(
    input: &WorkBlockCommand,
    scope: &Scope,
    expected: &[u8; 32],
    prior_request: &[u8],
) -> ServiceResult<Command> {
    let (old_scope, old_expected, command): (Scope, [u8; 32], Command) =
        serde_json::from_slice(prior_request).map_err(|_| ServiceError::CorruptJournal)?;
    if admission::local_request(&old_scope, &old_expected, &command)
        .map_err(|_| ServiceError::CorruptJournal)? != prior_request
    { return Err(ServiceError::CorruptJournal); }
    // Structural invalidity in retained decoded identities is also corruption.
    old_scope.validate().map_err(|_| ServiceError::CorruptJournal)?;
    let (record, generation) = mutation_identity(input)?;
    check_fixed_scope(scope)?;
    if &old_scope != scope || old_expected != *expected
        || &scope.record != record || &scope.generation != generation
    { return Err(ServiceError::OperationCollision); }
    use WorkBlockCommand::*;
    let witness = match input {
        Move { expected_revision, .. } | Title { expected_revision, .. }
        | AddRef { expected_revision, .. } | RemoveRef { expected_revision, .. }
        | Delete { expected_revision, .. } => Some(&expected_revision.0),
        _ => None,
    };
    if witness.is_some_and(|w| w != expected) { return Err(ServiceError::OperationCollision); }
    let semantic = match input {
        RemoveRef { task, .. } => {
            EntryId::new(task.as_str()).map_err(|_| Error::InvalidValue)?;
            match &command {
                Command::Patch(actions) if actions.len() == 1
                    && matches!(&actions[0], Action::Remove { field, member, .. }
                        if field.as_str() == "task_refs" && member.as_str() == task.as_str()) => command.clone(),
                _ => return Err(ServiceError::OperationCollision),
            }
        }
        _ => command_for_new(input, None)?,
    };
    if admission::local_request(scope, expected, &semantic)? != prior_request {
        return Err(ServiceError::OperationCollision);
    }
    Ok(semantic)
}

pub fn read_value(state: &State) -> Result<Option<WorkBlockValue>> {
    check_fixed_scope(state.scope())?;
    Ok(domain::read(state)?.map(|block| WorkBlockValue {
        ranges: block.ranges.into_iter().map(|c| WorkBlockRangeCandidate {
            operation: c.operation, range: c.range,
        }).collect(),
        titles: block.titles.into_iter().map(|(operation, title)| WorkBlockTitleCandidate {
            operation, title,
        }).collect(),
        task_refs: block.task_refs.into_iter().collect(),
    }))
}
pub fn validate_window(query: &WindowQuery) -> ServiceResult<domain::Window> {
    if !(1..=64).contains(&query.limit) || !(1..=1_048_576).contains(&query.bytes) {
        return Err(ServiceError::InvalidRequest);
    }
    Ok(domain::Window::new(&query.from, &query.until)?)
}
