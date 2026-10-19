use serde::Deserialize;
use zorid_core::{EntryId, EntryKind, EntryState, OperationId, Revision, VaultPath};
use zorid_document::{DocumentMetadata, MetadataRequest, MAX_SOURCE_BYTES};
use zorid_index::*;

fn witness(store: &str, watermark: &str, id: &str, revision: &str, path: &str) -> EntryWitness {
    let source = SourceSnapshotId::new(
        OperationId::new(store).unwrap(),
        SourceWatermark::new(watermark).unwrap(),
    );
    let entry = EntryState {
        id: EntryId::new(id).unwrap(),
        revision: Revision::new(revision).unwrap(),
        path: VaultPath::new(path).unwrap(),
        kind: EntryKind::File,
        deleted: false,
    };
    Manifest::new(source, vec![entry.clone()])
        .unwrap()
        .witness(&entry.id)
        .unwrap()
}
fn key(w: &EntryWitness, mode: ExtractionMode, text: &str) -> ContentExtractionKey {
    ContentExtractionKey::for_source(
        ExtractionScope::new(
            ExtractionDomain::DocumentIndex,
            w.source().local_store_id().clone(),
        ),
        mode,
        text,
    )
    .unwrap()
}
fn result(k: &ContentExtractionKey, text: &str) -> ContentExtractionResult {
    ContentExtractionResult::extract(k.clone(), text).unwrap()
}
#[test]
fn identical_content_rebinds_actual_current_ids_revisions_and_paths_without_reparse() {
    let text = "---\nz: 2\na: {z: 1, a: 2}\n---\n# 😀\n[[Target]] #tag\n- [ ] Task\n";
    let a = witness("store", "1", "first", "old", "Old.md");
    let b = witness("store", "99", "second", "new", "Moved.txt");
    let k = key(&a, ExtractionMode::Markdown, text);
    assert_eq!(k, key(&b, ExtractionMode::Markdown, text));
    let encoded = serde_json::to_vec(&result(&k, text)).unwrap();
    let json = std::str::from_utf8(&encoded).unwrap();
    for forbidden in [
        "entryId",
        "contentRevision",
        "Old.md",
        "Moved.txt",
        "generation",
        "resolved",
    ] {
        assert!(!json.contains(forbidden), "{forbidden}");
    }
    let decoded: ContentExtractionResult = serde_json::from_slice(&encoded).unwrap();
    let record = decoded
        .bind(&k, b.clone(), ExtractionMode::Markdown)
        .unwrap();
    let expected = zorid_document::parse_markdown(&MetadataRequest {
        entry_id: b.entry().id.clone(),
        content_revision: b.entry().revision.clone(),
        source: text.into(),
    })
    .unwrap();
    assert_eq!(record.witness(), &b);
    assert_eq!(record.metadata(), Some(&expected));
    assert_eq!(record.text_digest(), Some(k.digest()));
    record.check_text(text.as_bytes()).unwrap();
    assert_eq!(
        result(&k, text)
            .bind(&k, a, ExtractionMode::Markdown)
            .unwrap()
            .metadata()
            .unwrap()
            .entry_id
            .as_str(),
        "first"
    );
}
#[test]
fn mode_digest_length_scope_and_versions_cannot_cross_cache_bindings() {
    let w = witness("store", "1", "a", "r", "A.md");
    let text = "# heading 😀";
    let k = key(&w, ExtractionMode::Markdown, text);
    let plain = key(&w, ExtractionMode::PlainText, text);
    assert_ne!(k.storage_key().unwrap(), plain.storage_key().unwrap());
    assert_eq!(
        result(&k, text).bind(&plain, w.clone(), ExtractionMode::PlainText),
        Err(IndexError::ContentMismatch)
    );
    assert_eq!(
        result(&k, text).bind(&k, w.clone(), ExtractionMode::PlainText),
        Err(IndexError::ContentMismatch)
    );
    assert!(result(&plain, text)
        .bind(&plain, w.clone(), ExtractionMode::PlainText)
        .unwrap()
        .metadata()
        .is_none());
    let other = key(&w, ExtractionMode::Markdown, "different");
    assert_eq!(
        result(&k, text).bind(&other, w.clone(), ExtractionMode::Markdown),
        Err(IndexError::ContentMismatch)
    );
    assert_eq!(
        ContentExtractionResult::extract(k.clone(), "different"),
        Err(IndexError::ContentMismatch)
    );
    let foreign = witness("other", "1", "a", "r", "A.md");
    assert_eq!(
        result(&k, text).bind(&k, foreign, ExtractionMode::Markdown),
        Err(IndexError::StaleSource)
    );
    for field in [
        "documentSchemaVersion",
        "factsEncodingVersion",
        "dialectVersion",
        "extractionVersion",
    ] {
        let mut wire = serde_json::to_value(&k).unwrap();
        wire[field] = if field.ends_with("Version") && wire[field].is_number() {
            999.into()
        } else {
            "unsupported".into()
        };
        let bad: ContentExtractionKey = serde_json::from_value(wire).unwrap();
        assert_eq!(
            result(&k, text).bind(&bad, w.clone(), ExtractionMode::Markdown),
            Err(IndexError::InvalidVersion)
        );
    }
    let mut wire = serde_json::to_value(&k).unwrap();
    wire["sourceLength"]["bytes"] = 1.into();
    let bad: ContentExtractionKey = serde_json::from_value(wire).unwrap();
    assert_eq!(
        result(&k, text).bind(&bad, w, ExtractionMode::Markdown),
        Err(IndexError::InvalidRecord)
    );
}
#[test]
fn accidental_valid_json_fact_and_checksum_corruption_is_not_a_cache_hit() {
    let w = witness("store", "1", "a", "r", "A.md");
    let text = "---\nproject: one\n---\n# title\n";
    let k = key(&w, ExtractionMode::Markdown, text);
    let original = serde_json::to_value(result(&k, text)).unwrap();
    for change in 0..3 {
        let mut wire = original.clone();
        match change {
            0 => wire["facts"]["facts"]["headings"][0]["text"] = "changed".into(),
            1 => wire["facts"]["facts"]["sourceLength"]["utf16"] = 1.into(),
            _ => {
                wire["factsDigest"][0] =
                    ((wire["factsDigest"][0].as_u64().unwrap() + 1) % 256).into()
            }
        }
        let bad: ContentExtractionResult = serde_json::from_value(wire).unwrap();
        assert_eq!(
            bad.bind(&k, w.clone(), ExtractionMode::Markdown),
            Err(IndexError::ContentMismatch)
        );
    }
    let mut wire = original;
    wire["entryId"] = "placeholder".into();
    assert!(serde_json::from_value::<ContentExtractionResult>(wire).is_err());
}
#[test]
fn invalid_yaml_is_reusable_but_source_limit_and_nul_are_not_successful_facts() {
    let w = witness("store", "1", "a", "r", "A.md");
    let text = "---\na: [\n---\nbody";
    let k = key(&w, ExtractionMode::Markdown, text);
    let record = result(&k, text)
        .bind(&k, w.clone(), ExtractionMode::Markdown)
        .unwrap();
    assert_eq!(
        record.metadata().unwrap().frontmatter.state,
        zorid_document::FrontmatterState::Invalid
    );
    assert!(!record.metadata().unwrap().diagnostics.is_empty());
    for text in ["nul\0body".to_string(), "x".repeat(MAX_SOURCE_BYTES + 1)] {
        assert!(ContentExtractionKey::for_source(
            k.scope().clone(),
            ExtractionMode::Markdown,
            &text
        )
        .is_err());
    }
    let request = MetadataRequest {
        entry_id: w.entry().id.clone(),
        content_revision: w.entry().revision.clone(),
        source: "\0".repeat(MAX_SOURCE_BYTES + 1),
    };
    assert_eq!(
        IndexRecord::text(w.clone(), &request, true)
            .unwrap()
            .exclusion(),
        Some(&Exclusion::SourceLimit)
    );
    let bad = MetadataRequest {
        entry_id: EntryId::new("stale").unwrap(),
        ..request
    };
    assert_eq!(
        IndexRecord::text(w.clone(), &bad, true),
        Err(IndexError::StaleSource)
    );
    let nul = MetadataRequest {
        entry_id: w.entry().id.clone(),
        content_revision: w.entry().revision.clone(),
        source: "\0".into(),
    };
    assert_eq!(
        IndexRecord::text(w, &nul, false).unwrap().exclusion(),
        Some(&Exclusion::Binary)
    );
}
#[derive(Deserialize)]
struct Corpus {
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    id: String,
    request: MetadataRequest,
    expected: DocumentMetadata,
}
#[test]
fn every_canonical_extraction_case_keeps_exact_typed_metadata() {
    let corpus: Corpus = serde_json::from_str(include_str!(
        "../../../tests/fixtures/document-semantics/markdown/corpus.json"
    ))
    .unwrap();
    assert_eq!(corpus.cases.len(), 49);
    for c in corpus.cases {
        let w = witness(
            "corpus",
            "7",
            c.request.entry_id.as_str(),
            c.request.content_revision.as_str(),
            "Corpus.md",
        );
        let k = key(&w, ExtractionMode::Markdown, &c.request.source);
        let record = result(&k, &c.request.source)
            .bind(&k, w.clone(), ExtractionMode::Markdown)
            .unwrap();
        assert_eq!(record.metadata(), Some(&c.expected), "{}", c.id);
        assert_eq!(
            IndexRecord::text(w, &c.request, true).unwrap(),
            record,
            "{} compatibility",
            c.id
        );
    }
}
#[test]
fn shared_cache_admission_preserves_bounds_replacement_and_eviction_work_limit() {
    let empty = ParseCacheUsage { rows: 0, bytes: 0 };
    assert_eq!(
        parse_cache_admission(empty, None, 1, 0).unwrap(),
        ParseCacheAdmission::Write
    );
    assert_eq!(
        parse_cache_admission(empty, None, MAX_PARSE_CACHE_ROW_BYTES + 1, 0).unwrap(),
        ParseCacheAdmission::SkipOversized
    );
    let full = ParseCacheUsage {
        rows: 64,
        bytes: MAX_PARSE_CACHE_BYTES,
    };
    assert_eq!(
        parse_cache_admission(full, None, 1, 0).unwrap(),
        ParseCacheAdmission::EvictOldest
    );
    assert_eq!(
        parse_cache_admission(full, None, 1, 32).unwrap(),
        ParseCacheAdmission::SkipEvictionLimit
    );
    assert_eq!(
        parse_cache_admission(full, Some(MAX_PARSE_CACHE_ROW_BYTES), 1, 32).unwrap(),
        ParseCacheAdmission::Write
    );
    let many = ParseCacheUsage {
        rows: MAX_PARSE_CACHE_ROWS,
        bytes: MAX_PARSE_CACHE_ROWS,
    };
    assert_eq!(
        parse_cache_admission(many, None, 1, 0).unwrap(),
        ParseCacheAdmission::EvictOldest
    );
    for usage in [
        ParseCacheUsage { rows: 0, bytes: 1 },
        ParseCacheUsage { rows: 1, bytes: 0 },
        ParseCacheUsage {
            rows: 1,
            bytes: MAX_PARSE_CACHE_ROW_BYTES + 1,
        },
        ParseCacheUsage { rows: 2, bytes: 1 },
    ] {
        assert_eq!(
            parse_cache_admission(usage, None, 1, 0),
            Err(IndexError::InvalidRecord)
        );
    }
    for replacement in [Some(0), Some(2), Some(usize::MAX)] {
        assert_eq!(
            parse_cache_admission(ParseCacheUsage { rows: 1, bytes: 1 }, replacement, 1, 0),
            Err(IndexError::InvalidRecord)
        );
    }
    assert_eq!(
        parse_cache_admission(ParseCacheUsage { rows: 2, bytes: 4 }, Some(4), 1, 0),
        Err(IndexError::InvalidRecord)
    );
    assert_eq!(
        parse_cache_admission(empty, None, 1, 33),
        Err(IndexError::InvalidRecord)
    );
}
#[test]
fn cached_binding_still_requires_current_manifest_and_pump_preflight() {
    let old = witness("store", "1", "a", "old", "A.md");
    let current = witness("store", "2", "a", "new", "B.md");
    let text = "# same";
    let k = key(&old, ExtractionMode::Markdown, text);
    let stale = result(&k, text)
        .bind(&k, old.clone(), ExtractionMode::Markdown)
        .unwrap();
    let manifest = Manifest::new(current.source().clone(), vec![current.entry().clone()]).unwrap();
    let versions = SemanticVersions::new(
        INDEX_SCHEMA_VERSION,
        document_extraction_version(),
        RESOLVER_VERSION,
        LITERAL_QUERY_VERSION,
    )
    .unwrap();
    let snapshot = IndexSnapshotId::new(
        current.source().local_store_id().clone(),
        OperationId::new("epoch").unwrap(),
        1,
        versions,
    )
    .unwrap();
    let fence = PublicationFence::new(current.source().clone(), None, snapshot).unwrap();
    let mut builder = GenerationBuilder::new(manifest, fence).unwrap();
    assert_eq!(
        builder.preflight_extraction(&old, text.len()),
        Err(IndexError::StaleSource)
    );
    assert_eq!(builder.add(stale), Err(IndexError::StaleSource));
    builder
        .preflight_extraction(&current, MAX_PUMP_BYTES + 1)
        .unwrap();
    let large = "x".repeat(MAX_PUMP_BYTES + 1);
    let first = key(&current, ExtractionMode::PlainText, &large);
    builder
        .add(
            result(&first, &large)
                .bind(&first, current.clone(), ExtractionMode::PlainText)
                .unwrap(),
        )
        .unwrap();
    assert_eq!(
        builder.preflight_extraction(&current, 1),
        Err(IndexError::PumpLimit)
    );
}

#[test]
fn ordinary_extraction_returns_exclusions_without_successful_cache_envelopes() {
    let scope = ExtractionScope::new(
        ExtractionDomain::DocumentIndex,
        OperationId::new("store").unwrap(),
    );
    assert_eq!(
        extract_content(scope.clone(), ExtractionMode::Markdown, "\0").unwrap(),
        ContentExtractionOutcome::Excluded(Exclusion::Binary)
    );
    assert_eq!(
        extract_content(
            scope,
            ExtractionMode::Markdown,
            &"\0".repeat(MAX_SOURCE_BYTES + 1)
        )
        .unwrap(),
        ContentExtractionOutcome::Excluded(Exclusion::SourceLimit)
    );
}
