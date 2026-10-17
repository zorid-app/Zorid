use serde::Deserialize;
use zorid_core::{EntryId, EntryKind, EntryState, OperationId, Revision, VaultPath};
use zorid_index::*;
fn source(store: &str, watermark: &str) -> SourceSnapshotId {
    SourceSnapshotId::new(
        OperationId::new(store).unwrap(),
        SourceWatermark::new(watermark).unwrap(),
    )
}
fn versions(extraction: &str) -> SemanticVersions {
    SemanticVersions::new(1, extraction, RESOLVER_VERSION, "literal-v1").unwrap()
}
fn index(generation: u64, extraction: &str) -> IndexSnapshotId {
    IndexSnapshotId::new(
        OperationId::new("store-a").unwrap(),
        OperationId::new("epoch-a").unwrap(),
        generation,
        versions(extraction),
    )
    .unwrap()
}
fn entry(id: &str, path: &str) -> EntryState {
    EntryState {
        id: EntryId::new(id).unwrap(),
        path: VaultPath::new(path).unwrap(),
        kind: EntryKind::File,
        revision: Revision::new("revision-1").unwrap(),
        deleted: false,
    }
}
#[derive(Deserialize)]
struct ResolverCase {
    name: String,
    source: String,
    files: Vec<String>,
    target: String,
    expected: Vec<String>,
}
#[test]
fn shared_resolver_corpus_has_deterministic_segment_safe_results() {
    let cases: Vec<ResolverCase> =
        serde_json::from_str(include_str!("fixtures/resolver.json")).unwrap();
    for case in cases {
        let mut rows = vec![entry("source", &case.source)];
        rows.extend(
            case.files
                .iter()
                .enumerate()
                .map(|(i, path)| entry(&format!("entry-{i}"), path)),
        );
        for reverse in [false, true] {
            let mut rows = rows.clone();
            if reverse {
                rows.reverse();
            }
            let manifest = Manifest::new(source("store-a", "10"), rows).unwrap();
            let resolver = Resolver::new(&manifest);
            let actual: Vec<_> = resolver
                .candidates(&EntryId::new("source").unwrap(), &case.target)
                .unwrap()
                .into_iter()
                .map(|e| e.path.as_str())
                .collect();
            assert_eq!(actual, case.expected, "{} reverse={reverse}", case.name);
        }
    }
}
#[derive(Deserialize)]
struct FenceCase {
    name: String,
    store: String,
    watermark: String,
    generation: Option<u64>,
    extraction: String,
    expected: String,
}
#[test]
fn publication_corpus_binds_store_source_generation_and_versions() {
    let cases: Vec<FenceCase> =
        serde_json::from_str(include_str!("fixtures/index-fences.json")).unwrap();
    let fence = PublicationFence::new(
        source("store-a", "10"),
        Some(index(1, "parser-v1")),
        index(2, "parser-v1"),
    )
    .unwrap();
    for case in cases {
        let observed = case.generation.map(|g| index(g, &case.extraction));
        let actual = match fence.check(&source(&case.store, &case.watermark), observed.as_ref()) {
            Ok(()) => "ok",
            Err(IndexError::StaleSource) => "stale_source",
            Err(IndexError::StaleIndex) => "stale_index",
            other => panic!("unexpected fence result {other:?}"),
        };
        assert_eq!(actual, case.expected, "{}", case.name);
    }
}
#[test]
fn namespace_witness_cannot_resurrect_replaced_moved_or_deleted_entry() {
    let original = Manifest::new(source("store-a", "10"), vec![entry("old", "Note.md")]).unwrap();
    let witness = original.witness(&EntryId::new("old").unwrap()).unwrap();
    assert_eq!(original.check_witness(&witness), Ok(()));
    let mut changed = entry("old", "Note.md");
    changed.revision = Revision::new("revision-2").unwrap();
    for rows in [
        vec![changed],
        vec![entry("old", "Moved.md")],
        vec![entry("replacement", "Note.md")],
        vec![],
    ] {
        let current = Manifest::new(source("store-a", "11"), rows).unwrap();
        assert_eq!(
            current.check_witness(&witness),
            Err(IndexError::StaleSource)
        );
    }
    // Also reject inconsistent same-head host data: a cursor alone is no byte/entry proof.
    let current = Manifest::new(source("store-a", "10"), vec![entry("old", "Moved.md")]).unwrap();
    assert_eq!(
        current.check_witness(&witness),
        Err(IndexError::StaleSource)
    );
}
#[test]
fn malformed_manifest_and_watermark_never_become_valid_snapshots() {
    for bad in ["", "01", "+1", "-1", "18446744073709551616"] {
        assert_eq!(SourceWatermark::new(bad), Err(IndexError::InvalidWatermark));
    }
    assert_eq!(
        SourceWatermark::new("9007199254740993").unwrap().as_str(),
        "9007199254740993"
    );
    let row = entry("old", "Note.md");
    let mut deleted = row.clone();
    deleted.deleted = true;
    for rows in [
        vec![row.clone(), row.clone()],
        vec![row.clone(), entry("other", "Note.md")],
        vec![deleted],
    ] {
        assert_eq!(
            Manifest::new(source("store-a", "10"), rows),
            Err(IndexError::InvalidManifest)
        );
    }
    assert_eq!(
        PublicationFence::new(
            source("store-a", "10"),
            Some(index(2, "parser-v1")),
            index(2, "parser-v1")
        ),
        Err(IndexError::InvalidGeneration)
    );
    assert_eq!(
        PublicationFence::new(source("store-b", "10"), None, index(1, "parser-v1")),
        Err(IndexError::InvalidGeneration)
    );
}

