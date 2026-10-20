use super::*;
use serde_json::{json, Value};
use zorid_core::{Revision, VaultPath};

const BASE:&str="filters: file.ext == \"md\"\nviews:\n  - type: table\n    name: Table\n    order: [file.path, note.score]\n";
fn entry(id: &str, path: &str) -> EntryState {
    EntryState {
        id: EntryId::new(id).unwrap(),
        path: VaultPath::new(path).unwrap(),
        kind: EntryKind::File,
        revision: Revision::new("r1").unwrap(),
        deleted: false,
    }
}
fn builder(entries: Vec<EntryState>) -> WasmDocumentIndexBuilder {
    let versions: Value =
        serde_json::from_str(&crate::document_index::document_index_versions_json().unwrap())
            .unwrap();
    WasmDocumentIndexBuilder::new(&json!({"source":{"localStoreId":"store","watermark":"1"},"entries":entries,"expectedIndex":null,"nextIndex":{"localStoreId":"store","generationEpoch":"epoch","generation":"1","versions":versions}}).to_string()).unwrap()
}
fn owner() -> WasmDocumentPreviewOwner {
    WasmDocumentPreviewOwner::create("client", "owner").unwrap()
}
fn configure(b: &mut WasmDocumentIndexBuilder, o: &WasmDocumentPreviewOwner, nonce: &str) {
    b.preview =
        Some(PreviewProducer::create(b.builder.as_ref().unwrap(), o, nonce, "stage").unwrap());
}
fn add(b: &mut WasmDocumentIndexBuilder, id: &str, text: &str) {
    b.begin_pump().unwrap();
    b.add_text(id, text.as_bytes()).unwrap();
}
fn batch(b: &WasmDocumentIndexBuilder, ids: &[&str]) -> String {
    serde_json::to_string(
        &ids.iter()
            .map(|id| {
                let e = b
                    .builder
                    .as_ref()
                    .unwrap()
                    .record(&EntryId::new(*id).unwrap())
                    .unwrap()
                    .witness()
                    .entry();
                json!({"entry":e,"presentation":{"size":12,"ctimeMs":1,"mtimeMs":2}})
            })
            .collect::<Vec<_>>(),
    )
    .unwrap()
}
fn commit(b: &mut WasmDocumentIndexBuilder, ids: &[&str]) -> Result<()> {
    let raw = batch(b, ids);
    let core = b.builder.as_ref().unwrap();
    b.preview.as_mut().unwrap().commit(core, &raw)
}
fn capture(b: &mut WasmDocumentIndexBuilder) -> Result<WasmDocumentPreview> {
    let core = b.builder.as_ref().unwrap();
    b.preview.as_mut().unwrap().capture(core)
}
fn fixture() -> (
    WasmDocumentPreviewOwner,
    WasmDocumentIndexBuilder,
    WasmDocumentPreview,
) {
    let o = owner();
    let mut b = builder(vec![
        entry("definition", "View.base"),
        entry("a", "A.md"),
        entry("pending", "Pending.md"),
    ]);
    configure(&mut b, &o, "producer");
    add(&mut b, "definition", BASE);
    add(&mut b, "a", "---\nscore: 1\n---\n# A\n");
    commit(&mut b, &["definition", "a"]).unwrap();
    let p = capture(&mut b).unwrap();
    (o, b, p)
}
fn request(id: &str, options: Value) -> String {
    json!({"previewId":"1","id":id,"viewName":"Table","options":options}).to_string()
}
fn query(p: &WasmDocumentPreview) -> WasmDocumentPreviewQuery {
    p.begin(&request(
        "definition",
        json!({"clockMs":0,"timezone":"UTC"}),
    ))
    .unwrap()
}

