//! Fixed first-party service. Capabilities and continuations remain process objects.
use super::*;
#[path = "calendar.rs"]
pub mod calendar;
pub use calendar::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};
use zorid_records::{first_party as domain, Command as RecordCommand, Id, State};
use zorid_store::{
    ManagedCollection, ManagedCommit, ManagedRevision, ManagedSnapshot, ManagedTarget,
};

pub use zorid_records::first_party::Range as WorkBlockRange;
#[derive(Debug)]
pub enum WorkBlockError {
    Native(Error),
    Admission(ClientAdmissionError),
    Domain(zorid_records::Error),
    InvalidRequest,
    StaleSession,
    WindowChanged,
    CursorExpired,
    Limit,
    Codec,
}
impl From<Error> for WorkBlockError {
    fn from(e: Error) -> Self {
        Self::Native(e)
    }
}
impl From<zorid_store::StoreError> for WorkBlockError {
    fn from(e: zorid_store::StoreError) -> Self {
        Self::Native(e.into())
    }
}
impl From<ClientAdmissionError> for WorkBlockError {
    fn from(e: ClientAdmissionError) -> Self {
        Self::Admission(e)
    }
}
impl From<zorid_records::Error> for WorkBlockError {
    fn from(e: zorid_records::Error) -> Self {
        Self::Domain(e)
    }
}
impl WorkBlockError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Native(Error::Store(zorid_store::StoreError::Contract(
                zorid_core::ContractError::InvalidMutation { reason },
            ))) => match reason.as_str() {
                "stale managed revision" => "stale_revision",
                "managed local operation identity collision"
                | "managed operation already has another source" => "operation_collision",
                _ => "invalid_workblock",
            },
            Self::Domain(_) => "invalid_workblock",
            Self::Admission(_) => "client_not_admitted",
            Self::InvalidRequest => "invalid_request",
            Self::StaleSession => "stale_session",
            Self::WindowChanged => "window_changed",
            Self::CursorExpired => "cursor_expired",
            Self::Limit => "limit",
            _ => "workblock_failed",
        }
    }
    pub fn commit_uncertain(&self) -> bool {
        matches!(self, Self::Native(e) if !matches!(e, Error::Store(zorid_store::StoreError::Contract(_))))
    }
}
pub type WorkBlockResult<T> = std::result::Result<T, WorkBlockError>;

