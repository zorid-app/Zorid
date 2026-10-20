//! Durable graph facts maintained with immutable family membership.
//!
//! These tables are checked engine state, not a disposable query cache. Batch A
//! still uses the bounded reference planner to validate complete graph changes;
//! indexed delta planning is enabled only after every writer/read route migrates.
use super::family_ledger::{self, EnvelopeKey, EnvelopeMetadata, Family};
use super::*;
use zorid_file_sync::{
    graph_facts::{SourceFacts, SourceKind},
    metadata::{MetadataState, MetadataView},
    metadata_plan::MetadataPlan,
    v2::ContentBinding,
    EntryIdentity, EntryView, Liveness, Projection, Scope,
};
use zorid_sync_protocol::{RealmId, UpdateId, VaultId};

const FORMAT: i64 = 1;
const MAX_FACT_BYTES: usize = zorid_file_sync::MAX_STATE_BYTES;
pub(super) const SCHEMA: &[(&str, &str)] = &[
    ("family_graph_state", "CREATE TABLE family_graph_state (realm_id TEXT NOT NULL,vault_id TEXT NOT NULL,format INTEGER NOT NULL CHECK(format=1),revision TEXT NOT NULL,record_count INTEGER NOT NULL CHECK(record_count>=0),activity_count INTEGER NOT NULL CHECK(activity_count>=0),event_count INTEGER NOT NULL CHECK(event_count>=0),entry_count INTEGER NOT NULL CHECK(entry_count>=0),PRIMARY KEY(realm_id,vault_id),FOREIGN KEY(realm_id,vault_id) REFERENCES family_graph_heads(realm_id,vault_id))"),
    ("family_graph_sources", "CREATE TABLE family_graph_sources (realm_id TEXT NOT NULL,vault_id TEXT NOT NULL,source_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('events','page','chunk','text')),metadata TEXT NOT NULL,event_count INTEGER NOT NULL CHECK(event_count BETWEEN 0 AND 128),PRIMARY KEY(realm_id,vault_id,source_id),FOREIGN KEY(realm_id,vault_id) REFERENCES family_graph_state(realm_id,vault_id),FOREIGN KEY(realm_id,vault_id,source_id) REFERENCES immutable_payloads(realm_id,vault_id,update_id))"),
    ("family_graph_events", "CREATE TABLE family_graph_events (realm_id TEXT NOT NULL,vault_id TEXT NOT NULL,event_id TEXT NOT NULL,source_id TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 127),entry_id TEXT NOT NULL,bootstrap_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(realm_id,vault_id,event_id),UNIQUE(realm_id,vault_id,source_id,ordinal),FOREIGN KEY(realm_id,vault_id,source_id) REFERENCES family_graph_sources(realm_id,vault_id,source_id))"),
    ("family_graph_events_entry", "CREATE INDEX family_graph_events_entry ON family_graph_events(realm_id,vault_id,entry_id,event_id)"),
    ("family_graph_claims", "CREATE TABLE family_graph_claims (realm_id TEXT NOT NULL,vault_id TEXT NOT NULL,source_id TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>=0),reserved_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(realm_id,vault_id,source_id,ordinal),FOREIGN KEY(realm_id,vault_id,source_id) REFERENCES family_graph_sources(realm_id,vault_id,source_id))"),
    ("family_graph_claims_id", "CREATE INDEX family_graph_claims_id ON family_graph_claims(realm_id,vault_id,reserved_id,source_id,ordinal)"),
    ("family_graph_parents", "CREATE TABLE family_graph_parents (realm_id TEXT NOT NULL,vault_id TEXT NOT NULL,event_id TEXT NOT NULL,parent_id TEXT NOT NULL,entry_id TEXT NOT NULL,PRIMARY KEY(realm_id,vault_id,event_id,parent_id),FOREIGN KEY(realm_id,vault_id,event_id) REFERENCES family_graph_events(realm_id,vault_id,event_id))"),
    ("family_graph_parent_dependents", "CREATE INDEX family_graph_parent_dependents ON family_graph_parents(realm_id,vault_id,parent_id,event_id)"),
    ("family_graph_entries", "CREATE TABLE family_graph_entries (realm_id TEXT NOT NULL,vault_id TEXT NOT NULL,entry_id TEXT NOT NULL,record TEXT NOT NULL,binding TEXT,parent_key TEXT NOT NULL,name TEXT,liveness TEXT NOT NULL CHECK(liveness IN ('live','deleted','delete_conflict')),PRIMARY KEY(realm_id,vault_id,entry_id),FOREIGN KEY(realm_id,vault_id) REFERENCES family_graph_state(realm_id,vault_id))"),
    ("family_graph_siblings", "CREATE INDEX family_graph_siblings ON family_graph_entries(realm_id,vault_id,parent_key,name,liveness,entry_id)"),
    ("family_graph_entry_heads", "CREATE TABLE family_graph_entry_heads (realm_id TEXT NOT NULL,vault_id TEXT NOT NULL,entry_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('namespace','location','content')),event_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(realm_id,vault_id,entry_id,kind,event_id),FOREIGN KEY(realm_id,vault_id,entry_id) REFERENCES family_graph_entries(realm_id,vault_id,entry_id),FOREIGN KEY(realm_id,vault_id,event_id) REFERENCES family_graph_events(realm_id,vault_id,event_id))"),
    ("family_graph_pending", "CREATE TABLE family_graph_pending (realm_id TEXT NOT NULL,vault_id TEXT NOT NULL,event_id TEXT NOT NULL,entry_id TEXT NOT NULL,PRIMARY KEY(realm_id,vault_id,event_id),FOREIGN KEY(realm_id,vault_id,event_id) REFERENCES family_graph_events(realm_id,vault_id,event_id))"),
    ("family_graph_pending_entry", "CREATE INDEX family_graph_pending_entry ON family_graph_pending(realm_id,vault_id,entry_id,event_id)"),
    ("family_graph_sources_no_update", "CREATE TRIGGER family_graph_sources_no_update BEFORE UPDATE ON family_graph_sources BEGIN SELECT RAISE(ABORT,'graph source facts are immutable'); END"),
    ("family_graph_sources_no_delete", "CREATE TRIGGER family_graph_sources_no_delete BEFORE DELETE ON family_graph_sources BEGIN SELECT RAISE(ABORT,'graph source facts are immutable'); END"),
    ("family_graph_events_no_update", "CREATE TRIGGER family_graph_events_no_update BEFORE UPDATE ON family_graph_events BEGIN SELECT RAISE(ABORT,'graph event facts are immutable'); END"),
    ("family_graph_events_no_delete", "CREATE TRIGGER family_graph_events_no_delete BEFORE DELETE ON family_graph_events BEGIN SELECT RAISE(ABORT,'graph event facts are immutable'); END"),
    ("family_graph_claims_no_update", "CREATE TRIGGER family_graph_claims_no_update BEFORE UPDATE ON family_graph_claims BEGIN SELECT RAISE(ABORT,'graph role claims are immutable'); END"),
    ("family_graph_claims_no_delete", "CREATE TRIGGER family_graph_claims_no_delete BEFORE DELETE ON family_graph_claims BEGIN SELECT RAISE(ABORT,'graph role claims are immutable'); END"),
    ("family_graph_parents_no_update", "CREATE TRIGGER family_graph_parents_no_update BEFORE UPDATE ON family_graph_parents BEGIN SELECT RAISE(ABORT,'graph parent facts are immutable'); END"),
    ("family_graph_parents_no_delete", "CREATE TRIGGER family_graph_parents_no_delete BEFORE DELETE ON family_graph_parents BEGIN SELECT RAISE(ABORT,'graph parent facts are immutable'); END"),
];

