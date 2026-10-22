//! Root-origin expression resolution shares ordinary link precedence without a
//! synthetic file or manifest identity.
use zorid_core::{EntryId, EntryKind, EntryState, OperationId, Revision, VaultPath};
use zorid_index::{IndexError, Manifest, Resolver, SourceSnapshotId, SourceWatermark};

fn manifest() -> Manifest {
    Manifest::new(
        SourceSnapshotId::new(
            OperationId::new("root-origin").unwrap(),
            SourceWatermark::new("1").unwrap(),
        ),
        [
            ("source", "Deep/Source.md"),
            ("near", "Deep/Target.md"),
            ("short", "X/Target.md"),
            ("root", "Root.md"),
        ]
        .into_iter()
        .map(|(id, path)| EntryState {
            id: EntryId::new(id).unwrap(),
            path: VaultPath::new(path).unwrap(),
            kind: EntryKind::File,
            revision: Revision::new("r1").unwrap(),
            deleted: false,
        })
        .collect(),
    )
    .unwrap()
}

#[test]
fn root_origin_preserves_shared_order_and_relative_directory_semantics() {
    let manifest = manifest();
    let resolver = Resolver::new(&manifest);
    let root = resolver
        .candidates_from_root_checked("Target", &mut |_| Ok::<(), IndexError>(()))
        .unwrap();
    assert_eq!(root[0].id.as_str(), "short");
    let source = resolver
        .candidates(&EntryId::new("source").unwrap(), "Target")
        .unwrap();
    assert_eq!(source[0].id.as_str(), "near");
    let explicit = resolver
        .candidates_from_root_checked("./Deep/Target", &mut |_| Ok::<(), IndexError>(()))
        .unwrap();
    assert_eq!(explicit.len(), 1);
    assert_eq!(explicit[0].id.as_str(), "near");
    assert!(resolver
        .candidates_from_root_checked("", &mut |_| Ok::<(), IndexError>(()))
        .unwrap()
        .is_empty());
    assert!(resolver
        .candidates_from_root_checked("https://example.org", &mut |_| Ok::<(), IndexError>(()))
        .unwrap()
        .is_empty());
}

#[test]
fn root_origin_checkpoints_run_before_namespace_visits() {
    let manifest = manifest();
    let resolver = Resolver::new(&manifest);
    let failure = resolver
        .candidates_from_root_checked("Target", &mut |_| Err::<(), _>(IndexError::InvalidBudget))
        .unwrap_err();
    assert_eq!(failure, IndexError::InvalidBudget);
    let mut work = 0usize;
    resolver
        .candidates_from_root_checked("Root", &mut |charged| {
            work += charged;
            Ok::<(), IndexError>(())
        })
        .unwrap();
    assert!(work > 0);
}
