//! Compiled first-party semantics. No registry callbacks or independent authority.
use crate::*;
use chrono::{DateTime, LocalResult, NaiveDateTime, Offset, TimeZone, Utc};
use chrono_tz::Tz;
use zorid_core::EntryId;

pub const OWNER: &str = "zorid_firstparty_calendar";
pub const COLLECTION: &str = "workblocks";
pub const MAX_TASK_REFS: usize = 64;
fn id(value: &str) -> Id {
    Id::new(value).expect("compiled identifier")
}
fn applies(owner: &Id, collection: &Id) -> bool {
    owner.as_str() == OWNER && collection.as_str() == COLLECTION
}
pub fn schema() -> Schema {
    Schema {
        collection: id(COLLECTION),
        version: 1,
        policy: Policy::Synced,
        fields: [
            ("range", Kind::Object, true),
            ("title", Kind::String, false),
            ("task_refs", Kind::Set, false),
        ]
        .into_iter()
        .map(|(name, kind, required)| {
            (
                id(name),
                Field {
                    kind,
                    required,
                    nullable: false,
                    default: None,
                },
            )
        })
        .collect(),
    }
}
pub fn registration(realm: Id, vault: Id) -> Result<admission::Registration> {
    realm.validate()?;
    vault.validate()?;
    Ok(admission::Registration {
        realm,
        vault,
        owner: id(OWNER),
        schema: schema(),
    })
}
/// Pure declaration check; must never construct a State (registration calls State::new).
pub(crate) fn validate_schema(owner: &Id, declared: &Schema) -> Result<()> {
    if applies(owner, &declared.collection) && declared != &schema() {
        return Err(Error::InvalidSchema);
    }
    Ok(())
}

