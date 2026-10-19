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
            let original = original_scan::Resolver::new(&manifest);
            assert_eq!(
                resolver.candidates(&EntryId::new("source").unwrap(), &case.target),
                original.candidates(&EntryId::new("source").unwrap(), &case.target),
                "full ordered identities/revisions: {} reverse={reverse}",
                case.name
            );
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
    wrong["unknown"] = serde_json::Value::Bool(true);
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

#[test]
fn external_destination_fact_uses_the_same_semantic_resolver_pipeline() {
    for destination in [
        "https://example.org",
        "https%3A%2F%2Fexample.org",
        "//example.org",
        "\u{feff} mailto:user@example.org #fragment",
    ] {
        assert_eq!(
            is_external_destination(destination),
            Ok(true),
            "{destination}"
        );
    }
    for destination in [
        "A%23B.md",
        "#https%3A%2F%2Fexample.org",
        "https%3A%ZZ",
        "%FF",
        "Folder/Note.md",
    ] {
        assert_eq!(
            is_external_destination(destination),
            Ok(false),
            "{destination}"
        );
    }
    assert_eq!(
        is_external_destination(&"x".repeat(4097)),
        Err(IndexError::InvalidTarget)
    );
}

#[test]
fn prepared_resolver_matches_frozen_scan_for_context_errors_and_fallback_edges() {
    let paths = [
        "A/Child/Source.md",
        "Note.md",
        "A/Note.md",
        "A/Child/Note.md",
        "AB/Note.md",
        "A/Deep/Note.md",
        "X/Dir/Note.md",
        "OtherDir/Note.md",
        "Café.md",
        "CAFE\u{301}.md",
        "Hash#Name.md",
        "%E9.md",
        "bad%20%ZZ.md",
        "Note.custom.md",
        "Bizarre.md.md",
        "Missing/Note.md.md",
        "A/😀/Note.md",
        "A/xx/Note.md",
        "STRAẞE.md",
        "strasse.md",
    ];
    let mut rows: Vec<_> = paths
        .iter()
        .enumerate()
        .map(|(n, path)| {
            let mut row = entry(
                if n == 0 {
                    "source".into()
                } else {
                    format!("note-{n}")
                }
                .as_str(),
                path,
            );
            row.revision = Revision::new(format!("revision-{n}")).unwrap();
            row
        })
        .collect();
    let mut folder = entry("folder", "A/Folder");
    folder.kind = EntryKind::Folder;
    rows.push(folder);
    let targets = [
        "",
        "#Section",
        "Note",
        "Note.md",
        "../Note",
        "./../Note",
        "../../Note",
        "./Note",
        "././Note",
        "/Note",
        "/A/Note",
        "/Absent/Note",
        "Dir/Note",
        "\u{feff}\t../Note #part",
        "\u{0085}Note",
        "CAFE\u{301}",
        "Hash%23Name#other",
        "%E9",
        "bad%20%ZZ",
        "Bizarre.md",
        "Missing/Note.md",
        "Note.custom",
        "none",
        "https%3A%2F%2Fexample.org#part",
        "//example.org",
        "mailto:user@example.org",
        "%23Section",
        "STRAẞE",
        "strasse",
    ];
    for reverse in [false, true] {
        if reverse {
            rows.reverse();
        }
        let manifest = Manifest::new(source("store-a", "10"), rows.clone()).unwrap();
        let prepared = Resolver::new(&manifest);
        let original = original_scan::Resolver::new(&manifest);
        let oversized = "x".repeat(4097);
        for id in ["source", "folder", "missing"] {
            let id = EntryId::new(id).unwrap();
            for target in targets
                .iter()
                .copied()
                .chain(std::iter::once(oversized.as_str()))
            {
                assert_eq!(
                    prepared.candidates(&id, target),
                    original.candidates(&id, target),
                    "source={id} target={target:?} reverse={reverse}"
                );
            }
        }
        for id in ["folder", "missing"] {
            for target in ["", "#part", "https://example.org"] {
                assert_eq!(
                    prepared.candidates(&EntryId::new(id).unwrap(), target),
                    Err(IndexError::MissingSource)
                );
            }
        }
        assert!(
            prepared
                .candidates(&EntryId::new("source").unwrap(), "Missing/Note.md")
                .unwrap()
                .is_empty(),
            "an existing basename bucket must prevent a later .md retry"
        );
    }
}