fn corrupt(reason: &'static str) -> StoreError {
    StoreError::Corrupt(reason.into())
}
fn number(value: usize) -> Result<i64> {
    i64::try_from(value).map_err(|_| corrupt("graph fact count overflow"))
}
fn encode(value: &impl Serialize) -> Result<String> {
    let encoded = serde_json::to_string(value)?;
    if encoded.len() > MAX_FACT_BYTES {
        return Err(corrupt("graph fact exceeds bounded metadata"));
    }
    Ok(encoded)
}
fn kind(value: SourceKind) -> &'static str {
    match value {
        SourceKind::Events => "events",
        SourceKind::Page => "page",
        SourceKind::Chunk => "chunk",
        SourceKind::Text => "text",
    }
}
fn key(scope: &Scope, id: &UpdateId) -> EnvelopeKey {
    EnvelopeKey {
        realm_id: scope.realm_id.clone(),
        vault_id: scope.vault_id.clone(),
        update_id: id.clone(),
    }
}

/// Scalar consistency on ordinary reopen; this intentionally does not scrub
/// every historical source. Known schema/head contradictions still fail closed.
pub(super) fn check_current(tx: &Connection) -> Result<()> {
    storage_accounting::check_current(tx)?;
    let mismatch: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM family_graph_heads h LEFT JOIN family_graph_state s USING(realm_id,vault_id) WHERE s.realm_id IS NULL OR typeof(s.format)!='integer' OR s.format!=1 OR typeof(s.revision)!='text' OR length(CAST(s.revision AS BLOB)) NOT BETWEEN 1 AND 128 OR s.revision!=h.revision OR typeof(s.record_count)!='integer' OR s.record_count!=h.record_count OR typeof(s.activity_count)!='integer' OR s.activity_count!=h.activity_count OR typeof(s.event_count)!='integer' OR s.event_count<0 OR typeof(s.entry_count)!='integer' OR s.entry_count<0 UNION ALL SELECT 1 FROM family_graph_state s LEFT JOIN family_graph_heads h USING(realm_id,vault_id) WHERE h.realm_id IS NULL)", [], |row| row.get(0),
    )?;
    if mismatch {
        return Err(corrupt("durable graph head differs from membership"));
    }
    Ok(())
}