/// Milliseconds serialize as canonical strings through JavaScript boundaries.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Range {
    pub start_ms: String,
    pub end_ms: String,
    pub timezone: String,
}
fn instant(text: &str) -> Result<i64> {
    let n: i64 = text.parse().map_err(|_| Error::InvalidValue)?;
    if n.to_string() != text || DateTime::<Utc>::from_timestamp_millis(n).is_none() {
        return Err(Error::InvalidValue);
    }
    Ok(n)
}
impl Range {
    pub fn new(start_ms: i64, end_ms: i64, timezone: impl Into<String>) -> Result<Self> {
        let out = Self {
            start_ms: start_ms.to_string(),
            end_ms: end_ms.to_string(),
            timezone: timezone.into(),
        };
        out.validate()?;
        Ok(out)
    }
    pub fn validate(&self) -> Result<()> {
        if instant(&self.end_ms)? <= instant(&self.start_ms)?
            || self.timezone.parse::<Tz>().is_err()
        {
            return Err(Error::InvalidValue);
        }
        Ok(())
    }
    pub fn cell(&self) -> Result<Cell> {
        self.validate()?;
        let serde_json::Value::Object(map) =
            serde_json::to_value(self).map_err(|_| Error::Codec)?
        else {
            unreachable!()
        };
        Ok(Cell::Value(Value::Object(map.into_iter().collect())))
    }
    pub fn from_cell(cell: &Cell) -> Result<Self> {
        let Cell::Value(Value::Object(map)) = cell else {
            return Err(Error::InvalidValue);
        };
        let out: Self =
            serde_json::from_value(serde_json::to_value(map).map_err(|_| Error::Codec)?)
                .map_err(|_| Error::InvalidValue)?;
        out.validate()?;
        Ok(out)
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WallTimeError {
    InvalidZone,
    Nonexistent,
    Ambiguous,
    InvalidOffset,
    OutOfRange,
}
/// Offset is seconds east of UTC. An ambiguous time always requires a matching choice.
pub fn resolve_wall_time(
    local: NaiveDateTime,
    zone: &str,
    offset_seconds: Option<i32>,
) -> std::result::Result<i64, WallTimeError> {
    let zone: Tz = zone.parse().map_err(|_| WallTimeError::InvalidZone)?;
    let selected = match zone.from_local_datetime(&local) {
        LocalResult::None => return Err(WallTimeError::Nonexistent),
        LocalResult::Single(value) => {
            if offset_seconds.is_some_and(|offset| value.offset().fix().local_minus_utc() != offset)
            {
                return Err(WallTimeError::InvalidOffset);
            }
            value
        }
        LocalResult::Ambiguous(a, b) => {
            let offset = offset_seconds.ok_or(WallTimeError::Ambiguous)?;
            if a.offset().fix().local_minus_utc() == offset {
                a
            } else if b.offset().fix().local_minus_utc() == offset {
                b
            } else {
                return Err(WallTimeError::InvalidOffset);
            }
        }
    };
    let ms = selected.timestamp_millis();
    if DateTime::<Utc>::from_timestamp_millis(ms).is_none() {
        return Err(WallTimeError::OutOfRange);
    }
    Ok(ms)
}
pub(crate) fn validate_operation(op: &Operation) -> Result<()> {
    if !applies(&op.scope.owner, &op.scope.collection) {
        return Ok(());
    }
    if op.schema_version != 1 {
        return Err(Error::InvalidSchema);
    }
    let actions = match &op.command {
        Command::Create(a) | Command::Patch(a) => a,
        Command::Delete => return Ok(()),
    };
    if matches!(op.command, Command::Create(_))
        && !actions
            .iter()
            .any(|a| matches!(a, Action::Write { field, .. } if field.as_str() == "range"))
    {
        return Err(Error::InvalidValue);
    }
    for action in actions {
        match action {
            Action::Write { field, cell } if field.as_str() == "range" => {
                Range::from_cell(cell)?;
            }
            Action::Write { field, cell } if field.as_str() == "title" => {
                if !matches!(cell, Cell::Unset | Cell::Value(Value::String(_))) {
                    return Err(Error::InvalidValue);
                }
                if matches!(cell, Cell::Value(Value::String(s)) if s.len() > 512) {
                    return Err(Error::InvalidValue);
                }
            }
            Action::Add { field, member } | Action::Remove { field, member, .. }
                if field.as_str() == "task_refs" =>
            {
                EntryId::new(member.as_str()).map_err(|_| Error::InvalidValue)?;
            }
            _ => (), // Unknown outer fields retain the existing records semantics.
        }
    }
    Ok(())
}
pub(crate) fn validate_export(state: &State) -> Result<()> {
    if !applies(&state.scope.owner, &state.scope.collection) {
        return Ok(());
    }
    validate_schema(&state.scope.owner, &state.schema)?;
    for operation in state.operations.values() {
        validate_operation(operation)?;
    }
    validate_projection(&state.scope, &state.projection()?)
}
pub(crate) fn validate_projection(scope: &Scope, projection: &Projection) -> Result<()> {
    if applies(&scope.owner, &scope.collection)
        && projection
            .sets
            .get(&id("task_refs"))
            .is_some_and(|refs| refs.len() > MAX_TASK_REFS)
    {
        return Err(Error::Limit);
    }
    Ok(())
}

pub fn create(range: &Range, title: Option<String>) -> Result<Command> {
    let mut actions = vec![Action::Write {
        field: id("range"),
        cell: range.cell()?,
    }];
    if let Some(title) = title {
        if title.len() > 512 {
            return Err(Error::InvalidValue);
        }
        actions.push(Action::Write {
            field: id("title"),
            cell: Cell::Value(Value::String(title)),
        });
    }
    Ok(Command::Create(actions))
}
/// Moving/resizing or resolving conflicts writes one entire range and State::prepare observes all heads.
pub fn set_range(range: &Range) -> Result<Command> {
    Ok(Command::Patch(vec![Action::Write {
        field: id("range"),
        cell: range.cell()?,
    }]))
}
pub fn set_title(title: Option<String>) -> Result<Command> {
    if title.as_ref().is_some_and(|s| s.len() > 512) {
        return Err(Error::InvalidValue);
    }
    Ok(Command::Patch(vec![Action::Write {
        field: id("title"),
        cell: title
            .map(|s| Cell::Value(Value::String(s)))
            .unwrap_or(Cell::Unset),
    }]))
}
/// One observed-set member per immutable operation; batch hosts use their existing local queue.
pub fn add_task(task: &EntryId) -> Command {
    Command::Patch(vec![Action::Add {
        field: id("task_refs"),
        member: id(task.as_str()),
    }])
}
pub fn remove_task(state: &State, task: &EntryId) -> Result<Command> {
    validate_schema(&state.scope.owner, &state.schema)?;
    if !applies(&state.scope.owner, &state.scope.collection) {
        return Err(Error::Scope);
    }
    let member = id(task.as_str());
    // Include all observed add tags, including already removed ones (valid and idempotent).
    let tags = state.history().values().filter(|op| match &op.command {
        Command::Create(a) | Command::Patch(a) => a.iter().any(|a|
            matches!(a, Action::Add { field, member: m } if field.as_str() == "task_refs" && m == &member)),
        _ => false,
    }).map(|op| op.id.clone()).collect();
    Ok(Command::Patch(vec![Action::Remove {
        field: id("task_refs"),
        member,
        tags,
    }]))
}
pub fn delete() -> Command {
    Command::Delete
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RangeCandidate {
    pub operation: Id,
    pub range: Range,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkBlock {
    pub record: Id,
    pub generation: Id,
    pub ranges: Vec<RangeCandidate>,
    pub titles: Vec<(Id, Option<String>)>,
    pub task_refs: BTreeSet<EntryId>,
}
/// Read without selecting away recoverable conflicts or joining referenced notes.
pub fn read(state: &State) -> Result<Option<WorkBlock>> {
    if !applies(&state.scope.owner, &state.scope.collection) {
        return Err(Error::Scope);
    }
    let projection = state.projection()?;
    if !projection.pending.is_empty() {
        return Err(Error::MissingDependency);
    }
    if !projection.created || projection.deleted {
        return Ok(None);
    }
    let ranges = projection
        .fields
        .get(&id("range"))
        .ok_or(Error::InvalidValue)?
        .iter()
        .map(|c| {
            Ok(RangeCandidate {
                operation: c.operation.clone(),
                range: Range::from_cell(&c.cell)?,
            })
        })
        .collect::<Result<_>>()?;
    let titles = projection
        .fields
        .get(&id("title"))
        .into_iter()
        .flatten()
        .map(|c| {
            let title = match &c.cell {
                Cell::Unset => None,
                Cell::Value(Value::String(s)) => Some(s.clone()),
                _ => return Err(Error::InvalidValue),
            };
            Ok((c.operation.clone(), title))
        })
        .collect::<Result<_>>()?;
    let task_refs = projection
        .sets
        .get(&id("task_refs"))
        .into_iter()
        .flatten()
        .map(|m| EntryId::new(m.as_str()).map_err(|_| Error::InvalidValue))
        .collect::<Result<_>>()?;
    Ok(Some(WorkBlock {
        record: state.scope.record.clone(),
        generation: state.scope.generation.clone(),
        ranges,
        titles,
        task_refs,
    }))
}
/// Shared half-open window predicate. Hosts own bounded paging and revision fencing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Window {
    from: i64,
    until: i64,
}
impl Window {
    pub fn new(from: &str, until: &str) -> Result<Self> {
        let from = instant(from)?;
        let until = instant(until)?;
        if until <= from || until.checked_sub(from).is_none_or(|n| n > 31 * 86_400_000) {
            return Err(Error::InvalidValue);
        }
        Ok(Self { from, until })
    }
    /// Include any intersecting candidate so a display winner cannot hide a conflict.
    pub fn intersects(&self, block: &WorkBlock) -> Result<bool> {
        for candidate in &block.ranges {
            candidate.range.validate()?;
            if instant(&candidate.range.start_ms)? < self.until
                && instant(&candidate.range.end_ms)? > self.from
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

/// Result for one bounded host page, not a snapshot-consistency or cursor authority.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueryPage<C> {
    pub blocks: Vec<WorkBlock>,
    pub continuation: Option<C>,
    pub incomplete: bool,
}
/// Hosts supply an authorized, revision-fenced storage page (native export still caps at 64).
/// The continuation is carried unchanged; any concurrent change requires a host restart.
pub fn query_page<C>(
    window: &Window,
    states: &[State],
    continuation: Option<C>,
) -> Result<QueryPage<C>> {
    if states.len() > 200 {
        return Err(Error::Limit);
    }
    let mut bytes = 0usize;
    let mut blocks = Vec::new();
    for state in states {
        bytes = bytes
            .checked_add(state.snapshot()?.len())
            .ok_or(Error::Limit)?;
        if bytes > MAX_BYTES {
            return Err(Error::Limit);
        }
        if let Some(block) = read(state)? {
            if window.intersects(&block)? {
                blocks.push(block);
            }
        }
    }
    Ok(QueryPage {
        blocks,
        incomplete: continuation.is_some(),
        continuation,
    })
}