#[derive(Debug, PartialEq)]
enum ResolverStop {
    Index(IndexError),
    Budget,
    Cancelled,
}
impl From<IndexError> for ResolverStop {
    fn from(error: IndexError) -> Self {
        Self::Index(error)
    }
}

#[test]
fn prepared_queries_charge_bucket_work_instead_of_revisiting_unrelated_files() {
    for count in [32, 2048] {
        let mut rows = vec![entry("source", "Working/Source.md")];
        rows.extend(
            (0..count).map(|n| entry(&format!("note-{n}"), &format!("Other/Node-{n:04}.md"))),
        );
        let manifest = Manifest::new(source("store-a", "10"), rows).unwrap();
        let mut construction = 0usize;
        let prepared = Resolver::new_checked(&manifest, &mut |units| {
            construction += units;
            Ok::<(), ResolverStop>(())
        })
        .unwrap();
        assert!(
            construction
                >= manifest
                    .entries()
                    .iter()
                    .map(|e| e.path.as_str().len())
                    .sum::<usize>()
        );
        let id = EntryId::new("source").unwrap();
        let mut total = 0usize;
        for _ in 0..128 {
            let mut work = 0usize;
            let result = prepared
                .candidates_checked(&id, "Node-0007", &mut |units| {
                    work += units;
                    Ok::<(), ResolverStop>(())
                })
                .unwrap();
            assert_eq!(result[0].id.as_str(), "note-7");
            assert!(
                work < 128,
                "one candidate must not reserve the {count}-file namespace: {work}"
            );
            total += work;
        }
        assert!(total < 128 * 128);
        for (target, expected) in [
            ("#part", 1),
            ("https://example.org", 0),
            ("No-such-basename", 0),
        ] {
            let mut work = 0usize;
            let result = prepared
                .candidates_checked(&id, target, &mut |units| {
                    work += units;
                    Ok::<(), ResolverStop>(())
                })
                .unwrap();
            assert_eq!(result.len(), expected);
            assert!(work < 128);
        }
    }
}

#[test]
fn prepared_construction_and_collision_queries_keep_work_and_cancellation_bounds() {
    let mut rows = vec![entry("source", "Source.md")];
    rows.extend(
        (0..1024).map(|n| entry(&format!("note-{n}"), &format!("Collision-{n:04}/Note.md"))),
    );
    let manifest = Manifest::new(source("store-a", "10"), rows).unwrap();
    assert!(matches!(
        Resolver::new_checked(&manifest, &mut |_| Err(ResolverStop::Cancelled)),
        Err(ResolverStop::Cancelled)
    ));
    let mut projection_work = 0usize;
    assert!(
        matches!(
            Resolver::new_checked(&manifest, &mut |units| {
                if units > 4096 {
                    return Err(ResolverStop::Budget);
                }
                projection_work += units;
                Ok(())
            }),
            Err(ResolverStop::Budget)
        ),
        "collision-bucket sorting must reserve real work before sorting"
    );
    assert!(projection_work > manifest.entries().len());
    let prepared = Resolver::new(&manifest);
    let id = EntryId::new("source").unwrap();
    let mut remaining = 128usize;
    assert_eq!(
        prepared.candidates_checked(&id, "Note", &mut |units| {
            remaining = remaining.checked_sub(units).ok_or(ResolverStop::Budget)?;
            Ok(())
        }),
        Err(ResolverStop::Budget),
        "a collision bucket must not become a constant-cost lookup"
    );
    let mut calls = 0usize;
    assert_eq!(
        prepared.candidates_checked(&id, "Note", &mut |_| {
            calls += 1;
            if calls == 12 {
                Err(ResolverStop::Cancelled)
            } else {
                Ok(())
            }
        }),
        Err(ResolverStop::Cancelled)
    );
    assert_eq!(calls, 12, "cancellation stops further candidate visits");
}