#[test]
fn reset_generation_counter_uses_fresh_epoch_and_cannot_match_old_identity() {
    let old = index(1, "parser-v1");
    let fresh = IndexSnapshotId::new(
        OperationId::new("store-a").unwrap(),
        OperationId::new("fresh-csprng-epoch").unwrap(),
        1,
        versions("parser-v1"),
    )
    .unwrap();
    assert_ne!(old, fresh);
    let rebuild =
        PublicationFence::new(source("store-a", "10"), Some(old.clone()), fresh.clone()).unwrap();
    assert_eq!(rebuild.check(&source("store-a", "10"), Some(&old)), Ok(()));
    assert_eq!(
        rebuild.check(&source("store-a", "10"), Some(&fresh)),
        Err(IndexError::StaleIndex)
    );
}

#[test]
fn snapshot_json_is_canonical_and_revalidates_private_identities() {
    let id = IndexSnapshotId::new(
        OperationId::new("store-a").unwrap(),
        OperationId::new("epoch-a").unwrap(),
        9007199254740993,
        versions("parser-v1"),
    )
    .unwrap();
    let encoded = serde_json::to_value(&id).unwrap();
    assert_eq!(encoded["generation"], "9007199254740993");
    assert_eq!(encoded["generationEpoch"], "epoch-a");
    assert_eq!(
        serde_json::from_value::<IndexSnapshotId>(encoded.clone()).unwrap(),
        id
    );
    for value in [
        serde_json::json!("01"),
        serde_json::json!("0"),
        serde_json::json!("18446744073709551616"),
        serde_json::json!(1),
    ] {
        let mut wrong = encoded.clone();
        wrong["generation"] = value;
        assert!(serde_json::from_value::<IndexSnapshotId>(wrong).is_err());
    }
    let mut wrong = encoded.clone();
    wrong["unknown"] = true;
    assert!(serde_json::from_value::<IndexSnapshotId>(wrong).is_err());
    let mut wrong = encoded;
    wrong["versions"]["schema"] = 0.into();
    assert!(serde_json::from_value::<IndexSnapshotId>(wrong).is_err());
    let source = source("store-a", "9007199254740993");
    assert_eq!(
        serde_json::from_str::<SourceSnapshotId>(&serde_json::to_string(&source).unwrap()).unwrap(),
        source
    );
    assert!(serde_json::from_str::<SourceSnapshotId>(
        r#"{"localStoreId":"store-a","watermark":"01"}"#
    )
    .is_err());
}
