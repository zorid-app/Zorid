use super::*;
use crate::{plan_file_content_mutation, plan_file_materialization, plan_mutation, OperationId};
use std::ops::Bound::{Excluded, Included, Unbounded};

#[derive(Debug, PartialEq, Eq)]
enum ReaderError {
    Contract(ContractError),
    Admission,
    Source,
}
impl From<ContractError> for ReaderError {
    fn from(error: ContractError) -> Self {
        Self::Contract(error)
    }
}

struct Reader {
    ids: BTreeMap<EntryId, EntryState>,
    paths: BTreeMap<String, EntryState>,
    revisions: BTreeSet<Revision>,
    admissions: Vec<IndexedMutationWork>,
    reads: Vec<String>,
    reject_at: Option<usize>,
    source_failure: bool,
    bad_id: bool,
    bad_path: bool,
    bad_cursor: bool,
    repeat_cursor: bool,
    hide_target_path: bool,
}

impl Reader {
    fn new(entries: &[EntryState]) -> Self {
        Self {
            ids: entries
                .iter()
                .cloned()
                .map(|entry| (entry.id.clone(), entry))
                .collect(),
            paths: entries
                .iter()
                .filter(|entry| !entry.deleted)
                .cloned()
                .map(|entry| (entry.path.as_str().to_owned(), entry))
                .collect(),
            revisions: entries.iter().map(|entry| entry.revision.clone()).collect(),
            admissions: Vec::new(),
            reads: Vec::new(),
            reject_at: None,
            source_failure: false,
            bad_id: false,
            bad_path: false,
            bad_cursor: false,
            repeat_cursor: false,
            hide_target_path: false,
        }
    }
    fn record(&mut self, selector: String) -> Result<(), ReaderError> {
        assert_eq!(self.admissions.last(), Some(&IndexedMutationWork::Read));
        self.reads.push(selector);
        if self.source_failure {
            Err(ReaderError::Source)
        } else {
            Ok(())
        }
    }
}

impl IndexedMutationReader for Reader {
    type Error = ReaderError;
    fn admit(&mut self, work: IndexedMutationWork) -> Result<(), ReaderError> {
        self.admissions.push(work);
        if self.reject_at == Some(self.admissions.len()) {
            Err(ReaderError::Admission)
        } else {
            Ok(())
        }
    }
    fn require_fresh_revision(&mut self, revision: &Revision) -> Result<(), ReaderError> {
        self.record(format!("revision:{revision}"))?;
        if self.revisions.contains(revision) {
            Err(invalid("next revision must be freshly allocated").into())
        } else {
            Ok(())
        }
    }
    fn entry(&mut self, id: &EntryId) -> Result<Option<EntryState>, ReaderError> {
        self.record(format!("id:{id}"))?;
        let mut entry = self.ids.get(id).cloned();
        if self.bad_id {
            if let Some(entry) = &mut entry {
                entry.id = EntryId::new("different").unwrap();
            }
        }
        Ok(entry)
    }
    fn live_path(&mut self, path: &VaultPath) -> Result<Option<EntryState>, ReaderError> {
        self.record(format!("path:{path}"))?;
        if self.hide_target_path && path.as_str() == "notes/topic" {
            return Ok(None);
        }
        let mut entry = self.paths.get(path.as_str()).cloned();
        if self.bad_path {
            if let Some(entry) = &mut entry {
                entry.deleted = true;
            }
        }
        Ok(entry)
    }
    fn next_live_descendant(
        &mut self,
        root: &VaultPath,
        after: Option<&VaultPath>,
    ) -> Result<Option<EntryState>, ReaderError> {
        self.record(format!(
            "descendants:{root}:{}",
            after.map(VaultPath::as_str).unwrap_or("")
        ))?;
        if self.bad_cursor {
            return Ok(self.paths.get(root.as_str()).cloned());
        }
        if self.repeat_cursor {
            return Ok(self
                .paths
                .values()
                .find(|entry| entry.path.is_descendant_of(root))
                .cloned());
        }
        let prefix = format!("{root}/");
        let lower = after
            .map(|path| Excluded(path.as_str()))
            .unwrap_or(Included(prefix.as_str()));
        Ok(self
            .paths
            .range::<str, _>((lower, Unbounded))
            .next()
            .map(|(_, entry)| entry)
            .filter(|entry| entry.path.is_descendant_of(root))
            .cloned())
    }
}