pub(super) fn initialize(tx: &Connection, scope: &Scope, revision: &Revision) -> Result<()> {
    tx.execute(
        "INSERT INTO family_graph_state VALUES(?1,?2,?3,?4,0,0,0,0)",
        params![
            scope.realm_id.as_str(),
            scope.vault_id.as_str(),
            FORMAT,
            revision.as_str()
        ],
    )?;
    Ok(())
}

fn checked_source(
    tx: &Connection,
    scope: &Scope,
    id: &UpdateId,
) -> Result<(EnvelopeMetadata, SourceFacts)> {
    let metadata = family_ledger::metadata_only(tx, &key(scope, id))?
        .ok_or_else(|| corrupt("graph fact source lacks independent ledger"))?
        .metadata;
    let facts = match metadata.family {
        Family::Files => SourceFacts::file(scope, id, &blob_index::file_record(tx, scope, id)?)?,
        Family::Text => SourceFacts::text(scope, &blob_index::activity(tx, scope, id)?)?,
        Family::Records => return Err(corrupt("managed record cannot supply file graph facts")),
    };
    if facts.scope() != scope || facts.source_id() != id {
        return Err(corrupt(
            "checked graph source labels differ from membership",
        ));
    }
    Ok((metadata, facts))
}

pub(super) fn insert_source(tx: &Connection, metadata: &EnvelopeMetadata, facts: &SourceFacts) -> Result<()> {
    let scope = facts.scope();
    let id = facts.source_id();
    if metadata.key != key(scope, id) {
        return Err(corrupt("graph fact source key differs from ledger"));
    }
    tx.execute(
        "INSERT INTO family_graph_sources VALUES(?1,?2,?3,?4,?5,?6)",
        params![
            scope.realm_id.as_str(),
            scope.vault_id.as_str(),
            id.as_str(),
            kind(facts.kind()),
            encode(metadata)?,
            number(facts.events().len())?,
        ],
    )?;
    for event in facts.events() {
        tx.execute(
            "INSERT INTO family_graph_events VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                scope.realm_id.as_str(),
                scope.vault_id.as_str(),
                event.id().as_str(),
                id.as_str(),
                i64::from(event.ordinal()),
                event.identity().entry_id.as_str(),
                event.identity().bootstrap_id.as_str(),
                encode(event)?,
            ],
        )?;
        for parent in event.parents() {
            tx.execute(
                "INSERT INTO family_graph_parents VALUES(?1,?2,?3,?4,?5)",
                params![
                    scope.realm_id.as_str(),
                    scope.vault_id.as_str(),
                    event.id().as_str(),
                    parent.as_str(),
                    event.identity().entry_id.as_str(),
                ],
            )?;
        }
    }
    for (ordinal, claim) in facts.claims().iter().enumerate() {
        tx.execute(
            "INSERT INTO family_graph_claims VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                scope.realm_id.as_str(),
                scope.vault_id.as_str(),
                id.as_str(),
                number(ordinal)?,
                claim.id().as_str(),
                encode(claim)?,
            ],
        )?;
    }
    Ok(())
}

