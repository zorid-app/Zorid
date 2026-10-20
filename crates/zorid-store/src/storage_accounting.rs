//! Transactionally maintained local source/fence usage, not source authority.
//! Full comparison is migration/explicit integrity work. Ordinary allocation
//! checks scalar state and indexed high-water marks rather than the corpus.
use super::*;

pub(super) const PAYLOAD_SCHEMA: &[(&str, &str)] = &[
    ("family_graph_payload_usage", "CREATE TABLE family_graph_payload_usage (singleton INTEGER PRIMARY KEY CHECK(singleton=1),records INTEGER NOT NULL CHECK(typeof(records)='integer' AND records>=0),bytes INTEGER NOT NULL CHECK(typeof(bytes)='integer' AND bytes>=0),CHECK((records=0)=(bytes=0)))"),
    ("family_graph_payload_usage_insert", "CREATE TRIGGER family_graph_payload_usage_insert AFTER INSERT ON immutable_payloads BEGIN SELECT CASE WHEN typeof(NEW.payload)!='blob' THEN RAISE(ABORT,'immutable payload accounting requires exact bytes') END; UPDATE family_graph_payload_usage SET records=records+1,bytes=bytes+length(NEW.payload) WHERE singleton=1; SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'immutable payload usage is missing') END; END"),
    ("family_graph_payload_usage_delete", "CREATE TRIGGER family_graph_payload_usage_delete AFTER DELETE ON immutable_payloads BEGIN UPDATE family_graph_payload_usage SET records=records-1,bytes=bytes-length(OLD.payload) WHERE singleton=1; SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'immutable payload usage is missing') END; END"),
];
pub(super) const REVISION_SCHEMA: &[(&str, &str)] = &[
    ("family_graph_revision_usage", "CREATE TABLE family_graph_revision_usage (singleton INTEGER PRIMARY KEY CHECK(singleton=1),records INTEGER NOT NULL CHECK(typeof(records)='integer' AND records>=0),highest INTEGER NOT NULL CHECK(typeof(highest)='integer' AND highest>=0),CHECK(records<=highest))"),
    ("family_graph_revision_usage_insert", "CREATE TRIGGER family_graph_revision_usage_insert AFTER INSERT ON revision_fences BEGIN UPDATE family_graph_revision_usage SET records=records+1,highest=NEW.ordinal WHERE singleton=1 AND records=highest AND highest+1=NEW.ordinal; SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'revision allocation usage differs from inserted ordinal') END; END"),
    ("family_graph_revision_usage_delete", "CREATE TRIGGER family_graph_revision_usage_delete AFTER DELETE ON revision_fences BEGIN UPDATE family_graph_revision_usage SET records=records-1 WHERE singleton=1; SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'revision allocation usage is missing') END; END"),
];

pub(super) fn schema() -> impl DoubleEndedIterator<Item = &'static (&'static str, &'static str)> {
    PAYLOAD_SCHEMA.iter().chain(REVISION_SCHEMA)
}

fn corrupt(reason: &'static str) -> StoreError {
    StoreError::Corrupt(reason.into())
}

/// Exactly once inside current-format initialization or the schema16 writer.
/// Existing immutable sources may include unpublished/quarantined/staged rows;
/// accounting includes all of them without manufacturing graph membership.
pub(super) fn initialize_payloads(tx: &Connection) -> Result<()> {
    check_payload_shapes(tx)?;
    tx.execute(
        "INSERT INTO family_graph_payload_usage SELECT 1,count(*),coalesce(sum(length(payload)),0) FROM immutable_payloads", [],
    )?;
    payload_usage(tx)?;
    Ok(())
}

fn check_payload_shapes(tx: &Connection) -> Result<()> {
    let invalid: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM immutable_payloads WHERE typeof(payload)!='blob' OR length(payload) NOT BETWEEN 1 AND CASE WHEN family='text' THEN 8388608 ELSE 1048576 END OR length(payload)!=payload_bytes)",
        [], |row| row.get(0),
    )?;
    if invalid {
        return Err(corrupt(
            "retained payload accounting source has invalid byte shape",
        ));
    }
    Ok(())
}

pub(super) fn initialize_revisions(tx: &Connection) -> Result<()> {
    let (records, highest, allocated): (i64, i64, i64) = tx.query_row(
        "SELECT (SELECT count(*) FROM revision_fences),(SELECT coalesce(max(ordinal),0) FROM revision_fences),(SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name='revision_fences'),0))",
        [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    if records < 0 || records != highest || highest != allocated {
        return Err(corrupt("revision allocation history has a gap"));
    }
    tx.execute(
        "INSERT INTO family_graph_revision_usage VALUES(1,?1,?2)",
        params![records, highest],
    )?;
    check_revisions(tx)
}

fn payload_usage(tx: &Connection) -> Result<(u64, u64)> {
    let value: Option<(Option<i64>, Option<i64>)> = tx.query_row(
        "SELECT CASE WHEN typeof(records)='integer' AND records>=0 THEN records END,CASE WHEN typeof(bytes)='integer' AND bytes>=0 THEN bytes END FROM family_graph_payload_usage WHERE singleton=1",
        [], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    let Some((Some(records), Some(bytes))) = value else {
        return Err(corrupt("immutable payload usage is missing or malformed"));
    };
    if (records == 0) != (bytes == 0) || bytes < records {
        return Err(corrupt("immutable payload usage is contradictory"));
    }
    Ok((records as u64, bytes as u64))
}

pub(super) fn payload_bytes(tx: &Connection) -> Result<u64> {
    payload_usage(tx).map(|(_, bytes)| bytes)
}

pub(super) fn check_revisions(tx: &Connection) -> Result<()> {
    let state: Option<(Option<i64>, Option<i64>, i64, i64)> = tx.query_row(
        "SELECT CASE WHEN typeof(records)='integer' AND records>=0 THEN records END,CASE WHEN typeof(highest)='integer' AND highest>=0 THEN highest END,(SELECT coalesce(max(ordinal),0) FROM revision_fences),(SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name='revision_fences'),0)) FROM family_graph_revision_usage WHERE singleton=1",
        [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).optional()?;
    let Some((Some(records), Some(highest), actual, allocated)) = state else {
        return Err(corrupt("revision allocation usage is missing or malformed"));
    };
    if records != highest || highest != actual || highest != allocated {
        return Err(corrupt("revision allocation history has a gap"));
    }
    Ok(())
}

pub(super) fn check_current(tx: &Connection) -> Result<()> {
    payload_usage(tx)?;
    check_revisions(tx)
}

/// Explicit integrity comparison. Never used to prepare an ordinary mutation,
/// list/status, pin/range read or current-format Store reopen.
pub(super) fn audit(tx: &Connection) -> Result<()> {
    check_payload_shapes(tx)?;
    let expected = payload_usage(tx)?;
    let actual: (i64, i64) = tx.query_row(
        "SELECT count(*),coalesce(sum(length(payload)),0) FROM immutable_payloads",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if actual.0 < 0 || actual.1 < 0 || expected != (actual.0 as u64, actual.1 as u64) {
        return Err(corrupt(
            "immutable payload usage differs from retained sources",
        ));
    }
    check_revisions(tx)?;
    let actual: i64 = tx.query_row("SELECT count(*) FROM revision_fences", [], |row| row.get(0))?;
    let expected: i64 = tx.query_row(
        "SELECT records FROM family_graph_revision_usage WHERE singleton=1",
        [],
        |row| row.get(0),
    )?;
    if actual != expected {
        return Err(corrupt("revision usage differs from retained fences"));
    }
    Ok(())
}