// Frozen scan implementation from253b1433; intentionally independent of prepared
// lookup code. Existing fixture expectations are unchanged, never regenerated.
mod original_scan {
    use percent_encoding::percent_decode_str;
    use std::cmp::Ordering;
    use unicode_normalization::UnicodeNormalization;
    use zorid_core::{EntryId, EntryKind, EntryState};
    use zorid_index::{IndexError, Manifest};

    /// Bump on normalization, priority, segment-boundary or tie-order changes.
    pub const RESOLVER_VERSION: &str = "link-nfc-lower-segment-utf16-v1";
    const MAX_TARGET_BYTES: usize = 4096;
    pub fn normalize_link_key(value: &str) -> String {
        value.nfc().collect::<String>().to_lowercase()
    }
    fn parent(path: &str) -> &str {
        path.rsplit_once('/').map_or("", |(p, _)| p)
    }
    fn name(path: &str) -> &str {
        path.rsplit('/').next().unwrap_or(path)
    }
    fn external(target: &str) -> bool {
        if target.starts_with("//") {
            return true;
        }
        let Some((scheme, _)) = target.split_once(':') else {
            return false;
        };
        let mut b = scheme.bytes();
        b.next().is_some_and(|c| c.is_ascii_alphabetic())
            && b.all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'+' | b'.' | b'-'))
    }
    fn js_whitespace(c: char) -> bool {
        matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|
        '\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
    }
    fn decode_or_literal(value: &str) -> String {
        let bytes = value.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' {
                if i + 2 >= bytes.len()
                    || !bytes[i + 1].is_ascii_hexdigit()
                    || !bytes[i + 2].is_ascii_hexdigit()
                {
                    return value.into();
                }
                i += 3;
            } else {
                i += 1;
            }
        }
        percent_decode_str(value)
            .decode_utf8()
            .map_or_else(|_| value.into(), |s| s.into_owned())
    }
    fn destination_path(destination: &str) -> Result<String, IndexError> {
        if destination.len() > MAX_TARGET_BYTES {
            return Err(IndexError::InvalidTarget);
        }
        let raw = destination
            .split('#')
            .next()
            .unwrap_or("")
            .trim_matches(js_whitespace);
        Ok(decode_or_literal(raw))
    }
    /// Classify the parser's semantic full destination using exactly the resolver's
    /// fragment/trim/strict-percent pipeline and target resource limit. Markdown
    /// escapes/entities must already be normalized upstream, just as candidates().
    pub fn is_external_destination(destination: &str) -> Result<bool, IndexError> {
        Ok(external(&destination_path(destination)?))
    }
    fn order(a: &EntryState, b: &EntryState) -> Ordering {
        a.path
            .as_str()
            .encode_utf16()
            .count()
            .cmp(&b.path.as_str().encode_utf16().count())
            .then(a.path.cmp(&b.path))
            .then(a.id.cmp(&b.id))
    }
    fn suffix_segment(path: &str, target: &str) -> bool {
        path == target
            || path
                .strip_suffix(target)
                .is_some_and(|prefix| prefix.ends_with('/'))
    }
    fn in_directory(path: &str, directory: &str) -> bool {
        directory.is_empty()
            || path
                .strip_prefix(directory)
                .is_some_and(|suffix| suffix.starts_with('/'))
    }
    /// Borrowed namespace-only view: no body reads or second authority snapshot.
    pub struct Resolver<'a> {
        manifest: &'a Manifest,
        files: Vec<(&'a EntryState, String)>,
    }
    impl<'a> Resolver<'a> {
        pub fn new(manifest: &'a Manifest) -> Self {
            Self::new_checked(manifest, &mut |_| Ok::<(), IndexError>(()))
                .expect("infallible checkpoint")
        }
        /// Charge/cancel before allocating each namespace projection. The callback
        /// owns its error classification; this engine has no clock/cancellation IO.
        pub fn new_checked<E>(
            manifest: &'a Manifest,
            check: &mut impl FnMut(usize) -> Result<(), E>,
        ) -> Result<Self, E> {
            check(0)?;
            let mut files = Vec::new();
            for entry in manifest.entries() {
                check(1)?;
                if entry.kind == EntryKind::File {
                    files.push((entry, normalize_link_key(entry.path.as_str())));
                }
            }
            Ok(Self { manifest, files })
        }
        /// Semantic destination from the document parser: Markdown escapes/entities
        /// have already been normalized by that established parser; percent encoding
        /// remains. Wiki destination is its raw target plus raw fragment. Split the
        /// literal fragment before percent decoding, preserving encoded hash filenames.
        /// Never pass raw CommonMark source here or decode its escapes/entities again.
        pub fn candidates(
            &self,
            source_id: &EntryId,
            destination: &str,
        ) -> Result<Vec<&'a EntryState>, IndexError> {
            self.candidates_checked(source_id, destination, &mut |_| Ok::<(), IndexError>(()))
        }
        /// Same resolver with explicit work/cancellation checkpoints. Namespace
        /// lookup and sorting reserve conservative work before their bounded work;
        /// filtering charges each candidate as visited. No alternative semantics.
        pub fn candidates_checked<E: From<IndexError>>(
            &self,
            source_id: &EntryId,
            destination: &str,
            check: &mut impl FnMut(usize) -> Result<(), E>,
        ) -> Result<Vec<&'a EntryState>, E> {
            check(0)?;
            let decoded = destination_path(destination).map_err(E::from)?;
            check(self.manifest.entries().len())?;
            let source = self
                .manifest
                .entry(source_id)
                .filter(|e| e.kind == EntryKind::File)
                .ok_or_else(|| E::from(IndexError::MissingSource))?;
            if decoded.is_empty() {
                return Ok(vec![source]);
            }
            if external(&decoded) {
                return Ok(Vec::new());
            }
            let mut target = normalize_link_key(&decoded);
            let rooted = target.starts_with('/');
            let mut candidates = Vec::new();
            if name(&target).contains('.') {
                for pair in &self.files {
                    check(1)?;
                    if name(&pair.1) == name(&target) {
                        candidates.push(pair);
                    }
                }
            }
            if candidates.is_empty() {
                target.push_str(".md");
                for pair in &self.files {
                    check(1)?;
                    if name(&pair.1) == name(&target) {
                        candidates.push(pair);
                    }
                }
            }
            if candidates.is_empty() {
                return Ok(Vec::new());
            }
            let mut directory = normalize_link_key(parent(source.path.as_str()));
            if target.starts_with("./") || target.starts_with("../") {
                if target.starts_with("./../") {
                    target = target[2..].into();
                }
                if target.starts_with("./") {
                    target = target[2..].into();
                } else {
                    while target.starts_with("../") {
                        target = target[3..].into();
                        directory = parent(&directory).into();
                    }
                }
                target = if directory.is_empty() {
                    target
                } else {
                    format!("{directory}/{target}")
                };
                let mut exact = Vec::new();
                for (entry, path) in &candidates {
                    check(1)?;
                    if path.as_str() == target.as_str() {
                        exact.push(*entry);
                    }
                }
                if !exact.is_empty() {
                    check(sort_work(exact.len()))?;
                    exact.sort_by(|a, b| order(a, b));
                    check(0)?;
                    return Ok(exact);
                }
            }
            if target.starts_with('/') {
                target = target[1..].into();
            }
            let mut exact = Vec::new();
            for (entry, path) in &candidates {
                check(1)?;
                if path.as_str() == target.as_str() {
                    exact.push(*entry);
                }
            }
            if !exact.is_empty() {
                check(sort_work(exact.len()))?;
                exact.sort_by(|a, b| order(a, b));
                check(0)?;
                return Ok(exact);
            }
            if rooted {
                return Ok(Vec::new());
            }
            let mut selected = Vec::new();
            for pair in candidates {
                check(1)?;
                if suffix_segment(&pair.1, &target) {
                    selected.push(pair);
                }
            }
            check(sort_work(selected.len()))?;
            selected.sort_by(|(a, ap), (b, bp)| {
                in_directory(bp, &directory)
                    .cmp(&in_directory(ap, &directory))
                    .then(order(a, b))
            });
            check(0)?;
            Ok(selected.into_iter().map(|(entry, _)| *entry).collect())
        }
    }
    fn sort_work(n: usize) -> usize {
        if n < 2 {
            return 0;
        }
        n.saturating_mul((usize::BITS - (n - 1).leading_zeros()) as usize + 1)
            .saturating_mul(4)
    }
}