/// A known source is checked against its independent ledger and membership,
/// then every indexed fact for that bounded source is compared in SQLite. No
/// untrusted large fact String is allocated merely to discover corruption.
pub(super) fn check_source(tx: &Connection, scope: &Scope, id: &UpdateId) -> Result<SourceFacts> {
    let (metadata, facts) = checked_source(tx, scope, id)?;
    let source_matches: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM family_graph_sources WHERE realm_id=?1 AND vault_id=?2 AND source_id=?3 AND kind=?4 AND metadata=?5 AND typeof(event_count)='integer' AND event_count=?6)",
        params![scope.realm_id.as_str(), scope.vault_id.as_str(), id.as_str(), kind(facts.kind()), encode(&metadata)?, number(facts.events().len())?], |row| row.get(0),
    )?;
    let event_count: i64 = tx.query_row("SELECT count(*) FROM family_graph_events WHERE realm_id=?1 AND vault_id=?2 AND source_id=?3",
        params![scope.realm_id.as_str(), scope.vault_id.as_str(), id.as_str()], |row| row.get(0))?;
    let claim_count: i64 = tx.query_row("SELECT count(*) FROM family_graph_claims WHERE realm_id=?1 AND vault_id=?2 AND source_id=?3",
        params![scope.realm_id.as_str(), scope.vault_id.as_str(), id.as_str()], |row| row.get(0))?;
    if !source_matches
        || event_count != number(facts.events().len())?
        || claim_count != number(facts.claims().len())?
    {
        return Err(corrupt(
            "graph source facts differ from checked ledger source",
        ));
    }
    for event in facts.events() {
        let matches: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM family_graph_events WHERE realm_id=?1 AND vault_id=?2 AND event_id=?3 AND source_id=?4 AND typeof(ordinal)='integer' AND ordinal=?5 AND entry_id=?6 AND bootstrap_id=?7 AND record=?8)",
            params![scope.realm_id.as_str(), scope.vault_id.as_str(), event.id().as_str(), id.as_str(), i64::from(event.ordinal()), event.identity().entry_id.as_str(), event.identity().bootstrap_id.as_str(), encode(event)?], |row| row.get(0))?;
        let parents: i64 = tx.query_row("SELECT count(*) FROM family_graph_parents WHERE realm_id=?1 AND vault_id=?2 AND event_id=?3",
            params![scope.realm_id.as_str(), scope.vault_id.as_str(), event.id().as_str()], |row| row.get(0))?;
        if !matches || parents != number(event.parents().len())? {
            return Err(corrupt(
                "graph event facts differ from checked source ordinal",
            ));
        }
        for parent in event.parents() {
            let matches: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM family_graph_parents WHERE realm_id=?1 AND vault_id=?2 AND event_id=?3 AND parent_id=?4 AND entry_id=?5)",
                params![scope.realm_id.as_str(), scope.vault_id.as_str(), event.id().as_str(), parent.as_str(), event.identity().entry_id.as_str()], |row| row.get(0))?;
            if !matches {
                return Err(corrupt(
                    "graph parent facts differ from checked source ordinal",
                ));
            }
        }
    }
    for (ordinal, claim) in facts.claims().iter().enumerate() {
        let matches: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM family_graph_claims WHERE realm_id=?1 AND vault_id=?2 AND source_id=?3 AND ordinal=?4 AND reserved_id=?5 AND record=?6)",
            params![scope.realm_id.as_str(), scope.vault_id.as_str(), id.as_str(), number(ordinal)?, claim.id().as_str(), encode(claim)?], |row| row.get(0))?;
        if !matches {
            return Err(corrupt("graph role claims differ from checked source"));
        }
    }
    Ok(facts)
}

