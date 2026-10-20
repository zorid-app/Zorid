//! Transaction-scoped, admitted reads of durable source-backed graph facts.
//!
//! Indexed absence relies on the publisher's maintained completeness invariant.
//! A positive row is never evidence by itself: regenerate its bounded source
//! from independent ledger/membership and compare its exact source ordinal.
use super::*;
use std::{collections::BTreeMap, sync::Arc};
use zorid_file_sync::{
    graph_facts::{SourceEvent, SourceFacts},
    Scope,
};
use zorid_sync_protocol::UpdateId;

const PAGE_ROWS: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Head {
    revision: Revision,
    records: u64,
    activities: u64,
    events: u64,
    entries: u64,
}

/// Work admission is supplied by the actual operation/read owner, not a new
/// independent resource pool. Source bytes are checked before source decoding;
/// retained event output is charged before cloning it out of its source.
pub(super) enum Work {
    Read,
    SourceBytes(u64),
    RetainBytes(u64),
}

pub(super) struct GraphSnapshot<'tx> {
    tx: &'tx Connection,
    store: zorid_core::OperationId,
    scope: Scope,
    head: Head,
}

fn corrupt(reason: &'static str) -> StoreError {
    StoreError::Corrupt(reason.into())
}

fn read_head(tx: &Connection, scope: &Scope) -> Result<Head> {
    let row: Option<(Option<String>, Option<i64>, Option<i64>, Option<i64>, Option<i64>)> = tx.query_row(
        "SELECT CASE WHEN typeof(h.revision)='text' AND length(CAST(h.revision AS BLOB)) BETWEEN 1 AND 128 AND s.revision=h.revision AND typeof(s.format)='integer' AND s.format=1 THEN h.revision END,CASE WHEN typeof(h.record_count)='integer' AND h.record_count>=0 AND typeof(s.record_count)='integer' AND s.record_count=h.record_count THEN h.record_count END,CASE WHEN typeof(h.activity_count)='integer' AND h.activity_count>=0 AND typeof(s.activity_count)='integer' AND s.activity_count=h.activity_count THEN h.activity_count END,CASE WHEN typeof(s.event_count)='integer' AND s.event_count>=0 THEN s.event_count END,CASE WHEN typeof(s.entry_count)='integer' AND s.entry_count>=0 THEN s.entry_count END FROM family_graph_heads h LEFT JOIN family_graph_state s USING(realm_id,vault_id) WHERE h.realm_id=?1 AND h.vault_id=?2",
        params![scope.realm_id.as_str(), scope.vault_id.as_str()],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    ).optional()?;
    let Some((Some(revision), Some(records), Some(activities), Some(events), Some(entries))) = row
    else {
        return Err(corrupt(
            "selected graph head/state is missing or contradictory",
        ));
    };
    Ok(Head {
        revision: Revision::new(revision).map_err(|_| corrupt("invalid graph revision"))?,
        records: records as u64,
        activities: activities as u64,
        events: events as u64,
        entries: entries as u64,
    })
}

impl<'tx> GraphSnapshot<'tx> {
    /// The borrowed connection must be the caller's actual pinned transaction.
    /// A self-consistent head for a foreign scope is not an admitted snapshot.
    pub(super) fn open(tx: &'tx Connection, scope: &Scope) -> Result<Self> {
        if tx.is_autocommit() {
            return Err(corrupt("graph reader requires an actual transaction"));
        }
        let identity = text_sync::identity(tx)?;
        if identity.realm_id.as_ref() != Some(&scope.realm_id)
            || identity.vault_id.as_ref() != Some(&scope.vault_id)
        {
            return Err(zorid_client_sync::SyncError::IdentityMismatch.into());
        }
        Ok(Self {
            tx,
            store: identity.local_store_id,
            scope: scope.clone(),
            head: read_head(tx, scope)?,
        })
    }

    pub(super) fn scope(&self) -> &Scope {
        &self.scope
    }
    pub(super) fn tx(&self) -> &Connection {
        self.tx
    }
    pub(super) fn revision(&self) -> &Revision {
        &self.head.revision
    }
    pub(super) fn record_count(&self) -> u64 { self.head.records }
    pub(super) fn activity_count(&self) -> u64 { self.head.activities }
    pub(super) fn source_count(&self) -> u64 {
        self.head.records + self.head.activities
    }
    pub(super) fn event_count(&self) -> u64 {
        self.head.events
    }
    pub(super) fn entry_count(&self) -> u64 {
        self.head.entries
    }

