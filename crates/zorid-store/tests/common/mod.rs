//! Test-only recreation of the historical v5 layout. Current stores have only
//! local commands in these fixtures; no managed text may be silently downgraded.
pub fn downgrade_v6_to_v5(db: &rusqlite::Connection) {
    let managed: i64 = db
        .query_row("SELECT count(*) FROM text_bindings", [], |r| r.get(0))
        .unwrap();
    assert_eq!(managed, 0);
    db.execute_batch("CREATE TABLE projection_queue (sequence INTEGER PRIMARY KEY REFERENCES operations(sequence));
    INSERT INTO projection_queue SELECT o.sequence FROM operations o JOIN projection_jobs j ON json_extract(j.record,'$.origin.operation_id')=o.operation_id WHERE j.completed=0;
    UPDATE projection_attempts SET record=json_remove(record,'$.covered_jobs');
    DROP INDEX active_directory_projection;
    ALTER TABLE directory_attempts RENAME TO directory_attempts_v6;
    CREATE TABLE directory_attempts (attempt_id TEXT PRIMARY KEY NOT NULL, entry_id TEXT NOT NULL REFERENCES entries(id), operation_id TEXT NOT NULL REFERENCES operations(operation_id), completed INTEGER NOT NULL CHECK(completed IN (0,1)), record TEXT NOT NULL);
    CREATE UNIQUE INDEX active_directory_projection ON directory_attempts(entry_id) WHERE completed = 0;
    INSERT INTO directory_attempts SELECT d.attempt_id,d.entry_id,o.operation_id,d.completed,json_set(json_remove(d.record,'$.job_id','$.origin'),'$.operation_id',o.operation_id,'$.sequence',cast(o.sequence AS TEXT)) FROM directory_attempts_v6 d JOIN projection_jobs j ON j.job_id=d.job_id JOIN operations o ON o.operation_id=json_extract(j.record,'$.origin.operation_id');
    DROP TABLE directory_attempts_v6;
    DROP TABLE IF EXISTS namespace_member_progress;
    DROP TABLE IF EXISTS namespace_members;
    DROP TABLE IF EXISTS namespace_attempts;
    DROP TABLE projection_jobs;
    DROP TABLE revision_fences;
    DROP TABLE checkpoint_heads; DROP TABLE checkpoint_revisions;
    DROP TABLE text_bindings; DROP TABLE text_revisions; DROP TABLE sync_updates; DROP TABLE authored_text; DROP TABLE receive_cursors; DROP TABLE authority_identity;
    PRAGMA user_version=5;").unwrap();
}