#[derive(Serialize)]
struct EntryFact<'a> {
    identity: &'a EntryIdentity,
    kind: EntryKind,
    liveness: &'a Liveness,
    projection: &'a Projection,
}
fn entry_fact(entry: &EntryView) -> EntryFact<'_> {
    EntryFact {
        identity: &entry.identity,
        kind: entry.kind,
        liveness: &entry.liveness,
        projection: &entry.projection,
    }
}
fn liveness(entry: &EntryView) -> &'static str {
    match entry.liveness {
        Liveness::Live => "live",
        Liveness::Deleted => "deleted",
        Liveness::DeleteConflict => "delete_conflict",
    }
}
fn location(entry: &EntryView) -> (&str, Option<&str>) {
    entry.locations.last().map_or(("", None), |head| {
        (
            head.location.parent.as_ref().map_or("", |id| id.as_str()),
            Some(head.location.name.as_str()),
        )
    })
}
pub(super) fn check_entry(
    tx: &Connection,
    scope: &Scope,
    entry: &EntryView,
    binding: Option<&ContentBinding>,
) -> Result<()> {
    let id = &entry.identity.entry_id;
    let (parent, name) = location(entry);
    let matches: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM family_graph_entries WHERE realm_id=?1 AND vault_id=?2 AND entry_id=?3 AND record=?4 AND binding IS ?5 AND parent_key=?6 AND name IS ?7 AND liveness=?8)",
        params![scope.realm_id.as_str(), scope.vault_id.as_str(), id.as_str(), encode(&entry_fact(entry))?, binding.map(encode).transpose()?, parent, name, liveness(entry)], |row| row.get(0))?;
    let count: i64 = tx.query_row("SELECT count(*) FROM family_graph_entry_heads WHERE realm_id=?1 AND vault_id=?2 AND entry_id=?3",
        params![scope.realm_id.as_str(), scope.vault_id.as_str(), id.as_str()], |row| row.get(0))?;
    if !matches
        || count != number(entry.heads.len() + entry.locations.len() + entry.contents.len())?
    {
        return Err(corrupt(
            "graph entry facts differ from checked causal state",
        ));
    }
    for head in &entry.heads {
        check_head(tx, scope, id, "namespace", head, head)?;
    }
    for head in &entry.locations {
        check_head(tx, scope, id, "location", &head.event, head)?;
    }
    for head in &entry.contents {
        check_head(tx, scope, id, "content", &head.event, head)?;
    }
    Ok(())
}
fn check_head(
    tx: &Connection,
    scope: &Scope,
    id: &EntryId,
    kind: &str,
    event: &UpdateId,
    value: &impl Serialize,
) -> Result<()> {
    let matches: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM family_graph_entry_heads WHERE realm_id=?1 AND vault_id=?2 AND entry_id=?3 AND kind=?4 AND event_id=?5 AND record=?6)",
        params![scope.realm_id.as_str(), scope.vault_id.as_str(), id.as_str(), kind, event.as_str(), encode(value)?], |row| row.get(0))?;
    if !matches {
        return Err(corrupt("graph causal head differs from checked source"));
    }
    Ok(())
}
pub(super) fn write_entry(
    tx: &Connection,
    scope: &Scope,
    entry: &EntryView,
    binding: Option<&ContentBinding>,
) -> Result<()> {
    let id = &entry.identity.entry_id;
    let (parent, name) = location(entry);
    tx.execute("INSERT INTO family_graph_entries VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(realm_id,vault_id,entry_id) DO UPDATE SET record=excluded.record,binding=excluded.binding,parent_key=excluded.parent_key,name=excluded.name,liveness=excluded.liveness",
        params![scope.realm_id.as_str(), scope.vault_id.as_str(), id.as_str(), encode(&entry_fact(entry))?, binding.map(encode).transpose()?, parent, name, liveness(entry)])?;
    tx.execute(
        "DELETE FROM family_graph_entry_heads WHERE realm_id=?1 AND vault_id=?2 AND entry_id=?3",
        params![
            scope.realm_id.as_str(),
            scope.vault_id.as_str(),
            id.as_str()
        ],
    )?;
    for head in &entry.heads {
        write_head(tx, scope, id, "namespace", head, head)?;
    }
    for head in &entry.locations {
        write_head(tx, scope, id, "location", &head.event, head)?;
    }
    for head in &entry.contents {
        write_head(tx, scope, id, "content", &head.event, head)?;
    }
    Ok(())
}
fn write_head(
    tx: &Connection,
    scope: &Scope,
    id: &EntryId,
    kind: &str,
    event: &UpdateId,
    value: &impl Serialize,
) -> Result<()> {
    tx.execute(
        "INSERT INTO family_graph_entry_heads VALUES(?1,?2,?3,?4,?5,?6)",
        params![
            scope.realm_id.as_str(),
            scope.vault_id.as_str(),
            id.as_str(),
            kind,
            event.as_str(),
            encode(value)?
        ],
    )?;
    Ok(())
}