    pub(super) fn check_current(&self) -> Result<()> {
        if self.tx.is_autocommit() {
            return Err(corrupt("graph transaction has ended"));
        }
        let identity = text_sync::identity(self.tx)?;
        if identity.local_store_id != self.store
            || identity.realm_id.as_ref() != Some(&self.scope.realm_id)
            || identity.vault_id.as_ref() != Some(&self.scope.vault_id)
            || read_head(self.tx, &self.scope)? != self.head
        {
            return Err(zorid_client_sync::SyncError::VersionConflict.into());
        }
        Ok(())
    }

    pub(super) fn source(
        &self,
        id: &UpdateId,
        admit: &mut impl FnMut(Work) -> Result<()>,
    ) -> Result<SourceFacts> {
        admit(Work::Read)?;
        self.check_current()?;
        // Lengths are scalar reads, before any potentially large descriptor,
        // activity or ledger metadata allocation. Bodies are not selected.
        let sizes: Option<(Option<i64>, Option<i64>, Option<i64>, Option<i64>)> = self.tx.query_row(
            "SELECT length(CAST(p.descriptor AS BLOB)),(SELECT length(CAST(record AS BLOB)) FROM family_text_activities WHERE realm_id=p.realm_id AND vault_id=p.vault_id AND update_id=p.update_id),(SELECT length(CAST(metadata AS BLOB)) FROM authored_envelopes WHERE realm_id=p.realm_id AND vault_id=p.vault_id AND update_id=p.update_id),(SELECT length(CAST(metadata AS BLOB)) FROM sync_envelopes WHERE realm_id=p.realm_id AND vault_id=p.vault_id AND update_id=p.update_id) FROM immutable_payloads p WHERE p.realm_id=?1 AND p.vault_id=?2 AND p.update_id=?3",
            params![self.scope.realm_id.as_str(), self.scope.vault_id.as_str(), id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional()?;
        let Some((descriptor, activity, authored, received)) = sizes else {
            return Err(corrupt("expected graph source has no immutable payload"));
        };
        let mut bytes = 0_u64;
        for (size, limit) in [
            (
                descriptor,
                zorid_file_sync::metadata::MAX_GRAPH_RECORD_BYTES,
            ),
            (activity, zorid_sync_protocol::MAX_PLAINTEXT_BYTES),
            (authored, zorid_sync_protocol::MAX_PLAINTEXT_BYTES),
            (received, zorid_sync_protocol::MAX_PLAINTEXT_BYTES),
        ] {
            if let Some(size) = size {
                if size <= 0 || size as u64 > limit as u64 {
                    return Err(corrupt(
                        "graph source descriptor or metadata exceeds its bound",
                    ));
                }
                bytes = bytes
                    .checked_add(size as u64)
                    .ok_or_else(|| corrupt("graph source size overflow"))?;
            }
        }
        admit(Work::SourceBytes(bytes))?;
        let facts = family_graph::check_source(self.tx, &self.scope, id)?;
        self.check_current()?;
        Ok(facts)
    }

    /// A retained stage/quarantined payload is not graph membership. Conversely,
    /// an indexed source whose expected membership disappeared is corruption.
    pub(super) fn member(
        &self,
        id: &UpdateId,
        admit: &mut impl FnMut(Work) -> Result<()>,
    ) -> Result<Option<SourceFacts>> {
        admit(Work::Read)?;
        self.check_current()?;
        let (files, text, facts): (bool, bool, bool) = self.tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM family_file_records WHERE realm_id=?1 AND vault_id=?2 AND update_id=?3),EXISTS(SELECT 1 FROM family_text_activities WHERE realm_id=?1 AND vault_id=?2 AND update_id=?3),EXISTS(SELECT 1 FROM family_graph_sources WHERE realm_id=?1 AND vault_id=?2 AND source_id=?3)",
            params![self.scope.realm_id.as_str(), self.scope.vault_id.as_str(), id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        if (files && text) || facts != (files || text) {
            return Err(corrupt(
                "graph source membership and indexed ownership differ",
            ));
        }
        if !facts {
            return Ok(None);
        }
        self.source(id, admit).map(Some)
    }

    pub(super) fn event(
        &self,
        id: &UpdateId,
        admit: &mut impl FnMut(Work) -> Result<()>,
    ) -> Result<Option<SourceEvent>> {
        admit(Work::Read)?;
        self.check_current()?;
        let locator: Option<(Option<String>, Option<i64>)> = self.tx.query_row(
            "SELECT CASE WHEN typeof(source_id)='text' AND length(CAST(source_id AS BLOB)) BETWEEN 1 AND 128 THEN source_id END,CASE WHEN typeof(ordinal)='integer' AND ordinal BETWEEN 0 AND 127 THEN ordinal END FROM family_graph_events WHERE realm_id=?1 AND vault_id=?2 AND event_id=?3",
            params![self.scope.realm_id.as_str(), self.scope.vault_id.as_str(), id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        let Some((source, ordinal)) = locator else {
            return Ok(None);
        };
        let source = UpdateId::new(source.ok_or_else(|| corrupt("invalid graph source locator"))?)
            .map_err(|_| corrupt("invalid graph source locator"))?;
        let ordinal = ordinal.ok_or_else(|| corrupt("invalid graph event ordinal"))? as usize;
        let facts = self.source(&source, admit)?;
        let event = facts
            .events()
            .get(ordinal)
            .filter(|event| event.id() == id)
            .ok_or_else(|| corrupt("graph locator does not select its source event"))?;
        admit(Work::RetainBytes(encoded_size(event)?))?;
        Ok(Some(event.clone()))
    }

    pub(super) fn require_event(
        &self,
        id: &UpdateId,
        admit: &mut impl FnMut(Work) -> Result<()>,
    ) -> Result<SourceEvent> {
        self.event(id, admit)?
            .ok_or_else(|| corrupt("expected graph event is missing"))
    }

    /// Complete keyset traversal of one entry's source events, or the children
    /// of one causal parent. A full page is never reported as exhaustion.
    pub(super) fn events(
        &self,
        selector: &EventSelector,
        cursor: Option<&EventCursor>,
        admit: &mut impl FnMut(Work) -> Result<()>,
    ) -> Result<EventPage> {
        admit(Work::Read)?;
        self.check_current()?;
        let after = match cursor {
            Some(cursor)
                if cursor.scope == self.scope
                    && cursor.revision == self.head.revision
                    && cursor.selector == *selector =>
            {
                cursor.after.as_str()
            }
            Some(_) => {
                return Err(corrupt(
                    "graph event cursor belongs to another selector or head",
                ))
            }
            None => "",
        };
        let (sql, selected) = match selector {
            EventSelector::Entry(id) => ("SELECT CASE WHEN typeof(event_id)='text' AND length(CAST(event_id AS BLOB)) BETWEEN 1 AND 128 THEN event_id END FROM family_graph_events WHERE realm_id=?1 AND vault_id=?2 AND entry_id=?3 AND event_id>?4 ORDER BY event_id LIMIT 32", id.as_str()),
            EventSelector::Pending(id) => ("SELECT CASE WHEN typeof(event_id)='text' AND length(CAST(event_id AS BLOB)) BETWEEN 1 AND 128 THEN event_id END FROM family_graph_pending WHERE realm_id=?1 AND vault_id=?2 AND entry_id=?3 AND event_id>?4 ORDER BY event_id LIMIT 32", id.as_str()),
            EventSelector::Children(id) => ("SELECT CASE WHEN typeof(event_id)='text' AND length(CAST(event_id AS BLOB)) BETWEEN 1 AND 128 THEN event_id END FROM family_graph_parents WHERE realm_id=?1 AND vault_id=?2 AND parent_id=?3 AND event_id>?4 ORDER BY event_id LIMIT 32", id.as_str()),
        };
        let ids: Vec<Option<String>> = self
            .tx
            .prepare(sql)?
            .query_map(
                params![
                    self.scope.realm_id.as_str(),
                    self.scope.vault_id.as_str(),
                    selected,
                    after
                ],
                |row| row.get(0),
            )?
            .collect::<rusqlite::Result<_>>()?;
        let mut events = Vec::with_capacity(ids.len());
        let mut last = None;
        for id in ids {
            let id = UpdateId::new(id.ok_or_else(|| corrupt("invalid indexed graph event ID"))?)
                .map_err(|_| corrupt("invalid indexed graph event ID"))?;
            let event = self.require_event(&id, admit)?;
            let matches = match selector {
                EventSelector::Entry(id) | EventSelector::Pending(id) => {
                    &event.identity().entry_id == id
                }
                EventSelector::Children(id) => event.parents().contains(id),
            };
            if !matches {
                return Err(corrupt("graph event selector contradicts source event"));
            }
            last = Some(id);
            events.push(event);
        }
        self.check_current()?;
        let cursor = if events.len() == PAGE_ROWS {
            Some(EventCursor {
                scope: self.scope.clone(),
                revision: self.head.revision.clone(),
                selector: selector.clone(),
                after: last.ok_or_else(|| corrupt("full graph page lacks cursor"))?,
            })
        } else {
            None
        };
        Ok(EventPage { events, cursor })
    }

    pub(super) fn roles(
        &self,
        id: &UpdateId,
        cursor: Option<&RoleCursor>,
        admit: &mut impl FnMut(Work) -> Result<()>,
    ) -> Result<RolePage> {
        admit(Work::Read)?;
        self.check_current()?;
        let (after, ordinal) = match cursor {
            Some(cursor)
                if cursor.scope == self.scope
                    && cursor.revision == self.head.revision
                    && cursor.id == *id =>
            {
                (cursor.source.as_str(), cursor.ordinal as i64)
            }
            Some(_) => return Err(corrupt("graph role cursor belongs to another ID or head")),
            None => ("", -1),
        };
        let locators: Vec<(Option<String>, Option<i64>)> = self.tx.prepare(
            "SELECT CASE WHEN typeof(source_id)='text' AND length(CAST(source_id AS BLOB)) BETWEEN 1 AND 128 THEN source_id END,CASE WHEN typeof(ordinal)='integer' AND ordinal>=0 THEN ordinal END FROM family_graph_claims WHERE realm_id=?1 AND vault_id=?2 AND reserved_id=?3 AND (source_id>?4 OR (source_id=?4 AND ordinal>?5)) ORDER BY source_id,ordinal LIMIT 32",
        )?.query_map(params![self.scope.realm_id.as_str(), self.scope.vault_id.as_str(), id.as_str(), after, ordinal],
            |row| Ok((row.get(0)?, row.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
        // Reuse checked sources only inside this bounded page. Nothing survives
        // a graph revision, transaction, operation or arbitrary host turn.
        let mut checked = BTreeMap::new();
        let mut claims = Vec::with_capacity(locators.len());
        let mut last = None;
        for (source, ordinal) in locators {
            let source = UpdateId::new(source.ok_or_else(|| corrupt("invalid graph role source"))?)
                .map_err(|_| corrupt("invalid graph role source"))?;
            let ordinal =
                usize::try_from(ordinal.ok_or_else(|| corrupt("invalid graph role ordinal"))?)
                    .map_err(|_| corrupt("invalid graph role ordinal"))?;
            let facts = match checked.get(&source) {
                Some(facts) => Arc::clone(facts),
                None => {
                    let facts = Arc::new(self.source(&source, admit)?);
                    checked.insert(source.clone(), Arc::clone(&facts));
                    facts
                }
            };
            if facts
                .claims()
                .get(ordinal)
                .is_none_or(|claim| claim.id() != id)
            {
                return Err(corrupt(
                    "graph role locator contradicts checked source claim",
                ));
            }
            last = Some((source, ordinal));
            claims.push(CheckedRole { facts, ordinal });
        }
        self.check_current()?;
        let cursor = if claims.len() == PAGE_ROWS {
            let (source, ordinal) =
                last.ok_or_else(|| corrupt("full graph role page lacks cursor"))?;
            Some(RoleCursor {
                scope: self.scope.clone(),
                revision: self.head.revision.clone(),
                id: id.clone(),
                source,
                ordinal,
            })
        } else {
            None
        };
        Ok(RolePage { claims, cursor })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum EventSelector {
    Entry(EntryId),
    Pending(EntryId),
    Children(UpdateId),
}
pub(super) struct EventCursor {
    scope: Scope,
    revision: Revision,
    selector: EventSelector,
    after: UpdateId,
}
pub(super) struct EventPage {
    pub(super) events: Vec<SourceEvent>,
    pub(super) cursor: Option<EventCursor>,
}
pub(super) struct RoleCursor {
    scope: Scope,
    revision: Revision,
    id: UpdateId,
    source: UpdateId,
    ordinal: usize,
}
pub(super) struct CheckedRole {
    facts: Arc<SourceFacts>,
    ordinal: usize,
}
impl CheckedRole {
    pub(super) fn facts(&self) -> &SourceFacts {
        &self.facts
    }
    pub(super) fn ordinal(&self) -> usize {
        self.ordinal
    }
}
pub(super) struct RolePage {
    pub(super) claims: Vec<CheckedRole>,
    pub(super) cursor: Option<RoleCursor>,
}

fn encoded_size(value: &impl Serialize) -> Result<u64> {
    struct Counter(u64);
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self
                .0
                .checked_add(bytes.len() as u64)
                .ok_or_else(|| std::io::Error::other("graph output size overflow"))?;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter(0);
    serde_json::to_writer(&mut counter, value)?;
    Ok(counter.0)
}