fn id(value: &str) -> EntryId {
    EntryId::new(value).unwrap()
}
fn path(value: &str) -> VaultPath {
    VaultPath::new(value).unwrap()
}
fn rev(value: &str) -> Revision {
    Revision::new(value).unwrap()
}
fn entry(value: &str, at: &str, kind: EntryKind) -> EntryState {
    EntryState {
        id: id(value),
        path: path(at),
        kind,
        revision: rev(&format!("before-{value}")),
        deleted: false,
    }
}
fn tree() -> Vec<EntryState> {
    let mut old = entry("old", "notes/topic/deleted", EntryKind::File);
    old.deleted = true;
    vec![
        entry("a", "notes", EntryKind::Folder),
        entry("b", "notes/topic", EntryKind::Folder),
        entry("c", "notes/topic/note.md", EntryKind::File),
        entry("d", "notes/keep", EntryKind::File),
        entry("e", "archive", EntryKind::Folder),
        entry("f", "notes/topic/nested", EntryKind::Folder),
        entry("g", "notes/topic/nested/data", EntryKind::File),
        old,
        entry("root", "root", EntryKind::File),
    ]
}
fn request(mutation: Mutation) -> MutationRequest {
    MutationRequest {
        operation_id: OperationId::new("operation").unwrap(),
        mutation,
    }
}
fn create(value: &str, at: &str, kind: EntryKind) -> Mutation {
    Mutation::Create {
        id: id(value),
        path: path(at),
        kind,
        content: (kind == EntryKind::File).then_some(vec![0, 255]),
    }
}
fn write(entry: &EntryState) -> Mutation {
    Mutation::Write {
        id: entry.id.clone(),
        expected: entry.revision.clone(),
        content: vec![255],
    }
}
fn moved(entry: &EntryState, to: &str) -> Mutation {
    Mutation::Move {
        id: entry.id.clone(),
        expected: entry.revision.clone(),
        path: path(to),
    }
}
fn delete(entry: &EntryState, recursive: bool) -> Mutation {
    Mutation::Delete {
        id: entry.id.clone(),
        expected: entry.revision.clone(),
        recursive,
    }
}
fn compare(mutation: Mutation, entries: &[EntryState], next: &Revision) {
    let request = request(mutation);
    let expected = plan_mutation(&request, entries, next).map_err(ReaderError::from);
    assert_eq!(
        plan_indexed_mutation(&request, &mut Reader::new(entries), next),
        expected,
        "{request:?}"
    );
}

#[test]
fn indexed_all_command_variants_match_complete_snapshot_oracle() {
    let entries = tree();
    let next = rev("next");
    for mutation in [
        create("new", "notes/topic/new", EntryKind::File),
        create("new", "notes/topic/new", EntryKind::Folder),
        write(&entries[2]),
        write(&entries[8]),
        moved(&entries[1], "archive/renamed"),
        moved(&entries[2], "archive/file"),
        moved(&entries[1], "notes/topic"),
        moved(&entries[1], "topic"),
        delete(&entries[1], true),
        delete(&entries[2], false),
        delete(&entries[4], false),
    ] {
        compare(mutation, &entries, &next);
    }
    let mut reversed = entries.clone();
    reversed.reverse();
    compare(moved(&entries[1], "archive/renamed"), &reversed, &next);
    compare(create("root-new", "new-root", EntryKind::File), &[], &next);
}

#[test]
fn indexed_create_and_move_errors_match_complete_snapshot_oracle() {
    let entries = tree();
    for (value, at) in [
        ("new", "missing/child"),
        ("new", "notes/keep/child"),
        ("new", "notes/keep"),
        ("c", "notes/new"),
        ("old", "notes/new"),
    ] {
        compare(create(value, at, EntryKind::File), &entries, &rev("next"));
    }
    compare(
        create("new", "notes/topic/deleted", EntryKind::File),
        &entries,
        &rev("next"),
    );
    for to in [
        "notes/topic/nested/inside",
        "notes",
        "notes/keep",
        "missing/topic",
        "notes/keep/topic",
    ] {
        compare(moved(&entries[1], to), &entries, &rev("next"));
    }
    compare(delete(&entries[1], false), &entries, &rev("next"));
}