fn event_count(graph: &MetadataState) -> Result<i64> {
    let mut count = graph.activities().len();
    for record in graph.records().values() {
        if let zorid_file_sync::metadata::GraphRecordBody::Events { events }
        | zorid_file_sync::metadata::GraphRecordBody::ObservedDelete { events } = record.body()
        {
            count = count
                .checked_add(events.len())
                .ok_or_else(|| corrupt("graph event count overflow"))?;
        }
    }
    number(count)
}
fn check_expected_head(tx: &Connection, graph: &MetadataState, view: &MetadataView) -> Result<()> {
    let scope = graph.scope();
    let matches: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM family_graph_state WHERE realm_id=?1 AND vault_id=?2 AND format=?3 AND revision=?4 AND record_count=?5 AND activity_count=?6 AND event_count=?7 AND entry_count=?8)",
        params![scope.realm_id.as_str(), scope.vault_id.as_str(), FORMAT, graph.version().as_str(), number(graph.records().len())?, number(graph.activities().len())?, event_count(graph)?, number(view.namespace().entries.len())?], |row| row.get(0))?;
    if !matches {
        return Err(corrupt(
            "durable graph head differs from checked expected state",
        ));
    }
    Ok(())
}
fn set_head(
    tx: &Connection,
    graph: &MetadataState,
    view: &MetadataView,
    expected: &Revision,
) -> Result<()> {
    let scope = graph.scope();
    let changed = tx.execute("UPDATE family_graph_state SET revision=?1,record_count=?2,activity_count=?3,event_count=?4,entry_count=?5 WHERE realm_id=?6 AND vault_id=?7 AND format=?8 AND revision=?9",
        params![graph.version().as_str(), number(graph.records().len())?, number(graph.activities().len())?, event_count(graph)?, number(view.namespace().entries.len())?, scope.realm_id.as_str(), scope.vault_id.as_str(), FORMAT, expected.as_str()])?;
    if changed != 1 {
        return Err(corrupt("durable graph revision changed during publication"));
    }
    Ok(())
}
fn insert_pending(tx: &Connection, scope: &Scope, id: &UpdateId) -> Result<()> {
    let inserted = tx.execute(
        "INSERT INTO family_graph_pending SELECT realm_id,vault_id,event_id,entry_id FROM family_graph_events WHERE realm_id=?1 AND vault_id=?2 AND event_id=?3",
        params![
            scope.realm_id.as_str(),
            scope.vault_id.as_str(),
            id.as_str()
        ],
    )?;
    if inserted != 1 {
        return Err(corrupt("pending fact lacks its source-backed event"));
    }
    Ok(())
}

/// Every current writer still passes the existing reference plan in batch A.
/// Maintain only its appended sources/changed causal facts, within that writer;
/// this function is not an alternate planner or a publishable cache proof.
pub(super) fn maintain_legacy_plan(tx: &Connection, plan: &MetadataPlan) -> Result<()> {
    let old = plan.expected_state();
    let old_view = old.metadata_view()?;
    check_expected_head(tx, old, &old_view)?;
    let Some(next) = plan.next_state() else {
        return Ok(());
    };
    let scope = next.scope();
    for id in next
        .records()
        .keys()
        .filter(|id| !old.records().contains_key(*id))
    {
        let (metadata, facts) = checked_source(tx, scope, id)?;
        insert_source(tx, &metadata, &facts)?;
    }
    for id in next
        .activities()
        .keys()
        .filter(|id| !old.activities().contains_key(*id))
    {
        let (metadata, facts) = checked_source(tx, scope, id)?;
        insert_source(tx, &metadata, &facts)?;
    }
    let view = plan.metadata_view();
    for (id, before) in &old_view.namespace().entries {
        let after = view
            .namespace()
            .entries
            .get(id)
            .ok_or_else(|| corrupt("append removed checked graph identity"))?;
        let before_binding = old_view.content_bindings().get(id);
        let after_binding = view.content_bindings().get(id);
        if before != after || before_binding != after_binding {
            check_entry(tx, scope, before, before_binding)?;
            write_entry(tx, scope, after, after_binding)?;
        }
    }
    for (id, entry) in &view.namespace().entries {
        if !old_view.namespace().entries.contains_key(id) {
            let present: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM family_graph_entries WHERE realm_id=?1 AND vault_id=?2 AND entry_id=?3)",
                params![scope.realm_id.as_str(), scope.vault_id.as_str(), id.as_str()], |row| row.get(0))?;
            if present {
                return Err(corrupt("new graph identity already has indexed facts"));
            }
            write_entry(tx, scope, entry, view.content_bindings().get(id))?;
        }
    }
    for id in old_view
        .namespace()
        .pending
        .difference(&view.namespace().pending)
    {
        if tx.execute(
            "DELETE FROM family_graph_pending WHERE realm_id=?1 AND vault_id=?2 AND event_id=?3 AND entry_id=(SELECT entry_id FROM family_graph_events WHERE realm_id=?1 AND vault_id=?2 AND event_id=?3)",
            params![
                scope.realm_id.as_str(),
                scope.vault_id.as_str(),
                id.as_str()
            ],
        )? != 1
        {
            return Err(corrupt("resolved graph event lacks expected pending fact"));
        }
    }
    for id in view
        .namespace()
        .pending
        .difference(&old_view.namespace().pending)
    {
        insert_pending(tx, scope, id)?;
    }
    set_head(tx, next, view, old.version())
}

