//! Internal, in-memory managed-record authority. No durable receipt or authorization.
pub mod wire;

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_ID: usize = 128;
pub const MAX_FIELDS: usize = 64;
pub const MAX_PARENTS: usize = 32;
pub const MAX_ACTIONS: usize = 64;
pub const MAX_VALUE: usize = 16 * 1024;
pub const MAX_DEPTH: usize = 16;
pub const MAX_HISTORY: usize = 4096;
pub const MAX_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidId, InvalidSchema, InvalidValue, InvalidOperation, UnknownField,
    Scope, Collision, Cycle, MissingDependency, Deleted, Limit, Codec, Stale,
}
pub type Result<T> = std::result::Result<T, Error>;

/// Host-allocated opaque identity; decoding is revalidated at admission.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Id(String);
impl Id {
    pub fn new(value: impl Into<String>) -> Result<Self> {
        let id = Self(value.into());
        id.validate()?;
        Ok(id)
    }
    pub fn as_str(&self) -> &str { &self.0 }
    fn validate(&self) -> Result<()> {
        if self.0.is_empty() || self.0.len() > MAX_ID || !self.0.is_ascii()
            || self.0.bytes().any(|b| b.is_ascii_control() || b.is_ascii_whitespace()) {
            return Err(Error::InvalidId);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scope {
    pub realm: Id, pub vault: Id, pub owner: Id, pub collection: Id,
    pub record: Id, pub generation: Id,
    /// Explicit previous generation linkage; verifying its tombstone is a host obligation.
    pub restores: Option<Id>,
}
impl Scope {
    fn validate(&self) -> Result<()> {
        for id in [&self.realm, &self.vault, &self.owner, &self.collection,
                   &self.record, &self.generation] { id.validate()?; }
        if let Some(old) = &self.restores {
            old.validate()?;
            if old == &self.generation { return Err(Error::InvalidOperation); }
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Policy { Synced, Local, Cache }
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Kind { Boolean, String, Integer, Number, Object, Set }
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value")]
pub enum Value {
    Boolean(bool), String(String), Integer(i64), Number(f64),
    Object(BTreeMap<String, serde_json::Value>),
}
impl Value {
    fn kind(&self) -> Kind {
        match self {
            Self::Boolean(_) => Kind::Boolean, Self::String(_) => Kind::String,
            Self::Integer(_) => Kind::Integer, Self::Number(_) => Kind::Number,
            Self::Object(_) => Kind::Object,
        }
    }
    fn validate(&self) -> Result<()> {
        if matches!(self, Self::Number(n) if !n.is_finite()) { return Err(Error::InvalidValue); }
        if let Self::Object(map) = self {
            fn depth(v: &serde_json::Value, level: usize) -> bool {
                if level > MAX_DEPTH { return false; }
                if matches!(v, serde_json::Value::String(s) if s.len() > MAX_VALUE) { return false; }
                match v {
                    serde_json::Value::Array(a) => a.iter().all(|x| depth(x, level + 1)),
                    serde_json::Value::Object(m) => m.iter().all(|(k, x)| k.len() <= MAX_ID && depth(x, level + 1)),
                    _ => true,
                }
            }
            if !map.iter().all(|(k, v)| k.len() <= MAX_ID && depth(v, 2)) { return Err(Error::Limit); }
        }
        if encode(self)?.len() > MAX_VALUE { return Err(Error::Limit); }
        Ok(())
    }
}
/// Null and absent are distinct authored field states, including conflict candidates.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", content = "value")]
pub enum Cell { Value(Value), Null, Unset }
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Field {
    pub kind: Kind, pub required: bool, pub nullable: bool, pub default: Option<Cell>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Schema {
    pub collection: Id, pub version: u32, pub policy: Policy,
    pub fields: BTreeMap<Id, Field>,
}
impl Schema {
    pub fn validate(&self) -> Result<()> {
        self.collection.validate()?;
        if self.version == 0 || self.fields.len() > MAX_FIELDS { return Err(Error::InvalidSchema); }
        for (id, field) in &self.fields {
            id.validate()?;
            // Sets are intrinsically present (possibly empty), never nullable/defaulted.
            if field.kind == Kind::Set && (field.nullable || field.default.is_some()) {
                return Err(Error::InvalidSchema);
            }
            if let Some(default) = &field.default { validate_cell(default, Some(field))?; }
        }
        Ok(())
    }
}
fn validate_cell(cell: &Cell, field: Option<&Field>) -> Result<()> {
    if let Cell::Value(v) = cell { v.validate()?; }
    if let Some(f) = field {
        let valid = match cell {
            Cell::Value(v) => v.kind() == f.kind,
            Cell::Null => f.nullable && f.kind != Kind::Set,
            Cell::Unset => !f.required && f.kind != Kind::Set,
        };
        if !valid { return Err(Error::InvalidValue); }
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "action", deny_unknown_fields)]
pub enum Action {
    Write { field: Id, cell: Cell },
    Add { field: Id, member: Id },
    Remove { field: Id, member: Id, tags: Vec<Id> },
}
impl Action {
    fn field(&self) -> &Id {
        match self { Self::Write { field, .. } | Self::Add { field, .. }
            | Self::Remove { field, .. } => field }
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "command", content = "actions")]
pub enum Command { Create(Vec<Action>), Patch(Vec<Action>), Delete }
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    pub id: Id, pub parents: Vec<Id>, pub scope: Scope,
    pub schema_version: u32, pub command: Command,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope { format: u32, scope: Scope, operations: Vec<Operation> }

#[derive(Clone, Debug, PartialEq)]
pub struct State {
    schema: Schema, scope: Scope, operations: BTreeMap<Id, Operation>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate { pub operation: Id, pub cell: Cell }
#[derive(Clone, Debug, PartialEq)]
pub struct Projection {
    pub created: bool, pub deleted: bool,
    /// Sorted ascending by operation ID; last candidate is the display winner only.
    pub fields: BTreeMap<Id, Vec<Candidate>>,
    pub sets: BTreeMap<Id, BTreeSet<Id>>,
    pub pending: BTreeSet<Id>,
}
#[derive(Clone, Debug)]
pub struct Prepared {
    /// Exact expected canonical state, not a durable revision token or a hash.
    expected: Vec<u8>, next: State, payload: Vec<u8>,
}
impl Prepared {
    pub fn expected(&self) -> &[u8] { &self.expected }
    pub fn next(&self) -> &State { &self.next }
    /// Authored payload intent; only Synced registrations may enqueue it for sync.
    pub fn payload(&self) -> &[u8] { &self.payload }
}
fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec(value).map_err(|_| Error::Codec)?;
    if bytes.len() > MAX_BYTES { return Err(Error::Limit); }
    Ok(bytes)
}
fn ordered(ids: &[Id]) -> bool { ids.windows(2).all(|w| w[0] < w[1]) }

/// Ephemeral sorted-ID ordinals, never serialized or used as operation identity.
/// The dense matrix uses N * ceil(N / 64) words, at most 2 MiB at MAX_HISTORY.
struct Ancestry {
    ordinals: BTreeMap<Id, usize>,
    accepted: Vec<bool>,
    words: usize,
    bits: Vec<u64>,
}
impl Ancestry {
    fn new(operations: &BTreeMap<Id, Operation>) -> Self {
        let count = operations.len();
        let words = (count + 63) / 64;
        Self {
            ordinals: operations.keys().enumerate().map(|(i, id)| (id.clone(), i)).collect(),
            accepted: vec![false; count], words, bits: vec![0; count * words],
        }
    }
    fn accepts(&self, id: &Id) -> bool {
        self.ordinals.get(id).is_some_and(|i| self.accepted[*i])
    }
    /// Strict ancestor lookup; absent IDs and pending rows never imply ancestry.
    fn contains(&self, descendant: &Id, ancestor: &Id) -> bool {
        match (self.ordinals.get(descendant), self.ordinals.get(ancestor)) {
            (Some(&d), Some(&a)) if self.accepted[d] => self.row_contains(d, a),
            _ => false,
        }
    }
    fn row_contains(&self, descendant: usize, ancestor: usize) -> bool {
        self.bits[descendant * self.words + ancestor / 64] & (1u64 << (ancestor % 64)) != 0
    }
    fn inherit(&mut self, child: usize, parent: usize) {
        for word in 0..self.words {
            let inherited = self.bits[parent * self.words + word];
            self.bits[child * self.words + word] |= inherited;
        }
        self.bits[child * self.words + parent / 64] |= 1u64 << (parent % 64);
    }
}

impl State {
    pub fn new(schema: Schema, scope: Scope) -> Result<Self> {
        schema.validate()?; scope.validate()?;
        if schema.collection != scope.collection { return Err(Error::Scope); }
        Ok(Self { schema, scope, operations: BTreeMap::new() })
    }
    pub fn schema(&self) -> &Schema { &self.schema }
    pub fn scope(&self) -> &Scope { &self.scope }
    pub fn history(&self) -> &BTreeMap<Id, Operation> { &self.operations }
    pub fn snapshot(&self) -> Result<Vec<u8>> {
        encode(&Envelope { format: 1, scope: self.scope.clone(),
            operations: self.operations.values().cloned().collect() })
    }
    pub fn restore(schema: Schema, bytes: &[u8]) -> Result<Self> {
        let envelope = Self::decode(bytes)?;
        let mut state = Self::new(schema, envelope.scope)?;
        state.union(&envelope.operations)?;
        Ok(state)
    }
    fn decode(bytes: &[u8]) -> Result<Envelope> {
        if bytes.len() > MAX_BYTES { return Err(Error::Limit); }
        let envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| Error::Codec)?;
        if envelope.format != 1 { return Err(Error::Codec); }
        envelope.scope.validate()?;
        if envelope.operations.len() > MAX_HISTORY { return Err(Error::Limit); }
        // A single canonical JSON spelling rejects duplicate keys and ambiguous numbers,
        // including duplicates inside atomic objects. This is not exact ciphertext dedupe.
        if encode(&envelope)? != bytes { return Err(Error::Codec); }
        Ok(envelope)
    }
    pub fn receive(&mut self, bytes: &[u8]) -> Result<()> {
        let envelope = Self::decode(bytes)?;
        if envelope.scope != self.scope { return Err(Error::Scope); }
        self.union(&envelope.operations)
    }
    /// Transactional immutable set union. Pending operations count against all limits.
    pub fn union(&mut self, incoming: &[Operation]) -> Result<()> {
        if incoming.len() > MAX_HISTORY { return Err(Error::Limit); }
        let mut next = self.clone();
        for op in incoming {
            next.validate_operation(op)?;
            if let Some(old) = next.operations.get(&op.id) {
                if encode(old)? != encode(op)? { return Err(Error::Collision); }
            } else {
                if next.operations.len() >= MAX_HISTORY { return Err(Error::Limit); }
                next.operations.insert(op.id.clone(), op.clone());
            }
        }
        // Unknown remote fields share the same total field budget. Infer supported
        // unknown kinds without accepting incompatible stable-field type changes.
        let mut kinds: BTreeMap<Id, Kind> = next.schema.fields.iter()
            .map(|(id, field)| (id.clone(), field.kind.clone())).collect();
        let mut field_ids: BTreeSet<Id> = kinds.keys().cloned().collect();
        for op in next.operations.values() {
            let actions = match &op.command {
                Command::Create(a) | Command::Patch(a) => a.as_slice(), _ => &[],
            };
            for action in actions {
                field_ids.insert(action.field().clone());
                let kind = match action {
                    Action::Write { cell: Cell::Value(v), .. } => Some(v.kind()),
                    Action::Write { .. } => None,
                    _ => Some(Kind::Set),
                };
                if let Some(kind) = kind {
                    if let Some(old) = kinds.insert(action.field().clone(), kind.clone()) {
                        if old != kind { return Err(Error::InvalidValue); }
                    }
                }
            }
        }
        if field_ids.len() > MAX_FIELDS { return Err(Error::Limit); }
        // Even an initially untyped unknown null/unset may not later become a set.
        for op in next.operations.values() {
            let actions = match &op.command {
                Command::Create(a) | Command::Patch(a) => a.as_slice(), _ => &[],
            };
            for action in actions {
                if matches!(action, Action::Write { .. })
                    && kinds.get(action.field()) == Some(&Kind::Set) {
                    return Err(Error::InvalidValue);
                }
            }
        }
        next.snapshot()?;
        next.analyze()?;
        *self = next;
        Ok(())
    }
    fn validate_operation(&self, op: &Operation) -> Result<()> {
        op.id.validate()?; op.scope.validate()?;
        if op.scope != self.scope { return Err(Error::Scope); }
        if op.schema_version == 0 { return Err(Error::InvalidSchema); }
        if op.parents.len() > MAX_PARENTS { return Err(Error::Limit); }
        if !ordered(&op.parents) { return Err(Error::InvalidOperation); }
        for p in &op.parents {
            p.validate()?;
            if p == &op.id { return Err(Error::Cycle); }
        }
        let actions = match &op.command {
            Command::Create(a) => {
                if op.id != self.scope.generation || !op.parents.is_empty() {
                    return Err(Error::InvalidOperation);
                }
                a
            }
            Command::Patch(a) => {
                if op.id == self.scope.generation || op.parents.is_empty() {
                    return Err(Error::InvalidOperation);
                }
                a
            }
            Command::Delete => {
                if op.id == self.scope.generation || op.parents.is_empty() {
                    return Err(Error::InvalidOperation);
                }
                return Ok(());
            }
        };
        if actions.len() > MAX_ACTIONS { return Err(Error::Limit); }
        let mut fields = BTreeSet::new();
        for action in actions {
            let id = action.field(); id.validate()?;
            // One action per field gives each add an unambiguous operation-ID tag.
            if !fields.insert(id.clone()) { return Err(Error::InvalidOperation); }
            let field = self.schema.fields.get(id);
            match action {
                Action::Write { cell, .. } => validate_cell(cell, field)?,
                Action::Add { member, .. } | Action::Remove { member, .. } => {
                    member.validate()?;
                    if field.is_some_and(|f| f.kind != Kind::Set) { return Err(Error::InvalidValue); }
                    if let Action::Remove { tags, .. } = action {
                        if tags.len() > MAX_HISTORY { return Err(Error::Limit); }
                        if !ordered(tags) { return Err(Error::InvalidOperation); }
                        for tag in tags { tag.validate()?; }
                    }
                }
            }
        }
        if matches!(op.command, Command::Create(_)) {
            for (id, field) in &self.schema.fields {
                if field.required && field.kind != Kind::Set && !fields.contains(id) {
                    return Err(Error::InvalidValue);
                }
            }
        }
        Ok(())
    }
    /// Compact transitive ancestry for accepted operations; missing chains stay pending.
    fn analyze(&self) -> Result<Ancestry> {
        // Sorted-ID ordinals only index scratch storage; Kahn order establishes causality.
        // Present-edge traversal detects cycles even behind unavailable parents.
        let operations: Vec<&Operation> = self.operations.values().collect();
        let mut ancestors = Ancestry::new(&self.operations);
        let mut indegree = vec![0usize; operations.len()];
        let mut children = vec![Vec::new(); operations.len()];
        for (index, op) in operations.iter().enumerate() {
            for parent in &op.parents {
                if let Some(&p) = ancestors.ordinals.get(parent) {
                    indegree[index] += 1;
                    children[p].push(index);
                }
            }
        }
        let mut queue: BTreeSet<usize> = indegree.iter().enumerate()
            .filter(|(_, n)| **n == 0).map(|(i, _)| i).collect();
        let mut visited = 0;
        while let Some(index) = queue.pop_first() {
            visited += 1;
            let op = operations[index];
            if op.parents.iter().all(|p| ancestors.accepts(p)) {
                for parent in &op.parents {
                    let p = ancestors.ordinals[parent];
                    ancestors.inherit(index, p);
                }
                if !matches!(op.command, Command::Create(_)) {
                    let root = ancestors.ordinals.get(&self.scope.generation)
                        .ok_or(Error::InvalidOperation)?;
                    if !ancestors.row_contains(index, *root) { return Err(Error::InvalidOperation); }
                }
                let actions = match &op.command {
                    Command::Create(a) | Command::Patch(a) => a.as_slice(), Command::Delete => &[],
                };
                for action in actions {
                    if let Action::Remove { field, member, tags } = action {
                        for tag in tags {
                            let source_index = ancestors.ordinals.get(tag)
                                .ok_or(Error::InvalidOperation)?;
                            if !ancestors.row_contains(index, *source_index) {
                                return Err(Error::InvalidOperation);
                            }
                            let source = operations[*source_index];
                            let adds = match &source.command {
                                Command::Create(a) | Command::Patch(a) => a.as_slice(), _ => &[],
                            };
                            if !adds.iter().any(|a| matches!(a, Action::Add { field: f, member: m }
                                if f == field && m == member)) { return Err(Error::InvalidOperation); }
                        }
                    }
                }
                ancestors.accepted[index] = true;
            }
            for &child in &children[index] {
                indegree[child] -= 1;
                if indegree[child] == 0 { queue.insert(child); }
            }
        }
        if visited != operations.len() { return Err(Error::Cycle); }
        Ok(ancestors)
    }
    pub fn projection(&self) -> Result<Projection> {
        let ancestors = self.analyze()?;
        let mut out = Projection { created: ancestors.accepts(&self.scope.generation),
            deleted: false, fields: BTreeMap::new(), sets: BTreeMap::new(),
            pending: self.operations.keys().filter(|id| !ancestors.accepts(id)).cloned().collect() };
        let mut adds: BTreeMap<(Id, Id), BTreeSet<Id>> = BTreeMap::new();
        let mut removed = BTreeSet::new();
        for id in self.operations.keys().filter(|id| ancestors.accepts(id)) {
            let op = &self.operations[id];
            let actions = match &op.command {
                Command::Create(a) | Command::Patch(a) => a,
                Command::Delete => { out.deleted = true; continue; }
            };
            for a in actions {
                match a {
                    Action::Write { field, cell } => out.fields.entry(field.clone()).or_default()
                        .push(Candidate { operation: id.clone(), cell: cell.clone() }),
                    Action::Add { field, member } => {
                        adds.entry((field.clone(), member.clone())).or_default().insert(id.clone());
                    }
                    Action::Remove { field, tags, .. } => {
                        removed.extend(tags.iter().map(|tag| (field.clone(), tag.clone())));
                    }
                }
            }
        }
        for candidates in out.fields.values_mut() {
            let all = candidates.clone();
            candidates.retain(|c| !all.iter().any(|other|
                ancestors.contains(&other.operation, &c.operation)));
        }
        for ((field, member), tags) in adds {
            if tags.iter().any(|tag| !removed.contains(&(field.clone(), tag.clone()))) {
                out.sets.entry(field).or_default().insert(member);
            }
        }
        Ok(out)
    }
    /// Prepare a known-field local command against all currently accepted heads.
    /// Pending remote dependencies block local authorship until explicitly resolved.
    pub fn prepare(&self, id: Id, mut command: Command) -> Result<Prepared> {
        id.validate()?;
        if let Command::Create(actions) = &mut command {
            for (field, spec) in &self.schema.fields {
                if !actions.iter().any(|a| a.field() == field) {
                    if let Some(default) = &spec.default {
                        actions.push(Action::Write { field: field.clone(), cell: default.clone() });
                    }
                }
            }
        }
        let actions = match &command {
            Command::Create(a) | Command::Patch(a) => a.as_slice(), Command::Delete => &[],
        };
        for action in actions {
            if !self.schema.fields.contains_key(action.field()) { return Err(Error::UnknownField); }
        }
        // Retry exact command identity before computing new heads or deletion checks.
        let op = if let Some(old) = self.operations.get(&id) {
            if encode(&old.command)? != encode(&command)? || old.schema_version != self.schema.version {
                return Err(Error::Collision);
            }
            old.clone()
        } else {
            let projection = self.projection()?;
            if !projection.pending.is_empty() { return Err(Error::MissingDependency); }
            match &command {
                Command::Create(_) if projection.created => return Err(Error::InvalidOperation),
                Command::Create(_) => (),
                _ if !projection.created => return Err(Error::MissingDependency),
                _ if projection.deleted => return Err(Error::Deleted),
                _ => (),
            }
            let mut heads: BTreeSet<Id> = self.operations.keys().cloned().collect();
            for operation in self.operations.values() {
                for parent in &operation.parents { heads.remove(parent); }
            }
            Operation { id, parents: heads.into_iter().collect(), scope: self.scope.clone(),
                schema_version: self.schema.version, command }
        };
        let mut next = self.clone(); next.union(std::slice::from_ref(&op))?;
        let payload = encode(&Envelope { format: 1, scope: self.scope.clone(), operations: vec![op] })?;
        Ok(Prepared { expected: self.snapshot()?, next, payload })
    }
    /// In-memory CAS only. Adapters must independently commit their durable transaction.
    pub fn install(&mut self, prepared: Prepared) -> Result<()> {
        if self.snapshot()? != prepared.expected || encode(&self.schema)? != encode(&prepared.next.schema)?
            || self.scope != prepared.next.scope { return Err(Error::Stale); }
        // Prepared is inspectable but not trusted as an alternate mutation path.
        let mut next = self.clone(); next.receive(&prepared.payload)?;
        if next != prepared.next { return Err(Error::InvalidOperation); }
        *self = next;
        Ok(())
    }
}