#[test]
fn indexed_target_precondition_and_revision_errors_match_oracle() {
    let entries = tree();
    for target in [
        &entries[0],
        &entries[7],
        &entry("missing", "missing", EntryKind::File),
    ] {
        compare(write(target), &entries, &rev("next"));
        compare(moved(target, "new"), &entries, &rev("next"));
        compare(delete(target, true), &entries, &rev("next"));
    }
    for stale in [
        Mutation::Write {
            id: entries[2].id.clone(),
            expected: rev("stale"),
            content: vec![],
        },
        Mutation::Move {
            id: entries[1].id.clone(),
            expected: rev("stale"),
            path: path("new"),
        },
        Mutation::Delete {
            id: entries[1].id.clone(),
            expected: rev("stale"),
            recursive: true,
        },
    ] {
        compare(stale, &entries, &rev("next"));
    }
    for entry in &entries {
        compare(write(&entries[2]), &entries, &entry.revision);
    }
    let malformed = Mutation::Create {
        id: id("new"),
        path: path("new"),
        kind: EntryKind::File,
        content: None,
    };
    compare(malformed, &entries, &rev("next"));
    let malformed = Mutation::Create {
        id: id("new"),
        path: path("new"),
        kind: EntryKind::Folder,
        content: Some(vec![]),
    };
    compare(malformed, &entries, &rev("next"));
}

#[test]
fn indexed_file_content_and_materialization_match_oracles() {
    let entries = tree();
    let mut targets = vec![
        FileContentTarget::Create {
            id: id("new"),
            path: path("notes/topic/new"),
        },
        FileContentTarget::Create {
            id: id("old"),
            path: path("new"),
        },
        FileContentTarget::Create {
            id: id("new"),
            path: path("missing/new"),
        },
    ];
    for entry in &entries {
        targets.push(FileContentTarget::Write {
            id: entry.id.clone(),
            expected: entry.revision.clone(),
        });
    }
    targets.push(FileContentTarget::Write {
        id: id("missing"),
        expected: rev("missing"),
    });
    targets.push(FileContentTarget::Write {
        id: entries[2].id.clone(),
        expected: rev("stale"),
    });
    for target in targets {
        let next = rev("next");
        assert_eq!(
            plan_indexed_file_content_mutation(&target, &mut Reader::new(&entries), &next),
            plan_file_content_mutation(&target, &entries, &next).map_err(ReaderError::from)
        );
        if let FileContentTarget::Write { id, expected } = target {
            assert_eq!(
                plan_indexed_file_materialization(
                    &id,
                    &expected,
                    &next,
                    &mut Reader::new(&entries)
                ),
                plan_file_materialization(&id, &expected, &next, &entries)
                    .map_err(ReaderError::from)
            );
        }
    }
    let target = FileContentTarget::Create {
        id: id("new"),
        path: path("new"),
    };
    for old in &entries {
        assert_eq!(
            plan_indexed_file_content_mutation(&target, &mut Reader::new(&entries), &old.revision),
            plan_file_content_mutation(&target, &entries, &old.revision).map_err(ReaderError::from)
        );
    }
}

#[test]
fn indexed_queries_never_enumerate_unrelated_corpus() {
    let mut entries = tree();
    for n in 0..10_000 {
        entries.push(entry(
            &format!("unrelated-{n}"),
            &format!("unrelated-{n}"),
            EntryKind::File,
        ));
    }
    for mutation in [
        write(&entries[2]),
        create("new", "notes/topic/new", EntryKind::File),
        moved(&entries[1], "archive/moved"),
        delete(&entries[1], true),
    ] {
        let request = request(mutation);
        let mut reader = Reader::new(&entries);
        assert_eq!(
            plan_indexed_mutation(&request, &mut reader, &rev("next")),
            plan_mutation(&request, &entries, &rev("next")).map_err(ReaderError::from)
        );
        assert!(reader.reads.len() < 24, "{:?}", reader.reads);
        assert!(reader
            .reads
            .iter()
            .all(|selector| !selector.contains("unrelated")));
    }
}