#[derive(Clone, Debug, Serialize, Deserialize)]
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
        expected_revision: ManagedRevision,
        range: WorkBlockRange,
    },
    Title {
        record: Id,
        generation: Id,
        operation: Id,
        expected_revision: ManagedRevision,
        #[serde(deserialize_with = "required_nullable_title")]
        title: Option<String>,
    },
    AddRef {
        record: Id,
        generation: Id,
        operation: Id,
        expected_revision: ManagedRevision,
        task: EntryId,
    },
    RemoveRef {
        record: Id,
        generation: Id,
        operation: Id,
        expected_revision: ManagedRevision,
        task: EntryId,
    },
    Delete {
        record: Id,
        generation: Id,
        operation: Id,
        expected_revision: ManagedRevision,
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
#[derive(Clone, Debug, Serialize)]
pub struct WorkBlockRangeCandidate {
    pub operation: Id,
    pub range: WorkBlockRange,
}
#[derive(Clone, Debug, Serialize)]
pub struct WorkBlockTitleCandidate {
    pub operation: Id,
    pub title: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkBlockValue {
    pub ranges: Vec<WorkBlockRangeCandidate>,
    pub titles: Vec<WorkBlockTitleCandidate>,
    pub task_refs: Vec<EntryId>,
}
#[derive(Clone, Debug, Serialize)]
pub struct WorkBlockRead {
    pub record: Id,
    pub generation: Id,
    pub revision: ManagedRevision,
    pub created: bool,
    pub deleted: bool,
    pub block: Option<WorkBlockValue>,
    pub unresolved: BTreeMap<String, String>,
}
#[derive(Clone, Debug, Serialize)]
pub struct WorkBlockWindowPage {
    pub blocks: Vec<WorkBlockRead>,
    pub cursor: Option<String>,
    pub incomplete: bool,
    pub watermark: String,
    pub scanned: u32,
    pub bytes: u32,
}
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum WorkBlockReply {
    Read(WorkBlockRead),
    Commit(ManagedCommit),
    Window(WorkBlockWindowPage),
    Changes(zorid_store::ManagedChangePage),
}
#[derive(Clone, PartialEq, Eq)]
struct WindowQuery {
    from: String,
    until: String,
    limit: u32,
    bytes: u32,
}
#[derive(Clone)]
struct WindowCursor {
    query: WindowQuery,
    after: String,
    watermark: String,
}
/// Not serializable or constructible by callers; tied to one process Store and lease.
pub struct WorkBlockSession {
    handle: ManagedCollection,
    lease: ClientLeaseRef,
    scope: FamilyScope,
    cursors: BTreeMap<String, WindowCursor>,
    order: VecDeque<String>,
    calendar_slots: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}
fn target(record: Id, generation: Id) -> ManagedTarget {
    ManagedTarget {
        record,
        generation,
        restores: None,
    }
}
fn restore(snapshot: &ManagedSnapshot) -> WorkBlockResult<State> {
    Ok(State::restore(domain::schema(), snapshot.state.as_bytes())?)
}
fn view(snapshot: ManagedSnapshot) -> WorkBlockResult<WorkBlockRead> {
    let state = restore(&snapshot)?;
    let p = state.projection()?;
    let block = domain::read(&state)?.map(|block| WorkBlockValue {
        ranges: block
            .ranges
            .into_iter()
            .map(|c| WorkBlockRangeCandidate {
                operation: c.operation,
                range: c.range,
            })
            .collect(),
        titles: block
            .titles
            .into_iter()
            .map(|(operation, title)| WorkBlockTitleCandidate { operation, title })
            .collect(),
        task_refs: block.task_refs.into_iter().collect(),
    });
    Ok(WorkBlockRead {
        record: snapshot.scope.record,
        generation: snapshot.scope.generation,
        revision: snapshot.revision,
        created: p.created,
        deleted: p.deleted,
        block,
        unresolved: snapshot.unresolved,
    })
}
#[cfg(any(
    target_os = "macos",
    target_os = "linux",
    target_os = "ios",
    target_os = "android"
))]
impl NativeVault {
    pub fn open_workblocks(&mut self, lease: &ClientLease) -> WorkBlockResult<WorkBlockSession> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        self.verify_client_lease(lease)?;
        let scope = self
            .store
            .family_status()?
            .scope
            .ok_or(WorkBlockError::StaleSession)?;
        let registration = domain::registration(
            Id::new(scope.realm_id.as_str())?,
            Id::new(scope.vault_id.as_str())?,
        )?;
        let handle = self
            .store
            .managed_register(&zorid_store::ManagedRegistration {
                realm: registration.realm,
                vault: registration.vault,
                owner: registration.owner,
                schema: registration.schema,
            })?;
        Ok(WorkBlockSession {
            handle,
            lease: lease.reference().clone(),
            scope,
            cursors: BTreeMap::new(),
            order: VecDeque::new(),
            calendar_slots: std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        })
    }
    pub fn execute_workblocks(
        &mut self,
        lease: &ClientLease,
        session: &mut WorkBlockSession,
        command: WorkBlockCommand,
    ) -> WorkBlockResult<WorkBlockReply> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        self.verify_client_lease(lease)?;
        if lease.reference() != &session.lease
            || self.store.family_status()?.scope.as_ref() != Some(&session.scope)
        {
            return Err(WorkBlockError::StaleSession);
        }
        // Also reauthorize the Store-bound handle for commands with no target access.
        self.store.managed_changes(&session.handle, "0", 1)?;
        use WorkBlockCommand::*;
        match command {
            Read { record, generation } => Ok(WorkBlockReply::Read(view(
                self.store
                    .managed_snapshot(&session.handle, &target(record, generation))?,
            )?)),
            Create {
                record,
                generation,
                operation,
                range,
                title,
            } => {
                let target = target(record, generation);
                // Derive the original empty witness, even after later changes or process reopen.
                let scope = zorid_records::Scope {
                    realm: Id::new(session.scope.realm_id.as_str())?,
                    vault: Id::new(session.scope.vault_id.as_str())?,
                    owner: Id::new(domain::OWNER)?,
                    collection: Id::new(domain::COLLECTION)?,
                    record: target.record.clone(),
                    generation: target.generation.clone(),
                    restores: None,
                };
                let empty = State::new(domain::schema(), scope)?;
                let digest = Sha256Digest::of(&empty.snapshot()?);
                let expected: ManagedRevision = serde_json::from_value(
                    serde_json::to_value(digest).map_err(|_| WorkBlockError::Codec)?,
                )
                .map_err(|_| WorkBlockError::Codec)?;
                Ok(WorkBlockReply::Commit(self.store.managed_apply(
                    &session.handle,
                    &target,
                    operation,
                    &expected,
                    domain::create(&range, title)?,
                )?))
            }
            Move {
                record,
                generation,
                operation,
                expected_revision,
                range,
            } => self.workblock_apply(
                session,
                target(record, generation),
                operation,
                expected_revision,
                domain::set_range(&range)?,
            ),
            Title {
                record,
                generation,
                operation,
                expected_revision,
                title,
            } => self.workblock_apply(
                session,
                target(record, generation),
                operation,
                expected_revision,
                domain::set_title(title)?,
            ),
            AddRef {
                record,
                generation,
                operation,
                expected_revision,
                task,
            } => self.workblock_apply(
                session,
                target(record, generation),
                operation,
                expected_revision,
                domain::add_task(&task),
            ),
            RemoveRef {
                record,
                generation,
                operation,
                expected_revision,
                task,
            } => {
                let target = target(record, generation);
                let snapshot = self.store.managed_snapshot(&session.handle, &target)?;
                let state = restore(&snapshot)?;
                let command = if let Some(old) = state.history().get(&operation) {
                    // Preserve original observed tags on exact semantic retry after later additions.
                    match &old.command {
                        RecordCommand::Patch(actions)
                            if actions.len() == 1
                                && matches!(&actions[0],zorid_records::Action::Remove{field,member,..}
                            if field.as_str()=="task_refs" && member.as_str()==task.as_str()) =>
                        {
                            old.command.clone()
                        }
                        _ => return Err(WorkBlockError::InvalidRequest),
                    }
                } else {
                    domain::remove_task(&state, &task)?
                };
                self.workblock_apply(session, target, operation, expected_revision, command)
            }
            Delete {
                record,
                generation,
                operation,
                expected_revision,
            } => self.workblock_apply(
                session,
                target(record, generation),
                operation,
                expected_revision,
                domain::delete(),
            ),
            Changes { after, limit } => Ok(WorkBlockReply::Changes(self.store.managed_changes(
                &session.handle,
                &after,
                limit,
            )?)),
            Window {
                from_ms,
                until_ms,
                limit,
                byte_limit,
                cursor,
            } => self.workblock_window(
                session,
                WindowQuery {
                    from: from_ms,
                    until: until_ms,
                    limit,
                    bytes: byte_limit,
                },
                cursor,
            ),
        }
    }
    fn workblock_apply(
        &mut self,
        session: &WorkBlockSession,
        target: ManagedTarget,
        operation: Id,
        expected: ManagedRevision,
        command: RecordCommand,
    ) -> WorkBlockResult<WorkBlockReply> {
        Ok(WorkBlockReply::Commit(self.store.managed_apply(
            &session.handle,
            &target,
            operation,
            &expected,
            command,
        )?))
    }
    fn workblock_watermark(&self, session: &WorkBlockSession) -> WorkBlockResult<String> {
        Ok(self.store.managed_watermark(&session.handle)?)
    }
    fn workblock_window(
        &mut self,
        session: &mut WorkBlockSession,
        query: WindowQuery,
        cursor: Option<String>,
    ) -> WorkBlockResult<WorkBlockReply> {
        if !(1..=64).contains(&query.limit) || query.bytes == 0 || query.bytes > 1024 * 1024 {
            return Err(WorkBlockError::Limit);
        }
        let window = domain::Window::new(&query.from, &query.until)?;
        let (mut after, watermark) = match cursor {
            Some(token) => {
                let cursor = session
                    .cursors
                    .get(&token)
                    .ok_or(WorkBlockError::CursorExpired)?;
                if cursor.query != query {
                    return Err(WorkBlockError::InvalidRequest);
                }
                (Some(cursor.after.clone()), cursor.watermark.clone())
            }
            None => (None, self.workblock_watermark(session)?),
        };
        self.workblock_fence(session, &watermark)?;
        let mut blocks = Vec::new();
        let mut scanned = 0;
        let mut bytes = 0usize;
        let mut eof = false;
        while scanned < query.limit {
            let page = self
                .store
                .managed_export(&session.handle, after.as_deref(), 1)?;
            let Some(snapshot) = page.records.into_iter().next() else {
                eof = true;
                break;
            };
            let size = serde_json::to_vec(&snapshot)
                .map_err(|_| WorkBlockError::Codec)?
                .len();
            if bytes + size > query.bytes as usize {
                if scanned == 0 {
                    return Err(WorkBlockError::Limit);
                }
                break;
            }
            bytes += size;
            scanned += 1;
            after = page.next;
            let state = restore(&snapshot)?;
            if let Some(block) = domain::read(&state)? {
                if window.intersects(&block)? {
                    blocks.push(view(snapshot)?);
                }
            }
        }
        self.workblock_fence(session, &watermark)?;
        let cursor = if eof {
            None
        } else {
            let after = after.ok_or(WorkBlockError::Codec)?;
            let existing = session
                .cursors
                .iter()
                .find(|(_, c)| c.after == after && c.query == query && c.watermark == watermark)
                .map(|(k, _)| k.clone());
            Some(match existing {
                Some(token) => token,
                None => {
                    let token = uuid::Uuid::new_v4().to_string();
                    if session.cursors.len() + session.calendar_slots.load(std::sync::atomic::Ordering::Relaxed) >= 8 {
                        if session.order.is_empty() { return Err(WorkBlockError::Limit); }
                        if let Some(old) = session.order.pop_front() {
                            session.cursors.remove(&old);
                        }
                    }
                    session.order.push_back(token.clone());
                    session.cursors.insert(
                        token.clone(),
                        WindowCursor {
                            query,
                            after,
                            watermark: watermark.clone(),
                        },
                    );
                    token
                }
            })
        };
        Ok(WorkBlockReply::Window(WorkBlockWindowPage {
            blocks,
            incomplete: cursor.is_some(),
            cursor,
            watermark,
            scanned,
            bytes: bytes as u32,
        }))
    }
    fn workblock_fence(&self, session: &WorkBlockSession, watermark: &str) -> WorkBlockResult<()> {
        if !self
            .store
            .managed_changes(&session.handle, watermark, 1)?
            .changes
            .is_empty()
        {
            return Err(WorkBlockError::WindowChanged);
        }
        Ok(())
    }
}

#[cfg(not(any(
    target_os = "macos",
    target_os = "linux",
    target_os = "ios",
    target_os = "android"
)))]
impl NativeVault {
    pub fn open_workblocks(&mut self, _: &ClientLease) -> WorkBlockResult<WorkBlockSession> {
        Err(WorkBlockError::Native(Error::Unsupported("platform")))
    }
    pub fn execute_workblocks(
        &mut self,
        _: &ClientLease,
        _: &mut WorkBlockSession,
        _: WorkBlockCommand,
    ) -> WorkBlockResult<WorkBlockReply> {
        Err(WorkBlockError::Native(Error::Unsupported("platform")))
    }
}