#[test]
fn only_actual_committed_membership_can_be_captured_and_progress_stays_partial() {
    let (o, mut b, p) = fixture();
    let c = p.admitted().unwrap();
    assert_eq!(
        c.snapshot.progress(),
        PreviewProgress {
            prepared_files: 2,
            total_files: 3,
            pending_files: 1
        }
    );
    drop(c);
    add(&mut b, "pending", "new staged text");
    assert_eq!(capture(&mut b).err(), Some("index_invalid_request"));
    assert!(p.same_capture(&p));
    commit(&mut b, &["pending"]).unwrap();
    let next = capture(&mut b).unwrap();
    assert!(!p.same_capture(&p));
    assert_eq!(
        next.admitted().unwrap().snapshot.progress().pending_files,
        0
    );
    assert!(o.inner.pool.used.get() <= POOL);
}
#[test]
fn duplicate_unknown_or_wrong_revision_receipts_leave_bookkeeping_and_budget_unchanged() {
    let (o, mut b, _) = fixture();
    let before = o.inner.pool.used.get();
    let rows = b.preview.as_ref().unwrap().rows.len();
    assert_eq!(commit(&mut b, &["a"]), Err("index_invalid_request"));
    let mut raw: Value = serde_json::from_str(&batch(&b, &["a"])).unwrap();
    raw[0]["entry"]["revision"] = json!("foreign");
    assert_eq!(
        b.preview
            .as_mut()
            .unwrap()
            .commit(b.builder.as_ref().unwrap(), &raw.to_string()),
        Err("index_invalid_request")
    );
    raw[0]["entry"]["id"] = json!("unknown");
    assert_eq!(
        b.preview
            .as_mut()
            .unwrap()
            .commit(b.builder.as_ref().unwrap(), &raw.to_string()),
        Err("index_invalid_request")
    );
    assert_eq!(b.preview.as_ref().unwrap().rows.len(), rows);
    assert_eq!(o.inner.pool.used.get(), before);
}
#[test]
fn an_existing_prepared_builder_bootstraps_from_bounded_receipts_without_restoration() {
    let o = owner();
    let mut entries = vec![entry("definition", "View.base")];
    for n in 0..64 {
        entries.push(entry(&format!("n{n:02}"), &format!("N{n:02}.md")));
    }
    let mut b = builder(entries);
    add(&mut b, "definition", BASE);
    let names: Vec<String> = (0..64).map(|n| format!("n{n:02}")).collect();
    for name in &names {
        add(&mut b, name, "text");
    }
    configure(&mut b, &o, "late-producer");
    let mut all = vec!["definition"];
    all.extend(names.iter().map(String::as_str));
    let oversized = batch(&b, &all);
    assert_eq!(
        b.preview
            .as_mut()
            .unwrap()
            .commit(b.builder.as_ref().unwrap(), &oversized),
        Err("index_invalid_request")
    );
    for chunk in all.chunks(32) {
        commit(&mut b, chunk).unwrap();
    }
    let p = capture(&mut b).unwrap();
    assert_eq!(p.admitted().unwrap().snapshot.progress().prepared_files, 65);
    assert_eq!(b.builder.as_ref().unwrap().prepared_records(), 65);
}
#[test]
fn equal_scalar_capture_stamps_never_alias_private_backing() {
    let (a, _, pa) = fixture();
    let (b, _, pb) = fixture();
    let ca = pa.admitted().unwrap();
    let cb = pb.admitted().unwrap();
    assert_eq!(
        control_json(&descriptor(&ca)).unwrap(),
        control_json(&descriptor(&cb)).unwrap()
    );
    assert!(!pa.same_capture(&pb));
    assert!(!ca.snapshot.same_capture(&cb.snapshot));
    drop(ca);
    drop(cb);
    assert!(a.inner.latest.borrow().is_some());
    assert!(b.inner.latest.borrow().is_some());
}
#[test]
fn retiring_a_different_producer_with_equal_labels_does_not_retire_the_actual_latest() {
    let (o, mut a, old) = fixture();
    let mut b = builder(vec![
        entry("definition", "View.base"),
        entry("a", "A.md"),
        entry("pending", "Pending.md"),
    ]);
    configure(&mut b, &o, "producer");
    add(&mut b, "definition", BASE);
    add(&mut b, "a", "text");
    commit(&mut b, &["definition", "a"]).unwrap();
    let latest = capture(&mut b).unwrap();
    assert!(!old.same_capture(&old));
    a.preview.take().unwrap().retire();
    assert!(latest.same_capture(&latest));
}
#[test]
fn final_unpublished_capture_survives_builder_finish_and_free_until_explicit_stage_retirement() {
    let o = owner();
    let mut b = builder(vec![entry("definition", "View.base")]);
    configure(&mut b, &o, "producer");
    add(&mut b, "definition", BASE);
    commit(&mut b, &["definition"]).unwrap();
    let p = capture(&mut b).unwrap();
    let full = p.admitted().unwrap().snapshot.retention().total_bytes();
    let generation = b.finish().unwrap();
    drop(generation);
    drop(b);
    assert!(p.same_capture(&p));
    assert!(o.inner.pool.used.get() >= full);
    o.retire_stage("stage").unwrap();
    assert!(!p.same_capture(&p));
}
#[test]
fn real_rust_query_preserves_partial_classification_and_complete_transport_envelope() {
    let (_o, _b, p) = fixture();
    let q = query(&p);
    let reply = q.prepare(BASE.as_bytes()).unwrap();
    let mut bytes = Vec::new();
    reply.write(&mut bytes).unwrap();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(bytes.len(), reply.length);
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["op"], "preview_base");
    assert_eq!(value["value"]["previewId"], "1");
    assert_eq!(value["value"]["definition"]["id"], "definition");
    let result = &value["value"]["result"];
    assert_eq!(result["status"], "indexing");
    assert_eq!(result["complete"], false);
    assert_eq!(result["aggregatesComplete"], false);
    assert_eq!(result["countsScope"], "preparedSubset");
    assert_eq!(result["relationshipsAvailable"], false);
    assert_eq!(result["metadataComplete"], false);
    assert_eq!(result["progress"]["pendingFiles"], 1);
    assert_eq!(result["rows"].as_array().unwrap().len(), 1);
    assert_eq!(result["rows"][0]["path"], "A.md");
    assert!(value["value"].get("snapshotId").is_none());
    assert!(result.get("snapshotId").is_none());
}
#[test]
fn pending_context_wrong_text_and_unknown_view_fail_explicitly() {
    let (_o, _b, p) = fixture();
    assert_eq!(
        p.begin(&request("pending", json!({}))).err().is_some(),
        true
    );
    let q = query(&p);
    let mut wrong = BASE.as_bytes().to_vec();
    wrong[0] = b'x';
    assert_eq!(q.prepare(&wrong).err(), Some("index_source_changed"));
    let context = p
        .begin(&request("definition", json!({"currentEntryId":"pending"})))
        .unwrap();
    assert_eq!(
        context.prepare(BASE.as_bytes()).err(),
        Some("index_preview_not_ready")
    );
    let bad = p
        .begin(
            &json!({"previewId":"1","id":"definition","viewName":"absent","options":{}})
                .to_string(),
        )
        .unwrap();
    assert_eq!(
        bad.prepare(BASE.as_bytes()).err(),
        Some("index_view_not_found")
    );
    for preview_id in ["0", "01", "18446744073709551616"] {
        assert!(p
            .begin(&json!({"previewId":preview_id,"id":"definition"}).to_string())
            .is_err());
    }
}
#[test]
fn old_backing_and_weak_control_charges_survive_until_their_actual_guards_drop() {
    let (o, mut b, p) = fixture();
    let q = query(&p);
    let reply = q.prepare(BASE.as_bytes()).unwrap();
    let weak = p._charge.bytes.get();
    let query_charge = q.inner._charge.bytes.get();
    let full = q.inner.capture.snapshot.retention().total_bytes();
    let next = capture(&mut b).unwrap();
    assert!(!p.same_capture(&p));
    assert!(o.inner.pool.used.get() >= query_charge + full + weak);
    let mut target = Vec::new();
    assert_eq!(reply.write(&mut target), Err("index_preview_expired"));
    assert!(target.is_empty());
    drop(reply);
    drop(q);
    drop(b);
    o.inner.retire_latest();
    drop(next);
    let before = o.inner.pool.used.get();
    drop(p);
    assert_eq!(before - o.inner.pool.used.get(), weak);
    assert_eq!(o.inner.pool.used.get(), o.inner._charge.bytes.get());
}
#[test]
fn counted_whole_envelope_limit_and_cancel_prevent_partial_success() {
    let (_o, _b, p) = fixture();
    let q = query(&p);
    let reply = q.prepare(BASE.as_bytes()).unwrap();
    let check = || q.inner.active();
    let mut exact = Count {
        bytes: 0,
        maximum: reply.length,
        check: &check,
    };
    reply.write(&mut exact).unwrap();
    assert_eq!(exact.bytes, reply.length);
    let mut short = Count {
        bytes: 0,
        maximum: reply.length - 1,
        check: &check,
    };
    assert_eq!(reply.write(&mut short), Err("index_output_limit"));
    assert!(short.bytes < reply.length);
    q.cancel();
    let mut bytes = Vec::new();
    assert_eq!(reply.write(&mut bytes), Err("index_preview_expired"));
    assert!(bytes.is_empty());
}
#[test]
fn all_queries_share_the_one_owner_allowance_and_tighten_to_remaining_bytes() {
    let (o, _b, p) = fixture();
    let before = o.inner.pool.used.get();
    let mut queries = Vec::new();
    let mut refused = false;
    for _ in 0..8 {
        match p.begin(&request("definition", json!({}))) {
            Ok(q) => {
                assert!(q.inner._charge.bytes.get() <= QUERY);
                assert!(q.inner.owned_limit + 2 * q.inner.encoded_limit <= q.inner._charge.bytes.get());
                queries.push(q);
            }
            Err(code) => {
                assert_eq!(code, "index_preview_resource");
                refused = true;
                break;
            }
        }
    }
    assert!(refused);
    assert!(queries.iter().any(|q| q.inner._charge.bytes.get() < QUERY));
    assert!(o.inner.pool.used.get() <= POOL);
    drop(queries);
    assert_eq!(o.inner.pool.used.get(), before);
}
#[test]
fn owner_retirement_during_a_borrowed_output_rejects_the_handoff() {
    struct Retire<'a> {
        owner: &'a WasmDocumentPreviewOwner,
        bytes: usize,
    }
    impl Write for Retire<'_> {
        fn write(&mut self, input: &[u8]) -> io::Result<usize> {
            self.bytes += input.len();
            self.owner.inner.retire_latest();
            Ok(input.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let (o, _b, p) = fixture();
    let q = query(&p);
    let reply = q.prepare(BASE.as_bytes()).unwrap();
    let mut sink = Retire {
        owner: &o,
        bytes: 0,
    };
    assert_eq!(reply.write(&mut sink), Err("index_preview_expired"));
    assert!(sink.bytes > 0);
    assert!(!p.same_capture(&p));
}
#[test]
fn repeated_queries_over_a_large_pending_namespace_use_only_the_prepared_capture() {
    let o = owner();
    let mut entries = Vec::with_capacity(100_000);
    entries.push(entry("definition", "View.base"));
    for n in 0..99_999 {
        entries.push(entry(&format!("n{n:05}"), &format!("N{n:05}.md")));
    }
    let mut b = builder(entries);
    configure(&mut b, &o, "large-producer");
    add(&mut b, "definition", BASE);
    let names: Vec<String> = (0..127).map(|n| format!("n{n:05}")).collect();
    for name in &names {
        add(&mut b, name, "text");
    }
    let mut all = vec!["definition"];
    all.extend(names.iter().map(String::as_str));
    for chunk in all.chunks(32) {
        commit(&mut b, chunk).unwrap();
    }
    let p = capture(&mut b).unwrap();
    drop(b);
    let capture = p.admitted().unwrap();
    assert_eq!(capture.entries.len(), 128);
    assert_eq!(capture.facts.len(), 128);
    assert_eq!(capture.source_bytes.len(), 128);
    assert_eq!(capture.snapshot.progress().total_files, 100_000);
    drop(capture);
    for _ in 0..3 {
        let q = query(&p);
        let reply = q.prepare(BASE.as_bytes()).unwrap();
        assert_eq!(reply.result.rows.len(), 127);
        assert_eq!(reply.result.progress.prepared_files, 128);
        assert_eq!(reply.result.progress.pending_files, 99_872);
        assert!(reply.length < RESPONSE);
    }
}