#[test]
fn indexed_every_admission_rejection_returns_no_prefix_success() {
    let entries = tree();
    for mutation in [
        write(&entries[2]),
        create("new", "notes/topic/new", EntryKind::File),
        moved(&entries[1], "archive/moved"),
        delete(&entries[1], true),
    ] {
        let request = request(mutation);
        let mut baseline = Reader::new(&entries);
        plan_indexed_mutation(&request, &mut baseline, &rev("next")).unwrap();
        assert!(baseline
            .admissions
            .iter()
            .any(|work| matches!(work, IndexedMutationWork::Retain { .. })));
        assert!(baseline
            .admissions
            .iter()
            .any(|work| matches!(work, IndexedMutationWork::Emit { .. })));
        for stop in 1..=baseline.admissions.len() {
            let mut reader = Reader::new(&entries);
            reader.reject_at = Some(stop);
            assert_eq!(
                plan_indexed_mutation(&request, &mut reader, &rev("next")),
                Err(ReaderError::Admission),
                "admission {stop} for {request:?}"
            );
            assert_eq!(reader.admissions.len(), stop);
            assert_eq!(
                reader.ids, baseline.ids,
                "candidate rejection must not mutate source rows"
            );
        }
    }
}

#[test]
fn indexed_admission_precedes_subtree_collection_and_output_construction() {
    let entries = tree();
    let request = request(moved(&entries[1], "archive/moved"));
    let mut baseline = Reader::new(&entries);
    let expected = plan_indexed_mutation(&request, &mut baseline, &rev("next")).unwrap();
    let first_emit = baseline
        .admissions
        .iter()
        .position(|work| matches!(work, IndexedMutationWork::Emit { .. }))
        .unwrap();
    assert_eq!(baseline.admissions[first_emit..].len(), expected.len());
    assert!(baseline.admissions[first_emit..]
        .iter()
        .all(|work| matches!(work, IndexedMutationWork::Emit { .. })));
    let mut reader = Reader::new(&entries);
    reader.reject_at = Some(first_emit + 1);
    assert_eq!(
        plan_indexed_mutation(&request, &mut reader, &rev("next")),
        Err(ReaderError::Admission)
    );
    let mut reader = Reader::new(&entries);
    reader.reject_at = Some(1);
    assert_eq!(
        plan_indexed_mutation(&request, &mut reader, &rev("next")),
        Err(ReaderError::Admission)
    );
    assert!(
        reader.reads.is_empty(),
        "cancellation before first lookup must prevent source access"
    );
}

#[test]
fn indexed_rejects_lying_id_live_path_and_descendant_rows() {
    let entries = tree();
    for mode in 0..5 {
        let mut reader = Reader::new(&entries);
        reader.bad_id = mode == 0;
        reader.bad_path = mode == 1;
        reader.bad_cursor = mode == 2;
        reader.repeat_cursor = mode == 3;
        reader.hide_target_path = mode == 4;
        assert!(matches!(
            plan_indexed_mutation(
                &request(moved(
                    &entries[1],
                    if mode == 4 {
                        "notes/topic"
                    } else {
                        "archive/moved"
                    }
                )),
                &mut reader,
                &rev("next")
            ),
            Err(ReaderError::Contract(ContractError::InvalidMutation { .. }))
        ));
    }
}

#[test]
fn indexed_propagates_source_errors_without_a_candidate() {
    let entries = tree();
    let mut reader = Reader::new(&entries);
    reader.source_failure = true;
    assert_eq!(
        plan_indexed_mutation(&request(write(&entries[2])), &mut reader, &rev("next")),
        Err(ReaderError::Source)
    );
}

#[test]
fn indexed_encoded_output_estimate_bounds_json_even_with_escaped_paths() {
    let mut entries = tree();
    // Quote and non-ASCII spelling exercise conservative JSON accounting.
    entries.push(entry("escaped", "notes/topic/\"é", EntryKind::File));
    let mut reader = Reader::new(&entries);
    let changes = plan_indexed_mutation(
        &request(moved(&entries[1], "archive/\"Ω")),
        &mut reader,
        &rev("next"),
    )
    .unwrap();
    let estimates: Vec<_> = reader
        .admissions
        .iter()
        .filter_map(|work| match work {
            IndexedMutationWork::Emit { encoded_bytes } => Some(*encoded_bytes),
            _ => None,
        })
        .collect();
    for (change, estimate) in changes.iter().zip(estimates) {
        assert!(serde_json::to_vec(change).unwrap().len() <= estimate);
    }
}