/// Complete bounded-reference comparison for migration and focused integrity
/// tests. Ordinary reopen and future indexed mutation do not call this scrub.
pub(super) fn audit_reference(tx: &Connection, graph: &MetadataState) -> Result<()> {
    let scope = graph.scope();
    let view = graph.metadata_view()?;
    check_expected_head(tx, graph, &view)?;
    let source_count: i64 = tx.query_row(
        "SELECT count(*) FROM family_graph_sources WHERE realm_id=?1 AND vault_id=?2",
        params![scope.realm_id.as_str(), scope.vault_id.as_str()],
        |row| row.get(0),
    )?;
    let indexed_events: i64 = tx.query_row(
        "SELECT count(*) FROM family_graph_events WHERE realm_id=?1 AND vault_id=?2",
        params![scope.realm_id.as_str(), scope.vault_id.as_str()],
        |row| row.get(0),
    )?;
    let entries: i64 = tx.query_row(
        "SELECT count(*) FROM family_graph_entries WHERE realm_id=?1 AND vault_id=?2",
        params![scope.realm_id.as_str(), scope.vault_id.as_str()],
        |row| row.get(0),
    )?;
    let pending: i64 = tx.query_row(
        "SELECT count(*) FROM family_graph_pending WHERE realm_id=?1 AND vault_id=?2",
        params![scope.realm_id.as_str(), scope.vault_id.as_str()],
        |row| row.get(0),
    )?;
    if source_count != number(graph.records().len() + graph.activities().len())?
        || indexed_events != event_count(graph)?
        || entries != number(view.namespace().entries.len())?
        || pending != number(view.namespace().pending.len())?
    {
        return Err(corrupt(
            "durable graph fact coverage differs from checked reference",
        ));
    }
    for id in graph.records().keys().chain(graph.activities().keys()) {
        check_source(tx, scope, id)?;
    }
    for (id, entry) in &view.namespace().entries {
        check_entry(tx, scope, entry, view.content_bindings().get(id))?;
    }
    for id in &view.namespace().pending {
        let found: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM family_graph_pending p JOIN family_graph_events e USING(realm_id,vault_id,event_id,entry_id) WHERE p.realm_id=?1 AND p.vault_id=?2 AND p.event_id=?3)",
            params![scope.realm_id.as_str(), scope.vault_id.as_str(), id.as_str()], |row| row.get(0))?;
        if !found {
            return Err(corrupt("pending graph fact differs from checked reference"));
        }
    }
    Ok(())
}

/// Pre-graph schemas12–15 are bounded by the existing reference contract. Build
/// facts under the migration writer and compare them before publishing schema16.
/// A rollback leaves original sources/membership/receipts/schema untouched.
pub(super) fn backfill(tx: &Connection) -> Result<()> {
    check_legacy_coverage(tx)?;
    let mut statement = tx.prepare("SELECT CASE WHEN typeof(realm_id)='text' AND length(CAST(realm_id AS BLOB)) BETWEEN 1 AND 128 THEN realm_id END,CASE WHEN typeof(vault_id)='text' AND length(CAST(vault_id AS BLOB)) BETWEEN 1 AND 128 THEN vault_id END FROM family_graph_heads ORDER BY realm_id,vault_id")?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let realm: Option<String> = row.get(0)?;
        let vault: Option<String> = row.get(1)?;
        let scope = Scope {
            realm_id: RealmId::new(realm.ok_or_else(|| corrupt("invalid legacy graph realm"))?)
                .map_err(|_| corrupt("invalid legacy graph realm"))?,
            vault_id: VaultId::new(vault.ok_or_else(|| corrupt("invalid legacy graph vault"))?)
                .map_err(|_| corrupt("invalid legacy graph vault"))?,
        };
        let graph = blob_index::load_metadata(tx, &scope)?
            .ok_or_else(|| corrupt("legacy graph head has no metadata"))?;
        let verified = blob_index::verify_metadata(tx, &graph, &[])?;
        family_materialization::validate(tx, &graph, &verified)?;
        let view = graph.metadata_view()?;
        initialize(tx, &scope, graph.version())?;
        for id in graph.records().keys().chain(graph.activities().keys()) {
            let (metadata, facts) = checked_source(tx, &scope, id)?;
            insert_source(tx, &metadata, &facts)?;
        }
        for (id, entry) in &view.namespace().entries {
            write_entry(tx, &scope, entry, view.content_bindings().get(id))?;
        }
        for id in &view.namespace().pending {
            insert_pending(tx, &scope, id)?;
        }
        set_head(tx, &graph, &view, graph.version())?;
        audit_reference(tx, &graph)?;
    }
    Ok(())
}

/// Migration must not bless membership omitted by the head enumeration. Legacy
/// Text-only enrollment predates the combined graph and legitimately has no
/// graph head; its actual Text binding distinguishes it from an empty combined
/// enrollment whose head has been removed. This traversal is migration-only.
fn check_legacy_coverage(tx: &Connection) -> Result<()> {
    let orphan: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM family_file_records m LEFT JOIN family_graph_heads h USING(realm_id,vault_id) LEFT JOIN immutable_payloads p ON p.realm_id=m.realm_id AND p.vault_id=m.vault_id AND p.update_id=m.update_id WHERE h.realm_id IS NULL OR p.update_id IS NULL UNION ALL SELECT 1 FROM family_text_activities m LEFT JOIN family_graph_heads h USING(realm_id,vault_id) LEFT JOIN immutable_payloads p ON p.realm_id=m.realm_id AND p.vault_id=m.vault_id AND p.update_id=m.update_id WHERE h.realm_id IS NULL OR p.update_id IS NULL)",
        [], |row| row.get(0),
    )?;
    if orphan {
        return Err(corrupt("legacy graph membership lacks head or source"));
    }
    let identity = text_sync::identity(tx)?;
    if let (Some(realm), Some(vault)) = (identity.realm_id, identity.vault_id) {
        let (heads, selected): (i64, bool) = tx.query_row(
            "SELECT (SELECT count(*) FROM family_graph_heads),EXISTS(SELECT 1 FROM family_graph_heads WHERE realm_id=?1 AND vault_id=?2)",
            params![realm.as_str(), vault.as_str()], |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if selected && heads == 1 {
            return Ok(());
        }
        if heads != 0 {
            return Err(corrupt("legacy graph head differs from enrolled scope"));
        }
        let (legacy_text, combined): (bool, bool) = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM text_bindings WHERE realm_id=?1 AND vault_id=?2),EXISTS(SELECT 1 FROM sync_envelopes UNION ALL SELECT 1 FROM authored_envelopes UNION ALL SELECT 1 FROM family_materializations UNION ALL SELECT 1 FROM family_materialization_history UNION ALL SELECT 1 FROM family_commands UNION ALL SELECT 1 FROM binary_stages)",
            params![realm.as_str(), vault.as_str()], |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if !legacy_text || combined {
            return Err(corrupt("legacy combined enrollment lacks graph head"));
        }
    } else {
        let head_exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM family_graph_heads)",
            [],
            |row| row.get(0),
        )?;
        if head_exists {
            return Err(corrupt("legacy graph head lacks enrolled authority"));
        }
    }
    Ok(())
}
